import { describe, expect, it } from "vitest";
import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";

import {
  evaluateNodeCaptureRulesForEvent,
  parseRemoteCaptureRulesPayload
} from "../../../packages/sdk-node/src/capture-rules.js";
import type { NodeCaptureRule, NodeCaptureRuleMatcher } from "../../../packages/sdk-node/src/types.js";

function createRawRule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "00000000-0000-4000-8000-000000000201",
    project_id: "proj_123",
    name: "Node capture rule",
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

function parseRule(raw: Record<string, unknown>): NodeCaptureRule {
  const [rule] = parseRemoteCaptureRulesPayload({ capture_rules: [raw] });
  if (rule === undefined) {
    throw new Error("Expected capture rule to parse.");
  }
  return rule;
}

function createBackendEvent(): EventEnvelope {
  return {
    schema_version: "2026-03-01",
    event_id: "00000000-0000-4000-8000-000000000301",
    event_type: "backend_exception",
    project_token: "dbundle_proj_test",
    sdk_name: "@debugbundle/sdk-node",
    sdk_version: "0.1.0",
    service: {
      name: "checkout-api",
      runtime: "nodejs",
      framework: "express",
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
      handled: false,
      request: {
        method: "POST",
        path: "https://api.example.com/orders/1",
        query: {},
        headers: {}
      },
      response: {
        status_code: 503,
        headers: {}
      },
      context: {}
    }
  } as unknown as EventEnvelope;
}

