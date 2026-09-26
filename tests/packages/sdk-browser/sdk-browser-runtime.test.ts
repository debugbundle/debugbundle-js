import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSelector,
  captureCallerTrace,
  createBrowserTraceId,
  buildBrowserTransportRequestBody,
  createFetchTransport,
  deriveSdkConfigEndpoint,
  resolveBrowserTransport,
  getConsoleSource,
  getCryptoSource,
  getDocumentSource,
  getFetchSource,
  getHistorySource,
  getLocationSource,
  getMatchMedia,
  getNavigatorSource,
  getScreenSource,
  getWindowSource,
  getXmlHttpRequestConstructor,
  matchesBrowserPattern,
  matchesStatusCodeFilter,
  normalizeBoolean,
  normalizeError,
  normalizeLogLevel,
  normalizeNetworkFilter,
  normalizePositiveNumber,
  normalizeSampleRate,
  normalizeTracePropagationTargets,
  normalizeUnknownRecord,
  parseIngestionProbeDirectives,
  parseRemoteAnalyticsConfigPayload,
  parseRemoteProbeConfigPayload,
  stringifyConsoleArgs
} from "../../../packages/sdk-browser/src/runtime.js";
import { parseRemoteCaptureRulesPayload } from "../../../packages/sdk-browser/src/capture-rules.js";
import { boundedTransportTimeoutMs, parseRetryAfter } from "../../../packages/sdk-browser/src/fetch-transport.js";
import { DEFAULT_ENDPOINT, DEFAULT_RELAY_ENDPOINT } from "../../../packages/sdk-browser/src/types.js";

