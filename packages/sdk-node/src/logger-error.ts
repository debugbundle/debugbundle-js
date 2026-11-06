import { types } from "node:util";
import type { CaptureLogContext } from "./types.js";

/** Own bounded logger metadata without running host getters, proxies or serializers. */
export function nativeLoggerContext(value: unknown): CaptureLogContext {
  let budget = 256;
  const seen = new WeakSet<object>();
  const snapshot = (input: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 8) return "[Truncated]";
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") return input.length <= 4096 ? input : `${input.slice(0, 4085)}[Truncated]`;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input !== "object" || types.isProxy(input)) return "[Unavailable]";
    if (seen.has(input)) return "[Circular]";
    seen.add(input);
    const own = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      return descriptor && "value" in descriptor ? snapshot(descriptor.value, depth + 1) : "[Unavailable]";
    };
    try {
      if (Array.isArray(input)) {
        const items = Array.from({ length: Math.min(input.length, 64) }, (_, i) => own(String(i)));
        if (input.length > 64) items.push("[Truncated]");
        return items;
      }
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const keys = Object.keys(input);
      for (const key of keys.slice(0, 64)) if (key.length <= 128) result[key] = own(key);
      if (keys.length > 64) result["_debugbundle_truncated"] = true;
      return result;
    } finally { seen.delete(input); }
  };
  const result = snapshot(value, 0);
  return result !== null && typeof result === "object" && !Array.isArray(result) ? result as CaptureLogContext : {};
}

/** Inspect only known data slots; no custom getters, serializers or retained raw records. */
export function nativeLoggedError(value: unknown): Error | undefined {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return undefined;
  if (types.isNativeError(value)) return value;
  for (const key of ["err", "error", "exception"]) {
    const field = Object.getOwnPropertyDescriptor(value, key);
    if (field && "value" in field && field.value !== null && typeof field.value === "object" &&
        !types.isProxy(field.value) && types.isNativeError(field.value)) return field.value;
  }
  return undefined;
}
