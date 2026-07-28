import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";

import {
  applyBrowserCaptureRules,
  buildBrowserSuppressionKey
} from "../../../packages/sdk-browser/src/event-pipeline.js";
import type { ActiveConfig, BrowserCaptureRule } from "../../../packages/sdk-browser/src/types.js";

function createFrontendEvent(): Extract<EventEnvelope, { event_type: "frontend_exception" }> {
  return {
    schema_version: "2026-03-01",
    event_id: "00000000-0000-4000-8000-000000000501",
    event_type: "frontend_exception",
    project_token: "dbundle_proj_test",
    sdk_name: "@debugbundle/sdk-browser",
    sdk_version: "0.1.0",
    service: { name: "checkout-web", runtime: "browser", framework: "react", environment: "production" },
    occurred_at: "2026-05-26T10:00:00.000Z",
    correlation: { request_id: null, trace_id: null, session_id: null, user_id_hash: null },
    payload: {
      name: "TypeError",
      message: "Checkout failed",
      stack: "TypeError: Checkout failed\n    at checkout.ts:10:5",
      route: null,
      browser_event: {
        kind: "resource_error",
        target: { source_url: "https://cdn.example.com/app.js" }
      }
    }
  } as unknown as Extract<EventEnvelope, { event_type: "frontend_exception" }>;
}

function createRule(
  action: BrowserCaptureRule["action"],
  overrides: Partial<BrowserCaptureRule> = {}
): BrowserCaptureRule {
  return {
    id: `rule-${action}`,
    project_id: "proj_123",
    name: `${action} rule`,
    description: null,
    enabled: true,
    action,
    matcher: { services: ["checkout-web"] },
    sample_rate: action === "sample" ? 1 : null,
    sample_event_class: action === "sample" ? "context" : null,
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

function createConfig(captureRules: BrowserCaptureRule[]): ActiveConfig {
  return { captureRules } as unknown as ActiveConfig;
}

describe("sdk-browser event pipeline", () => {
  it("passes events through absent, empty, nonmatching, and malformed rule sets", () => {
    const event = createFrontendEvent();
    expect(applyBrowserCaptureRules({ config: null, event, currentRoute: null, now: event.occurred_at })).toEqual({
      event,
      breadcrumb: null
    });
    expect(
      applyBrowserCaptureRules({ config: createConfig([]), event, currentRoute: null, now: event.occurred_at })
    ).toEqual({ event, breadcrumb: null });
    expect(
      applyBrowserCaptureRules({
        config: createConfig([createRule("drop", { project_id: "" })]),
        event,
        currentRoute: null,
        now: event.occurred_at
      })
    ).toEqual({ event, breadcrumb: null });
    expect(
      applyBrowserCaptureRules({
        config: createConfig([createRule("drop", { matcher: { services: ["other"] } })]),
        event,
        currentRoute: null,
        now: event.occurred_at
      })
    ).toEqual({ event, breadcrumb: null });

    const throwingRule = new Proxy(createRule("drop"), {
      get(target, property, receiver) {
        if (property === "enabled") {
          throw new Error("malformed rule");
        }
        return Reflect.get(target, property, receiver) as unknown;
      }
    });
    expect(
      applyBrowserCaptureRules({
        config: createConfig([throwingRule]),
        event,
        currentRoute: null,
        now: event.occurred_at
      })
    ).toEqual({ event, breadcrumb: null });
  });

  it("drops, demotes, and context-samples matching browser events", () => {
    const event = createFrontendEvent();
    expect(
      applyBrowserCaptureRules({
        config: createConfig([createRule("drop")]),
        event,
        currentRoute: "/fallback",
        now: event.occurred_at
      })
    ).toEqual({ event: null, breadcrumb: null });

    const demoted = applyBrowserCaptureRules({
      config: createConfig([createRule("demote")]),
      event,
      currentRoute: "/fallback",
      now: event.occurred_at
    });
    expect(demoted.event).toBeNull();
    expect(demoted.breadcrumb).toMatchObject({
      route: "/fallback",
      data: {
        capture_rule_outcome: "demote",
        browser_event_kind: "resource_error",
        source_url: "https://cdn.example.com/app.js"
      }
    });

    expect(
      applyBrowserCaptureRules({
        config: createConfig([createRule("sample")]),
        event,
        currentRoute: null,
        now: event.occurred_at
      }).breadcrumb
    ).toMatchObject({ data: { capture_rule_outcome: "sampled_in" } });
  });

  it("demotes matching request context without creating an exception breadcrumb", () => {
    const frontend = createFrontendEvent();
    const request = {
      ...frontend,
      event_type: "request_event",
      payload: {
        method: "POST",
        path: "/checkout",
        query: {},
        headers: {},
        response_status: 503,
        duration_ms: 25
      }
    } as unknown as EventEnvelope;

    expect(
      applyBrowserCaptureRules({
        config: createConfig([createRule("demote")]),
        event: request,
        currentRoute: "/checkout",
        now: frontend.occurred_at
      })
    ).toEqual({ event: null, breadcrumb: null });
  });

  it("builds stable suppression keys only for supported event types", () => {
    const frontend = createFrontendEvent();
    expect(buildBrowserSuppressionKey(frontend)).toContain("checkout.ts:10:5");
    expect(buildBrowserSuppressionKey({ ...frontend, payload: { ...frontend.payload, stack: "TypeError" } })).toContain(
      '"stack_frame":null'
    );

    const log = {
      ...frontend,
      event_type: "log_event",
      payload: { level: "warning", message: "Checkout warning", attributes: { retry: true } }
    } as unknown as EventEnvelope;
    expect(buildBrowserSuppressionKey(log)).toContain("Checkout warning");

    const request = {
      ...frontend,
      event_type: "request_event",
      payload: { method: "POST", path: "/checkout", response_status: 503 }
    } as unknown as EventEnvelope;
    expect(buildBrowserSuppressionKey(request)).toContain('"response_status":503');

    const deploy = { ...frontend, event_type: "deploy_metadata", payload: { version: "1.0.0" } } as EventEnvelope;
    expect(buildBrowserSuppressionKey(deploy)).toBeNull();
  });
});
