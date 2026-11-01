import { expect, it, vi } from "vitest";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { createBrowserRelay, type BrowserRelayAcceptedBatch } from "../../../packages/sdk-node/src/relay.js";
import { RelayEvidencePath } from "../../../packages/sdk-node/src/relay-evidence.js";
import { BrowserRelayEventSchema } from "../../../packages/sdk-node/src/relay-schemas.js";
import { largeExceptionEvidence } from "../../helpers/large-exception-evidence.js";
const proof = { version: 1 as const, features: ["exception_evidence_v1", "recovery_v1"] as ("exception_evidence_v1" | "recovery_v1")[] };
const event = (): ReturnType<typeof createEventEnvelope> => createEventEnvelope({ event_type: "frontend_exception", service: { name: "web", environment: "test" },
  payload: { name: "Error", message: "original", stack: "Error: original", browser: { name: "test", version: "1" },
    exception_evidence: { version: 1, runtime: "browser", root_id: 0, nodes: [{ id: 0, name: "Error", message: "original", stack: null,
      trace_origin: "unavailable", parsing_status: "unavailable", frames: [], relationships: [] }], truncated: false, unavailable_reason: null } } });
function request(events: unknown[], optedIn = true) { return { method: "POST", url: optedIn ? "/debugbundle/browser?debugbundle_evidence=1" : "/debugbundle/browser",
  headers: { "content-type": "application/json", host: "example.test", origin: "https://example.test" }, body: JSON.stringify({ batch: events }) }; }
const ack = (body: unknown): Response => ({ status: 202, headers: new Headers(), json: async () => body } as Response);
function forwarded(body: unknown): { events: EventEnvelope[] } {
  if (typeof body !== "string") throw new Error("expected serialized batch");
  return JSON.parse(body) as { events: EventEnvelope[] };
}
it("does not advertise downstream proof learned from malformed counts", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ack({ accepted: 99, rejected: 0, errors: [], evidence_capabilities: proof }));
  const relay = createBrowserRelay({ durableWrite: false, endpoint: "https://api.example/v1/events", projectToken: "server-token", fetchImpl });
  expect((await relay(request([event()]))).status).toBe(500);
  expect((await relay(request([]))).body?.evidence_capabilities).toEqual({ version: 1, features: [] });
});
it("advertises only verified downstream support and strips unsupported additions while retaining the error", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ack({ accepted: 1, rejected: 0, errors: [] }));
  const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => void>(); const relay = createBrowserRelay({ durableWrite: false, endpoint: "https://api.example/v1/events", projectToken: "server-token", fetchImpl, onAccept });
  const result = await relay(request([event()])); expect(result.status).toBe(202);
  expect(result.body?.evidence_capabilities).toEqual({ version: 1, features: [] });
  expect(onAccept.mock.calls[0]?.[0].events[0]?.payload).not.toHaveProperty("exception_evidence");
});
it("preserves closed evidence and opaque references when the complete path supports them", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ack({ accepted: 1, rejected: 0, errors: [], evidence_capabilities: proof }));
  const relay = createBrowserRelay({ durableWrite: false, endpoint: "https://api.example/v1/events", projectToken: "server-token", fetchImpl, evidenceCapabilities: proof });
  const result = await relay(request([event()])); expect(result.body?.evidence_capabilities).toEqual(proof);
  expect(forwarded(fetchImpl.mock.calls[0]?.[1]?.body).events[0]?.payload).toHaveProperty("exception_evidence");
  const legacy = await relay(request([event()], false)); expect(legacy.body).not.toHaveProperty("evidence_capabilities");
});
it("retries only a stripped original error after negotiated downstream rejection", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(ack({ accepted: 0, rejected: 1, errors: [{ index: 0, reason: "invalid_event" }] }))
    .mockResolvedValueOnce(ack({ accepted: 1, rejected: 0, errors: [] }));
  const relay = createBrowserRelay({ durableWrite: false, endpoint: "https://api.example/v1/events", projectToken: "server-token", fetchImpl, evidenceCapabilities: proof });
  const original = event(), result = await relay(request([original])); expect(result.status).toBe(202); expect(fetchImpl).toHaveBeenCalledTimes(2);
  const retry = forwarded(fetchImpl.mock.calls[1]?.[1]?.body).events[0]!; expect(retry.event_id).toBe(original.event_id);
  expect(retry.payload).toMatchObject({ name: "Error", message: "original" }); expect(retry.payload).not.toHaveProperty("exception_evidence");
  expect(result.body?.evidence_capabilities).toEqual({ version: 1, features: [] });
});

