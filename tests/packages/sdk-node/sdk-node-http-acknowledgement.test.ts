import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createDebugBundleSdk, type DebugBundleNodeSdk } from "../../../packages/sdk-node/src/index.js";

const sdks: DebugBundleNodeSdk[] = [];
const servers: Server[] = [];
afterEach(async () => {
  sdks.splice(0).forEach(sdk => sdk.dispose());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function setup(body: string) {
  const batches: Array<Array<{ event_id: string }>> = [];
  const server = createServer((request, response) => { void (async () => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk as Uint8Array);
    const parsed = JSON.parse(Buffer.concat(chunks).toString()) as { events: Array<{ event_id: string }> };
    batches.push(parsed.events);
    response.writeHead(202, { "Content-Type": "application/json", "Retry-After": "300" });
    response.end(batches.length === 1 ? body : JSON.stringify({ accepted: batches.at(-1)!.length, rejected: 0, errors: [] }));
  })().catch((error: unknown) => response.destroy(error instanceof Error ? error : new Error(String(error)))); });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server address");
  const sdk = createDebugBundleSdk();
  sdks.push(sdk);
  sdk.init({ projectToken: "dbundle_proj_test", environment: "production", service: "ack-test",
    endpoint: `http://127.0.0.1:${address.port}/events`, batchSize: 100, flushInterval: 60_000,
    fetchImpl: (input, init) => init?.method === "POST" ? fetch(input, init) : Promise.resolve(new Response("{}")) });
  sdk.captureMessage("first", "error");
  sdk.captureMessage("second", "error");
  return { sdk, batches };
}

describe("Node built-in HTTP acknowledgement", () => {
  it.each([NaN, Infinity])("uses safe backoff for a nonfinite custom retry hint %s", async retryHint => {
    const sdk = createDebugBundleSdk();
    sdks.push(sdk);
    sdk.init({ projectToken: "dbundle_proj_test", environment: "production", flushInterval: 60_000,
      fetchImpl: async () => new Response("{}"), transport: async () => ({ status: 429, retry_after_ms: retryHint }) });
    sdk.captureMessage("retain", "error");
    await sdk.flush();
    const retryAt = (sdk as unknown as { nextRetryAt: number }).nextRetryAt;
    expect(retryAt - Date.now()).toBeGreaterThan(900);
    expect(retryAt - Date.now()).toBeLessThanOrEqual(1_000);
    expect(sdk.lastEventAt).toBeNull();
  });

  it.each([429, 503, 202, 203])("caps custom retry hints at the delivery boundary for status %i", async status => {
    const sdk = createDebugBundleSdk();
    sdks.push(sdk);
    sdk.init({ projectToken: "dbundle_proj_test", environment: "production", flushInterval: 60_000,
      fetchImpl: async () => new Response("{}"), transport: async () => ({ status, retry_after_ms: 1e100,
        body: status === 202 ? { accepted: 2, rejected: 0, errors: [] } :
          { accepted: 0, rejected: 1, errors: [{ index: 0, reason: "rate_limited" }] } }) });
    sdk.captureMessage("retry", "error");
    await sdk.flush();
    const retryAt = (sdk as unknown as { nextRetryAt: number }).nextRetryAt;
    expect(retryAt - Date.now()).toBeLessThanOrEqual(300_000);
    expect(retryAt - Date.now()).toBeGreaterThan(299_000);
  });

  it.each(["",
    '{"accepted":null,"rejected":2,"errors":[{"index":0,"reason":"rate_limited"},{"index":1,"reason":"rate_limited"}]}',
    '{"accepted":2,"rejected":0,"errors":null}',
    '{"accepted":1,"rejected":1,"errors":[{"index":4294967296,"reason":"rate_limited"}]}',
    '{"accepted":1,"rejected":1,"errors":{"one":{"index":1,"reason":"rate_limited"}}}', "<html>proxy</html>", "{}", "[]", "null",
    '{"accepted":1,"rejected":0,"errors":[]}',
    '{"accepted":0,"rejected":2,"errors":[{"index":0,"reason":"rate_limited"},{"index":0,"reason":"rate_limited"}]}',
    '{"accepted":1,"rejected":1,"errors":[{"index":2,"reason":"rate_limited"}]}'])
  ("retains the full batch and backs off for invalid HTTP body %s", async body => {
    const { sdk, batches } = await setup(body);
    await sdk.flush();
    expect(sdk.lastEventAt).toBeNull();
    await sdk.flush();
    expect(batches).toHaveLength(1);
    (sdk as unknown as { nextRetryAt: number }).nextRetryAt = 0;
    await sdk.flush();
    expect(batches).toHaveLength(2);
    expect(batches[1]!.map(event => event.event_id)).toEqual(batches[0]!.map(event => event.event_id));
    expect(sdk.lastEventAt).not.toBeNull();
  });

  it("retries only the indexed retryable event after a valid HTTP acknowledgement", async () => {
    const { sdk, batches } = await setup('{"accepted":1,"rejected":1,"errors":[{"index":1,"reason":"rate_limited"}]}');
    await sdk.flush();
    expect(sdk.lastEventAt).not.toBeNull();
    (sdk as unknown as { nextRetryAt: number }).nextRetryAt = 0;
    await sdk.flush();
    expect(batches[1]!.map(event => event.event_id)).toEqual([batches[0]![1]!.event_id]);
  });

  it("preserves bodyless custom transport success", async () => {
    let calls = 0;
    const sdk = createDebugBundleSdk();
    sdks.push(sdk);
    sdk.init({ projectToken: "dbundle_proj_test", environment: "production", flushInterval: 60_000,
      transport: async () => { calls++; return { status: 202 }; }, fetchImpl: async () => new Response("{}") });
    sdk.captureMessage("custom", "error");
    await sdk.flush();
    await sdk.flush();
    expect(calls).toBe(1);
    expect(sdk.lastEventAt).not.toBeNull();
  });
});
