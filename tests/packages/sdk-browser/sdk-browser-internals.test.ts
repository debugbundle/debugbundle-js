import { describe, expect, it, vi } from "vitest";

import { BrowserSdk } from "../../../packages/sdk-browser/src/index.js";
import {
  BrowserProbeController,
  matchesProbeLabelPattern,
  normalizeProbeInput
} from "../../../packages/sdk-browser/src/probes.js";
import type { DebugBundleBrowserTransportRequest, DebugBundleBrowserTransportResponse } from "../../../packages/sdk-browser/src/types.js";

describe("sdk-browser internals", () => {
  it("should normalize primitive probe inputs and preserve object inputs", (): void => {
    expect(normalizeProbeInput(null)).toEqual({ value: null });
    expect(normalizeProbeInput([1, 2])).toEqual({ value: [1, 2] });
    expect(normalizeProbeInput("ok")).toEqual({ value: "ok" });
    expect(normalizeProbeInput({ total: 42 })).toEqual({ total: 42 });
  });

  it("should match wildcard, prefix, exact, and non-matching probe labels", (): void => {
    expect(matchesProbeLabelPattern("*", "checkout.ui.cart")).toBe(true);
    expect(matchesProbeLabelPattern("checkout.ui.*", "checkout.ui")).toBe(true);
    expect(matchesProbeLabelPattern("checkout.ui.*", "checkout.ui.cart")).toBe(true);
    expect(matchesProbeLabelPattern("checkout.tax", "checkout.tax")).toBe(true);
    expect(matchesProbeLabelPattern("checkout.tax", "checkout.total")).toBe(false);
  });

  it("should filter matching remote directives by config, expiry, and active trigger directives", (): void => {
    const config = {
      service: "checkout-web",
      environment: "production"
    };
    const controller = new BrowserProbeController({
      getConfig: () => config as never,
      isDebugRejected: () => false,
      isSessionSampledIn: () => true,
      emitProbeEvent: () => undefined,
      applyRemoteAnalytics: () => undefined
    }) as unknown as {
      remoteState: {
        probesEnabled: boolean;
        remoteProbesEnabled: boolean;
        directives: Array<{
          activationId: string;
          labelPattern: string;
          service: string;
          environment: string;
          expiresAt: string;
          triggerExpiresAt: string | null;
        }>;
        triggerTokenKey: string | null;
      };
      activeTriggerDirective: {
        activationId: string;
        labelPattern: string;
        service: string;
        environment: string;
        expiresAt: string;
        triggerExpiresAt: string | null;
      } | null;
      getMatchingDirectives: (label: string, nowMs: number) => Array<{ activationId: string }>;
    };

    controller.remoteState = {
      probesEnabled: true,
      remoteProbesEnabled: true,
      directives: [
        {
          activationId: "expired",
          labelPattern: "checkout.ui.*",
          service: "checkout-web",
          environment: "production",
          expiresAt: "2026-03-15T00:00:00.000Z",
          triggerExpiresAt: null
        },
        {
          activationId: "service-mismatch",
          labelPattern: "checkout.ui.*",
          service: "billing-web",
          environment: "production",
          expiresAt: "2026-03-20T00:00:00.000Z",
          triggerExpiresAt: null
        },
        {
          activationId: "env-mismatch",
          labelPattern: "checkout.ui.*",
          service: "checkout-web",
          environment: "staging",
          expiresAt: "2026-03-20T00:00:00.000Z",
          triggerExpiresAt: null
        },
        {
          activationId: "prefix-match",
          labelPattern: "checkout.ui.*",
          service: "checkout-web",
          environment: "production",
          expiresAt: "2026-03-20T00:00:00.000Z",
          triggerExpiresAt: null
        }
      ],
      triggerTokenKey: null
    };
    controller.activeTriggerDirective = {
      activationId: "exact-match",
      labelPattern: "checkout.ui.tax",
      service: "checkout-web",
      environment: "production",
      expiresAt: "2026-03-20T00:00:00.000Z",
      triggerExpiresAt: null
    };

    expect(controller.getMatchingDirectives("checkout.ui.tax", Date.parse("2026-03-14T00:00:00.000Z"))).toHaveLength(3);
    expect(controller.getMatchingDirectives("checkout.ui.tax", Date.parse("2026-03-16T00:00:00.000Z"))).toEqual([
      expect.objectContaining({ activationId: "prefix-match" }),
      expect.objectContaining({ activationId: "exact-match" })
    ]);
  });
});