it.each([false, true])("splits after server metadata expansion and marks only complete spools (%s)", async complete => {
  const directory = await mkdtemp(join(tmpdir(), "debugbundle-relay-wire-"));
  try {
    const projectToken = "t".repeat(8192);
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => void>();
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      calls++;
      const events = forwarded(init?.body).events;
      const status = typeof init?.body === "string" && Buffer.byteLength(init.body) > 256 * 1024 ? 413 :
        calls > 1 && !complete ? 503 : 202;
      return { status, headers: new Headers(), json: async () => ({ accepted: events.length,
        rejected: 0, errors: [], evidence_capabilities: proof }) } as Response;
    });
    const relay = createBrowserRelay({ endpoint: "https://api.example/v1/events", projectToken,
      spoolDir: directory, fetchImpl, evidenceCapabilities: proof, onAccept });
    const events = [event(), event()].map(value => ({ ...value,
      context: Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`detail${i}`, "x".repeat(2000)])) }));
    const input = request(events);
    expect(Buffer.byteLength(input.body)).toBeLessThanOrEqual(256 * 1024);
    expect((await relay(input)).status).toBe(202);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const call of fetchImpl.mock.calls) {
      const body = call[1]?.body;
      expect(typeof body === "string" ? Buffer.byteLength(body) : Infinity).toBeLessThanOrEqual(256 * 1024);
    }
    expect(fetchImpl.mock.calls.flatMap(call => forwarded(call[1]?.body).events).map(value => value.event_id))
      .toEqual(events.map(value => value.event_id));
    expect((await readdir(directory)).filter(file => file.endsWith(".delivered"))).toHaveLength(complete ? 1 : 0);
    expect(JSON.stringify(onAccept.mock.calls)).not.toContain(projectToken);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("keeps a legacy browser receipt durable when native upstream ACK fields are missing", async () => {
  const directory = await mkdtemp(join(tmpdir(), "debugbundle-relay-ack-"));
  try {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ack({}));
    const relay = createBrowserRelay({ endpoint: "https://api.example/v1/events", projectToken: "server-token",
      spoolDir: directory, fetchImpl, evidenceCapabilities: proof });
    const response = await relay(request([event()], false));
    expect(response.status).toBe(202);
    expect(response.body).not.toHaveProperty("evidence_capabilities");
    expect((await readdir(directory)).filter(file => file.endsWith(".events.json"))).toHaveLength(1);
    expect((await readdir(directory)).filter(file => file.endsWith(".delivered"))).toHaveLength(0);
    expect((await relay(request([]))).body?.evidence_capabilities?.features).toEqual([]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("preserves another file behind a pre-existing delivered-marker symlink", async () => {
  const directory = await mkdtemp(join(tmpdir(), "debugbundle-relay-marker-"));
  try {
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    const foreign = join(directory, "existing.txt");
    await writeFile(foreign, "preserve this file");
    await symlink(foreign, join(directory, "1800000000000-1-web.events.json.delivered"));
    const relay = createBrowserRelay({ endpoint: "https://api.example/v1/events", projectToken: "server-token",
      spoolDir: directory, fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(ack({ accepted: 1, rejected: 0, errors: [] })) });
    expect((await relay(request([event()]))).status).toBe(202);
    expect(await readFile(foreign, "utf8")).toBe("preserve this file");
  } finally { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); }
});

it("keeps one monotonic forwarding deadline across byte-sized chunks", async () => {
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  try {
    const path = new RelayEvidencePath(proof);
    const events = [event(), event()].map(value => ({ ...value,
      context: Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`detail${i}`, "x".repeat(2000)])) }));
    const transport = vi.fn(async (request: { events: EventEnvelope[]; timeout_ms: number }) => {
      now += 6000;
      return { status: 202, body: { accepted: request.events.length, rejected: 0, errors: [], evidence_capabilities: proof } };
    });
    const result = await path.forward({ events: events as Parameters<typeof path.prepare>[0][], transport,
      projectToken: "t".repeat(8192), endpoint: "https://api.example/v1/events", discover: true });
    expect(result).toEqual({ succeeded: false, complete: false });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]?.[0].timeout_ms).toBe(5000);
  } finally { vi.restoreAllMocks(); }
});

