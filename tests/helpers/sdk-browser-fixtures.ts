import { webcrypto } from "node:crypto";

import { afterEach, beforeEach, vi } from "vitest";

import { deriveProbeTriggerTokenKey, generateProbeTriggerToken } from "./probe-trigger-token.js";
import {
  createDebugBundleBrowserSdk,
  type DebugBundleBrowserTransportEvent,
  type DebugBundleBrowserSdk,
  type DebugBundleBrowserTransportRequest
} from "../../packages/sdk-browser/src/index.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

export type TransportMock = ReturnType<typeof vi.fn>;
export type ErrorSuppressedEvent = Extract<EventEnvelope, { event_type: "error_suppressed" }>;
export type FrontendExceptionEvent = Extract<EventEnvelope, { event_type: "frontend_exception" }>;
export type FrontendBreadcrumbEvent = Extract<EventEnvelope, { event_type: "frontend_breadcrumb" }>;
export type RequestEvent = Extract<EventEnvelope, { event_type: "request_event" }>;
export type ProbeEvent = Extract<EventEnvelope, { event_type: "probe_event" }>;
export type AnalyticsEvent = Extract<DebugBundleBrowserTransportEvent, { event_type: "analytics_event" }>;
export const originalProbeTriggerSecret = process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];

export class FakeEventTarget {
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

export interface InstalledBrowserGlobals {
  windowTarget: FakeEventTarget;
  documentTarget: FakeEventTarget & {
    visibilityState: "visible" | "hidden";
    readyState: "loading" | "interactive" | "complete";
    referrer: string;
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
  localStorage: {
    entries(): Array<[string, string]>;
    getItem(key: string): string | null;
    removeItem(key: string): void;
    setItem(key: string, value: string): void;
  };
}

export const activeSdks: DebugBundleBrowserSdk[] = [];

export function createRawTransportEvents(transport: TransportMock, callIndex: number): DebugBundleBrowserTransportEvent[] {
  const calls = transport.mock.calls as Array<[DebugBundleBrowserTransportRequest]>;
  return calls[callIndex]?.[0].events ?? [];
}

export function createTransportEvents(transport: TransportMock, callIndex: number): EventEnvelope[] {
  return createRawTransportEvents(transport, callIndex).filter((event): event is EventEnvelope => event.event_type !== "analytics_event");
}

export function getAnalyticsEvents(transport: TransportMock, callIndex = 0): AnalyticsEvent[] {
  return createRawTransportEvents(transport, callIndex).filter((event): event is AnalyticsEvent => event.event_type === "analytics_event");
}

export function getFrontendExceptionEvent(event: EventEnvelope | undefined): FrontendExceptionEvent {
  if (event === undefined || event.event_type !== "frontend_exception") {
    throw new Error("Expected a frontend_exception event");
  }

  return event;
}

export function getFrontendBreadcrumbEvent(event: EventEnvelope | undefined): FrontendBreadcrumbEvent {
  if (event === undefined || event.event_type !== "frontend_breadcrumb") {
    throw new Error("Expected a frontend_breadcrumb event");
  }

  return event;
}

export function getErrorSuppressedEvent(event: EventEnvelope | undefined): ErrorSuppressedEvent {
  if (event === undefined || event.event_type !== "error_suppressed") {
    throw new Error("Expected an error_suppressed event");
  }

  return event;
}

export function getProbeEvent(event: EventEnvelope | undefined): ProbeEvent {
  if (event === undefined || event.event_type !== "probe_event") {
    throw new Error("Expected a probe_event");
  }

  return event;
}

export function installBrowserGlobals(): InstalledBrowserGlobals {
  const windowTarget = new FakeEventTarget();
  const documentBase = new FakeEventTarget() as FakeEventTarget & {
    visibilityState: "visible" | "hidden";
    readyState: "loading" | "interactive" | "complete";
    referrer: string;
    activeElement: unknown;
  };
  documentBase.visibilityState = "visible";
  documentBase.readyState = "interactive";
  documentBase.referrer = "https://example.com/start?token=secret#section";
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
  const localStorageValues = new Map<string, string>();
  const localStorage = {
    entries: (): Array<[string, string]> => Array.from(localStorageValues.entries()),
    getItem: (key: string): string | null => localStorageValues.get(key) ?? null,
    removeItem: (key: string): void => {
      localStorageValues.delete(key);
    },
    setItem: (key: string, value: string): void => {
      localStorageValues.set(key, value);
    }
  };
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
  vi.stubGlobal("location", { href: "https://example.com/checkout?token=secret#payment", pathname: "/checkout", search: "?token=secret" } as unknown);
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
  vi.stubGlobal("localStorage", localStorage as unknown);
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
    xhrResponses,
    localStorage
  };
}

export function createSdk(
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

export async function settleAsyncInit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

export async function settleBrowserTriggerActivation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

export function getEventMessage(event: EventEnvelope): string {
  if (event.event_type === "frontend_exception") {
    return event.payload.message;
  }

  if (event.event_type === "log_event") {
    return event.payload.message;
  }

  throw new Error(`Unsupported event type for message extraction: ${event.event_type}`);
}

export function captureRepeatedException(sdk: DebugBundleBrowserSdk, message: string, count: number): void {
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


export { createDebugBundleBrowserSdk, deriveProbeTriggerTokenKey, generateProbeTriggerToken };
export type {
  DebugBundleBrowserTransportEvent,
  DebugBundleBrowserSdk,
  DebugBundleBrowserTransportRequest,
  EventEnvelope
};
