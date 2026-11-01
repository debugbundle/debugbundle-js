import { expect, it, vi } from "vitest";
import { readBoundedNodeJson } from "../../../packages/sdk-node/src/response-json.js";
it("reads a bounded real response and rejects oversized declared or streamed bodies", async () => {
  expect(await readBoundedNodeJson(new Response('{"accepted":1}'), 20)).toEqual({ accepted: 1 });
  expect(await readBoundedNodeJson(new Response("x".repeat(30), { headers: { "content-length": "30" } }), 20)).toBeUndefined();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(21)); }, cancel });
  expect(await readBoundedNodeJson(new Response(body), 20)).toBeUndefined(); expect(cancel).toHaveBeenCalledTimes(1);
});
it("cancels a stalled response when the existing request deadline aborts", async () => {
  const controller = new AbortController(), cancel = vi.fn();
  const pending = readBoundedNodeJson(new Response(new ReadableStream<Uint8Array>({ cancel })), 20, controller.signal);
  controller.abort();
  expect(await pending).toBeUndefined(); expect(cancel).toHaveBeenCalledTimes(1);
});
it("contains cancellation failures and rejects malformed or empty native bodies", async () => {
  const cancel = vi.fn(() => { throw new Error("already closed"); });
  const controller = new AbortController(); controller.abort();
  expect(await readBoundedNodeJson(new Response(new ReadableStream<Uint8Array>({ cancel })), 100, controller.signal)).toBeUndefined();
  expect(cancel).toHaveBeenCalledOnce();
  expect(await readBoundedNodeJson(new Response(null))).toBeUndefined();
  expect(await readBoundedNodeJson(new Response(""))).toBeUndefined();
  expect(await readBoundedNodeJson(new Response(new Uint8Array([255])))).toBeUndefined();
  expect(await readBoundedNodeJson({ json: () => Promise.reject(new Error("custom invalid JSON")) } as unknown as Response)).toBeUndefined();
});
it("bounds tiny native chunks while growing one byte buffer and contains declared-body cancellation errors", async () => {
  const value = { message: "x".repeat(5000) }, bytes = new TextEncoder().encode(JSON.stringify(value));
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
  expect(await readBoundedNodeJson(response, 10_000)).toEqual(value);
  const cancel = vi.fn(() => { throw new Error("cancelled"); });
  expect(await readBoundedNodeJson(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-length": "100" } }), 20)).toBeUndefined();
  expect(cancel).toHaveBeenCalledOnce();
});
