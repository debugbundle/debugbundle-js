import { afterEach, expect, it, vi } from "vitest";
import { ExceptionEvidenceV1Schema } from "@debugbundle/shared-types";
import { snapshotNodeException } from "../../../packages/sdk-node/src/exception-evidence.js";
import { createDebugBundleSdk, type DebugBundleTransportRequest, type NodeBeforeSendHook } from "../../../packages/sdk-node/src/index.js";
afterEach(() => vi.restoreAllMocks());
function withNativeStacks<Result>(run: () => Result): Result {
  const formatter = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace"), limit = Object.getOwnPropertyDescriptor(Error, "stackTraceLimit");
  Object.defineProperty(Error, "prepareStackTrace", { configurable: true, value: undefined });
  Object.defineProperty(Error, "stackTraceLimit", { configurable: true, value: 10 });
  try { return run(); }
  finally {
    if (formatter) Object.defineProperty(Error, "prepareStackTrace", formatter); else Reflect.deleteProperty(Error, "prepareStackTrace");
    if (limit) Object.defineProperty(Error, "stackTraceLimit", limit); else Reflect.deleteProperty(Error, "stackTraceLimit");
  }
}
it("captures native cause and aggregate relationships with a bounded safe snapshot", () => {
  const cause = new TypeError("root");
  const aggregate = new AggregateError([cause, new Error("other")], "group", { cause });
  const snapshot = snapshotNodeException(aggregate, true);
  expect(snapshot.legacy).toMatchObject({ name: "AggregateError", message: "group" });
  const graph = ExceptionEvidenceV1Schema.parse(snapshot.evidence);
  expect(graph.nodes).toHaveLength(3);
  expect(graph.nodes[0]?.relationships.map((edge) => edge.kind)).toEqual(["cause", "aggregate", "aggregate"]);
  expect(graph.nodes.find((node) => node.message === "root")?.name).toBe("TypeError");
});
it("never calls error accessors, custom formatters or proxy traps", () => {
  const getter = vi.fn(() => { throw new Error("must not call"); });
  const error = new Error("outer");
  Object.defineProperty(error, "cause", { get: getter });
  Object.defineProperty(error, "message", { get: getter });
  const prepare = vi.fn(() => { throw new Error("must not format"); });
  const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  Object.defineProperty(Error, "prepareStackTrace", { configurable: true, value: prepare });
  try {
    const snapshot = snapshotNodeException(error, true);
    expect(snapshot.evidence?.unavailable_reason).toBe("unsafe");
    const trap = vi.fn(() => { throw new Error("must not inspect"); });
    snapshotNodeException(new Proxy(new Error("proxy"), { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }), true);
    expect(trap).not.toHaveBeenCalled(); expect(getter).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  } finally { if (original) Object.defineProperty(Error, "prepareStackTrace", original); else Reflect.deleteProperty(Error, "prepareStackTrace"); }
});
it("does not materialise V8 stacks through overridden message/name fields", () => {
  const original = Object.getOwnPropertyDescriptor(Error, "prepareStackTrace");
  Object.defineProperty(Error, "prepareStackTrace", { configurable: true, value: undefined });
  try {
    const getter = vi.fn(() => "must not invoke"), error = new Error("outer");
    Object.defineProperty(error, "message", { get: getter });
    snapshotNodeException(error, true);
    const formatter = vi.fn(() => "must not format"), named = new Error("outer");
    Object.defineProperty(named, "name", { value: { toString: formatter } });
    snapshotNodeException(named, true);
    expect(getter).not.toHaveBeenCalled(); expect(formatter).not.toHaveBeenCalled();
  } finally { if (original) Object.defineProperty(Error, "prepareStackTrace", original); else Reflect.deleteProperty(Error, "prepareStackTrace"); }
});
it("bounds cycles, depth, width, UTF-8 bytes and fatal evidence without retaining native errors", () => {
  const root = new Error("😀".repeat(20_000));
  Object.defineProperty(root, "cause", { value: root });
  const snapshot = snapshotNodeException(root, true);
  expect(ExceptionEvidenceV1Schema.safeParse(snapshot.evidence).success).toBe(true);
  expect(snapshot.evidence?.truncated).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(snapshot.evidence))).toBeLessThanOrEqual(32 * 1024);
  const group = new AggregateError(Array.from({ length: 30 }, () => new Error("x".repeat(10_000))), "fatal");
  const fatal = snapshotNodeException(group, true, { fatal: true });
  expect(fatal.evidence!.nodes.length).toBeLessThanOrEqual(2);
  expect(Buffer.byteLength(JSON.stringify(fatal.evidence))).toBeLessThanOrEqual(4096);
  expect(JSON.stringify(fatal)).not.toContain('"arguments"');
});
it("preserves legacy error shape when capability support is absent", () => {
  const snapshot = snapshotNodeException(new Error("legacy"), false);
  expect(snapshot.evidence).toBeUndefined(); expect(snapshot.legacy.message).toBe("legacy");
});
it("distinguishes a constructed capture trace from the original cause's runtime trace", () => {
  const graph = withNativeStacks(() => snapshotNodeException(new Error("capture wrapper", { cause: new Error("original cause") }), true, { captureTrace: true }).evidence);
  expect(graph?.nodes.map(node => node.trace_origin)).toEqual(["capture", "runtime_reported"]);
});
it("preserves non-error and empty legacy inputs while omitting additions that cannot fit", () => {
  expect(snapshotNodeException("non-error", true).evidence).toMatchObject({ unavailable_reason: "unsupported" });
  expect(snapshotNodeException(null, true).legacy).toMatchObject({ message: "Unknown error" });
  expect(snapshotNodeException(new Error("ordinary"), true, { budgetBytes: 100 })).toMatchObject({ evidence_omitted: "budget_exceeded", legacy: { message: "ordinary" } });
  const group = new AggregateError(Array.from({ length: 5 }, () => new Error("\x01".repeat(2000))), "original");
  expect(snapshotNodeException(group, true, { budgetBytes: 512 })).toMatchObject({ evidence_omitted: "budget_exceeded", legacy: { message: "original" } });
});
it("bounds aliased aggregate depth and rejects unsafe child arrays without executing accessors", () => {
  let chain = new Error("bottom");
  const shared = chain;
  for (let n = 0; n < 5; n++) chain = new Error("parent", { cause: chain });
  const group = new AggregateError([shared, chain, ...Array.from({ length: 10 }, () => new Error("wide"))], "root");
  const graph = ExceptionEvidenceV1Schema.parse(snapshotNodeException(group, true).evidence);
  expect(graph.truncated).toBe(true); expect(graph.nodes.length).toBeLessThanOrEqual(8);
  const getter = vi.fn(() => new Error("never")), values = [new Error("safe")];
  Object.defineProperty(values, "0", { get: getter });
  expect(snapshotNodeException(new AggregateError([], "root", { cause: "non-error" }), true).evidence?.unavailable_reason).toBe("unsafe");
  const arrayError = new Error("root"); Object.defineProperty(arrayError, "errors", { configurable: true, value: values });
  expect(snapshotNodeException(arrayError, true).evidence?.unavailable_reason).toBe("unsafe");
  Object.defineProperty(arrayError, "errors", { configurable: true, value: new Proxy([], { get: getter }) });
  expect(snapshotNodeException(arrayError, true).evidence?.unavailable_reason).toBe("unsafe");
  expect(getter).not.toHaveBeenCalled();
});
it("shrinks large retained stacks and frames before giving up the original failure", () => {
  const error = new Error("\x01".repeat(2000));
  error.stack = 'Error: original\n' + Array.from({ length: 40 }, (_, n) => `    at call (/app/${'x'.repeat(1500)}${n}.js:42:6)`).join('\n');
  const result = withNativeStacks(() => snapshotNodeException(error, true, { budgetBytes: 1000 }));
  expect(result.legacy.message).toBe(error.message);
  if (result.evidence) expect(Buffer.byteLength(JSON.stringify(result.evidence))).toBeLessThanOrEqual(1000);
  else expect(result.evidence_omitted).toBe("budget_exceeded");
});
it("rejects proxy prototypes and custom stack getters while retaining supported own string traces", () => {
  withNativeStacks(() => {
    const trap = vi.fn(() => { throw new Error("must not inspect"); }), proxied = new Error("proxy prototype");
    Object.setPrototypeOf(proxied, new Proxy(Error.prototype, { get: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap }));
    expect(snapshotNodeException(proxied, true).evidence?.unavailable_reason).toBe("unsafe");
    const custom = new Error("getter"); Object.defineProperty(custom, "stack", { get: trap });
    expect(snapshotNodeException(custom, true).legacy.stack).toBe("unavailable");
    const retained = new Error("retained"); Object.defineProperty(retained, "stack", { value: "Error: retained\n    at run (/app/main.js:42:6)" });
    expect(snapshotNodeException(retained, true).evidence?.nodes[0]?.frames[0]).toMatchObject({ file: "/app/main.js", line: 42, column: 6 });
    expect(trap).not.toHaveBeenCalled();
  });
});
it("keeps uncaught capture on its smaller budget without invoking a user hook", async () => {
  const sdk = createDebugBundleSdk(), hook = vi.fn<NodeBeforeSendHook>((event) => event);
  const transport = vi.fn<(request: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  sdk.init({ projectToken: "synthetic-project", service: "test", transport, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
    evidenceCapabilities: { version: 1, features: ["exception_evidence_v1"] }, beforeSend: hook });
  try {
    process.emit("uncaughtException", new AggregateError([new Error("cause")], "fatal"));
    await sdk.flush();
    expect(hook).not.toHaveBeenCalled();
    const event = transport.mock.calls[0]?.[0].events[0];
    expect(event?.event_type).toBe("backend_exception");
    if (event?.event_type !== "backend_exception") throw new Error("missing event");
    expect(event.payload.exception_evidence?.nodes.length).toBeLessThanOrEqual(2);
    expect(Buffer.byteLength(JSON.stringify(event.payload.exception_evidence))).toBeLessThanOrEqual(4096);
  } finally { sdk.dispose(); }
});
