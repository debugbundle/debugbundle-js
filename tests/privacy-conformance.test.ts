import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeTelemetry, type JsonValue } from "@debugbundle/redaction";
import { protectNodeEvent } from "../packages/sdk-node/src/privacy.js";
import { protectBrowserEvent } from "../packages/sdk-browser/src/privacy.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/privacy-conformance.json", import.meta.url), "utf8")) as {
  policy: string;
  cases: Array<{ id: string; input: JsonValue; expected: JsonValue }>;
};

describe("portable telemetry privacy policy", () => {
  it("pins the native fixture copy to the protected policy", () => {
    expect(corpus.policy).toBe("telemetry-privacy-v1");
  });

  for (const fixture of corpus.cases) {
    it(`sanitizes ${fixture.id}`, () => {
      expect(sanitizeTelemetry(fixture.input)).toMatchObject({ ok: true, value: fixture.expected });
    });
  }
});

describe.each([
  ["Node", protectNodeEvent],
  ["browser", protectBrowserEvent]
])("%s event privacy", (_name, protect) => {
  const event: EventEnvelope = {
    schema_version: "1",
    event_id: "11111111-1111-4111-8111-111111111111",
    event_type: "log_event",
    sdk_name: "@debugbundle/sdk-node",
    sdk_version: "2.0.0",
    service: { name: "checkout", environment: "test" },
    occurred_at: "2026-09-21T00:00:00.000Z",
    payload: { level: "error", message: "Authorization: Bearer SESSION_SECRET", attributes: {} },
    context: { privateKey: "CONTEXT_SECRET" }
  };

  it("protects payload and context while retaining a valid envelope", () => {
    const result = protect(event, []);
    expect(result).toMatchObject({
      event_id: event.event_id,
      payload: { message: "Authorization: [REDACTED]" },
      context: { privateKey: "[REDACTED]" }
    });
    expect(JSON.stringify(result)).not.toContain("SESSION_SECRET");
    expect(JSON.stringify(result)).not.toContain("CONTEXT_SECRET");
  });

  it("rejects credential-bearing identities while preserving safe correlation", () => {
    expect(protect({ ...event, correlation: { request_id: null, trace_id: "dbundle_proj_SYNTHETIC_SECRET", session_id: null, user_id_hash: null } }, [])).toBeNull();
    expect(protect({ ...event, sdk_version: "password=SYNTHETIC_SECRET" }, [])).toBeNull();
    expect(protect({ ...event, correlation: { request_id: null, trace_id: null, session_id: "session-123", user_id_hash: null } }, [])).toMatchObject({
      correlation: { session_id: "session-123" }
    });
  });

  it("accepts an absent context without adding one", () => {
    const withoutContext = { ...event };
    delete withoutContext.context;
    expect(protect(withoutContext, [])).not.toHaveProperty("context");
  });

  it("withholds unsafe options and invalid sanitized envelopes", () => {
    expect(protect(event, Array.from({ length: 129 }, (_, index) => `key_${index}`))).toBeNull();
    expect(protect({ ...event, payload: { ...event.payload, message: "" } }, [])).toBeNull();
  });
});
