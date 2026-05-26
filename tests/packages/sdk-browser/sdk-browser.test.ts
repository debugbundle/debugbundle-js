import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveProbeTriggerTokenKey, generateProbeTriggerToken } from "../../helpers/probe-trigger-token.js";
import {
  createDebugBundleBrowserSdk,
  type DebugBundleBrowserSdk,
  type DebugBundleBrowserTransportRequest
} from "../../../packages/sdk-browser/src/index.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

type TransportMock = ReturnType<typeof vi.fn>;
type ErrorSuppressedEvent = Extract<EventEnvelope, { event_type: "error_suppressed" }>;
type FrontendExceptionEvent = Extract<EventEnvelope, { event_type: "frontend_exception" }>;
type FrontendBreadcrumbEvent = Extract<EventEnvelope, { event_type: "frontend_breadcrumb" }>;
type RequestEvent = Extract<EventEnvelope, { event_type: "request_event" }>;
type ProbeEvent = Extract<EventEnvelope, { event_type: "probe_event" }>;
const originalProbeTriggerSecret = process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];

class FakeEventTarget {
  private listeners = new Map<string, Set<(event: unknown) => void>>();

  public addEventListener(eventName: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(eventName) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  public removeEventListener(eventName: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(eventName);
    listeners?.delete(listener);
    if (listeners !== undefined && listeners.size === 0) {
      this.listeners.delete(eventName);
    }
  }

  public dispatch(eventName: string, event: unknown): void {
    const listeners = this.listeners.get(eventName);
    if (listeners === undefined) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }
}

beforeEach((): void => {
  process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = "test-probe-secret";
});

interface InstalledBrowserGlobals {
  windowTarget: FakeEventTarget;
  documentTarget: FakeEventTarget & {
    visibilityState: "visible" | "hidden";
    activeElement: unknown;
  };
  historyCalls: string[];
  sendBeacon: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  xhrRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }>;
  xhrResponses: Array<{ status: number }>;
}

const activeSdks: DebugBundleBrowserSdk[] = [];

function createTransportEvents(transport: TransportMock, callIndex: number): EventEnvelope[] {
  const calls = transport.mock.calls as Array<[DebugBundleBrowserTransportRequest]>;
  return calls[callIndex]?.[0].events ?? [];
}

function getFrontendExceptionEvent(event: EventEnvelope | undefined): FrontendExceptionEvent {
  if (event === undefined || event.event_type !== "frontend_exception") {
    throw new Error("Expected a frontend_exception event");
  }

  return event;
}

function getFrontendBreadcrumbEvent(event: EventEnvelope | undefined): FrontendBreadcrumbEvent {
  if (event === undefined || event.event_type !== "frontend_breadcrumb") {
    throw new Error("Expected a frontend_breadcrumb event");
  }

  return event;
}

function getErrorSuppressedEvent(event: EventEnvelope | undefined): ErrorSuppressedEvent {
  if (event === undefined || event.event_type !== "error_suppressed") {
    throw new Error("Expected an error_suppressed event");
  }

  return event;
}

function getProbeEvent(event: EventEnvelope | undefined): ProbeEvent {
  if (event === undefined || event.event_type !== "probe_event") {
    throw new Error("Expected a probe_event");
  }

  return event;
}

