import { AsyncLocalStorage } from "node:async_hooks";
import { isNativeError, isPromise } from "node:util/types";
import { performance } from "node:perf_hooks";
import type { ActiveConfig } from "./types.js";
import { sanitizeMetadataObject } from "./utils.js";

// Scope follows asynchronous callback work without suppressing unrelated tasks
// or retaining an unbounded list of failure identities. Shared across clients.
const scope = new AsyncLocalStorage<boolean>();
const windows = new WeakMap<ActiveConfig, { at: number; count: number }>();
const pending = new WeakSet<ActiveConfig>();
export const inInternalDiagnostic = (): boolean => scope.getStore() === true;

export function diagnosticError(error: unknown): unknown {
  if (!isNativeError(error)) return error;
  const value = (key: string, source: object): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
  };
  // Do not read Error.stack: lazy formatting can invoke Error.prepareStackTrace
  // or application accessors. Native data properties need no rendering callback.
  return { name: value("name", error) ?? value("name", Object.getPrototypeOf(error) as object) ?? "Error",
    message: value("message", error) ?? "error_details_withheld", stack: "" };
}

export function emitNodeDiagnostic(config: ActiveConfig | null, code: string, message: string, metadata?: Record<string, unknown>): void {
  if (config?.onDiagnostic === undefined || inInternalDiagnostic() || pending.has(config)) return;
  try {
    const now = performance.now();
    let window = windows.get(config);
    if (window === undefined || now - window.at >= 60_000) {
      window = { at: now, count: 0 };
      windows.set(config, window);
    }
    if (window.count >= 10) return;
    window.count++;
    scope.run(true, () => {
      let safeMetadata;
      try {
        const detail = metadata === undefined ? undefined : { ...metadata,
          ...(Object.hasOwn(metadata, "error") ? { error: diagnosticError(metadata["error"]) } : {}) };
        safeMetadata = sanitizeMetadataObject(detail, config.redactFields, config.redactExactFields);
        if (safeMetadata !== undefined && Buffer.byteLength(JSON.stringify(safeMetadata), "utf8") > 4096) safeMetadata = undefined;
      } catch { /* Unsafe detail is optional; still report the static failure code. */ }
      const result: unknown = config.onDiagnostic?.({ code, message,
        ...(safeMetadata === undefined ? {} : { metadata: safeMetadata }) });
      // Promise subscription uses the native intrinsic, never a user .then/.catch.
      // Do not await callbacks or schedule replacement work for a stalled callback.
      if (isPromise(result)) {
        pending.add(config);
        try {
          void Promise.prototype.then.call(result, () => pending.delete(config), () => pending.delete(config));
        } catch { /* Keep the lane reserved if subscription cannot be trusted. */ }
      }
    });
  } catch { /* Optional diagnostics cannot affect capture or delivery. */ }
}
