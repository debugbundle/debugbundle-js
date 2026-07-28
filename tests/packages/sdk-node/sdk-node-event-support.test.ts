import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";

import {
  applyNodeCaptureRules,
  buildInternalSdkPaths,
  buildNodeCorrelation,
  buildNodeLogAttributes,
  buildNodeRequestSnapshot,
  buildNodeResponseSnapshot,
  buildNodeServiceDescriptor,
  buildNodeSuppressionKey,
  consumeNodeProbeData,
  effectiveNodeLogThreshold,
  formatNodeConsoleMessage,
  normalizeNodeRequestPath,
  shouldCaptureNodeSample
} from "../../../packages/sdk-node/src/event-support.js";
import type { ActiveConfig, NodeCaptureRule, ProbeBufferItem } from "../../../packages/sdk-node/src/types.js";

function createConfig(overrides: Partial<ActiveConfig> = {}): ActiveConfig {
  return {
    service: "checkout-api",
    environment: "production",
    framework: null,
    endpoint: "https://api.debugbundle.com/v1/events",
    ...overrides
  } as ActiveConfig;
}

function createRequestEvent(): EventEnvelope {
  return {
    event_type: "request_event",
    event_id: "00000000-0000-4000-8000-000000000601",
    service: { name: "checkout-api", runtime: "node", environment: "production" },
    payload: {
      method: "POST",
      path: "/checkout",
      response_status: 503,
      route_template: "/checkout"
    }
  } as unknown as EventEnvelope;
}

