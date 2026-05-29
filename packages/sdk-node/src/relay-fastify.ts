import { createBrowserRelay, type BrowserRelayOptions } from "./relay.js";

const DEFAULT_RELAY_ROUTE_PATH = "/debugbundle/browser";

type FastifyRelayRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string | null;
};

type FastifyRelayReply = {
  header?: (name: string, value: string) => unknown;
  code: (statusCode: number) => {
    send: (body: unknown) => void;
  };
};

type FastifyRelayPluginOptions = BrowserRelayOptions & {
  routePath?: string;
};

type FastifyRouteRegistrar = {
  route: (definition: {
    method: "OPTIONS" | "POST";
    url: string;
    handler: (request: unknown, reply: unknown) => Promise<void>;
  }) => void;
};

function applyRelayHeaders(reply: FastifyRelayReply, headers: Record<string, string> | undefined): void {
  if (headers === undefined || typeof reply.header !== "function") {
    return;
  }

  for (const [key, value] of Object.entries(headers)) {
    reply.header(key, value);
  }
}

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

  const handler = async (requestInput: unknown, replyInput: unknown): Promise<void> => {
    const request = requestInput as FastifyRelayRequest;
    const reply = replyInput as FastifyRelayReply;
    const relayResponse = await relay({
      method: request.method ?? "POST",
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      body: serializeRelayBody(request.body),
      ipAddress: request.ip ?? null
    });

    applyRelayHeaders(reply, relayResponse.headers);
    reply.code(relayResponse.status).send(relayResponse.body);
  };

  fastify.route({
    method: "OPTIONS",
    url: routePath,
    handler
  });

  fastify.route({
    method: "POST",
    url: routePath,
    handler
  });

  done();
}