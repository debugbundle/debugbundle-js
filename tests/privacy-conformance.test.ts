import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sanitizeTelemetry, type JsonValue } from "@debugbundle/redaction";
import { protectNodeEvent } from "../packages/sdk-node/src/privacy.js";
import { protectBrowserEvent } from "../packages/sdk-browser/src/privacy.js";
import { createDebugBundleBrowserSdk } from "../packages/sdk-browser/src/index.js";
import { DebugBundleNodeSdk } from "../packages/sdk-node/src/core.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

const corpus = JSON.parse(readFileSync(new URL("./fixtures/privacy-conformance.json", import.meta.url), "utf8")) as {
  policy: string;
  cases: Array<{ id: string; input: JsonValue; expected: JsonValue }>;
  exact_key_cases: Array<{
    id: string;
    additional_keys?: string[];
    exact_keys?: string[];
    input: JsonValue;
    expected: JsonValue;
  }>;
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

  for (const fixture of corpus.exact_key_cases) {
    it(`sanitizes exact-key case ${fixture.id}`, () => {
      const options = {
        ...(fixture.additional_keys === undefined ? {} : { additionalKeys: fixture.additional_keys }),
        ...(fixture.exact_keys === undefined ? {} : { exactKeys: fixture.exact_keys })
      };
      const result = sanitizeTelemetry(fixture.input, options);
      expect(result).toMatchObject({ ok: true, value: fixture.expected });
      if (result.ok) {
        expect(sanitizeTelemetry(result.value, options)).toMatchObject({ ok: true, value: result.value });
      }
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
    expect(
      protect(
        event,
        Array.from({ length: 65 }, (_, index) => `broad_${index}`),
        Array.from({ length: 64 }, (_, index) => `exact_${index}`)
      )
    ).toBeNull();
    expect(protect({ ...event, payload: { ...event.payload, message: "" } }, [])).toBeNull();
  });

  it("preserves validated closed protocol structures under broad redactFields while still redacting application data", () => {
    const failureRef = "22222222-2222-4222-8222-222222222222";
    const pageId = "33333333-3333-4333-8333-333333333333";
    const frontendEvent: EventEnvelope = {
      schema_version: "2026-03-01",
      event_id: "44444444-4444-4444-8444-444444444444",
      event_type: "frontend_exception",
      sdk_name: "@debugbundle/sdk-browser",
      sdk_version: "2.1.0",
      service: { name: "web", runtime: "browser", framework: null, environment: "production" },
      occurred_at: "2026-11-24T00:00:00.000Z",
      correlation: { request_id: null, trace_id: null, session_id: "sess-123", user_id_hash: null },
      payload: {
        name: "ResourceLoadError",
        message: "Script failed to load",
        stack: "ResourceLoadError: Script failed to load",
        route: "/checkout",
        browser: { name: "Chrome", version: "130" },
        browser_event: {
          kind: "resource_error",
          message: "Failed with tag=SECRET_IN_MSG",
          file_name: "https://cdn.example.com/assets/app.js?token=SECRET_TOKEN&tag=SECRET_TAG",
          line_number: 1,
          column_number: 1,
          target: {
            tag_name: "script",
            source_url: "https://cdn.example.com/assets/widget.js?tag=SECRET_QUERY",
            attributes: {
              rel: "preload",
              as: "script",
              type: "text/javascript",
              async: true
            }
          },
          page: {
            url: "https://app.example.com/checkout?tag=SECRET_PAGE",
            referrer: null,
            ready_state: "complete",
            visibility_state: "visible"
          },
          opaque: true
        },
        rejection_reason: {
          kind: "error",
          name: "ChunkLoadError",
          message: "Rejected reason=SECRET_REASON",
          preview: "Authorization: Bearer SECRET_BEARER"
        },
        exception_evidence: {
          version: 1,
          runtime: "browser",
          root_id: 0,
          nodes: [
            {
              id: 0,
              name: "ChunkLoadError",
              message: "Failed to load chunk",
              stack: "ChunkLoadError\n    at load (https://cdn.example.com/app.js?token=SECRET:1:2)",
              trace_origin: "capture",
              parsing_status: "parsed",
              frames: [
                {
                  function: "load",
                  file: "https://cdn.example.com/app.js?token=SECRET",
                  line: 1,
                  column: 2,
                  classification: "application"
                }
              ],
              relationships: []
            }
          ],
          truncated: false,
          unavailable_reason: null
        }
      },
      context: {
        evidence_reference: {
          version: 1,
          failure_ref: failureRef,
          scope: { kind: "page", page_id: pageId }
        },
        evidence_limits: {
          version: 1,
          execution: "unsupported"
        },
        payout: {
          tag: "SECRET_PAYOUT_TAG",
          reference: "SECRET_PAYOUT_REF",
          reason: "SECRET_PAYOUT_REASON",
          file: "SECRET_PAYOUT_FILE"
        }
      }
    };

    const result = protect(frontendEvent, ["tag", "reference", "reason", "file"]);
    expect(result).not.toBeNull();
    if (result === null || result.event_type !== "frontend_exception") return;

    // Closed SDK protocol structures survive broad custom redactFields.
    expect(result.payload.browser_event?.target?.tag_name).toBe("script");
    expect(result.payload.browser_event?.target?.source_url).toBe(
      "https://cdn.example.com/assets/widget.js?tag=%5BREDACTED%5D"
    );
    expect(result.payload.browser_event?.message).toBe("Failed with tag=[REDACTED]");
    expect(result.payload.browser_event?.file_name).toBe(
      "https://cdn.example.com/assets/app.js?token=%5BREDACTED%5D&tag=%5BREDACTED%5D"
    );
    expect(result.payload.rejection_reason).toEqual({
      kind: "error",
      name: "ChunkLoadError",
      message: "Rejected reason=[REDACTED]",
      preview: "Authorization: [REDACTED]"
    });
    expect(result.payload.exception_evidence?.unavailable_reason).toBeNull();
    expect(result.payload.exception_evidence?.nodes[0]?.frames[0]?.file).toBe("https://cdn.example.com/app.js");
    expect(result.context?.["evidence_reference"]).toEqual({
      version: 1,
      failure_ref: failureRef,
      scope: { kind: "page", page_id: pageId }
    });
    expect(result.context?.["evidence_limits"]).toEqual({
      version: 1,
      execution: "unsupported"
    });

    // Application fields still honor broad custom redactFields.
    expect(result.context?.["payout"]).toEqual({
      tag: "[REDACTED]",
      reference: "[REDACTED]",
      reason: "[REDACTED]",
      file: "[REDACTED]"
    });

    // No secret value escapes anywhere in the serialized output.
    const serialized = JSON.stringify(result);
    for (const leaked of [
      "SECRET_IN_MSG",
      "SECRET_TOKEN",
      "SECRET_TAG",
      "SECRET_QUERY",
      "SECRET_PAGE",
      "SECRET_REASON",
      "SECRET_BEARER",
      "SECRET_PAYOUT_TAG",
      "SECRET_PAYOUT_REF",
      "SECRET_PAYOUT_REASON",
      "SECRET_PAYOUT_FILE"
    ]) {
      expect(serialized).not.toContain(leaked);
    }
  });

  it("supports exactKeys without redacting compound siblings and preserves caller redactions", () => {
    const exactEvent: EventEnvelope = {
      ...event,
      context: {
        payout: { tag: "SECRET_TAG", tag_name: "script", tagName: "link" }
      }
    };
    const result = protect(exactEvent, [], ["tag"]);
    expect(result).toMatchObject({
      context: {
        payout: { tag: "[REDACTED]", tag_name: "script", tagName: "link" }
      }
    });

    const redactedTagEvent: EventEnvelope = {
      schema_version: "2026-03-01",
      event_id: "55555555-5555-4555-8555-555555555555",
      event_type: "frontend_exception",
      sdk_name: "@debugbundle/sdk-browser",
      sdk_version: "2.1.0",
      service: { name: "web", runtime: "browser", framework: null, environment: "production" },
      occurred_at: "2026-11-24T00:00:00.000Z",
      payload: {
        name: "ResourceLoadError",
        message: "Failed",
        stack: "ResourceLoadError: Failed",
        browser: { name: "Chrome", version: "130" },
        browser_event: {
          kind: "resource_error",
          message: null,
          file_name: null,
          line_number: null,
          column_number: null,
          target: { tag_name: "[REDACTED]", source_url: "https://cdn.example.com/a.js" },
          opaque: true
        }
      }
    };
    const preservedHookRedaction = protect(redactedTagEvent, ["tag"]);
    expect(preservedHookRedaction?.event_type === "frontend_exception" && preservedHookRedaction.payload.browser_event?.target?.tag_name).toBe("[REDACTED]");
  });

  it("fails closed on hostile getters inside protocol blocks without invoking them", () => {
    let called = 0;
    const hostileTarget = Object.defineProperty({}, "tag_name", {
      enumerable: true,
      get() {
        called += 1;
        return "script";
      }
    });
    const hostileEvent = {
      schema_version: "2026-03-01",
      event_id: "66666666-6666-4666-8666-666666666666",
      event_type: "frontend_exception",
      sdk_name: "@debugbundle/sdk-browser",
      sdk_version: "2.1.0",
      service: { name: "web", runtime: "browser", framework: null, environment: "production" },
      occurred_at: "2026-11-24T00:00:00.000Z",
      payload: {
        name: "ResourceLoadError",
        message: "Failed",
        stack: "ResourceLoadError: Failed",
        browser: { name: "Chrome", version: "130" },
        browser_event: {
          kind: "resource_error",
          message: null,
          file_name: null,
          line_number: null,
          column_number: null,
          target: hostileTarget,
          opaque: true
        }
      }
    } as unknown as EventEnvelope;
    expect(protect(hostileEvent, ["tag"])).toBeNull();
    expect(called).toBe(0);
  });
});

