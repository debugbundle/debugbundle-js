import { expect, it, vi } from "vitest";
import { readBoundedBrowserJson } from "../../../packages/sdk-browser/src/response-json.js";
it("refuses oversized HTTP JSON before parsing and preserves custom fetch compatibility", async () => {
  const json = vi.fn().mockResolvedValue({ safe: true });
  expect(await readBoundedBrowserJson({ status: 200, headers: { get: () => "262145" }, json })).toBeUndefined();
  expect(json).not.toHaveBeenCalled();
  expect(await readBoundedBrowserJson({ status: 200, json })).toEqual({ safe: true });
});
it("cancels a stalled native body when its existing request deadline aborts", async () => {
  const cancel = vi.fn(), controller = new AbortController();
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
  const pending = readBoundedBrowserJson(response, controller.signal); controller.abort();
  expect(await pending).toBeUndefined(); expect(cancel).toHaveBeenCalledTimes(1);
});
it("parses a valid bounded body delivered as many tiny stream chunks", async () => {
  const value = { message: "x".repeat(5000) }, bytes = new TextEncoder().encode(JSON.stringify(value));
  const response = new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
  expect(await readBoundedBrowserJson(response)).toEqual(value);
});
it("contains cancellation rejection and malformed bodies without leaking into application callbacks", async () => {
  const cancel = vi.fn(() => { throw new Error("cancel failed"); });
  const response = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { "content-length": "262145" } });
  expect(await readBoundedBrowserJson(response)).toBeUndefined(); expect(cancel).toHaveBeenCalledOnce();
  const controller = new AbortController(); controller.abort();
  expect(await readBoundedBrowserJson(new Response(new ReadableStream<Uint8Array>({ cancel })), controller.signal)).toBeUndefined();
  expect(await readBoundedBrowserJson({ status: 200, json: () => Promise.reject(new Error("invalid JSON")) })).toBeUndefined();
  expect(await readBoundedBrowserJson(new Response(null))).toBeUndefined();
  expect(await readBoundedBrowserJson(new Response(""))).toBeUndefined();
  expect(await readBoundedBrowserJson(new Response(new Uint8Array([255])))).toBeUndefined();
});
it("cancels an oversized streamed body even without a content-length hint", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(262145)); }, cancel });
  expect(await readBoundedBrowserJson(new Response(body))).toBeUndefined(); expect(cancel).toHaveBeenCalledOnce();
});
