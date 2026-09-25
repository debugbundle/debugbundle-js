import { describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";

import { createSdk, createTransportEvents } from "../../helpers/sdk-browser-fixtures.js";

import { BrowserEventTransport } from "../../../packages/sdk-browser/src/event-transport.js";
import type { ActiveConfig, DebugBundleBrowserTransportEvent } from "../../../packages/sdk-browser/src/types.js";

describe("sdk-browser transport safety", () => {
  it("retries after a custom transport synchronously throws", async () => {
    const { sdk, transport } = createSdk({ batchSize: 1 });
    transport.mockImplementationOnce(() => { throw new Error("synchronous application transport failure"); });
    sdk.captureLog("one", "error");
    await Promise.resolve();
    await sdk.flush();
    const calls = transport.mock.calls.length;
    sdk.dispose();
    expect(calls).toBe(2);
  });

  it.each(["log", "exception"] as const)("rejects full public %s capture before hooks and caller context reads", async (kind) => {
    let release!: (result: { status: number }) => void;
    const held = new Promise<{ status: number }>(resolve => { release = resolve; });
    const beforeSend = vi.fn((event: EventEnvelope) => event);
    const { sdk, transport } = createSdk({ batchSize: 20_000, maxEventsPerSession: 20_000, beforeSend });
    transport.mockReturnValueOnce(held);
    for (let index = 0; index < 512; index++) {
      if (kind === "log") sdk.captureLog(`retained-${index}`, "error");
      else sdk.captureException(new Error(`retained-${index}`));
    }
    const flushing = sdk.flush();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    let reads = 0;
    const context = { get application() { reads++; return "ignored"; } };
    const target = { get outerHTML() { reads++; return "<div></div>"; } };
    const hooksBefore = beforeSend.mock.calls.length;
    for (let index = 0; index < 10_000; index++) {
      if (kind === "log") sdk.captureLog(`discarded-${index}`, "error", context);
      else sdk.captureException(new Error(`discarded-${index}`), { target });
    }
    const hooksAfter = beforeSend.mock.calls.length;
    release({ status: 202 });
    await flushing;
    expect(hooksAfter - hooksBefore).toBe(0);
    expect(reads).toBe(0);
    const events = transport.mock.calls.flatMap((_, index) => createTransportEvents(transport, index));
    expect(events.filter(event => event.event_type === "error_suppressed")
      .map(event => event.payload.suppressed_count)).toEqual([10_000]);
    sdk.dispose();
  }, 30_000);

  it("allows a public exception to replace an unsent warning while its first batch is held", async () => {
    let release!: (result: { status: number }) => void;
    const held = new Promise<{ status: number }>(resolve => { release = resolve; });
    const beforeSend = vi.fn((event: EventEnvelope) => event);
    const { sdk, transport } = createSdk({ batchSize: 20_000, maxEventsPerSession: 20_000, beforeSend });
    transport.mockReturnValueOnce(held);
    for (let index = 0; index < 512; index++) sdk.captureLog(`warning-${index}`, "warning");
    const flushing = sdk.flush();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    const hooksBeforeException = beforeSend.mock.calls.length;
    sdk.captureException(new Error("priority failure"));
    expect(beforeSend).toHaveBeenCalledTimes(hooksBeforeException);
    release({ status: 202 });
    await flushing;
    const events = transport.mock.calls.flatMap((_, index) => createTransportEvents(transport, index));
    expect(events.filter(event => event.event_type === "frontend_exception")).toHaveLength(1);
    expect(events.filter(event => event.event_type === "log_event")).toHaveLength(511);
    sdk.dispose();
  });

  it("bounds concurrent explicit flush deadlines while retaining the stalled sender's queue", async () => {
    let release!: (value: { status: number }) => void;
    const held = new Promise<{ status: number }>(resolve => { release = resolve; });
    const { sdk, transport } = createSdk({ requestTimeoutMs: 20, batchSize: 20_000 });
    transport.mockReturnValueOnce(held);
    sdk.captureLog("held", "error");
    const started = performance.now();
    await Promise.all(Array.from({ length: 100 }, () => sdk.flush()));
    expect(performance.now() - started).toBeLessThan(500);
    expect(transport).toHaveBeenCalledTimes(1);
    const lane = (sdk as unknown as { eventTransport: { debug: { events: EventEnvelope[]; queuedBytes: number } } }).eventTransport.debug;
    expect(lane.events).toHaveLength(1);
    expect(lane.queuedBytes).toBeGreaterThan(0);
    await Promise.all(Array.from({ length: 100 }, () => sdk.flush()));
    expect(transport).toHaveBeenCalledTimes(1);
    release({ status: 202 });
    await vi.waitFor(() => expect(lane.events).toHaveLength(0));
    sdk.dispose();
  });

  it("charges expanded hook outputs before invoking the next callback and never restores dropped content", async () => {
    let inspected = 0;
    const { sdk, transport } = createSdk({ batchSize: 20_000, maxEventsPerSession: 20_000,
      beforeSend: event => {
        const lane = (sdk as unknown as { eventTransport: { debug: { events: EventEnvelope[]; queuedBytes: number } } }).eventTransport.debug;
        const retained = lane.events.reduce((total, entry) => total + new TextEncoder().encode(JSON.stringify(entry)).byteLength, 0);
        expect(retained).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(lane.queuedBytes).toBe(retained);
        inspected += 1;
        return event.event_type === "log_event" ? { ...event, payload: { ...event.payload,
          message: `app-redacted-${inspected}`, attributes: Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`field_${i}`, "x".repeat(4000)])) } } : event;
      }
    });
    for (let i = 0; i < 512; i++) sdk.captureLog(`original-${i}`, "error");
    expect(inspected).toBe(0);
    await sdk.flush();
    const sent = transport.mock.calls.flatMap((_, index) => createTransportEvents(transport, index));
    expect(sent.filter(event => event.event_type === "log_event").length).toBeGreaterThan(0);
    expect(sent.filter(event => event.event_type === "log_event").length).toBeLessThan(512);
    expect(JSON.stringify(sent)).not.toContain('"message":"original-');
    sdk.dispose();
  }, 30_000);

  it("rechecks final log level and bounds session admissions after deferred replacement", async () => {
    const { sdk, transport } = createSdk({ maxEventsPerSession: 1, beforeSend: event =>
      event.event_type === "log_event" && event.payload.message === "demote"
        ? { ...event, payload: { ...event.payload, level: "info" } } : event });
    sdk.captureLog("demote", "error");
    sdk.captureLog("first", "error");
    sdk.captureLog("extra", "error");
    await sdk.flush();
    const logs = transport.mock.calls.flatMap((_, index) => createTransportEvents(transport, index))
      .filter(event => event.event_type === "log_event");
    expect(logs.map(event => event.payload.message)).toEqual(["first"]);
    sdk.dispose();
  });

  it("reports one bounded pressure aggregate after an all-ERROR queue recovers", async (): Promise<void> => {
    let releaseFirst!: (result: { status: number }) => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseFirst = resolve; });
    const send = vi.fn().mockImplementationOnce(() => held).mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser",
      service: "web", environment: "test", transport: send
    } as unknown as ActiveConfig);
    let retainedPriorityReads = 0;
    const event = (id: string, tracked = false) => ({
      event_id: id, event_type: "log_event", payload: {
        get level() {
          if (tracked) retainedPriorityReads += 1;
          return "error";
        },
        message: id
      }
    }) as DebugBundleBrowserTransportEvent;

    for (let index = 0; index < 512; index += 1) transport.enqueueDebug(event(`retained-${index}`, true));
    const flush = transport.flush();
    retainedPriorityReads = 0;
    for (let index = 0; index < 10_000; index += 1) transport.enqueueDebug(event(`dropped-${index}`));
    expect(retainedPriorityReads).toBeLessThanOrEqual(512);
    releaseFirst({ status: 202 });
    await flush;

    const sent = send.mock.calls.flatMap((call) => (call[0] as { events: DebugBundleBrowserTransportEvent[] }).events);
    const reports = sent.filter((entry) => entry.event_type === "error_suppressed");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.payload.suppressed_count).toBe(10_000);
    expect(sent.filter((entry) => entry.event_type === "log_event")).toHaveLength(512);
    expect(sent.filter((entry) => entry.event_type === "log_event")
      .every((entry) => entry.event_id.startsWith("retained-"))).toBe(true);
    transport.reset();
  });

  it("does not lose an unsent pressure count when exceptions evict its queued report", async (): Promise<void> => {
    let releaseSecond!: (result: { status: number }) => void;
    let secondEntered!: () => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseSecond = resolve; });
    const entered = new Promise<void>((resolve) => { secondEntered = resolve; });
    const send = vi.fn().mockResolvedValueOnce({ status: 202 })
      .mockImplementationOnce(() => { secondEntered(); return held; })
      .mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser",
      service: "web", environment: "test", transport: send
    } as unknown as ActiveConfig);
    const warning = (id: number) => ({
      event_id: `warning-${id}`, event_type: "log_event", payload: { level: "warning", message: "warning" }
    }) as DebugBundleBrowserTransportEvent;
    const exception = (id: number) => ({
      event_id: `exception-${id}`, event_type: "frontend_exception", payload: { message: "failure" }
    }) as DebugBundleBrowserTransportEvent;

    try {
      for (let index = 0; index < 612; index += 1) transport.enqueueDebug(warning(index));
      const firstFlush = transport.flush();
      await entered;
      for (let index = 0; index < 256; index += 1) transport.enqueueDebug(exception(index));
      releaseSecond({ status: 202 });
      await firstFlush;
      await transport.flush();

      const sent = send.mock.calls.flatMap((call) =>
        (call[0] as { events: DebugBundleBrowserTransportEvent[] }).events);
      const reports = sent.filter((entry) => entry.event_type === "error_suppressed");
      expect(reports).toHaveLength(1);
      expect(reports[0]?.payload.suppressed_count).toBe(100);
      expect(sent.filter((entry) => entry.event_type === "frontend_exception")).toHaveLength(256);
    } finally {
      transport.reset();
    }
  });

  it("keeps browser pressure counts until the next bounded report window", async (): Promise<void> => {
    let now = Date.parse("2026-09-24T09:00:00.000Z");
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const send = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser",
      service: "web", environment: "test", transport: send
    } as unknown as ActiveConfig);
    const reports = () => send.mock.calls.flatMap((call) =>
      (call[0] as { events: DebugBundleBrowserTransportEvent[] }).events)
      .filter((entry) => entry.event_type === "error_suppressed");
    const burst = (prefix: string) => {
      for (let index = 0; index < 512; index += 1) {
        transport.enqueueDebug({ event_id: `${prefix}-${index}`, event_type: "log_event",
          payload: { level: "error", message: prefix } } as DebugBundleBrowserTransportEvent);
      }
      for (let index = 0; index < 100; index += 1) {
        transport.enqueueDebug({ event_id: `${prefix}-drop-${index}`, event_type: "log_event",
          payload: { level: "error", message: prefix } } as DebugBundleBrowserTransportEvent);
      }
    };

    try {
      burst("first");
      await transport.flush();
      expect(reports()).toHaveLength(1);
      now += 1_000;
      burst("second");
      await transport.flush();
      expect(reports()).toHaveLength(1);
      now += 30_000;
      await transport.flush();
      expect(reports()).toHaveLength(2);
      expect(reports()[1]?.payload.suppressed_count).toBe(100);
    } finally {
      transport.reset();
      clock.mockRestore();
    }
  });

  it("reports an oversized browser event drop after the queue is empty", async (): Promise<void> => {
    const send = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser",
      service: "web", environment: "test", transport: send
    } as unknown as ActiveConfig);

    transport.enqueueDebug({ event_id: "oversized", event_type: "log_event",
      payload: { level: "error", message: "x".repeat(9 * 1_024 * 1_024) } } as DebugBundleBrowserTransportEvent);
    await transport.flush();

    const sent = send.mock.calls.flatMap((call) => (call[0] as { events: DebugBundleBrowserTransportEvent[] }).events);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.event_type).toBe("error_suppressed");
    expect((sent[0]?.payload as { suppressed_count: number }).suppressed_count).toBe(1);
    transport.reset();
  });

  it("counts a held send and queued events in the same browser memory budget", async (): Promise<void> => {
    let releaseFirst!: (result: { status: number }) => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseFirst = resolve; });
    const send = vi.fn().mockImplementationOnce(() => held).mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000,
      flushInterval: 60_000,
      endpoint: "https://example.test/v1/events",
      transportMode: "direct",
      requestTimeoutMs: 5_000,
      projectToken: "dbundle_proj_browser",
      transport: send
    } as unknown as ActiveConfig);
    const event = (id: string, level: "warning" | "error") => ({
      event_id: id, event_type: "log_event", payload: { level, message: id }
    }) as DebugBundleBrowserTransportEvent;

    for (let index = 0; index < 512; index += 1) transport.enqueueDebug(event(`warning-${index}`, "warning"));
    const flush = transport.flush();
    expect(send).toHaveBeenCalledTimes(1);
    const sending = (send.mock.calls[0]?.[0] as { events: DebugBundleBrowserTransportEvent[] }).events;
    for (let index = 0; index < 512; index += 1) transport.enqueueDebug(event(`error-${index}`, "error"));

    const pending = (transport as unknown as {
      debug: { events: DebugBundleBrowserTransportEvent[] }
    }).debug.events;
    expect(new Set([...sending, ...pending].map((entry) => entry.event_id)).size).toBeLessThanOrEqual(512);
    expect(pending.some((entry) => entry.event_id.startsWith("error-"))).toBe(true);

    releaseFirst({ status: 202 });
    await flush;
    expect(send).toHaveBeenCalledTimes(2);
    expect((send.mock.calls[1]?.[0] as { events: DebugBundleBrowserTransportEvent[] }).events
      .every((entry) => entry.event_id.startsWith("error-"))).toBe(true);
    expect((transport as unknown as {
      debug: { events: DebugBundleBrowserTransportEvent[] }
    }).debug.events).toHaveLength(0);
    transport.reset();
  });

  it("keeps a held unload keepalive request inside the same retained-event cap", async (): Promise<void> => {
    vi.stubGlobal("navigator", {});
    let releaseKeepalive!: (response: { status: number }) => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseKeepalive = resolve; });
    const fetchImpl = vi.fn().mockImplementation(() => held);
    const normalSend = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser",
      fetchImpl, transport: normalSend
    } as unknown as ActiveConfig);
    const event = (id: string, level: "warning" | "error") => ({
      event_id: id, event_type: "log_event", payload: { level, message: id }
    }) as DebugBundleBrowserTransportEvent;
    for (let index = 0; index < 512; index += 1) transport.enqueueDebug(event(`warning-${index}`, "warning"));
    transport.flushViaBeacon();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const flushing = transport.flush();
    expect(normalSend).not.toHaveBeenCalled();
    for (let index = 0; index < 512; index += 1) transport.enqueueDebug(event(`error-${index}`, "error"));

    const retained = (transport as unknown as {
      debug: { events: DebugBundleBrowserTransportEvent[]; inFlightEvents: Map<DebugBundleBrowserTransportEvent, number> }
    }).debug;
    const body = (fetchImpl.mock.calls[0]?.[1] as { body: string }).body;
    const sent = (JSON.parse(body) as { events: DebugBundleBrowserTransportEvent[] }).events;
    expect(new Set([...sent, ...retained.events].map((entry) => entry.event_id)).size)
      .toBeLessThanOrEqual(512);

    releaseKeepalive({ status: 202 });
    await flushing;
    await vi.waitFor(() => expect(retained.inFlightEvents.size).toBe(0));
    transport.reset();
  });

  it("keeps relay beacons below the browser body limit and retains the rest for ordinary delivery", async (): Promise<void> => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon });
    const send = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 256, flushInterval: 60_000,
      endpoint: "/debugbundle/browser", transportMode: "relay",
      requestTimeoutMs: 5_000, projectToken: null, transport: send
    } as unknown as ActiveConfig);
    // A custom hook may return the same object for more than one queued event.
    const sharedEvent = { event_id: "relay-shared", event_type: "log_event",
      payload: { level: "error", message: "x".repeat(8_000) }
    } as DebugBundleBrowserTransportEvent;
    for (let index = 0; index < 12; index += 1) transport.enqueueDebug(sharedEvent);

    transport.flushViaBeacon();
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    const body = sendBeacon.mock.calls[0]?.[1] as Blob;
    expect(body.size).toBeLessThanOrEqual(64 * 1024);
    const sent = JSON.parse(await body.text()) as { batch: DebugBundleBrowserTransportEvent[] };
    expect(sent.batch.length).toBeGreaterThan(0);
    expect(sent.batch.length).toBeLessThan(12);
    const lane = (transport as unknown as { debug: { events: DebugBundleBrowserTransportEvent[] } }).debug;
    expect(lane.events.length + sent.batch.length).toBe(12);
    await transport.flush();
    expect(send.mock.calls.flatMap(([request]) =>
      (request as { events: DebugBundleBrowserTransportEvent[] }).events).length).toBe(12 - sent.batch.length);
    transport.reset();
  });

  it("leaves an oversized individual unload event for ordinary delivery", async (): Promise<void> => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    const fetchImpl = vi.fn();
    vi.stubGlobal("navigator", { sendBeacon });
    const send = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 256, flushInterval: 60_000,
      endpoint: "/debugbundle/browser", transportMode: "relay",
      requestTimeoutMs: 5_000, projectToken: null, fetchImpl, transport: send
    } as unknown as ActiveConfig);
    transport.enqueueDebug({ event_id: "large", event_type: "log_event",
      payload: { level: "error", message: "x".repeat(70_000) }
    } as DebugBundleBrowserTransportEvent);

    transport.flushViaBeacon();
    expect(sendBeacon).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
    const lane = (transport as unknown as { debug: { events: DebugBundleBrowserTransportEvent[] } }).debug;
    expect(lane.events.map(event => event.event_id)).toEqual(["large"]);
    await transport.flush();
    expect(send).toHaveBeenCalledTimes(1);
    transport.reset();
  });

  it("bounds authenticated direct keepalive and retains a failed chunk with the remaining events", async (): Promise<void> => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon });
    const fetchImpl = vi.fn().mockResolvedValue({ status: 503 });
    let releaseSend!: (response: { status: number }) => void;
    const heldSend = new Promise<{ status: number }>(resolve => { releaseSend = resolve; });
    const send = vi.fn().mockReturnValueOnce(heldSend);
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 256, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser",
      fetchImpl, transport: send
    } as unknown as ActiveConfig);
    for (let index = 0; index < 12; index += 1) {
      transport.enqueueDebug({ event_id: `direct-${index}`, event_type: "log_event",
        payload: { level: "error", message: "x".repeat(8_000) }
      } as DebugBundleBrowserTransportEvent);
    }

    transport.flushViaBeacon();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(sendBeacon).not.toHaveBeenCalled();
    const request = fetchImpl.mock.calls[0]?.[1] as {
      body: string;
      keepalive: boolean;
      headers: Record<string, string>;
    };
    expect(new TextEncoder().encode(request.body).byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(request.keepalive).toBe(true);
    expect(request.headers["authorization"]).toBe("Bearer dbundle_proj_browser");
    const lane = (transport as unknown as { debug: { events: DebugBundleBrowserTransportEvent[] } }).debug;
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(lane.events).toHaveLength(12);
    expect(send.mock.calls.flatMap(([sent]) =>
      (sent as { events: DebugBundleBrowserTransportEvent[] }).events).length).toBe(12);
    releaseSend({ status: 202 });
    await vi.waitFor(() => expect(lane.events).toHaveLength(0));
    transport.reset();
  });

  it("falls back to relay keepalive when sendBeacon throws", async (): Promise<void> => {
    vi.stubGlobal("navigator", { sendBeacon: vi.fn(() => { throw new Error("beacon unavailable"); }) });
    const fetchImpl = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 256, flushInterval: 60_000,
      endpoint: "/debugbundle/browser", transportMode: "relay",
      requestTimeoutMs: 5_000, projectToken: null, fetchImpl, transport: vi.fn()
    } as unknown as ActiveConfig);
    transport.enqueueDebug({ event_id: "throwing-beacon", event_type: "log_event",
      payload: { level: "error", message: "still delivered" }
    } as DebugBundleBrowserTransportEvent);

    expect(() => transport.flushViaBeacon()).not.toThrow();
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: "POST", keepalive: true, headers: { "content-type": "application/json" }
    });
    transport.reset();
  });

  it("coalesces repeated unload fallback calls while keepalive fetch is held", async (): Promise<void> => {
    vi.stubGlobal("navigator", {});
    let releaseKeepalive!: (response: { status: number }) => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseKeepalive = resolve; });
    const fetchImpl = vi.fn().mockImplementation(() => held);
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 10, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser",
      fetchImpl, transport: vi.fn()
    } as unknown as ActiveConfig);
    transport.enqueueDebug({
      event_id: "repeated-unload", event_type: "log_event",
      payload: { level: "error", message: "one held keepalive" }
    } as DebugBundleBrowserTransportEvent);

    for (let index = 0; index < 1_000; index += 1) transport.flushViaBeacon();
    await Promise.resolve();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    releaseKeepalive({ status: 202 });
    await vi.waitFor(() => expect((transport as unknown as {
      debug: { inFlightEvents: Map<DebugBundleBrowserTransportEvent, number> }
    }).debug.inFlightEvents.size).toBe(0));
    transport.reset();
  });

  it("releases a timed-out keepalive fallback without acknowledging its events", async (): Promise<void> => {
    vi.stubGlobal("navigator", {});
    let signal: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: unknown, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }));
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 10, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 10, projectToken: "dbundle_proj_browser",
      fetchImpl, transport: vi.fn()
    } as unknown as ActiveConfig);
    transport.enqueueDebug({
      event_id: "keepalive-failure", event_type: "log_event",
      payload: { level: "error", message: "retain on timeout" }
    } as DebugBundleBrowserTransportEvent);

    transport.flushViaBeacon();
    const lane = (transport as unknown as {
      debug: { events: DebugBundleBrowserTransportEvent[]; inFlightEvents: Map<DebugBundleBrowserTransportEvent, number> }
    }).debug;
    await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 500 });
    await vi.waitFor(() => expect(lane.inFlightEvents.size).toBe(0));
    expect(lane.events.map((event) => event.event_id)).toEqual(["keepalive-failure"]);
    transport.reset();
  });

  it("does not apply an old transport response after reconfiguration", async (): Promise<void> => {
    let releaseOld!: (response: { status: number; body: { old: boolean } }) => void;
    const held = new Promise<{ status: number; body: { old: boolean } }>((resolve) => { releaseOld = resolve; });
    const onDebugResponse = vi.fn();
    const transport = new BrowserEventTransport({
      onDebugResponse, onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    const config = (sender: ReturnType<typeof vi.fn>) => ({
      batchSize: 1, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser", transport: sender
    }) as unknown as ActiveConfig;
    transport.configure(config(vi.fn().mockImplementation(() => held)));
    transport.enqueueDebug({
      event_id: "old-event", event_type: "log_event", payload: { level: "error", message: "old" }
    } as DebugBundleBrowserTransportEvent);
    const oldFlush = transport.flush();
    transport.configure(config(vi.fn().mockResolvedValue({ status: 202 })));
    releaseOld({ status: 202, body: { old: true } });
    await oldFlush;

    expect(onDebugResponse).not.toHaveBeenCalled();
    expect(transport.lastEventAt).toBeNull();
    transport.reset();
  });

  it("does not open a new sender while a retired generation still owns a held batch", async (): Promise<void> => {
    let releaseOld!: (response: { status: number }) => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseOld = resolve; });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    const config = (sender: ReturnType<typeof vi.fn>) => ({
      batchSize: 1, flushInterval: 60_000,
      endpoint: "https://example.test/v1/events", transportMode: "direct",
      requestTimeoutMs: 5_000, projectToken: "dbundle_proj_browser", transport: sender
    }) as unknown as ActiveConfig;
    const event = (id: string) => ({
      event_id: id, event_type: "log_event", payload: { level: "error", message: id }
    }) as DebugBundleBrowserTransportEvent;
    transport.configure(config(vi.fn().mockImplementation(() => held)));
    transport.enqueueDebug(event("old"));
    const oldFlush = transport.flush();

    const newSender = vi.fn().mockResolvedValue({ status: 202 });
    transport.configure(config(newSender));
    for (let index = 0; index < 1_000; index += 1) transport.enqueueDebug(event(`new-${index}`));
    await transport.flush();
    expect(newSender).not.toHaveBeenCalled();

    releaseOld({ status: 202 });
    await oldFlush;
    transport.enqueueDebug(event("after-old-settled"));
    await transport.flush();
    expect(newSender).toHaveBeenCalledTimes(1);
    transport.reset();
  });

  it("does not refill the queue after an accepted beacon while another send is held", async (): Promise<void> => {
    vi.stubGlobal("navigator", { sendBeacon: vi.fn().mockReturnValue(true) });
    let releaseFirst!: (response: { status: number }) => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseFirst = resolve; });
    const sender = vi.fn().mockImplementationOnce(() => held).mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 1, flushInterval: 60_000,
      endpoint: "/debugbundle/browser", transportMode: "relay",
      requestTimeoutMs: 5_000, projectToken: null, transport: sender
    } as unknown as ActiveConfig);
    const event = (id: string) => ({
      event_id: id, event_type: "log_event", payload: { level: "error", message: id }
    }) as DebugBundleBrowserTransportEvent;
    transport.enqueueDebug(event("sending"));
    const first = transport.flush();
    transport.flushViaBeacon();
    for (let index = 0; index < 1_000; index += 1) transport.enqueueDebug(event(`after-beacon-${index}`));
    const lane = (transport as unknown as {
      debug: { events: DebugBundleBrowserTransportEvent[] }
    }).debug;
    expect(lane.events).toHaveLength(0);

    releaseFirst({ status: 202 });
    await first;
    transport.enqueueDebug(event("after-send-settled"));
    await transport.flush();
    expect(sender).toHaveBeenCalledTimes(2);
    transport.reset();
  });

  it("bounds a stalled debug lane while preserving an exception over later logs", async (): Promise<void> => {
    const send = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(),
      onUnauthorized: vi.fn(),
      onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000,
      flushInterval: 60_000,
      endpoint: "https://example.test/v1/events",
      transportMode: "direct",
      requestTimeoutMs: 5_000,
      projectToken: "dbundle_proj_browser",
      transport: send
    } as unknown as ActiveConfig);
    const event = (id: number, eventType: "frontend_exception" | "log_event") => ({
      event_id: `event-${id}`,
      event_type: eventType,
      payload: eventType === "log_event" ? { level: "warning", message: `warning ${id}` } : { message: "root failure" }
    }) as DebugBundleBrowserTransportEvent;

    transport.enqueueDebug(event(0, "frontend_exception"));
    for (let index = 1; index <= 10_000; index += 1) transport.enqueueDebug(event(index, "log_event"));
    await transport.flush();

    const sent = (send.mock.calls[0]?.[0] as { events: DebugBundleBrowserTransportEvent[] }).events;
    expect(sent.length).toBeLessThanOrEqual(512);
    expect(sent.some((entry) => entry.event_type === "frontend_exception")).toBe(true);
    transport.reset();
  });

  it("retains failed requests when ordinary request traffic fills the debug lane", async (): Promise<void> => {
    const send = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000,
      flushInterval: 60_000,
      endpoint: "https://example.test/v1/events",
      transportMode: "direct",
      requestTimeoutMs: 5_000,
      projectToken: "dbundle_proj_browser",
      transport: send
    } as unknown as ActiveConfig);
    const request = (id: string, status: number) => ({
      event_id: id,
      event_type: "request_event",
      payload: { response_status: status }
    }) as DebugBundleBrowserTransportEvent;

    transport.enqueueDebug(request("server-failure", 503));
    transport.enqueueDebug(request("throttled", 429));
    for (let index = 0; index < 1_000; index += 1) transport.enqueueDebug(request(`ordinary-${index}`, 200));
    await transport.flush();

    const sent = (send.mock.calls[0]?.[0] as { events: DebugBundleBrowserTransportEvent[] }).events;
    expect(sent.map((entry) => entry.event_id)).toContain("server-failure");
    expect(sent.map((entry) => entry.event_id)).toContain("throttled");
    expect(sent.length).toBeLessThanOrEqual(512);
    transport.reset();
  });

  it("keeps queued transport bytes finite when individual events are large", async (): Promise<void> => {
    const send = vi.fn().mockResolvedValue({ status: 202 });
    const transport = new BrowserEventTransport({
      onDebugResponse: vi.fn(), onUnauthorized: vi.fn(), onAcknowledgementDiagnostic: vi.fn()
    });
    transport.configure({
      batchSize: 20_000,
      flushInterval: 60_000,
      endpoint: "https://example.test/v1/events",
      transportMode: "direct",
      requestTimeoutMs: 5_000,
      projectToken: "dbundle_proj_browser",
      transport: send
    } as unknown as ActiveConfig);

    const largeMessage = "x".repeat(1024 * 1024);
    for (let index = 0; index < 20; index += 1) {
      transport.enqueueDebug({
        event_id: `large-${index}`,
        event_type: "log_event",
        payload: { level: "warning", message: largeMessage }
      } as DebugBundleBrowserTransportEvent);
    }
    await transport.flush();

    const sent = (send.mock.calls[0]?.[0] as { events: DebugBundleBrowserTransportEvent[] }).events;
    expect(new TextEncoder().encode(JSON.stringify(sent)).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(sent.length).toBeGreaterThan(0);
    transport.reset();
  });
});
