import { webcrypto } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { collectDeviceInfo, installConsoleHook, installNetworkHook } from "../../../packages/sdk-browser/src/hooks.js";
import type { ActiveConfig, BrowserBreadcrumb } from "../../../packages/sdk-browser/src/types.js";

class FakeEventTarget {
  private listeners = new Map<string, Set<() => void>>();

  public addEventListener(eventName: string, listener: () => void): void {
    const listeners = this.listeners.get(eventName) ?? new Set<() => void>();
    listeners.add(listener);
    this.listeners.set(eventName, listeners);
  }

  public removeEventListener(eventName: string, listener: () => void): void {
    this.listeners.get(eventName)?.delete(listener);
  }

  public dispatch(eventName: string): void {
    for (const listener of this.listeners.get(eventName) ?? []) {
      listener();
    }
  }
}

function createFetchResponse(status: number, body?: string, headers?: Record<string, string>): Response {
  const responseHeaders = new Headers(headers);
  return new Response(body ?? null, { status, headers: responseHeaders });
}

function getWrappedXmlHttpRequestConstructor(): new () => {
  open(method: string, url: string, async?: boolean): void;
  send(): void;
} {
  const ctor = (globalThis as Record<string, unknown>)["XMLHttpRequest"];
  if (typeof ctor !== "function") {
    throw new Error("Wrapped XMLHttpRequest is unavailable");
  }

  return ctor as new () => {
    open(method: string, url: string, async?: boolean): void;
    send(): void;
  };
}

function getConsoleHookResult(value: unknown): {
  originalConsoleError: ((...args: unknown[]) => void) | null;
  originalConsoleWarn: ((...args: unknown[]) => void) | null;
} {
  return value as {
    originalConsoleError: ((...args: unknown[]) => void) | null;
    originalConsoleWarn: ((...args: unknown[]) => void) | null;
  };
}

function getNetworkHookResult(value: unknown): {
  originalFetch: unknown;
  originalXmlHttpRequest: unknown;
} {
  return value as {
    originalFetch: unknown;
    originalXmlHttpRequest: unknown;
  };
}

function createConfig(overrides: Partial<ActiveConfig> = {}): ActiveConfig {
  return {
    projectToken: "dbundle_proj_browser",
    environment: "production",
    service: "checkout-web",
    enabled: true,
    redactFields: ["token"],
    tracePropagationTargets: [],
    sampleRate: 1,
    batchSize: 50,
    flushInterval: 60_000,
    endpoint: "https://api.debugbundle.com/v1/events",
    logLevel: "warning",
    maxBreadcrumbs: 50,
    breadcrumbsOnErrorOnly: true,
    captureNetwork: true,
    captureClicks: true,
    captureRouteChanges: true,
    captureConsole: true,
    networkFilter: {
      urlPatterns: [],
      urlDenyPatterns: [],
      statusCodes: [400, 599],
      minResponseTime: null
    },
    sessionSampleRate: 1,
    maxEventsPerSession: 100,
    maxProbeLabels: 50,
    maxProbeEntriesPerLabel: 10,
    probeFlushOnError: true,
    requestTimeoutMs: 5_000,
    fetchImpl: vi.fn() as typeof fetch,
    transport: vi.fn(),
    transportMode: "direct",
    ...overrides
  };
}

