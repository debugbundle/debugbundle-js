import { createHmac, webcrypto } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveProbeTriggerTokenKey, generateProbeTriggerToken } from "../../helpers/probe-trigger-token.js";
import { validateBrowserTriggerToken } from "../../../packages/sdk-browser/src/trigger-token.js";

const ORIGINAL_CRYPTO = globalThis.crypto;
const originalProbeTriggerSecret = process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];

function createSignedToken(input: { key: string; payloadJson: string }): string {
  const payloadSegment = Buffer.from(input.payloadJson, "utf8").toString("base64url");
  const signatureSegment = createHmac("sha256", input.key).update(payloadSegment, "utf8").digest("base64url");
  return `dbundle_probe_${payloadSegment}.${signatureSegment}`;
}

beforeEach((): void => {
  process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = "test-probe-secret";
});

afterEach((): void => {
  if (originalProbeTriggerSecret === undefined) {
    delete process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];
  } else {
    process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = originalProbeTriggerSecret;
  }

  vi.restoreAllMocks();
  vi.stubGlobal("crypto", ORIGINAL_CRYPTO);
});

describe("sdk-browser trigger token validation", () => {
  it("should return a directive for a valid trigger token", async (): Promise<void> => {
    vi.stubGlobal("crypto", webcrypto as unknown);
    const projectId = "proj_123";
    const triggerToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        trigger_expires_at: "2026-03-20T00:00:00.000Z"
      }
    }).plaintext;

    const directive = await validateBrowserTriggerToken({
      token: triggerToken,
      triggerTokenKey: deriveProbeTriggerTokenKey(projectId),
      nowMs: Date.parse("2026-03-15T00:00:00.000Z")
    });

    expect(directive).toEqual({
      activationId: "11111111-1111-4111-8111-111111111111",
      labelPattern: "checkout.*",
      service: "checkout-web",
      environment: "production",
      expiresAt: "2026-03-20T00:00:00.000Z",
      triggerExpiresAt: "2026-03-20T00:00:00.000Z"
    });
  });

  it("should reject tokens when Web Crypto is unavailable", async (): Promise<void> => {
    vi.stubGlobal("crypto", { randomUUID: webcrypto.randomUUID.bind(webcrypto) } as unknown);
    const projectId = "proj_123";
    const triggerToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        trigger_expires_at: "2026-03-20T00:00:00.000Z"
      }
    }).plaintext;

    await expect(
      validateBrowserTriggerToken({
        token: triggerToken,
        triggerTokenKey: deriveProbeTriggerTokenKey(projectId),
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();
  });

  it("should validate trigger token signatures through subtle.verify", async (): Promise<void> => {
    const projectId = "proj_123";
    const triggerTokenKey = deriveProbeTriggerTokenKey(projectId);
    const triggerToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        trigger_expires_at: "2026-03-20T00:00:00.000Z"
      }
    }).plaintext;

    vi.stubGlobal(
      "crypto",
      {
        subtle: {
          importKey: webcrypto.subtle.importKey.bind(webcrypto.subtle),
          verify: webcrypto.subtle.verify.bind(webcrypto.subtle)
        }
      } as unknown
    );

    await expect(
      validateBrowserTriggerToken({
        token: triggerToken,
        triggerTokenKey,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toEqual({
      activationId: "11111111-1111-4111-8111-111111111111",
      labelPattern: "checkout.*",
      service: "checkout-web",
      environment: "production",
      expiresAt: "2026-03-20T00:00:00.000Z",
      triggerExpiresAt: "2026-03-20T00:00:00.000Z"
    });
  });

  it("should reject malformed, invalid, and expired tokens", async (): Promise<void> => {
    vi.stubGlobal("crypto", webcrypto as unknown);
    const projectId = "proj_123";
    const key = deriveProbeTriggerTokenKey(projectId);

    await expect(
      validateBrowserTriggerToken({
        token: "dbundle_probe_missing_separator",
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();

    await expect(
      validateBrowserTriggerToken({
        token: "dbundle_probe_invalid.invalid",
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();

    const malformedPayloadToken = createSignedToken({
      key,
      payloadJson: JSON.stringify({ activation_id: 123 })
    });
    await expect(
      validateBrowserTriggerToken({
        token: malformedPayloadToken,
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();

    const invalidJsonToken = createSignedToken({
      key,
      payloadJson: "not-json"
    });
    await expect(
      validateBrowserTriggerToken({
        token: invalidJsonToken,
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();

    const invalidDateToken = createSignedToken({
      key,
      payloadJson: JSON.stringify({
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        trigger_expires_at: "not-a-date"
      })
    });
    await expect(
      validateBrowserTriggerToken({
        token: invalidDateToken,
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();

    const expiredToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        trigger_expires_at: "2026-03-14T00:00:00.000Z"
      }
    }).plaintext;
    await expect(
      validateBrowserTriggerToken({
        token: expiredToken,
        triggerTokenKey: key,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();
  });

  it("should reject tokens with a missing key or wrong prefix", async (): Promise<void> => {
    vi.stubGlobal("crypto", webcrypto as unknown);
    const token = "dbundle_probe_test";

    await expect(
      validateBrowserTriggerToken({
        token,
        triggerTokenKey: null,
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();

    await expect(
      validateBrowserTriggerToken({
        token: "not_a_probe_token",
        triggerTokenKey: "key",
        nowMs: Date.parse("2026-03-15T00:00:00.000Z")
      })
    ).resolves.toBeNull();
  });
});