import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  type BrowserFetch,
  type BrowserTransportMode,
  type DebugBundleBrowserTransport,
  type DebugBundleBrowserTransportEvent,
  type DebugBundleBrowserTransportResponse
} from "./types.js";

export function getFetchSource(): BrowserFetch | null {
  const candidate = (globalThis as Record<string, unknown>)["fetch"];
  return typeof candidate === "function" ? (candidate as BrowserFetch) : null;
}

export function boundedTransportTimeoutMs(requested: number): number {
  return Number.isFinite(requested)
    ? Math.min(60_000, Math.max(1, Math.trunc(requested)))
    : DEFAULT_REQUEST_TIMEOUT_MS;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return boundedRetryAfterMs(Math.min(300, seconds) * 1_000);
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : boundedRetryAfterMs(parsed - Date.now());
}

export function boundedRetryAfterMs(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value) ? 1_000 : Math.min(300_000, Math.max(0, value));
}

export function createFetchTransport(): DebugBundleBrowserTransport {
  const fetchImpl = getFetchSource();

  return async (request): Promise<DebugBundleBrowserTransportResponse> => {
    if (fetchImpl === null) throw new Error("fetch unavailable");
    if (typeof AbortController !== "function") throw new Error("abort controller unavailable");

    const controller = new AbortController();
    // Keep the deadline active through response-body decoding, which can also stall.
    const timeout = setTimeout(() => controller.abort(), boundedTransportTimeoutMs(request.timeout_ms));
    try {
      const response = await fetchImpl(request.endpoint, {
        method: "POST",
        headers: request.headers,
        body: buildBrowserTransportRequestBody(request.transportMode, request.events),
        signal: controller.signal
      });

      const retryAfterMs = parseRetryAfter(response.headers?.get("Retry-After") ?? null);
      const body = typeof response.json === "function"
        ? await response.json().catch(() => undefined)
        : undefined;
      if (controller.signal.aborted) throw new Error("transport timeout");

      return {
        status: response.status,
        ...(body === undefined ? {} : { body }),
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs })
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}

export function buildBrowserTransportRequestBody(
  transportMode: BrowserTransportMode,
  events: DebugBundleBrowserTransportEvent[]
): string {
  return transportMode === "direct" ? JSON.stringify({ events }) : JSON.stringify({ batch: events });
}
