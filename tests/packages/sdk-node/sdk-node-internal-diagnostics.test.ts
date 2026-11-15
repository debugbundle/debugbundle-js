import { afterEach, expect, it, vi } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";
import { activeSdks, createSdk } from "../../helpers/sdk-node-client.js";

afterEach(() => {
  while (activeSdks.length) activeSdks.pop()?.dispose();
  vi.restoreAllMocks();
});

it("synchronous diagnostic failures preserve the original application event", async () => {
  const { sdk, transport } = createSdk({
    beforeSend() { throw new Error("synthetic hook failure"); },
    onDiagnostic() { throw new Error("synthetic diagnostic failure"); }
  });
  sdk.captureLog("application error", "error");
  await sdk.flush();
  expect(transport.mock.calls[0]![0].events[0].payload.message).toBe("application error");
});

it("diagnostic logging must not create additional transported events", async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  let calls = 0;
  const { sdk, transport } = createSdk({ batchSize: 1, captureConsole: true,
    beforeSend() { throw new Error("synthetic hook failure"); },
    onDiagnostic() {
      // Test-owned fuse prevents an unrestricted feedback loop.
      if (++calls <= 6) console.error(`internal diagnostic ${calls}`);
    }
  });
  sdk.captureLog("application error", "error");
  await sdk.flush();
  const messages = transport.mock.calls.flatMap(([request]) => (request as { events: EventEnvelope[] }).events.map((event: EventEnvelope) => event.event_type === "log_event" ? event.payload.message : null));
  expect({ diagnosticCalls: calls, messages }).toEqual({ diagnosticCalls: 1, messages: ["application error"] });
});

it("custom privacy fields apply to internal diagnostic metadata", async () => {
  const diagnostics: unknown[] = [];
  const { sdk } = createSdk({ redactFields: ["customer_internal_id"],
    transport: async () => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- Application transports can reject with arbitrary values.
      throw { customer_internal_id: "audit-private-value" };
    },
    onDiagnostic: diagnostic => { diagnostics.push(diagnostic); }
  });
  sdk.captureLog("application error", "error");
  await sdk.flush();
  expect(JSON.stringify(diagnostics)).not.toContain("audit-private-value");
});

it("error formatting must not reject public flush even with diagnostics disabled", async () => {
  const error = new Error("synthetic transport failure");
  Object.defineProperty(error, "message", { get() { throw new Error("synthetic diagnostic projection failure"); } });
  const { sdk } = createSdk({ transport: async () => { throw error; } });
  sdk.captureLog("application error", "error");
  let escaped = false;
  try { await sdk.flush(); } catch { escaped = true; }
  expect(escaped).toBe(false);
});

it("consumes async diagnostic rejections and suppresses only callback descendants", async () => {
  const calls = vi.fn(async () => {
    await Promise.resolve();
    sdk.captureLog("internal async diagnostic", "error");
    throw new Error("synthetic rejected diagnostic");
  });
  const { sdk, transport } = createSdk({ beforeSend() { throw new Error("hook failed"); }, onDiagnostic: calls as unknown as () => void });
  sdk.captureLog("application error", "error");
  await sdk.flush();
  await new Promise<void>(resolve => setImmediate(resolve));
  sdk.captureLog("unrelated application error", "error");
  await sdk.flush();
  expect(calls).toHaveBeenCalledTimes(2);
  expect(transport.mock.calls.flatMap(([request]) => (request as { events: EventEnvelope[] }).events.map((event: EventEnvelope) =>
    event.event_type === "log_event" ? event.payload.message : null))).toEqual(["application error", "unrelated application error"]);
});

it("bounds diagnostic emission and omits unsafe or oversized metadata without losing failure codes", async () => {
  const diagnostics: unknown[] = [];
  const error = new Error("unsafe");
  let reads = 0;
  Object.defineProperty(error, "message", { get() { reads++; throw new Error("projection failed"); } });
  let failure: unknown = error;
  const { sdk } = createSdk({ onDiagnostic: value => { diagnostics.push(value); },
    transport: async () => { throw failure; } });
  for (let i = 0; i < 12; i++) {
    sdk.captureLog(`application error ${i}`, "error");
    await sdk.flush();
    failure = { details: "é".repeat(4000) };
  }
  expect(diagnostics).toHaveLength(10);
  expect(diagnostics.every(value => JSON.stringify(value).length < 4096)).toBe(true);
  expect(JSON.stringify(diagnostics)).toContain("flush_failed");
  expect(reads).toBe(0);
});

it.each([false, true])("bounds stalled diagnostic Promises through console capture=%s", async (captureConsole) => {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  vi.spyOn(console, "error").mockImplementation(() => held as unknown as void);
  const callback = vi.fn(() => captureConsole ? console.error("local diagnostic") : held);
  const { sdk, transport } = createSdk({ captureConsole, beforeSend() { throw new Error("hook failed"); },
    onDiagnostic: callback as unknown as () => void });
  for (let index = 0; index < 20; index++) {
    sdk.captureLog(`application error ${index}`, "error");
    await sdk.flush();
  }
  expect(callback).toHaveBeenCalledTimes(1);
  expect(transport).toHaveBeenCalledTimes(20);
  release();
  await Promise.resolve();
  sdk.captureLog("after diagnostics resume", "error");
  await sdk.flush();
  expect(callback).toHaveBeenCalledTimes(2);
});