describe("sdk-node capture rules", () => {
  it("should parse valid remote capture rules and ignore malformed entries", (): void => {
    expect(
      parseRemoteCaptureRulesPayload({
        capture_rules: [
          {
            id: "00000000-0000-4000-8000-000000000201",
            project_id: "proj_123",
            name: "Drop noisy backend request failures",
            description: null,
            enabled: true,
            action: "drop",
            matcher: {
              event_types: ["request_event"],
              runtime: ["node"],
              request_url: { path_prefix: "/internal/health" }
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
            action: "drop"
          }
        ]
      })
    ).toEqual([
      {
        id: "00000000-0000-4000-8000-000000000201",
        project_id: "proj_123",
        name: "Drop noisy backend request failures",
        description: null,
        enabled: true,
        action: "drop",
        matcher: {
          event_types: ["request_event"],
          runtime: ["node"],
          request_url: { path_prefix: "/internal/health" }
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

  it("should evaluate matching node request rules deterministically", (): void => {
    const rules = parseRemoteCaptureRulesPayload({
      capture_rules: [
        {
          id: "00000000-0000-4000-8000-000000000202",
          project_id: "proj_123",
          name: "Sample noisy health requests",
          description: null,
          enabled: true,
          action: "sample",
          matcher: {
            event_types: ["request_event"],
            runtime: ["node"],
            request_url: { path_prefix: "/internal/health" }
          },
          sample_rate: 0,
          sample_event_class: "preserve",
          created_by_user_id: null,
          created_from_incident_id: null,
          created_from_event_id: null,
          expires_at: null,
          hit_count: 0,
          last_matched_at: null,
          created_at: "2026-05-26T10:00:00.000Z",
          updated_at: "2026-05-26T10:00:00.000Z"
        }
      ]
    });

    const event = createEventEnvelope({
      schema_version: "2026-03-01",
      event_type: "request_event",
      project_token: "dbundle_proj_test",
      sdk_name: "@debugbundle/sdk-node",
      sdk_version: "0.1.0",
      service: {
        name: "checkout-api",
        runtime: "node",
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
        method: "GET",
        path: "/internal/health/ready",
        query: {},
        headers: {},
        response_status: 200,
        duration_ms: 5
      }
    });

    expect(
      evaluateNodeCaptureRulesForEvent(rules, "proj_123", event, "2026-05-26T10:01:00.000Z")
    ).toEqual({
      rule_id: "00000000-0000-4000-8000-000000000202",
      action: "sample",
      outcome: "sampled_out",
      sample_rate: 0,
      sample_event_class: "preserve"
    });
  });

  it("should fail closed for malformed payloads and incompatible sampling fields", () => {
    expect(parseRemoteCaptureRulesPayload(null)).toEqual([]);
    expect(parseRemoteCaptureRulesPayload({ capture_rules: "invalid" })).toEqual([]);
    expect(
      parseRemoteCaptureRulesPayload({
        capture_rules: [
          null,
          createRawRule({ matcher: null }),
          createRawRule({ matcher: {} }),
          createRawRule({ action: "sample", sample_rate: null, sample_event_class: "preserve" }),
          createRawRule({ action: "drop", sample_rate: 0.5, sample_event_class: null })
        ]
      })
    ).toEqual([]);
  });

  it("should normalize the complete node matcher and optional metadata surface", () => {
    const [rule] = parseRemoteCaptureRulesPayload({
      capture_rules: [
        createRawRule({
          description: "  comprehensive  ",
          action: "sample",
          matcher: {
            event_types: ["backend_exception", "", 123],
            services: ["checkout-api", "checkout-api"],
            environments: ["production"],
            runtime: ["browser", "nodejs", "python", "php", "java", "golang", "ruby", "other"],
            first_party: false,
            error_name: "TypeError",
            message_contains: "failed",
            message_equals: "Checkout failed",
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
        services: ["checkout-api"],
        runtime: ["browser", "node", "python", "php", "java", "go", "ruby", "unknown"],
        request_url: {
          host: "api.example.com",
          host_suffix: "example.com",
          path_prefix: "/orders",
          path_equals: "/orders/1"
        },
        status_codes: [502, 503],
        status_ranges: [{ start: 500, end: 599 }],
        fingerprint: { version: "v1", value: "fingerprint" }
      }
    });
  });

  it("should evaluate every node matcher dimension and fail closed on mismatches", () => {
    const event = createBackendEvent();
    const matcher: NodeCaptureRuleMatcher = {
      event_types: ["backend_exception"],
      services: ["checkout-api"],
      environments: ["production"],
      runtime: ["node"],
      first_party: false,
      error_name: "TypeError",
      message_contains: "failed",
      message_equals: "Checkout failed",
      request_url: {
        host: "api.example.com",
        host_suffix: "example.com",
        path_prefix: "/orders",
        path_equals: "/orders/1"
      },
      status_codes: [503],
      status_ranges: [{ start: 500, end: 599 }]
    };
    const rule = parseRule(createRawRule({ matcher }));

    expect(evaluateNodeCaptureRulesForEvent([rule], "proj_123", event, "2026-05-26T10:01:00.000Z")).toMatchObject({
      action: "drop",
      outcome: "drop"
    });

    const mismatches: NodeCaptureRuleMatcher[] = [
      { ...matcher, event_types: ["log_event"] },
      { ...matcher, services: ["other"] },
      { ...matcher, environments: ["staging"] },
      { ...matcher, runtime: ["browser"] },
      { ...matcher, first_party: true },
      { ...matcher, error_name: "RangeError" },
      { ...matcher, message_equals: "Other" },
      { ...matcher, message_contains: "missing" },
      { ...matcher, request_url: { ...matcher.request_url, host: "other.example.com" } },
      { ...matcher, request_url: { ...matcher.request_url, host_suffix: "invalid.test" } },
      { ...matcher, request_url: { ...matcher.request_url, path_equals: "/other" } },
      { ...matcher, request_url: { ...matcher.request_url, path_prefix: "/other" } },
      { ...matcher, status_codes: [502] },
      { ...matcher, status_ranges: [{ start: 400, end: 499 }] },
      { ...matcher, fingerprint: { version: "v1", value: "missing" } }
    ];

    for (const candidate of mismatches) {
      expect(
        evaluateNodeCaptureRulesForEvent([{ ...rule, matcher: candidate }], "proj_123", event, "2026-05-26T10:01:00.000Z")
      ).toBeNull();
    }
  });

  it("should handle non-request contexts, URL failures, inactive rules, and every action", () => {
    const event = createBackendEvent();
    const matchingRule = parseRule(createRawRule({ matcher: { services: ["checkout-api"] } }));
    const logEvent = {
      ...event,
      event_type: "log_event",
      payload: { level: "error", message: "Checkout failed", context: {} }
    } as unknown as EventEnvelope;
    const deployEvent = {
      ...event,
      event_type: "deploy_metadata",
      payload: { version: "1.0.0" }
    } as EventEnvelope;
    const malformedUrlEvent = {
      ...event,
      payload: {
        ...(event as Extract<EventEnvelope, { event_type: "backend_exception" }>).payload,
        request: {
          ...(event as Extract<EventEnvelope, { event_type: "backend_exception" }>).payload.request,
          path: "http://["
        }
      }
    } as EventEnvelope;

    expect(evaluateNodeCaptureRulesForEvent([matchingRule], "proj_123", logEvent, "2026-05-26T10:01:00.000Z")).toMatchObject({
      action: "drop"
    });
    expect(evaluateNodeCaptureRulesForEvent([matchingRule], "proj_123", deployEvent, "2026-05-26T10:01:00.000Z")).toMatchObject({
      action: "drop"
    });
    expect(
      evaluateNodeCaptureRulesForEvent(
        [{ ...matchingRule, matcher: { request_url: { path_equals: "/" } } }],
        "proj_123",
        malformedUrlEvent,
        "2026-05-26T10:01:00.000Z"
      )
    ).toBeNull();
    expect(
      evaluateNodeCaptureRulesForEvent(
        [{ ...matchingRule, enabled: false }, { ...matchingRule, expires_at: "2026-05-01T00:00:00.000Z" }],
        "proj_123",
        event,
        "2026-05-26T10:01:00.000Z"
      )
    ).toBeNull();

    for (const [action, sampleRate, sampleEventClass, expected] of [
      ["demote", null, null, "demote"],
      ["sample", 1, "preserve", "sampled_in"],
      ["sample", 0.5, "context", null]
    ] as const) {
      const rule = parseRule(
        createRawRule({
          action,
          matcher: { services: ["checkout-api"] },
          sample_rate: sampleRate,
          sample_event_class: sampleEventClass
        })
      );
      const result = evaluateNodeCaptureRulesForEvent([rule], "proj_123", event, "2026-05-26T10:01:00.000Z");
      if (expected === null) {
        expect(["sampled_in", "sampled_out"]).toContain(result?.outcome);
      } else {
        expect(result?.outcome).toBe(expected);
      }
    }
  });

  it("should order node rules by specificity, update time, and id", () => {
    const event = createBackendEvent();
    const broad = parseRule(createRawRule({ id: "rule-z", matcher: { services: ["checkout-api"] } }));
    const specific = parseRule(
      createRawRule({
        id: "rule-specific",
        matcher: {
          event_types: ["backend_exception"],
          services: ["checkout-api"],
          environments: ["production"],
          runtime: ["node"],
          first_party: false,
          error_name: "TypeError",
          message_contains: "failed",
          message_equals: "Checkout failed",
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

    expect(evaluateNodeCaptureRulesForEvent([broad, specific], "proj_123", event, "2026-05-26T10:01:00.000Z")?.rule_id).toBe(
      "rule-z"
    );
    expect(evaluateNodeCaptureRulesForEvent([broad, newer], "proj_123", event, "2026-05-26T10:01:00.000Z")?.rule_id).toBe(
      "rule-newer"
    );
    expect(
      evaluateNodeCaptureRulesForEvent([broad, alphabetic], "proj_123", event, "2026-05-26T10:01:00.000Z")?.rule_id
    ).toBe("rule-a");
  });
});
