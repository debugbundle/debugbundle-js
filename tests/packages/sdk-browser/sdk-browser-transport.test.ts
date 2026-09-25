import { describe, expect, it, vi } from "vitest";

import * as browserFixtures from "../../helpers/sdk-browser-fixtures.js";
import type { DebugBundleBrowserTransportEvent } from "../../../packages/sdk-browser/src/types.js";

describe("sdk-browser transport", () => {
  it("should only capture 4xx and 5xx network breadcrumbs by default", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk();

    await browserFixtures.settleAsyncInit();
    globals.fetchMock.mockClear();

    const browserFetch = (globalThis as Record<string, unknown>)["fetch"] as (input: string, init?: { method?: string }) => Promise<{
      status: number;
    }>;

    globals.fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: false, status: 500 });

    await browserFetch("https://api.example.com/cart", { method: "GET" });
    await browserFetch("https://api.example.com/cart/404", { method: "POST" });
    await browserFetch("https://api.example.com/cart/500", { method: "PUT" });

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    const networkBreadcrumbs = (event.payload.breadcrumbs ?? []).filter(
      (breadcrumb) => breadcrumb.breadcrumb_type === "network_request"
    );

    expect(networkBreadcrumbs).toHaveLength(2);
    expect(networkBreadcrumbs.map((breadcrumb) => breadcrumb.data["status_code"])).toEqual([404, 500]);
  });

  it("should attach request metadata to captured network breadcrumbs", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk();

    await browserFixtures.settleAsyncInit();
    globals.fetchMock.mockClear();

    const browserFetch = (globalThis as Record<string, unknown>)["fetch"] as (
      input: string,
      init?: { method?: string; debugbundle?: Record<string, string> }
    ) => Promise<{ status: number }>;

    globals.fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    await browserFetch("/v1/auth/session", {
      method: "GET",
      debugbundle: {
        operation: "auth.session.get",
        initiator: "session.bootstrap",
        feature: "auth"
      }
    });

    sdk.captureException(new Error("Session bootstrap failed"));
    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(
      browserFixtures.createTransportEvents(transport, 0).find((candidate) => candidate.event_type === "frontend_exception")
    );
    const networkBreadcrumb = (event.payload.breadcrumbs ?? []).find(
      (breadcrumb) => breadcrumb.breadcrumb_type === "network_request"
    );

    expect(networkBreadcrumb?.data).toMatchObject({
      url: "/v1/auth/session",
      method: "GET",
      status_code: 401,
      operation: "auth.session.get",
      initiator: "session.bootstrap",
      feature: "auth"
    });
  });

  it("should honor networkFilter allow, deny, status, and latency controls", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));

    const { sdk, transport, globals } = browserFixtures.createSdk({
      breadcrumbsOnErrorOnly: false,
      networkFilter: {
        urlPatterns: ["api.example.com"],
        urlDenyPatterns: ["/health"],
        statusCodes: [500, 599],
        minResponseTime: 50
      }
    });

    await browserFixtures.settleAsyncInit();
    globals.fetchMock.mockClear();

    globals.fetchMock
      .mockImplementationOnce(() => {
        vi.advanceTimersByTime(75);
        return { ok: false, status: 503 };
      })
      .mockImplementationOnce(() => {
        vi.advanceTimersByTime(75);
        return { ok: false, status: 503 };
      })
      .mockImplementationOnce(() => {
        vi.advanceTimersByTime(10);
        return { ok: false, status: 503 };
      })
      .mockImplementationOnce(() => {
        vi.advanceTimersByTime(90);
        return { ok: false, status: 503 };
      });

    const browserFetch = (globalThis as Record<string, unknown>)["fetch"] as (input: string, init?: { method?: string }) => Promise<{
      status: number;
    }>;

    await browserFetch("https://other.example.com/checkout", { method: "GET" });
    await browserFetch("https://api.example.com/health", { method: "GET" });
    await browserFetch("https://api.example.com/checkout/fast", { method: "POST" });
    await browserFetch("https://api.example.com/checkout/slow", { method: "POST" });

    await sdk.flush();

    const events = browserFixtures.createTransportEvents(transport, 0);
    expect(events.map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    const breadcrumbEvent = browserFixtures.getFrontendBreadcrumbEvent(events[0]);
    expect(breadcrumbEvent.payload).toMatchObject({
      breadcrumb_type: "network_request",
      route: "/checkout",
      data: {
        url: "https://api.example.com/checkout/slow",
        method: "POST",
        status_code: 503,
        duration_ms: 90
      }
    });
    expect(breadcrumbEvent.payload.data["caller_trace"]).toEqual(expect.any(Array));
  });

  it("should sample at the session level while still capturing frontend exceptions", async (): Promise<void> => {
    vi.spyOn(Math, "random").mockReturnValue(0.95);

    const { sdk, transport, globals } = browserFixtures.createSdk({
      sessionSampleRate: 0.5
    });

    sdk.captureMessage("sampled-out log", "warning");
    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "pay-now",
        textContent: "Pay Now"
      }
    });

    sdk.captureException(new Error("Still capture the exception"));
    await sdk.flush();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_exception"]);

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.breadcrumbs ?? []).toHaveLength(0);
  });

  it("should sample non-exception browser events while still allowing frontend exceptions", async (): Promise<void> => {
    vi.spyOn(Math, "random").mockReturnValue(0.95);

    const { sdk, transport } = browserFixtures.createSdk({
      sampleRate: 0.5
    });

    sdk.captureMessage("sampled-out warning", "warning");
    sdk.captureException(new Error("Still capture the exception"));
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_exception"]);
  });

  it("should discard log events below the configured logLevel threshold", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk({
      logLevel: "error"
    });

    sdk.captureLog("debug noise", "debug", { token: "debug-secret" });
    sdk.captureLog("warning noise", "warning");
    sdk.captureLog("real error", "error", { token: "error-secret" });
    sdk.captureLog("critical issue", "critical");
    await sdk.flush();

    const events = browserFixtures.createTransportEvents(transport, 0);
    expect(events).toHaveLength(2);
    expect(browserFixtures.getEventMessage(events[0]!)).toBe("real error");
    expect(browserFixtures.getEventMessage(events[1]!)).toBe("critical issue");

    if (events[0]?.event_type === "log_event") {
      expect(events[0].payload.attributes).toEqual({
        token: "[REDACTED]"
      });
    }
  });

  it("should send the first three identical frontend exceptions and aggregate later duplicates", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const { sdk, transport } = browserFixtures.createSdk();

    browserFixtures.captureRepeatedException(sdk, "duplicate checkout failure", 5);
    await sdk.flush();

    const events = browserFixtures.createTransportEvents(transport, 0);
    expect(events.map((event) => event.event_type)).toEqual([
      "frontend_exception",
      "frontend_exception",
      "frontend_exception",
      "error_suppressed"
    ]);

    const suppressed = browserFixtures.getErrorSuppressedEvent(events[3]);
    expect(suppressed.payload.suppressed_count).toBe(2);
    expect(suppressed.payload.window_seconds).toBe(30);
    expect(suppressed.payload.first_seen).toBe("2026-03-14T00:00:00.000Z");
    expect(suppressed.payload.last_seen).toBe("2026-03-14T00:00:00.000Z");
    expect(suppressed.payload.fingerprint.length).toBeGreaterThan(0);
  });

  it("delivers duplicate-suppression summaries on the automatic timer", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));
    const { sdk, transport } = browserFixtures.createSdk({ batchSize: 10, flushInterval: 100 });

    browserFixtures.captureRepeatedException(sdk, "automatic duplicate", 5);
    await vi.advanceTimersByTimeAsync(100);

    const events = transport.mock.calls.flatMap((_call: unknown[], index: number) =>
      browserFixtures.createTransportEvents(transport, index));
    expect(events.filter((event) => event.event_type === "frontend_exception")).toHaveLength(3);
    expect(events.filter((event) => event.event_type === "error_suppressed")).toHaveLength(1);
  });

  it("includes a pending duplicate-suppression summary in the relay unload beacon", async (): Promise<void> => {
    const { sdk, globals } = browserFixtures.createSdk({
      batchSize: 10, transportMode: "relay", endpoint: "/debugbundle/browser"
    });
    browserFixtures.captureRepeatedException(sdk, "unload duplicate", 5);

    globals.windowTarget.dispatch("pagehide", {});
    expect(globals.sendBeacon).toHaveBeenCalledTimes(1);
    const body = globals.sendBeacon.mock.calls[0]?.[1] as Blob | string;
    const serialized = typeof body === "string" ? body : await body.text();
    const events = (JSON.parse(serialized) as { batch: DebugBundleBrowserTransportEvent[] }).batch;
    expect(events.filter((event) => event.event_type === "frontend_exception")).toHaveLength(3);
    expect(events.filter((event) => event.event_type === "error_suppressed")).toHaveLength(1);
  });

  it("keeps an automatic suppression summary due while a sender is held", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));
    let releaseFirst!: (response: { status: number }) => void;
    const held = new Promise<{ status: number }>((resolve) => { releaseFirst = resolve; });
    const sender = vi.fn().mockImplementationOnce(() => held).mockResolvedValue({ status: 202 });
    const { sdk } = browserFixtures.createSdk({ batchSize: 1, flushInterval: 100, transport: sender });

    browserFixtures.captureRepeatedException(sdk, "held duplicate", 5);
    await Promise.resolve();
    expect(sender).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    releaseFirst({ status: 202 });
    await vi.advanceTimersByTimeAsync(100);

    const calls = sender.mock.calls as Array<[{ events: DebugBundleBrowserTransportEvent[] }]>;
    expect(calls.flatMap((call) => call[0].events)
      .filter((event) => event.event_type === "error_suppressed")).toHaveLength(1);
  });

  it("should keep identical frontend exceptions suppressed until silence resets loop protection", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const { sdk, transport } = browserFixtures.createSdk();

    browserFixtures.captureRepeatedException(sdk, "recursive failure", 11);
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
      "frontend_exception",
      "frontend_exception",
      "frontend_exception",
      "error_suppressed"
    ]);

    transport.mockClear();

    vi.setSystemTime(new Date("2026-03-14T00:00:30.000Z"));
    browserFixtures.captureRepeatedException(sdk, "recursive failure", 2);
    await sdk.flush();

    const checkpointEvents = browserFixtures.createTransportEvents(transport, 0);
    expect(checkpointEvents).toHaveLength(1);
    expect(checkpointEvents[0]?.event_type).toBe("error_suppressed");
    expect(browserFixtures.getErrorSuppressedEvent(checkpointEvents[0]).payload.suppressed_count).toBe(2);

    transport.mockClear();

    vi.setSystemTime(new Date("2026-03-14T00:01:31.000Z"));
    sdk.captureException(new Error("recursive failure"));
    await sdk.flush();

    const recoveredEvents = browserFixtures.createTransportEvents(transport, 0);
    expect(recoveredEvents).toHaveLength(1);
    expect(recoveredEvents[0]?.event_type).toBe("frontend_exception");
    expect(browserFixtures.getEventMessage(recoveredEvents[0]!)).toBe("recursive failure");
  });

  it("should stop non-exception capture after max events per session is reached", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      maxEventsPerSession: 1
    });

    sdk.captureMessage("first browser log", "warning");
    sdk.captureMessage("second browser log", "error");
    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "pay-now",
        textContent: "Pay Now"
      }
    });

    sdk.captureException(new Error("Still capture the exception"));
    await sdk.flush();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
      "log_event",
      "frontend_exception"
    ]);

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[1]);
    expect(event.payload.breadcrumbs ?? []).toHaveLength(0);
  });

  it("should auto-flush when the batch size is reached", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk({
      batchSize: 2
    });

    sdk.captureMessage("first browser log", "warning");
    sdk.captureMessage("second browser log", "error");

    await browserFixtures.settleAsyncInit();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event", "log_event"]);
  });

  it("uses authenticated keepalive instead of an unauthenticated beacon for direct ingestion", async (): Promise<void> => {
    const { sdk, globals } = browserFixtures.createSdk();

    sdk.captureMessage("flush me on unload", "error");
    globals.windowTarget.dispatch("pagehide", {});
    await browserFixtures.settleAsyncInit();

    expect(globals.sendBeacon).not.toHaveBeenCalled();
    expect(globals.fetchMock).toHaveBeenCalledWith("https://api.debugbundle.com/v1/events", expect.objectContaining({
      method: "POST",
      keepalive: true,
      headers: {
        authorization: "Bearer dbundle_proj_browser",
        "content-type": "application/json"
      }
    }));
  });

  it("does not use a direct-ingestion beacon even when the browser would accept one", async (): Promise<void> => {
    const { sdk, globals } = browserFixtures.createSdk();

    await browserFixtures.settleAsyncInit();
    globals.fetchMock.mockClear();
    globals.sendBeacon.mockReturnValue(true);

    sdk.captureMessage("flush me with keepalive", "error");
    globals.windowTarget.dispatch("pagehide", {});

    await browserFixtures.settleAsyncInit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(globals.sendBeacon).not.toHaveBeenCalled();
    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
    expect(globals.fetchMock.mock.calls[0]?.[0]).toBe("https://api.debugbundle.com/v1/events");
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: {
        authorization: "Bearer dbundle_proj_browser",
        "content-type": "application/json"
      }
    });
  });

  it("should keep absolute relay unload flushes credential-free and batch-shaped", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.init({
      transportMode: "relay",
      endpoint: "https://api.example.test/debugbundle/browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000
    });

    globals.sendBeacon.mockReturnValue(false);

    sdk.captureMessage("flush me through absolute relay", "error");
    globals.windowTarget.dispatch("pagehide", {});

    await browserFixtures.settleAsyncInit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(globals.sendBeacon).toHaveBeenCalledTimes(1);
    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
    expect(globals.fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/debugbundle/browser");
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      keepalive: true,
      headers: {
        "content-type": "application/json"
      }
    });
    expect(String(globals.fetchMock.mock.calls[0]?.[1]?.body)).toContain('"batch"');
    expect(String(globals.fetchMock.mock.calls[0]?.[1]?.body)).not.toContain('"events"');
  });

  it("should inject trace headers into allowlisted cross-origin fetch requests", async (): Promise<void> => {
    const { globals } = browserFixtures.createSdk({
      captureNetwork: false,
      tracePropagationTargets: ["https://api.example.com"]
    } as Parameters<browserFixtures.DebugBundleBrowserSdk["init"]>[0]);

    await Promise.resolve();
    await Promise.resolve();
    globals.fetchMock.mockClear();

    const browserFetch = (globalThis as Record<string, unknown>)["fetch"] as (input: string, init?: {
      method?: string;
      headers?: Record<string, string>;
    }) => Promise<{ status: number }>;

    await browserFetch("https://api.example.com/trace-test", {
      method: "POST",
      headers: {
        authorization: "Bearer upstream"
      }
    });

    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer upstream",
        "X-DebugBundle-Trace-Id": "00000000-0000-4000-8000-000000000002"
      }
    });
  });

  it("should not inject trace headers into third-party fetch requests by default", async (): Promise<void> => {
    const { globals } = browserFixtures.createSdk({
      captureNetwork: false
    });

    await Promise.resolve();
    await Promise.resolve();
    globals.fetchMock.mockClear();

    const browserFetch = (globalThis as Record<string, unknown>)["fetch"] as (input: string, init?: {
      method?: string;
      headers?: Record<string, string>;
    }) => Promise<{ status: number }>;

    await browserFetch("https://third-party.example/trace-test", {
      method: "POST",
      headers: {
        authorization: "Bearer upstream"
      }
    });

    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer upstream"
      }
    });
    expect((globals.fetchMock.mock.calls[0]?.[1] as { headers?: Record<string, string> } | undefined)?.headers).not.toHaveProperty(
      "X-DebugBundle-Trace-Id"
    );
  });

  it("should inject trace headers into XMLHttpRequest and capture failing requests", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      breadcrumbsOnErrorOnly: false
    });

    await Promise.resolve();
    await Promise.resolve();
    globals.xhrResponses.push({ status: 503 });

    const XmlHttpRequestConstructor = (globalThis as Record<string, unknown>)["XMLHttpRequest"] as new () => {
      open(method: string, url: string): void;
      send(body?: unknown): void;
    };
    const request = new XmlHttpRequestConstructor();
    request.open("POST", "https://example.com/xhr-checkout");
    request.send('{"checkout":true}');

    await sdk.flush();

    expect(globals.xhrRequests).toHaveLength(1);
    expect(globals.xhrRequests[0]).toMatchObject({
      method: "POST",
      url: "https://example.com/xhr-checkout",
      headers: {
        "X-DebugBundle-Trace-Id": "00000000-0000-4000-8000-000000000002"
      },
      body: '{"checkout":true}'
    });

    const events = browserFixtures.createTransportEvents(transport, 0);
    expect(events.map((event) => event.event_type)).toEqual(["frontend_breadcrumb", "request_event"]);
    const breadcrumbEvent = browserFixtures.getFrontendBreadcrumbEvent(events[0]);
    expect(breadcrumbEvent.payload).toMatchObject({
      breadcrumb_type: "network_request",
      route: "/checkout",
      data: {
        url: "https://example.com/xhr-checkout",
        method: "POST",
        status_code: 503
      }
    });
    expect(breadcrumbEvent.payload.data["duration_ms"]).toBeGreaterThanOrEqual(0);

    const requestEvent = events[1] as browserFixtures.RequestEvent | undefined;
    expect(requestEvent?.event_type).toBe("request_event");
    expect(requestEvent?.payload).toMatchObject({
      method: "POST",
      path: "/xhr-checkout",
      response_status: 503
    });
  });

  it("should read probe_directives from ingestion responses without extra polling", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const configJson = vi.fn().mockResolvedValue({
      probes_enabled: true,
      remote_probes_enabled: true,
      active_probes: [],
      poll_interval_ms: 60000
    });
    const ingestionJson = vi.fn().mockResolvedValue({
      accepted: 1,
      rejected: 0,
      errors: [],
      probe_directives: {
        active_probes: [
          {
            activation_id: "11111111-1111-4111-8111-111111111111",
            label_pattern: "checkout.ui.*",
            service: "*",
            environment: "production",
            expires_at: "2026-03-20T00:00:00.000Z",
            trigger_expires_at: "2026-03-21T00:00:00.000Z"
          }
        ]
      }
    });

    globals.fetchMock
      .mockResolvedValueOnce({ ok: true, status: 200, json: configJson })
      .mockResolvedValueOnce({ ok: true, status: 202, json: ingestionJson });

    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000
    });

    await Promise.resolve();
    sdk.captureMessage("flush with piggyback directives", "warning");
    await sdk.flush();

    expect(globals.fetchMock).toHaveBeenCalledTimes(2);
    expect(globals.fetchMock.mock.calls[1]?.[0]).toBe("https://api.debugbundle.com/v1/events");
    expect(ingestionJson).toHaveBeenCalledTimes(1);
  });

  it("should retain buffered events when transport fails", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    void globals;

    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    sdk.captureMessage("browser retry", "error");

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(browserFixtures.createTransportEvents(transport, 1).map((event) => event.event_type)).toEqual(["log_event"]);
  });

  it("should retain buffered events and back off after a 429 response", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T00:00:00.000Z"));

    const globals = browserFixtures.installBrowserGlobals();
    void globals;

    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, retry_after_ms: 5_000 })
      .mockResolvedValueOnce({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    sdk.captureMessage("browser retry after throttle", "error");

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-16T00:00:05.001Z"));

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(browserFixtures.createTransportEvents(transport, 1).map((event) => event.event_type)).toEqual(["log_event"]);
  });

  it("should stop retrying after an unauthorized ingestion response", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    void globals;
    const consoleSource = { error: vi.fn(), warn: vi.fn() };
    vi.stubGlobal("console", consoleSource as unknown);

    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, body: { error: "invalid_project_token" } })
      .mockResolvedValueOnce({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    sdk.captureMessage("browser unauthorized", "error");

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(sdk.status).toBe("disconnected");
    expect(consoleSource.error).toHaveBeenCalledTimes(1);
    expect(consoleSource.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "DebugBundle browser SDK disabled after ingestion returned 401 for https://api.debugbundle.com/v1/events"
      )
    );
    expect(consoleSource.error).toHaveBeenCalledWith(expect.stringContaining("invalid_project_token"));

    sdk.captureMessage("browser unauthorized again", "error");
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(consoleSource.error).toHaveBeenCalledTimes(1);
  });

});
