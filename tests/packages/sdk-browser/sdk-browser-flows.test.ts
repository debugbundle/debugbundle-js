import { afterEach, expect, it, vi } from "vitest";
import {
  createAnalyticsFlowClient,
  type AnalyticsFlowClientOptions
} from "../../../packages/sdk-browser/src/analytics-flows.js";

function setup() {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    }
  };
  const replaceState = vi.fn();
  vi.stubGlobal("window", {
    sessionStorage: storage,
    location: {
      href: "https://auth.customer.test/login?next=app",
      origin: "https://auth.customer.test"
    },
    history: { state: { router: 1 }, replaceState }
  });
  const request = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async (_url) => {
    const result = _url.endsWith("handoff")
      ? {
          origin: "https://app.customer.test",
          expires_at: new Date(Date.now() + 600_000).toISOString()
        }
      : _url.endsWith("step")
        ? { recorded: true }
        : _url.endsWith("withdraw")
          ? { withdrawn: true }
          : { expires_at: new Date(Date.now() + 3600_000).toISOString() };
    return new Response(JSON.stringify(result));
  });
  vi.stubGlobal("fetch", request);
  const options = {
    endpoint: "https://api.example.test",
    projectId: "00000000-0000-4000-8000-000000000001",
    projectToken: "dbundle_proj_test",
    flowKey: "onboarding",
    enabled: true,
    consentRequired: true
  };
  return { values, storage, request, replaceState, options };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("keeps malformed JavaScript initialization from throwing into the host", async () => {
  const { request } = setup();
  const flow = createAnalyticsFlowClient(undefined as unknown as AnalyticsFlowClientOptions);
  flow.setConsent(true);
  expect(await flow.start("visit")).toBe(false);
  expect(await flow.step("login")).toBe(false);
  expect(await flow.handoff("app", "https://app.customer.test")).toBeNull();
  expect(await flow.arrive()).toBe(false);
  await expect(flow.withdraw()).resolves.toBeUndefined();
  expect(request).not.toHaveBeenCalled();
});
it("is headless and off without explicit consent; never throws when unavailable", async () => {
  const { options, request } = setup();
  const flow = createAnalyticsFlowClient(options);
  expect(await flow.start("auth")).toBe(false);
  expect(request).not.toHaveBeenCalled();
  flow.setConsent(true);
  expect(await flow.start("auth")).toBe(true);
  request.mockRejectedValue(new Error("offline"));
  expect(await flow.step("login")).toBe(false);
  await expect(flow.withdraw()).resolves.toBeUndefined();
});
it("retains tab context across an external OAuth roundtrip and only marks explicit success", async () => {
  const { options, request } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  expect(await flow.start("auth")).toBe(true);
  const context = JSON.parse(request.mock.calls[0]![1].body as string).context;
  const afterOAuth = createAnalyticsFlowClient({ ...options, consentRequired: false });
  expect(request).toHaveBeenCalledTimes(1);
  expect(await afterOAuth.step("login")).toBe(true);
  expect(JSON.parse(request.mock.calls[1]![1].body as string).context).toBe(context);
  const url = await afterOAuth.handoff(
    "app",
    "https://app.customer.test/welcome?source=home#section"
  );
  expect(url).toContain("dbflow=");
  expect(url).toContain("source=home");
  expect(url).toContain("section");
  expect(await afterOAuth.handoff("app", "https://attacker.test/")).toBeNull();
});
it("scrubs handoff fragments, preserves OAuth state, and retries arrival with the same receiver", async () => {
  const { options, request, replaceState } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  window.location.href = `https://auth.customer.test/login?state=oauth-state#section&dbflow=${"a".repeat(43)}`;
  request.mockRejectedValueOnce(new Error("offline"));
  expect(await flow.arrive()).toBe(false);
  expect(replaceState).toHaveBeenCalledWith(
    { router: 1 },
    "",
    "https://auth.customer.test/login?state=oauth-state#section"
  );
  const first = JSON.parse(request.mock.calls[0]![1].body as string);
  window.location.href = "https://auth.customer.test/login?state=oauth-state#section";
  const retry = createAnalyticsFlowClient({ ...options, consentRequired: false });
  expect(await retry.arrive()).toBe(true);
  expect(JSON.parse(request.mock.calls[1]![1].body as string)).toEqual(first);
});
it("withdraws context and prevents queued capture; blocked storage fails closed", async () => {
  const { options, storage, request, values } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  await flow.start("auth");
  await flow.withdraw();
  expect(values.size).toBe(0);
  expect(await flow.step("login")).toBe(false);
  expect(String(request.mock.calls.at(-1)?.[0])).toMatch(/withdraw$/);
  storage.setItem = () => {
    throw new Error("blocked");
  };
  const blocked = createAnalyticsFlowClient({ ...options, consentRequired: false });
  request.mockClear();
  expect(await blocked.start("auth")).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it("expires continuity and does not forward tokens while disabled", async () => {
  const { options, request, replaceState } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  await flow.start("auth");
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 3600_001);
  expect(await flow.step("login")).toBe(false);
  const disabled = createAnalyticsFlowClient({ ...options, enabled: false });
  window.location.href = `https://auth.customer.test/#dbflow=${"a".repeat(43)}`;
  expect(await disabled.arrive()).toBe(false);
  expect(replaceState).toHaveBeenCalled();
  expect(request).toHaveBeenCalledTimes(1);
});
it("bounds stalled delivery and discards queued observations on withdrawal", async () => {
  const { options, request, values } = setup();
  const flow = createAnalyticsFlowClient({
    ...options,
    consentRequired: false,
    requestTimeoutMs: 100
  });
  await flow.start("auth");
  vi.useFakeTimers();
  request.mockImplementationOnce(() => new Promise(() => {}));
  const stalled = flow.step("login");
  await vi.advanceTimersByTimeAsync(1);
  const queued = flow.step("app");
  await flow.withdraw();
  await vi.advanceTimersByTimeAsync(100);
  expect(await stalled).toBe(false);
  expect(await queued).toBe(false);
  expect(values.size).toBe(0);
});
it("rejects invalid input and malformed stored contexts without transmitting personal fields", async () => {
  const { options, request, values } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  expect(await flow.start("Bad Key")).toBe(false);
  expect(await flow.start("auth", { source: "person@example.test" })).toBe(false);
  expect(await flow.handoff("app", "javascript:alert(1)")).toBeNull();
  expect(await flow.arrive()).toBe(false);
  expect(request).not.toHaveBeenCalled();
  values.set(
    `debugbundle:flow:${options.projectId}:${options.flowKey}`,
    JSON.stringify({ context: "invalid", expires: Date.now() + 1000 })
  );
  expect(await flow.step("login")).toBe(false);
  expect(await flow.start("auth")).toBe(true);
  expect(await flow.start("auth")).toBe(true);
  expect(request).toHaveBeenCalledTimes(1);
  window.location.href = "https://auth.customer.test/#dbflow=invalid";
  expect(await flow.arrive()).toBe(false);
  expect(request).toHaveBeenCalledTimes(1);
});
it("rejects unexpected attribution fields and credential-like labels before capture", async () => {
  const { options, request } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  const unexpected = { source: "newsletter", customer_name: "private-name" };
  expect(await flow.start("auth", unexpected)).toBe(false);
  expect(await flow.start("auth", { source: `dbundle_proj_${"a".repeat(32)}` })).toBe(false);
  expect(await flow.start("auth", { campaign: `dbundle_mem_${"a".repeat(32)}` })).toBe(false);
  expect(await flow.start("auth", { campaign: "4242424242424242" })).toBe(false);
  const getter = vi.fn(() => "newsletter");
  expect(await flow.start("auth", Object.defineProperty({}, "source", { get: getter }))).toBe(
    false
  );
  expect(getter).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(await flow.start("auth", { source: "newsletter", campaign: "spring-2026" })).toBe(true);
});
it("keeps retries on the original context and rejects invalid API responses and insecure endpoints", async () => {
  const { options, request } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  request.mockResolvedValueOnce(new Response("{}", { status: 503 }));
  expect(await flow.start("auth")).toBe(false);
  expect(await flow.start("different")).toBe(false);
  expect(await flow.step("login")).toBe(false);
  expect(await flow.start("auth")).toBe(true);
  expect(JSON.parse(request.mock.calls[0]![1].body as string).context).toBe(
    JSON.parse(request.mock.calls[1]![1].body as string).context
  );
  await flow.withdraw();
  request.mockClear();
  expect(
    await createAnalyticsFlowClient({
      ...options,
      consentRequired: false,
      endpoint: "http://remote.test"
    }).start("auth")
  ).toBe(false);
  expect(request).not.toHaveBeenCalled();
});
it("rejects oversized capture responses and non-acknowledged steps", async () => {
  const { options, request } = setup();
  const flow = createAnalyticsFlowClient({ ...options, consentRequired: false });
  request.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        padding: "x".repeat(5000)
      })
    )
  );
  expect(await flow.start("auth")).toBe(false);
  expect(await flow.start("auth")).toBe(true);
  request.mockResolvedValueOnce(new Response(JSON.stringify({ recorded: false })));
  expect(await flow.step("login")).toBe(false);
});
