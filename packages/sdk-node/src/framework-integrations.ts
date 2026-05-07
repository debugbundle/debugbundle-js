import type {
  CaptureRequestInput,
  CaptureResponseInput,
  FrameworkSdkBridge,
  NextApiHandler,
  NextWrappedHandler
} from "./types.js";

function buildRequestSnapshot(input: {
  method: string | undefined;
  path: string | undefined;
  headers: Record<string, unknown> | undefined;
  query: Record<string, unknown> | undefined;
  body: unknown;
  routeTemplate: string | null | undefined;
}): CaptureRequestInput {
  return {
    ...(input.method === undefined ? {} : { method: input.method }),
    ...(input.path === undefined ? {} : { path: input.path }),
    ...(input.headers === undefined ? {} : { headers: input.headers }),
    ...(input.query === undefined ? {} : { query: input.query }),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(input.routeTemplate === undefined ? {} : { routeTemplate: input.routeTemplate })
  };
}

function buildResponseSnapshot(input: {
  statusCode?: number;
  durationMs?: number;
}): CaptureResponseInput {
  return {
    ...(input.statusCode === undefined ? {} : { statusCode: input.statusCode }),
    ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs })
  };
}

function captureWithConsoleFallback(sdk: FrameworkSdkBridge, logger: unknown): void {
  const attached = sdk.attachLogger(logger);
  if (!attached) {
    sdk.captureConsole();
  }
}

function expressRequestSnapshot(request: {
  method?: string;
  path?: string;
  originalUrl?: string;
  url?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  route?: { path?: string };
}): CaptureRequestInput {
  return buildRequestSnapshot({
    method: request.method,
    path: request.path ?? request.originalUrl ?? request.url,
    headers: request.headers,
    query: request.query,
    body: request.body,
    routeTemplate: request.route?.path ?? null
  });
}

export function createExpressMiddleware(sdk: FrameworkSdkBridge): (
  req: {
    method?: string;
    path?: string;
    originalUrl?: string;
    url?: string;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
    route?: { path?: string };
    app?: { locals?: { logger?: unknown }; logger?: unknown };
    logger?: unknown;
    log?: unknown;
  },
  res: { statusCode?: number; end?: (...args: unknown[]) => unknown },
  next: (error?: unknown) => void
) => void {
  return (req, res, next): void => {
    const requestSnapshot = expressRequestSnapshot(req);
    const shouldInstrumentRequest = sdk.shouldInstrumentRequest?.bind(sdk) ?? (() => true);
    if (!shouldInstrumentRequest(requestSnapshot)) {
      next();
      return;
    }

    const run = sdk.runWithRequestContext?.bind(sdk) ?? ((_: CaptureRequestInput, callback: () => void) => callback());

    run(requestSnapshot, () => {
      captureWithConsoleFallback(sdk, req.app?.locals?.logger ?? req.app?.logger ?? req.logger ?? req.log);

      const startedAt = Date.now();
      let requestCaptured = false;
      const originalEnd = typeof res.end === "function" ? res.end : undefined;

      const finalize = (): void => {
        if (requestCaptured) {
          return;
        }

        requestCaptured = true;
        sdk.captureRequest(
          requestSnapshot,
          buildResponseSnapshot({
            ...(res.statusCode === undefined ? {} : { statusCode: res.statusCode }),
            durationMs: Date.now() - startedAt
          })
        );
      };

      if (originalEnd !== undefined) {
        res.end = (...args: unknown[]): unknown => {
          finalize();
          return Reflect.apply(originalEnd, res, args);
        };
      }

      next();
    });
  };
}

