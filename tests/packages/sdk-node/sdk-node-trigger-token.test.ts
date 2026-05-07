import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deriveProbeTriggerTokenKey, generateProbeTriggerToken } from "../../helpers/probe-trigger-token.js";
import { resolveRequestTriggerDirectives } from "../../../packages/sdk-node/src/trigger-token.js";

function createSignedToken(input: { key: string; payloadJson: string }): string {
  const payloadSegment = Buffer.from(input.payloadJson, "utf8").toString("base64url");
  const signatureSegment = createHmac("sha256", input.key).update(payloadSegment, "utf8").digest("base64url");
  return `dbundle_probe_${payloadSegment}.${signatureSegment}`;
}

const originalProbeTriggerSecret = process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];

beforeEach((): void => {
  process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = "test-probe-secret";
});

afterEach((): void => {
  if (originalProbeTriggerSecret === undefined) {
    delete process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];
  } else {
    process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = originalProbeTriggerSecret;
  }
});

describe("sdk-node trigger token resolution", () => {
  it("should resolve a valid query trigger token into a directive", (): void => {
    const projectId = "proj_123";
    const triggerToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-api",
        environment: "production",
        trigger_expires_at: "2026-03-20T00:00:00.000Z"
      }
    }).plaintext;

    const directives = resolveRequestTriggerDirectives({
      request: {
        query: { _debug_probe: triggerToken },
        headers: {}
      },
      triggerTokenKey: deriveProbeTriggerTokenKey(projectId),
      nowMs: Date.parse("2026-03-15T00:00:00.000Z")
    });

    expect(directives).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        labelPattern: "checkout.*",
        service: "checkout-api",
        environment: "production",
        expiresAt: "2026-03-20T00:00:00.000Z"
      }
    ]);
  });

  it("should prefer the trigger header and support array query values", (): void => {
    const projectId = "proj_123";
    const key = deriveProbeTriggerTokenKey(projectId);
    const headerToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "22222222-2222-4222-8222-222222222222",
        label_pattern: "payment.*",
        service: "checkout-api",
        environment: "production",
        trigger_expires_at: "2026-03-20T00:00:00.000Z"
      }
    }).plaintext;

    const directives = resolveRequestTriggerDirectives({
      request: {
        query: { _debug_probe: ["", "dbundle_probe_bad", "ignored"] },
        headers: { "x-debugbundle-probe-trigger": headerToken }
      },
      triggerTokenKey: key,
      nowMs: Date.parse("2026-03-15T00:00:00.000Z")
    });

    expect(directives).toEqual([
      {
        id: "22222222-2222-4222-8222-222222222222",
        labelPattern: "payment.*",
        service: "checkout-api",
        environment: "production",
        expiresAt: "2026-03-20T00:00:00.000Z"
      }
    ]);
  });

  it("should reject missing keys, malformed payloads, invalid signatures, and expired tokens", (): void => {
    const projectId = "proj_123";
    const key = deriveProbeTriggerTokenKey(projectId);
    const expiredToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "33333333-3333-4333-8333-333333333333",
        label_pattern: "checkout.*",
        service: "checkout-api",
        environment: "production",
        trigger_expires_at: "2026-03-14T00:00:00.000Z"
      }
    }).plaintext;

    expect(
      resolveRequestTriggerDirectives({
        request: { query: { _debug_probe: expiredToken }, headers: {} },
        triggerTokenKey: null,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).toEqual([]);

    expect(
      resolveRequestTriggerDirectives({
        request: { query: { _debug_probe: "dbundle_probe_missing_separator" }, headers: {} },
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).toEqual([]);

    const malformedPayloadToken = createSignedToken({
      key,
      payloadJson: JSON.stringify({ activation_id: 123 })
    });
    expect(
      resolveRequestTriggerDirectives({
        request: { query: { _debug_probe: malformedPayloadToken }, headers: {} },
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).toEqual([]);

    expect(
      resolveRequestTriggerDirectives({
        request: { query: { _debug_probe: "dbundle_probe_invalid.invalid" }, headers: {} },
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).toEqual([]);

    expect(
      resolveRequestTriggerDirectives({
        request: { query: { _debug_probe: expiredToken }, headers: {} },
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).toEqual([]);
  });
});