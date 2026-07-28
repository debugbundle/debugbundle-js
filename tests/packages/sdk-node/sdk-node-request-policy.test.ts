import { describe, expect, it } from "vitest";

import {
  isImmediateRequestIncidentStatus,
  shouldCaptureNodeRequestEvent
} from "../../../packages/sdk-node/src/request-policy.js";
import type { CapturePolicy } from "../../../packages/sdk-node/src/types.js";

function createPolicy(overrides: Partial<CapturePolicy> = {}): CapturePolicy {
  return {
    preset: "minimal",
    captureLogs: "error",
    captureRequestEvents: "off",
    captureBreadcrumbs: "exception_only",
    captureProbeEvents: "buffer_only",
    immediateClientErrorStatuses: [],
    immediateClientErrorPathRules: [],
    ...overrides
  };
}

describe("sdk-node request capture policy", () => {
  it("recognizes immediate server, configured client, and preset statuses", () => {
    expect(isImmediateRequestIncidentStatus(Number.NaN, "balanced")).toBe(false);
    expect(isImmediateRequestIncidentStatus(500, "minimal")).toBe(true);
    expect(isImmediateRequestIncidentStatus(418, "minimal", [418])).toBe(true);
    expect(isImmediateRequestIncidentStatus(409, "investigative")).toBe(true);
    expect(isImmediateRequestIncidentStatus(429, "balanced")).toBe(true);
    expect(isImmediateRequestIncidentStatus(400, "minimal")).toBe(false);
  });

  it("matches exact and prefix path rules with normalized methods and URLs", () => {
    const rules: CapturePolicy["immediateClientErrorPathRules"] = [
      { statusCode: 404, pathPattern: "/checkout", methods: ["POST"] },
      { statusCode: 422, pathPattern: "/api/orders/*", methods: [] }
    ];

    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/checkout?retry=1", "post", rules)).toBe(true);
    expect(isImmediateRequestIncidentStatus(422, "minimal", [], "https://shop.test/api/orders/123", undefined, rules)).toBe(
      true
    );
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/checkout", undefined, rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/checkout", "GET", rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "/other", "POST", rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(400, "minimal", [], "/checkout", "POST", rules)).toBe(false);
    expect(isImmediateRequestIncidentStatus(404, "minimal", [], undefined, "POST", rules)).toBe(false);
  });

  it("fails closed while normalizing malformed request URLs", () => {
    const rules: CapturePolicy["immediateClientErrorPathRules"] = [
      { statusCode: 404, pathPattern: "/", methods: [] },
      { statusCode: 422, pathPattern: "/orders", methods: [] }
    ];

    expect(isImmediateRequestIncidentStatus(404, "minimal", [], "http://[?bad#value", undefined, rules)).toBe(true);
    expect(isImmediateRequestIncidentStatus(422, "minimal", [], "/orders?bad#value", undefined, rules)).toBe(true);
    expect(isImmediateRequestIncidentStatus(422, "minimal", [], "/orders#bad", undefined, rules)).toBe(true);
  });

  it("applies request-event modes after immediate-incident preservation", () => {
    expect(shouldCaptureNodeRequestEvent(createPolicy(), { path: "/" }, { statusCode: 503 })).toBe(true);
    expect(shouldCaptureNodeRequestEvent(createPolicy(), { path: "/" }, { statusCode: 200 })).toBe(false);
    expect(
      shouldCaptureNodeRequestEvent(createPolicy({ captureRequestEvents: "all" }), { path: "/" }, { status: 200 })
    ).toBe(true);
    expect(
      shouldCaptureNodeRequestEvent(
        createPolicy({ captureRequestEvents: "failures_only" }),
        { path: "/" },
        { statusCode: 499 }
      )
    ).toBe(false);
    expect(
      shouldCaptureNodeRequestEvent(createPolicy({ captureRequestEvents: "filtered" }), { path: "/" }, {})
    ).toBe(false);
  });
});
