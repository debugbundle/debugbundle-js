import { types } from "node:util";
import { sanitizeTelemetry, sanitizeBrowserStackUrls } from "@debugbundle/redaction";
import { ExceptionEvidenceV1Schema, truncateUtf8, parseNormalizedStackFrames, type ExceptionEvidenceV1 } from "@debugbundle/shared-types";

interface LegacyError { name: string; message: string; stack: string }
export interface NodeExceptionSnapshot { legacy: LegacyError; evidence?: ExceptionEvidenceV1; evidence_omitted?: "budget_exceeded" }
type Node = ExceptionEvidenceV1["nodes"][number];
const NativeError = Error;
let nativeStackDescriptor: PropertyDescriptor | undefined;

/** No enumeration, user getters, custom formatting/unwrap or raw-object
 * retention. Node's native brand/proxy checks precede all own-descriptor reads. */
export function snapshotNodeException(input: unknown, enabled: boolean, options: { fatal?: boolean; captureTrace?: boolean; budgetBytes?: number } = {}): NodeExceptionSnapshot {
  let unsafe = false, truncated = false;
  const fatal = options.fatal === true, maxNodes = fatal ? 2 : 8, maxBytes = Math.min(fatal ? 4096 : 32 * 1024, options.budgetBytes ?? Infinity);
  if (enabled && maxBytes < 512) return { ...snapshotNodeException(input, false), evidence_omitted: "budget_exceeded" };
  const data = (value: object, key: string): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !("value" in descriptor)) unsafe = true;
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  };
  const text = (value: unknown, fallback: string): string => typeof value === "string" && value.length > 0 ? value : fallback;
  const stringField = (value: object, key: string): string | undefined => {
    let current: object | null = value;
    for (let depth = 0; current !== null && depth < 8; depth++) {
      if (types.isProxy(current)) { unsafe = true; break; }
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if (!("value" in descriptor) || (descriptor.value !== undefined && typeof descriptor.value !== "string")) { unsafe = true; return undefined; }
        return descriptor.value as string | undefined;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
    if (current !== null) unsafe = true;
    return undefined;
  };
  const name = (value: object): string => text(stringField(value, "name"), "Error");
  const stack = (value: object): string | null => {
    // V8 can materialise a lazy stack even for getOwnPropertyDescriptor. Refuse
    // custom formatters and unbounded stack limits before touching that property.
    const errorName = stringField(value, "name"), errorMessage = stringField(value, "message");
    if (unsafe) return null;
    if ((errorName?.length ?? 0) > 256 || (errorMessage?.length ?? 0) > (fatal ? 512 : 2048)) { truncated = true; return null; }
    const prepare = Object.getOwnPropertyDescriptor(NativeError, "prepareStackTrace");
    const limit = Object.getOwnPropertyDescriptor(NativeError, "stackTraceLimit");
    if ((prepare && (!("value" in prepare) || prepare.value !== undefined)) || !limit || !("value" in limit) || typeof limit.value !== "number" || limit.value > 64 || limit.value < 0) {
      unsafe = true; return null;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, "stack");
    let result: unknown;
    if (descriptor && "value" in descriptor) result = descriptor.value;
    else if (descriptor?.get) {
      // Newer V8 exposes a shared engine stack accessor. Resolve its identity
      // from an SDK-owned native error only after checking formatter/field safety.
      nativeStackDescriptor ??= Object.getOwnPropertyDescriptor(new NativeError(), "stack");
      if (descriptor.get !== nativeStackDescriptor?.get) unsafe = true;
      else { try { result = descriptor.get.call(value); } catch { unsafe = true; } }
    } else if (descriptor) unsafe = true;
    if (result !== undefined && result !== null && typeof result !== "string") unsafe = true;
    return typeof result === "string" && result.length > 0 ? result : null;
  };
  const native = (value: unknown): value is Error => value !== null && typeof value === "object" && !types.isProxy(value) && types.isNativeError(value);
  const outer = native(input) ? { name: name(input), message: text(stringField(input, "message"), "Unknown error"), stack: stack(input) ?? "unavailable" } : {
    name: "Error", message: typeof input === "string" && input.length > 0 ? input : "Unknown error", stack: "unavailable"
  };
  if (!enabled) return { legacy: outer };
  const nodes: Node[] = [], ids = new Map<object, number>();
  const clip = (value: string, bytes: number): string => {
    const result = truncateUtf8(value, bytes); if (result !== value) truncated = true; return result;
  };
  const height = (id: number): number => Math.max(0, ...nodes[id]!.relationships.map((edge) => 1 + height(edge.target_id)));
  const visit = (value: unknown, depth: number, ancestors: ReadonlySet<object>): number | null => {
    if (!native(value)) { unsafe = true; return null; }
    if (ancestors.has(value) || depth > 4) { truncated = true; return null; }
    const existing = ids.get(value);
    if (existing !== undefined) {
      if (depth + height(existing) > 4) { truncated = true; return null; }
      return existing;
    }
    if (nodes.length >= maxNodes) { truncated = true; return null; }
    const id = nodes.length, rawStack = id === 0 ? outer.stack === "unavailable" ? null : outer.stack : stack(value);
    const protectedStack = rawStack === null ? null : sanitizeBrowserStackUrls(clip(rawStack, fatal ? 1024 : 16 * 1024));
    const parsed = protectedStack === null ? null : parseNormalizedStackFrames(protectedStack, "node");
    if (parsed?.truncated || (fatal && parsed && parsed.frames.length > 8)) truncated = true;
    const node: Node = { id, name: clip(id === 0 ? outer.name : name(value), 256), message: clip(id === 0 ? outer.message : text(stringField(value, "message"), "Unknown error"), fatal ? 512 : 2048),
      stack: protectedStack, trace_origin: rawStack === null ? "unavailable" : options.captureTrace && id === 0 ? "capture" : "runtime_reported",
      parsing_status: parsed?.status ?? "unavailable", frames: parsed?.frames.slice(0, fatal ? 8 : 32) ?? [], relationships: [] };
    nodes.push(node); ids.set(value, id);
    const nextAncestors = new Set(ancestors); nextAncestors.add(value);
    const link = (child: unknown, kind: "cause" | "aggregate"): void => {
      if (child === undefined) return;
      if (node.relationships.length >= 5) { truncated = true; return; }
      const target = visit(child, depth + 1, nextAncestors);
      if (target !== null && !node.relationships.some((edge) => edge.kind === kind && edge.target_id === target)) node.relationships.push({ kind, target_id: target });
    };
    link(data(value, "cause"), "cause");
    const errors = data(value, "errors");
    if (errors !== undefined) {
      if (!Array.isArray(errors) || types.isProxy(errors)) unsafe = true;
      else {
        const length = data(errors, "length");
        if (typeof length === "number") {
          for (let index = 0; index < Math.min(length, 5); index++) link(data(errors, String(index)), "aggregate");
          if (length > 5) truncated = true;
        }
      }
    }
    return id;
  };
  if (native(input)) visit(input, 0, new Set());
  else nodes.push({ id: 0, name: "Error", message: clip(outer.message, fatal ? 512 : 2048), stack: null, trace_origin: "unavailable", parsing_status: "unavailable", frames: [], relationships: [] });
  const graph: ExceptionEvidenceV1 = { version: 1, runtime: "node", root_id: 0, nodes, truncated, unavailable_reason: unsafe ? "unsafe" : truncated ? "budget_exceeded" : native(input) ? null : "unsupported" };
  let bytes = Buffer.byteLength(JSON.stringify(graph), "utf8");
  if (bytes > maxBytes) {
    graph.truncated = true; graph.unavailable_reason = "budget_exceeded";
    bytes = Buffer.byteLength(JSON.stringify(graph), "utf8");
    for (let index = nodes.length - 1; bytes > maxBytes && index >= 0; index--) {
      const node = nodes[index]!;
      if (node.stack === null) continue;
      bytes -= Buffer.byteLength(JSON.stringify(node.stack), "utf8") - 4;
      bytes += Buffer.byteLength(JSON.stringify("truncated")) - Buffer.byteLength(JSON.stringify(node.parsing_status));
      node.stack = null; node.parsing_status = "truncated";
    }
    for (let index = nodes.length - 1; bytes > maxBytes && index >= 0; index--) {
      const frames = nodes[index]!.frames;
      while (frames.length && bytes > maxBytes) {
        const removed = frames.pop()!;
        bytes -= Buffer.byteLength(JSON.stringify(removed), "utf8") + (frames.length ? 1 : 0);
      }
    }
    // JSON escaping can exceed the raw UTF-8 field cost for control characters.
    if (bytes > maxBytes) for (const node of nodes) { node.name = truncateUtf8(node.name, fatal ? 64 : 128); node.message = truncateUtf8(node.message, fatal ? 128 : 256); }
  }
  const protectedGraph = sanitizeTelemetry(graph);
  const parsed = protectedGraph.ok ? ExceptionEvidenceV1Schema.safeParse(protectedGraph.value) : null;
  if (!parsed?.success || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > maxBytes) return { legacy: outer, evidence_omitted: "budget_exceeded" };
  return { legacy: outer, evidence: parsed.data };
}
