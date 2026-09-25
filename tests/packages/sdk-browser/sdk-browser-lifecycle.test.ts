import { afterEach, describe, expect, it, vi } from "vitest";
import { activeSdks, createSdk, installBrowserGlobals } from "../../helpers/sdk-browser-fixtures.js";
import { createDebugBundleBrowserSdk } from "../../../packages/sdk-browser/src/index.js";
import { BrowserEventTransport } from "../../../packages/sdk-browser/src/event-transport.js";
import { parseRetryAfter } from "../../../packages/sdk-browser/src/fetch-transport.js";
import type { ActiveConfig, BrowserFetchResponse, DebugBundleBrowserTransportEvent } from "../../../packages/sdk-browser/src/types.js";

const transports: BrowserEventTransport[] = [];
afterEach(() => { for (const transport of transports.splice(0)) transport.reset(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function ack(count: number): BrowserFetchResponse {
  return { status: 202, json: async () => ({ accepted: count, rejected: 0, errors: [] }) };
}

function event(id: string, bytes = 500): DebugBundleBrowserTransportEvent {
  return { event_id: id, event_type: "frontend_exception", payload: { message: "x".repeat(bytes) } } as DebugBundleBrowserTransportEvent;
}

function setup(overrides: Partial<ActiveConfig> = {}) {
  const callbacks = { onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn() };
  const send = vi.fn().mockResolvedValue({ status: 503 });
  const transport = new BrowserEventTransport(callbacks);
  transport.configure({ endpoint: "https://example.test/v1/events", transportMode: "direct",
    projectToken: "dbundle_proj_browser", batchSize: 256, flushInterval: 60_000,
    requestTimeoutMs: 1_000, transport: send, ...overrides } as ActiveConfig);
  transports.push(transport);
  const lane = () => (transport as unknown as { debug: {
    events: DebugBundleBrowserTransportEvent[]; inFlightEvents: Map<DebugBundleBrowserTransportEvent, number>;
    nextRetryAt: number | null; keepalivePending: boolean;
  } }).debug;
  return { transport, send, lane, callbacks };
}

describe("browser lifecycle delivery", () => {
  it.each(["ordinary", "lifecycle"])("requires a canonical acknowledgement from built-in direct %s delivery", async mode => {
    const globals = installBrowserGlobals();
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({ projectToken: "dbundle_proj_browser", captureNetwork: false, batchSize: 256 });
    globals.fetchMock.mockResolvedValue(new Response("<html>proxy response</html>", { status: 200 }));
    sdk.captureMessage("retain after invalid response", "error");
    if (mode === "ordinary") await sdk.flush();
    else globals.windowTarget.dispatch("pagehide", { persisted: true });
    const state = (sdk as unknown as { eventTransport: { debug: { events: unknown[]; nextRetryAt: number | null; keepalivePending: boolean } } }).eventTransport.debug;
    await vi.waitFor(() => expect(state.keepalivePending).toBe(false));
    expect(state.events).toHaveLength(1);
    expect(state.nextRetryAt).toBeGreaterThan(Date.now());
  });

  it("preserves bodyless custom and legacy relay acknowledgements", async () => {
    const { sdk, transport } = createSdk();
    sdk.captureMessage("custom compatibility", "error");
    await sdk.flush();
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    const relay = setup({ transportMode: "relay", projectToken: null, fetchImpl: async () => ({ status: 202 }) });
    vi.stubGlobal("navigator", { sendBeacon: () => false });
    relay.transport.enqueueDebug(event("relay"));
    relay.transport.flushViaBeacon();
    await vi.waitFor(() => expect(relay.lane().events).toHaveLength(0));
  });

  it.each([500, 20_000])("keeps overlapping send ownership inside count and byte bounds (%i-byte payload)", async bytes => {
    const ordinary = deferred<{ status: number }>();
    const fixture = setup({ transport: () => ordinary.promise, fetchImpl: async (_url, init) =>
      ack((JSON.parse(init!.body as string) as { events: unknown[] }).events.length) });
    try {
      for (let index = 0; index < 512; index++) fixture.transport.enqueueDebug(event(`before-${index}`, bytes));
      await vi.waitFor(() => expect(fixture.lane().inFlightEvents.size).toBeGreaterThan(0));
      fixture.transport.flushViaBeacon();
      await vi.waitFor(() => expect(fixture.lane().keepalivePending).toBe(false));
      for (let index = 0; index < 512; index++) fixture.transport.enqueueDebug(event(`after-${index}`, bytes));
      const owned = new Set([...fixture.lane().events, ...fixture.lane().inFlightEvents.keys()]);
      expect(owned.size).toBeLessThanOrEqual(512);
      expect([...owned].reduce((size, value) => size + new TextEncoder().encode(JSON.stringify(value)).byteLength, 0))
        .toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally { ordinary.resolve({ status: 202 }); }
  });

  it("does not resurrect an event acknowledged by a concurrent lifecycle send", async () => {
    const ordinary = deferred<{ status: number; body: unknown }>();
    const fixture = setup({ batchSize: 1, transport: () => ordinary.promise, fetchImpl: async () => ack(1) });
    fixture.transport.enqueueDebug(event("accepted-once"));
    await vi.waitFor(() => expect(fixture.lane().inFlightEvents.size).toBe(1));
    fixture.transport.flushViaBeacon();
    await vi.waitFor(() => expect(fixture.lane().keepalivePending).toBe(false));
    ordinary.resolve({ status: 202, body: { accepted: 0, rejected: 1, errors: [{ index: 0, reason: "rate_limited" }] } });
    await vi.waitFor(() => expect(fixture.lane().inFlightEvents.size).toBe(0));
    expect(fixture.lane().events).toHaveLength(0);
  });

  it("honors an existing rate-limit deadline on repeated lifecycle callbacks", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 429 });
    const fixture = setup({ transport: async () => ({ status: 429, retry_after_ms: 300_000 }), fetchImpl });
    fixture.transport.enqueueDebug(event("rate-limited"));
    await fixture.transport.flush();
    for (let index = 0; index < 3; index++) { fixture.transport.flushViaBeacon(); await Promise.resolve(); }
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fixture.lane().events).toHaveLength(1);
  });

  it.each([429, 202])("honors Retry-After on lifecycle HTTP %i responses", async status => {
    const fetchImpl = vi.fn().mockResolvedValue({ status, headers: { get: () => "86400" },
      json: async () => ({ accepted: 0, rejected: 1, errors: [{ index: 0, reason: "rate_limited" }] }) });
    const fixture = setup({ fetchImpl });
    fixture.transport.enqueueDebug(event("retry"));
    fixture.transport.flushViaBeacon();
    await vi.waitFor(() => expect(fixture.lane().keepalivePending).toBe(false));
    expect(fixture.lane().nextRetryAt! - Date.now()).toBeGreaterThan(299_000);
    expect(fixture.lane().nextRetryAt! - Date.now()).toBeLessThanOrEqual(300_000);
    fixture.transport.flushViaBeacon();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("stops lifecycle retries after authorization rejection %i", async status => {
    const fetchImpl = vi.fn().mockResolvedValue({ status });
    const fixture = setup({ fetchImpl });
    fixture.transport.enqueueDebug(event("unauthorized"));
    fixture.transport.flushViaBeacon();
    await vi.waitFor(() => expect(fixture.lane().keepalivePending).toBe(false));
    fixture.transport.flushViaBeacon();
    expect(fixture.callbacks.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caps numeric and date Retry-After hints at five minutes", () => {
    expect(parseRetryAfter("86400")).toBe(300_000);
    expect(parseRetryAfter(new Date(Date.now() + 86_400_000).toUTCString())).toBe(300_000);
    expect(parseRetryAfter("1e308")).toBe(300_000);
  });

  it("waits for an owned keepalive when explicitly flushed", async () => {
    const request = deferred<BrowserFetchResponse>();
    const fixture = setup({ fetchImpl: () => request.promise });
    fixture.transport.enqueueDebug(event("wait"));
    fixture.transport.flushViaBeacon();
    let finished = false;
    const flushing = fixture.transport.flush().then(() => { finished = true; });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(finished).toBe(false);
    request.resolve(ack(1));
    await flushing;
    expect(fixture.lane().events).toHaveLength(0);
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("shares a bounded flush deadline without releasing a stalled lifecycle sender", async () => {
    const request = deferred<BrowserFetchResponse>();
    const fixture = setup({ fetchImpl: () => request.promise, requestTimeoutMs: 20 });
    fixture.transport.enqueueDebug(event("deadline"));
    fixture.transport.flushViaBeacon();
    const first = fixture.transport.flush();
    expect(fixture.transport.flush()).toBe(first);
    const start = Date.now();
    await first;
    expect(Date.now() - start).toBeGreaterThanOrEqual(10);
    expect(Date.now() - start).toBeLessThan(500);
    expect(fixture.lane().inFlightEvents.size).toBe(1);
    request.resolve(ack(1));
    await vi.waitFor(() => expect(fixture.lane().inFlightEvents.size).toBe(0));
    expect(fixture.lane().events).toHaveLength(1);
  });

  it.each(["direct", "relay"] as const)("shares the unload byte budget across %s lanes and repeated callbacks", async mode => {
    const request = deferred<BrowserFetchResponse>();
    const fetchImpl = vi.fn().mockReturnValue(request.promise);
    const beacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon: beacon });
    const fixture = setup({ transportMode: mode, projectToken: mode === "relay" ? null : "dbundle_proj_browser", fetchImpl });
    fixture.transport.enqueueDebug(event("debug", 50_000));
    fixture.transport.enqueueAnalytics({ ...event("analytics", 20_000), event_type: "analytics_event" } as never);
    fixture.transport.flushViaBeacon();
    fixture.transport.flushViaBeacon();
    await Promise.resolve();
    const bodies = mode === "direct" ? fetchImpl.mock.calls.map(([, init]) => new TextEncoder().encode((init as { body: string }).body).byteLength)
      : beacon.mock.calls.map(([, body]) => (body as Blob).size);
    expect(bodies.reduce((total, bytes) => total + bytes, 0)).toBeLessThanOrEqual(60 * 1024);
    expect(bodies.length).toBe(1);
    request.resolve(ack(1));
  });
});
