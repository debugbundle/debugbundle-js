import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";

import {
  evaluateBrowserCaptureRulesForEvent,
  parseRemoteCaptureRulesPayload
} from "../../../packages/sdk-browser/src/capture-rules.js";
import type {
  BrowserCaptureRule,
  BrowserCaptureRuleMatcher
} from "../../../packages/sdk-browser/src/types.js";

function createRawRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000101",
    project_id: "proj_123",
    name: "Browser capture rule",
    description: null,
    enabled: true,
    action: "drop",
    matcher: { services: ["checkout-web"] },
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

function parseRule(raw: Record<string, unknown>): BrowserCaptureRule {
  const [rule] = parseRemoteCaptureRulesPayload({ capture_rules: [raw] });
  if (rule === undefined) {
    throw new Error("Expected capture rule to parse.");
  }
  return rule;
}

function createFrontendExceptionEvent(
  userAgent: string | null = "Mozilla/5.0 Googlebot/2.1"
): EventEnvelope {
  return {
    schema_version: "2026-03-01",
    event_id: "00000000-0000-4000-8000-000000000301",
    event_type: "frontend_exception",
    project_token: "dbundle_proj_test",
    sdk_name: "@debugbundle/sdk-browser",
    sdk_version: "0.1.0",
    service: {
      name: "checkout-web",
      runtime: "browser",
      framework: "react",
      environment: "production"
    },
    occurred_at: "2026-05-26T10:00:00.000Z",
    correlation: {
      request_id: null,
      trace_id: null,
      session_id: null,
      user_id_hash: null
    },
    payload: {
      name: "TypeError",
      message: "Checkout failed",
      stack: null,
      route: "/checkout",
      device: userAgent === null ? {} : { user_agent: userAgent },
      browser_event: {
        kind: "resource_error",
        opaque: true,
        target: {
          source_url: "https://cdn.example.com/assets/app.js"
        }
      }
    }
  } as unknown as EventEnvelope;
}

function createRequestEvent(path = "https://api.example.com/orders/1"): EventEnvelope {
  const event = createFrontendExceptionEvent();
  return {
    ...event,
    event_type: "request_event",
    payload: {
      method: "POST",
      path,
      query: {},
      headers: {},
      response_status: 503,
      duration_ms: 25,
      device: { user_agent: "Mozilla/5.0" }
    }
  } as unknown as EventEnvelope;
}

