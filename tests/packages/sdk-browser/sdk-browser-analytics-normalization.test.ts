import { webcrypto } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildAnalyticsDimensions,
  getAnalyticsProjectTokenFields,
  getStructuralActionKey,
  isDeadClickCandidate,
  normalizeAnalyticsPrivacyMode,
  normalizeAnalyticsRoute,
  normalizeAnalyticsSignal,
  omitBuiltInAnalyticsDimensions,
  removeStoredAnalyticsVisitor,
  resolveStandardAnalyticsVisitor,
  sanitizeAnalyticsCustomDimensions
} from "../../../packages/sdk-browser/src/analytics-normalization.js";
import type { ActiveConfig, BrowserDeviceInfo } from "../../../packages/sdk-browser/src/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sdk-browser analytics normalization", () => {
  it("normalizes privacy, project-token, signal, and structural-action fields", () => {
    expect(normalizeAnalyticsPrivacyMode("standard")).toBe("standard");
    expect(normalizeAnalyticsPrivacyMode("custom")).toBe("custom");
    expect(normalizeAnalyticsPrivacyMode("invalid")).toBe("strict");
    expect(getAnalyticsProjectTokenFields({ projectToken: null } as ActiveConfig)).toEqual({});
    expect(getAnalyticsProjectTokenFields({ projectToken: "token" } as ActiveConfig)).toEqual({
      project_token: "token"
    });
    expect(
      normalizeAnalyticsSignal({
        action_key: " checkout.pay ",
        funnel_key: "bad key",
        step_key: 123 as unknown as string,
        conversion_key: "x".repeat(121),
        marker_key: "marker:ready"
      })
    ).toEqual({
      action_key: "checkout.pay",
      funnel_key: null,
      step_key: null,
      conversion_key: null,
      marker_key: "marker:ready"
    });

    expect(getStructuralActionKey({ role: " BUTTON " })).toBe("click.button");
    expect(getStructuralActionKey({ tagName: "INPUT", type: "submit" })).toBe("click.input.submit");
    expect(getStructuralActionKey({ tagName: "input", type: "text" })).toBe("click.input");
    expect(getStructuralActionKey({ tagName: "unknown" })).toBeNull();
    expect(getStructuralActionKey({ tagName: 123 })).toBeNull();
    expect(isDeadClickCandidate({ tagName: "DIV" })).toBe(true);
    expect(isDeadClickCandidate({ tagName: "input" })).toBe(false);
    expect(isDeadClickCandidate({})).toBe(false);
  });

  it("normalizes absolute, relative, malformed, and empty analytics routes", () => {
    vi.stubGlobal("location", { href: "https://shop.example.com/current" });

    expect(normalizeAnalyticsRoute("/checkout?coupon=yes", " Checkout ")).toEqual({
      path: "/checkout",
      normalized_path: "/checkout",
      title: "Checkout"
    });
    expect(normalizeAnalyticsRoute("", null)).toBeNull();
    expect(normalizeAnalyticsRoute(undefined, null)).toBeNull();
    expect(normalizeAnalyticsRoute("http://[?bad#fragment", "")).toEqual({
      path: "/http://[",
      normalized_path: "/http://[",
      title: null
    });
    expect(normalizeAnalyticsRoute("http://[#fragment", null)).toEqual({
      path: "/http://[",
      normalized_path: "/http://[",
      title: null
    });
    expect(normalizeAnalyticsRoute("http://[?bad", null)).toEqual({
      path: "/http://[",
      normalized_path: "/http://[",
      title: null
    });
    expect(normalizeAnalyticsRoute("http://[", null)).toEqual({
      path: "/http://[",
      normalized_path: "/http://[",
      title: null
    });
    vi.stubGlobal("location", { href: "not a base url" });
    expect(normalizeAnalyticsRoute("?query-only", null)).toBeNull();
  });

  it("bounds custom dimensions and removes reserved or sensitive values", () => {
    const sanitized = sanitizeAnalyticsCustomDimensions({
      auth_state: "authenticated",
      password: "secret",
      "bad key": "value",
      valid: " value ",
      boolean: false,
      nullable: null,
      finite: 42,
      too_large: 1_000_001,
      invalid_object: {},
      sensitive_value: "contains token",
      long_value: "x".repeat(129),
      one: 1,
      two: 2,
      three: 3,
      four: 4,
      five: 5,
      six: 6
    });

    expect(sanitized).toEqual({
      valid: "value",
      boolean: false,
      nullable: null,
      finite: 42,
      one: 1,
      two: 2,
      three: 3,
      four: 4
    });
    expect(omitBuiltInAnalyticsDimensions({ ...sanitized, auth_state: "authenticated" })).not.toHaveProperty(
      "auth_state"
    );
  });

  it("builds bounded device, campaign, locale, viewport, and referrer dimensions", () => {
    vi.stubGlobal("location", {
      search: "?utm_source=docs&utm_medium=email&utm_campaign=launch",
      href: "https://shop.example.com/"
    });
    vi.stubGlobal("document", { referrer: "https://search.example.com/results?q=debugbundle" });
    const device: BrowserDeviceInfo = {
      user_agent: "Browser",
      os: { name: "Example OS", version: "17.4" },
      browser: { name: "Example Browser", version: "125.2" },
      device_type: "desktop",
      screen: { width: 1920, height: 1080 },
      viewport: { width: 800, height: 700 },
      device_pixel_ratio: 2,
      touch_capable: false,
      language: "en-US",
      connection_type: "4g",
      color_scheme_preference: "dark"
    };

    expect(buildAnalyticsDimensions(device, true, { auth_state: "authenticated" })).toMatchObject({
      auth_state: "authenticated",
      browser_major: 125,
      os_major: 17,
      language: "en-US",
      viewport_bucket: "medium",
      referrer_domain: "search.example.com",
      utm_source: "docs"
    });
    expect(
      buildAnalyticsDimensions(
        {
          ...device,
          browser: { name: "", version: "-1" },
          os: { name: null, version: "invalid" },
          language: "invalid locale!",
          viewport: { width: 0, height: 0 }
        },
        false,
        { auth_state: "other" }
      )
    ).toMatchObject({
      auth_state: "anonymous",
      browser_family: null,
      browser_major: null,
      os_family: null,
      os_major: null,
      language: null,
      viewport_bucket: "unknown",
      referrer_domain: null
    });
    expect(buildAnalyticsDimensions({ ...device, viewport: { width: 500, height: 700 } }, true, {})).toMatchObject({
      viewport_bucket: "small"
    });
    vi.stubGlobal("document", { referrer: "not a url" });
    expect(buildAnalyticsDimensions(device, true, {})).toMatchObject({ referrer_domain: null });
  });

  it("creates, reuses, removes, and fails closed for standard visitors", async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      })
    };
    vi.stubGlobal("crypto", {
      randomUUID: () => "00000000-0000-4000-8000-000000000123",
      subtle: { digest: webcrypto.subtle.digest.bind(webcrypto.subtle) }
    });
    vi.stubGlobal("localStorage", storage);
    const resolvedKeys: string[] = [];

    const created = await resolveStandardAnalyticsVisitor("project-token", (key) => resolvedKeys.push(key));
    expect(created?.visitorIdHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(resolvedKeys).toEqual([created?.storageKey]);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
    await expect(resolveStandardAnalyticsVisitor("project-token")).resolves.toEqual(created);

    removeStoredAnalyticsVisitor(created?.storageKey ?? "missing");
    expect(storage.removeItem).toHaveBeenCalled();

    vi.stubGlobal("crypto", { randomUUID: () => "invalid", subtle: { digest: webcrypto.subtle.digest.bind(webcrypto.subtle) } });
    values.clear();
    await expect(resolveStandardAnalyticsVisitor("project-token")).resolves.toBeNull();

    vi.stubGlobal("crypto", {});
    await expect(resolveStandardAnalyticsVisitor("project-token")).resolves.toBeNull();
    vi.stubGlobal("localStorage", undefined);
    removeStoredAnalyticsVisitor("missing");
  });
});
