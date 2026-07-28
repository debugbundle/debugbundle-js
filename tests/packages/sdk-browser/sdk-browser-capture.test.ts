import { describe, expect, it, vi } from "vitest";

import * as browserFixtures from "../../helpers/sdk-browser-fixtures.js";

describe("sdk-browser capture", () => {
  it("should allow beforeSend to mutate or drop browser events before transport", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk({
      beforeSend: (event) => {
        if (event.event_type === "log_event" && event.payload.message === "drop me") {
          return null;
        }

        if (event.event_type === "log_event") {
          return {
            ...event,
            payload: {
              ...event.payload,
              message: `filtered:${event.payload.message}`
            }
          };
        }

        return event;
      }
    });

    sdk.captureMessage("drop me", "error");
    sdk.captureMessage("keep me", "error");
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map(browserFixtures.getEventMessage)).toEqual(["filtered:keep me"]);
  });

  it("should keep the original browser event when beforeSend fails", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk({
      beforeSend: () => {
        throw new Error("hook failed");
      }
    });

    sdk.captureMessage("keep original", "error");
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map(browserFixtures.getEventMessage)).toEqual(["keep original"]);
  });

  it("should fetch sdk config exactly once on init without periodic polling", async (): Promise<void> => {
    vi.useFakeTimers();

    const globals = browserFixtures.installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [
          {
            activation_id: "11111111-1111-4111-8111-111111111111",
            label_pattern: "checkout.ui.*",
            service: "*",
            environment: "production",
            expires_at: "2036-03-20T00:00:00.000Z",
            trigger_expires_at: "2036-03-21T00:00:00.000Z"
          }
        ],
        poll_interval_ms: 60000
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

    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
    expect(globals.fetchMock.mock.calls[0]?.[0]).toBe("https://api.debugbundle.com/v1/sdk/config");
    expect(globals.fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      headers: {
        authorization: "Bearer dbundle_proj_browser"
      }
    });

    await vi.advanceTimersByTimeAsync(180_000);
    expect(globals.fetchMock).toHaveBeenCalledTimes(1);
  });

  it("should degrade silently when init config is invalid", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    void globals;

    const transport = vi.fn();
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    expect(() =>
      sdk.init({
        projectToken: "",
        service: "checkout-web",
        environment: "production",
        transport
      })
    ).not.toThrow();
    expect(() => sdk.captureException(new Error("boom"))).not.toThrow();
    expect(() => sdk.captureMessage("still-running", "error")).not.toThrow();
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });

  it("should keep compatibility aliases and scalar context safe with default service fields", async (): Promise<void> => {
    browserFixtures.installBrowserGlobals();
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.setContext("before-init", "ignored");
    sdk.captureRequest({ method: "GET", path: "/" });
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: " ",
      environment: " ",
      flushInterval: 60_000,
      transport
    });
    await browserFixtures.settleBrowserTriggerActivation();

    sdk.setContext(" ", "ignored");
    sdk.setContext("token", "secret");
    sdk.captureError(new Error("compatibility alias"));
    sdk.captureMessage("context event", "error");
    await sdk.flush();

    const events = browserFixtures.createTransportEvents(transport, 0);
    expect(events.map((event) => event.service)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "browser-app",
          environment: "development"
        })
      ])
    );
    expect(events.find((event) => event.event_type === "log_event")?.payload).toMatchObject({
      attributes: {
        token: "[REDACTED]"
      }
    });
  });

  it("should enable relay mode for relative endpoints without auth headers or embedded project tokens", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.init({
      endpoint: "/debugbundle/browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await browserFixtures.settleBrowserTriggerActivation();

    expect(globals.fetchMock).not.toHaveBeenCalled();

    sdk.captureException(new Error("relay mode failure"));
    await sdk.flush();

    const transportRequest = (transport.mock.calls as Array<[browserFixtures.DebugBundleBrowserTransportRequest]>)[0]?.[0];
    expect(transportRequest?.endpoint).toBe("/debugbundle/browser");
    expect(transportRequest?.transportMode).toBe("relay");
    expect(transportRequest?.headers).toEqual({
      "content-type": "application/json"
    });
    expect(transportRequest?.events).toHaveLength(1);
    expect(transportRequest?.events[0]).not.toHaveProperty("project_token");
  });

  it("should support explicit relay mode for absolute backend relay endpoints", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const transport = vi.fn().mockResolvedValue({ status: 202 });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.init({
      transportMode: "relay",
      endpoint: "https://api.example.test/debugbundle/browser",
      projectToken: "dbundle_proj_should_not_be_used_in_relay",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await browserFixtures.settleBrowserTriggerActivation();

    expect(globals.fetchMock).not.toHaveBeenCalled();

    sdk.captureException(new Error("cross-origin relay mode failure"));
    await sdk.flush();

    const transportRequest = (transport.mock.calls as Array<[browserFixtures.DebugBundleBrowserTransportRequest]>)[0]?.[0];
    expect(transportRequest?.endpoint).toBe("https://api.example.test/debugbundle/browser");
    expect(transportRequest?.transportMode).toBe("relay");
    expect(transportRequest?.headers).toEqual({
      "content-type": "application/json"
    });
    expect(transportRequest?.events[0]).not.toHaveProperty("project_token");
  });

  it("should stay disabled when neither endpoint nor project token is configured", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const transport = vi.fn();
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);

    sdk.init({
      service: "checkout-web",
      environment: "production",
      transport
    });

    sdk.captureException(new Error("disabled sdk"));
    await expect(sdk.flush()).resolves.toBeUndefined();

    expect(transport).not.toHaveBeenCalled();
    expect(globals.fetchMock).not.toHaveBeenCalled();
  });

  it("should keep breadcrumbs local until an exception ships them with privacy masking and device context", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk();

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "pay-now",
        textContent: "Upgrade to Team - $49/mo"
      }
    });
    globals.documentTarget.dispatch("submit", {
      target: {
        tagName: "FORM",
        id: "checkout-form",
        elements: [
          { name: "email", value: "owen@example.com" },
          { name: "credit_card_number", value: "4111111111111111" }
        ]
      }
    });
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout/payment");

    expect(transport).not.toHaveBeenCalled();

    sdk.captureException(new Error("Checkout exploded"), {
      target: {
        tagName: "BUTTON",
        id: "pay-now",
        outerHTML: '<button id="pay-now">Pay Now</button>'
      }
    });

    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.device).toEqual(
      expect.objectContaining({
        device_type: "desktop",
        language: "en-US",
        connection_type: "4g"
      })
    );
    expect(event.payload.dom_context).toEqual({
      mode: "lightweight",
      html_excerpt: '<button id="pay-now">Pay Now</button>'
    });
    const breadcrumbs = event.payload.breadcrumbs ?? [];
    expect(breadcrumbs).toHaveLength(3);
    expect(breadcrumbs[0]).toMatchObject({
      breadcrumb_type: "click",
      data: {
        selector: "button#pay-now"
      }
    });
    expect(breadcrumbs[0]?.data).not.toHaveProperty("text");
    expect(breadcrumbs[1]).toMatchObject({
      breadcrumb_type: "form_submit",
      data: {
        form: "form#checkout-form",
        field_count: 2
      }
    });
    expect(breadcrumbs[1]?.data).not.toHaveProperty("fields");
    expect(breadcrumbs[2]).toMatchObject({
      breadcrumb_type: "route_change",
      route: "/checkout/payment"
    });
  });

  it("captures opaque window error metadata without blaming the SDK fallback", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk();

    globals.windowTarget.dispatch("error", {
      filename: "https://user:secret@app.example/assets/app.js?token=secret#bootstrap",
      lineno: 42,
      colno: 9
    });

    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.message).toBe("Window error");
    expect((event.payload as Record<string, unknown>)["browser_event"]).toEqual({
      kind: "window_error",
      message: null,
      file_name: "https://app.example/assets/app.js",
      line_number: 42,
      column_number: 9,
      target: null,
      page: {
        url: "https://example.com/checkout",
        referrer: "https://example.com/start",
        ready_state: "interactive",
        visibility_state: "visible"
      },
      opaque: true
    });
  });

  it("captures structured unhandled rejection reasons", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk();

    globals.windowTarget.dispatch("unhandledrejection", {
      reason: {
        name: "AnalyticsRejected",
        message: "Google Analytics request failed"
      }
    });

    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.message).toBe("Google Analytics request failed");
    expect((event.payload as Record<string, unknown>)["rejection_reason"]).toEqual({
      kind: "object",
      name: "AnalyticsRejected",
      message: "Google Analytics request failed",
      preview: "Object"
    });
  });

  it("captures resource load error targets from the window error hook", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk();

    globals.windowTarget.dispatch("error", {
      target: {
        tagName: "SCRIPT",
        src: "https://cdn.example/app.js?access_token=secret#chunk",
        crossOrigin: "anonymous",
        async: true,
        defer: false,
        integrity: "sha384-secret"
      }
    });

    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.message).toBe("Browser resource load error");
    expect((event.payload as Record<string, unknown>)["browser_event"]).toEqual({
      kind: "resource_error",
      message: null,
      file_name: null,
      line_number: null,
      column_number: null,
      target: {
        tag_name: "script",
        source_url: "https://cdn.example/app.js",
        attributes: {
          cross_origin: "anonymous",
          async: true,
          defer: false,
          integrity_present: true
        }
      },
      page: {
        url: "https://example.com/checkout",
        referrer: "https://example.com/start",
        ready_state: "interactive",
        visibility_state: "visible"
      },
      opaque: true
    });
  });

  it("demotes matching resource load exceptions into breadcrumb context after sdk config loads", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_rules: [
          {
            id: "00000000-0000-4000-8000-000000000101",
            project_id: "proj_123",
            name: "Demote CDN resource noise",
            description: null,
            enabled: true,
            action: "demote",
            matcher: {
              event_types: ["frontend_exception"],
              browser_event_kind: "resource_error",
              resource_url: { host: "cdn.example" }
            },
            sample_rate: null,
            sample_event_class: null,
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
      breadcrumbsOnErrorOnly: false,
      transport
    });

    await browserFixtures.settleAsyncInit();
    globals.windowTarget.dispatch("error", {
      target: {
        tagName: "SCRIPT",
        src: "https://cdn.example/app.js?access_token=secret#chunk"
      }
    });

    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    const event = browserFixtures.getFrontendBreadcrumbEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.data).toMatchObject({
      source: "capture_rule_demoted_exception",
      browser_event_kind: "resource_error",
      source_url: "https://cdn.example/app.js"
    });
  });

  it("demotes matching bot-scoped unhandled rejections after sdk config loads", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    vi.stubGlobal(
      "navigator",
      {
        userAgent:
          "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 Chrome/148.0.0.0 Mobile Safari/537.36 Googlebot/2.1",
        language: "en-US",
        maxTouchPoints: 1,
        sendBeacon: globals.sendBeacon
      } as unknown
    );
    globals.fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_rules: [
          {
            id: "00000000-0000-4000-8000-000000000103",
            project_id: "proj_123",
            name: "Demote Googlebot rejection noise",
            description: null,
            enabled: true,
            action: "demote",
            matcher: {
              event_types: ["frontend_exception"],
              client_kind: "bot",
              bot_family: "Googlebot",
              message_equals: "Unhandled promise rejection"
            },
            sample_rate: null,
            sample_event_class: null,
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
      breadcrumbsOnErrorOnly: false,
      transport
    });

    await browserFixtures.settleAsyncInit();
    globals.windowTarget.dispatch("unhandledrejection", {
      reason: new Error("Unhandled promise rejection")
    });

    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_breadcrumb"]);
    const event = browserFixtures.getFrontendBreadcrumbEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.data).toMatchObject({
      source: "capture_rule_demoted_exception",
      capture_rule_outcome: "demote"
    });
  });

  it("drops sampled-out resource load exceptions after sdk config loads", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    globals.fetchMock.mockResolvedValueOnce({
      status: 200,
      json: async () => ({
        probes_enabled: false,
        remote_probes_enabled: false,
        active_probes: [],
        capture_rules: [
          {
            id: "00000000-0000-4000-8000-000000000102",
            project_id: "proj_123",
            name: "Sample out CDN resource noise",
            description: null,
            enabled: true,
            action: "sample",
            matcher: {
              event_types: ["frontend_exception"],
              browser_event_kind: "resource_error",
              resource_url: { host: "cdn.example" }
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
    globals.windowTarget.dispatch("error", {
      target: {
        tagName: "SCRIPT",
        src: "https://cdn.example/app.js?access_token=secret#chunk"
      }
    });

    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();
  });

  it("should honor breadcrumb caps and capture toggles", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      maxBreadcrumbs: 2,
      captureClicks: true,
      captureRouteChanges: false
    });

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "first",
        textContent: "First"
      }
    });
    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "second",
        textContent: "Second"
      }
    });
    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "third",
        textContent: "Third"
      }
    });
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout/review");

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    const breadcrumbs = event.payload.breadcrumbs ?? [];
    expect(breadcrumbs).toHaveLength(2);
    expect(breadcrumbs[0]?.breadcrumb_type).toBe("click");
    expect(breadcrumbs[0]?.data["selector"]).toBe("button#second");
    expect(breadcrumbs[1]?.breadcrumb_type).toBe("click");
    expect(breadcrumbs[1]?.data["selector"]).toBe("button#third");
  });

  it("should ship standalone frontend_breadcrumb events when breadcrumbsOnErrorOnly is false", async (): Promise<void> => {
    const { sdk, transport, globals } = browserFixtures.createSdk({
      breadcrumbsOnErrorOnly: false
    });

    globals.documentTarget.dispatch("click", {
      target: {
        tagName: "BUTTON",
        id: "apply-coupon",
        textContent: "Apply"
      }
    });
    globals.documentTarget.dispatch("submit", {
      target: {
        tagName: "FORM",
        id: "coupon-form",
        elements: [{ name: "code", value: "SAVE10" }]
      }
    });
    ((globalThis as Record<string, unknown>)["history"] as {
      pushState: (state: unknown, title: string, url?: string | URL | null) => void;
    }).pushState({}, "", "/checkout/review");

    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
      "frontend_breadcrumb",
      "frontend_breadcrumb",
      "frontend_breadcrumb"
    ]);

    const clickEvent = browserFixtures.getFrontendBreadcrumbEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(clickEvent.payload).toEqual({
      breadcrumb_type: "click",
      route: "/checkout",
      data: {
        selector: "button#apply-coupon"
      }
    });

    const submitEvent = browserFixtures.getFrontendBreadcrumbEvent(browserFixtures.createTransportEvents(transport, 0)[1]);
    expect(submitEvent.payload).toEqual({
      breadcrumb_type: "form_submit",
      route: "/checkout",
      data: {
        form: "form#coupon-form",
        field_count: 1
      }
    });

    const routeEvent = browserFixtures.getFrontendBreadcrumbEvent(browserFixtures.createTransportEvents(transport, 0)[2]);
    expect(routeEvent.payload).toEqual({
      breadcrumb_type: "route_change",
      route: "/checkout/review",
      data: {
        route: "/checkout/review"
      }
    });

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const exceptionEvent = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 1)[0]);
    expect(exceptionEvent.payload.breadcrumbs ?? []).toHaveLength(0);
  });

});
