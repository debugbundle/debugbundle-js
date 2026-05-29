import { createBrowserRelay, type BrowserRelayOptions } from "./relay.js";

type ExpressRelayRequest = {
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: unknown;
  ip?: string | null;
};

type ExpressRelayResponse = {
  header?: (field: string, value: string) => unknown;
  set?: (headers: Record<string, string>) => unknown;
  status: (code: number) => {
    json?: (body: unknown) => void;
    end?: () => void;
    send?: (body: unknown) => void;
  };
};

function applyRelayHeaders(response: ExpressRelayResponse, headers: Record<string, string> | undefined): void {
  if (headers === undefined) {
    return;
  }

  if (typeof response.set === "function") {
    response.set(headers);
    return;
  }

  if (typeof response.header === "function") {
    for (const [key, value] of Object.entries(headers)) {
      response.header(key, value);
    }
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

export function debugBundleRelay(options: BrowserRelayOptions = {}) {
  const relay = createBrowserRelay(options);

  return async (request: ExpressRelayRequest, response: ExpressRelayResponse): Promise<void> => {
    const relayResponse = await relay({
      ...(request.method === undefined ? {} : { method: request.method }),
      ...(request.headers === undefined ? {} : { headers: request.headers }),
      body: serializeRelayBody(request.body),
      ipAddress: request.ip ?? null
    });

    applyRelayHeaders(response, relayResponse.headers);
    const sender = response.status(relayResponse.status);
    if (relayResponse.body === undefined) {
      sender.end?.();
      return;
    }

    if (typeof sender.json === "function") {
      sender.json(relayResponse.body);
      return;
    }

    if (typeof sender.send === "function") {
      sender.send(relayResponse.body);
      return;
    }

    sender.end?.();
  };
}