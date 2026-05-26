import { describe, expect, it } from "vitest";
import { createEventEnvelope } from "@debugbundle/shared-types";

import {
  evaluateNodeCaptureRulesForEvent,
  parseRemoteCaptureRulesPayload
} from "../../../packages/sdk-node/src/capture-rules.js";

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
});
