import { afterEach, expect, it, vi } from "vitest";
import {
  createRawTransportEvents,
  createSdk,
  getAnalyticsEvents
} from "../../helpers/sdk-browser-fixtures.js";

afterEach(() => vi.restoreAllMocks());

const analytics = {
  enabled: true,
  privacyMode: "custom" as const,
  trackSessions: false,
  trackPageViews: false,
  sampleRate: 0.5
};

it("keeps an admitted V1 analytics session after the initial sampling decision", async () => {
  const random = vi.spyOn(Math, "random").mockReturnValue(0.1);
  const { sdk, transport } = createSdk({ analytics, captureNetwork: false, batchSize: 256 });
  random.mockReturnValue(0.9);

  sdk.analytics.track("first.action");
  sdk.analytics.track("second.action");
  await sdk.flush();

  expect(getAnalyticsEvents(transport).map((event) => event.payload.signal.action_key)).toEqual([
    "first.action",
    "second.action"
  ]);
});

it("does not sample debug capture and V1 analytics as one shared decision", async () => {
  vi.spyOn(Math, "random").mockReturnValue(0.9);
  const { sdk, transport } = createSdk({ analytics, captureNetwork: false, batchSize: 256 });

  sdk.analytics.track("sampled.out");
  sdk.captureException(new Error("debug remains eligible"));
  await sdk.flush();

  expect(createRawTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
    "frontend_exception"
  ]);
});
