import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";
import { parseRemoteCaptureRulesPayload } from "../../../packages/sdk-node/src/capture-rules.js";
import type { RemoteProbeConfigSnapshot } from "../../../packages/sdk-node/src/types.js";
import { activeSdks, createSdk } from "../../helpers/sdk-node-client.js";

const retained = (sdk: unknown): EventEnvelope[] => (sdk as { buffer: EventEnvelope[] }).buffer;
afterEach(() => {
  while (activeSdks.length > 0) activeSdks.pop()?.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Node delivery hooks", () => {
  it("defers accepted hooks and automatic transport until capture returns", async () => {
    const hook = vi.fn((event: EventEnvelope) => event);
    const { sdk, transport } = createSdk({ batchSize: 1, beforeSend: hook });
    sdk.captureLog("filtered", "info");
    sdk.captureLog("accepted", "error");
    expect(hook).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    await sdk.flush();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rechecks final hook replacements against effective log policy", async () => {
    const { sdk, transport } = createSdk({ beforeSend: event => event.event_type === "log_event"
      ? { ...event, payload: { ...event.payload, level: "info" } } : event });
    sdk.captureLog("admitted error", "error");
    await sdk.flush();
    expect(transport).not.toHaveBeenCalled();
    expect(retained(sdk)).toHaveLength(0);
  });

  it.each(["warning", "error"] as const)("uses the existing fallback threshold for custom replacement levels under %s policy", async logLevel => {
    const { sdk, transport } = createSdk({ logLevel, beforeSend: event => event.event_type === "log_event"
      ? { ...event, payload: { ...event.payload, level: "notice" } } : event });
    sdk.captureLog("custom level", "error");
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(logLevel === "warning" ? 1 : 0);
    if (logLevel === "warning") expect(transport.mock.calls[0]![0].events[0].payload.level).toBe("notice");
  });

  it("preserves a legitimately activated probe when a deferred hook is configured", async () => {
    const { sdk, transport } = createSdk({ beforeSend: event => event });
    const remote = (sdk as unknown as { remoteProbeConfig: RemoteProbeConfigSnapshot }).remoteProbeConfig;
    remote.probesEnabled = remote.remoteProbesEnabled = true;
    remote.capturePolicy.captureProbeEvents = "standalone_when_activated";
    remote.directives = [{ id: "00000000-0000-4000-8000-000000000211", labelPattern: "checkout",
      service: "checkout-api", environment: "production", expiresAt: new Date(Date.now() + 60_000).toISOString() }];
    sdk.probe("checkout", { marker: "activated" });
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0]![0].events[0].event_type).toBe("probe_event");
  });

  it.each(["buffer_only", "standalone_when_activated"] as const)("applies %s probe policy to a hook-created probe", async captureProbeEvents => {
    const { sdk, transport } = createSdk({ beforeSend: event => ({ ...event, event_type: "probe_event",
      payload: { label: "hook", data: {}, activation_id: "00000000-0000-4000-8000-000000000211", probe_label_pattern: "hook" } }) });
    const remote = (sdk as unknown as { remoteProbeConfig: RemoteProbeConfigSnapshot }).remoteProbeConfig;
    remote.probesEnabled = remote.remoteProbesEnabled = true;
    remote.capturePolicy.captureProbeEvents = captureProbeEvents;
    sdk.captureLog("transform", "error");
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(captureProbeEvents === "standalone_when_activated" ? 1 : 0);
  });

  it("drops valid expanding replacements that cannot fit without restoring original content", async () => {
    const { sdk, transport } = createSdk({ batchSize: 10, maxBufferedBytes: 6_000,
      beforeSend: event => event.event_type === "log_event"
        ? { ...event, payload: { ...event.payload, message: `safe replacement ${"x".repeat(4000)}` } } : event });
    sdk.captureLog("private original one", "error");
    sdk.captureLog("private original two", "error");
    await sdk.flush();
    const sent = transport.mock.calls.flatMap(([request]) => request.events as EventEnvelope[]);
    const logs = sent.filter(event => event.event_type === "log_event");
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("private original");
    expect(Buffer.byteLength(JSON.stringify(logs))).toBeLessThanOrEqual(6_000);
  });

  it("reserves final bytes during a held sender and caches replacements by object identity on retry", async () => {
    let release!: (response: { status: number }) => void;
    const transport = vi.fn().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }))
      .mockResolvedValue({ status: 202 });
    const hook = vi.fn((event: EventEnvelope): EventEnvelope => event.event_type === "log_event"
      ? { ...event, event_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", payload: { ...event.payload,
          message: `${event.payload.message} ${"x".repeat(3000)}` } } : event);
    const { sdk } = createSdk({ transport, beforeSend: hook, maxBufferedEvents: 2,
      maxBufferedBytes: 9_000, batchSize: 10 });
    sdk.captureLog("one", "error");
    sdk.captureLog("two", "error");
    const drain = sdk.flush();
    await Promise.resolve();
    const state = sdk as unknown as { inFlightBytes: number; inFlightCount: number };
    expect(state.inFlightBytes).toBeGreaterThan(6_000);
    expect(state.inFlightCount).toBe(2);
    const read = vi.fn();
    sdk.captureLog("full", "error", new Proxy({}, { get() { read(); throw new Error("must not read"); } }));
    expect(read).not.toHaveBeenCalled();
    release({ status: 500 });
    await drain;
    await sdk.flush();
    expect(hook).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1]![0].events).toEqual(transport.mock.calls[0]![0].events);
  });

  it("lets hooks produce distinct events for identical occurrences before duplicate suppression", async () => {
    let occurrence = 0;
    const { sdk, transport } = createSdk({ beforeSend: event => event.event_type === "log_event"
      ? { ...event, payload: { ...event.payload, message: `tenant ${++occurrence}` } } : event });
    for (let index = 0; index < 5; index++) sdk.captureLog("identical input", "error");
    await sdk.flush();
    const sent = transport.mock.calls.flatMap(([request]) => request.events as EventEnvelope[]);
    expect(sent.filter(event => event.event_type === "log_event").map(event => event.payload.message))
      .toEqual(["tenant 1", "tenant 2", "tenant 3", "tenant 4", "tenant 5"]);
  });

  it("applies value-dependent capture rules to the replacement rather than its original", async () => {
    const { sdk, transport } = createSdk({ beforeSend: event => ({ ...event,
      service: { ...event.service, name: "transformed-api" } }) });
    const remote = (sdk as unknown as { remoteProbeConfig: RemoteProbeConfigSnapshot }).remoteProbeConfig;
    remote.captureRules = parseRemoteCaptureRulesPayload({ capture_rules: [{
      id: "00000000-0000-4000-8000-000000000201", project_id: "proj_123", name: "Original service rule",
      description: null, enabled: true, action: "drop", matcher: { services: ["checkout-api"] },
      sample_rate: null, sample_event_class: null, created_by_user_id: null, created_from_incident_id: null,
      created_from_event_id: null, expires_at: null, hit_count: 0, last_matched_at: null,
      created_at: "2026-05-26T10:00:00.000Z", updated_at: "2026-05-26T10:00:00.000Z"
    }] });
    expect(remote.captureRules).toHaveLength(1);
    sdk.captureLog("accepted replacement", "error");
    await sdk.flush();
    expect(transport.mock.calls[0]![0].events[0].service.name).toBe("transformed-api");
  });

  it("evaluates expiring rules at capture time even when finalization is delayed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-26T10:00:00.000Z"));
    const { sdk, transport } = createSdk({ beforeSend: event => event });
    const remote = (sdk as unknown as { remoteProbeConfig: RemoteProbeConfigSnapshot }).remoteProbeConfig;
    remote.captureRules = parseRemoteCaptureRulesPayload({ capture_rules: [{
      id: "00000000-0000-4000-8000-000000000201", project_id: "proj_123", name: "Capture-time rule",
      description: null, enabled: true, action: "drop", matcher: { services: ["checkout-api"] },
      sample_rate: null, sample_event_class: null, created_by_user_id: null, created_from_incident_id: null,
      created_from_event_id: null, expires_at: "2026-05-26T10:00:01.000Z", hit_count: 0, last_matched_at: null,
      created_at: "2026-05-26T09:00:00.000Z", updated_at: "2026-05-26T09:00:00.000Z"
    }] });
    sdk.captureLog("captured while rule active", "error");
    vi.setSystemTime(new Date("2026-05-26T10:00:02.000Z"));
    await sdk.flush();
    expect(transport).not.toHaveBeenCalled();
  });

  it("samples hook-bearing events after invoking the final hook", async () => {
    const hook = vi.fn((event: EventEnvelope) => event);
    const { sdk, transport } = createSdk({ sampleRate: 0, beforeSend: hook });
    sdk.captureLog("eligible but sampled", "error");
    expect(hook).not.toHaveBeenCalled();
    await sdk.flush();
    expect(hook).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it("does not let a reinitializing hook alter the new generation's suppression state", async () => {
    const nextTransport = vi.fn().mockResolvedValue({ status: 202 });
    const { sdk, transport } = createSdk({ beforeSend: event => {
      sdk.init({ projectToken: "dbundle_proj_test", service: "checkout-api", environment: "production",
        transport: nextTransport, batchSize: 1000, flushInterval: 60000 });
      return event;
    } });
    sdk.captureLog("same message", "error");
    await sdk.flush();
    for (let index = 0; index < 3; index++) sdk.captureLog("same message", "error");
    await sdk.flush();
    expect(transport).not.toHaveBeenCalled();
    const sent = nextTransport.mock.calls.flatMap(([request]) => request.events as EventEnvelope[]);
    expect(sent.filter(event => event.event_type === "log_event")).toHaveLength(3);
  });

  it("contains an accidentally async rejected hook without emitting an unhandled rejection", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    let first = true;
    const hook = (event: EventEnvelope): EventEnvelope => {
      if (!first) return event;
      first = false;
      return Promise.reject(new Error("synthetic async hook failure")) as unknown as EventEnvelope;
    };
    const { sdk, transport } = createSdk({ beforeSend: hook });
    try {
      sdk.captureLog("safe original", "error");
      await sdk.flush();
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(transport.mock.calls[0]![0].events[0].payload.message).toBe("safe original");
    } finally { process.off("unhandledRejection", unhandled); }
  });

  it("coalesces a reentrant capture and flush without reentering the hook", async () => {
    let depth = 0;
    let maximumDepth = 0;
    const { sdk, transport } = createSdk({ batchSize: 1, beforeSend: event => {
      depth++; maximumDepth = Math.max(maximumDepth, depth);
      if (event.event_type === "log_event" && event.payload.message === "outer") {
        sdk.captureLog("inner", "error");
        void sdk.flush();
      }
      depth--;
      return event;
    } });
    sdk.captureLog("outer", "error");
    await sdk.flush();
    expect(maximumDepth).toBe(1);
    expect(transport.mock.calls.flatMap(([request]): EventEnvelope[] => (request as { events: EventEnvelope[] }).events).map((event: EventEnvelope) =>
      event.event_type === "log_event" ? event.payload.message : null)).toEqual(["outer", "inner"]);
  });
});
