import { describe, expect, it, vi } from "vitest";
import { createDebugBundleBrowserSdk } from "../../../packages/sdk-browser/src/index.js";
import { installBrowserGlobals } from "../../helpers/sdk-browser-fixtures.js";

const projectId = "11111111-1111-4111-8111-111111111111";

function capability(enabled = true, expiresInMs = 60_000, maxBatchEvents = 256, sampleRate = 1) {
  const now = Date.now();
  return {
    analytics_semantic: {
      protocol: "2026-09-analytics-capabilities-01", project_id: projectId,
      principal: "project_token", server_time: new Date(now).toISOString(),
      expires_at: new Date(now + expiresInMs).toISOString(), enabled,
      unavailable_reason: enabled ? null : "not_enabled",
      schema_version: "2026-09-analytics-02", scope: { kind: "project", project_id: projectId },
      scope_revision: 1, catalog_revision: enabled ? 1 : null,
      namespace_revision: null, identity_scope: null, known_identity_allowed: false,
      allowed_producers: enabled ? ["browser"] : [],
      allowed_purposes: enabled ? ["product_analytics"] : [],
      consent_required: false, privacy_mode: "strict", sample_rate: sampleRate,
      max_event_bytes: 16_384, max_batch_events: maxBatchEvents, max_batch_bytes: 262_144,
      max_properties: 20, detailed_retention_days: 90, max_event_age_seconds: 604_800,
      correction_seconds: 172_800, receipt_retention_days: 90, retry_after_max_ms: 300_000
    }
  };
}

function remoteAnalytics(overrides: Record<string, unknown> = {}) {
  return {
    enabled: true, privacy_mode: "strict", consent_required: false,
    capture_page_views: true, capture_route_changes: true,
    capture_actions: true, capture_friction_signals: true,
    ...overrides
  };
}

