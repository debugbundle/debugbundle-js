/** Bound native HTTP bytes before parsing; grow one byte buffer instead of
 * retaining an unbounded number of tiny stream-chunk objects. */
export async function readBoundedNodeJson(response: Response, maximumBytes = 256 * 1024, signal?: AbortSignal): Promise<unknown> {
  try {
    const length = Number(response.headers?.get("content-length"));
    if (Number.isFinite(length) && length > maximumBytes) { void response.body?.cancel().catch(() => undefined); return undefined; }
    if (response.body === null) return undefined;
    if (response.body === undefined) return typeof response.json === "function" ? response.json().catch(() => undefined) : undefined;
    const reader = response.body.getReader();
    let bytes = 0, buffer = new Uint8Array(4096);
    const abort = (): void => { void reader.cancel().catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      while (!signal?.aborted) {
        const result = await reader.read(); if (result.done) break;
        const required = bytes + result.value.byteLength;
        if (required > maximumBytes) { abort(); return undefined; }
        if (required > buffer.length) { const grown = new Uint8Array(Math.min(maximumBytes, Math.max(required, buffer.length * 2))); grown.set(buffer.subarray(0, bytes)); buffer = grown; }
        buffer.set(result.value, bytes); bytes = required;
      }
      if (signal?.aborted || bytes === 0) return undefined;
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytes))) as unknown;
    } finally { signal?.removeEventListener("abort", abort); reader.releaseLock(); }
  } catch { return undefined; }
}
