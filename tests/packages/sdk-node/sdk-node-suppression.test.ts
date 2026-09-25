import { describe, expect, it } from "vitest";
import { EventSuppressionTracker } from "../../../packages/sdk-node/src/suppression.js";

describe("Node suppression cardinality", () => {
  it("keeps unique fingerprints bounded and reports evicted suppressed counts once", () => {
    const tracker = new EventSuppressionTracker();
    for (let index = 0; index < 4; index += 1) tracker.shouldCapture("oldest", 1_000);
    for (let index = 0; index < 2_048; index += 1) tracker.shouldCapture(`distinct-${index}`, 1_000);

    expect(tracker.trackedCount).toBe(2_048);
    expect(tracker.drainAggregates(1_000).map((aggregate) => aggregate.suppressedCount)).toEqual([1]);
    expect(tracker.drainAggregates(1_000)).toEqual([]);
  });

  it("coalesces a wide duplicate storm into a finite report set", () => {
    const tracker = new EventSuppressionTracker();
    for (let fingerprint = 0; fingerprint < 100; fingerprint += 1) {
      for (let repeat = 0; repeat < 4; repeat += 1) tracker.shouldCapture(`failure-${fingerprint}`, 1_000);
    }

    const reports = tracker.drainAggregates(1_000);
    expect(reports).toHaveLength(65);
    expect(reports.reduce((total, aggregate) => total + aggregate.suppressedCount, 0)).toBe(100);
  });

  it("discards accumulated counters on explicit reset", () => {
    const tracker = new EventSuppressionTracker();
    for (let index = 0; index < 4; index += 1) tracker.shouldCapture("failure", 1_000);
    tracker.reset();
    expect(tracker.trackedCount).toBe(0);
    expect(tracker.drainAggregates(1_000)).toEqual([]);
  });
});
