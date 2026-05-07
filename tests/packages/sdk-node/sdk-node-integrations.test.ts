import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deriveProbeTriggerTokenKey, generateProbeTriggerToken } from "../../helpers/probe-trigger-token.js";
import {
  createDebugBundleSdk,
  type DebugBundleNodeSdk,
  type DebugBundleTransportRequest
} from "../../../packages/sdk-node/src/index.js";
import type { EventEnvelope } from "@debugbundle/shared-types";

const activeSdks: DebugBundleNodeSdk[] = [];
type TransportMock = ReturnType<typeof vi.fn>;
const originalProbeTriggerSecret = process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];

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

function getTransportEvents(transport: TransportMock): EventEnvelope[] {
  const calls = transport.mock.calls as Array<[DebugBundleTransportRequest]>;
  return calls.flatMap((call) => call[0].events);
}

function getEventTypes(transport: TransportMock): EventEnvelope["event_type"][] {
  return getTransportEvents(transport).map((event) => event.event_type);
}

async function settleAsyncInit(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach((): void => {
  process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = "test-probe-secret";
});

afterEach((): void => {
  if (originalProbeTriggerSecret === undefined) {
    delete process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"];
  } else {
    process.env["DEBUGBUNDLE_PROBE_TRIGGER_SECRET"] = originalProbeTriggerSecret;
  }

  while (activeSdks.length > 0) {
    activeSdks.pop()?.dispose();
  }

  vi.restoreAllMocks();
});

describe("sdk-node framework and logger integrations", () => {
  it("should auto-detect and attach a configured logger on init", async (): Promise<void> => {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const resolveModule = vi.fn((moduleName: string) => {
      if (moduleName === "pino") {
        return "/virtual/pino/index.js";
      }

      throw new Error(`missing module ${moduleName}`);
    });

    const { transport } = createSdk({
      logger,
      resolveModule
    });

    logger.error({ query: "SELECT 1", duration_ms: 400 }, "slow query detected");

    await activeSdks[0]?.flush();

    expect(resolveModule).toHaveBeenCalledWith("pino");
    expect(getEventTypes(transport)).toContain("log_event");
    expect(
      getTransportEvents(transport).find((event) => event.event_type === "log_event" && event.payload.message === "slow query detected")
    ).toBeDefined();
  });

  it("should capture express requests and auto-attach an app logger through middleware", async (): Promise<void> => {
    const { sdk, transport } = createSdk();
    const middleware = sdk.express();
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    };
    const req = {
      method: "GET",
      path: "/checkout",
      headers: {
        "x-request-id": "req_123"
      },
      query: {
        orderId: "ord_123"
      },
      app: {
        locals: {
          logger
        }
      }
    };
    const res = {
      statusCode: 200,
      end: vi.fn()
    };
    const next = vi.fn();

    middleware(req, res, next);
    logger.error({ orderId: "ord_123" }, "express logger failed");
    res.end("ok");

    await sdk.flush();

    expect(next).toHaveBeenCalledTimes(1);
    expect(getEventTypes(transport)).toEqual(["log_event", "request_event"]);
  });

  it("should register fastify hooks and attach the built-in logger", async (): Promise<void> => {
    const { sdk, transport } = createSdk();
    const hooks: Record<string, (...args: unknown[]) => unknown> = {};
    const fastify = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      addHook: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        hooks[name] = handler;
      })
    };
    const done = vi.fn();

    sdk.fastify()(fastify, {}, done);
    fastify.log.error({ requestId: "req_fastify" }, "fastify exploded");
    await hooks["onResponse"]?.(
      {
        method: "POST",
        routeOptions: { url: "/orders/:id" },
        headers: {},
        query: {},
        body: { token: "secret" },
        url: "/orders/123"
      },
      {
        statusCode: 502,
        elapsedTime: 18
      }
    );
    await hooks["onError"]?.(
      { method: "POST", url: "/orders/123", headers: {}, query: {} },
      { statusCode: 500 },
      new Error("fastify error"),
      vi.fn()
    );

    await sdk.flush();

    expect(done).toHaveBeenCalledTimes(1);
    expect(getEventTypes(transport)).toEqual(["log_event", "request_event", "backend_exception"]);
  });

  it("should capture a 500 backend exception when fastify onError still reports reply status 200", async (): Promise<void> => {
    const { sdk, transport } = createSdk();
    const hooks: Record<string, (...args: unknown[]) => unknown> = {};
    const fastify = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      addHook: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        hooks[name] = handler;
      })
    };

    sdk.fastify()(fastify, {}, () => undefined);

    await hooks["onError"]?.(
      { method: "POST", url: "/orders/123", headers: {}, query: {} },
      { statusCode: 200 },
      new Error("fastify error"),
      vi.fn()
    );

    await sdk.flush();

    const backendException = getTransportEvents(transport).find((event) => event.event_type === "backend_exception");
    expect(backendException).toBeDefined();
    expect(backendException?.event_type).toBe("backend_exception");
    if (backendException?.event_type === "backend_exception") {
      expect(backendException.payload.response.status_code).toBe(500);
    }
  });

  it("should ignore sdk self-ingestion routes during fastify request instrumentation", async (): Promise<void> => {
    const { sdk, transport } = createSdk({
      endpoint: "http://127.0.0.1:3000/v1/events"
    });
    const hooks: Record<string, (...args: unknown[]) => unknown> = {};
    const fastify = {
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
      },
      addHook: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
        hooks[name] = handler;
      })
    };

    sdk.fastify()(fastify, {}, () => undefined);

    await hooks["onRequest"]?.(
      {
        method: "POST",
        routeOptions: { url: "/v1/events" },
        headers: {},
        query: {},
        body: { events: [] },
        url: "/v1/events"
      },
      {},
      vi.fn()
    );
    await hooks["onResponse"]?.(
      {
        method: "POST",
        routeOptions: { url: "/v1/events" },
        headers: {},
        query: {},
        body: { events: [] },
        url: "/v1/events"
      },
      {
        statusCode: 202,
        elapsedTime: 5
      }
    );

    await sdk.flush();

    expect(getEventTypes(transport)).toEqual([]);
  });

  it("should wrap nextjs api handlers and auto-capture console errors", async (): Promise<void> => {
    const { sdk, transport } = createSdk();
    const handler = sdk.nextjs((_req, res) => {
      console.error("next handler warning");
      res.statusCode = 204;
      throw new Error("next handler failed");
    });

    await expect(
      handler(
        {
          method: "DELETE",
          url: "/api/orders/123",
          headers: {},
          query: {}
        },
        {
          statusCode: 200
        }
      )
    ).rejects.toThrow("next handler failed");

    await sdk.flush();

    expect(getEventTypes(transport)).toEqual(["log_event", "backend_exception"]);
  });

  it("should activate a heavy probe for a single express request via trigger-token query", async (): Promise<void> => {
    const projectId = "proj_123";
    const triggerTokenKey = deriveProbeTriggerTokenKey(projectId);
    const triggerToken = generateProbeTriggerToken({
      projectId,
      payload: {
        activation_id: "11111111-1111-4111-8111-111111111111",
        label_pattern: "checkout.*",
        service: "checkout-api",
        environment: "production",
        trigger_expires_at: "2036-03-20T00:00:00.000Z"
      }
    }).plaintext;
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          probes_enabled: true,
          remote_probes_enabled: true,
          active_probes: [],
          poll_interval_ms: 60000,
          trigger_token_key: triggerTokenKey
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json"
          }
        }
      )
    );

    const { sdk, transport } = createSdk({ fetchImpl });
    await settleAsyncInit();

    const middleware = sdk.express();
    const req = {
      method: "GET",
      path: "/checkout",
      headers: {},
      query: {
        _debug_probe: triggerToken
      },
      app: {
        locals: {
          logger: {
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn()
          }
        }
      }
    };
    const res = {
      statusCode: 200,
      end: vi.fn()
    };

    middleware(req, res, () => {
      sdk.probe("checkout.tax", () => ({ total: 42 }), { heavy: true });
    });
    res.end("ok");

    await sdk.flush();

    expect(getEventTypes(transport)).toContain("probe_event");
    expect(
      getTransportEvents(transport).find(
        (event) => event.event_type === "probe_event" && event.payload.probe_label_pattern === "checkout.*"
      )
    ).toBeDefined();
  });
});