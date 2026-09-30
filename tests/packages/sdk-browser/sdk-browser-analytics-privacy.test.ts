import { describe, expect, it, vi } from "vitest";
import {
  activeSdks,
  createDebugBundleBrowserSdk,
  createSdk,
  installBrowserGlobals
} from "../../helpers/sdk-browser-fixtures.js";
import { buildAnalyticsDimensions } from "../../../packages/sdk-browser/src/analytics-normalization.js";
import type {
  BrowserAnalyticsEventEnvelope,
  DebugBundleBrowserTransportRequest
} from "../../../packages/sdk-browser/src/types.js";

const analytics = {
  enabled: true,
  privacyMode: "custom" as const,
  trackSessions: false,
  trackPageViews: false
};
// This is a mandatory baseline pattern in privacy-conformance.json, not arbitrary secret prose.
const credential = "dbundle_mem_analytics_fixture_secret";

describe("browser analytics first-buffer safety", () => {
  it.each([false, true])(
    "rejects disabled or consent-blocked capture before input traversal (%s)",
    async (enabled) => {
      const { sdk } = createSdk({ analytics: { ...analytics, enabled, consentRequired: true } });
      await sdk.flush();
      const read = vi.fn(() => "value");
      const input = Object.defineProperty({}, "feature", { enumerable: true, get: read });
      sdk.analytics.track("feature.used", input);
      sdk.analytics.setContext(input);
      expect(read).not.toHaveBeenCalled();
    }
  );

  it("contains getters and proxy failures without invoking application accessors", async () => {
    const { sdk } = createSdk({ analytics });
    await sdk.flush();
    const read = vi.fn(() => {
      throw new Error("application getter");
    });
    const input = Object.defineProperty({}, "feature", { enumerable: true, get: read });
    expect(() => sdk.analytics.track("feature.used", input)).not.toThrow();
    expect(() => sdk.analytics.setContext(input)).not.toThrow();
    expect(() =>
      sdk.analytics.pageView(Object.defineProperty({}, "path", { get: read }))
    ).not.toThrow();
    const proxy = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error("application proxy");
        }
      }
    );
    expect(() => sdk.analytics.track("feature.used", proxy)).not.toThrow();
    expect(read).not.toHaveBeenCalled();
  });

  it("retains a protected snapshot while configuration is pending, immune to caller mutation", async () => {
    const globals = installBrowserGlobals();
    let finish!: (value: { status: number }) => void;
    const heldConfiguration = new Promise<{ status: number }>((resolve) => { finish = resolve; });
    globals.fetchMock.mockReturnValue(heldConfiguration);
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    activeSdks.push(sdk);
    sdk.init({ projectToken: "dbundle_proj_browser", analytics, transport, captureNetwork: false });
    const dimensions = { feature: "before", category: credential };
    sdk.analytics.track("feature.used", dimensions);
    const state = (
      sdk as unknown as { analyticsController: { active: { pendingCaptures: unknown[] } } }
    ).analyticsController.active;
    expect(state.pendingCaptures.length).toBe(1);
    expect(typeof state.pendingCaptures[0]).toBe("object");
    expect(JSON.stringify(state.pendingCaptures)).not.toContain(credential);
    dimensions.feature = "after";
    finish({ status: 202 });
    await sdk.flush();
    const events = transport.mock.calls.flatMap(
      (call) => (call[0] as DebugBundleBrowserTransportRequest).events
    );
    const captured = events.find(
      (event) => event.event_type === "analytics_event"
    ) as BrowserAnalyticsEventEnvelope;
    expect(captured.payload.custom_dimensions["feature"]).toBe("before");
    expect(JSON.stringify(events)).not.toContain(credential);
  });

  it("protects titles, campaign values and custom fields before transport admission", async () => {
    const { sdk, transport } = createSdk({ analytics });
    await sdk.flush();
    vi.stubGlobal("location", {
      href: "https://example.test/",
      search: `?utm_campaign=${credential}`
    });
    sdk.analytics.pageView({ path: "/pricing", title: `Authorization: Bearer ${credential}` });
    sdk.analytics.track("feature.used", { feature: "checkout", category: credential });
    const owned = (sdk as unknown as { eventTransport: { analytics: { events: unknown[] } } })
      .eventTransport.analytics.events;
    expect(owned.length).toBe(2);
    expect(JSON.stringify(owned)).not.toContain(credential);
    await sdk.flush();
    expect(JSON.stringify(transport.mock.calls)).not.toContain(credential);
    expect(JSON.stringify(transport.mock.calls)).toContain("checkout");
  });

  it("withholds a credential-like signal name before deferred retention", () => {
    const { sdk } = createSdk({ analytics });
    sdk.analytics.track(credential);
    const state = (
      sdk as unknown as { analyticsController: { active: { pendingCaptures: unknown[] } } }
    ).analyticsController.active;
    expect(JSON.stringify(state.pendingCaptures)).not.toContain(credential);
  });

  it("does not inspect referrer or campaign sources when collection is disabled", () => {
    const read = vi.fn(() => {
      throw new Error("disabled field read");
    });
    vi.stubGlobal("location", Object.defineProperty({}, "search", { get: read }));
    vi.stubGlobal("document", Object.defineProperty({}, "referrer", { get: read }));
    expect(() => buildAnalyticsDimensions(null, false, {})).not.toThrow();
    expect(read).not.toHaveBeenCalled();
    expect(buildAnalyticsDimensions(null, false, {})).toMatchObject({
      referrer_domain: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null
    });
  });

  it("does not inspect application data once the analytics queue is full", async () => {
    const { sdk } = createSdk({ analytics, batchSize: 256 });
    await sdk.flush();
    for (let i = 0; i < 256; i++) sdk.analytics.track("queued.action");
    const read = vi.fn(() => "must not inspect");
    const input = Object.defineProperty({}, "feature", { enumerable: true, get: read });
    sdk.analytics.track("overflow.action", input);
    expect(read).not.toHaveBeenCalled();
  });
});