it("removes optional evidence before server metadata can strand one primary error", async () => {
  const original = event();
  if (original.event_type !== "frontend_exception") throw new Error("expected a frontend fixture");
  original.context = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`detail${i}`, "x".repeat(16000)]));
  original.payload.exception_evidence = largeExceptionEvidence();
  const token = "t".repeat(28000);
  expect(Buffer.byteLength(request([original]).body)).toBeLessThanOrEqual(256 * 1024);
  expect(Buffer.byteLength(JSON.stringify({ events: [{ ...original, project_token: token }] }))).toBeGreaterThan(256 * 1024);
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(ack({ accepted: 1, rejected: 0, errors: [], evidence_capabilities: proof }));
  const relay = createBrowserRelay({ durableWrite: false, endpoint: "https://api.example/v1/events",
    projectToken: token, fetchImpl, evidenceCapabilities: proof });
  expect((await relay(request([original]))).status).toBe(202);
  const body = fetchImpl.mock.calls[0]?.[1]?.body;
  expect(typeof body === "string" ? Buffer.byteLength(body) : Infinity).toBeLessThanOrEqual(256 * 1024);
  expect(forwarded(body).events[0]).toMatchObject({ event_id: original.event_id, payload: { message: "original" } });
  expect(forwarded(body).events[0]?.payload).not.toHaveProperty("exception_evidence");
});

it("rejects a single connected event that cannot fit after optional evidence is removed", async () => {
  const original = event();
  original.context = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`detail${i}`, "x".repeat(16000)]));
  const fetchImpl = vi.fn<typeof fetch>();
  const relay = createBrowserRelay({ durableWrite: false, endpoint: "https://api.example/v1/events",
    projectToken: "t".repeat(64000), fetchImpl, evidenceCapabilities: proof });
  const response = await relay(request([original]));
  expect(response.status).toBe(202);
  expect(response.body).toMatchObject({ accepted: 0, rejected: 1,
    evidence_errors: [{ index: 0, reason: "invalid_event" }] });
  expect(fetchImpl).not.toHaveBeenCalled();
});

it("retains a pending batch when downstream loses standalone-context support between chunks", async () => {
  const path = new RelayEvidencePath(proof);
  const context = Object.fromEntries(Array.from({ length: 63 }, (_, i) => [`detail${i}`, "x".repeat(2000)]));
  const observation = createEventEnvelope({ event_type: "diagnostic_context", service: { name: "web", environment: "test" },
    context, payload: { version: 1, kind: "recovery", failure_ref: "11111111-1111-4111-8111-111111111111",
      attempt_id: "22222222-2222-4222-8222-222222222222", state: "attempt_completed",
      scope: { kind: "operation", operation_id: "33333333-3333-4333-8333-333333333333" } } });
  const transport = vi.fn(async (request: { events: EventEnvelope[] }) => ({ status: 202,
    body: { accepted: request.events.length, rejected: 0, errors: [], evidence_capabilities: { version: 1, features: [] } } }));
  const result = await path.forward({ events: [BrowserRelayEventSchema.parse({ ...event(), context }),
    BrowserRelayEventSchema.parse(observation)], transport, projectToken: "t".repeat(8192),
    endpoint: "https://api.example/v1/events", discover: true });
  expect(result).toEqual({ succeeded: false, complete: false });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(path.descriptor.features).toEqual([]);
});

it("keeps analytics independent of debug-evidence fitting and bounds its final wire bytes", () => {
  const analytics = BrowserRelayEventSchema.parse({ schema_version: "2026-03-01", event_id: "11111111-1111-4111-8111-111111111111",
    event_type: "analytics_event", occurred_at: "2026-10-27T00:00:00Z", sdk_name: "@debugbundle/sdk-browser", sdk_version: "fixture",
    service: { name: "web", environment: "test" }, correlation: { session_id: "session", visitor_id_hash: null,
      user_id_hash: null, trace_id: null, deploy_id: null },
    payload: { kind: "page_view", privacy: { mode: "standard", consent_granted: true }, dimensions: {}, custom_dimensions: {} } });
  const path = new RelayEvidencePath();
  expect(path.prepare(analytics)).toBe(analytics);
  expect(path.prepareForward(analytics, "synthetic")).toBe(analytics);
  expect(path.prepareForward(analytics, "x".repeat(280000))).toBeNull();
});
