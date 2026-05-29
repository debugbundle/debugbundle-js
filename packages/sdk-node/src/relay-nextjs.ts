import { createBrowserRelay, type BrowserRelayOptions } from "./relay.js";

function getRelayIpAddress(request: Request): string | null {
  return request.headers.get("x-forwarded-for") ?? request.headers.get("x-real-ip");
}

function getRelayHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return headers;
}

export function createNextjsRelayHandler(options: BrowserRelayOptions = {}) {
  const relay = createBrowserRelay(options);

  return async (request: Request): Promise<Response> => {
    const relayResponse = await relay({
      method: request.method,
      headers: getRelayHeaders(request),
      body: await request.text(),
      ipAddress: getRelayIpAddress(request)
    });

    if (relayResponse.body === undefined) {
      return new Response(null, {
        status: relayResponse.status,
        ...(relayResponse.headers === undefined ? {} : { headers: relayResponse.headers })
      });
    }

    return new Response(JSON.stringify(relayResponse.body), {
      status: relayResponse.status,
      headers: {
        ...relayResponse.headers,
        "content-type": "application/json"
      }
    });
  };
}

export const debugBundleRelay = createNextjsRelayHandler();