function installBrowserGlobals(): InstalledBrowserGlobals {
  const windowTarget = new FakeEventTarget();
  const documentBase = new FakeEventTarget() as FakeEventTarget & {
    visibilityState: "visible" | "hidden";
    activeElement: unknown;
  };
  documentBase.visibilityState = "visible";
  documentBase.activeElement = null;

  const historyCalls: string[] = [];
  const sendBeacon = vi.fn().mockReturnValue(true);
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
  const xhrRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const xhrResponses: Array<{ status: number }> = [];
  let traceCounter = 0;

  class FakeXMLHttpRequest extends FakeEventTarget {
    public status = 0;
    private method = "GET";
    private url = "";
    private headers: Record<string, string> = {};

    public open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }

    public setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }

    public send(body?: unknown): void {
      const response = xhrResponses.shift() ?? { status: 200 };
      this.status = response.status;
      xhrRequests.push({
        method: this.method,
        url: this.url,
        headers: { ...this.headers },
        body: body ?? null
      });
      this.dispatch("loadend", {});
    }
  }

  const history = {
    pushState: (_state: unknown, _title: string, url?: string | URL | null): void => {
      historyCalls.push(String(url ?? ""));
    },
    replaceState: (_state: unknown, _title: string, url?: string | URL | null): void => {
      historyCalls.push(`replace:${String(url ?? "")}`);
    }
  };
  const subtle = webcrypto.subtle;

  vi.stubGlobal("window", windowTarget as unknown);
  vi.stubGlobal("document", documentBase as unknown);
  vi.stubGlobal("history", history as unknown);
  vi.stubGlobal("location", { href: "https://example.com/checkout", pathname: "/checkout", search: "" } as unknown);
  vi.stubGlobal(
    "navigator",
    {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.94 Safari/537.36",
      language: "en-US",
      maxTouchPoints: 0,
      connection: { effectiveType: "4g" },
      sendBeacon
    } as unknown
  );
  vi.stubGlobal("screen", { width: 2560, height: 1440 } as unknown);
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      media: query,
      matches: query.includes("dark"),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })) as unknown
  );
  vi.stubGlobal("fetch", fetchMock as unknown);
  vi.stubGlobal("XMLHttpRequest", FakeXMLHttpRequest as unknown);
  vi.stubGlobal(
    "crypto",
    {
      subtle,
      randomUUID: vi.fn().mockImplementation(() => {
        traceCounter += 1;
        return `00000000-0000-4000-8000-${String(traceCounter).padStart(12, "0")}`;
      })
    } as unknown
  );

  return {
    windowTarget,
    documentTarget: documentBase,
    historyCalls,
    sendBeacon,
    fetchMock,
    xhrRequests,
    xhrResponses
  };
}

function createSdk(
  overrides: Parameters<DebugBundleBrowserSdk["init"]>[0] = {}
): { sdk: DebugBundleBrowserSdk; transport: TransportMock; globals: InstalledBrowserGlobals } {
  const globals = installBrowserGlobals();
  const transport = vi.fn().mockResolvedValue({ status: 202 });
  const sdk = createDebugBundleBrowserSdk();
  activeSdks.push(sdk);
  sdk.init({
    projectToken: "dbundle_proj_browser",
    service: "checkout-web",
    environment: "production",
    flushInterval: 60_000,
    transport,
    ...overrides
  });

  return { sdk, transport, globals };
}

async function settleAsyncInit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function settleBrowserTriggerActivation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function getEventMessage(event: EventEnvelope): string {
  if (event.event_type === "frontend_exception") {
    return event.payload.message;
  }

  if (event.event_type === "log_event") {
    return event.payload.message;
  }

  throw new Error(`Unsupported event type for message extraction: ${event.event_type}`);
}

function captureRepeatedException(sdk: DebugBundleBrowserSdk, message: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    sdk.captureException(new Error(message));
  }
}