describe("browser semantic analytics direct writer", () => {
  it("captures only opted-in structural V2 actions after capability without debug clicks or target data", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      captureClicks: false, analytics: { enabled: true, schemaVersion: "2026-09-analytics-02",
        trackActions: true, routeTemplates: ["/checkout"] } });
    globals.documentTarget.dispatch("click", { target: { tagName: "BUTTON" } });
    await sdk.flush();
    let idReads = 0;
    globals.documentTarget.dispatch("click", { target: {
      tagName: "BUTTON", get id() { idReads += 1; return "private-button-id"; },
      textContent: "Upgrade for $19",
      value: "private-value", type: "submit"
    } });
    globals.documentTarget.dispatch("click", { target: { tagName: "DIV", id: "private-div" } });
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    const events = posts.flatMap((call) => (JSON.parse(String((call as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ event_type: string; payload: { kind: string; name: string;
        route: { normalized_path: string } | null } }>
    }).events);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "analytics_event", payload: {
      kind: "semantic", name: "click.button", route: { normalized_path: "/checkout" }
    } });
    expect(idReads).toBe(0);
    expect(JSON.stringify(events)).not.toMatch(/private-button-id|private-div|Upgrade|private-value/);
    sdk.dispose();
  });

  it("keeps V2 structural capture behind both local and remote action controls", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics({ capture_actions: false })
    }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      captureClicks: false, analytics: { enabled: true, schemaVersion: "2026-09-analytics-02",
        trackActions: true } });
    await sdk.flush();
    globals.documentTarget.dispatch("click", { target: { tagName: "BUTTON" } });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });

  it("emits only fixed V2 friction markers from transient clicks and safe route reversal", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockImplementation((_url: unknown, init: { body?: unknown }) => ({
      status: 202, json: async () => ({
        accepted: (JSON.parse(String(init.body)) as { events: unknown[] }).events.length,
        rejected: 0, errors: []
      })
    }));
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      captureClicks: false, analytics: { enabled: true, schemaVersion: "2026-09-analytics-02",
        trackFrictionSignals: true, trackRouteChanges: true, routeTemplates: ["/checkout", "/pricing"] } });
    await sdk.flush();
    const button = { tagName: "BUTTON", id: "secret-button", textContent: "Private label" };
    const div = { tagName: "DIV", id: "secret-div", textContent: "Private area" };
    for (let index = 0; index < 4; index += 1) {
      globals.documentTarget.dispatch("click", { target: button });
      globals.documentTarget.dispatch("click", { target: div });
    }
    globalThis.history.pushState({}, "", "/pricing");
    globalThis.history.pushState({}, "", "/checkout");
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    const events = posts.flatMap((call) => (JSON.parse(String((call as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ payload: { kind: string; name: string; properties: Record<string, unknown> } }>
    }).events);
    expect(events.filter((event) => event.payload.kind === "journey_marker").map((event) => event.payload.name))
      .toEqual(["friction.repeated_click", "friction.dead_click", "friction.backtrack"]);
    expect(events.filter((event) => event.payload.kind === "journey_marker")
      .every((event) => Object.keys(event.payload.properties).length === 0)).toBe(true);
    expect(JSON.stringify(events)).not.toMatch(/secret-button|secret-div|Private/);
    sdk.dispose();
  });

  it("withholds V2 friction markers when remote friction capture is off", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics({ capture_friction_signals: false })
    }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      captureClicks: false, analytics: { enabled: true, schemaVersion: "2026-09-analytics-02",
        trackFrictionSignals: true } });
    await sdk.flush();
    const button = { tagName: "BUTTON" };
    for (let index = 0; index < 3; index += 1) globals.documentTarget.dispatch("click", { target: button });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });

  it("captures opted-in session and allowlisted page lifecycle after capability, without dynamic routes", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockImplementation((_url: unknown, init: { body?: unknown }) => ({
      status: 202, json: async () => ({
        accepted: (JSON.parse(String(init.body)) as { events: unknown[] }).events.length,
        rejected: 0, errors: []
      })
    }));
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackSessions: true,
        trackPageViews: true, trackRouteChanges: true, routeTemplates: ["/checkout", "/signup"] } });
    await sdk.flush();
    globalThis.history.pushState({}, "", "/signup?token=secret#step");
    globalThis.history.pushState({}, "", "/users/private-id");
    globalThis.history.pushState({}, "", "https://other.example/signup");
    globals.windowTarget.dispatch("pagehide", { persisted: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    const events = posts.flatMap((call) => {
      const body = String((call as [unknown, { body?: unknown }])[1].body);
      return (JSON.parse(body) as { events: unknown[] }).events;
    }) as Array<{ payload: { kind: string; route: { normalized_path: string } | null;
      previous_route: { normalized_path: string } | null; session: unknown } }>;
    expect(events.map((event) => event.payload.kind)).toEqual([
      "session_start", "page_view", "route_change", "session_summary"
    ]);
    expect(events[1]?.payload.route).toEqual({ normalized_path: "/checkout" });
    expect(events[2]?.payload).toMatchObject({
      route: { normalized_path: "/signup" }, previous_route: { normalized_path: "/checkout" }
    });
    expect(JSON.stringify(events)).not.toContain("private-id");
    expect(JSON.stringify(events)).not.toContain("token=secret");
    sdk.dispose();
  });

  it("keeps automatic V2 capture behind remote consent and per-signal restrictions", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics({
        consent_required: true, capture_page_views: false, capture_route_changes: false
      })
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackSessions: true,
        trackPageViews: true, trackRouteChanges: true, routeTemplates: ["/checkout", "/signup"] } });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.analytics.setConsent(true);
    globalThis.history.pushState({}, "", "/signup");
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = String((posts[0] as [unknown, { body?: unknown }])[1].body);
    const events = (JSON.parse(body) as { events: Array<{ payload: { kind: string } }> }).events;
    expect(events.map((event) => event.payload.kind)).toEqual(["session_start"]);
    sdk.dispose();
  });

  it("ignores an invalid automatic route allowlist without throwing into the page", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    expect(() => sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackPageViews: true,
        routeTemplates: 123 as never } })).not.toThrow();
    await sdk.flush();
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = String((posts[0] as [unknown, { body?: unknown }])[1].body);
    const events = (JSON.parse(body) as { events: Array<{ payload: { kind: string } }> }).events;
    expect(events.map((event) => event.payload.kind)).toEqual(["semantic"]);
    sdk.dispose();
  });

  it("keeps a legacy status result when V2 was not selected", () => {
    const sdk = createDebugBundleBrowserSdk();
    expect(sdk.analytics.getStatus()).toEqual({ mode: "legacy", semantic: null });
    sdk.dispose();
  });

  it("emits a protected V2 browser fact only after a current authenticated capability", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => capability() });
    globals.fetchMock.mockResolvedValueOnce({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({
      projectToken: "dbundle_proj_browser", transportMode: "direct", service: "checkout-web",
      environment: "production", captureNetwork: false, flushInterval: 60_000,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" }
    });
    await sdk.flush();
    expect(sdk.analytics.getStatus()).toMatchObject({
      mode: "semantic", semantic: { state: "enabled", pending_events: 0 }
    });
    sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[0]).toBe("https://api.debugbundle.com/v1/events");
    const body = String((posts[0] as [unknown, { body?: unknown }])[1].body);
    const event = (JSON.parse(body) as { events: unknown[] }).events[0];
    expect(event).toMatchObject({
      schema_version: "2026-09-analytics-02", event_type: "analytics_event",
      producer: { kind: "browser" }, payload: { kind: "semantic", name: "signup.completed",
        event_revision: 1, purpose: "product_analytics", client: {
          auth_state: "anonymous", device_type: "desktop", browser_family: "chrome",
          browser_major: 122, language: "en-US", viewport_bucket: "large"
        } }
    });
    expect(JSON.stringify(event)).not.toContain("Bearer secret");
    expect(JSON.stringify(event)).not.toContain("Mozilla/");
    sdk.analytics.track("signup.completed", { method: "email", authorization: "Bearer secret" }, { eventRevision: 1 });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    sdk.dispose();
  });

  it("attaches one protected landing and campaign touch only when explicitly enabled", async () => {
    const globals = installBrowserGlobals();
    vi.stubGlobal("location", { href: "https://example.com/checkout?utm_source=partner&utm_campaign=launch&token=secret",
      pathname: "/checkout", search: "?utm_source=partner&utm_campaign=launch&token=secret" });
    globals.documentTarget.referrer = "https://partner.example/start?auth=hidden";
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackReferrers: true,
        routeTemplates: ["/checkout"] } });
    await sdk.flush();
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    const first = (JSON.parse(String((posts[0] as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ payload: { acquisition: unknown } }>
    }).events[0];
    expect(first?.payload.acquisition).toEqual({
      landing_route: { normalized_path: "/checkout" }, referrer_domain: "partner.example",
      utm_source: "partner", utm_medium: null, utm_campaign: "launch"
    });
    expect(JSON.stringify(first)).not.toContain("auth=hidden");
    expect(JSON.stringify(first)).not.toContain("token=secret");
    sdk.analytics.track("signup.completed", {}, { eventRevision: 1 });
    await sdk.flush();
    const nextPost = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")[1];
    const next = (JSON.parse(String((nextPost as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ payload: { acquisition: unknown } }>
    }).events[0];
    expect(next?.payload.acquisition).toBeNull();
    sdk.dispose();
  });

  it("keeps the consented landing touch when the route changes before the first admitted fact", async () => {
    const globals = installBrowserGlobals();
    const location = { href: "https://example.com/checkout?utm_source=partner",
      pathname: "/checkout", search: "?utm_source=partner" };
    vi.stubGlobal("location", location);
    globals.documentTarget.referrer = "https://partner.example/start";
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackReferrers: true,
        routeTemplates: ["/checkout", "/pricing"] } });
    await sdk.flush();
    location.href = "https://example.com/pricing?utm_source=later";
    location.pathname = "/pricing";
    location.search = "?utm_source=later";
    globals.documentTarget.referrer = "https://other.example/page";
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    const post = globals.fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    const first = (JSON.parse(String((post as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ payload: { acquisition: unknown } }>
    }).events[0];
    expect(first?.payload.acquisition).toEqual({
      landing_route: { normalized_path: "/checkout" }, referrer_domain: "partner.example",
      utm_source: "partner", utm_medium: null, utm_campaign: null
    });
    sdk.dispose();
  });

  it("does not snapshot attribution before explicit consent", async () => {
    const globals = installBrowserGlobals();
    const location = { href: "https://example.com/checkout?utm_source=partner",
      pathname: "/checkout", search: "?utm_source=partner" };
    vi.stubGlobal("location", location);
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics({ consent_required: true })
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const referrerRead = vi.fn(() => "https://partner.example/start");
    Object.defineProperty(globals.documentTarget, "referrer", { get: referrerRead, configurable: true });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", consentRequired: true,
        trackReferrers: true, routeTemplates: ["/checkout", "/pricing"] } });
    await sdk.flush();
    expect(referrerRead).not.toHaveBeenCalled();
    location.href = "https://example.com/pricing?utm_source=later";
    location.pathname = "/pricing";
    location.search = "?utm_source=later";
    sdk.analytics.setConsent(true);
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    const post = globals.fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
    const first = (JSON.parse(String((post as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ payload: { acquisition: unknown } }>
    }).events[0];
    expect(first?.payload.acquisition).toMatchObject({
      landing_route: { normalized_path: "/pricing" }, referrer_domain: "partner.example",
      utm_source: "later"
    });
    expect(referrerRead).toHaveBeenCalledTimes(1);
    sdk.dispose();
  });

  it("does not traverse referrer or query sources when V2 acquisition is off", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackReferrers: false } });
    await sdk.flush();
    const referrerRead = vi.fn(() => { throw new Error("referrer read"); });
    const queryRead = vi.fn(() => { throw new Error("query read"); });
    Object.defineProperty(globals.documentTarget, "referrer", { get: referrerRead, configurable: true });
    Object.defineProperty(globalThis.location, "search", { get: queryRead, configurable: true });
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    expect(referrerRead).not.toHaveBeenCalled();
    expect(queryRead).not.toHaveBeenCalled();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = String((posts[0] as [unknown, { body?: unknown }])[1].body);
    const event = (JSON.parse(body) as { events: Array<{ payload: { acquisition: unknown } }> }).events[0];
    expect(event?.payload.acquisition).toBeNull();
    sdk.dispose();
  });

  it("keeps first-touch acquisition for the next admitted event after a transport drop", async () => {
    const globals = installBrowserGlobals();
    const location = { href: "https://example.com/checkout?utm_source=partner",
      pathname: "/checkout", search: "?utm_source=partner" };
    vi.stubGlobal("location", location);
    globals.documentTarget.referrer = "https://partner.example/start";
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackReferrers: true,
        routeTemplates: ["/checkout", "/pricing"] } });
    await sdk.flush();
    const transport = (sdk as unknown as { eventTransport: {
      enqueueAnalytics(event: unknown): boolean
    } }).eventTransport;
    const enqueue = transport.enqueueAnalytics.bind(transport);
    const admission = vi.spyOn(transport, "enqueueAnalytics")
      .mockReturnValueOnce(false)
      .mockImplementation(enqueue);
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    location.href = "https://example.com/pricing?utm_source=later";
    location.pathname = "/pricing";
    location.search = "?utm_source=later";
    sdk.analytics.track("signup.completed", {}, { eventRevision: 1 });
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    const event = (JSON.parse(String((posts[0] as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ payload: { name: string; acquisition: unknown } }>
    }).events[0];
    expect(event?.payload.name).toBe("signup.completed");
    expect(event?.payload.acquisition).toMatchObject({
      landing_route: { normalized_path: "/checkout" }, utm_source: "partner"
    });
    expect(admission).toHaveBeenCalledTimes(2);
    sdk.dispose();
  });

  it("retries the first touch on a later fact after a terminal indexed rejection", async () => {
    const globals = installBrowserGlobals();
    vi.stubGlobal("location", { href: "https://example.com/checkout?utm_source=partner",
      pathname: "/checkout", search: "?utm_source=partner" });
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValueOnce({ status: 202,
      json: async () => ({ accepted: 0, rejected: 1,
        errors: [{ index: 0, reason: "unknown_event" }] }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", trackReferrers: true,
        routeTemplates: ["/checkout"] } });
    await sdk.flush();
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    expect(sdk.analytics.getStatus()).toMatchObject({ mode: "semantic", semantic: {
      last_receipt: { accepted: 0, retryable: 0, terminal: 1 }
    } });
    sdk.analytics.track("signup.completed", {}, { eventRevision: 1 });
    await sdk.flush();
    expect(sdk.analytics.getStatus()).toMatchObject({ mode: "semantic", semantic: {
      last_receipt: { accepted: 1, retryable: 0, terminal: 0 }
    } });
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(2);
    const events = posts.map((call) => (JSON.parse(String((call as [unknown, { body?: unknown }])[1].body)) as {
      events: Array<{ payload: { name: string; acquisition: unknown } }>
    }).events[0]);
    expect(events.map((event) => event?.payload.name)).toEqual(["signup.started", "signup.completed"]);
    expect(events[0]?.payload.acquisition).toMatchObject({ utm_source: "partner" });
    expect(events[1]?.payload.acquisition).toMatchObject({ utm_source: "partner" });
    sdk.dispose();
  });

  it("routes explicit V2 page views through the safe path without reading titles or disabled input", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics()
    }) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", routeTemplates: ["/pricing"] } });
    await sdk.flush();
    const titleRead = vi.fn(() => { throw new Error("title read"); });
    sdk.analytics.pageView({ path: "/pricing?private=secret", get title() { return titleRead(); } });
    sdk.analytics.pageView({ path: "/pricing", get title() { return titleRead(); } });
    await sdk.flush();
    expect(titleRead).not.toHaveBeenCalled();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = String((posts[0] as [unknown, { body?: unknown }])[1].body);
    const events = (JSON.parse(body) as { events: Array<{ payload: { kind: string; route: unknown } }> }).events;
    expect(events.map((event) => event.payload)).toMatchObject([
      { kind: "page_view", route: { normalized_path: "/pricing" } }
    ]);
    expect(JSON.stringify(events)).not.toContain("private=secret");
    sdk.analytics.setConsent(false);
    const pathRead = vi.fn(() => { throw new Error("path read"); });
    sdk.analytics.pageView({ get path() { return pathRead(); } });
    expect(pathRead).not.toHaveBeenCalled();
    sdk.dispose();
  });

  it("drops protected pending capture when current remote analytics settings disable capture", async () => {
    const globals = installBrowserGlobals();
    let resolveConfig!: (value: unknown) => void;
    globals.fetchMock.mockReturnValueOnce(new Promise<unknown>((resolve) => { resolveConfig = resolve; }));
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    const configRequest = globals.fetchMock.mock.calls.find((call) => call[1]?.method === "GET");
    expect(configRequest?.[1]?.headers).toMatchObject({
      "x-debugbundle-analytics-schema": "2026-09-analytics-02",
      "x-debugbundle-analytics-config": "1"
    });
    resolveConfig({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics({ enabled: false })
    }) });
    await new Promise((resolve) => setTimeout(resolve, 0));
    sdk.analytics.track("signup.completed", {}, { eventRevision: 1 });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });

  it("requires explicit consent when current remote settings tighten the V2 grant", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({
      ...capability(), analytics: remoteAnalytics({ consent_required: true })
    }) });
    globals.fetchMock.mockResolvedValueOnce({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    await sdk.flush();
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.analytics.setConsent(true);
    sdk.analytics.track("signup.completed", {}, { eventRevision: 1 });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    sdk.dispose();
  });

  it("rejects capture before reading caller input when capability is disabled or consent is revoked", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValue({ status: 200, json: async () => capability(false) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct",
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" }, captureNetwork: false });
    await sdk.flush();
    const getter = vi.fn(() => "unsafe");
    sdk.analytics.track("signup.completed", { get secret() { return getter(); } }, { eventRevision: 1 });
    sdk.analytics.setConsent(false);
    sdk.analytics.track("signup.completed", { get secret() { return getter(); } }, { eventRevision: 1 });
    await sdk.flush();
    expect(getter).not.toHaveBeenCalled();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });

  it("fences an expired capability before dispatch while debug capture still works", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => capability(true, 30) });
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", transport,
      batchSize: 256, flushInterval: 60_000, captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    await sdk.flush();
    sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await sdk.flush();
    expect(transport).not.toHaveBeenCalled();
    sdk.captureMessage("debug survives V2 expiry", "error");
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    sdk.dispose();
  });

  it("keeps V2 batches within the negotiated event count", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200,
      json: async () => capability(true, 60_000, 1) });
    globals.fetchMock.mockResolvedValue({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct",
      batchSize: 256, flushInterval: 60_000, captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    await sdk.flush();
    sdk.analytics.track("signup.started", { method: "email" }, { eventRevision: 1 });
    sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(2);
    for (const post of posts) {
      const body = String((post as [unknown, { body?: unknown }])[1].body);
      expect((JSON.parse(body) as { events: unknown[] }).events).toHaveLength(1);
    }
    sdk.dispose();
  });

  it("does not accept an enabled capability carried by a failed config response", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValue({ status: 503, json: async () => capability() });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    await sdk.flush();
    sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });

  it("ignores a previous initialization's late enabled capability", async () => {
    const globals = installBrowserGlobals();
    let resolveOld!: (value: unknown) => void;
    const oldResponse = new Promise<unknown>((resolve) => { resolveOld = resolve; });
    globals.fetchMock.mockReturnValueOnce(oldResponse);
    globals.fetchMock.mockResolvedValueOnce({ status: 200, json: async () => capability(false) });
    const sdk = createDebugBundleBrowserSdk();
    const config = { transportMode: "direct" as const, captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" as const } };
    sdk.init({ ...config, projectToken: "dbundle_proj_old" });
    sdk.init({ ...config, projectToken: "dbundle_proj_new" });
    resolveOld({ status: 200, json: async () => capability() });
    await sdk.flush();
    sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });

  it("retains a protected first manual fact only until startup capability resolves", async () => {
    const globals = installBrowserGlobals();
    let resolveConfig!: (value: unknown) => void;
    globals.fetchMock.mockReturnValueOnce(new Promise<unknown>((resolve) => { resolveConfig = resolve; }));
    globals.fetchMock.mockResolvedValueOnce({ status: 202,
      json: async () => ({ accepted: 1, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    const properties = { method: "email" };
    sdk.analytics.track("signup.completed", properties, { eventRevision: 1 });
    properties.method = "changed";
    resolveConfig({ status: 200, json: async () => capability() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sdk.flush();
    const posts = globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    const body = String((posts[0] as [unknown, { body?: unknown }])[1].body);
    expect((JSON.parse(body) as { events: Array<{payload:{properties:Record<string,unknown>}}> })
      .events[0]?.payload.properties).toEqual({ method: "email" });
    sdk.dispose();
  });

  it("bounds protected pre-capability records and clears them on consent withdrawal", async () => {
    const globals = installBrowserGlobals();
    let resolveConfig!: (value: unknown) => void;
    globals.fetchMock.mockReturnValueOnce(new Promise<unknown>((resolve) => { resolveConfig = resolve; }));
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", transport,
      captureNetwork: false, batchSize: 256, flushInterval: 60_000,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    for (let index = 0; index < 20; index += 1)
      sdk.analytics.track(`signup.${index}`, { method: "email" }, { eventRevision: 1 });
    resolveConfig({ status: 200, json: async () => capability() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sdk.flush();
    expect(transport.mock.calls.flatMap((call) => (call[0] as { events: unknown[] }).events)).toHaveLength(16);
    sdk.dispose();

    const nextGlobals = installBrowserGlobals();
    let resolveNext!: (value: unknown) => void;
    nextGlobals.fetchMock.mockReturnValueOnce(new Promise<unknown>((resolve) => { resolveNext = resolve; }));
    const nextTransport = vi.fn().mockResolvedValue({ status: 202 });
    const next = createDebugBundleBrowserSdk();
    next.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", transport: nextTransport,
      captureNetwork: false, analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    next.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    next.analytics.setConsent(false);
    resolveNext({ status: 200, json: async () => capability() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await next.flush();
    expect(nextTransport).not.toHaveBeenCalled();
    next.dispose();
  });

  it("coalesces an on-demand config refresh after expiry and sends protected pending work", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200,
      json: async () => capability(true, 60_000, 256, 1) });
    globals.fetchMock.mockResolvedValueOnce({ status: 200,
      json: async () => capability(true, 60_000, 256, 1) });
    globals.fetchMock.mockResolvedValueOnce({ status: 202,
      json: async () => ({ accepted: 2, rejected: 0, errors: [] }) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    await sdk.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const current = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(current + 61_000);
    sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "GET")).toHaveLength(2);
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(1);
    sdk.dispose();
  });

  it("makes the same V2 session sampling decision without a random draw", async () => {
    const decisions: number[] = [];
    for (const randomDraw of [0.1, 0.9]) {
      const globals = installBrowserGlobals();
      vi.spyOn(Math, "random").mockReturnValue(randomDraw);
      globals.fetchMock.mockResolvedValue({ status: 200,
        json: async () => capability(true, 60_000, 256, 0.5) });
      const transport = vi.fn().mockResolvedValue({ status: 202 });
      const sdk = createDebugBundleBrowserSdk();
      sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", transport,
        captureNetwork: false, analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
      await sdk.flush();
      sdk.analytics.track("signup.completed", { method: "email" }, { eventRevision: 1 });
      await sdk.flush();
      decisions.push(transport.mock.calls.length);
      sdk.dispose();
    }
    expect(decisions[0]).toBe(decisions[1]);
  });

  it("does not let remote V2 sampling widen a locally sampled-out session", async () => {
    const globals = installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({ status: 200,
      json: async () => capability(true, 60_000, 256, 1) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02", sampleRate: 0,
        trackPageViews: true, routeTemplates: ["/checkout"] } });
    await sdk.flush();
    expect(sdk.analytics.getStatus()).toMatchObject({ mode: "semantic", semantic: {
      state: "sampled_out"
    } });
    let reads = 0;
    sdk.analytics.track("signup.started", { get privateValue() { reads += 1; return "secret"; } },
      { eventRevision: 1 });
    await sdk.flush();
    expect(reads).toBe(0);
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });

  it("expires a V2 capability by elapsed time even if the wall clock moves backward", async () => {
    const globals = installBrowserGlobals();
    let elapsed = 1_000;
    vi.stubGlobal("performance", { now: () => elapsed });
    globals.fetchMock.mockResolvedValueOnce({ status: 200,
      json: async () => capability(true, 60_000) });
    const sdk = createDebugBundleBrowserSdk();
    sdk.init({ projectToken: "dbundle_proj_browser", transportMode: "direct", captureNetwork: false,
      analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" } });
    await sdk.flush();
    expect(sdk.analytics.getStatus()).toMatchObject({ mode: "semantic", semantic: {
      state: "enabled"
    } });
    const current = Date.now();
    elapsed += 61_000;
    vi.spyOn(Date, "now").mockReturnValue(current - 60_000);
    expect(sdk.analytics.getStatus()).toMatchObject({ mode: "semantic", semantic: {
      state: "expired"
    } });
    sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    await sdk.flush();
    expect(globals.fetchMock.mock.calls.filter((call) => call[1]?.method === "POST")).toHaveLength(0);
    sdk.dispose();
  });
});
