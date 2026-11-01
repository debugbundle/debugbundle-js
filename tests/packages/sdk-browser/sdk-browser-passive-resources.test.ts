import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticCaptureBudget, type ResourceObservation } from "@debugbundle/shared-types";
import { PassiveResourceCollector, safeResourceUrl, type PassiveFailure } from "../../../packages/sdk-browser/src/passive-resources.js";
import { installPassivePlatform } from "../../helpers/passive-platform.js";
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const start = Date.parse("2026-10-26T00:00:00.000Z");
const timing = (url = "https://cdn.example/asset.js"): ResourceObservation => ({ kind: "timing", observed_at: new Date(start).toISOString(), source_url: url,
  availability: "withheld", response_status: null, duration_ms: 10, transfer_size_bytes: 0 });
const source: PassiveFailure = { event_id: id(1), occurred_at: new Date(start).toISOString(), reference: { version: 1, failure_ref: id(2), scope: { kind: "page", page_id: id(3) } },
  service: { name: "web", environment: "test" }, correlation: { request_id: null, trace_id: null, session_id: id(4), user_id_hash: null },
  source_url: "https://cdn.example/asset.js", identitySafe: true };
const collectors: PassiveResourceCollector[] = [];
afterEach(() => { collectors.splice(0).forEach(collector => collector.reset()); vi.unstubAllGlobals(); vi.useRealTimers(); });
function fixture(resetClock = true) { if (resetClock) { vi.useFakeTimers(); vi.setSystemTime(start); } const budget = new DiagnosticCaptureBudget(), emit = vi.fn();
  const collector = new PassiveResourceCollector(budget, emit); collectors.push(collector); collector.enable(true); return { collector, emit, budget }; }
function platformFixture() { vi.useFakeTimers(); vi.setSystemTime(start); const platform = installPassivePlatform(start); return { platform, ...fixture(false) }; }
it("retains only sanitised identity and refuses redaction-colliding identity matches", () => {
  expect(safeResourceUrl("https://user:secret@cdn.example/asset.js?token=secret#sample")).toEqual({ url: source.source_url, identitySafe: false });
  const { collector } = fixture(); collector.record(timing(), start, false);
  expect(collector.snapshot(source.source_url, start).items).toMatchObject([{ availability: "ambiguous", response_status: null }]);
});
it("coalesces a single late context, preserves report-only CSP, and releases metadata", async () => {
  const { collector, emit, budget } = fixture(); collector.watch(source); expect(budget.accountedBytes).toBeGreaterThan(0);
  collector.record(timing(), start); collector.record({ kind: "csp", observed_at: source.occurred_at, source_url: source.source_url,
    effective_directive: "script-src-elem", disposition: "report", document_status_code: 200 }, start);
  await vi.advanceTimersByTimeAsync(0); expect(emit).toHaveBeenCalledTimes(1);
  expect(emit.mock.calls[0]?.[1]).toMatchObject({ source_event_id: source.event_id, observations: { items: [timing(), { disposition: "report", document_status_code: 200 }] } });
  expect(budget.accountedBytes).toBe(0); collector.record(timing(), start); await vi.advanceTimersByTimeAsync(0); expect(emit).toHaveBeenCalledTimes(1);
});
it("bounds its passive buffer and expiry and treats repeated URL timings as ambiguous", async () => {
  const { collector, emit, budget } = fixture(); collector.watch(source);
  collector.record(timing(), start); collector.record(timing(), start);
  expect(collector.snapshot(source.source_url, start, true, source.event_id).items).toMatchObject([{ availability: "ambiguous" }]);
  for (let n = 0; n < 30; n++) collector.record(timing(`https://cdn.example/${n}.js`), start);
  expect((collector as unknown as { observations: unknown[] }).observations).toHaveLength(20);
  await vi.advanceTimersByTimeAsync(30_001); expect(budget.accountedBytes).toBe(0); expect(emit).not.toHaveBeenCalled();
  expect((collector as unknown as { observations: unknown[] }).observations).toHaveLength(0);
});
it("contains observer setup/teardown failures instead of throwing into SDK initialization", () => {
  class BrokenObserver { observe(): never { throw new Error("unsupported"); } disconnect(): never { throw new Error("already detached"); } }
  vi.stubGlobal("PerformanceObserver", BrokenObserver);
  expect(() => fixture()).not.toThrow();
});
it("collects platform timing and report-only CSP through fixed prototype getters and tears down once", () => {
  const { platform, collector } = platformFixture();
  expect(platform.observe).toHaveBeenCalledExactlyOnceWith({ type: "resource", buffered: false });
  const entry = platform.timing({ name: source.source_url, startTime: 0, duration: 12, transferSize: 100.5, responseStatus: 403, redirectEnd: 0 });
  const ownGetter = vi.fn(() => "https://attacker.example/should-not-read");
  Object.defineProperty(entry, "name", { get: ownGetter });
  platform.entries([entry]);
  platform.violation(platform.csp({ blockedURI: source.source_url, statusCode: 200, effectiveDirective: "script-src-elem", disposition: "report" }));
  expect(collector.snapshot(source.source_url, start).items).toMatchObject([
    { kind: "timing", availability: "observed", response_status: 403, duration_ms: 12, transfer_size_bytes: 100 },
    { kind: "csp", disposition: "report", document_status_code: 200 }
  ]);
  expect(ownGetter).not.toHaveBeenCalled();
  collector.enable(true); expect(platform.observe).toHaveBeenCalledOnce();
  collector.enable(false); expect(platform.disconnect).toHaveBeenCalledOnce(); expect(platform.remove).toHaveBeenCalledOnce();
  platform.entries([entry]); expect(collector.snapshot(source.source_url, start).items).toMatchObject([{ availability: "unsupported" }]);
});
it("withholds zero/invalid timing status, rejects redirected identities and ignores invalid platform values", () => {
  const { platform, collector } = platformFixture();
  platform.entries([{}, platform.timing({ name: "data:secret", startTime: 0 }),
    platform.timing({ name: source.source_url, startTime: 0, duration: -1, transferSize: Infinity, responseStatus: 0, redirectEnd: 0 })]);
  expect(collector.snapshot(source.source_url, start).items).toMatchObject([{ availability: "withheld", response_status: null, duration_ms: null, transfer_size_bytes: null }]);
  platform.entries([platform.timing({ name: "https://cdn.example/redirected.js", startTime: 0, duration: 10, transferSize: 100, responseStatus: 200, redirectEnd: 2 })]);
  expect(collector.snapshot("https://cdn.example/redirected.js", start).items).toMatchObject([{ availability: "ambiguous", response_status: null }]);
  platform.violation(platform.csp({ blockedURI: source.source_url, effectiveDirective: "invalid directive", disposition: "enforce", statusCode: 0 }));
  expect(collector.snapshot(source.source_url, start).items).toHaveLength(1);
});
it("does not reinterpret a CSP inline marker as a relative resource URL", () => {
  const { platform, collector } = platformFixture();
  platform.violation(platform.csp({ blockedURI: "inline", effectiveDirective: "script-src-elem", disposition: "enforce", statusCode: 200 }));
  expect(collector.snapshot("https://evidence.invalid/inline", start).items).toMatchObject([{ kind: "timing", availability: "no_match" }]);
});
