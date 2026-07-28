import { describe, expect, it, vi } from "vitest";
import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";

import {
  applyBrowserBeforeSend,
  type BrowserBeforeSendHook
} from "../../../packages/sdk-browser/src/before-send.js";
import {
  applyNodeBeforeSend,
  type NodeBeforeSendHook
} from "../../../packages/sdk-node/src/before-send.js";

function createLogEvent(): EventEnvelope {
  return createEventEnvelope({
    schema_version: "2026-03-01",
    event_type: "log_event",
    project_token: "dbundle_proj_test",
    sdk_name: "@debugbundle/sdk-browser",
    sdk_version: "0.1.0",
    service: {
      name: "checkout-web",
      runtime: "browser",
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
      level: "error",
      message: "Checkout failed",
      attributes: {}
    }
  });
}

describe("beforeSend direct safety", () => {
  it("keeps browser events for absent, undefined, invalid, and throwing hooks", () => {
    const event = createLogEvent();
    const undefinedHook = (() => undefined) as unknown as BrowserBeforeSendHook;
    const invalidHook = (() => ({ ...event, event_id: "invalid" })) as BrowserBeforeSendHook;

    expect(applyBrowserBeforeSend(event, undefined)).toBe(event);
    expect(applyBrowserBeforeSend(event, undefinedHook)).toBe(event);
    expect(applyBrowserBeforeSend(event, invalidHook)).toBe(event);
    expect(
      applyBrowserBeforeSend(event, () => {
        throw new Error("failed");
      })
    ).toBe(event);
    expect(applyBrowserBeforeSend(event, () => null)).toBeNull();
  });

  it("diagnoses invalid and throwing node hooks while preserving the original", () => {
    const event = createLogEvent();
    const emitDiagnostic = vi.fn();
    const undefinedHook = (() => undefined) as unknown as NodeBeforeSendHook;
    const invalidHook = (() => ({ ...event, event_id: "invalid" })) as NodeBeforeSendHook;

    expect(applyNodeBeforeSend(event, undefined, emitDiagnostic)).toBe(event);
    expect(applyNodeBeforeSend(event, undefinedHook, emitDiagnostic)).toBe(event);
    expect(applyNodeBeforeSend(event, invalidHook, emitDiagnostic)).toBe(event);
    expect(
      applyNodeBeforeSend(
        event,
        () => {
          // A JavaScript consumer can throw any value; the SDK must stringify it safely.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw "failed";
        },
        emitDiagnostic
      )
    ).toBe(event);
    expect(applyNodeBeforeSend(event, () => null, emitDiagnostic)).toBeNull();
    expect(emitDiagnostic).toHaveBeenCalledWith(
      "before_send_invalid_event",
      "sdk-node beforeSend returned an invalid event"
    );
    expect(emitDiagnostic).toHaveBeenCalledWith(
      "before_send_failed",
      "sdk-node beforeSend hook failed",
      { error: "failed" }
    );
  });
});