describe("sdk-browser capture rules", () => {
  it("should fail closed for malformed payloads and incompatible rule fields", () => {
    expect(parseRemoteCaptureRulesPayload(null)).toEqual([]);
    expect(parseRemoteCaptureRulesPayload({ capture_rules: "invalid" })).toEqual([]);
    expect(
      parseRemoteCaptureRulesPayload({
        capture_rules: [
          null,
          createRawRule({ matcher: null }),
          createRawRule({ matcher: {} }),
          createRawRule({
            matcher: { browser_event_kind: "resource_error" }
          }),
          createRawRule({ action: "sample", sample_rate: null, sample_event_class: "preserve" }),
          createRawRule({ action: "drop", sample_rate: 0.5, sample_event_class: null })
        ]
      })
    ).toEqual([]);
  });

  it("should normalize the complete browser matcher and optional metadata surface", () => {
    const [rule] = parseRemoteCaptureRulesPayload({
      capture_rules: [
        createRawRule({
          description: "  comprehensive  ",
          action: "sample",
          matcher: {
            event_types: ["frontend_exception", "", 123],
            services: ["checkout-web", "checkout-web"],
            environments: ["production"],
            runtime: ["browser", "nodejs", "python", "php", "java", "golang", "ruby", "other"],
            first_party: false,
            error_name: "TypeError",
            message_contains: "failed",
            message_equals: "Checkout failed",
            browser_event_kind: "resource_error",
            browser_event_opaque: true,
            client_kind: "bot",
            bot_family: "Googlebot",
            resource_url: {
              host: "CDN.EXAMPLE.COM",
              host_suffix: "EXAMPLE.COM",
              path_prefix: "assets",
              path_equals: "/assets/app.js"
            },
            request_url: {
              host: "API.EXAMPLE.COM",
              host_suffix: "EXAMPLE.COM",
              path_prefix: "orders",
              path_equals: "/orders/1"
            },
            status_codes: [503, 503, 502, "invalid"],
            status_ranges: [{ start: 500, end: 599 }, { start: 600, end: 500 }, null],
            fingerprint: { version: "v1", value: "fingerprint" }
          },
          sample_rate: 0.5,
          sample_event_class: "context",
          created_by_user_id: " usr_owner ",
          created_from_incident_id: "inc_123",
          created_from_event_id: "evt_123",
          expires_at: "2026-06-01T00:00:00.000Z",
          hit_count: 7,
          last_matched_at: "2026-05-26T09:00:00.000Z"
        })
      ]
    });

    expect(rule).toMatchObject({
      description: "comprehensive",
      sample_rate: 0.5,
      sample_event_class: "context",
      matcher: {
        services: ["checkout-web"],
        runtime: ["browser", "node", "python", "php", "java", "go", "ruby", "unknown"],
        resource_url: {
          host: "cdn.example.com",
          host_suffix: "example.com",
          path_prefix: "/assets",
          path_equals: "/assets/app.js"
        },
        status_codes: [502, 503],
        status_ranges: [{ start: 500, end: 599 }],
        fingerprint: { version: "v1", value: "fingerprint" }
      }
    });
  });

  it("should evaluate every frontend matcher dimension and fail closed on mismatches", () => {
    const event = createFrontendExceptionEvent();
    const matcher: BrowserCaptureRuleMatcher = {
      event_types: ["frontend_exception"],
      services: ["checkout-web"],
      environments: ["production"],
      runtime: ["browser"],
      first_party: false,
      error_name: "TypeError",
      message_contains: "failed",
      message_equals: "Checkout failed",
      browser_event_kind: "resource_error",
      browser_event_opaque: true,
      client_kind: "bot",
      bot_family: "Googlebot",
      resource_url: {
        host: "cdn.example.com",
        host_suffix: "example.com",
        path_prefix: "/assets",
        path_equals: "/assets/app.js"
      }
    };
    const rule = parseRule(createRawRule({ matcher }));

    expect(evaluateBrowserCaptureRulesForEvent([rule], "proj_123", event, "2026-05-26T10:01:00.000Z")).toMatchObject({
      action: "drop",
      outcome: "drop"
    });

    const mismatches: BrowserCaptureRuleMatcher[] = [
      { ...matcher, event_types: ["log_event"] },
      { ...matcher, services: ["other"] },
      { ...matcher, environments: ["staging"] },
      { ...matcher, runtime: ["node"] },
      { ...matcher, first_party: true },
      { ...matcher, error_name: "RangeError" },
      { ...matcher, message_equals: "Other" },
      { ...matcher, message_contains: "missing" },
      { ...matcher, browser_event_kind: "window_error" },
      { ...matcher, browser_event_opaque: false },
      { ...matcher, client_kind: "human" },
      { ...matcher, bot_family: "Bingbot" },
      { ...matcher, resource_url: { ...matcher.resource_url, host: "other.example.com" } },
      { ...matcher, resource_url: { ...matcher.resource_url, host_suffix: "invalid.test" } },
      { ...matcher, resource_url: { ...matcher.resource_url, path_equals: "/other" } },
      { ...matcher, resource_url: { ...matcher.resource_url, path_prefix: "/other" } },
      { ...matcher, fingerprint: { version: "v1", value: "missing" } }
    ];

    for (const candidate of mismatches) {
      expect(
        evaluateBrowserCaptureRulesForEvent(
          [{ ...rule, matcher: candidate }],
          "proj_123",
          event,
          "2026-05-26T10:01:00.000Z"
        )
      ).toBeNull();
    }
  });

  it("should evaluate request URLs, statuses, breadcrumbs, logs, and client classes", () => {
    const requestEvent = createRequestEvent();
    const requestRule = parseRule(
      createRawRule({
        matcher: {
          first_party: false,
          request_url: {
            host: "api.example.com",
            host_suffix: "example.com",
            path_prefix: "/orders",
            path_equals: "/orders/1"
          },
          status_codes: [503],
          status_ranges: [{ start: 500, end: 599 }]
        }
      })
    );
    expect(
      evaluateBrowserCaptureRulesForEvent([requestRule], "proj_123", requestEvent, "2026-05-26T10:01:00.000Z")
    ).toMatchObject({ action: "drop" });

    for (const matcher of [
      { ...requestRule.matcher, request_url: { host: "other.example.com" } },
      { ...requestRule.matcher, status_codes: [502] },
      { ...requestRule.matcher, status_ranges: [{ start: 400, end: 499 }] }
    ]) {
      expect(
        evaluateBrowserCaptureRulesForEvent(
          [{ ...requestRule, matcher }],
          "proj_123",
          requestEvent,
          "2026-05-26T10:01:00.000Z"
        )
      ).toBeNull();
    }

    const breadcrumbEvent = {
      ...requestEvent,
      event_type: "frontend_breadcrumb",
      payload: {
        breadcrumb_type: "network_request",
        message: "POST /orders",
        data: {
          url: "/orders/1?retry=1",
          status_code: 503
        }
      }
    } as unknown as EventEnvelope;
    const localRequestRule = parseRule(
      createRawRule({
        matcher: {
          first_party: true,
          request_url: { path_equals: "/orders/1" },
          status_codes: [503]
        }
      })
    );
    expect(
      evaluateBrowserCaptureRulesForEvent(
        [localRequestRule],
        "proj_123",
        breadcrumbEvent,
        "2026-05-26T10:01:00.000Z"
      )
    ).toMatchObject({ action: "drop" });

    const logEvent = {
      ...requestEvent,
      event_type: "log_event",
      payload: { level: "warning", message: "Checkout warning", attributes: {} }
    } as unknown as EventEnvelope;
    const logRule = parseRule(createRawRule({ matcher: { message_contains: "warning" } }));
    expect(evaluateBrowserCaptureRulesForEvent([logRule], "proj_123", logEvent, "2026-05-26T10:01:00.000Z")).toMatchObject({
      action: "drop"
    });

    for (const [userAgent, matcher] of [
      ["custom crawler", { client_kind: "bot", bot_family: "OtherBot" }],
      ["Mozilla/5.0 Safari/605.1", { client_kind: "human" }],
      [null, { client_kind: "unknown" }]
    ] as const) {
      const clientRule = parseRule(createRawRule({ matcher }));
      expect(
        evaluateBrowserCaptureRulesForEvent(
          [clientRule],
          "proj_123",
          createFrontendExceptionEvent(userAgent),
          "2026-05-26T10:01:00.000Z"
        )
      ).toMatchObject({ action: "drop" });
    }
  });

  it("should handle URL failures, alternate frontend metadata, inactive rules, and every action", () => {
    const event = createFrontendExceptionEvent("Mozilla/5.0");
    const baseRule = parseRule(createRawRule({ matcher: { services: ["checkout-web"] } }));
    const invalidUrlEvent = {
      ...event,
      payload: {
        ...(event as Extract<EventEnvelope, { event_type: "frontend_exception" }>).payload,
        browser_event: {
          kind: "window_error",
          file_name: "not-an-absolute-url"
        }
      }
    } as unknown as EventEnvelope;
    const plainEvent = {
      ...event,
      event_type: "deploy_metadata",
      payload: { version: "1.0.0" }
    } as EventEnvelope;

    expect(
      evaluateBrowserCaptureRulesForEvent(
        [{ ...baseRule, matcher: { browser_event_kind: "window_error" } }],
        "proj_123",
        invalidUrlEvent,
        "2026-05-26T10:01:00.000Z"
      )
    ).toMatchObject({ action: "drop" });
    expect(evaluateBrowserCaptureRulesForEvent([baseRule], "proj_123", plainEvent, "2026-05-26T10:01:00.000Z")).toMatchObject({
      action: "drop"
    });
    expect(
      evaluateBrowserCaptureRulesForEvent(
        [{ ...baseRule, enabled: false }, { ...baseRule, expires_at: "2026-05-01T00:00:00.000Z" }],
        "proj_123",
        event,
        "2026-05-26T10:01:00.000Z"
      )
    ).toBeNull();

    for (const [action, sampleRate, sampleEventClass, expected] of [
      ["demote", null, null, "demote"],
      ["sample", 0, "preserve", "sampled_out"],
      ["sample", 1, "preserve", "sampled_in"],
      ["sample", 0.5, "context", null]
    ] as const) {
      const rule = parseRule(
        createRawRule({
          action,
          sample_rate: sampleRate,
          sample_event_class: sampleEventClass
        })
      );
      const result = evaluateBrowserCaptureRulesForEvent([rule], "proj_123", event, "2026-05-26T10:01:00.000Z");
      if (expected === null) {
        expect(["sampled_in", "sampled_out"]).toContain(result?.outcome);
      } else {
        expect(result?.outcome).toBe(expected);
      }
    }
  });

  it("should order browser rules by specificity, update time, and id", () => {
    const event = createFrontendExceptionEvent();
    const broad = parseRule(createRawRule({ id: "rule-z", matcher: { services: ["checkout-web"] } }));
    const specific = parseRule(
      createRawRule({
        id: "rule-specific",
        matcher: {
          event_types: ["frontend_exception"],
          services: ["checkout-web"],
          environments: ["production"],
          runtime: ["browser"],
          first_party: false,
          error_name: "TypeError",
          message_contains: "failed",
          message_equals: "Checkout failed",
          browser_event_kind: "resource_error",
          browser_event_opaque: true,
          client_kind: "bot",
          bot_family: "Googlebot",
          resource_url: {
            host: "cdn.example.com",
            host_suffix: "example.com",
            path_prefix: "/assets",
            path_equals: "/assets/app.js"
          },
          request_url: {
            host: "api.example.com",
            host_suffix: "example.com",
            path_prefix: "/orders",
            path_equals: "/orders/1"
          },
          status_codes: [503],
          status_ranges: [{ start: 500, end: 599 }],
          fingerprint: { version: "v1", value: "unavailable" }
        }
      })
    );
    const newer = { ...broad, id: "rule-newer", updated_at: "2026-05-27T10:00:00.000Z" };
    const alphabetic = { ...broad, id: "rule-a" };

    expect(
      evaluateBrowserCaptureRulesForEvent([broad, specific], "proj_123", event, "2026-05-26T10:01:00.000Z")?.rule_id
    ).toBe("rule-z");
    expect(
      evaluateBrowserCaptureRulesForEvent([broad, newer], "proj_123", event, "2026-05-26T10:01:00.000Z")?.rule_id
    ).toBe("rule-newer");
    expect(
      evaluateBrowserCaptureRulesForEvent([broad, alphabetic], "proj_123", event, "2026-05-26T10:01:00.000Z")?.rule_id
    ).toBe("rule-a");
  });
});
