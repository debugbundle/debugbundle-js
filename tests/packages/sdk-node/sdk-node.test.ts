import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createDebugBundleSdk,
  type DebugBundleNodeSdk,
  type DebugBundleTransportRequest
} from "../../../packages/sdk-node/src/index.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

const activeSdks: DebugBundleNodeSdk[] = [];
type TransportMock = ReturnType<typeof vi.fn>;
type BackendExceptionEvent = Extract<EventEnvelope, { event_type: "backend_exception" }>;
type ErrorSuppressedEvent = Extract<EventEnvelope, { event_type: "error_suppressed" }>;

function getTransportEvents(transport: TransportMock, callIndex: number): EventEnvelope[] {
  const calls = transport.mock.calls as Array<[DebugBundleTransportRequest]>;
  return calls[callIndex]?.[0].events ?? [];
}

function getEventMessage(event: EventEnvelope): string {
  if (event.event_type === "backend_exception" || event.event_type === "log_event") {
    return event.payload.message;
  }

  throw new Error(`Expected a message-bearing event but received ${event.event_type}`);
}

function getBackendExceptionEvent(event: EventEnvelope | undefined): BackendExceptionEvent {
  if (event === undefined || event.event_type !== "backend_exception") {
    throw new Error("Expected a backend_exception event");
  }

  return event;
}

function getErrorSuppressedEvent(event: EventEnvelope | undefined): ErrorSuppressedEvent {
  if (event === undefined || event.event_type !== "error_suppressed") {
    throw new Error("Expected an error_suppressed event");
  }

  return event;
}

