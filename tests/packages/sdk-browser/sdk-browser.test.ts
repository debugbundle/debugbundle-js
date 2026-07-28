import { describe, expect, it, vi } from "vitest";

import * as browserFixtures from "../../helpers/sdk-browser-fixtures.js";

describe("sdk-browser", () => {
  it("should expose the core browser sdk surface", (): void => {
    const globals = browserFixtures.installBrowserGlobals();
    void globals;

    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    expect(typeof sdk.init).toBe("function");
    expect(typeof sdk.captureException).toBe("function");
    expect(typeof sdk.captureError).toBe("function");
    expect(typeof sdk.captureLog).toBe("function");
    expect(typeof sdk.captureRequest).toBe("function");
    expect(typeof sdk.captureMessage).toBe("function");
    expect(typeof sdk.setContext).toBe("function");
    expect(typeof sdk.analytics.setConsent).toBe("function");
    expect(typeof sdk.analytics.pageView).toBe("function");
    expect(typeof sdk.analytics.track).toBe("function");
    expect(typeof sdk.analytics.funnel).toBe("function");
    expect(typeof sdk.analytics.convert).toBe("function");
    expect(typeof sdk.analytics.marker).toBe("function");
    expect(typeof sdk.analytics.setContext).toBe("function");
    expect(typeof sdk.analytics.setUserHash).toBe("function");
    expect(typeof sdk.probe).toBe("function");
    expect(typeof sdk.flush).toBe("function");
    expect(typeof sdk.dispose).toBe("function");
  });

  it("keeps analytics disabled by default without changing debug capture", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk();

    sdk.analytics.pageView({ path: "/pricing?token=secret", title: "Pricing" });
    sdk.analytics.track("feature.used", { feature: "billing_portal" });
    sdk.analytics.funnel("checkout", "payment_submitted");
    sdk.analytics.convert("subscription_started");
    sdk.analytics.marker("checkout.validation_failed");
    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();

    sdk.captureMessage("debug still works", "error");
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event"]);
  });

  it("emits opt-in analytics session, page, route, action, funnel, and conversion events", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk({
      analytics: {
        enabled: true,
        privacyMode: "custom"
      }
    });

    sdk.analytics.setContext({
      auth_state: "authenticated",
      account_tier: "team",
      unsafe_email: "owner@example.com"
    });
    sdk.analytics.setUserHash("sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout/payment?token=secret");
    sdk.analytics.track("feature.used", { feature: "billing_portal", order_id: "ord_123" });
    sdk.analytics.funnel("checkout", "payment_submitted", { plan_selected: "team" });
    sdk.analytics.convert("subscription_started", { plan_selected: "team" });
    sdk.analytics.pageView({ path: "/pricing?token=secret#plans", title: "Pricing" });
    await sdk.flush();

    const events = browserFixtures.getAnalyticsEvents(transport);
    expect(events.map((event) => event.payload.kind)).toEqual([
      "session_start",
      "page_view",
      "route_change",
      "action",
      "funnel_step",
      "conversion",
      "page_view"
    ]);
    expect(events.every((event) => event.event_type === "analytics_event")).toBe(true);
    expect(events.every((event) => event.correlation.session_id.length > 0)).toBe(true);
    expect(events[0]?.correlation.user_id_hash).toBeNull();
    expect(events.slice(2).every((event) => event.correlation.user_id_hash === "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")).toBe(true);
    expect(events[1]?.payload.route).toEqual({
      path: "/checkout",
      normalized_path: "/checkout",
      title: null
    });
    expect(events[2]?.payload.route).toEqual({
      path: "/checkout/payment",
      normalized_path: "/checkout/payment",
      title: null
    });
    expect(events[2]?.payload.previous_route).toEqual({
      path: "/checkout",
      normalized_path: "/checkout",
      title: null
    });
    expect(events[6]?.payload.route).toEqual({
      path: "/pricing",
      normalized_path: "/pricing",
      title: "Pricing"
    });
    expect(events[3]?.payload.signal).toMatchObject({ action_key: "feature.used" });
    expect(events[3]?.payload.custom_dimensions).toMatchObject({
      account_tier: "team",
      feature: "billing_portal"
    });
    expect(events[3]?.payload.custom_dimensions).not.toHaveProperty("unsafe_email");
    expect(events[3]?.payload.custom_dimensions).not.toHaveProperty("order_id");
    expect(events[4]?.payload.signal).toMatchObject({ funnel_key: "checkout", step_key: "payment_submitted" });
    expect(events[5]?.payload.signal).toMatchObject({ conversion_key: "subscription_started" });
    expect(events[0]?.payload.dimensions).toMatchObject({
      auth_state: "anonymous",
      device_type: "desktop",
      browser_family: "Chrome",
      os_family: "macOS",
      language: "en-US",
      locale: "en-US",
      viewport_bucket: "large",
      referrer_domain: "example.com"
    });
    expect(events[3]?.payload.dimensions.auth_state).toBe("authenticated");
  });

  it("captures opt-in structural actions independently from debug click breadcrumbs", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      captureClicks: false,
      analytics: {
        enabled: true,
        trackActions: true
      }
    });

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "pay-now",
        textContent: "Upgrade to Team - $49/mo",
        value: "private-button-value"
      }
    });
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0)).toEqual([]);
    const events = browserFixtures.getAnalyticsEvents(transport);
    expect(events.map((event) => event.payload.kind)).toEqual(["session_start", "page_view", "action"]);

    const action = events[2];
    expect(action?.payload.signal).toMatchObject({ action_key: "click.button" });
    expect(action?.payload.route).toEqual({
      path: "/checkout",
      normalized_path: "/checkout",
      title: null
    });
    expect(JSON.stringify(action)).not.toContain("pay-now");
    expect(JSON.stringify(action)).not.toContain("Upgrade to Team - $49/mo");
    expect(JSON.stringify(action)).not.toContain("private-button-value");
  });

  it("does not auto-capture structural actions unless trackActions is enabled", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      captureClicks: false,
      analytics: {
        enabled: true
      }
    });

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "A",
        href: "/upgrade",
        textContent: "Upgrade"
      }
    });
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0)).toEqual([]);
    expect(browserFixtures.getAnalyticsEvents(transport).map((event) => event.payload.kind)).toEqual(["session_start", "page_view"]);
  });

  it("captures bounded privacy-safe repeated-click, dead-click, and backtrack friction markers", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      captureClicks: false,
      analytics: {
        enabled: true,
        trackActions: false
      }
    });
    const buttonTarget = {
      tagName: "BUTTON",
      id: "pay-now",
      textContent: "Pay $49 now",
      value: "private-button-value"
    };
    const nonInteractiveTarget = {
      tagName: "DIV",
      id: "looks-clickable",
      textContent: "Upgrade to Team"
    };

    for (let index = 0; index < 4; index += 1) {
      globals.documentTarget.dispatch("click", { target: buttonTarget });
      globals.documentTarget.dispatch("click", { target: nonInteractiveTarget });
    }
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/pricing");
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout");
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0)).toEqual([]);
    const markers = browserFixtures.getAnalyticsEvents(transport)
      .filter((event) => event.payload.kind === "journey_marker")
      .map((event) => event.payload.signal.marker_key);
    expect(markers).toEqual(["friction.repeated_click", "friction.dead_click", "friction.backtrack"]);
    const serialized = JSON.stringify(browserFixtures.getAnalyticsEvents(transport));
    expect(serialized).not.toContain("pay-now");
    expect(serialized).not.toContain("Pay $49 now");
    expect(serialized).not.toContain("private-button-value");
    expect(serialized).not.toContain("looks-clickable");
    expect(serialized).not.toContain("Upgrade to Team");
  });

  it("does not capture friction markers when the local setting disables them", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      captureClicks: false,
      analytics: {
        enabled: true,
        trackFrictionSignals: false
      }
    });
    const target = { tagName: "BUTTON" };

    for (let index = 0; index < 3; index += 1) {
      globals.documentTarget.dispatch("click", { target });
    }
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/pricing");
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout");
    await sdk.flush();

    expect(browserFixtures.getAnalyticsEvents(transport).filter((event) => event.payload.kind === "journey_marker")).toEqual([]);
  });

  it("applies restrictive remote friction settings without affecting debug capture", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: {},
        capture_rules: [],
        analytics: {
          enabled: true,
          privacy_mode: "strict",
          consent_required: false,
          capture_page_views: true,
          capture_route_changes: true,
          capture_actions: true,
          capture_friction_signals: false
        }
      })
    });
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport,
      captureClicks: false,
      analytics: {
        enabled: true,
        trackPageViews: false,
        trackSessions: false
      }
    });
    await browserFixtures.settleAsyncInit();

    const target = { tagName: "BUTTON" };
    for (let index = 0; index < 3; index += 1) {
      globals.documentTarget.dispatch("click", { target });
    }
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/pricing");
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout");
    await sdk.flush();

    expect(browserFixtures.getAnalyticsEvents(transport).filter((event) => event.payload.kind === "journey_marker")).toEqual([]);
    sdk.captureMessage("debug still works", "error");
    await sdk.flush();
    expect(browserFixtures.createTransportEvents(transport, 1).map((event) => event.event_type)).toEqual(["log_event"]);
  });

  it("gates structural actions on analytics consent", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      captureClicks: false,
      analytics: {
        enabled: true,
        consentRequired: true,
        trackActions: true
      }
    });

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        textContent: "Blocked before consent"
      }
    });
    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();

    sdk.analytics.setConsent(true);
    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        textContent: "Allowed after consent"
      }
    });
    await sdk.flush();

    expect(browserFixtures.getAnalyticsEvents(transport).map((event) => event.payload.kind)).toEqual(["action"]);
    expect(browserFixtures.getAnalyticsEvents(transport)[0]?.payload.signal).toMatchObject({ action_key: "click.button" });
  });

  it("emits bounded journey markers and one unload-safe session summary", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      analytics: {
        enabled: true
      }
    });

    sdk.analytics.marker("checkout.validation_failed", {
      attempt_bucket: 3,
      email: "owner@example.com"
    });
    await sdk.flush();

    const marker = browserFixtures.getAnalyticsEvents(transport).find((event) => event.payload.kind === "journey_marker");
    expect(marker?.payload.signal).toMatchObject({ marker_key: "checkout.validation_failed" });
    expect(marker?.payload.route).toEqual({
      path: "/checkout",
      normalized_path: "/checkout",
      title: null
    });
    expect(marker?.payload.custom_dimensions).toEqual({ attempt_bucket: 3 });

    await browserFixtures.settleAsyncInit();
    globals.fetchMock.mockClear();
    globals.sendBeacon.mockReturnValue(false);
    globals.windowTarget.dispatch("pagehide", { persisted: true });
    await browserFixtures.settleAsyncInit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(globals.fetchMock).not.toHaveBeenCalled();

    globals.windowTarget.dispatch("pagehide", { persisted: false });
    await browserFixtures.settleAsyncInit();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = globals.fetchMock.mock.calls[0]?.[1] as { body?: unknown } | undefined;
    const body = JSON.parse(String(request?.body)) as { events: browserFixtures.AnalyticsEvent[] };
    expect(body.events.map((event) => event.payload.kind)).toEqual(["session_summary"]);
    expect(body.events[0]?.payload.route).toEqual({
      path: "/checkout",
      normalized_path: "/checkout",
      title: null
    });
    expect(body.events[0]?.payload.signal).toEqual({
      action_key: null,
      funnel_key: null,
      step_key: null,
      conversion_key: null,
      marker_key: null
    });
  });

  it("gates analytics capture on consent without affecting debug events", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk({
      analytics: {
        enabled: true,
        consentRequired: true
      }
    });

    sdk.analytics.pageView({ path: "/blocked" });
    sdk.captureMessage("debug while analytics blocked", "error");
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event"]);

    sdk.analytics.setConsent(true);
    sdk.analytics.pageView({ path: "/allowed" });
    await sdk.flush();

    expect(browserFixtures.getAnalyticsEvents(transport, 1).map((event) => event.payload.kind)).toEqual(["page_view"]);
  });

  it("uses a project-scoped anonymous visitor hash for standard analytics without persisting the project token", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const firstTransport = vi.fn().mockResolvedValue({ status: 202 });
    const firstSdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(firstSdk);
    firstSdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport: firstTransport,
      analytics: {
        enabled: true,
        privacyMode: "standard",
        trackPageViews: false,
        trackSessions: false
      }
    });
    await browserFixtures.settleAsyncInit();

    firstSdk.analytics.track("checkout.started");
    await vi.waitFor(async () => {
      await firstSdk.flush();
      expect(browserFixtures.getAnalyticsEvents(firstTransport)).toHaveLength(1);
    });

    const firstVisitorHash = browserFixtures.getAnalyticsEvents(firstTransport)[0]?.correlation.visitor_id_hash;
    expect(firstVisitorHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(globals.localStorage.entries()).toHaveLength(1);
    expect(JSON.stringify(globals.localStorage.entries())).not.toContain("dbundle_proj_browser");

    const secondTransport = vi.fn().mockResolvedValue({ status: 202 });
    const secondSdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(secondSdk);
    secondSdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport: secondTransport,
      analytics: {
        enabled: true,
        privacyMode: "standard",
        trackPageViews: false,
        trackSessions: false
      }
    });
    await browserFixtures.settleAsyncInit();

    secondSdk.analytics.track("checkout.completed");
    await vi.waitFor(async () => {
      await secondSdk.flush();
      expect(browserFixtures.getAnalyticsEvents(secondTransport)).toHaveLength(1);
    });

    expect(browserFixtures.getAnalyticsEvents(secondTransport)[0]?.correlation.visitor_id_hash).toBe(firstVisitorHash);
  });

  it("keeps strict analytics session-only and does not create persistent visitor storage", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      analytics: {
        enabled: true,
        privacyMode: "strict",
        trackPageViews: false,
        trackSessions: false
      }
    });

    sdk.analytics.track("checkout.started");
    await sdk.flush();

    expect(browserFixtures.getAnalyticsEvents(transport)[0]?.correlation.visitor_id_hash).toBeNull();
    expect(globals.localStorage.entries()).toEqual([]);
  });

  it("removes the standard visitor value when analytics consent is withdrawn", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport,
      analytics: {
        enabled: true,
        privacyMode: "standard",
        trackPageViews: false,
        trackSessions: false
      }
    });
    await vi.waitFor(() => {
      expect(globals.localStorage.entries()).toHaveLength(1);
    });

    sdk.analytics.setConsent(false);
    sdk.analytics.track("checkout.after_consent_withdrawal");
    await sdk.flush();

    expect(globals.localStorage.entries()).toEqual([]);
    expect(transport).not.toHaveBeenCalled();
  });

  it("applies restrictive remote analytics settings without affecting debug capture", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: {},
        capture_rules: [],
        analytics: {
          enabled: false,
          privacy_mode: "strict",
          consent_required: true,
          capture_page_views: false,
          capture_route_changes: false,
          capture_actions: false,
          capture_friction_signals: false
        }
      })
    });
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport,
      analytics: {
        enabled: true,
        privacyMode: "standard",
        trackActions: true,
        trackPageViews: false,
        trackSessions: false
      }
    });
    await browserFixtures.settleAsyncInit();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        authorization: "Bearer dbundle_proj_browser",
        "x-debugbundle-analytics-config": "1"
      }
    });
    expect(globals.localStorage.entries()).toEqual([]);

    sdk.analytics.track("checkout.started");
    globals.documentTarget.dispatch("click", {
      target: { tagName: "BUTTON", textContent: "Pay now" }
    });
    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();

    sdk.captureMessage("debug still works", "error");
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event"]);
  });

  it("does not request remote analytics settings for an analytics-disabled SDK", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: {},
        capture_rules: [],
        analytics: {
          enabled: true,
          privacy_mode: "standard",
          consent_required: false,
          capture_page_views: true,
          capture_route_changes: true,
          capture_actions: true,
          capture_friction_signals: true
        }
      })
    });
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });
    await browserFixtures.settleAsyncInit();

    sdk.analytics.track("checkout.started");
    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: {
        authorization: "Bearer dbundle_proj_browser"
      }
    });
    expect(globals.fetchMock.mock.calls[0]?.[1]).not.toMatchObject({
      headers: {
        "x-debugbundle-analytics-config": "1"
      }
    });
  });

  it("requires explicit consent when remote analytics settings tighten consent", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        capture_policy: {},
        capture_rules: [],
        analytics: {
          enabled: true,
          privacy_mode: "strict",
          consent_required: true,
          capture_page_views: true,
          capture_route_changes: true,
          capture_actions: true,
          capture_friction_signals: true
        }
      })
    });
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport,
      analytics: {
        enabled: true,
        trackPageViews: false,
        trackSessions: false
      }
    });
    await browserFixtures.settleAsyncInit();

    sdk.analytics.track("checkout.started");
    await sdk.flush();
    expect(transport).not.toHaveBeenCalled();

    sdk.analytics.setConsent(true);
    sdk.analytics.track("checkout.started");
    await sdk.flush();

    expect(browserFixtures.getAnalyticsEvents(transport).map((event) => event.payload.kind)).toEqual(["action"]);
  });

});
