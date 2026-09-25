import { describe, expect, it } from "vitest";
import { EventSuppressionTracker } from "../../../packages/sdk-browser/src/suppression.js";

describe("browser suppression cardinality", () => {
  it("retains a finite number of fingerprints and reports evicted counts once", () => {
    const tracker = new EventSuppressionTracker();
    for (let index = 0; index < 4; index += 1) tracker.shouldCapture("oldest", 1_000);
    for (let index = 0; index < 2_048; index += 1) tracker.shouldCapture(`distinct-${index}`, 1_000);

    expect(tracker.trackedCount).toBe(2_048);
    expect(tracker.drainAggregates(1_000).map((aggregate) => aggregate.suppressedCount)).toEqual([1]);
    expect(tracker.drainAggregates(1_000)).toEqual([]);
  });

  it("limits a wide duplicate storm to one bounded report set", () => {
    const tracker = new EventSuppressionTracker();
    for (let fingerprint = 0; fingerprint < 100; fingerprint += 1) {
      for (let repeat = 0; repeat < 4; repeat += 1) tracker.shouldCapture(`failure-${fingerprint}`, 1_000);
    }

    const reports = tracker.drainAggregates(1_000);
    expect(reports).toHaveLength(65);
    expect(reports.reduce((total, aggregate) => total + aggregate.suppressedCount, 0)).toBe(100);
  });
});
