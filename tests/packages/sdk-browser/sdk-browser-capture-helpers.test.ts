import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createInitialRemoteProbeState,
  isImmediateRequestIncidentStatus,
  normalizeUnhandledRejectionReason,
  shouldCaptureBrowserNetworkRequest,
  shouldCaptureFailedBrowserNetworkRequest,
  shouldCaptureRequestStatus
} from "../../../packages/sdk-browser/src/capture-helpers.js";
import type { ActiveConfig, BrowserRemoteProbeState } from "../../../packages/sdk-browser/src/types.js";

function createNetworkConfig(
  overrides: Partial<ActiveConfig["networkFilter"]> = {}
): ActiveConfig {
  return {
    networkFilter: {
      urlPatterns: [],
      urlDenyPatterns: [],
      statusCodes: [500, 599],
      minResponseTime: null,
      ...overrides
    }
  } as unknown as ActiveConfig;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sdk-browser capture helpers", () => {
  it("creates an isolated balanced remote-probe state", () => {
    const first = createInitialRemoteProbeState();
    const second = createInitialRemoteProbeState();

    expect(first).toMatchObject({
      probesEnabled: false,
      requestFailurePreset: "balanced",
      requestCaptureEvents: "failures_only",
      immediateClientErrorStatuses: []
    });
    first.immediateClientErrorStatuses.push(418);
    expect(second.immediateClientErrorStatuses).toEqual([]);
  });

  it("normalizes every unhandled rejection shape without leaking large values", () => {
    const emptyError = new Error("");
    emptyError.name = "";
    expect(normalizeUnhandledRejectionReason(emptyError)).toMatchObject({
      error: emptyError,
      rejectionReason: { kind: "error", name: "Error", message: "Unknown rejection error" }
    });
    expect(normalizeUnhandledRejectionReason("")).toMatchObject({
      error: expect.any(Error),
      rejectionReason: { kind: "string", preview: "[empty string]" }
    });
    expect(normalizeUnhandledRejectionReason("x".repeat(600)).rejectionReason.preview).toHaveLength(511);
    expect(normalizeUnhandledRejectionReason(null).rejectionReason).toEqual({ kind: "null", preview: "null" });
    expect(normalizeUnhandledRejectionReason(undefined).rejectionReason).toEqual({
      kind: "undefined",
      preview: "undefined"
    });
    expect(
      normalizeUnhandledRejectionReason({
        name: " CustomError ",
        message: " failed ",
        constructor: { name: "" }
      }).rejectionReason
    ).toEqual({
      kind: "object",
      name: "CustomError",
      message: "failed",
      preview: "object"
    });
    expect(normalizeUnhandledRejectionReason({}).rejectionReason).toEqual({
      kind: "object",
      preview: "Object"
    });
    expect(normalizeUnhandledRejectionReason(Object.create(null)).rejectionReason).toEqual({
      kind: "object",
      preview: "object"
    });
    expect(normalizeUnhandledRejectionReason(123).rejectionReason).toEqual({
      kind: "object",
      preview: "object"
    });
  });

  it("preserves immediate browser incidents across presets and policy modes", () => {
    expect(isImmediateRequestIncidentStatus(Number.NaN, "balanced")).toBe(false);
    expect(isImmediateRequestIncidentStatus(503, "minimal")).toBe(true);
    expect(isImmediateRequestIncidentStatus(418, "minimal", [418])).toBe(true);
    expect(isImmediateRequestIncidentStatus(409, "investigative")).toBe(true);
    expect(isImmediateRequestIncidentStatus(429, "balanced")).toBe(true);
    expect(isImmediateRequestIncidentStatus(400, "minimal")).toBe(false);

    expect(shouldCaptureRequestStatus(503, "minimal", "off")).toBe(true);
    expect(shouldCaptureRequestStatus(404, "minimal", "all")).toBe(true);
    expect(shouldCaptureRequestStatus(Number.NaN, "minimal", "all")).toBe(false);
    expect(shouldCaptureRequestStatus(499, "minimal", "failures_only")).toBe(false);
    expect(shouldCaptureRequestStatus(499, "minimal", "filtered")).toBe(false);
  });

  it("matches immediate client-error path rules by URL, method, exact path, and prefix", () => {
    const rules: BrowserRemoteProbeState["immediateClientErrorPathRules"] = [
      { statusCode: 404, pathPattern: "/checkout", methods: ["POST"] },
      { statusCode: 422, pathPattern: "/api/orders/*", methods: [] }
    ];
    vi.stubGlobal("location", { href: "https://shop.example.com/current" });

    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/checkout?retry=1", "post", rules)).toBe(true);
    expect(
      isImmediateRequestIncidentStatus(422, "minimal", [], "https://shop.example.com/api/orders/1", undefined, rules)
    ).toBe(true);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/checkout", undefined, rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/checkout", "GET", rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/other", "POST", rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(400, "minimal", [], "/checkout", "POST", rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], undefined, "POST", rules)).toBe(false);

    const rootRule: BrowserRemoteProbeState["immediateClientErrorPathRules"] = [
      { statusCode: 404, pathPattern: "/", methods: [] }
    ];
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "http://[?bad#value", undefined, rootRule)).toBe(true);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "http://[#bad", undefined, rootRule)).toBe(true);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "http://[?bad", undefined, rootRule)).toBe(true);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "http://[", undefined, rootRule)).toBe(true);
  });

  it("applies browser network allow, deny, latency, and status filters", () => {
    expect(shouldCaptureBrowserNetworkRequest(null, "/api/orders", 503, 100)).toBe(false);
    expect(
      shouldCaptureBrowserNetworkRequest(
        createNetworkConfig({ urlPatterns: ["/api/"], urlDenyPatterns: ["/health"], minResponseTime: 50 }),
        "/api/orders",
        503,
        100
      )
    ).toBe(true);
    expect(
      shouldCaptureBrowserNetworkRequest(
        createNetworkConfig({ urlPatterns: ["/admin"] }),
        "/api/orders",
        503,
        100
      )
    ).toBe(false);
    expect(
      shouldCaptureBrowserNetworkRequest(
        createNetworkConfig({ urlDenyPatterns: ["/health"] }),
        "/api/health",
        503,
        100
      )
    ).toBe(false);
    expect(
      shouldCaptureBrowserNetworkRequest(createNetworkConfig({ minResponseTime: 200 }), "/api/orders", 503, 100)
    ).toBe(false);
    expect(shouldCaptureBrowserNetworkRequest(createNetworkConfig(), "/api/orders", 399, 100)).toBe(false);

    expect(shouldCaptureFailedBrowserNetworkRequest(null, "/api/orders", 100)).toBe(false);
    expect(shouldCaptureFailedBrowserNetworkRequest(createNetworkConfig(), "/api/orders", 100)).toBe(true);
  });
});