describe("sdk-browser health status", () => {
  function createInitedSdk(
    transportFn: (req: DebugBundleBrowserTransportRequest) => Promise<DebugBundleBrowserTransportResponse>
  ): BrowserSdk {
    const sdk = new BrowserSdk();
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "test-app",
      environment: "test",
      flushInterval: 60_000,
      transport: transportFn
    });
    return sdk;
  }

  it("should report disconnected before init", () => {
    const sdk = new BrowserSdk();
    expect(sdk.status).toBe("disconnected");
    expect(sdk.lastEventAt).toBeNull();
  });

  it("should report healthy after init with no events", () => {
    const sdk = createInitedSdk(async () => ({ status: 202 }));
    expect(sdk.status).toBe("healthy");
    expect(sdk.lastEventAt).toBeNull();
    sdk.dispose();
  });

  it("should report healthy and set lastEventAt after successful flush", async () => {
    const sdk = createInitedSdk(async () => ({ status: 202 }));
    sdk.captureException(new Error("test-error"));
    await sdk.flush();
    expect(sdk.status).toBe("healthy");
    expect(sdk.lastEventAt).toBeTypeOf("number");
    sdk.dispose();
  });

  it("should retry only the indexed retryable browser event", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({
        status: 202,
        retry_after_ms: 0,
        body: {
          accepted: 1,
          rejected: 1,
          errors: [{ index: 1, reason: "analytics_quota_exceeded" }]
        }
      })
      .mockResolvedValueOnce({
        status: 202,
        body: { accepted: 1, rejected: 0, errors: [] }
      });
    const sdk = createInitedSdk(transport);
    sdk.captureMessage("accepted", "error");
    sdk.captureMessage("retry", "error");

    await sdk.flush();
    expect(sdk.status).toBe("degraded");
    expect(sdk.lastEventAt).toBeTypeOf("number");

    await sdk.flush();
    const secondRequest = transport.mock.calls[1]?.[0] as DebugBundleBrowserTransportRequest;
    expect(secondRequest.events).toHaveLength(1);
    expect(secondRequest.events[0]?.payload).toMatchObject({ message: "retry" });
    expect(sdk.status).toBe("healthy");
    sdk.dispose();
  });

  it("should not report an all-terminally-rejected browser batch as delivered", async () => {
    const transport = vi.fn().mockResolvedValue({
      status: 202,
      body: {
        accepted: 0,
        rejected: 1,
        errors: [{ index: 0, reason: "capture_policy_rejected" }]
      }
    });
    const sdk = createInitedSdk(transport);
    sdk.captureMessage("terminal", "error");

    await sdk.flush();

    expect(sdk.status).toBe("disconnected");
    expect(sdk.lastEventAt).toBeNull();
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    sdk.dispose();
  });

  it("should retain a browser batch after an inconsistent acknowledgement", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({
        status: 202,
        retry_after_ms: 0,
        body: { accepted: 1, rejected: 0, errors: [] }
      })
      .mockResolvedValueOnce({
        status: 202,
        body: { accepted: 2, rejected: 0, errors: [] }
      });
    const sdk = createInitedSdk(transport);
    sdk.captureMessage("first", "error");
    sdk.captureMessage("second", "error");

    await sdk.flush();
    expect(sdk.status).toBe("degraded");
    expect(sdk.lastEventAt).toBeNull();
    await sdk.flush();

    const secondRequest = transport.mock.calls[1]?.[0] as DebugBundleBrowserTransportRequest;
    expect(secondRequest.events).toHaveLength(2);
    expect(sdk.status).toBe("healthy");
    sdk.dispose();
  });

  it("should report degraded when transport returns 429", async () => {
    const sdk = createInitedSdk(async () => ({ status: 429, retry_after_ms: 5_000 }));
    sdk.captureException(new Error("test-error"));
    await sdk.flush();
    expect(sdk.status).toBe("degraded");
    sdk.dispose();
  });

  it("should recover to healthy after a successful flush following degraded", async () => {
    let callCount = 0;
    const sdk = createInitedSdk(async () => {
      callCount++;
      return callCount === 1 ? { status: 429, retry_after_ms: 0 } : { status: 202 };
    });
    sdk.captureException(new Error("first"));
    await sdk.flush();
    expect(sdk.status).toBe("degraded");

    await sdk.flush();
    expect(sdk.status).toBe("healthy");
    sdk.dispose();
  });

  it("should report disconnected after 3 consecutive failures", async () => {
    const sdk = createInitedSdk(async () => ({ status: 500 }));
    for (let i = 0; i < 3; i++) {
      sdk.captureException(new Error(`error-${i}`));
      await sdk.flush();
    }
    expect(sdk.status).toBe("disconnected");
    sdk.dispose();
  });

  it("should report disconnected after 3 consecutive transport errors", async () => {
    const sdk = createInitedSdk(async () => {
      throw new Error("network failure");
    });
    for (let i = 0; i < 3; i++) {
      sdk.captureException(new Error(`error-${i}`));
      await sdk.flush();
    }
    expect(sdk.status).toBe("disconnected");
    sdk.dispose();
  });

  it("should reset health state on dispose", async () => {
    const sdk = createInitedSdk(async () => ({ status: 202 }));
    sdk.captureException(new Error("test"));
    await sdk.flush();
    expect(sdk.lastEventAt).toBeTypeOf("number");

    sdk.dispose();
    expect(sdk.status).toBe("disconnected");
    expect(sdk.lastEventAt).toBeNull();
  });

  it("should reset consecutive failures on success", async () => {
    let callCount = 0;
    const sdk = createInitedSdk(async () => {
      callCount++;
      return callCount <= 2 ? { status: 500 } : { status: 202 };
    });

    sdk.captureException(new Error("fail-1"));
    await sdk.flush();
    sdk.captureException(new Error("fail-2"));
    await sdk.flush();
    expect(sdk.status).toBe("healthy");

    sdk.captureException(new Error("success"));
    await sdk.flush();
    expect(sdk.status).toBe("healthy");
    expect(sdk.lastEventAt).toBeTypeOf("number");
    sdk.dispose();
  });
});
