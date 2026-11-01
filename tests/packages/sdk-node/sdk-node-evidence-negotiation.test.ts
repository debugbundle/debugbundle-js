import { afterEach, expect, it, vi } from "vitest";
import { createDebugBundleSdk, type DebugBundleNodeSdk, type DebugBundleTransportRequest } from "../../../packages/sdk-node/src/index.js";
import type { EvidenceDeliveryState } from "@debugbundle/shared-types";
const clients: DebugBundleNodeSdk[] = [];
const capabilities = { version: 1 as const, features: ["exception_evidence_v1" as const] };
const remote = (evidence?: unknown) => ({ probes_enabled: false, remote_probes_enabled: false, active_probes: [],
  capture_policy: { preset: "balanced", capture_logs: "warning", capture_request_events: "failures_only", capture_breadcrumbs: "exception_only", capture_probe_events: "buffer_only" },
  ...(evidence === undefined ? {} : { evidence_capabilities: evidence }) });
afterEach(() => { for (const sdk of clients.splice(0)) sdk.dispose(); vi.useRealTimers(); vi.restoreAllMocks(); });
it("cannot grant capabilities from malformed config even with a valid descriptor", async () => {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ capture_policy: "invalid", evidence_capabilities: capabilities })));
  sdk.init({ projectToken: "synthetic-project", service: "test", fetchImpl, evidenceCapabilities: capabilities });
  await vi.waitFor(() => expect((sdk as unknown as { evidence: EvidenceDeliveryState }).evidence.supports("exception_evidence_v1")).toBe(false));
});
it("does not grant capabilities from a malformed ingestion acknowledgement", async () => {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const transport = vi.fn().mockResolvedValue({ status: 202, body: { accepted: 99, rejected: 0, errors: [], evidence_capabilities: capabilities } });
  sdk.init({ projectToken: "synthetic-project", service: "test", transport, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")), flushInterval: 60_000 });
  sdk.captureException(new Error("legacy first")); await sdk.flush();
  expect((sdk as unknown as { evidence: EvidenceDeliveryState }).evidence.supports("exception_evidence_v1")).toBe(false);
});
it.each([undefined, { version: 2, features: [] }, { version: 1, features: ["unknown"] }, capabilities])("uses existing config discovery and fails closed for %j", async (descriptor) => {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(remote(descriptor)), { status: 200 }));
  const transport = vi.fn<(input: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  sdk.init({ projectToken: "synthetic-project", service: "test", fetchImpl, transport });
  const proof = (sdk as unknown as { evidence: EvidenceDeliveryState }).evidence;
  if (descriptor === capabilities) await vi.waitFor(() => expect(proof.supports("exception_evidence_v1")).toBe(true));
  else await new Promise((resolve) => setTimeout(resolve, 0));
  sdk.captureException(new Error("original", { cause: new Error("cause") })); await sdk.flush();
  const event = transport.mock.calls[0]?.[0].events[0];
  expect(event?.event_type).toBe("backend_exception");
  if (event?.event_type !== "backend_exception") throw new Error("missing event");
  expect(event.payload.exception_evidence !== undefined).toBe(descriptor === capabilities);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const requested = fetchImpl.mock.calls[0]?.[0];
  if (typeof requested !== "string") throw new Error("Expected a config URL string");
  expect(new URL(requested).searchParams.get("debugbundle_evidence")).toBe("1");
});
it("removes queued additions after config downgrade and preserves the original failure", async () => {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(remote()), { status: 200 }));
  const transport = vi.fn<(input: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  sdk.init({ projectToken: "synthetic-project", service: "test", fetchImpl, transport, evidenceCapabilities: capabilities });
  sdk.captureException(new Error("original", { cause: new Error("cause") }));
  await vi.waitFor(() => expect((sdk as unknown as { evidence: EvidenceDeliveryState }).evidence.supports("exception_evidence_v1")).toBe(false));
  await sdk.flush();
  const event = transport.mock.calls[0]?.[0].events[0];
  expect(event?.event_type).toBe("backend_exception");
  if (event?.event_type !== "backend_exception") throw new Error("missing event");
  expect(event.payload.message).toBe("original"); expect(event.payload.exception_evidence).toBeUndefined();
});
it("retries a rejected original once in legacy form after an acknowledged downgrade", async () => {
  vi.useFakeTimers();
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const transport = vi.fn<(input: DebugBundleTransportRequest) => Promise<{ status: number; body: unknown }>>()
    .mockResolvedValueOnce({ status: 202, body: { accepted: 0, rejected: 1, errors: [{ index: 0, reason: "invalid_event" }], evidence_capabilities: { version: 1, features: [] } } })
    .mockResolvedValue({ status: 202, body: { accepted: 1, rejected: 0, errors: [] } });
  sdk.init({ projectToken: "synthetic-project", service: "test", transport, evidenceCapabilities: capabilities, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")), flushInterval: 60_000 });
  sdk.captureException(new Error("keep original", { cause: new Error("cause") })); await sdk.flush();
  await vi.advanceTimersByTimeAsync(1001); await sdk.flush();
  expect(transport).toHaveBeenCalledTimes(2);
  const first = transport.mock.calls[0]?.[0].events[0], second = transport.mock.calls[1]?.[0].events[0];
  expect(second?.event_id).toBe(first?.event_id);
  expect(second?.payload).toMatchObject({ message: "keep original" }); expect(second?.payload).not.toHaveProperty("exception_evidence");
});
it("keeps the existing config deadline through a stalled response body and cancels it without extra requests", async () => {
  vi.useFakeTimers(); const cancel = vi.fn();
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel })));
  const transport = vi.fn<(input: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  sdk.init({ projectToken: "synthetic-project", service: "test", fetchImpl, transport, requestTimeoutMs: 50, flushInterval: 60_000,
    evidenceCapabilities: capabilities });
  await vi.advanceTimersByTimeAsync(51); expect(cancel).toHaveBeenCalledOnce(); expect(fetchImpl).toHaveBeenCalledOnce();
  sdk.captureException(new Error("original survives unavailable configuration")); await sdk.flush();
  expect(transport.mock.calls[0]?.[0].events[0]?.payload).toMatchObject({ message: "original survives unavailable configuration" });
});
