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
  parseRemoteProbeConfigPayload,
  stringifyConsoleArgs
} from "../../../packages/sdk-browser/src/runtime.js";
import { DEFAULT_ENDPOINT } from "../../../packages/sdk-browser/src/types.js";

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
        timeout_ms: 5000
      })
    ).resolves.toEqual({ status: 202, body: { ok: true } });
  });

  it("should derive the sdk config endpoint from supported event endpoints", (): void => {
    expect(deriveSdkConfigEndpoint("https://api.debugbundle.com/v1/events")).toBe("https://api.debugbundle.com/v1/sdk/config");
    expect(deriveSdkConfigEndpoint("https://api.debugbundle.com/events")).toBe("https://api.debugbundle.com/sdk/config");
    expect(deriveSdkConfigEndpoint("https://api.debugbundle.com/v1/sdk/config")).toBe("https://api.debugbundle.com/v1/sdk/config");
  });

  it("should serialize relay transport bodies with batch payloads and direct bodies with events payloads", (): void => {
    expect(buildBrowserTransportRequestBody("/debugbundle/browser", [])).toBe('{"batch":[]}');
    expect(buildBrowserTransportRequestBody("https://api.debugbundle.com/v1/events", [])).toBe('{"events":[]}');
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

    for (const endpoint of ["debugbundle/browser", "javascript:alert(1)", "//evil.example/relay"]) {
      expect(resolveBrowserTransport({ endpoint })).toEqual({
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
