import { describe, expect, it, vi } from "vitest";

import { createExpressMiddleware, createFastifyPlugin, createNextHandlerWrapper } from "../../../packages/sdk-node/src/framework-integrations.js";
import type { FrameworkSdkBridge } from "../../../packages/sdk-node/src/types.js";

function createSdkBridge(overrides: Partial<FrameworkSdkBridge> = {}): FrameworkSdkBridge {
  return {
    attachLogger: vi.fn().mockReturnValue(true),
    captureConsole: vi.fn(),
    captureException: vi.fn(),
    captureRequest: vi.fn(),
    ...overrides
  };
}

describe("sdk-node framework integrations direct", () => {
  it("should fall back to console capture for express and skip request capture when response.end is missing", (): void => {
    const attachLogger = vi.fn().mockReturnValue(false);
    const captureConsole = vi.fn();
    const captureRequest = vi.fn();
    const sdk = createSdkBridge({ attachLogger, captureConsole, captureRequest });
    const middleware = createExpressMiddleware(sdk);
    const next = vi.fn();

    middleware(
      {
        method: "GET",
        originalUrl: "/orders/42?expand=1",
        headers: { "x-request-id": "req_1" },
        query: { expand: "1" },
        log: { info: vi.fn() }
      },
      {
        statusCode: 204
      },
      next
    );

    expect(attachLogger).toHaveBeenCalled();
    expect(captureConsole).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(captureRequest).not.toHaveBeenCalled();
  });

  it("should wrap express responses once and preserve request context snapshots", (): void => {
    const runWithRequestContextImpl: NonNullable<FrameworkSdkBridge["runWithRequestContext"]> = (_request, callback) => callback();
    const runWithRequestContext = vi.fn(runWithRequestContextImpl) as typeof runWithRequestContextImpl;
    const captureRequest = vi.fn();
    const sdk = createSdkBridge({ runWithRequestContext, captureRequest });
    const middleware = createExpressMiddleware(sdk);
    const end = vi.fn();
    const next = vi.fn();
    const response = {
      statusCode: 201,
      end
    };

    middleware(
      {
        method: "POST",
        url: "/orders/123",
        headers: { authorization: "Bearer test" },
        query: { preview: "1" },
        body: { id: 123 },
        route: { path: "/orders/:id" },
        logger: { info: vi.fn() }
      },
      response,
      next
    );

    response.end("ok");
    response.end("again");

    expect(runWithRequestContext).toHaveBeenCalledWith(
      {
        method: "POST",
        path: "/orders/123",
        headers: { authorization: "Bearer test" },
        query: { preview: "1" },
        body: { id: 123 },
        routeTemplate: "/orders/:id"
      },
      expect.any(Function)
    );
    expect(captureRequest).toHaveBeenCalledTimes(1);
    expect(captureRequest).toHaveBeenCalledTimes(1);
    const requestCall = captureRequest.mock.calls[0];
    expect(requestCall?.[0]).toEqual({
      method: "POST",
      path: "/orders/123",
      headers: { authorization: "Bearer test" },
      query: { preview: "1" },
      body: { id: 123 },
      routeTemplate: "/orders/:id"
    });
    const responseSnapshot = requestCall?.[1] as { statusCode?: number; durationMs?: number } | undefined;
    expect(responseSnapshot?.statusCode).toBe(201);
    expect(typeof responseSnapshot?.durationMs).toBe("number");
  });

  it("should register fastify hooks without an error handler and capture responses with sparse reply metadata", (): void => {
    const attachLogger = vi.fn().mockReturnValue(false);
    const captureConsole = vi.fn();
    const captureException = vi.fn();
    const captureRequest = vi.fn();
    const sdk = createSdkBridge({ attachLogger, captureConsole, captureException, captureRequest });
    const hooks: Partial<Record<"onRequest" | "onResponse", (...args: unknown[]) => unknown>> = {};
    const done = vi.fn();
    createFastifyPlugin(sdk)(
      {
        log: { warn: vi.fn() },
        addHook: vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
          hooks[name as "onRequest" | "onResponse"] = handler;
        })
      },
      {},
      done
    );

    hooks["onRequest"]?.(
      {
        method: "PATCH",
        url: "/orders/123",
        headers: { "x-trace-id": "trace_1" },
        query: { include: "items" }
      },
      {},
      vi.fn()
    );
    hooks["onResponse"]?.(
      {
        method: "PATCH",
        url: "/orders/123",
        headers: { "x-trace-id": "trace_1" },
        query: { include: "items" }
      },
      {}
    );

    expect(captureConsole).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
    expect(captureRequest).toHaveBeenCalledWith(
      {
        method: "PATCH",
        path: "/orders/123",
        headers: { "x-trace-id": "trace_1" },
        query: { include: "items" },
        routeTemplate: null
      },
      {}
    );
  });

  it("should wrap next handlers on the success path and fall back to request.log", async (): Promise<void> => {
    const attachLogger = vi.fn().mockReturnValue(false);
    const captureConsole = vi.fn();
    const captureException = vi.fn();
    const sdk = createSdkBridge({ attachLogger, captureConsole, captureException });
    const handler = createNextHandlerWrapper(sdk, () => Promise.resolve("ok"));

    await expect(
      handler(
        {
          method: "DELETE",
          url: "/api/orders/123",
          headers: { accept: "application/json" },
          query: { force: "1" },
          body: { hard: true },
          log: { error: vi.fn() }
        },
        {
          statusCode: 202
        }
      )
    ).resolves.toBe("ok");

    expect(captureConsole).toHaveBeenCalledTimes(1);
    expect(captureException).not.toHaveBeenCalled();
  });

  it("should capture next handler failures with a default 500 status", async (): Promise<void> => {
    const captureException = vi.fn();
    const sdk = createSdkBridge({ captureException });
    const handler = createNextHandlerWrapper(sdk, () => Promise.reject(new Error("next failed")));

    await expect(handler({ url: "/api/fail" }, {})).rejects.toThrow("next failed");

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      {
        handled: false,
        request: {
          path: "/api/fail",
          routeTemplate: "/api/fail"
        },
        response: {
          statusCode: 500
        }
      }
    );
  });
});