function getObjectField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected object field ${key}`);
  }

  return (value as Record<string, unknown>)[key];
}

function createSdk(
  overrides: Parameters<DebugBundleNodeSdk["init"]>[0] = {}
): { sdk: DebugBundleNodeSdk; transport: TransportMock } {
  const transport = vi.fn().mockResolvedValue({ status: 202 });
  const sdk = createDebugBundleSdk();
  activeSdks.push(sdk);
  sdk.init({
    projectToken: "dbundle_proj_test",
    service: "checkout-api",
    environment: "production",
    flushInterval: 60_000,
    transport,
    ...overrides
  });

  return { sdk, transport };
}

function captureRepeatedException(sdk: DebugBundleNodeSdk, message: string, count: number): void {
  for (let index = 0; index < count; index += 1) {
    const error = new Error(message);
    error.stack = `Error: ${message}\n    at repeated-test-stack:1:1`;
    sdk.captureException(error);
  }
}

afterEach((): void => {
  while (activeSdks.length > 0) {
    activeSdks.pop()?.dispose();
  }

  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sdk-node", () => {
  it("should expose the universal sdk surface", (): void => {
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);

    expect(typeof sdk.init).toBe("function");
    expect(typeof sdk.captureException).toBe("function");
    expect(typeof sdk.captureError).toBe("function");
    expect(typeof sdk.captureLog).toBe("function");
    expect(typeof sdk.captureRequest).toBe("function");
    expect(typeof sdk.captureMessage).toBe("function");
    expect(typeof sdk.setContext).toBe("function");
    expect(typeof sdk.flush).toBe("function");
    expect(typeof sdk.probe).toBe("function");
    expect(typeof sdk.captureExceptions).toBe("function");
    expect(typeof sdk.captureRejections).toBe("function");
    expect(typeof sdk.captureConsole).toBe("function");
  });

  it("should degrade silently when init config is invalid", async (): Promise<void> => {
    const sdk = createDebugBundleSdk();
    const transport = vi.fn();
    activeSdks.push(sdk);

    expect(() =>
      sdk.init({
        projectToken: "",
        service: "checkout-api",
        environment: "production",
        transport
      })
    ).not.toThrow();
    expect(() => sdk.captureException(new Error("boom"))).not.toThrow();
    expect(() => sdk.captureMessage("still-running", "error")).not.toThrow();
    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).not.toHaveBeenCalled();
  });

  it("should retain buffered events when transport fails", async (): Promise<void> => {
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ status: 202 });
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "checkout-api",
      environment: "production",
      transport,
      flushInterval: 60_000
    });

    sdk.captureException(new Error("database unavailable"));

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);

    await expect(sdk.flush()).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(2);
    expect(getTransportEvents(transport, 1)).toHaveLength(1);
    expect(getEventMessage(getBackendExceptionEvent(getTransportEvents(transport, 1)[0]))).toBe("database unavailable");
  });

  it("should back off after a 429 retry response", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const transport = vi
      .fn()
      .mockResolvedValueOnce({ status: 429, retry_after_ms: 1_000 })
      .mockResolvedValueOnce({ status: 202 });
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "checkout-api",
      environment: "production",
      transport,
      flushInterval: 60_000
    });

    sdk.captureMessage("retry me", "error");

    await sdk.flush();
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-14T00:00:01.001Z"));
    await sdk.flush();
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("should drop the oldest buffered events when the queue is full", async (): Promise<void> => {
    const { sdk, transport } = createSdk({
      maxBufferedEvents: 2
    });

    sdk.captureMessage("first", "error");
    sdk.captureMessage("second", "error");
    sdk.captureMessage("third", "error");

    await sdk.flush();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(getTransportEvents(transport, 0).map(getEventMessage)).toEqual(["second", "third"]);
  });

  it("should allow beforeSend to mutate or drop events before transport", async (): Promise<void> => {
    const { sdk, transport } = createSdk({
      beforeSend: (event) => {
        if (event.event_type === "log_event" && event.payload.message === "drop me") {
          return null;
        }

        if (event.event_type === "log_event") {
          return {
            ...event,
            payload: {
              ...event.payload,
              message: `filtered:${event.payload.message}`
            }
          };
        }

        return event;
      }
    });

    sdk.captureMessage("drop me", "error");
    sdk.captureMessage("keep me", "error");
    await sdk.flush();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(getTransportEvents(transport, 0).map(getEventMessage)).toEqual(["filtered:keep me"]);
  });

  it("should keep the original event and emit diagnostics when beforeSend fails", async (): Promise<void> => {
    const diagnostics: Array<{ code: string; message: string }> = [];
    const { sdk, transport } = createSdk({
      beforeSend: () => {
        throw new Error("hook failed");
      },
      onDiagnostic: (diagnostic) => {
        diagnostics.push({
          code: diagnostic.code,
          message: diagnostic.message
        });
      }
    });

    sdk.captureMessage("keep original", "error");
    await sdk.flush();

    expect(getTransportEvents(transport, 0).map(getEventMessage)).toEqual(["keep original"]);
    expect(diagnostics).toContainEqual({
      code: "before_send_failed",
      message: "sdk-node beforeSend hook failed"
    });
  });

  it("should redact sensitive request fields before transport", async (): Promise<void> => {
    const { sdk, transport } = createSdk();

    sdk.captureException(new Error("login failed"), {
      request: {
        method: "POST",
        path: "/login",
        headers: {
          authorization: "Bearer secret-token"
        },
        query: {
          token: "query-secret"
        },
        body: {
          password: "super-secret"
        }
      },
      response: {
        statusCode: 401
      }
    });

    await sdk.flush();

    const event = getBackendExceptionEvent(getTransportEvents(transport, 0)[0]);
    expect(event.payload.request.headers["authorization"]).toBe("[REDACTED]");
    expect(event.payload.request.query["token"]).toBe("[REDACTED]");
    expect(getObjectField(event.payload.request.body, "password")).toBe("[REDACTED]");
  });

  it("should include safe process runtime facts on backend exceptions", async (): Promise<void> => {
    const { sdk, transport } = createSdk();

    sdk.captureException(new Error("runtime failed"));

    await sdk.flush();

    const runtime = getBackendExceptionEvent(getTransportEvents(transport, 0)[0]).payload.runtime;
    expect(runtime).toEqual(expect.objectContaining({
      version: process.version,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      cwd: process.cwd(),
      hostname: expect.any(String),
      uptime_sec: expect.any(Number),
      memory: expect.objectContaining({
        rss: expect.any(Number),
        heap_total: expect.any(Number),
        heap_used: expect.any(Number),
        external: expect.any(Number),
        peak: null
      })
    }));
    expect(JSON.stringify(runtime)).not.toContain("DEBUGBUNDLE_PROBE_TRIGGER_SECRET");
  });

  it("should attach always-on probe data to exceptions and keep heavy probes dormant", async (): Promise<void> => {
    const { sdk, transport } = createSdk();
    const heavyProbe = vi.fn(() => ({ plan: "full scan" }));

    sdk.probe("checkout.tax", {
      secret: "tax-secret",
      rate: 0.2
    });
    sdk.probe("db.query-plan", heavyProbe, { heavy: true });
    sdk.captureException(new Error("checkout failed"));

    await sdk.flush();

    expect(heavyProbe).not.toHaveBeenCalled();
    const probeData = getBackendExceptionEvent(getTransportEvents(transport, 0)[0]).payload.probe_data;
    expect(probeData).toEqual({
      version: 1,
      items: [
        expect.objectContaining({
          label: "checkout.tax",
          activation_id: null,
          data: {
            secret: "[REDACTED]",
            rate: 0.2
          }
        })
      ]
    });
  });

  it("should capture uncaught exceptions and unhandled rejections through vanilla hooks", async (): Promise<void> => {
    const { sdk, transport } = createSdk();

    sdk.captureExceptions();
    sdk.captureRejections();

    process.emit("uncaughtException", new Error("uncaught boom"));
    process.emit("unhandledRejection", new Error("rejected boom"), Promise.resolve());

    await sdk.flush();

    const capturedMessages = (transport.mock.calls as Array<[DebugBundleTransportRequest]>).flatMap((call) =>
      call[0].events.map(getEventMessage)
    );

    expect(capturedMessages).toEqual(["uncaught boom", "rejected boom"]);
  });

  it("should send the first three identical errors and aggregate later duplicates", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const { sdk, transport } = createSdk();

    captureRepeatedException(sdk, "duplicate checkout failure", 5);

    await sdk.flush();

    const events = getTransportEvents(transport, 0);
    expect(events.map((event) => event.event_type)).toEqual([
      "backend_exception",
      "backend_exception",
      "backend_exception",
      "error_suppressed"
    ]);

    const suppressed = getErrorSuppressedEvent(events[3]);
    expect(suppressed.payload.suppressed_count).toBe(2);
    expect(suppressed.payload.window_seconds).toBe(30);
    expect(suppressed.payload.first_seen).toBe("2026-03-14T00:00:00.000Z");
    expect(suppressed.payload.last_seen).toBe("2026-03-14T00:00:00.000Z");
    expect(suppressed.payload.fingerprint.length).toBeGreaterThan(0);
  });

  it("should keep identical errors suppressed until silence resets loop protection", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const { sdk, transport } = createSdk();

    captureRepeatedException(sdk, "recursive failure", 11);

    await sdk.flush();
    expect(getTransportEvents(transport, 0).map((event) => event.event_type)).toEqual([
      "backend_exception",
      "backend_exception",
      "backend_exception",
      "error_suppressed"
    ]);

    transport.mockClear();

    vi.setSystemTime(new Date("2026-03-14T00:00:30.000Z"));
  captureRepeatedException(sdk, "recursive failure", 2);

    await sdk.flush();

    const checkpointEvents = getTransportEvents(transport, 0);
    expect(checkpointEvents).toHaveLength(1);
    expect(checkpointEvents[0]?.event_type).toBe("error_suppressed");
    expect(getErrorSuppressedEvent(checkpointEvents[0]).payload.suppressed_count).toBe(2);

    transport.mockClear();

    vi.setSystemTime(new Date("2026-03-14T00:01:31.000Z"));
    sdk.captureException(new Error("recursive failure"));

    await sdk.flush();

    const recoveredEvents = getTransportEvents(transport, 0);
    expect(recoveredEvents).toHaveLength(1);
    expect(recoveredEvents[0]?.event_type).toBe("backend_exception");
    expect(getEventMessage(getBackendExceptionEvent(recoveredEvents[0]))).toBe("recursive failure");
  });

  it("should flush buffered events on SIGINT, SIGTERM, and beforeExit", async (): Promise<void> => {
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const beforeExitBefore = process.listenerCount("beforeExit");

    const { sdk, transport } = createSdk();

    expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    expect(process.listenerCount("beforeExit")).toBe(beforeExitBefore + 1);

    sdk.captureMessage("pending event", "error");
    expect(transport).not.toHaveBeenCalled();

    const flushSpy = vi.spyOn(sdk, "flush");
    process.emit("beforeExit", 0);
    expect(flushSpy).toHaveBeenCalledTimes(1);
    await flushSpy.mock.results[0]?.value;

    expect(transport).toHaveBeenCalledTimes(1);
    expect(getTransportEvents(transport, 0).map((e) => e.event_type)).toEqual(["log_event"]);

    sdk.dispose();
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
    expect(process.listenerCount("beforeExit")).toBe(beforeExitBefore);
  });

  it("should discard log events below the configured logLevel threshold", async (): Promise<void> => {
    const { sdk, transport } = createSdk({ logLevel: "error" });

    sdk.captureLog("debug noise", "debug");
    sdk.captureLog("info noise", "info");
    sdk.captureLog("warning noise", "warning");
    sdk.captureLog("real error", "error");
    sdk.captureLog("critical issue", "critical");

    await sdk.flush();

    const events = getTransportEvents(transport, 0);
    expect(events).toHaveLength(2);
    expect(getEventMessage(events[0]!)).toBe("real error");
    expect(getEventMessage(events[1]!)).toBe("critical issue");
  });

  it("should use file transport for local-only development mode", async (): Promise<void> => {
    const eventsDir = mkdtempSync(join(tmpdir(), "debugbundle-sdk-node-local-transport-"));
    const fetchImpl = vi.fn();

    try {
      const sdk = createDebugBundleSdk();
      activeSdks.push(sdk);
      sdk.init({
        projectToken: "dbundle_proj_test",
        service: "checkout-api",
        environment: "development",
        projectMode: "local-only",
        localEventsDir: eventsDir,
        fetchImpl: fetchImpl as typeof fetch,
        flushInterval: 60_000
      });

      sdk.captureMessage("local capture", "error");
      await sdk.flush();

      expect(fetchImpl).not.toHaveBeenCalled();

      const files = readdirSync(eventsDir).filter((file) => file.endsWith(".events.json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d+-\d+-checkout-api\.events\.json$/);

      const payload = JSON.parse(readFileSync(join(eventsDir, files[0]!), "utf8")) as EventEnvelope[];
      expect(payload).toHaveLength(1);
      expect(payload[0]?.event_type).toBe("log_event");
    } finally {
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  it("should use file transport for connected development mode", async (): Promise<void> => {
    const eventsDir = mkdtempSync(join(tmpdir(), "debugbundle-sdk-node-connected-local-"));
    const fetchImpl = vi.fn();

    try {
      const sdk = createDebugBundleSdk();
      activeSdks.push(sdk);
      sdk.init({
        projectToken: "dbundle_proj_test",
        service: "checkout-api",
        environment: "development",
        projectMode: "connected",
        localEventsDir: eventsDir,
        fetchImpl: fetchImpl as typeof fetch,
        flushInterval: 60_000
      });

      sdk.captureMessage("connected local capture", "error");
      await sdk.flush();

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(readdirSync(eventsDir).filter((file) => file.endsWith(".events.json"))).toHaveLength(1);
    } finally {
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  it("should warn and skip remote capture for production in local-only mode", async (): Promise<void> => {
    const eventsDir = mkdtempSync(join(tmpdir(), "debugbundle-sdk-node-production-local-only-"));
    const fetchImpl = vi.fn();
    const onDiagnostic = vi.fn();

    try {
      const sdk = createDebugBundleSdk();
      activeSdks.push(sdk);
      sdk.init({
        projectToken: "dbundle_proj_test",
        service: "checkout-api",
        environment: "production",
        projectMode: "local-only",
        localEventsDir: eventsDir,
        fetchImpl: fetchImpl as typeof fetch,
        onDiagnostic,
        flushInterval: 60_000
      });

      sdk.captureMessage("should not ship", "error");
      await sdk.flush();

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(readdirSync(eventsDir).filter((file) => file.endsWith(".events.json"))).toHaveLength(0);
      expect(onDiagnostic).toHaveBeenCalledWith(
        expect.objectContaining({
          code: "remote_capture_disabled",
          message:
            "DebugBundle: staging/production environment detected but project is local-only. Events will not be captured remotely. Run `debugbundle connect` to enable cloud delivery for this environment."
        })
      );
    } finally {
      rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  it("should use cloud transport for production in connected mode", async (): Promise<void> => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 202,
      headers: {
        get: vi.fn().mockReturnValue(null)
      }
    });

    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "checkout-api",
      environment: "production",
      projectMode: "connected",
      fetchImpl: fetchImpl as typeof fetch,
      flushInterval: 60_000
    });

    sdk.captureMessage("ship to cloud", "error");
    await sdk.flush();

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.debugbundle.com/v1/events",
      expect.objectContaining({
        method: "POST"
      })
    );
  });
});

describe("sdk-node health status", () => {
  it("should report disconnected before init", () => {
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    expect(sdk.status).toBe("disconnected");
    expect(sdk.lastEventAt).toBeNull();
  });

  it("should report healthy after init with no events", () => {
    const { sdk } = createSdk();
    expect(sdk.status).toBe("healthy");
    expect(sdk.lastEventAt).toBeNull();
  });

  it("should report healthy and set lastEventAt after successful flush", async () => {
    const { sdk } = createSdk();
    sdk.captureException(new Error("test-error"));
    await sdk.flush();
    expect(sdk.status).toBe("healthy");
    expect(sdk.lastEventAt).toBeTypeOf("number");
  });

  it("should report degraded when transport returns 429", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 429, retry_after_ms: 5_000 });
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "test-api",
      environment: "test",
      flushInterval: 60_000,
      transport
    });
    sdk.captureException(new Error("test-error"));
    await sdk.flush();
    expect(sdk.status).toBe("degraded");
  });

  it("should recover to healthy after a successful flush following degraded", async () => {
    let callCount = 0;
    const transport = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount === 1 ? { status: 429, retry_after_ms: 0 } : { status: 202 };
    });
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "test-api",
      environment: "test",
      flushInterval: 60_000,
      transport
    });
    sdk.captureException(new Error("first"));
    await sdk.flush();
    expect(sdk.status).toBe("degraded");

    await sdk.flush();
    expect(sdk.status).toBe("healthy");
  });

  it("should report disconnected after 3 consecutive failures", async () => {
    const transport = vi.fn().mockResolvedValue({ status: 500 });
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "test-api",
      environment: "test",
      flushInterval: 60_000,
      transport
    });
    for (let i = 0; i < 3; i++) {
      sdk.captureException(new Error(`error-${i}`));
      await sdk.flush();
    }
    expect(sdk.status).toBe("disconnected");
  });

  it("should report disconnected after 3 consecutive transport errors", async () => {
    const transport = vi.fn().mockRejectedValue(new Error("network failure"));
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "test-api",
      environment: "test",
      flushInterval: 60_000,
      transport
    });
    for (let i = 0; i < 3; i++) {
      sdk.captureException(new Error(`error-${i}`));
      await sdk.flush();
    }
    expect(sdk.status).toBe("disconnected");
  });

  it("should reset health state on dispose", async () => {
    const { sdk } = createSdk();
    sdk.captureException(new Error("test"));
    await sdk.flush();
    expect(sdk.lastEventAt).toBeTypeOf("number");

    sdk.dispose();
    expect(sdk.status).toBe("disconnected");
    expect(sdk.lastEventAt).toBeNull();
  });

  it("should reset consecutive failures on success", async () => {
    let callCount = 0;
    const transport = vi.fn().mockImplementation(async () => {
      callCount++;
      return callCount <= 2 ? { status: 500 } : { status: 202 };
    });
    const sdk = createDebugBundleSdk();
    activeSdks.push(sdk);
    sdk.init({
      projectToken: "dbundle_proj_test",
      service: "test-api",
      environment: "test",
      flushInterval: 60_000,
      transport
    });

    sdk.captureException(new Error("fail-1"));
    await sdk.flush();
    sdk.captureException(new Error("fail-2"));
    await sdk.flush();

    sdk.captureException(new Error("success"));
    await sdk.flush();
    expect(sdk.status).toBe("healthy");
    expect(sdk.lastEventAt).toBeTypeOf("number");
  });
});
