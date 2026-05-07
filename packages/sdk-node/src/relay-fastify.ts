import { createBrowserRelay, type BrowserRelayOptions } from "./relay.js";

const DEFAULT_RELAY_ROUTE_PATH = "/debugbundle/browser";

type FastifyRelayRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string | null;
};

type FastifyRelayReply = {
  code: (statusCode: number) => {
    send: (body: unknown) => void;
  };
};

type FastifyRelayPluginOptions = BrowserRelayOptions & {
  routePath?: string;
};

type FastifyRouteRegistrar = {
  route: (definition: {
    method: "POST";
    url: string;
    handler: (request: unknown, reply: unknown) => Promise<void>;
  }) => void;
};

function serializeRelayBody(body: unknown): string | Uint8Array {
  if (typeof body === "string" || body instanceof Uint8Array) {
    return body;
  }

  if (body === undefined) {
    return "";
  }

  return JSON.stringify(body);
}

export function debugBundleRelayPlugin(
  fastify: FastifyRouteRegistrar,
  options: FastifyRelayPluginOptions = {},
  done: () => void
): void {
  const { routePath = DEFAULT_RELAY_ROUTE_PATH, ...relayOptions } = options;
  const relay = createBrowserRelay(relayOptions);

  fastify.route({
    method: "POST",
    url: routePath,
    handler: async (requestInput, replyInput): Promise<void> => {
      const request = requestInput as FastifyRelayRequest;
      const reply = replyInput as FastifyRelayReply;
      const relayResponse = await relay({
        method: request.method ?? "POST",
        ...(request.headers === undefined ? {} : { headers: request.headers }),
        body: serializeRelayBody(request.body),
        ipAddress: request.ip ?? null
      });

      reply.code(relayResponse.status).send(relayResponse.body);
    }
  });

  done();
}