afterEach((): void => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sdk-browser hooks direct", () => {
  it("should no-op console hook installation when disabled or unavailable", (): void => {
    vi.stubGlobal("console", null as unknown);

    expect(installConsoleHook(null, vi.fn())).toEqual({
      originalConsoleError: null,
      originalConsoleWarn: null
    });
    expect(
      installConsoleHook(
        createConfig({
          captureConsole: false
        }),
        vi.fn()
      )
    ).toEqual({
      originalConsoleError: null,
      originalConsoleWarn: null
    });
  });

  it("should wrap console error and warn methods into breadcrumbs", (): void => {
    const consoleSource = {
      error: vi.fn(),
      warn: vi.fn()
    };
    const breadcrumbs: BrowserBreadcrumb[] = [];
    vi.stubGlobal("console", consoleSource as unknown);

    const result = getConsoleHookResult(installConsoleHook(createConfig(), (breadcrumb) => {
      breadcrumbs.push(breadcrumb);
    }));

    consoleSource.error("boom", { id: 1 });
    consoleSource.warn("careful");

    expect(result.originalConsoleError).toEqual(expect.any(Function));
    expect(result.originalConsoleWarn).toEqual(expect.any(Function));
    expect(breadcrumbs).toHaveLength(2);
    expect(breadcrumbs[0]?.breadcrumb_type).toBe("console_log");
    expect(breadcrumbs[0]?.data["level"]).toBe("error");
    expect(breadcrumbs[0]?.data["message"]).toContain("boom");
    expect(breadcrumbs[1]?.breadcrumb_type).toBe("console_log");
    expect(breadcrumbs[1]?.data["level"]).toBe("warning");
    expect(breadcrumbs[1]?.data["message"]).toBe("careful");
  });

  it("should wrap fetch requests, inject trace headers, and skip sdk endpoints", async (): Promise<void> => {
    vi.stubGlobal("location", { href: "https://example.com/checkout", pathname: "/checkout", search: "" } as unknown);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("trace-id") } as unknown);
    vi.stubGlobal("XMLHttpRequest", null as unknown);

    const fetchSource = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(createFetchResponse(503, '{"error":"service_unavailable"}', { "content-type": "application/json", "x-request-id": "req-abc" }))
      .mockResolvedValueOnce(createFetchResponse(202))
      .mockResolvedValueOnce(createFetchResponse(202))
      .mockResolvedValueOnce(createFetchResponse(200));
    vi.stubGlobal("fetch", fetchSource as unknown);

    const breadcrumbs: BrowserBreadcrumb[] = [];
    const requestFailures: BrowserBreadcrumb[] = [];
    const result = getNetworkHookResult(installNetworkHook(
      createConfig(),
      (breadcrumb) => {
        breadcrumbs.push(breadcrumb);
      },
      (breadcrumb) => {
        requestFailures.push(breadcrumb);
      },
      (url, statusCode) => url.includes("checkout") && statusCode >= 500,
      () => "/checkout"
    ));

    await globalThis.fetch("https://example.com/checkout/api", {
      method: "POST",
      headers: {
        authorization: "Bearer existing"
      }
    });
    await globalThis.fetch("https://third-party.example/widget.js", {
      method: "GET"
    });
    await globalThis.fetch("https://api.debugbundle.com/v1/events");
    await globalThis.fetch("https://api.debugbundle.com/v1/sdk/config");

    expect(result.originalFetch).toBe(fetchSource);
    expect(fetchSource).toHaveBeenNthCalledWith(
      1,
      "https://example.com/checkout/api",
      expect.objectContaining({
        method: "POST",
        headers: {
          authorization: "Bearer existing",
          "X-DebugBundle-Trace-Id": "trace-id"
        }
      })
    );
    expect(fetchSource).toHaveBeenNthCalledWith(
      2,
      "https://third-party.example/widget.js",
      expect.objectContaining({
        method: "GET",
        headers: {}
      })
    );
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]?.breadcrumb_type).toBe("network_request");
    expect(breadcrumbs[0]?.route).toBe("/checkout");
    expect(breadcrumbs[0]?.data["url"]).toBe("https://example.com/checkout/api");
    expect(breadcrumbs[0]?.data["method"]).toBe("POST");
    expect(breadcrumbs[0]?.data["status_code"]).toBe(503);
    expect(breadcrumbs[0]?.data["caller_trace"]).toEqual(expect.any(Array));
    expect((breadcrumbs[0]?.data["caller_trace"] as string[]).length).toBeGreaterThan(0);

    // Enriched: response body captured on non-2xx
    expect(breadcrumbs[0]?.data["response_body"]).toEqual({ error: "service_unavailable" });
    // Enriched: response headers captured
    expect(breadcrumbs[0]?.data["response_headers"]).toMatchObject({
      "content-type": "application/json",
      "x-request-id": "req-abc"
    });
    expect(requestFailures).toHaveLength(1);
    expect(requestFailures[0]?.data["url"]).toBe("https://example.com/checkout/api");
    expect(requestFailures[0]?.data["status_code"]).toBe(503);
  });

  it("should inject trace headers into allowlisted cross-origin fetch requests", async (): Promise<void> => {
    vi.stubGlobal("location", { href: "https://example.com/checkout", pathname: "/checkout", search: "" } as unknown);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("trace-id") } as unknown);
    vi.stubGlobal("XMLHttpRequest", null as unknown);

    const fetchSource = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(createFetchResponse(202));
    vi.stubGlobal("fetch", fetchSource as unknown);

    installNetworkHook(
      {
        ...createConfig(),
        tracePropagationTargets: ["https://api.example.com"]
      } as ActiveConfig,
      vi.fn(),
      vi.fn(),
      () => false,
      () => "/checkout"
    );

    await globalThis.fetch("https://api.example.com/checkout/trace", {
      method: "POST"
    });

    expect(fetchSource).toHaveBeenCalledWith(
      "https://api.example.com/checkout/trace",
      expect.objectContaining({
        method: "POST",
        headers: {
          "X-DebugBundle-Trace-Id": "trace-id"
        }
      })
    );
  });

  it("should preserve request metadata on fetch breadcrumbs without forwarding it to fetch", async (): Promise<void> => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("trace-id") } as unknown);
    vi.stubGlobal("XMLHttpRequest", null as unknown);

    const fetchSource = vi
      .fn<(input: string, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(createFetchResponse(401, '{"message":"unauthorized"}', {
        "content-type": "application/json",
        "www-authenticate": "Bearer"
      }));
    vi.stubGlobal("fetch", fetchSource as unknown);

    const breadcrumbs: BrowserBreadcrumb[] = [];
    installNetworkHook(
      createConfig(),
      (breadcrumb) => {
        breadcrumbs.push(breadcrumb);
      },
      vi.fn(),
      () => true,
      () => "/login"
    );

    await globalThis.fetch("/v1/auth/session", {
      credentials: "include",
      debugbundle: {
        operation: "auth.session.get",
        initiator: "session.bootstrap",
        feature: "auth"
      }
    } as RequestInit);

    const forwardedInit = fetchSource.mock.calls[0]?.[1] as Record<string, unknown> | undefined;
    expect(forwardedInit).not.toHaveProperty("debugbundle");
    expect(breadcrumbs[0]?.data).toMatchObject({
      url: "/v1/auth/session",
      method: "GET",
      status_code: 401,
      operation: "auth.session.get",
      initiator: "session.bootstrap",
      feature: "auth",
      response_body: { message: "unauthorized" },
      response_headers: {
        "content-type": "application/json",
        "www-authenticate": "Bearer"
      }
    });
    expect(breadcrumbs[0]?.data["caller_trace"]).toEqual(expect.any(Array));
  });

  it("should wrap XMLHttpRequest and honor network capture filters", (): void => {
    vi.stubGlobal("location", { href: "https://example.com/orders", pathname: "/orders", search: "" } as unknown);
    vi.stubGlobal("fetch", null as unknown);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("trace-id") } as unknown);

    const requests: Array<{ headers: Record<string, string> }> = [];
    const statuses = [500, 204];

    class FakeXmlHttpRequest extends FakeEventTarget {
      public status = 0;
      private headers: Record<string, string> = {};

      public open(): void {}

      public setRequestHeader(name: string, value: string): void {
        this.headers[name] = value;
      }

      public send(): void {
        this.status = statuses.shift() ?? 0;
        requests.push({ headers: { ...this.headers } });
        this.dispatch("loadend");
      }
    }

    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest as unknown);

    const breadcrumbs: BrowserBreadcrumb[] = [];
    const requestFailures: BrowserBreadcrumb[] = [];
    const result = getNetworkHookResult(installNetworkHook(
      createConfig(),
      (breadcrumb) => {
        breadcrumbs.push(breadcrumb);
      },
      (breadcrumb) => {
        requestFailures.push(breadcrumb);
      },
      (_url, statusCode) => statusCode >= 500,
      () => "/orders"
    ));

    const WrappedXmlHttpRequest = getWrappedXmlHttpRequestConstructor();

    const capturedRequest = new WrappedXmlHttpRequest();
    capturedRequest.open("PATCH", "https://example.com/orders/123", true);
    capturedRequest.send();

    const ignoredRequest = new WrappedXmlHttpRequest();
    ignoredRequest.open("GET", "https://third-party.example/health", true);
    ignoredRequest.send();

    expect(result.originalXmlHttpRequest).toBe(FakeXmlHttpRequest);
    expect(requests[0]?.headers["X-DebugBundle-Trace-Id"]).toBe("trace-id");
    expect(requests[1]?.headers["X-DebugBundle-Trace-Id"]).toBeUndefined();
    expect(breadcrumbs).toHaveLength(1);
    expect(breadcrumbs[0]?.breadcrumb_type).toBe("network_request");
    expect(breadcrumbs[0]?.route).toBe("/orders");
    expect(breadcrumbs[0]?.data["url"]).toBe("https://example.com/orders/123");
    expect(breadcrumbs[0]?.data["method"]).toBe("PATCH");
    expect(breadcrumbs[0]?.data["status_code"]).toBe(500);
    expect(requestFailures).toHaveLength(1);
    expect(requestFailures[0]?.data["url"]).toBe("https://example.com/orders/123");
    expect(requestFailures[0]?.data["status_code"]).toBe(500);
  });

  it("should inject trace headers into allowlisted cross-origin XMLHttpRequest calls", (): void => {
    vi.stubGlobal("location", { href: "https://example.com/orders", pathname: "/orders", search: "" } as unknown);
    vi.stubGlobal("fetch", null as unknown);
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("trace-id") } as unknown);

    const requests: Array<{ headers: Record<string, string> }> = [];

    class FakeXmlHttpRequest extends FakeEventTarget {
      public status = 204;
      private headers: Record<string, string> = {};

      public open(): void {}

      public setRequestHeader(name: string, value: string): void {
        this.headers[name] = value;
      }

      public send(): void {
        requests.push({ headers: { ...this.headers } });
        this.dispatch("loadend");
      }
    }

    vi.stubGlobal("XMLHttpRequest", FakeXmlHttpRequest as unknown);

    installNetworkHook(
      {
        ...createConfig(),
        tracePropagationTargets: ["https://api.example.com"]
      } as ActiveConfig,
      vi.fn(),
      vi.fn(),
      () => false,
      () => "/orders"
    );

    const WrappedXmlHttpRequest = getWrappedXmlHttpRequestConstructor();
    const request = new WrappedXmlHttpRequest();
    request.open("POST", "https://api.example.com/orders/123", true);
    request.send();

    expect(requests[0]?.headers["X-DebugBundle-Trace-Id"]).toBe("trace-id");
  });

  it("should collect device info with browser globals and sensible fallbacks", (): void => {
    vi.stubGlobal("navigator", {
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      language: "en-US",
      maxTouchPoints: 5,
      connection: {
        effectiveType: "4g"
      }
    } as unknown);
    vi.stubGlobal("screen", { width: 390, height: 844 } as unknown);
    vi.stubGlobal("window", { innerWidth: 375, innerHeight: 812, devicePixelRatio: 3 } as unknown);
    const matchMediaMock = vi.fn<(query: string) => { matches: boolean }>().mockReturnValue({ matches: false });
    vi.stubGlobal("matchMedia", matchMediaMock as unknown);

    expect(collectDeviceInfo()).toEqual(
      expect.objectContaining({
        device_type: "mobile",
        language: "en-US",
        connection_type: "4g",
        color_scheme_preference: "light",
        screen: {
          width: 390,
          height: 844
        },
        viewport: {
          width: 375,
          height: 812
        },
        device_pixel_ratio: 3,
        touch_capable: true
      })
    );

    vi.unstubAllGlobals();
    vi.stubGlobal("crypto", { subtle: webcrypto.subtle } as unknown);

    expect(collectDeviceInfo()).toEqual(
      expect.objectContaining({
        color_scheme_preference: null,
        screen: {
          width: 0,
          height: 0
        },
        viewport: {
          width: 0,
          height: 0
        },
        device_pixel_ratio: null,
        touch_capable: null,
        connection_type: null
      })
    );
  });
});
