import { describe, expect, it, vi } from "vitest";
import { createSdk } from "../../helpers/sdk-browser-fixtures.js";
import type { DebugBundleBrowserTransportRequest } from "../../../packages/sdk-browser/src/types.js";
import type { BrowserAnalyticsController } from "../../../packages/sdk-browser/src/analytics.js";

const analytics = {
  enabled: true,
  privacyMode: "custom" as const,
  trackSessions: false,
  trackPageViews: false
};

function sentNames(transport: ReturnType<typeof vi.fn>): string[] {
  return transport.mock.calls
    .flatMap((call) => (call[0] as DebugBundleBrowserTransportRequest).events)
    .flatMap((event) =>
      event.event_type === "analytics_event" && event.schema_version === "2026-07-analytics-01"
        ? [event.payload.signal.action_key ?? ""] : []
    );
}

describe("browser analytics consent ownership", () => {
  it("keeps an explicit V2 opt-in from silently emitting V1 analytics while debug capture works", async () => {
    const { sdk, transport, globals } = createSdk({
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" },
      captureNetwork: false
    });
    await sdk.flush();
    sdk.analytics.track("account.created", { signup_method: "email" });
    sdk.analytics.pageView({ path: "/signup" });
    await sdk.flush();
    expect(sentNames(transport)).toEqual([]);
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        authorization: "Bearer dbundle_proj_browser",
        "x-debugbundle-analytics-schema": "2026-09-analytics-02"
      }
    });
    sdk.captureMessage("debug still works", "error");
    await sdk.flush();
    expect(transport.mock.calls.flatMap((call) => (call[0] as DebugBundleBrowserTransportRequest).events)
      .some((event) => event.event_type === "log_event")).toBe(true);
  });

  it("keeps V2 relay opt-in closed without a browser-held writer credential", async () => {
    const { sdk, transport, globals } = createSdk({
      transportMode: "relay",
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" },
      captureNetwork: false
    });
    sdk.analytics.track("account.created", { signup_method: "email" });
    await sdk.flush();
    expect(sentNames(transport)).toEqual([]);
    expect(globals.fetchMock).not.toHaveBeenCalled();
    sdk.captureMessage("debug via relay", "error");
    await sdk.flush();
    expect(transport.mock.calls.flatMap((call) => (call[0] as DebugBundleBrowserTransportRequest).events)
      .some((event) => event.event_type === "log_event")).toBe(true);
  });

  it.each([1, 256])(
    "purges unsent records before a manual or threshold flush with batch size %i",
    async (batchSize) => {
      const { sdk, transport } = createSdk({ analytics, batchSize, captureNetwork: false });
      await sdk.flush();
      sdk.analytics.track("revoked.action");
      sdk.analytics.setConsent(false);
      sdk.captureMessage("debug remains eligible", "error");
      await sdk.flush();
      expect(sentNames(transport)).toEqual([]);
      expect(
        transport.mock.calls
          .flatMap((call) => (call[0] as DebugBundleBrowserTransportRequest).events)
          .some((event) => event.event_type === "log_event")
      ).toBe(true);
    }
  );

  it("does not retry queued analytics after withdrawal", async () => {
    const { sdk, transport } = createSdk({ analytics, batchSize: 256, captureNetwork: false });
    await sdk.flush();
    transport.mockResolvedValue({ status: 503 });
    sdk.analytics.track("revoked.retry");
    await sdk.flush();
    expect(sentNames(transport)).toEqual(["revoked.retry"]);
    sdk.analytics.setConsent(false);
    transport.mockResolvedValue({ status: 202 });
    await sdk.flush();
    expect(sentNames(transport)).toEqual(["revoked.retry"]);
  });

  it("requires fresh identity and context after re-grant", async () => {
    const { sdk, transport } = createSdk({ analytics, batchSize: 256, captureNetwork: false });
    await sdk.flush();
    sdk.analytics.setUserHash(`sha256:${"a".repeat(64)}`);
    sdk.analytics.setContext({ account_tier: "old-account" });
    sdk.analytics.track("old.account");
    sdk.analytics.setConsent(false);
    sdk.analytics.setConsent(true);
    sdk.analytics.track("new.account");
    await sdk.flush();
    expect(sentNames(transport)).toEqual(["new.account"]);
    const events = (transport.mock.calls[0]?.[0] as DebugBundleBrowserTransportRequest).events;
    expect(
      events.find((event) => event.event_type === "analytics_event")?.correlation.user_id_hash
    ).toBeNull();
    const encoded = JSON.stringify(events);
    expect(encoded).not.toContain("old-account");
  });

  it("fences keepalive before the deferred fetch invocation", async () => {
    const { sdk, globals } = createSdk({ analytics, batchSize: 256, captureNetwork: false });
    await sdk.flush();
    globals.fetchMock.mockClear();
    sdk.analytics.track("revoked.lifecycle");
    globals.windowTarget.dispatch("pagehide", { persisted: true });
    sdk.analytics.setConsent(false);
    await sdk.flush();
    expect(globals.fetchMock).not.toHaveBeenCalled();
  });

  it("does not resurrect a revoked in-flight failure after re-grant", async () => {
    let finish!: (response: { status: number }) => void;
    const { sdk, transport } = createSdk({ analytics, batchSize: 256, captureNetwork: false });
    await sdk.flush();
    const heldResponse = new Promise<{ status: number }>((resolve) => { finish = resolve; });
    transport.mockReturnValueOnce(heldResponse);
    sdk.analytics.track("already.sent");
    const pending = sdk.flush();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    sdk.analytics.setConsent(false);
    sdk.analytics.setConsent(true);
    finish({ status: 503 });
    await pending;
    sdk.analytics.track("fresh.action");
    await sdk.flush();
    expect(sentNames(transport)).toEqual(["already.sent", "fresh.action"]);
  });

  it("aborts dispatched keepalive but retains ownership until the request settles", async () => {
    const { sdk, globals } = createSdk({ analytics, batchSize: 256, captureNetwork: false });
    await sdk.flush();
    globals.fetchMock.mockClear();
    let finish!: (value: { status: number }) => void;
    const response = new Promise<{ status: number }>((resolve) => { finish = resolve; });
    globals.fetchMock.mockReturnValue(response);
    sdk.analytics.track("already.dispatched");
    globals.windowTarget.dispatch("pagehide", { persisted: true });
    await vi.waitFor(() => expect(globals.fetchMock).toHaveBeenCalledTimes(1));
    const signal = (globals.fetchMock.mock.calls[0]?.[1] as RequestInit).signal;
    const owner = (sdk as unknown as { eventTransport: { keepaliveBytes: number } }).eventTransport;
    const reserved = owner.keepaliveBytes;
    sdk.analytics.setConsent(false);
    expect(signal?.aborted).toBe(true);
    expect(reserved).toBeGreaterThan(0);
    expect(owner.keepaliveBytes).toBe(reserved);
    finish({ status: 503 });
    await vi.waitFor(() => expect(owner.keepaliveBytes).toBe(0));
  });

  it.each(["disable", "privacy", "consent"])(
    "fences queued work on remote %s tightening",
    async (mode) => {
      const { sdk, transport } = createSdk({ analytics, batchSize: 256, captureNetwork: false });
      await sdk.flush();
      sdk.analytics.setUserHash(`sha256:${"a".repeat(64)}`);
      sdk.analytics.track("old.policy");
      const controller = (sdk as unknown as { analyticsController: BrowserAnalyticsController })
        .analyticsController;
      controller.applyRemoteSettings({
        enabled: mode !== "disable",
        privacyMode: mode === "privacy" ? "strict" : "custom",
        consentRequired: mode === "consent",
        capturePageViews: true,
        captureRouteChanges: true,
        captureActions: true,
        captureFrictionSignals: true
      });
      await sdk.flush();
      expect(sentNames(transport)).toEqual([]);
    }
  );
});
