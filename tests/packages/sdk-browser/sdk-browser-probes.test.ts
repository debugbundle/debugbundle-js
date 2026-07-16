import { describe, expect, it, vi } from "vitest";

import * as browserFixtures from "../../helpers/sdk-browser-fixtures.js";

describe("sdk-browser probes", () => {
  it("should buffer probes locally and flush them inline with frontend exceptions", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk();

    sdk.probe("checkout.pricing.tax", {
      total: 42,
      authorization: "Bearer secret-token"
    });
    sdk.probe("checkout.inventory", {
      sku: "sku_123",
      stock: 4
    });

    expect(transport).not.toHaveBeenCalled();

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.pricing.tax",
          activation_id: null,
          data: {
            total: 42,
            authorization: "[REDACTED]"
          }
        }),
        expect.objectContaining({
          label: "checkout.inventory",
          activation_id: null,
          data: {
            sku: "sku_123",
            stock: 4
          }
        })
      ]
    });

    sdk.captureException(new Error("Exploded again"));
    await sdk.flush();

    const secondEvent = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 1)[0]);
    expect(secondEvent.payload.probe_data).toEqual({
      version: 1,
      items: []
    });
  });

  it("should enforce bounded probe label and entry buffers", async (): Promise<void> => {
    const { sdk, transport } = browserFixtures.createSdk({
      maxProbeLabels: 1,
      maxProbeEntriesPerLabel: 2
    });

    sdk.probe("checkout.pricing.tax", { total: 40 });
    sdk.probe("checkout.pricing.tax", { total: 41 });
    sdk.probe("checkout.pricing.tax", { total: 42 });
    sdk.probe("checkout.inventory", { sku: "sku_123" });

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const event = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.pricing.tax",
          data: { total: 41 }
        }),
        expect.objectContaining({
          label: "checkout.pricing.tax",
          data: { total: 42 }
        })
      ]
    });
  });

  it("should emit remote probe_event entries when directives match and still keep local buffers", async (): Promise<void> => {
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    sdk.probe("checkout.ui.cart-render", {
      renderTime: 42,
      token: "secret"
    });
    await sdk.flush();

    const probeEvent = browserFixtures.getProbeEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(probeEvent.payload).toEqual({
      label: "checkout.ui.cart-render",
      data: {
        renderTime: 42,
        token: "[REDACTED]"
      },
      activation_id: "11111111-1111-4111-8111-111111111111",
      probe_label_pattern: "checkout.ui.*"
    });

    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    const exceptionEvent = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 1)[0]);
    expect(exceptionEvent.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.ui.cart-render",
          activation_id: null,
          data: {
            renderTime: 42,
            token: "[REDACTED]"
          }
        })
      ]
    });
  });

  it("should activate matching probes from _debug_probe for the current page load and strip the URL", async (): Promise<void> => {
    const globals = browserFixtures.installBrowserGlobals();
    const projectId = "proj_123";
    const triggerTokenKey = browserFixtures.deriveProbeTriggerTokenKey(projectId);
    const triggerToken = browserFixtures.generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-web",
        environment: "production",
        trigger_expires_at: "2036-03-20T00:00:00.000Z"
      }
    }).plaintext;
    globals.fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        probes_enabled: true,
        remote_probes_enabled: true,
        active_probes: [],
        poll_interval_ms: 60000,
        trigger_token_key: triggerTokenKey
      })
    });
    vi.stubGlobal(
      "location",
      {
        href: `https://example.com/checkout?_debug_probe=${triggerToken}`,
        pathname: "/checkout",
        search: `?_debug_probe=${triggerToken}`
      } as unknown
    );

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

    await browserFixtures.settleBrowserTriggerActivation();

    sdk.probe("checkout.ui.tax", { total: 42 });
    await sdk.flush();

    expect(
      browserFixtures.createTransportEvents(transport, 0).find(
        (event) => event.event_type === "probe_event" && event.payload.probe_label_pattern === "checkout.*"
      )
    ).toBeDefined();
    expect(globals.historyCalls).toContain("replace:/checkout");
  });

  it("should keep remote probe events sampled out with the session while allowing exception flushes", async (): Promise<void> => {
    vi.spyOn(Math, "random").mockReturnValue(0.95);

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
      transport,
      sessionSampleRate: 0.5
    });

    await Promise.resolve();
    await Promise.resolve();

    sdk.probe("checkout.ui.cart-render", { renderTime: 42 });
    sdk.captureException(new Error("Checkout exploded"));
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["frontend_exception"]);

    const exceptionEvent = browserFixtures.getFrontendExceptionEvent(browserFixtures.createTransportEvents(transport, 0)[0]);
    expect(exceptionEvent.payload.probe_data).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.ui.cart-render",
          activation_id: null,
          data: { renderTime: 42 }
        })
      ]
    });
  });

  it("should let remote probe events bypass the max events per session cap", async (): Promise<void> => {
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
      transport,
      maxEventsPerSession: 1
    });

    await Promise.resolve();
    await Promise.resolve();

    sdk.captureMessage("first browser log", "warning");
    sdk.probe("checkout.ui.cart-render", { renderTime: 42 });
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event", "probe_event"]);
  });

  it("should prune expired remote directives before later probe matches", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));

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
            expires_at: "2026-03-15T00:00:01.000Z",
            trigger_expires_at: "2026-03-15T00:00:01.000Z"
          }
        ],
        poll_interval_ms: 60000
      })
    });

    const transport = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        accepted: 1,
        rejected: 0,
        errors: []
      }
    });
    const sdk = browserFixtures.createDebugBundleBrowserSdk();
    browserFixtures.activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_browser",
      service: "checkout-web",
      environment: "production",
      flushInterval: 60_000,
      transport
    });

    await Promise.resolve();
    await Promise.resolve();

    vi.advanceTimersByTime(2_000);

    sdk.captureMessage("force remote state maintenance", "warning");
    await sdk.flush();
    sdk.probe("checkout.ui.cart-render", { renderTime: 42 });
    await sdk.flush();

    expect(browserFixtures.createTransportEvents(transport, 0).map((event) => event.event_type)).toEqual(["log_event"]);
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
