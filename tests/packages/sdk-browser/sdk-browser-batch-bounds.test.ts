import { expect, it, vi } from "vitest";
import * as fixtures from "../../helpers/sdk-browser-fixtures.js";
import { buildBrowserTransportRequestBody } from "../../../packages/sdk-browser/src/fetch-transport.js";
import { largeExceptionEvidence as largeEvidence } from "../../helpers/large-exception-evidence.js";
import type { DebugBundleBrowserTransport } from "../../../packages/sdk-browser/src/index.js";

it("retains every primary error while splitting enriched relay batches below the default body limit", async () => {
  const evidence = largeEvidence();
  const capabilities = { version: 1 as const, features: ["exception_evidence_v1" as const] };
  const transport = vi.fn<DebugBundleBrowserTransport>();
  const { sdk } = fixtures.createSdk({ transport, transportMode: "relay", endpoint: "/debugbundle/browser",
    batchSize: 10, evidenceCapabilities: capabilities,
    beforeSend: event => event.event_type === "frontend_exception" ? { ...event, payload: { ...event.payload, exception_evidence: evidence } } : event });
  transport.mockImplementation(async (request) => {
    const bytes = new TextEncoder().encode(buildBrowserTransportRequestBody("relay", request.events)).byteLength;
    return bytes > 256 * 1024 ? { status: 413 } : { status: 202, body: {
      accepted: request.events.length, rejected: 0, errors: [], evidence_capabilities: capabilities } };
  });
  for (let index = 0; index < 10; index++) sdk.captureException(new Error(`primary-${String.fromCharCode(97 + index)}`));
  for (let index = 0; index < 12; index++) await sdk.flush();
  const batches = transport.mock.calls.map(call => call[0]);
  expect(batches.length).toBeGreaterThan(1);
  for (const batch of batches)
    expect(new TextEncoder().encode(buildBrowserTransportRequestBody("relay", batch.events)).byteLength).toBeLessThanOrEqual(256 * 1024);
  expect(batches.flatMap(batch => batch.events).filter(event => event.event_type === "frontend_exception")).toHaveLength(10);
});

it.each([13, 14])("preserves hook redaction when an enriched replacement exceeds wire bytes (%i fields)", async (fields) => {
  const transport = vi.fn<DebugBundleBrowserTransport>().mockResolvedValue({ status: 202 });
  const oversizedName = "a".repeat(16000);
  const { sdk } = fixtures.createSdk({ transport, transportMode: "relay", endpoint: "/debugbundle/browser",
    evidenceCapabilities: { version: 1, features: ["exception_evidence_v1"] },
    beforeSend: event => event.event_type === "frontend_exception" ? { ...event,
      sdk_name: oversizedName, sdk_version: "b".repeat(16000), schema_version: "c".repeat(16000),
      context: Object.fromEntries(Array.from({ length: fields }, (_, index) => [`detail${index}`, "x".repeat(16000)])),
      payload: { ...event.payload, message: "safe replacement", stack: "safe replacement stack", exception_evidence: largeEvidence() } } : event });
  sdk.captureException(new Error("private original before hook")); await sdk.flush();
  const events = transport.mock.calls.flatMap(call => call[0].events);
  expect(JSON.stringify(events)).not.toContain("private original before hook");
  expect(events).toHaveLength(fields === 13 ? 1 : 0);
  expect(new TextEncoder().encode(buildBrowserTransportRequestBody("relay", events)).byteLength).toBeLessThanOrEqual(256 * 1024);
  if (fields === 13) {
    expect(events[0]?.sdk_name).toBe(oversizedName);
    expect(events[0]?.payload).toMatchObject({ message: "safe replacement" });
    expect(events[0]?.payload).not.toHaveProperty("exception_evidence");
  }
});
