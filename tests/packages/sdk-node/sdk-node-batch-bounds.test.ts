import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDebugBundleSdk, createFileTransport, type DebugBundleNodeSdk, type DebugBundleTransportRequest } from "../../../packages/sdk-node/src/index.js";
import { largeExceptionEvidence } from "../../helpers/large-exception-evidence.js";

const clients: DebugBundleNodeSdk[] = [];
const capabilities = { version: 1 as const, features: ["exception_evidence_v1" as const] };
afterEach(() => { clients.splice(0).forEach(sdk => sdk.dispose()); vi.restoreAllMocks(); });

it("retains all primary errors in byte-bounded requests with chunk-local ACK indices", async () => {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  let calls = 0;
  const transport = vi.fn(async (request: DebugBundleTransportRequest) => {
    const rejected = ++calls === 1 ? 1 : 0;
    return Buffer.byteLength(JSON.stringify({ events: request.events })) > 256 * 1024 ? { status: 413 } : { status: 202, body: {
      accepted: request.events.length - rejected, rejected, errors: rejected ? [{ index: 1, reason: "invalid_event" }] : [],
      evidence_capabilities: capabilities } };
  });
  sdk.init({ projectToken: "synthetic-project", service: "test", transport, batchSize: 1000, flushInterval: 60_000,
    fetchImpl: vi.fn().mockRejectedValue(new Error("offline")), evidenceCapabilities: capabilities,
    beforeSend: event => event.event_type === "backend_exception" ? { ...event,
      payload: { ...event.payload, exception_evidence: largeExceptionEvidence("node") } } : event });
  for (let index = 0; index < 10; index++) sdk.captureException(new Error(`primary-${String.fromCharCode(97 + index)}`));
  await sdk.flush();
  const requests = transport.mock.calls.map(call => call[0]);
  expect(requests.length).toBeGreaterThan(1);
  for (const request of requests) expect(Buffer.byteLength(JSON.stringify({ events: request.events }))).toBeLessThanOrEqual(256 * 1024);
  expect(requests.flatMap(request => request.events).filter(event => event.event_type === "backend_exception")).toHaveLength(10);
  expect(new Set(requests.flatMap(request => request.events).map(event => event.event_id)).size).toBe(10);
});

it.each([13, 14])("preserves hook redaction when a valid replacement exceeds wire bytes (%i fields)", async fields => {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const transport = vi.fn<(request: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  const name = "a".repeat(16000);
  sdk.init({ projectToken: "synthetic-project", service: "test", transport, batchSize: 1000, flushInterval: 60_000,
    fetchImpl: vi.fn().mockRejectedValue(new Error("offline")), evidenceCapabilities: capabilities,
    beforeSend: event => event.event_type === "backend_exception" ? { ...event,
      sdk_name: name, sdk_version: "b".repeat(16000), schema_version: "c".repeat(16000),
      context: Object.fromEntries(Array.from({ length: fields }, (_, i) => [`detail${i}`, "x".repeat(16000)])),
      payload: { ...event.payload, message: "safe replacement", stack: "safe replacement stack", exception_evidence: largeExceptionEvidence("node") } } : event });
  sdk.captureException(new Error("private original before hook")); await sdk.flush();
  const events = transport.mock.calls.flatMap(call => call[0].events);
  expect(JSON.stringify(events)).not.toContain("private original before hook");
  expect(events).toHaveLength(fields === 13 ? 1 : 0);
  expect(Buffer.byteLength(JSON.stringify({ events }))).toBeLessThanOrEqual(256 * 1024);
  if (fields === 13) { expect(events[0]?.sdk_name).toBe(name); expect(events[0]?.payload).toMatchObject({ message: "safe replacement" }); expect(events[0]?.payload).not.toHaveProperty("exception_evidence"); }
});

it("preserves existing larger local file captures independently of HTTP body limits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "debugbundle-wire-local-"));
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  try {
    sdk.init({ projectToken: "synthetic-project", service: "test", environment: "development", batchSize: 1000,
      transport: createFileTransport({ eventsDir: directory, serviceName: "test" }),
      fetchImpl: vi.fn().mockRejectedValue(new Error("offline")),
      beforeSend: event => ({ ...event, sdk_name: "a".repeat(16000), sdk_version: "b".repeat(16000), schema_version: "c".repeat(16000),
        context: Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`detail${i}`, "x".repeat(16000)])) }) });
    sdk.captureException(new Error("local primary")); await sdk.flush();
    const files = (await readdir(directory)).filter(path => path.endsWith(".events.json"));
    expect(files).toHaveLength(1);
    const json = await readFile(join(directory, files[0]!), "utf8");
    expect(Buffer.byteLength(json)).toBeGreaterThan(256 * 1024);
    expect(JSON.parse(json)).toMatchObject([{ sdk_name: "a".repeat(16000), payload: { message: "local primary" } }]);
  } finally { sdk.dispose(); await rm(directory, { recursive: true, force: true }); }
});

it("releases pending diagnostics evicted while a hook replacement acquires sender bytes", async () => {
  const sdk = createDebugBundleSdk(); clients.push(sdk);
  const transport = vi.fn<(request: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  const proof = { version: 1 as const, features: ["exception_evidence_v1" as const, "recovery_v1" as const] };
  const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ probes_enabled: false,
    remote_probes_enabled: false, active_probes: [], evidence_capabilities: proof,
    capture_policy: { preset: "balanced", capture_logs: "warning", capture_request_events: "failures_only",
      capture_breadcrumbs: "exception_only", capture_probe_events: "buffer_only" } })));
  sdk.init({ projectToken: "synthetic-project", service: "test", transport, fetchImpl,
    batchSize: 1, maxBufferedBytes: 5000, flushInterval: 60_000, evidenceCapabilities: proof,
    captureRecoveryObservations: true, beforeSend: event => {
      if (event.event_type !== "backend_exception") return event;
      const replacement = { ...event, context: { padding: "" } };
      replacement.context.padding = "x".repeat(4800 - Buffer.byteLength(JSON.stringify(replacement)));
      return replacement;
    } });
  const state = sdk as unknown as { remoteProbeConfig: { capturePolicy: { preset: string } };
    diagnosticBudget: { pending: Map<string, unknown> } };
  await vi.waitFor(() => expect(state.remoteProbeConfig.capturePolicy.preset).toBe("balanced"));
  sdk.captureException(new Error("primary owns sender bytes"));
  sdk.captureRecovery({ failureRef: "11111111-1111-4111-8111-111111111111", attemptId: "22222222-2222-4222-8222-222222222222",
    state: "attempt_completed", evidenceScope: { kind: "operation", operation_id: "33333333-3333-4333-8333-333333333333" } });
  expect(state.diagnosticBudget.pending.size).toBe(1);
  await sdk.flush();
  const events = transport.mock.calls.flatMap(call => call[0].events);
  expect(events.filter(event => event.event_type === "backend_exception")).toHaveLength(1);
  expect(events.filter(event => event.event_type === "diagnostic_context")).toHaveLength(0);
  expect(state.diagnosticBudget.pending.size).toBe(0);
});
