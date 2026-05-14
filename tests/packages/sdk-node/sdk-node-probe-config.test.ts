import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDebugBundleSdk,
  type DebugBundleNodeSdk,
  type DebugBundleTransportRequest
} from "../../../packages/sdk-node/src/index.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

const activeSdks: DebugBundleNodeSdk[] = [];
type TransportMock = ReturnType<typeof vi.fn>;
type ProbeEvent = Extract<EventEnvelope, { event_type: "probe_event" }>;

function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    },
    ...init
  });
}

function getTransportEvents(transport: TransportMock, callIndex: number): EventEnvelope[] {
  const calls = transport.mock.calls as Array<[DebugBundleTransportRequest]>;
  return calls[callIndex]?.[0].events ?? [];
}

function getProbeEvent(event: EventEnvelope | undefined): ProbeEvent {
  if (event === undefined || event.event_type !== "probe_event") {
    throw new Error("Expected a probe_event");
  }

  return event;
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function settleConfigPolling(): Promise<void> {
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(0);
}

function createSdk(
  overrides: Parameters<DebugBundleNodeSdk["init"]>[0] = {}
): { sdk: DebugBundleNodeSdk; transport: TransportMock } {
  const transport = vi.fn<(request: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
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

afterEach((): void => {
  while (activeSdks.length > 0) {
    activeSdks.pop()?.dispose();
  }

  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("sdk-node remote probe config", () => {
  it("should skip recurring polling when remote probes are disabled", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createJsonResponse({
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        poll_interval_ms: 60_000
      })
    );

    createSdk({
      fetchImpl,
      probesPollInterval: 15_000
    });

    await settleConfigPolling();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.debugbundle.com/v1/sdk/config",
      expect.objectContaining({
        method: "GET"
      })
    );
  });

  it("should poll sdk config with ETag and activate heavy probes only while directives are active", async (): Promise<void> => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-14T00:00:00.000Z"));

    const activationId = "550e8400-e29b-41d4-a716-446655440000";
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse(
          {
            probes_enabled: true,
            remote_probes_enabled: true,
            active_probes: [
              {
                id: activationId,
                label_pattern: "checkout.*",
                service: "checkout-api",
                environment: "production",
                expires_at: "2026-03-14T00:00:10.000Z"
              }
            ],
            poll_interval_ms: 15_000
          },
          {
            headers: {
              etag: '"cfg-1"'
            }
          }
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 304, headers: { etag: '"cfg-1"' } }));

    const { sdk, transport } = createSdk({
      fetchImpl,
      probesPollInterval: 60_000
    });

    await settleConfigPolling();

    const heavyProbe = vi.fn(() => ({ tax_rate: 0.2 }));
    sdk.probe("checkout.tax", heavyProbe, { heavy: true });
    await sdk.flush();

    expect(heavyProbe).toHaveBeenCalledTimes(1);
    const firstEvents = getTransportEvents(transport, 0);
    expect(firstEvents).toHaveLength(1);
    const probeEvent = getProbeEvent(firstEvents[0]);
    expect(probeEvent.payload.activation_id).toBe(activationId);
    expect(probeEvent.payload.probe_label_pattern).toBe("checkout.*");
    expect(probeEvent.payload.data).toEqual({ tax_rate: 0.2 });

    transport.mockClear();

    await vi.advanceTimersByTimeAsync(15_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondCallHeaders = new Headers((fetchImpl.mock.calls[1]?.[1] as RequestInit | undefined)?.headers);
    expect(secondCallHeaders.get("if-none-match")).toBe('"cfg-1"');

    vi.setSystemTime(new Date("2026-03-14T00:00:11.000Z"));
    sdk.probe("checkout.tax", heavyProbe, { heavy: true });
    await sdk.flush();

    expect(heavyProbe).toHaveBeenCalledTimes(1);
    expect(transport).not.toHaveBeenCalled();
  });

  it("should emit a diagnostic and retry with the default interval when a refresh returns an invalid config", async (): Promise<void> => {
    vi.useFakeTimers();

    const onDiagnostic = vi.fn<(diagnostic: { code: string; message: string; metadata?: Record<string, unknown> }) => void>();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          probes_enabled: true,
          remote_probes_enabled: true,
          active_probes: [],
          poll_interval_ms: 15_000
        })
      )
      .mockResolvedValueOnce(createJsonResponse(null))
      .mockResolvedValueOnce(
        createJsonResponse({
          probes_enabled: true,
          remote_probes_enabled: true,
          active_probes: [],
          poll_interval_ms: 15_000
        })
      );

    createSdk({
      fetchImpl,
      probesPollInterval: 25_000,
      onDiagnostic
    });

    await settleConfigPolling();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledWith({
      code: "remote_probe_config_invalid",
      message: "sdk-node received an invalid remote probe config payload"
    });

    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("should emit a diagnostic and retry with the default interval when a refresh fails", async (): Promise<void> => {
    vi.useFakeTimers();

    const onDiagnostic = vi.fn<(diagnostic: { code: string; message: string; metadata?: Record<string, unknown> }) => void>();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        createJsonResponse({
          probes_enabled: true,
          remote_probes_enabled: true,
          active_probes: [],
          poll_interval_ms: 15_000
        })
      )
      .mockRejectedValueOnce(new Error("config refresh failed"))
      .mockResolvedValueOnce(
        createJsonResponse({
          probes_enabled: true,
          remote_probes_enabled: true,
          active_probes: [],
          poll_interval_ms: 15_000
        })
      );

    createSdk({
      fetchImpl,
      probesPollInterval: 25_000,
      onDiagnostic
    });

    await settleConfigPolling();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    const diagnostic = onDiagnostic.mock.calls[0]?.[0] as { code?: string; message?: string; metadata?: Record<string, unknown> } | undefined;
    expect(diagnostic?.code).toBe("remote_probe_config_failed");
    expect(diagnostic?.message).toBe("sdk-node failed to refresh remote probe config");
    const diagnosticError = diagnostic?.metadata?.["error"] as { message?: string; name?: string; stack?: string | null } | undefined;
    expect(diagnosticError?.message).toBe("config refresh failed");
    expect(diagnosticError?.name).toBe("Error");
    expect(typeof diagnosticError?.stack).toBe("string");

    await vi.advanceTimersByTimeAsync(24_999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("sdk-node capture policy enforcement", () => {
  function createConfigResponse(capturePolicy: Record<string, unknown>): Response {
    return createJsonResponse({
      probes_enabled: false,
      remote_probes_enabled: false,
      active_probes: [],
      poll_interval_ms: 60_000,
      capture_policy: capturePolicy
    });
  }

  const BALANCED_POLICY = {
    preset: "balanced",
    capture_logs: "warning",
    capture_request_events: "all",
    capture_breadcrumbs: "local_only",
    capture_probe_events: "standalone_when_activated",
    immediate_client_error_statuses: []
  };

  it("should filter log events based on capture_logs policy from server config", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        capture_logs: "error"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl, logLevel: "info" });
    await settleConfigPolling();

    sdk.captureLog("info message", "info");
    sdk.captureLog("warning message", "warning");
    sdk.captureLog("error message", "error");
    sdk.captureLog("critical message", "critical");
    await sdk.flush();

    const events = getTransportEvents(transport, 0);
    const logMessages = events
      .filter((e) => e.event_type === "log_event")
      .map((e) => e.payload.message);

    expect(logMessages).toEqual(["error message", "critical message"]);
  });

  it("should discard all logs when capture_logs is off", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        capture_logs: "off"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleConfigPolling();

    sdk.captureLog("should be dropped", "error");
    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();
  });

  it("should discard non-critical request events when capture_request_events is off", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        capture_request_events: "off"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleConfigPolling();

    sdk.captureRequest({ method: "GET", path: "/api/test" }, { statusCode: 200 });
    await sdk.flush();

    expect(transport).not.toHaveBeenCalled();
  });

  it("should still capture 500+ request events when capture_request_events is off", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        capture_request_events: "off"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleConfigPolling();

    sdk.captureRequest({ method: "POST", path: "/api/test" }, { statusCode: 503 });
    await sdk.flush();

    const requestEvents = getTransportEvents(transport, 0).filter((event) => event.event_type === "request_event");
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]?.payload).toMatchObject({ path: "/api/test", response_status: 503 });
  });

  it("should capture configured client error incidents even when capture_request_events is off", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        preset: "minimal",
        capture_request_events: "off",
        immediate_client_error_statuses: [403]
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleConfigPolling();

    sdk.captureRequest({ method: "POST", path: "/forbidden" }, { statusCode: 403 });
    await sdk.flush();

    const requestEvents = getTransportEvents(transport, 0).filter((event) => event.event_type === "request_event");
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]?.payload).toMatchObject({ path: "/forbidden", response_status: 403 });
  });

  it("should capture balanced request failures and anomaly candidates when capture_request_events is failures_only", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        capture_request_events: "failures_only"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleConfigPolling();

    sdk.captureRequest({ method: "GET", path: "/ok" }, { statusCode: 200 });
    sdk.captureRequest({ method: "GET", path: "/not-found" }, { statusCode: 404 });
    sdk.captureRequest({ method: "POST", path: "/rate-limited" }, { statusCode: 429 });
    sdk.captureRequest({ method: "POST", path: "/conflict" }, { statusCode: 409 });
    sdk.captureRequest({ method: "POST", path: "/error" }, { statusCode: 500 });
    sdk.captureRequest({ method: "POST", path: "/gateway" }, { statusCode: 502 });
    await sdk.flush();

    const events = getTransportEvents(transport, 0);
    const requestPaths = events
      .filter((e) => e.event_type === "request_event")
      .map((e) => e.payload.path);

    expect(requestPaths).toEqual(["/not-found", "/rate-limited", "/conflict", "/error", "/gateway"]);
  });

  it("should still capture investigative 409 request events when capture_request_events is off", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        preset: "investigative",
        capture_request_events: "off"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleConfigPolling();

    sdk.captureRequest({ method: "POST", path: "/conflict" }, { statusCode: 409 });
    await sdk.flush();

    const requestEvents = getTransportEvents(transport, 0).filter((event) => event.event_type === "request_event");
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]?.payload).toMatchObject({ path: "/conflict", response_status: 409 });
  });

  it("should capture all request events when capture_request_events is all", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        capture_request_events: "all"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleConfigPolling();

    sdk.captureRequest({ method: "GET", path: "/ok" }, { statusCode: 200 });
    sdk.captureRequest({ method: "POST", path: "/error" }, { statusCode: 500 });
    await sdk.flush();

    const events = getTransportEvents(transport, 0);
    const requestPaths = events
      .filter((e) => e.event_type === "request_event")
      .map((e) => e.payload.path);

    expect(requestPaths).toEqual(["/ok", "/error"]);
  });

  it("should use effective log threshold that is the higher of init config and capture policy", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockResolvedValue(
      createConfigResponse({
        ...BALANCED_POLICY,
        capture_logs: "info"
      })
    );

    const { sdk, transport } = createSdk({ fetchImpl, logLevel: "warning" });
    await settleConfigPolling();

    sdk.captureLog("info message", "info");
    sdk.captureLog("warning message", "warning");
    await sdk.flush();

    const events = getTransportEvents(transport, 0);
    const logMessages = events
      .filter((e) => e.event_type === "log_event")
      .map((e) => e.payload.message);

    expect(logMessages).toEqual(["warning message"]);
  });

  it("should fallback to minimal capture policy when initial config fetch fails", async (): Promise<void> => {
    vi.useFakeTimers();

    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));

    const { sdk, transport } = createSdk({ fetchImpl, logLevel: "info" });
    await settleConfigPolling();

    sdk.captureRequest({ method: "GET", path: "/ok" }, { statusCode: 200 });
    sdk.captureRequest({ method: "GET", path: "/not-found" }, { statusCode: 404 });
    sdk.captureRequest({ method: "POST", path: "/boom" }, { statusCode: 503 });
    sdk.captureLog("info message", "info");
    sdk.captureLog("warning message", "warning");
    sdk.captureLog("error message", "error");
    await sdk.flush();

    const events = getTransportEvents(transport, 0);
    const logMessages = events
      .filter((e) => e.event_type === "log_event")
      .map((e) => e.payload.message);

    expect(logMessages).toEqual(["error message"]);

    const requestEvents = events.filter((e) => e.event_type === "request_event");
    expect(requestEvents).toHaveLength(1);
    expect(requestEvents[0]?.payload).toMatchObject({ path: "/boom", response_status: 503 });
  });
});
