import { sanitizeTelemetry, sanitizeBrowserStackUrls } from "@debugbundle/redaction";
import { ExceptionEvidenceV1Schema, parseNormalizedStackFrames, truncateUtf8, withinUtf8Budget, type ExceptionEvidenceV1 } from "@debugbundle/shared-types";

interface LegacyError { name: string; message: string; stack: string }
type Node = ExceptionEvidenceV1["nodes"][number];
const NativeError = Error;
let nativeStackDescriptor: PropertyDescriptor | undefined;
const nativePrototypes = new Set<object>([Error.prototype, TypeError.prototype, RangeError.prototype,
  ReferenceError.prototype, SyntaxError.prototype, URIError.prototype, EvalError.prototype,
  ...(typeof AggregateError === "function" ? [AggregateError.prototype as object] : [])]);
const brandDescriptor = Object.getOwnPropertyDescriptor(NativeError, "isError");
const nativeBrand: ((value: unknown) => boolean) | undefined = brandDescriptor && "value" in brandDescriptor &&
  typeof brandDescriptor.value === "function" ? brandDescriptor.value as (value: unknown) => boolean : undefined;

/** The browser has no portable proxy detector. Native cause reads therefore
 * require the engine's non-overridable Error brand check; older engines retain
 * their sanitized outer trace and explicitly report the traversal limitation.
 * Aggregate arrays are not traversed: a browser cannot brand-check array proxies. */
export function snapshotBrowserEvidence(input: unknown, legacy: LegacyError): ExceptionEvidenceV1 | undefined {
  let unsafe = false, truncated = false, unsupported = nativeBrand === undefined;
  const nodes: Node[] = [], seen = new Map<object, number>();
  const native = (value: unknown): value is object => nativeBrand !== undefined && nativeBrand(value);
  const own = (value: object, field: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (descriptor && !("value" in descriptor)) unsafe = true;
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const text = (value: unknown, fallback: string): string => typeof value === "string" && value.length > 0 ? value : fallback;
  const field = (value: object, key: string): unknown => {
    const stringData = (target: object): unknown => { const result = own(target, key);
      if (result !== undefined && typeof result !== "string") unsafe = true;
      return result; };
    const direct = Object.getOwnPropertyDescriptor(value, key);
    if (direct) return stringData(value);
    let prototype = Object.getPrototypeOf(value) as object | null;
    for (let depth = 0; prototype !== null && depth < 4; depth++) {
      if (!nativePrototypes.has(prototype)) { unsafe = true; return undefined; }
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
      if (descriptor) return stringData(prototype);
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    return undefined;
  };
  const clip = (value: string, bytes: number): string => { const result = truncateUtf8(value, bytes); if (result !== value) truncated = true; return result; };
  const visit = (value: unknown, depth: number, ancestors: ReadonlySet<object>, root = false): number | null => {
    if (!root && !native(value)) { unsupported = true; return null; }
    if (typeof value === "object" && value !== null && ancestors.has(value)) { truncated = true; return null; }
    if (depth > 4 || nodes.length >= 8) { truncated = true; return null; }
    if (!root && native(value) && seen.has(value)) return seen.get(value)!;
    const id = nodes.length, branded = native(value);
    const name = root ? legacy.name : text(field(value as object, "name"), "Error");
    const message = root ? legacy.message : text(field(value as object, "message"), "Unknown error");
    let stack: unknown = root ? legacy.stack : undefined;
    if (!root) {
      const formatter = Object.getOwnPropertyDescriptor(NativeError, "prepareStackTrace");
      const limit = Object.getOwnPropertyDescriptor(NativeError, "stackTraceLimit");
      // V8 lazily formats even on descriptor inspection. Do not trigger custom
      // formatting, accessor names/messages, or unbounded native frame work.
      if (unsafe || name.length > 256 || message.length > 2048 ||
        (formatter && (!("value" in formatter) || formatter.value !== undefined)) ||
        (limit && (!("value" in limit) || typeof limit.value !== "number" || limit.value < 0 || limit.value > 64))) unsafe = true;
      else {
        const descriptor = Object.getOwnPropertyDescriptor(value as object, "stack");
        if (descriptor && "value" in descriptor) stack = descriptor.value;
        else if (descriptor?.get) {
          nativeStackDescriptor ??= Object.getOwnPropertyDescriptor(new NativeError(), "stack");
          if (descriptor.get !== nativeStackDescriptor?.get) unsafe = true;
          else { try { stack = descriptor.get.call(value); } catch { unsafe = true; } }
        } else if (descriptor) unsafe = true;
      }
    }
    const retained = typeof stack === "string" && stack !== "unavailable" ? sanitizeBrowserStackUrls(clip(stack, 16 * 1024)) : null;
    const parsed = retained === null ? null : parseNormalizedStackFrames(retained, "browser");
    const runtimeTrace = parsed !== null && parsed.frames.length > 0;
    const node: Node = { id, name: clip(name, 256), message: clip(message, 2048), stack: runtimeTrace ? retained : null,
      trace_origin: runtimeTrace ? "runtime_reported" : "unavailable", parsing_status: runtimeTrace ? parsed.status : "unavailable",
      frames: runtimeTrace ? parsed.frames : [], relationships: [] };
    nodes.push(node); if (parsed?.truncated) truncated = true;
    if (!branded) { unsupported = true; return id; }
    seen.set(value, id); const next = new Set(ancestors); next.add(value);
    const cause = own(value, "cause");
    if (cause !== undefined) { const target = visit(cause, depth + 1, next); if (target !== null) node.relationships.push({ kind: "cause", target_id: target }); }
    if (own(value, "errors") !== undefined) unsupported = true;
    return id;
  };
  try { visit(input, 0, new Set(), true); } catch { unsafe = true; }
  if (nodes.length === 0) return undefined;
  const graph: ExceptionEvidenceV1 = { version: 1, runtime: "browser", root_id: 0, nodes, truncated,
    unavailable_reason: unsafe ? "unsafe" : truncated ? "budget_exceeded" : unsupported ? "unsupported" : null };
  if (!withinUtf8Budget(JSON.stringify(graph), 32 * 1024)) {
    graph.truncated = true; graph.unavailable_reason = "budget_exceeded";
    for (const node of nodes) { node.stack = null; node.parsing_status = "truncated"; node.frames = node.frames.slice(0, 4); }
  }
  const protectedGraph = sanitizeTelemetry(graph);
  const parsed = protectedGraph.ok ? ExceptionEvidenceV1Schema.safeParse(protectedGraph.value) : null;
  return parsed?.success ? parsed.data : undefined;
}
