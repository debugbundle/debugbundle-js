import { expect, it } from "vitest";
import { NodeOperationContext } from "../../../packages/sdk-node/src/operation-context.js";
import { createDebugBundleSdk, type DebugBundleTransportRequest } from "../../../packages/sdk-node/src/index.js";
import { vi } from "vitest";
import { watchNodeRequestEnd } from "../../../packages/sdk-node/src/request-lifecycle.js";
it("isolates concurrent operations, preserves results and clears completed or failed scopes", async () => {
  const context = new NodeOperationContext();
  const names = await Promise.all(["jobs:first", "jobs:second"].map((name) => context.runOperation({ kind: "job", name, limitMs: 5000 }, async () => {
    await Promise.resolve();
    expect(context.snapshot()).toMatchObject({ kind: "job", name, limit_ms: 5000 });
    expect(context.snapshot()!.elapsed_ms).toBeGreaterThanOrEqual(0);
    return context.snapshot()!.name;
  })));
  expect(names).toEqual(["jobs:first", "jobs:second"]); expect(context.snapshot()).toBeUndefined();
  const failure = new Error("application failure");
  await expect(context.runOperation({ kind: "command", name: "command:sync" }, () => { throw failure; })).rejects.toBe(failure);
  expect(context.snapshot()).toBeUndefined();
});
it("uses verified request lifecycle ownership and stops reporting elapsed time after completion", () => {
  const context = new NodeOperationContext(), owner = {}, request = { method: "GET", routeTemplate: "/items/:id" };
  context.runRequest(request, () => {
    expect(context.snapshot()).toMatchObject({ kind: "request", name: "/items/:id", limit_ms: null });
    context.finishRequest(owner); expect(context.snapshot()).toBeUndefined();
  }, owner);
  context.runRequest(request, () => { expect(context.getStore()?.request).toBe(request); expect(context.snapshot()).toBeUndefined(); });
});
it("preserves outer scope, sanitizes technical labels and omits invalid limits", async () => {
  const context = new NodeOperationContext();
  await context.runOperation({ kind: "job", name: "outer" }, async () => {
    await context.runOperation({ kind: "command", name: "token=private", limitMs: -1 }, () => {
      expect(context.snapshot()?.name).not.toContain("private"); expect(context.snapshot()?.limit_ms).toBeNull();
    });
    expect(context.snapshot()?.name).toBe("outer");
  });
});
it("attaches operation evidence only to its captured error and preserves local-only transport", async () => {
  const sdk = createDebugBundleSdk(), fetchImpl = vi.fn();
  const transport = vi.fn<(request: DebugBundleTransportRequest) => Promise<{ status: number }>>().mockResolvedValue({ status: 202 });
  sdk.init({ projectToken: "synthetic-project", service: "test", projectMode: "local-only", transport, fetchImpl,
    evidenceCapabilities: { version: 1, features: ["exception_evidence_v1"] } });
  try {
    await sdk.runWithOperationContext({ kind: "job", name: "jobs:resize", limitMs: 5000 }, async () => {
      await Promise.resolve(); sdk.captureException(new Error("job failure"));
    });
    sdk.captureException(new Error("outside operation")); await sdk.flush();
    const events = transport.mock.calls.flatMap(([request]) => request.events);
    expect(events[0]?.payload).toMatchObject({ execution: { version: 1, kind: "job", name: "jobs:resize", limit_ms: 5000 } });
    expect(events[1]?.payload).not.toHaveProperty("execution"); expect(fetchImpl).not.toHaveBeenCalled();
  } finally { sdk.dispose(); }
});
it("contains response observer and cleanup failures and completes request ownership only once", () => {
  const finishRequestContext = vi.fn(() => { throw new Error("disposed"); });
  const sdk = { finishRequestContext } as unknown as Parameters<typeof watchNodeRequestEnd>[0];
  const lifecycle = watchNodeRequestEnd(sdk, {}, { once() { throw new Error("already closed"); }, off() { throw new Error("detached"); } });
  expect(lifecycle.usesEvents).toBe(false); expect(finishRequestContext).toHaveBeenCalledOnce();
  expect(() => lifecycle.finish()).not.toThrow(); expect(finishRequestContext).toHaveBeenCalledOnce();
});
