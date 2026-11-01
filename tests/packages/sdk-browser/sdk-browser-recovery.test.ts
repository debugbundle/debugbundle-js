import { afterEach, expect, it, vi } from "vitest";
import * as fixtures from "../../helpers/sdk-browser-fixtures.js";
import { normalizeBrowserErrorEvent } from "../../../packages/sdk-browser/src/runtime.js";
import type { PassiveResourceCollector } from "../../../packages/sdk-browser/src/passive-resources.js";
afterEach(() => vi.useRealTimers());
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const observation = { failureRef: id(1), attemptId: id(2), state: "attempt_completed" as const, statusCode: 200 };
it.each([200, 500])("cannot grant evidence from malformed or unsuccessful configuration (%i)", async (status) => {
  const capabilities = { version: 1 as const, features: ["exception_evidence_v1" as const] };
  const globals = fixtures.installBrowserGlobals();
  globals.fetchMock.mockResolvedValueOnce({ status, json: async () => ({ capture_policy: "invalid", evidence_capabilities: capabilities }) });
  const transport = vi.fn().mockResolvedValue({ status: 202 });
  const sdk = fixtures.createDebugBundleBrowserSdk(); fixtures.activeSdks.push(sdk);
  sdk.init({ projectToken: "dbundle_proj_browser", transport, flushInterval: 60_000, evidenceCapabilities: capabilities });
  await fixtures.settleAsyncInit();
  sdk.captureException(new Error("preserved")); await sdk.flush();
  expect(fixtures.createTransportEvents(transport, 0)[0]?.payload).not.toHaveProperty("exception_evidence");
});
it("sends recovery independently with a page-scoped failure reference and no probe", async () => {
  const { sdk, transport } = fixtures.createSdk({ captureRecoveryObservations: true,
    evidenceCapabilities: { version: 1, features: ["exception_evidence_v1", "recovery_v1"] } });
  sdk.captureException(new Error("original"), { failureRef: id(1) });
  sdk.captureRecovery(observation); await sdk.flush();
  const events = transport.mock.calls.flatMap((_, index) => fixtures.createTransportEvents(transport, index));
  expect(events.map(event => event.event_type)).toEqual(["frontend_exception", "diagnostic_context"]);
  expect(events[1]?.payload).toMatchObject({ kind: "recovery", state: "attempt_completed", status_code: 200,
    scope: (events[0]?.context?.["evidence_reference"] as { scope: unknown }).scope });
});
it("retains legacy errors with no optional evidence when support is unknown", async () => {
  const { sdk, transport } = fixtures.createSdk({ captureRecoveryObservations: true });
  sdk.captureException(new Error("original")); sdk.captureRecovery(observation); await sdk.flush();
  const events = fixtures.createTransportEvents(transport, 0);
  expect(events).toHaveLength(1); expect(events[0]?.payload).not.toHaveProperty("exception_evidence");
});
it("keeps recovery behind its independent local opt-in", async () => {
  const { sdk, transport } = fixtures.createSdk({ evidenceCapabilities: { version: 1, features: ["recovery_v1"] } });
  sdk.captureRecovery(observation); await sdk.flush(); expect(transport).not.toHaveBeenCalled();
});
it("sends scoped recovery through a relay without retaining or forwarding a browser project token", async () => {
  const { sdk, transport } = fixtures.createSdk({ transportMode: "relay", endpoint: "/debugbundle/browser", captureRecoveryObservations: true,
    evidenceCapabilities: { version: 1, features: ["recovery_v1"] } });
  sdk.captureRecovery({ ...observation, operation: "asset.reload", durationMs: 0 }); await sdk.flush();
  const event = fixtures.createTransportEvents(transport, 0)[0];
  expect(event?.event_type).toBe("diagnostic_context"); expect(event).not.toHaveProperty("project_token");
  expect(event?.payload).toMatchObject({ operation: "asset.reload", duration_ms: 0 });
});
it("does not release another diagnostic receipt when hook identities collide", async () => {
  const { sdk, transport } = fixtures.createSdk({ captureRecoveryObservations: true, evidenceCapabilities: { version: 1, features: ["recovery_v1"] },
    beforeSend: event => ({ ...event, event_id: id(99) }) });
  transport.mockResolvedValue({ status: 500 });
  for (let n = 2; n < 5; n++) sdk.captureRecovery({ ...observation, attemptId: id(n) });
  await sdk.flush();
  expect(fixtures.createTransportEvents(transport, 0)).toHaveLength(1);
  expect(fixtures.createTransportEvents(transport, 0)[0]?.payload).toMatchObject({ attempt_id: id(2) });
});
it("delivers an original resource failure immediately and one later passive context after its ACK", async () => {
  vi.useFakeTimers(); vi.setSystemTime("2026-10-26T00:00:00.000Z");
  vi.stubGlobal("PerformanceObserver", undefined);
  const { sdk, transport, globals } = fixtures.createSdk({ captureResourceObservations: true,
    evidenceCapabilities: { version: 1, features: ["resource_observations_v1"] } });
  sdk.captureException("Browser resource load error", { browser_event: normalizeBrowserErrorEvent({ target: { tagName: "SCRIPT", src: "https://cdn.example/asset.js" } }) });
  await sdk.flush(); const original = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
  expect(original.payload.resource_observations?.items[0]).toMatchObject({ availability: "unsupported", response_status: null });
  const collector = (sdk as unknown as { evidence: { resources: PassiveResourceCollector } }).evidence.resources;
  collector.record({ kind: "csp", source_url: "https://cdn.example/asset.js", observed_at: new Date().toISOString(),
    effective_directive: "script-src-elem", disposition: "report", document_status_code: 200 }, Date.now());
  await vi.advanceTimersByTimeAsync(0); await sdk.flush();
  expect(fixtures.createTransportEvents(transport, 1)).toMatchObject([{ event_type: "diagnostic_context", payload: {
    kind: "resource_observation", source_event_id: original.event_id, observations: { items: [{ availability: "unsupported" }, { disposition: "report" }] }
  } }]);
  expect(globals.fetchMock).toHaveBeenCalledTimes(1);
  sdk.dispose(); expect(vi.getTimerCount()).toBe(0);
});
