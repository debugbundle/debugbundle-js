import { describe, expect, it, vi } from "vitest";
import * as fixtures from "../../helpers/sdk-browser-fixtures.js";


describe("Browser internal diagnostics", () => {
  it("keeps diagnostic warnings out of later application breadcrumbs and sanitizes response detail", async () => {
    const output = vi.fn();
    vi.stubGlobal("console", { warn: output, error: output });
    const { sdk, transport } = fixtures.createSdk({ captureConsole: true });
    transport.mockResolvedValueOnce({ status: 202, body: { accepted: 0, rejected: 1,
      errors: [{ index: 0, reason: "token=synthetic-private-value" }] } });
    sdk.captureMessage("first application error", "error");
    await sdk.flush();
    sdk.captureException(new Error("later application error"));
    await sdk.flush();
    expect(JSON.stringify(output.mock.calls)).not.toContain("synthetic-private-value");
    const events = fixtures.createTransportEvents(transport, 1);
    expect(JSON.stringify(events)).not.toContain("DebugBundle browser SDK");
    expect(events).toHaveLength(1);
  });

  it("contains failed console output without changing terminal ACK decisions", async () => {
    vi.stubGlobal("console", { warn() { throw new Error("console failed"); } });
    const { sdk, transport } = fixtures.createSdk();
    transport.mockResolvedValue({ status: 202, body: { accepted: 0, rejected: 1,
      errors: [{ index: 0, reason: "invalid_event" }] } });
    sdk.captureMessage("terminal error", "error");
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(sdk.status).toBe("disconnected");
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("bounds distinct diagnostic output and preserves later normal console breadcrumbs", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
    const output = vi.fn();
    vi.stubGlobal("console", { warn: output, error: output });
    const { sdk, transport } = fixtures.createSdk({ captureConsole: true, maxEventsPerSession: 100 });
    for (let index = 0; index < 12; index++) {
      transport.mockResolvedValueOnce({ status: 202, body: { accepted: 0, rejected: 1,
        errors: [{ index: 0, reason: `invalid_${index}` }] } });
      sdk.captureMessage(`application error ${index}`, "error");
      await sdk.flush();
    }
    expect(output).toHaveBeenCalledTimes(10);
    vi.setSystemTime(new Date("2026-11-15T12:01:01Z"));
    console.warn("ordinary application warning");
    sdk.captureException(new Error("ordinary application error"));
    await sdk.flush();
    const events = fixtures.createTransportEvents(transport, 12);
    expect(JSON.stringify(events)).toContain("ordinary application warning");
    expect(JSON.stringify(events)).not.toContain("DebugBundle browser SDK");
  });

  it.each([false, true])("sanitizes auth warnings and consumes async console rejection with captureConsole=%s", async (captureConsole) => {
    const messages: unknown[] = [];
    const output = vi.fn(async (message: unknown) => { messages.push(message); throw new Error("async console failed"); });
    vi.stubGlobal("console", { error: output });
    const { sdk, transport } = fixtures.createSdk({ captureConsole, endpoint: "https://example.test/v1/events?token=synthetic-private-value" });
    transport.mockResolvedValueOnce({ status: 401, body: { error: "dbundle_proj_synthetic-private-value" } });
    sdk.captureMessage("application error", "error");
    await sdk.flush();
    await Promise.resolve();
    expect(JSON.stringify(messages)).not.toContain("synthetic-private-value");
    expect(sdk.status).toBe("disconnected");
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("bounds pending console Promises with captureConsole=%s", async (captureConsole) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const output = vi.fn(() => held);
    vi.stubGlobal("console", { warn: output });
    const { sdk, transport } = fixtures.createSdk({ captureConsole });
    for (let index = 0; index < 3; index++) {
      transport.mockResolvedValueOnce({ status: 202, body: { accepted: 0, rejected: 1,
        errors: [{ index: 0, reason: `invalid_${index}` }] } });
      sdk.captureLog(`application error ${index}`, "error");
      await sdk.flush();
    }
    expect(output).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(3);
    release();
    await Promise.resolve();
  });
});