function createRule(overrides: Partial<NodeCaptureRule> = {}): NodeCaptureRule {
  return {
    id: "rule-drop",
    project_id: "proj_123",
    name: "Drop checkout",
    description: null,
    enabled: true,
    action: "drop",
    matcher: { services: ["checkout-api"] },
    sample_rate: null,
    sample_event_class: null,
    created_by_user_id: null,
    created_from_incident_id: null,
    created_from_event_id: null,
    expires_at: null,
    hit_count: 0,
    last_matched_at: null,
    created_at: "2026-05-26T10:00:00.000Z",
    updated_at: "2026-05-26T10:00:00.000Z",
    ...overrides
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sdk-node event support", () => {
  it("builds service, correlation, request, response, and log snapshots", () => {
    expect(buildNodeServiceDescriptor(createConfig())).toEqual({
      name: "checkout-api",
      runtime: "node",
      environment: "production"
    });
    expect(buildNodeServiceDescriptor(createConfig({ framework: "express" }))).toHaveProperty("framework", "express");

    expect(
      buildNodeCorrelation(
        { request_id: "explicit" },
        { headers: { "x-debugbundle-trace-id": "header-trace", "x-request-id": "header-request" } },
        { request_id: "context-request", session_id: "context-session", user_id_hash: 123 }
      )
    ).toEqual({
      request_id: "explicit",
      trace_id: "header-trace",
      session_id: "context-session",
      user_id_hash: null
    });
    expect(buildNodeCorrelation(undefined, undefined, {})).toEqual({
      request_id: null,
      trace_id: null,
      session_id: null,
      user_id_hash: null
    });

    expect(buildNodeRequestSnapshot(undefined, ["authorization"])).toEqual({
      method: "UNKNOWN",
      path: "/",
      headers: {},
      query: {},
      body: null,
      route_template: null
    });
    expect(
      buildNodeRequestSnapshot(
        {
          method: "POST",
          url: "/checkout",
          headers: { authorization: "secret" },
          query: { coupon: "TEAM" },
          body: { card: "4111" },
          routeTemplate: "/checkout"
        },
        ["authorization", "card"]
      )
    ).toMatchObject({
      method: "POST",
      path: "/checkout",
      headers: { authorization: "[REDACTED]" },
      body: { card: "[REDACTED]" }
    });

    expect(buildNodeResponseSnapshot(undefined, [])).toEqual({ status_code: 0 });
    expect(
      buildNodeResponseSnapshot(
        { status: 422, headers: { authorization: "secret" }, body: { token: "secret" } },
        ["authorization", "token"]
      )
    ).toEqual({
      status_code: 422,
      headers: { authorization: "[REDACTED]" },
      body: { token: "[REDACTED]" }
    });
    expect(buildNodeResponseSnapshot({ statusCode: 200, body: { ok: true } }, [])).toEqual({ status_code: 200 });

    expect(buildNodeLogAttributes({ correlation: {}, retry: true }, { request_id: "req" }, [])).toEqual({
      context: { request_id: "req" },
      retry: true
    });
    expect(buildNodeLogAttributes({}, {}, [])).toEqual({});
  });

  it("consumes buffered probe entries once", () => {
    const item: ProbeBufferItem = {
      label: "checkout.total",
      data: { value: 42 },
      timestamp: "2026-05-26T10:00:00.000Z",
      activation_id: null
    };
    const buffers = new Map([["checkout.total", [item]]]);

    expect(consumeNodeProbeData(new Map())).toBeNull();
    expect(consumeNodeProbeData(buffers)).toEqual({ version: 1, items: [item] });
    expect(buffers.size).toBe(0);
  });

  it("builds suppression keys for supported event types", () => {
    const request = createRequestEvent();
    expect(buildNodeSuppressionKey(request)).toContain('"route_template":"/checkout"');
    expect(
      buildNodeSuppressionKey({
        ...request,
        payload: { ...request.payload, route_template: undefined }
      } as EventEnvelope)
    ).toContain('"route_template":null');

    const log = {
      ...request,
      event_type: "log_event",
      payload: { level: "error", message: "Checkout failed", attributes: {} }
    } as unknown as EventEnvelope;
    expect(buildNodeSuppressionKey(log)).toContain("Checkout failed");

    const backend = {
      ...request,
      event_type: "backend_exception",
      payload: {
        name: "TypeError",
        message: "Checkout failed",
        stack: "stack",
        request: { path: "/checkout" },
        response: { status_code: 503 }
      }
    } as unknown as EventEnvelope;
    expect(buildNodeSuppressionKey(backend)).toContain("TypeError");
    expect(buildNodeSuppressionKey({ ...request, event_type: "deploy_metadata" } as EventEnvelope)).toBeNull();
  });

  it("applies capture rules fail closed and preserves unmatched events", () => {
    const event = createRequestEvent();
    expect(applyNodeCaptureRules(event, [])).toBe(event);
    expect(applyNodeCaptureRules(event, [createRule({ project_id: "" })])).toBe(event);
    expect(applyNodeCaptureRules(event, [createRule({ matcher: { services: ["other"] } })])).toBe(event);
    expect(applyNodeCaptureRules(event, [createRule()])).toBeNull();

    const throwingRule = new Proxy(createRule(), {
      get(target, property, receiver) {
        if (property === "enabled") {
          throw new Error("malformed rule");
        }
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    expect(applyNodeCaptureRules(event, [throwingRule])).toBe(event);
  });

  it("handles sampling, thresholds, console values, paths, and internal endpoints", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    expect(shouldCaptureNodeSample(1)).toBe(true);
    expect(shouldCaptureNodeSample(0.5)).toBe(true);
    expect(shouldCaptureNodeSample(0.4)).toBe(false);
    expect(effectiveNodeLogThreshold("error", "warning")).toBe("error");
    expect(effectiveNodeLogThreshold("info", "warning")).toBe("warning");
    expect(formatNodeConsoleMessage(["message", { retry: true }, 42])).toBe('message {"retry":true} 42');

    expect(normalizeNodeRequestPath(null)).toBeNull();
    expect(normalizeNodeRequestPath(" ")).toBeNull();
    expect(normalizeNodeRequestPath("https://api.example.com/v1/events?x=1")).toBe("/v1/events");
    expect(normalizeNodeRequestPath("http://[")).toBe("/http://[");
    expect(buildInternalSdkPaths(createConfig())).toEqual(["/v1/events", "/v1/sdk/config"]);
  });
});