export function createFastifyPlugin(sdk: FrameworkSdkBridge): (
  fastify: {
    log?: unknown;
    addHook: (name: string, handler: (...args: unknown[]) => unknown) => void;
  },
  options: Record<string, unknown>,
  done: () => void
) => void {
  return (fastify, _options, done): void => {
    captureWithConsoleFallback(sdk, fastify.log);

    const onRequest = (...args: unknown[]): void => {
      const [request, , next] = args as [
        {
          method?: string;
          url?: string;
          headers?: Record<string, unknown>;
          query?: Record<string, unknown>;
          body?: unknown;
          routeOptions?: { url?: string };
        },
        unknown,
        () => void
      ];

      const requestSnapshot = buildRequestSnapshot({
        method: request.method,
        path: request.url,
        headers: request.headers,
        query: request.query,
        body: request.body,
        routeTemplate: request.routeOptions?.url ?? null
      });
      const shouldInstrumentRequest = sdk.shouldInstrumentRequest?.bind(sdk) ?? (() => true);
      if (!shouldInstrumentRequest(requestSnapshot)) {
        next();
        return;
      }

      const run = sdk.runWithRequestContext?.bind(sdk) ?? ((_: CaptureRequestInput, callback: () => void) => callback());
      run(requestSnapshot, () => next());
    };

    fastify.addHook("onRequest", onRequest);

    const onResponse = (...args: unknown[]): void => {
      const [request, reply] = args as [
        {
          method?: string;
          url?: string;
          headers?: Record<string, unknown>;
          query?: Record<string, unknown>;
          body?: unknown;
          routeOptions?: { url?: string };
        },
        { statusCode?: number; elapsedTime?: number }
      ];

      const requestSnapshot = buildRequestSnapshot({
        method: request.method,
        path: request.url,
        headers: request.headers,
        query: request.query,
        body: request.body,
        routeTemplate: request.routeOptions?.url ?? null
      });
      const shouldInstrumentRequest = sdk.shouldInstrumentRequest?.bind(sdk) ?? (() => true);
      if (!shouldInstrumentRequest(requestSnapshot)) {
        return;
      }

      sdk.captureRequest(
        requestSnapshot,
        buildResponseSnapshot({
          ...(reply.statusCode === undefined ? {} : { statusCode: reply.statusCode }),
          ...(reply.elapsedTime === undefined ? {} : { durationMs: reply.elapsedTime })
        })
      );
    };

    fastify.addHook("onResponse", onResponse);

    const resolveFastifyErrorStatusCode = (replyStatusCode: number | undefined, error: unknown): number => {
      if (typeof error === "object" && error !== null) {
        const statusCode = "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
        if (typeof statusCode === "number" && Number.isFinite(statusCode) && statusCode >= 400) {
          return statusCode;
        }
      }

      if (typeof replyStatusCode === "number" && Number.isFinite(replyStatusCode) && replyStatusCode >= 400) {
        return replyStatusCode;
      }

      return 500;
    };

    const onError = (...args: unknown[]): void => {
      const [request, reply, error, done] = args as [
        {
          method?: string;
          url?: string;
          headers?: Record<string, unknown>;
          query?: Record<string, unknown>;
          body?: unknown;
          routeOptions?: { url?: string };
        },
        { statusCode?: number },
        unknown,
        (() => void) | undefined
      ];

      const requestSnapshot = buildRequestSnapshot({
        method: request.method,
        path: request.url,
        headers: request.headers,
        query: request.query,
        body: request.body,
        routeTemplate: request.routeOptions?.url ?? null
      });
      const shouldInstrumentRequest = sdk.shouldInstrumentRequest?.bind(sdk) ?? (() => true);
      if (!shouldInstrumentRequest(requestSnapshot)) {
        return;
      }

      sdk.captureException(error, {
        handled: false,
        request: requestSnapshot,
        response: buildResponseSnapshot({
          statusCode: resolveFastifyErrorStatusCode(reply.statusCode, error)
        })
      });

      done?.();
    };

    fastify.addHook("onError", onError);

    done();
  };
}

export function createNextHandlerWrapper<Request extends {
  method?: string;
  url?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  logger?: unknown;
  log?: unknown;
}, Response extends { statusCode?: number }, Result>(
  sdk: FrameworkSdkBridge,
  handler: NextApiHandler<Request, Response, Result>
): NextWrappedHandler<Request, Response, Result> {
  return async (request, response): Promise<Result> => {
    const requestSnapshot = buildRequestSnapshot({
      method: request.method,
      path: request.url,
      headers: request.headers,
      query: request.query,
      body: request.body,
      routeTemplate: request.url ?? null
    });
    const shouldInstrumentRequest = sdk.shouldInstrumentRequest?.bind(sdk) ?? (() => true);
    if (!shouldInstrumentRequest(requestSnapshot)) {
      return handler(request, response);
    }

    const run = sdk.runWithRequestContext?.bind(sdk) ?? ((_: CaptureRequestInput, callback: () => Promise<Result>) => callback());

    return run(requestSnapshot, async () => {
      captureWithConsoleFallback(sdk, request.logger ?? request.log);

      try {
        return await handler(request, response);
      } catch (error) {
        sdk.captureException(error, {
          handled: false,
          request: requestSnapshot,
          response: buildResponseSnapshot({
            statusCode: response.statusCode ?? 500
          })
        });
        throw error;
      }
    });
  };
}