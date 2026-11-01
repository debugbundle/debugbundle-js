import { afterEach, expect, it, vi } from "vitest";
import { normalizeBrowserErrorEvent } from "../../../packages/sdk-browser/src/runtime.js";
import { snapshotBrowserEvidence } from "../../../packages/sdk-browser/src/exception-evidence.js";
it("prefers the selected responsive resource and sanitises its URL", () => {
  expect(normalizeBrowserErrorEvent({ target: { tagName: "IMG", src: "https://cdn.example/fallback.png", currentSrc: "https://cdn.example/selected.webp?secret=value#fragment" } }).target?.source_url).toBe("https://cdn.example/selected.webp");
});
afterEach(() => vi.restoreAllMocks());
it("retains bounded native cause data without invoking cause accessors or custom formatters", () => {
  const inner = new Error("inner"), outer = new Error("outer", { cause: inner });
  const evidence = snapshotBrowserEvidence(outer, { name: "Error", message: "outer", stack: "Error: outer\nrun@https://app.example/app.js?token=secret:5:6" });
  expect(evidence?.nodes[0]?.relationships).toEqual([{ kind: "cause", target_id: 1 }]);
  expect(evidence?.nodes[0]?.frames[0]).toMatchObject({ function: "run", file: "https://app.example/app.js", line: 5, column: 6 });
  const getter = vi.fn(() => new Error("must not call"));
  Object.defineProperty(outer, "cause", { get: getter });
  expect(snapshotBrowserEvidence(outer, { name: "Error", message: "outer", stack: "unavailable" })?.unavailable_reason).toBe("unsafe");
  expect(getter).not.toHaveBeenCalled();
});
it("labels a message without a runtime trace as unavailable and bounds cyclic causes", () => {
  const error = new Error("failure"); Object.defineProperty(error, "cause", { value: error });
  const evidence = snapshotBrowserEvidence(error, { name: "Error", message: "failure", stack: "unavailable" });
  expect(evidence?.nodes[0]).toMatchObject({ stack: null, trace_origin: "unavailable", frames: [] });
  expect(evidence?.truncated).toBe(true);
});
it("does not format a cause through custom prototype accessors", () => {
  const getter = vi.fn(() => "custom name"), cause = new Error("inner");
  Object.setPrototypeOf(cause, Object.create(Error.prototype, { name: { get: getter } }) as object);
  const root = new Error("outer", { cause });
  const graph = snapshotBrowserEvidence(root, { name: "Error", message: "outer", stack: "unavailable" });
  expect(getter).not.toHaveBeenCalled(); expect(graph?.unavailable_reason).toBe("unsafe");
});
it("does not coerce object-valued native error fields while extracting a cause", () => {
  const coercion = vi.fn(() => "custom"), cause = new Error("inner");
  Object.defineProperty(cause, "message", { value: { toString: coercion } });
  const graph = snapshotBrowserEvidence(new Error("outer", { cause }), { name: "Error", message: "outer", stack: "unavailable" });
  expect(coercion).not.toHaveBeenCalled(); expect(graph?.unavailable_reason).toBe("unsafe");
});
it("retains a supported engine's native cause stack without invoking application stack accessors", () => {
  const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"), limit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  Object.defineProperty(Error, "prepareStackTrace", { configurable: true, value: undefined });
  Object.defineProperty(Error, "stackTraceLimit", { configurable: true, value: 10 });
  try {
    const cause = new Error("native cause");
    const graph = snapshotBrowserEvidence(new Error("outer", { cause }), { name: "Error", message: "outer", stack: "unavailable" });
    expect(graph?.nodes[1]?.trace_origin).toBe("runtime_reported");
    expect(graph?.nodes[1]?.frames.length).toBeGreaterThan(0);
    const getter = vi.fn(() => "must not invoke");
    Object.defineProperty(cause, "stack", { get: getter });
    expect(snapshotBrowserEvidence(new Error("outer", { cause }), { name: "Error", message: "outer", stack: "unavailable" })?.unavailable_reason).toBe("unsafe");
    expect(getter).not.toHaveBeenCalled();
  } finally {
    if (formatter) Object.defineProperty(Error, "prepareStackTrace", formatter); else Reflect.deleteProperty(Error, "prepareStackTrace");
    if (limit) Object.defineProperty(Error, "stackTraceLimit", limit); else Reflect.deleteProperty(Error, "stackTraceLimit");
  }
});
it("reports unsupported aggregate traversal and bounds escaped retained stacks without losing the outer identity", () => {
  const group = new AggregateError([new Error("child")], "group");
  const graph = snapshotBrowserEvidence(group, { name: "AggregateError", message: "group", stack: "AggregateError: group\n    at run (/app/main.js:42:6)" });
  expect(graph).toMatchObject({ unavailable_reason: "unsupported", nodes: [{ name: "AggregateError", message: "group" }] });
  const large = snapshotBrowserEvidence("non-error", { name: "Error", message: "\x01".repeat(2000),
    stack: "Error\n" + Array.from({ length: 40 }, (_, n) => `    at run (/app/${"x".repeat(1500)}${n}.js:42:6)`).join("\n") });
  expect(large?.truncated).toBe(true);
  expect(new TextEncoder().encode(JSON.stringify(large)).byteLength).toBeLessThanOrEqual(32768);
});
