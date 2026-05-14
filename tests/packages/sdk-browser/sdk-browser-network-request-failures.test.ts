import { webcrypto } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDebugBundleBrowserSdk,
  type DebugBundleBrowserSdk,
  type DebugBundleBrowserTransportRequest
} from "../../../packages/sdk-browser/src/index.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

type TransportMock = ReturnType<typeof vi.fn>;
type FrontendBreadcrumbEvent = Extract<EventEnvelope, { event_type: "frontend_breadcrumb" }>;
type RequestEvent = Extract<EventEnvelope, { event_type: "request_event" }>;

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  public addEventListener(eventName: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(eventName) ?? new Set<(event: unknown) => void>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  public removeEventListener(eventName: string, listener: (event: unknown) => void): void {
    this.listeners.get(eventName)?.delete(listener);
  }
}

const activeSdks: DebugBundleBrowserSdk[] = [];

function createTransportEvents(transport: TransportMock, callIndex: number): EventEnvelope[] {
  const calls = transport.mock.calls as Array<[DebugBundleBrowserTransportRequest]>;
  return calls[callIndex]?.[0].events ?? [];
}

function getRequestEvent(event: EventEnvelope | undefined): RequestEvent {
  if (event === undefined || event.event_type !== "request_event") {
    throw new Error("Expected a request_event event");
  }

  return event;
}

function getFrontendBreadcrumbEvent(event: EventEnvelope | undefined): FrontendBreadcrumbEvent {
  if (event === undefined || event.event_type !== "frontend_breadcrumb") {
    throw new Error("Expected a frontend_breadcrumb event");
  }

  return event;
}

async function settleAsyncInit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function installBrowserGlobals(): { fetchMock: ReturnType<typeof vi.fn> } {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
  const windowTarget = new FakeEventTarget();
  const documentTarget = Object.assign(new FakeEventTarget(), { visibilityState: "visible" });
  let traceCounter = 0;

  vi.stubGlobal("window", windowTarget as unknown);
  vi.stubGlobal("document", documentTarget as unknown);
  vi.stubGlobal("history", { pushState: vi.fn(), replaceState: vi.fn() } as unknown);
  vi.stubGlobal("location", { href: "https://example.com/checkout", pathname: "/checkout", search: "" } as unknown);
  vi.stubGlobal("navigator", { userAgent: "vitest", language: "en-US", sendBeacon: vi.fn() } as unknown);
  vi.stubGlobal("screen", { width: 1440, height: 900 } as unknown);
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }) as unknown);
  vi.stubGlobal("fetch", fetchMock as unknown);
  vi.stubGlobal("XMLHttpRequest", null as unknown);
  vi.stubGlobal(
    "crypto",
    {
      subtle: webcrypto.subtle,
      randomUUID: vi.fn().mockImplementation(() => {
        traceCounter += 1;
        return `00000000-0000-4000-8000-${String(traceCounter).padStart(12, "0")}`;
      })
    } as unknown
  );

  return { fetchMock };
}

function createSdk(
  overrides: Parameters<DebugBundleBrowserSdk["init"]>[0] = {},
  options: { sdkConfigPayload?: Record<string, unknown> } = {}
): { sdk: DebugBundleBrowserSdk; transport: TransportMock; fetchMock: ReturnType<typeof vi.fn> } {
  const { fetchMock } = installBrowserGlobals();
  if (options.sdkConfigPayload !== undefined) {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => options.sdkConfigPayload
    });
  }
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

  return { sdk, transport, fetchMock };
}

afterEach(() => {
  for (const sdk of activeSdks.splice(0)) {
    sdk.dispose();
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("browser SDK network request failures", () => {
  it("should promote same-origin 5xx network responses to request events", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk();

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("/v1/billing/checkout?plan=team", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["request_event"]);
    const event = getRequestEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload).toMatchObject({
      method: "POST",
      path: "/v1/billing/checkout",
      query: { plan: "team" },
      response_status: 503
    });
  });

  it("should promote balanced 429 network responses to request events after sdk config is loaded", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk({}, {
      sdkConfigPayload: {
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: { preset: "balanced" }
      }
    });

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("/v1/billing/checkout?plan=team", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["request_event"]);
    expect(getRequestEvent(createTransportEvents(transport, 0)[0]).payload.response_status).toBe(429);
  });

  it("should promote balanced anomaly-eligible network responses to request events", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk({}, {
      sdkConfigPayload: {
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: { preset: "balanced", capture_request_events: "failures_only" }
      }
    });

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("/v1/billing/checkout?plan=team", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["request_event"]);
    expect(getRequestEvent(createTransportEvents(transport, 0)[0]).payload.response_status).toBe(404);
  });

  it("should keep balanced anomaly-eligible responses as breadcrumb-only context when request capture is off", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk({ breadcrumbsOnErrorOnly: false }, {
      sdkConfigPayload: {
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: { preset: "balanced", capture_request_events: "off" }
      }
    });

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 404 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("/v1/billing/checkout?plan=team", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    expect(getFrontendBreadcrumbEvent(createTransportEvents(transport, 0)[0]).payload.data["status_code"]).toBe(404);
  });

  it("should promote investigative 409 network responses to request events after sdk config is loaded", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk({}, {
      sdkConfigPayload: {
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: { preset: "investigative" }
      }
    });

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 409 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("/v1/billing/checkout?plan=team", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["request_event"]);
    expect(getRequestEvent(createTransportEvents(transport, 0)[0]).payload.response_status).toBe(409);
  });

  it("should promote configured client error statuses to request events after sdk config is loaded", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk({}, {
      sdkConfigPayload: {
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: {
          preset: "minimal",
          capture_request_events: "off",
          immediate_client_error_statuses: [403]
        }
      }
    });

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("/v1/billing/checkout?plan=team", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["request_event"]);
    expect(getRequestEvent(createTransportEvents(transport, 0)[0]).payload.response_status).toBe(403);
  });

  it("should leave third-party 5xx network responses as breadcrumb-only context", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk({ breadcrumbsOnErrorOnly: false });

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 503 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("https://third-party.example/checkout", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    const event = getFrontendBreadcrumbEvent(createTransportEvents(transport, 0)[0]);
    expect(event.payload.data).toMatchObject({
      url: "https://third-party.example/checkout",
      method: "POST",
      status_code: 503
    });
  });

  it("should keep minimal 429 network responses as breadcrumb-only context", async (): Promise<void> => {
    const { sdk, transport, fetchMock } = createSdk({ breadcrumbsOnErrorOnly: false }, {
      sdkConfigPayload: {
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: { preset: "minimal" }
      }
    });

    await settleAsyncInit();
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });

    const browserFetch = globalThis.fetch as unknown as (input: string, init?: { method?: string }) => Promise<{ status: number }>;
    await browserFetch("/v1/billing/checkout?plan=team", { method: "POST" });
    await sdk.flush();

    expect(createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    expect(getFrontendBreadcrumbEvent(createTransportEvents(transport, 0)[0]).payload.data["status_code"]).toBe(429);
  });
});