describe("sdk-browser runtime helpers", () => {
  beforeEach((): void => {
    vi.restoreAllMocks();
  });

  it("should normalize network filters with defaults and valid values", (): void => {
    expect(normalizeNetworkFilter(undefined)).toEqual({
      urlPatterns: [],
      urlDenyPatterns: [],
      statusCodes: [400, 599],
      minResponseTime: null
    });

    expect(
      normalizeNetworkFilter({
        urlPatterns: ["/api", "checkout", 123 as never],
        urlDenyPatterns: ["/health"],
        statusCodes: [500.8, Number.NaN, 503],
        minResponseTime: 25.9
      })
    ).toEqual({
      urlPatterns: ["/api", "checkout"],
      urlDenyPatterns: ["/health"],
      statusCodes: [500, 503],
      minResponseTime: 25
    });
  });

  it("should resolve browser globals and normalize primitive config values", async (): Promise<void> => {
    const windowSource = { addEventListener: vi.fn(), removeEventListener: vi.fn(), innerWidth: 1, innerHeight: 1 };
    const documentSource = { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: "visible" };
    const historySource = { pushState: vi.fn(), replaceState: vi.fn() };
    const navigatorSource = { userAgent: "ua" };
    const locationSource = { pathname: "/checkout", search: "?x=1" };
    const screenSource = { width: 10, height: 20 };
    const fetchSource = vi.fn().mockResolvedValue({ status: 202, json: vi.fn().mockResolvedValue({ ok: true }) });
    const consoleSource = { error: vi.fn(), warn: vi.fn() };
    const cryptoSource = { randomUUID: vi.fn().mockReturnValue("trace-id") };
    const xhrSource = class FakeXmlHttpRequest {};
    const matchMedia = vi.fn().mockReturnValue({ matches: true });

    vi.stubGlobal("window", windowSource as unknown);
    vi.stubGlobal("document", documentSource as unknown);
    vi.stubGlobal("history", historySource as unknown);
    vi.stubGlobal("navigator", navigatorSource as unknown);
    vi.stubGlobal("location", locationSource as unknown);
    vi.stubGlobal("screen", screenSource as unknown);
    vi.stubGlobal("fetch", fetchSource as unknown);
    vi.stubGlobal("console", consoleSource as unknown);
    vi.stubGlobal("crypto", cryptoSource as unknown);
    vi.stubGlobal("XMLHttpRequest", xhrSource as unknown);
    vi.stubGlobal("matchMedia", matchMedia as unknown);

    expect(getWindowSource()).toBe(windowSource);
    expect(getDocumentSource()).toBe(documentSource);
    expect(getHistorySource()).toBe(historySource);
    expect(getNavigatorSource()).toBe(navigatorSource);
    expect(getLocationSource()).toBe(locationSource);
    expect(getScreenSource()).toBe(screenSource);
    expect(getFetchSource()).toBe(fetchSource);
    expect(getConsoleSource()).toBe(consoleSource);
    expect(getCryptoSource()).toBe(cryptoSource);
    expect(getXmlHttpRequestConstructor()).toBe(xhrSource);
    expect(getMatchMedia()).toBe(matchMedia);

    expect(normalizePositiveNumber(undefined, 10)).toBe(10);
    expect(normalizePositiveNumber(0, 10)).toBe(10);
    expect(normalizePositiveNumber(7.8, 10)).toBe(7);
    expect(normalizeSampleRate(undefined, 0.5)).toBe(0.5);
    expect(normalizeSampleRate(-1, 0.5)).toBe(0);
    expect(normalizeSampleRate(5, 0.5)).toBe(1);
    expect(normalizeBoolean(undefined, true)).toBe(true);
    expect(normalizeBoolean(false, true)).toBe(false);
    expect(normalizeLogLevel("error")).toBe("error");
    expect(normalizeLogLevel("nope")).toBe("warning");
    expect(normalizeUnknownRecord(null)).toEqual({});
    expect(normalizeUnknownRecord([1, 2])).toEqual({});
    expect(normalizeUnknownRecord({ ok: true })).toEqual({ ok: true });
    expect(normalizeError(new Error("boom"))).toMatchObject({ message: "boom" });
    expect(normalizeError("boom")).toMatchObject({ message: "boom" });
    expect(normalizeError(123)).toMatchObject({ message: "Unknown browser error" });

    const transport = createFetchTransport();
    await expect(
      transport({
        endpoint: "https://api.debugbundle.com/v1/events",
        headers: { authorization: "Bearer token" },
        events: [],
        transportMode: "direct",
        timeout_ms: 5000
      })
    ).resolves.toEqual({ status: 202, body: { ok: true } });
  });

  it("aborts a stalled built-in fetch at the configured transport deadline", async (): Promise<void> => {
    let signal: AbortSignal | undefined;
    const fetchSource = vi.fn((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        signal = init.signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }));
    vi.stubGlobal("fetch", fetchSource);
    try {
      const outcome = createFetchTransport()({
        endpoint: "https://api.debugbundle.test/v1/events",
        headers: {}, events: [], transportMode: "direct", timeout_ms: 10
      }).catch((error: unknown) => error);
      await vi.waitFor(() => expect(signal?.aborted).toBe(true), { timeout: 500 });
      await expect(outcome).resolves.toBeInstanceOf(Error);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not acknowledge a response whose body decoding exceeded the deadline", async (): Promise<void> => {
    const fetchSource = vi.fn((_url: unknown, init: { signal: AbortSignal }) =>
      Promise.resolve({
        status: 202,
        json: () => new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        })
      }));
    vi.stubGlobal("fetch", fetchSource);
    try {
      await expect(createFetchTransport()({
        endpoint: "https://api.debugbundle.test/v1/events",
        headers: {}, events: [], transportMode: "direct", timeout_ms: 10
      })).rejects.toThrow("transport timeout");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps transport deadlines and retry hints finite when input is malformed", (): void => {
    expect(boundedTransportTimeoutMs(Number.POSITIVE_INFINITY)).toBe(5_000);
    expect(boundedTransportTimeoutMs(0)).toBe(1);
    expect(boundedTransportTimeoutMs(100_000)).toBe(60_000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("-3")).toBe(0);
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 5_000).toUTCString())).toBeGreaterThan(0);
  });

  it("fails safely when fetch or abort support is unavailable", async (): Promise<void> => {
    const request = {
      endpoint: "https://api.debugbundle.test/v1/events",
      headers: {}, events: [], transportMode: "direct" as const, timeout_ms: 10
    };
    vi.stubGlobal("fetch", undefined);
    try {
      await expect(createFetchTransport()(request)).rejects.toThrow("fetch unavailable");
    } finally {
      vi.unstubAllGlobals();
    }

    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("AbortController", undefined);
    try {
      await expect(createFetchTransport()(request)).rejects.toThrow("abort controller unavailable");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves retry hints and no-body success responses", async (): Promise<void> => {
    const fetchSource = vi.fn().mockResolvedValue({
      status: 429,
      headers: { get: () => "2" }
    });
    vi.stubGlobal("fetch", fetchSource);
    try {
      await expect(createFetchTransport()({
        endpoint: "https://api.debugbundle.test/v1/events",
        headers: {}, events: [], transportMode: "direct", timeout_ms: 500
      })).resolves.toEqual({ status: 429, retry_after_ms: 2_000 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("should derive the sdk config endpoint from supported event endpoints", (): void => {
    expect(deriveSdkConfigEndpoint("https://api.debugbundle.com/v1/events")).toBe("https://api.debugbundle.com/v1/sdk/config");
    expect(deriveSdkConfigEndpoint("https://api.debugbundle.com/events")).toBe("https://api.debugbundle.com/sdk/config");
    expect(deriveSdkConfigEndpoint("https://api.debugbundle.com/v1/sdk/config")).toBe("https://api.debugbundle.com/v1/sdk/config");
  });

  it("should parse valid remote capture rules and ignore malformed entries", (): void => {
    expect(
      parseRemoteCaptureRulesPayload({
        capture_rules: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            project_id: "proj_123",
            name: "Demote analytics resource noise",
            description: null,
            enabled: true,
            action: "demote",
            matcher: {
              event_types: ["frontend_exception"],
              browser_event_kind: "resource_error",
              browser_event_opaque: true,
              client_kind: "bot",
              bot_family: "Googlebot",
              resource_url: { host: "analytics.example.com" }
            },
            sample_rate: null,
            sample_event_class: null,
            created_by_user_id: "usr_owner",
            created_from_incident_id: null,
            created_from_event_id: null,
            expires_at: null,
            hit_count: 0,
            last_matched_at: null,
            created_at: "2026-05-26T10:00:00.000Z",
            updated_at: "2026-05-26T10:00:00.000Z"
          },
          {
            id: "broken-rule",
            action: "demote"
          }
        ]
      })
    ).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000101",
        project_id: "proj_123",
        name: "Demote analytics resource noise",
        description: null,
        enabled: true,
        action: "demote",
        matcher: {
          event_types: ["frontend_exception"],
          browser_event_kind: "resource_error",
          browser_event_opaque: true,
          client_kind: "bot",
          bot_family: "Googlebot",
          resource_url: { host: "analytics.example.com" }
        },
        sample_rate: null,
        sample_event_class: null,
        created_by_user_id: "usr_owner",
        created_from_incident_id: null,
        created_from_event_id: null,
        expires_at: null,
        hit_count: 0,
        last_matched_at: null,
        created_at: "2026-05-26T10:00:00.000Z",
        updated_at: "2026-05-26T10:00:00.000Z"
      }
    ]);
  });

  it("should serialize relay transport bodies with batch payloads and direct bodies with events payloads", (): void => {
    expect(buildBrowserTransportRequestBody("relay", [])).toBe('{"batch":[]}');
    expect(buildBrowserTransportRequestBody("direct", [])).toBe('{"events":[]}');
  });

  it("should resolve browser transport mode from endpoint and project token configuration", (): void => {
    expect(resolveBrowserTransport({ endpoint: "/debugbundle/browser" })).toEqual({
      mode: "relay",
      endpoint: "/debugbundle/browser",
      projectToken: null
    });

    expect(resolveBrowserTransport({ projectToken: "dbundle_proj_browser" })).toEqual({
      mode: "direct",
      endpoint: DEFAULT_ENDPOINT,
      projectToken: "dbundle_proj_browser"
    });

    expect(
      resolveBrowserTransport({
        endpoint: "https://ingest.example.test/v1/events",
        projectToken: "dbundle_proj_browser"
      })
    ).toEqual({
      mode: "direct",
      endpoint: "https://ingest.example.test/v1/events",
      projectToken: "dbundle_proj_browser"
    });

    expect(resolveBrowserTransport({ endpoint: "https://ingest.example.test/v1/events" })).toEqual({
      mode: "disabled",
      endpoint: null,
      projectToken: null
    });

    expect(resolveBrowserTransport({ transportMode: "relay" })).toEqual({
      mode: "relay",
      endpoint: DEFAULT_RELAY_ENDPOINT,
      projectToken: null
    });

    expect(
      resolveBrowserTransport({
        transportMode: "relay",
        endpoint: "https://api.example.test/debugbundle/browser",
        projectToken: "dbundle_proj_should_not_be_used_in_relay"
      })
    ).toEqual({
      mode: "relay",
      endpoint: "https://api.example.test/debugbundle/browser",
      projectToken: null
    });

    expect(
      resolveBrowserTransport({
        transportMode: "direct",
        endpoint: "/debugbundle/browser",
        projectToken: "dbundle_proj_browser"
      })
    ).toEqual({
      mode: "disabled",
      endpoint: null,
      projectToken: null
    });

    for (const endpoint of ["debugbundle/browser", "javascript:alert(1)", "//evil.example/relay"]) {
      expect(resolveBrowserTransport({ endpoint })).toEqual({
        mode: "disabled",
        endpoint: null,
        projectToken: null
      });

      expect(resolveBrowserTransport({ transportMode: "relay", endpoint })).toEqual({
        mode: "disabled",
        endpoint: null,
        projectToken: null
      });
    }

    expect(resolveBrowserTransport({})).toEqual({
      mode: "disabled",
      endpoint: null,
      projectToken: null
    });
  });

  it("should parse remote probe config payloads and filter invalid directives", (): void => {
    expect(parseRemoteProbeConfigPayload(null, Date.parse("2026-03-15T00:00:00.000Z"))).toBeNull();

    expect(
      parseRemoteProbeConfigPayload(
        {
          probes_enabled: true,
          remote_probes_enabled: true,
          active_probes: [
            {
              activation_id: "11111111-1111-4111-8111-111111111111",
              label_pattern: "checkout.*",
              service: "checkout-web",
              environment: "production",
              expires_at: "2026-03-20T00:00:00.000Z",
              trigger_expires_at: "invalid"
            },
            {
              activation_id: "22222222-2222-4222-8222-222222222222",
              label_pattern: "expired.*",
              service: "checkout-web",
              environment: "production",
              expires_at: "2026-03-10T00:00:00.000Z"
            },
            {
              activation_id: 123,
              label_pattern: "bad.*",
              service: "checkout-web",
              environment: "production",
              expires_at: "2026-03-20T00:00:00.000Z"
            }
          ],
          trigger_token_key: "trigger-key"
        },
        Date.parse("2026-03-15T00:00:00.000Z")
      )
    ).toEqual({
      probesEnabled: true,
      remoteProbesEnabled: true,
      requestFailurePreset: "balanced",
      requestCaptureEvents: "failures_only",
      immediateClientErrorStatuses: [],
      immediateClientErrorPathRules: [],
      directives: [
        {
          activationId: "11111111-1111-4111-8111-111111111111",
          labelPattern: "checkout.*",
          service: "checkout-web",
          environment: "production",
          expiresAt: "2026-03-20T00:00:00.000Z",
          triggerExpiresAt: null
        }
      ],
      triggerTokenKey: "trigger-key"
    });
  });

  it("should parse complete remote analytics capture settings only", (): void => {
    expect(parseRemoteAnalyticsConfigPayload({})).toBeNull();
    expect(
      parseRemoteAnalyticsConfigPayload({
        analytics: {
          enabled: true,
          privacy_mode: "strict",
          consent_required: true,
          capture_page_views: true,
          capture_route_changes: false,
          capture_actions: true,
          capture_friction_signals: false
        }
      })
    ).toEqual({
      enabled: true,
      privacyMode: "strict",
      consentRequired: true,
      capturePageViews: true,
      captureRouteChanges: false,
      captureActions: true,
      captureFrictionSignals: false
    });
    expect(
      parseRemoteAnalyticsConfigPayload({
        analytics: {
          enabled: true,
          privacy_mode: "unknown",
          consent_required: false,
          capture_page_views: true,
          capture_route_changes: true,
          capture_actions: true,
          capture_friction_signals: true
        }
      })
    ).toBeNull();
  });

  it("should parse ingestion probe directives only when the response shape is valid", (): void => {
    expect(parseIngestionProbeDirectives({}, Date.parse("2026-03-15T00:00:00.000Z"))).toBeNull();

    expect(
      parseIngestionProbeDirectives(
        {
          probe_directives: {
            active_probes: [
              {
                activation_id: "11111111-1111-4111-8111-111111111111",
                label_pattern: "checkout.*",
                service: "checkout-web",
                environment: "production",
                expires_at: "2026-03-20T00:00:00.000Z",
                trigger_expires_at: "2026-03-21T00:00:00.000Z"
              },
              {
                activation_id: "expired",
                label_pattern: "checkout.*",
                service: "checkout-web",
                environment: "production",
                expires_at: "2026-03-10T00:00:00.000Z"
              }
            ]
          }
        },
        Date.parse("2026-03-15T00:00:00.000Z")
      )
    ).toEqual([
      {
        activationId: "11111111-1111-4111-8111-111111111111",
        labelPattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        expiresAt: "2026-03-20T00:00:00.000Z",
        triggerExpiresAt: "2026-03-21T00:00:00.000Z"
      }
    ]);
  });

  it("should stringify console args and match patterns and status filters", (): void => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(stringifyConsoleArgs(["hello", new Error("boom"), { ok: true }, circular])).toContain("hello boom {\"ok\":true}");

    expect(normalizeTracePropagationTargets(["api.example.com", /^https:\/\/api\.example\.com/ as never])).toEqual([
      "api.example.com"
    ]);
    expect(matchesBrowserPattern("/checkout", "checkout")).toBe(true);
    expect(matchesBrowserPattern("/cart", "/cart")).toBe(true);

    expect(matchesStatusCodeFilter(404, [404, 500])).toBe(true);
    expect(matchesStatusCodeFilter(450, [400, 499])).toBe(true);
    expect(matchesStatusCodeFilter(200, [400, 499])).toBe(false);
  });

  it("should create browser trace ids and selectors", (): void => {
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValue("trace-id") } as unknown);
    expect(createBrowserTraceId()).toBe("trace-id");

    vi.stubGlobal("crypto", {} as unknown);
    const traceId = createBrowserTraceId();
    expect(traceId).toMatch(/^[0-9a-f-]{36}$/);

    expect(buildSelector({ tagName: "BUTTON", id: "pay-now" })).toBe("button#pay-now");
    expect(buildSelector({})).toBeNull();
  });

  it("should capture caller trace with frame skipping", (): void => {
    function innerCaller(): string[] {
      return captureCallerTrace(0, 3);
    }

    function outerCaller(): string[] {
      return innerCaller();
    }

    const frames = outerCaller();

    expect(frames.length).toBeGreaterThan(0);
    // With Error.captureStackTrace, captureCallerTrace itself is excluded.
    // skipFrames=0 means the first frame is the direct caller (innerCaller).
    expect(frames[0]).toContain("innerCaller");
    expect(frames[1]).toContain("outerCaller");
    // Frames should not include the "at " prefix (cleaned by captureCallerTrace)
    expect(frames.every((f) => !f.startsWith("at "))).toBe(true);
  });

  it("should return empty array when skipFrames exceeds available frames", (): void => {
    const frames = captureCallerTrace(999, 5);
    expect(frames).toEqual([]);
  });

  it("should respect maxFrames limit", (): void => {
    function deeply(): string[] {
      return captureCallerTrace(0, 2);
    }

    const frames = deeply();
    expect(frames.length).toBeLessThanOrEqual(2);
  });
});