afterEach((): void => {
  if (originalProbeTriggerSecret === undefined) {
    delete process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];
  } else {
    process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = originalProbeTriggerSecret;
  }

  while (activeSdks.length > 0) {
    activeSdks.pop()?.dispose();
  }

  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("sdk-browser", () => {
  it("should expose the core browser sdk surface", (): void => {
    const globals = installBrowserGlobals();
    void globals;

    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);

    expect(typeof sdk.init).toBe("function");
    expect(typeof sdk.captureException).toBe("function");
    expect(typeof sdk.captureError).toBe("function");
    expect(typeof sdk.captureLog).toBe("function");
    expect(typeof sdk.captureRequest).toBe("function");
    expect(typeof sdk.captureMessage).toBe("function");
    expect(typeof sdk.setContext).toBe("function");
    expect(typeof sdk.probe).toBe("function");
    expect(typeof sdk.flush).toBe("function");
    expect(typeof sdk.dispose).toBe("function");
  });

  it("should fetch sdk config exactly once on init without periodic polling", async (): Promise<void> => {
    vi.useFakeTimers();

    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [
          {
            activation_id: "11111111-1111-4111-8111-111111111111",
            label_pattern: "checkout.ui.*",
            service: "*",
            environment: "production",
            expires_at: "2036-03-20T00:00:00.000Z",
            trigger_expires_at: "2036-03-21T00:00:00.000Z"
          }
        ],
        poll_interval_ms: 60000
      })
    });

    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);

    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await settleAsyncInit();

    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
    expect(globals.fetchMock.mock.calls[0]?.[0]).toBe("https://api.debugbundle.com/v1/sdk/config");
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        authorization: "Bearer dbundle_proj_browser"
      }
    });

    await vi.advanceTimersByTimeAsync(180_000);
    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should degrade silently when init config is invalid", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    void globals;

    const transport = vi.fn();
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);

    expect(() =>
      sdk.init({
        projectToken: "",
        service: "checkout-web",
        environment: "production",
        transport
      })
    ).not.toThrow();
    expect(() => sdk.captureException(new Error("boom"))).not.toThrow();
    expect(() => sdk.captureMessage("still-running", "error")).not.toThrow();
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });

  it("should enable relay mode for relative endpoints without auth headers or embedded project tokens", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);

    sdk.init({
      endpoint: "/debugbundle/browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await settleBrowserTriggerActivation();

    expect(globals.fetchMock).not.toHaveBeenCalled();

    sdk.captureException(new Error("relay mode failure"));
    await sdk.flush();

    const transportRequest = (transport.mock.calls as Array<[DebugBundleBrowserTransportRequest]>)[0]?.[0];
    expect(transportRequest?.endpoint).toBe("/debugbundle/browser");
    expect(transportRequest?.headers).toEqual({
      "content-type": "application/json"
    });
    expect(transportRequest?.events).toHaveLength(1);
    expect(transportRequest?.events[0]).not.toHaveProperty("project_token");
  });

  it("should stay disabled when neither endpoint nor project token is configured", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    const transport = vi.fn();
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);

    sdk.init({
      service: "checkout-web",
      environment: "production",
      transport
    });

    sdk.captureException(new Error("disabled sdk"));
    await expect(sdk.flush()).resolves.toBeUndefined();

    expect(transport).not.toHaveBeenCalled();
    expect(globals.fetchMock).not.toHaveBeenCalled();
  });

  it("should keep breadcrumbs local until an exception ships them with privacy masking and device context", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk();

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "pay-now",
        textContent: "Upgrade to Team - $49/mo"
      }
    });
    globals.documentTarget.dispatch("submit", {
      target: {
        tagName: "FORM",
        id: "checkout-form",
        elements: [
          { name: "email", value: "owen@example.com" },
          { name: "credit_card_number", value: "4111111111111111" }
        ]
      }
    });
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout/payment");

    expect(transport).not.toHaveBeenCalled();

    sdk.captureException(new Error("Checkout exploded"), {
      target: {
        tagName: "BUTTON",
        id: "pay-now",
        outerHTML: '<button id="pay-now">Pay Now</button>'
      }
    });

    await sdk.flush();

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.device).toEqual(
      expect.objectContaining({
        device_type: "desktop",
        language: "en-US",
        connection_type: "4g"
      })
    );
    expect(event.payload.dom_context).toEqual({
      mode: "lightweight",
      html_excerpt: '<button id="pay-now">Pay Now</button>'
    });
    const breadcrumbs = event.payload.breadcrumbs ?? [];
    expect(breadcrumbs).toHaveLength(3);
    expect(breadcrumbs[0]).toMatchObject({
      breadcrumb_type: "click",
      data: {
        selector: "button#pay-now"
      }
    });
    expect(breadcrumbs[0]?.data).not.toHaveProperty("text");
    expect(breadcrumbs[1]).toMatchObject({
      breadcrumb_type: "form_submit",
      data: {
        form: "form#checkout-form",
        field_count: 2
      }
    });
    expect(breadcrumbs[1]?.data).not.toHaveProperty("fields");
    expect(breadcrumbs[2]).toMatchObject({
      breadcrumb_type: "route_change",
      route: "/checkout/payment"
    });
  });

  it("captures opaque window error metadata without blaming the SDK fallback", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk();

    globals.windowTarget.dispatch("error", {
      filename: "https://user:secret@app.example/assets/app.js?token=secret#bootstrap",
      lineno: 42,
      colno: 9
    });

    await sdk.flush();

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.message).toBe("Window error");
    expect((event.payload as Record<string, unknown>)["browser_event"]).toEqual({
      kind: "window_error",
      message: null,
      file_name: "https://app.example/assets/app.js",
      line_number: 42,
      column_number: 9,
      target: null,
      opaque: true
    });
  });

  it("captures resource load error targets from the window error hook", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk();

    globals.windowTarget.dispatch("error", {
      target: {
        tagName: "SCRIPT",
        src: "https://cdn.example/app.js?access_token=secret#chunk"
      }
    });

    await sdk.flush();

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.message).toBe("Browser resource load error");
    expect((event.payload as Record<string, unknown>)["browser_event"]).toEqual({
      kind: "resource_error",
      message: null,
      file_name: null,
      line_number: null,
      column_number: null,
      target: {
        tag_name: "script",
        source_url: "https://cdn.example/app.js"
      },
      opaque: true
    });
  });

  it("demotes matching resource load exceptions into breadcrumb context after sdk config loads", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_rules: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            project_id: "proj_123",
            name: "Demote CDN resource noise",
            description: null,
            enabled: true,
            action: "demote",
            matcher: {
              event_types: ["frontend_exception"],
              browser_event_kind: "resource_error",
              resource_url: { host: "cdn.example" }
            },
            sample_rate: null,
            sample_event_class: null,
            created_by_user_id: null,
            created_from_incident_id: null,
            created_from_event_id: null,
            expires_at: null,
            hit_count: 0,
            last_matched_at: null,
            created_at: "2026-05-26T10:00:00.000Z",
            updated_at: "2026-05-26T10:00:00.000Z"
          }
        ]
      })
    });

    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      breadcrumbsOnErrorOnly: false,
      transport
    });

    await settleAsyncInit();
    globals.windowTarget.dispatch("error", {
      target: {
        tagName: "SCRIPT",
        src: "https://cdn.example/app.js?access_token=secret#chunk"
      }
    });

    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    const event = getFrontendBreadcrumbEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.data).toMatchObject({
      source: "capture_rule_demoted_exception",
      browser_event_kind: "resource_error",
      source_url: "https://cdn.example/app.js"
    });
  });

  it("drops sampled-out resource load exceptions after sdk config loads", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_rules: [
          {
            id: "00000000-0000-4000-8000-000000000102",
            project_id: "proj_123",
            name: "Sample out CDN resource noise",
            description: null,
            enabled: true,
            action: "sample",
            matcher: {
              event_types: ["frontend_exception"],
              browser_event_kind: "resource_error",
              resource_url: { host: "cdn.example" }
            },
            sample_rate: 0,
            sample_event_class: "preserve",
            created_by_user_id: null,
            created_from_incident_id: null,
            created_from_event_id: null,
            expires_at: null,
            hit_count: 0,
            last_matched_at: null,
            created_at: "2026-05-26T10:00:00.000Z",
            updated_at: "2026-05-26T10:00:00.000Z"
          }
        ]
      })
    });

    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await settleAsyncInit();
    globals.windowTarget.dispatch("error", {
      target: {
        tagName: "SCRIPT",
        src: "https://cdn.example/app.js?access_token=secret#chunk"
      }
    });

    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();
  });

  it("should honor breadcrumb caps and capture toggles", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk({
      maxBreadcrumbs: 2,
      captureClicks: true,
      captureRouteChanges: false
    });

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "first",
        textContent: "First"
      }
    });
    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "second",
        textContent: "Second"
      }
    });
    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "third",
        textContent: "Third"
      }
    });
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout/review");

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    const breadcrumbs = event.payload.breadcrumbs ?? [];
    expect(breadcrumbs).toHaveLength(2);
    expect(breadcrumbs[0]?.breadcrumb_type).toBe("click");
    expect(breadcrumbs[0]?.data["selector"]).toBe("button#second");
    expect(breadcrumbs[1]?.breadcrumb_type).toBe("click");
    expect(breadcrumbs[1]?.data["selector"]).toBe("button#third");
  });

  it("should ship standalone frontend_breadcrumb events when breadcrumbsOnErrorOnly is false", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk({
      breadcrumbsOnErrorOnly: false
    });

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "apply-coupon",
        textContent: "Apply"
      }
    });
    globals.documentTarget.dispatch("submit", {
      target: {
        tagName: "FORM",
        id: "coupon-form",
        elements: [{ name: "code", value: "SAVE10" }]
      }
    });
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout/review");

    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
      "frontend_breadcrumb",
      "frontend_breadcrumb",
      "frontend_breadcrumb"
    ]);

    const clickEvent = getFrontendBreadcrumbEvent(createTransportEvents(transport, 0)[0]);
    expect(clickEvent.payload).toEqual({
      breadcrumb_type: "click",
      route: "/checkout",
      data: {
        selector: "button#apply-coupon"
      }
    });

    const submitEvent = getFrontendBreadcrumbEvent(createTransportEvents(transport, 0)[1]);
    expect(submitEvent.payload).toEqual({
      breadcrumb_type: "form_submit",
      route: "/checkout",
      data: {
        form: "form#coupon-form",
        field_count: 1
      }
    });

    const routeEvent = getFrontendBreadcrumbEvent(createTransportEvents(transport, 0)[2]);
    expect(routeEvent.payload).toEqual({
      breadcrumb_type: "route_change",
      route: "/checkout/review",
      data: {
        route: "/checkout/review"
      }
    });

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const exceptionEvent = getFrontendExceptionEvent(createTransportEvents(transport, 1)[0]);
    expect(exceptionEvent.payload.breadcrumbs ?? []).toHaveLength(0);
  });

  it("should only capture 4xx and 5xx network breadcrumbs by default", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk();

    await settleAsyncInit();
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

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    const networkBreadcrumbs = (event.payload.breadcrumbs ?? []).filter(
      (breadcrumb) => breadcrumb.breadcrumb_type === "network_request"
    );

    expect(networkBreadcrumbs).toHaveLength(2);
    expect(networkBreadcrumbs.map((breadcrumb) => breadcrumb.data["status_code"])).toEqual([404, 500]);
  });

  it("should attach request metadata to captured network breadcrumbs", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk();

    await settleAsyncInit();
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

    const event = getFrontendExceptionEvent(
      createTransportEvents(transport, 0).find((candidate) => candidate.event_type === "frontend_exception")
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

    const { sdk, transport, globals } = createSdk({
      breadcrumbsOnErrorOnly: false,
      networkFilter: {
        urlPatterns: ["api.example.com"],
        urlDenyPatterns: ["/health"],
        statusCodes: [500, 599],
        minResponseTime: 50
      }
    });

    await settleAsyncInit();
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

    const events = createTransportEvents(transport, 0);
    expect(events.map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    const breadcrumbEvent = getFrontendBreadcrumbEvent(events[0]);
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

    const { sdk, transport, globals } = createSdk({
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
    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_exception"]);

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.breadcrumbs ?? []).toHaveLength(0);
  });

  it("should sample non-exception browser events while still allowing frontend exceptions", async (): Promise<void> => {
    vi.spyOn(Math, "random").mockReturnValue(0.95);

    const { sdk, transport } = createSdk({
      sampleRate: 0.5
    });

    sdk.captureMessage("sampled-out warning", "warning");
    sdk.captureException(new Error("Still capture the exception"));
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_exception"]);
  });

  it("should discard log events below the configured logLevel threshold", async (): Promise<void> => {
    const { sdk, transport } = createSdk({
      logLevel: "error"
    });

    sdk.captureLog("debug noise", "debug", { token: "debug-secret" });
    sdk.captureLog("warning noise", "warning");
    sdk.captureLog("real error", "error", { token: "error-secret" });
    sdk.captureLog("critical issue", "critical");
    await sdk.flush();

    const events = createTransportEvents(transport, 0);
    expect(events).toHaveLength(2);
    expect(getEventMessage(events[0]!)).toBe("real error");
    expect(getEventMessage(events[1]!)).toBe("critical issue");

    if (events[0]?.event_type === "log_event") {
      expect(events[0].payload.attributes).toEqual({
        token: "[REDACTED]"
      });
    }
  });

  it("should send the first three identical frontend exceptions and aggregate later duplicates", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const { sdk, transport } = createSdk();

    captureRepeatedException(sdk, "duplicate checkout failure", 5);
    await sdk.flush();

    const events = createTransportEvents(transport, 0);
    expect(events.map((event) => event.event_type)).toEqual([
      "frontend_exception",
      "frontend_exception",
      "frontend_exception",
      "error_suppressed"
    ]);

    const suppressed = getErrorSuppressedEvent(events[3]);
    expect(suppressed.payload.suppressed_count).toBe(2);
    expect(suppressed.payload.window_seconds).toBe(30);
    expect(suppressed.payload.first_seen).toBe("2026-03-14T00:00:00.000Z");
    expect(suppressed.payload.last_seen).toBe("2026-03-14T00:00:00.000Z");
    expect(suppressed.payload.fingerprint.length).toBeGreaterThan(0);
  });

  it("should keep identical frontend exceptions suppressed until silence resets loop protection", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const { sdk, transport } = createSdk();

    captureRepeatedException(sdk, "recursive failure", 11);
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
      "frontend_exception",
      "frontend_exception",
      "frontend_exception",
      "error_suppressed"
    ]);

    transport.mockClear();

    vi.setSystemTime(new Date("2026-03-14T00:00:30.000Z"));
    captureRepeatedException(sdk, "recursive failure", 2);
    await sdk.flush();

    const checkpointEvents = createTransportEvents(transport, 0);
    expect(checkpointEvents).toHaveLength(1);
    expect(checkpointEvents[0]?.event_type).toBe("error_suppressed");
    expect(getErrorSuppressedEvent(checkpointEvents[0]).payload.suppressed_count).toBe(2);

    transport.mockClear();

    vi.setSystemTime(new Date("2026-03-14T00:01:31.000Z"));
    sdk.captureException(new Error("recursive failure"));
    await sdk.flush();

    const recoveredEvents = createTransportEvents(transport, 0);
    expect(recoveredEvents).toHaveLength(1);
    expect(recoveredEvents[0]?.event_type).toBe("frontend_exception");
    expect(getEventMessage(recoveredEvents[0]!)).toBe("recursive failure");
  });

  it("should stop non-exception capture after max events per session is reached", async (): Promise<void> => {
    const { sdk, transport, globals } = createSdk({
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
    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
      "log_event",
      "frontend_exception"
    ]);

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[1]);
    expect(event.payload.breadcrumbs ?? []).toHaveLength(0);
  });

  it("should auto-flush when the batch size is reached", async (): Promise<void> => {
    const { sdk, transport } = createSdk({
      batchSize: 2
    });

    sdk.captureMessage("first browser log", "warning");
    sdk.captureMessage("second browser log", "error");

    await settleAsyncInit();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event", "log_event"]);
  });

  it("should use sendBeacon when the page is unloading", (): void => {
    const { sdk, globals } = createSdk();

    sdk.captureMessage("flush me on unload", "error");

    globals.windowTarget.dispatch("pagehide", {});

    expect(globals.sendBeacon).toHaveBeenCalledTimes(1);
    expect(globals.sendBeacon.mock.calls[0]?.[0]).toBe("https://api.debugbundle.com/v1/events");
  });

  it("should fall back to fetch keepalive when sendBeacon declines the unload flush", async (): Promise<void> => {
    const { sdk, globals } = createSdk();

    await settleAsyncInit();
    globals.fetchMock.mockClear();
    globals.sendBeacon.mockReturnValue(false);

    sdk.captureMessage("flush me with keepalive", "error");
    globals.windowTarget.dispatch("pagehide", {});

    await settleAsyncInit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(globals.sendBeacon).toHaveBeenCalledTimes(1);
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

  it("should inject trace headers into allowlisted cross-origin fetch requests", async (): Promise<void> => {
    const { globals } = createSdk({
      captureNetwork: false,
      tracePropagationTargets: ["https://api.example.com"]
    } as Parameters<DebugBundleBrowserSdk["init"]>[0]);

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
        "X-DebugBundle-Trace-Id": "00000000-0000-4000-8000-000000000001"
      }
    });
  });

  it("should not inject trace headers into third-party fetch requests by default", async (): Promise<void> => {
    const { globals } = createSdk({
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
    const { sdk, transport, globals } = createSdk({
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
        "X-DebugBundle-Trace-Id": "00000000-0000-4000-8000-000000000001"
      },
      body: '{"checkout":true}'
    });

    const events = createTransportEvents(transport, 0);
    expect(events.map((event) => event.event_type)).toEqual(["frontend_breadcrumb", "request_event"]);
    const breadcrumbEvent = getFrontendBreadcrumbEvent(events[0]);
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

    const requestEvent = events[1] as RequestEvent | undefined;
    expect(requestEvent?.event_type).toBe("request_event");
    expect(requestEvent?.payload).toMatchObject({
      method: "POST",
      path: "/xhr-checkout",
      response_status: 503
    });
  });

  it("should read probe_directives from ingestion responses without extra polling", async (): Promise<void> => {
    const globals = installBrowserGlobals();
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

    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
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
    const globals = installBrowserGlobals();
    void globals;

    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
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
    expect(createTransportEvents(transport, 1).map((event) => event.event_type)).toEqual(["log_event"]);
  });

  it("should retain buffered events and back off after a 429 response", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-16T00:00:00.000Z"));

    const globals = installBrowserGlobals();
    void globals;

    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, retry_after_ms: 5_000 })
      .mockResolvedValueOnce({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
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
    expect(createTransportEvents(transport, 1).map((event) => event.event_type)).toEqual(["log_event"]);
  });

  it("should stop retrying after an unauthorized ingestion response", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    void globals;
    const consoleSource = { error: vi.fn(), warn: vi.fn() };
    vi.stubGlobal("console", consoleSource as unknown);

    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 401, body: { error: "invalid_project_token" } })
      .mockResolvedValueOnce({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
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

  it("should buffer probes locally and flush them inline with frontend exceptions", async (): Promise<void> => {
    const { sdk, transport } = createSdk();

    sdk.probe("checkout.pricing.tax", {
      total: 42,
      authorization: "Bearer secret-token"
    });
    sdk.probe("checkout.inventory", {
      sku: "sku_123",
      stock: 4
    });

    expect(transport).not.toHaveBeenCalled();

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.pricing.tax",
          activation_id: null,
          data: {
            total: 42,
            authorization: "[REDACTED]"
          }
        }),
        expect.objectContaining({
          label: "checkout.inventory",
          activation_id: null,
          data: {
            sku: "sku_123",
            stock: 4
          }
        })
      ]
    });

    sdk.captureException(new Error("Exploded again"));
    await sdk.flush();

    const secondEvent = getFrontendExceptionEvent(createTransportEvents(transport, 1)[0]);
    expect(secondEvent.payload.probe_data).toEqual({
      version: 1,
      items: []
    });
  });

  it("should enforce bounded probe label and entry buffers", async (): Promise<void> => {
    const { sdk, transport } = createSdk({
      maxProbeLabels: 1,
      maxProbeEntriesPerLabel: 2
    });

    sdk.probe("checkout.pricing.tax", { total: 40 });
    sdk.probe("checkout.pricing.tax", { total: 41 });
    sdk.probe("checkout.pricing.tax", { total: 42 });
    sdk.probe("checkout.inventory", { sku: "sku_123" });

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const event = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.pricing.tax",
          data: { total: 41 }
        }),
        expect.objectContaining({
          label: "checkout.pricing.tax",
          data: { total: 42 }
        })
      ]
    });
  });

  it("should emit remote probe_event entries when directives match and still keep local buffers", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [
          {
            activation_id: "11111111-1111-4111-8111-111111111111",
            label_pattern: "checkout.ui.*",
            service: "*",
            environment: "production",
            expires_at: "2036-03-20T00:00:00.000Z",
            trigger_expires_at: "2036-03-21T00:00:00.000Z"
          }
        ],
        poll_interval_ms: 60000
      })
    });

    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await settleAsyncInit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    sdk.probe("checkout.ui.cart-render", {
      renderTime: 42,
      token: "secret"
    });
    await sdk.flush();

    const probeEvent = getProbeEvent(createTransportEvents(transport, 0)[0]);
    expect(probeEvent.payload).toEqual({
      label: "checkout.ui.cart-render",
      data: {
        renderTime: 42,
        token: "[REDACTED]"
      },
      activation_id: "11111111-1111-4111-8111-111111111111",
      probe_label_pattern: "checkout.ui.*"
    });

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const exceptionEvent = getFrontendExceptionEvent(createTransportEvents(transport, 1)[0]);
    expect(exceptionEvent.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.ui.cart-render",
          activation_id: null,
          data: {
            renderTime: 42,
            token: "[REDACTED]"
          }
        })
      ]
    });
  });

  it("should activate matching probes from _debug_probe for the current page load and strip the URL", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    const projectId = "proj_123";
    const triggerTokenKey = deriveProbeTriggerTokenKey(projectId);
    const triggerToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        trigger_expires_at: "2036-03-20T00:00:00.000Z"
      }
    }).plaintext;
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [],
        poll_interval_ms: 60000,
        trigger_token_key: triggerTokenKey
      })
    });
    vi.stubGlobal(
      "location",
      {
        href: `https://example.com/checkout?_debug_probe=${triggerToken}`,
        pathname: "/checkout",
        search: `?_debug_probe=${triggerToken}`
      } as unknown
    );

    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await settleBrowserTriggerActivation();

    sdk.probe("checkout.ui.tax", { total: 42 });
    await sdk.flush();

    expect(
      createTransportEvents(transport, 0).find(
        (event) => event.event_type === "probe_event" && event.payload.probe_label_pattern === "checkout.*"
      )
    ).toBeDefined();
    expect(globals.historyCalls).toContain("replace:/checkout");
  });

  it("should keep remote probe events sampled out with the session while allowing exception flushes", async (): Promise<void> => {
    vi.spyOn(Math, "random").mockReturnValue(0.95);

    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [
          {
            activation_id: "11111111-1111-4111-8111-111111111111",
            label_pattern: "checkout.ui.*",
            service: "*",
            environment: "production",
            expires_at: "2036-03-20T00:00:00.000Z",
            trigger_expires_at: "2036-03-21T00:00:00.000Z"
          }
        ],
        poll_interval_ms: 60000
      })
    });

    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport,
      sessionSampleRate: 0.5
    });

    await Promise.resolve();
    await Promise.resolve();

    sdk.probe("checkout.ui.cart-render", { renderTime: 42 });
    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_exception"]);

    const exceptionEvent = getFrontendExceptionEvent(createTransportEvents(transport, 0)[0]);
    expect(exceptionEvent.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.ui.cart-render",
          activation_id: null,
          data: { renderTime: 42 }
        })
      ]
    });
  });

  it("should let remote probe events bypass the max events per session cap", async (): Promise<void> => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [
          {
            activation_id: "11111111-1111-4111-8111-111111111111",
            label_pattern: "checkout.ui.*",
            service: "*",
            environment: "production",
            expires_at: "2036-03-20T00:00:00.000Z",
            trigger_expires_at: "2036-03-21T00:00:00.000Z"
          }
        ],
        poll_interval_ms: 60000
      })
    });

    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport,
      maxEventsPerSession: 1
    });

    await Promise.resolve();
    await Promise.resolve();

    sdk.captureMessage("first browser log", "warning");
    sdk.probe("checkout.ui.cart-render", { renderTime: 42 });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event", "probe_event"]);
  });

  it("should prune expired remote directives before later probe matches", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));

    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [
          {
            activation_id: "11111111-1111-4111-8111-111111111111",
            label_pattern: "checkout.ui.*",
            service: "*",
            environment: "production",
            expires_at: "2026-03-15T00:00:01.000Z",
            trigger_expires_at: "2026-03-15T00:00:01.000Z"
          }
        ],
        poll_interval_ms: 60000
      })
    });

    const transport = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        accepted: 1,
        rejected: 0,
        errors: []
      }
    });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(2_000);

    sdk.captureMessage("force remote state maintenance", "warning");
    await sdk.flush();
    sdk.probe("checkout.ui.cart-render", { renderTime: 42 });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event"]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
