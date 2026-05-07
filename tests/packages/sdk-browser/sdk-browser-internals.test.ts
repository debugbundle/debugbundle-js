import { describe, expect, it } from "vitest";

import { BrowserSdk } from "../../../packages/sdk-browser/src/index.js";
import type { DebugBundleBrowserTransportRequest, DebugBundleBrowserTransportResponse } from "../../../packages/sdk-browser/src/types.js";

describe("sdk-browser internals", () => {
  it("should normalize primitive probe inputs and preserve object inputs", (): void => {
    const sdk = new BrowserSdk() as unknown as {
      normalizeProbeInput: (data: unknown) => Record<string, unknown>;
    };

    expect(sdk.normalizeProbeInput(null)).toEqual({ value: null });
    expect(sdk.normalizeProbeInput([1, 2])).toEqual({ value: [1, 2] });
    expect(sdk.normalizeProbeInput("ok")).toEqual({ value: "ok" });
    expect(sdk.normalizeProbeInput({ total: 42 })).toEqual({ total: 42 });
  });

  it("should match wildcard, prefix, exact, and non-matching probe labels", (): void => {
    const sdk = new BrowserSdk() as unknown as {
      matchesProbeLabelPattern: (pattern: string, label: string) => boolean;
    };

    expect(sdk.matchesProbeLabelPattern("*", "checkout.ui.cart")).toBe(true);
    expect(sdk.matchesProbeLabelPattern("checkout.ui.*", "checkout.ui")).toBe(true);
    expect(sdk.matchesProbeLabelPattern("checkout.ui.*", "checkout.ui.cart")).toBe(true);
    expect(sdk.matchesProbeLabelPattern("checkout.tax", "checkout.tax")).toBe(true);
    expect(sdk.matchesProbeLabelPattern("checkout.tax", "checkout.total")).toBe(false);
  });

  it("should filter matching remote directives by config, expiry, and active trigger directives", (): void => {
    const sdk = new BrowserSdk() as unknown as {
      config: { service: string; environment: string } | null;
      remoteProbeState: {
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
      getMatchingRemoteProbeDirectives: (label: string, nowMs: number) => Array<{ activationId: string }>;
    };

    sdk.config = {
      service: "checkout-web",
      environment: "production"
    };
    sdk.remoteProbeState = {
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
    sdk.activeTriggerDirective = {
      activationId: "exact-match",
      labelPattern: "checkout.ui.tax",
      service: "checkout-web",
      environment: "production",
      expiresAt: "2026-03-20T00:00:00.000Z",
      triggerExpiresAt: null
    };

    expect(sdk.getMatchingRemoteProbeDirectives("checkout.ui.tax", Date.parse("2026-03-14T00:00:00.000Z"))).toHaveLength(3);
    expect(sdk.getMatchingRemoteProbeDirectives("checkout.ui.tax", Date.parse("2026-03-16T00:00:00.000Z"))).toEqual([
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