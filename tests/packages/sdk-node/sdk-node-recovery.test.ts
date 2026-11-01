import { afterEach, expect, it, vi } from "vitest";
import { createDebugBundleSdk, type DebugBundleNodeSdk, type DebugBundleTransportRequest, type NodeBeforeSendHook } from "../../../packages/sdk-node/src/index.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { kind: "operation" as const, operation_id: id(1) };
const observation = { failureRef: id(2), evidenceScope: scope, attemptId: id(3), state: "attempt_completed" as const, statusCode: 200 };
const clients: DebugBundleNodeSdk[] = [];
afterEach(() => { for (const sdk of clients.splice(0)) sdk.dispose(); vi.restoreAllMocks(); });
function fixture(enabled = true, beforeSend?: NodeBeforeSendHook) {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const transport = vi.fn<(request: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  sdk.init({ projectToken: "synthetic-project", service: "test", projectMode: "local-only", transport, captureRecoveryObservations: enabled,
    evidenceCapabilities: { version: 1, features: ["exception_evidence_v1", "recovery_v1"] }, ...(beforeSend === undefined ? {} : { beforeSend }) });
  return { sdk, transport };
}
it("delivers recovery independently without an exception or a probe activation", async () => {
  const { sdk, transport } = fixture(); sdk.captureRecovery(observation); await sdk.flush();
  expect(transport.mock.calls[0]?.[0].events).toMatchObject([{ event_type: "diagnostic_context", payload: { kind: "recovery", state: "attempt_completed", status_code: 200, failure_ref: id(2) } }]);
});
it("requires local opt-in and emits the original error even when recovery is disabled", async () => {
  const { sdk, transport } = fixture(false); sdk.captureRecovery(observation); sdk.captureException(new Error("original")); await sdk.flush();
  expect(transport.mock.calls[0]?.[0].events.map((event) => event.event_type)).toEqual(["backend_exception"]);
});
it("shares an owned operation scope with its error and limits independent observations", async () => {
  const { sdk, transport } = fixture();
  await sdk.runWithOperationContext({ kind: "job", name: "jobs:resize" }, () => {
    sdk.captureException(new Error("failure"), { failureRef: id(2) });
    for (let n = 0; n < 25; n++) sdk.captureRecovery({ failureRef: id(2), attemptId: id(3), state: "attempt_started" });
  });
  await sdk.flush(); const events = transport.mock.calls.flatMap(([request]) => request.events);
  const failure = events.find((event) => event.event_type === "backend_exception"), diagnostics = events.filter((event) => event.event_type === "diagnostic_context");
  expect(diagnostics).toHaveLength(20);
  expect(diagnostics[0]?.payload.scope).toEqual((failure?.context?.["evidence_reference"] as { scope: unknown }).scope);
});
it("allows canonical hook identity changes while keeping diagnostic budget ownership correct", async () => {
  const { sdk, transport } = fixture(true, (event) => ({ ...event, event_id: id(99) }));
  sdk.captureRecovery(observation); await sdk.flush();
  expect(transport.mock.calls[0]?.[0].events[0]?.event_id).toBe(id(99));
  sdk.captureRecovery({ ...observation, attemptId: id(4) }); await sdk.flush();
  expect(transport).toHaveBeenCalledTimes(2);
});
it("keeps the first diagnostic receipt owned when later hook identities collide", async () => {
  const { sdk, transport } = fixture(true, event => ({ ...event, event_id: id(99) }));
  transport.mockResolvedValue({ status: 500 });
  for (let n = 3; n < 6; n++) sdk.captureRecovery({ ...observation, attemptId: id(n) });
  await sdk.flush();
  expect(transport.mock.calls[0]?.[0].events).toHaveLength(1);
  expect(transport.mock.calls[0]?.[0].events[0]?.payload).toMatchObject({ attempt_id: id(3) });
});
it("accepts an explicit session-scoped page observation and ignores unsafe local option accessors", async () => {
  const { sdk, transport } = fixture(), trap = vi.fn(() => { throw new Error("must not invoke"); });
  const unsafe = { ...observation }; Object.defineProperty(unsafe, "failureRef", { get: trap });
  sdk.captureRecovery(unsafe); sdk.captureRecovery(new Proxy(observation, { getOwnPropertyDescriptor: trap }));
  sdk.captureRecovery({ ...observation, evidenceScope: { kind: "page", page_id: id(10) }, correlation: { session_id: "synthetic-session" },
    operation: "asset.reload", durationMs: 0 });
  await sdk.flush(); expect(trap).not.toHaveBeenCalled();
  expect(transport.mock.calls[0]?.[0].events).toMatchObject([{ event_type: "diagnostic_context", payload: { scope: { kind: "page", page_id: id(10) }, operation: "asset.reload", duration_ms: 0 } }]);
});
