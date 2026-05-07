import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildSdkConfigEndpoint,
  createFetchTransport,
  detectRuntimeContext,
  ensureObject,
  extractHeaderValue,
  fetchWithTimeout,
  normalizeError,
  normalizeFiniteNumber,
  normalizeSampleRate,
  parseRetryAfter,
  redactObject,
  sanitizeMetadataObject,
  sanitizeUnknown,
  stringifyJsonValue
} from "../../../packages/sdk-node/src/utils.js";

afterEach((): void => {
  vi.restoreAllMocks();
});

describe("sdk-node utils", () => {
  it("should detect runtime context from package metadata and handle read failures", (): void => {
    const firstDir = mkdtempSync(join(tmpdir(), "debugbundle-fastify-"));
    const secondDir = mkdtempSync(join(tmpdir(), "debugbundle-next-"));
    const missingDir = mkdtempSync(join(tmpdir(), "debugbundle-missing-"));
    const traversalRoot = mkdtempSync(join(tmpdir(), "debugbundle-traversal-"));
    const cwdSpy = vi.spyOn(process, "cwd");

    try {
      writeFileSync(join(firstDir, "package.json"), JSON.stringify({ name: "checkout-api", dependencies: { fastify: "5.0.0" } }));
      cwdSpy.mockReturnValue(firstDir);
      expect(detectRuntimeContext()).toEqual({ service: "checkout-api", framework: "fastify" });

      writeFileSync(join(secondDir, "package.json"), JSON.stringify({ name: "web", devDependencies: { next: "15.0.0" } }));
      cwdSpy.mockReturnValue(secondDir);
      expect(detectRuntimeContext()).toEqual({ service: "web", framework: "nextjs" });

      mkdirSync(join(missingDir, "empty"));
      cwdSpy.mockReturnValue(join(missingDir, "empty"));
      expect(detectRuntimeContext()).toEqual({ service: null, framework: null });

      mkdirSync(join(traversalRoot, "safe"));
      mkdirSync(join(traversalRoot, "escaped"));
      writeFileSync(
        join(traversalRoot, "escaped", "package.json"),
        JSON.stringify({ name: "escaped-service", dependencies: { express: "5.0.0" } })
      );
      cwdSpy.mockReturnValue(`${traversalRoot}/safe/../escaped`);
      expect(detectRuntimeContext()).toEqual({ service: null, framework: null });
    } finally {
      cwdSpy.mockRestore();
      rmSync(firstDir, { recursive: true, force: true });
      rmSync(secondDir, { recursive: true, force: true });
      rmSync(missingDir, { recursive: true, force: true });
      rmSync(traversalRoot, { recursive: true, force: true });
    }
  });

  it("should normalize numbers and parse retry headers", (): void => {
    expect(normalizeFiniteNumber(undefined, 10, 2)).toBe(10);
    expect(normalizeFiniteNumber(1.9, 10, 2)).toBe(2);
    expect(normalizeFiniteNumber(7.8, 10, 2)).toBe(7);

    expect(normalizeSampleRate(undefined)).toBe(1);
    expect(normalizeSampleRate(-1)).toBe(0);
    expect(normalizeSampleRate(5)).toBe(1);
    expect(normalizeSampleRate(0.25)).toBe(0.25);

    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("1.5")).toBe(1500);
    expect(parseRetryAfter("3600")).toBe(300000);
    expect(parseRetryAfter("invalid")).toBeUndefined();

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-15T00:00:00.000Z"));
    expect(parseRetryAfter("2026-03-15T00:00:02.000Z")).toBe(2000);
    expect(parseRetryAfter("2026-03-15T02:00:00.000Z")).toBe(300000);
    vi.useRealTimers();
  });

  it("should sanitize, stringify, and redact unknown values", (): void => {
    const error = new Error("boom");
    const buffer = Buffer.from("payload", "utf8");
    const circular: Record<string, unknown> = { nested: true };
    circular["self"] = circular;

    expect(sanitizeUnknown(null)).toBeNull();
    expect(sanitizeUnknown(true)).toBe(true);
    expect(sanitizeUnknown(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(sanitizeUnknown(10n)).toBe("10");
    expect(sanitizeUnknown(new Date("2026-03-15T00:00:00.000Z"))).toBe("2026-03-15T00:00:00.000Z");
    expect(sanitizeUnknown(error)).toMatchObject({ message: "boom" });
    expect(sanitizeUnknown(buffer)).toBe("payload");
    expect(sanitizeUnknown([1, circular])).toEqual([1, { nested: true, self: "[Circular]" }]);
    expect(sanitizeUnknown(() => undefined)).toBe("[Function]");
    expect(sanitizeUnknown(Symbol("x"))).toBe("x");

    expect(stringifyJsonValue(null)).toBe("null");
    expect(stringifyJsonValue({ ok: true })).toBe('{"ok":true}');
    expect(ensureObject("value")).toEqual({ value: "value" });
    expect(sanitizeMetadataObject(undefined)).toBeUndefined();
    expect(sanitizeMetadataObject({ ok: true })).toEqual({ ok: true });
    expect(redactObject({ password: "secret", ok: true }, ["password"])).toEqual({ password: "[REDACTED]", ok: true });
  });

  it("should cap sanitizeUnknown recursion depth instead of overflowing on deeply nested input", (): void => {
    const deep = {} as Record<string, unknown>;
    let cursor = deep;
    for (let index = 0; index < 32; index += 1) {
      const next: Record<string, unknown> = {};
      cursor["child"] = next;
      cursor = next;
    }
    cursor["secret"] = "too-deep";

    const sanitized = sanitizeUnknown(deep) as Record<string, unknown>;
    const level1 = sanitized["child"] as Record<string, unknown>;
    const level2 = level1["child"] as Record<string, unknown>;
    const level3 = level2["child"] as Record<string, unknown>;
    const level4 = level3["child"] as Record<string, unknown>;
    const level5 = level4["child"] as Record<string, unknown>;
    const level6 = level5["child"] as Record<string, unknown>;
    const level7 = level6["child"] as Record<string, unknown>;

    expect(level7["child"]).toBe("[Truncated]");
  });

  it("should cap sanitizeUnknown output size for large strings and arrays", (): void => {
    const sanitized = sanitizeUnknown({
      payload: "x".repeat(10_000),
      entries: Array.from({ length: 60 }, (_unused, index) => index)
    }) as Record<string, unknown>;

    expect(typeof sanitized["payload"]).toBe("string");
    expect((sanitized["payload"] as string).length).toBeLessThan(10_000);
    expect(sanitized["payload"]).toBe("x".repeat(2034) + "...[truncated]");
    expect(sanitized["entries"]).toEqual([
      ...Array.from({ length: 50 }, (_unused, index) => index),
      "[Truncated]"
    ]);
  });

  it("should normalize errors, extract headers, and build the sdk config endpoint", (): void => {
    expect(normalizeError(new Error("boom"))).toBeInstanceOf(Error);
    expect(normalizeError("boom").message).toBe("boom");
    expect(normalizeError({ ok: true }).message).toBe('{"ok":true}');

    expect(extractHeaderValue(undefined, "x-request-id")).toBeNull();
    expect(extractHeaderValue({ "X-Request-Id": "req_123" }, "x-request-id")).toBe("req_123");
    expect(extractHeaderValue({ "x-tags": ["a", 2] }, "x-tags")).toBe("a,2");
    expect(extractHeaderValue({ "x-null": null }, "x-null")).toBeNull();

    expect(buildSdkConfigEndpoint("https://api.debugbundle.com/v1/events")).toBe("https://api.debugbundle.com/v1/sdk/config");
    expect(buildSdkConfigEndpoint("https://api.debugbundle.com/")).toBe("https://api.debugbundle.com/sdk/config");
  });

  it("should wrap fetch calls with timeout support and authorization", async (): Promise<void> => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 202,
      headers: { get: vi.fn().mockReturnValue("1") }
    });

    await expect(
      fetchWithTimeout(fetchImpl as typeof fetch, "https://api.debugbundle.com/v1/sdk/config", { method: "GET" }, 1000)
    ).resolves.toMatchObject({ status: 202 });

    const transport = createFetchTransport(fetchImpl as typeof fetch, "dbundle_proj_test");
    await expect(
      transport({
        endpoint: "https://api.debugbundle.com/v1/events",
        headers: { "x-debugbundle-sdk": "sdk" },
        events: [],
        timeout_ms: 1000
      })
    ).resolves.toEqual({ status: 202, retry_after_ms: 1000 });
  });
});