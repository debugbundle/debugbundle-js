import { afterEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";
import type { DebugBundleTransportRequest } from "../../../packages/sdk-node/src/index.js";
import { activeSdks, createSdk } from "../../helpers/sdk-node-client.js";

function sentPressureReports(transport: ReturnType<typeof vi.fn>): Array<Extract<EventEnvelope, { event_type: "error_suppressed" }>> {
  return (transport.mock.calls as Array<[DebugBundleTransportRequest]>)
    .flatMap(([request]) => request.events)
    .filter((event): event is Extract<EventEnvelope, { event_type: "error_suppressed" }> =>
      event.event_type === "error_suppressed");
}

afterEach(() => {
  while (activeSdks.length > 0) activeSdks.pop()?.dispose();
  vi.restoreAllMocks();
});

describe("sdk-node overload", () => {
  it("keeps all-ERROR overload off the application hook and reports queue loss once", async () => {
    const beforeSend = vi.fn((event: EventEnvelope) => event);
    const { sdk, transport } = createSdk({ maxBufferedEvents: 2, batchSize: 25, beforeSend });

    for (let index = 0; index < 10_000; index += 1) {
      sdk.captureLog(`distinct error ${index}`, "error");
    }

    expect(beforeSend.mock.calls.length).toBeLessThanOrEqual(42);
    expect((sdk as unknown as { buffer: EventEnvelope[] }).buffer).toHaveLength(2);
    await sdk.flush();
    await sdk.flush();
    const reports = sentPressureReports(transport);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.payload.suppressed_count).toBe(9_998);
  });

  it("bounds all-exception admission before reading application error properties", () => {
    const { sdk } = createSdk({ maxBufferedEvents: 2, batchSize: 25 });
    sdk.captureException(new Error("first"));
    sdk.captureException(new Error("second"));
    let inspected = 0;
    const error = new Error("later");
    Object.defineProperty(error, "message", { get: () => {
      inspected += 1;
      return "later";
    } });

    for (let index = 0; index < 10_000; index += 1) sdk.captureException(error);

    expect(inspected).toBeLessThanOrEqual(80);
    expect((sdk as unknown as { buffer: EventEnvelope[] }).buffer).toHaveLength(2);
  });

  it("swallows a hostile request status accessor before policy and queue admission", () => {
    const { sdk } = createSdk();
    const response = Object.defineProperty({}, "statusCode", { get: () => { throw new Error("host getter"); } });

    expect(() => sdk.captureRequest({ method: "GET", path: "/" }, response)).not.toThrow();
  });

  it("keeps one queue-pressure report after a failed send and recovery", async () => {
    const { sdk, transport } = createSdk({ maxBufferedEvents: 2, batchSize: 25 });
    transport.mockResolvedValueOnce({ status: 500 });
    sdk.captureLog("first", "error");
    sdk.captureLog("second", "error");
    sdk.captureLog("third", "error");

    await sdk.flush();
    await sdk.flush();
    await sdk.flush();

    const reports = sentPressureReports(transport);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.payload.suppressed_count).toBe(1);
  });
});