describe("SDK init redactExactFields end-to-end", () => {
  it("redacts exact private fields in BrowserSdk while preserving tag_name and sibling fields", async () => {
    const sent: unknown[] = [];
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "web",
      environment: "production",
      logLevel: "error",
      redactExactFields: ["tag"],
      transport: async (req) => {
        sent.push(...req.events);
        return { status: 202, body: { accepted: req.events.length, rejected: 0, errors: [] } };
      }
    });

    sdk.setContext("payout", { tag: "SECRET_PAYOUT_TAG", tag_name: "script" });
    sdk.captureLog("failed tag=SECRET_MSG_TAG tag_name=script", "error", {
      tag: "SECRET_LOG_TAG",
      tag_name: "script",
      url: "https://example.test/api?tag=SECRET_QUERY&tag_name=script"
    });
    await sdk.flush();
    sdk.dispose();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_type: "log_event",
      payload: {
        message: "failed tag=[REDACTED] tag_name=script",
        attributes: {
          payout: { tag: "[REDACTED]", tag_name: "script" },
          tag: "[REDACTED]",
          tag_name: "script",
          url: "https://example.test/api?tag=%5BREDACTED%5D&tag_name=script"
        }
      }
    });
    const serialized = JSON.stringify(sent[0]);
    expect(serialized).not.toContain("SECRET_PAYOUT_TAG");
    expect(serialized).not.toContain("SECRET_MSG_TAG");
    expect(serialized).not.toContain("SECRET_LOG_TAG");
    expect(serialized).not.toContain("SECRET_QUERY");
  });

  it("redacts exact private fields in DebugBundleNodeSdk while preserving sibling fields", async () => {
    const sent: EventEnvelope[] = [];
    const sdk = new DebugBundleNodeSdk();
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "api",
      environment: "production",
      logLevel: "error",
      redactExactFields: ["tag"],
      transport: async (req) => {
        sent.push(...req.events);
        return { status: 202, body: { accepted: req.events.length, rejected: 0, errors: [] } };
      }
    });

    sdk.setContext("payout", { tag: "SECRET_PAYOUT_TAG", tag_name: "script" });
    sdk.captureLog("failed tag=SECRET_MSG_TAG tag_name=script", "error", {
      tag: "SECRET_LOG_TAG",
      tag_name: "script"
    });
    await sdk.flush();
    sdk.dispose();

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      event_type: "log_event",
      payload: {
        message: "failed tag=[REDACTED] tag_name=script",
        attributes: {
          context: { payout: { tag: "[REDACTED]", tag_name: "script" } },
          tag: "[REDACTED]",
          tag_name: "script"
        }
      }
    });
  });
});
