import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSemanticAnalyticsNodeDelivery } from "../../../packages/sdk-node/src/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const endpoint = "https://analytics.example.invalid/api";
const writerToken = `dbundle_anl_${"A".repeat(43)}`;
const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function prepared() {
  const now = Date.now();
  const event = {
    schema_version: "2026-09-analytics-02",
    event_type: "analytics_event",
    event_id: "00000000-0000-4000-8000-000000000901",
    occurred_at: new Date(now).toISOString(),
    sdk_name: "@debugbundle/sdk-node",
    sdk_version: "3.0.3",
    service: { name: "accounts-api", runtime: "node", framework: null, environment: "test" },
    producer: { kind: "server", stream_id: null, sequence: null },
    operation_id: sha("operation"),
    correlation: {
      session_id: null, anonymous_id_hash: null, user_id_hash: null, account_id_hash: null,
      namespace_revision: null, trace_id: null, deploy_id: null
    },
    payload: {
      kind: "semantic", name: "account.created", event_revision: 1, purpose: "business_measurement",
      privacy: { mode: "strict", consent_granted: false },
      route: null, previous_route: null, screen: null, session: null, acquisition: null, client: null,
      properties: { signup_method: "email" }, measurements: {}, money: null, financial: null
    }
  };
  const eventJson = JSON.stringify(event);
  return {
    protocol: "2026-09-analytics-prepared-01" as const,
    project_id: projectId,
    destination_binding: sha(JSON.stringify(["debugbundle.analytics.destination.v1", endpoint, projectId])),
    prepared_at: new Date(now - 1_000).toISOString(),
    expires_at: new Date(now + 86_400_000).toISOString(),
    event_id: event.event_id,
    operation_id: event.operation_id,
    event_json: eventJson,
    prepared_content_hash: sha(eventJson)
  };
}

const destinationVector = "sha256:18e6e6b4b338761d1fe3849a3b5b141436023660dda15a835c0bc33833727414";

function capability(expiresInMs = 60_000, maxBatchEvents = 256) {
  const now = Date.now();
  return {
    analytics_semantic: {
      protocol: "2026-09-analytics-capabilities-01", project_id: projectId,
      principal: "server_writer", server_time: new Date(now).toISOString(),
      expires_at: new Date(now + expiresInMs).toISOString(), enabled: true, unavailable_reason: null,
      schema_version: "2026-09-analytics-02", scope: { kind: "project", project_id: projectId },
      scope_revision: 1, catalog_revision: 1, namespace_revision: null, identity_scope: null,
      known_identity_allowed: false, allowed_producers: ["server"],
      allowed_purposes: ["business_measurement"], consent_required: false, privacy_mode: "strict",
      sample_rate: 1, max_event_bytes: 16_384, max_batch_events: maxBatchEvents, max_batch_bytes: 262_144,
      max_properties: 20, detailed_retention_days: 90, max_event_age_seconds: 604_800,
      correction_seconds: 172_800, receipt_retention_days: 90, retry_after_max_ms: 300_000
    }
  };
}

function receipt(record: { event_id: string; operation_id: string | null }) {
  const now = Date.now();
  return {
    protocol: "2026-09-analytics-delivery-01", project_id: projectId,
    submitted: 1, accepted: 1, rejected: 0, errors: [],
    accepted_events: [{
      index: 0, event_id: record.event_id, operation_id: record.operation_id,
      content_hash: sha("protected-server-content"), accepted_at: new Date(now).toISOString(),
      expires_at: new Date(now + 86_400_000).toISOString(), duplicate: false
    }]
  };
}

describe("Node semantic analytics outbox delivery", () => {
  it("prepares an immutable nonfinancial business fact locally without a network request", async () => {
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl
    });
    const properties = { signup_method: "email" };
    const result = await writer.prepare("account.created", properties, {
      eventRevision: 1, operationId: sha("operation")
    });
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;
    properties.signup_method = "social";
    expect(Object.isFrozen(result.record)).toBe(true);
    expect(result.record.destination_binding).toBe(destinationVector);
    expect(result.record.prepared_content_hash).toBe(sha(result.record.event_json));
    expect(JSON.parse(result.record.event_json).payload.properties).toEqual({ signup_method: "email" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("delivers exactly the locally prepared record after an explicit outbox handoff", async () => {
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl
    });
    expect(writer.getStatus()).toEqual({
      enabled: true, inFlight: false, queuedEvents: 0, queuedBytes: 0,
      capability: "unchecked", lastFailure: null, lastReceipt: null
    });
    const preparedResult = await writer.prepare("account.created", { signup_method: "email" }, {
      eventRevision: 1, operationId: sha("operation")
    });
    expect(preparedResult.status).toBe("prepared");
    if (preparedResult.status !== "prepared") return;
    fetchImpl
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt(preparedResult.record)), { status: 200 }));
    const delivered = await writer.deliver([preparedResult.record]);
    expect(delivered.status).toBe("received");
    expect(writer.getStatus()).toEqual({
      enabled: true, inFlight: false, queuedEvents: 0, queuedBytes: 0,
      capability: "enabled", lastFailure: null,
      lastReceipt: { accepted: 1, retryable: 0, terminal: 0 }
    });
    expect((JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string) as { events: unknown[] }).events[0])
      .toEqual(JSON.parse(preparedResult.record.event_json));
  });

  it("rejects a space-scoped capability for the project-only Node writer", async () => {
    const candidate = { analytics_semantic: {
      ...capability().analytics_semantic,
      scope: { kind: "space", space_id: "33333333-3333-4333-8333-333333333333" }
    } };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(candidate), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl
    });
    expect((await writer.refreshCapability()).capability).not.toBe("enabled");
    const properties = Object.defineProperty({}, "private", {
      get() { throw new Error("application property was read"); }
    });
    writer.track("account.created", properties, {
      eventRevision: 1, operationId: sha("space-capability")
    });
    expect(writer.getStatus().queuedEvents).toBe(0);
    const result = await writer.prepare("account.created", {}, {
      eventRevision: 1, operationId: sha("space-capability")
    });
    if (result.status !== "prepared") throw new Error("preparation failed");
    expect((await writer.deliver([result.record])).status).toBe("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps best-effort track facts in a bounded SDK lane until an indexed receipt", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockImplementationOnce((_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string) as { events: Array<{ event_id: string; operation_id: string }> };
        return Promise.resolve(new Response(JSON.stringify(receipt(body.events[0]!)), { status: 200 }));
      });
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl
    });
    expect((await writer.refreshCapability()).capability).toBe("enabled");
    writer.track("account.created", { signup_method: "email" }, {
      eventRevision: 1, operationId: sha("tracked-operation")
    });
    expect(writer.getStatus().queuedEvents).toBe(1);
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("keeps request context and withdrawal isolated between Node scopes", async () => {
    const sent: Array<{ correlation: { trace_id: string | null; deploy_id: string | null } }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/sdk/config")) return new Response(JSON.stringify(capability()), { status: 200 });
      const body = JSON.parse(init.body as string) as { events: typeof sent & Array<{ event_id: string; operation_id: string }> };
      sent.push(...body.events);
      return new Response(JSON.stringify(receipt(body.events[0]!)), { status: 200 });
    });
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint,
      serviceName: "accounts-api", enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    await writer.refreshCapability();
    const first = writer.withContext({ traceId: sha("request-a"), deployId: sha("deploy") });
    const second = writer.withContext({ traceId: sha("request-b") });
    expect(await first.prepare("account.created", {}, {
      eventRevision: 1, operationId: sha("probe"), traceId: sha("untrusted-override")
    })).toEqual({ status: "prepared", record: expect.anything() });
    const scoped = await first.prepare("account.created", {}, {
      eventRevision: 1, operationId: sha("scoped-prepare"), traceId: sha("untrusted-override")
    });
    if (scoped.status !== "prepared") throw new Error("scoped preparation failed");
    expect(JSON.parse(scoped.record.event_json).correlation).toMatchObject({
      trace_id: sha("request-a"), deploy_id: sha("deploy")
    });
    first.track("account.created", {}, { eventRevision: 1, operationId: sha("first") });
    second.track("account.created", {}, { eventRevision: 1, operationId: sha("second") });
    expect(writer.getStatus().queuedEvents).toBe(2);
    first.setConsent(false);
    expect(writer.getStatus().queuedEvents).toBe(1);
    first.track("account.created", {}, { eventRevision: 1, operationId: sha("suppressed") });
    expect(writer.getStatus().queuedEvents).toBe(1);
    await writer.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.correlation).toMatchObject({ trace_id: sha("request-b"), deploy_id: null });
    first.reset();
    first.track("account.created", {}, { eventRevision: 1, operationId: sha("still-suppressed") });
    expect(writer.getStatus().queuedEvents).toBe(0);
  });

  it("withholds a scoped event when consent is withdrawn during capability refresh", async () => {
    let finishCapability!: (value: Response) => void;
    let configCalls = 0;
    const fetchImpl = vi.fn((url: string) => {
      if (url.endsWith("/v1/sdk/config")) {
        configCalls += 1;
        return configCalls === 1
          ? Promise.resolve(new Response(JSON.stringify(capability()), { status: 200 }))
          : new Promise<Response>((resolve) => { finishCapability = resolve; });
      }
      throw new Error("revoked scope must not dispatch");
    });
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint,
      serviceName: "accounts-api", enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch });
    await writer.refreshCapability();
    const scope = writer.withContext({ traceId: sha("request") });
    scope.track("account.created", {}, { eventRevision: 1, operationId: sha("revoked") });
    const pending = writer.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    scope.setConsent(false);
    finishCapability(new Response(JSON.stringify(capability()), { status: 200 }));
    await pending;
    expect(writer.getStatus().queuedEvents).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects unsafe request context without invoking application getters", async () => {
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, enabled: true });
    const read = vi.fn(() => sha("unsafe"));
    const scope = writer.withContext({ get traceId() { return read(); } });
    const result = await scope.prepare("account.created", {}, {
      eventRevision: 1, operationId: sha("unsafe-context")
    });
    expect(result).toEqual({ status: "unavailable", reason: "disabled" });
    expect(read).not.toHaveBeenCalled();
  });

  it("retains one finalized track fact across an unavailable send and retries its same identity", async () => {
    const deliveredIds: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/sdk/config")) return new Response(JSON.stringify(capability()), { status: 200 });
      const body = JSON.parse(init.body as string) as { events: Array<{ event_id: string; operation_id: string }> };
      deliveredIds.push(body.events[0]!.event_id);
      return deliveredIds.length === 1
        ? new Response("{}", { status: 503 })
        : new Response(JSON.stringify(receipt(body.events[0]!)), { status: 200 });
    });
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await writer.refreshCapability();
    writer.track("account.created", {}, { eventRevision: 1, operationId: sha("tracked-retry") });
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(1);
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(0);
    expect(deliveredIds).toHaveLength(2);
    expect(deliveredIds[0]).toBe(deliveredIds[1]);
  });

  it("removes only indexed accepted track records after a partial receipt", async () => {
    const sent: string[][] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/sdk/config")) return new Response(JSON.stringify(capability()), { status: 200 });
      const body = JSON.parse(init.body as string) as { events: Array<{ event_id: string; operation_id: string }> };
      sent.push(body.events.map((event) => event.event_id));
      const acknowledged = receipt(body.events[0]!);
      return new Response(JSON.stringify(sent.length === 1 ? {
        ...acknowledged,
        submitted: 2,
        rejected: 1,
        errors: [{ index: 1, reason: "rate_limited" }]
      } : acknowledged), { status: sent.length === 1 ? 429 : 200 });
    });
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await writer.refreshCapability();
    for (let index = 0; index < 2; index += 1)
      writer.track("account.created", { step: String(index) }, { eventRevision: 1, operationId: sha(`partial-${index}`) });
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(1);
    expect(writer.getStatus().lastReceipt).toEqual({ accepted: 1, retryable: 1, terminal: 0 });
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(0);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toHaveLength(2);
    expect(sent[1]).toEqual([sent[0]![1]]);
  });

  it("disposes terminally rejected track records while retaining retryable indexes", async () => {
    const sent: string[][] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/sdk/config"))
        return new Response(JSON.stringify(capability()), { status: 200 });
      const body = JSON.parse(init.body as string) as {
        events: Array<{ event_id: string; operation_id: string }>;
      };
      sent.push(body.events.map((event) => event.event_id));
      if (sent.length === 1)
        return new Response(JSON.stringify({
          ...receipt(body.events[0]!), submitted: 2, accepted: 0, rejected: 2,
          accepted_events: [],
          errors: [
            { index: 0, reason: "catalog_policy_rejected" },
            { index: 1, reason: "analytics_quota_exceeded" }
          ]
        }), { status: 429 });
      return new Response(JSON.stringify(receipt(body.events[0]!)), { status: 200 });
    });
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await writer.refreshCapability();
    for (let index = 0; index < 2; index += 1)
      writer.track("account.created", { step: String(index) }, {
        eventRevision: 1, operationId: sha(`disposition-${index}`)
      });
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(1);
    expect(writer.getStatus().lastReceipt).toEqual({ accepted: 0, retryable: 1, terminal: 1 });
    await writer.flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual([sent[0]![1]]);
    expect(writer.getStatus().queuedEvents).toBe(0);
  });

  it("drains a smaller fact after a refreshed capability makes the oldest fact too large", async () => {
    let configCalls = 0;
    const sent: Array<{ payload: { properties: Record<string, string> }; event_id: string; operation_id: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/sdk/config")) {
        configCalls += 1;
        const grant = capability();
        if (configCalls > 1) {
          grant.analytics_semantic.max_event_bytes = tightenedEventBytes;
          grant.analytics_semantic.max_batch_bytes = tightenedEventBytes + 14;
        }
        return new Response(JSON.stringify(grant), { status: 200 });
      }
      const body = JSON.parse(init.body as string) as { events: typeof sent };
      sent.push(...body.events);
      return new Response(JSON.stringify(receipt(body.events[0]!)), { status: 200 });
    });
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const small = await writer.prepare("account.created", { step: "small" }, {
      eventRevision: 1, operationId: sha("small-bound")
    });
    if (small.status !== "prepared") throw new Error("small preparation failed");
    const tightenedEventBytes = Buffer.byteLength(small.record.event_json, "utf8") + 16;
    await writer.refreshCapability();
    writer.track("account.created", { first: "A".repeat(128), second: "B".repeat(128) }, {
      eventRevision: 1, operationId: sha("large-bound")
    });
    writer.track("account.created", { step: "small" }, {
      eventRevision: 1, operationId: sha("small-bound")
    });
    expect(writer.getStatus().queuedEvents).toBe(2);
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(1);
    expect(writer.getStatus().lastFailure).toBe("capacity_exceeded");
    await writer.flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.properties).toEqual({ step: "small" });
    expect(writer.getStatus().queuedEvents).toBe(0);
  });

  it("drains a track queue using the negotiated smaller batch count", async () => {
    const sizes: number[] = [];
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/sdk/config"))
        return new Response(JSON.stringify(capability(60_000, 1)), { status: 200 });
      const body = JSON.parse(init.body as string) as { events: Array<{ event_id: string; operation_id: string }> };
      sizes.push(body.events.length);
      return new Response(JSON.stringify(receipt(body.events[0]!)), { status: 200 });
    });
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch
    });
    await writer.refreshCapability();
    for (let index = 0; index < 2; index += 1)
      writer.track("account.created", { step: String(index) }, { eventRevision: 1, operationId: sha(`small-${index}`) });
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(1);
    await writer.flush();
    expect(writer.getStatus().queuedEvents).toBe(0);
    expect(sizes).toEqual([1, 1]);
  });

  it("keeps a newly queued fact when an older in-flight fact expires", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    let finishPost!: (response: Response) => void;
    let sent: Array<{ event_id: string; operation_id: string }> = [];
    try {
      const fetchImpl = vi.fn((url: string, init: RequestInit) => {
        if (url.endsWith("/v1/sdk/config"))
          return Promise.resolve(new Response(JSON.stringify(capability(300_000)), { status: 200 }));
        sent = (JSON.parse(init.body as string) as { events: typeof sent }).events;
        return new Promise<Response>((resolve) => { finishPost = resolve; });
      });
      const writer = createSemanticAnalyticsNodeDelivery({
        projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
        enabled: true, fetchImpl: fetchImpl as unknown as typeof fetch
      });
      await writer.refreshCapability();
      writer.track("account.created", { step: "first" }, { eventRevision: 1, operationId: sha("old") });
      now += 4 * 60_000;
      await writer.refreshCapability();
      writer.track("account.created", { step: "second" }, { eventRevision: 1, operationId: sha("middle") });
      const pending = writer.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sent).toHaveLength(2);
      now += 60_001;
      writer.track("account.created", { step: "third" }, { eventRevision: 1, operationId: sha("new") });
      const first = receipt(sent[0]!);
      const second = receipt(sent[1]!);
      finishPost(new Response(JSON.stringify({
        ...first, submitted: 2, accepted: 2,
        accepted_events: [first.accepted_events[0]!, { ...second.accepted_events[0]!, index: 1 }]
      }), { status: 200 }));
      await pending;
      expect(writer.getStatus().queuedEvents).toBe(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("rejects a track burst beyond its event cap before traversing more app input", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(capability()), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test", enabled: true, fetchImpl
    });
    await writer.refreshCapability();
    for (let index = 0; index < 256; index += 1)
      writer.track("account.created", {}, { eventRevision: 1, operationId: sha(`burst-${index}`) });
    const getter = vi.fn(() => "unsafe");
    writer.track("account.created", { get secret() { return getter(); } }, {
      eventRevision: 1, operationId: sha("overflow")
    });
    expect(writer.getStatus().queuedEvents).toBe(256);
    expect(getter).not.toHaveBeenCalled();
  });

  it("does not traverse app properties before an enabled authenticated capability", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      analytics_semantic: { ...capability().analytics_semantic, enabled: false,
        unavailable_reason: "not_enabled", allowed_producers: [], allowed_purposes: [] }
    }), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test", enabled: true, fetchImpl
    });
    const getter = vi.fn(() => "unsafe");
    const properties = { get secret() { return getter(); } };
    writer.track("account.created", properties, { eventRevision: 1, operationId: sha("before-cap") });
    expect((await writer.refreshCapability()).capability).toBe("disabled");
    writer.track("account.created", properties, { eventRevision: 1, operationId: sha("after-disabled") });
    expect(getter).not.toHaveBeenCalled();
    expect(writer.getStatus().queuedEvents).toBe(0);
  });

  it("expires a cached capture grant after monotonic elapsed time despite a backward wall clock", async () => {
    let wallNow = Date.now();
    let elapsedNow = 10_000;
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    const elapsedClock = vi.spyOn(globalThis.performance, "now").mockImplementation(() => elapsedNow);
    try {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(capability(60_000)), { status: 200 }));
      const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
      expect((await writer.refreshCapability()).capability).toBe("enabled");
      wallNow -= 60_000;
      elapsedNow += 60_001;
      const getter = vi.fn(() => "private");
      writer.track("account.created", { get private_value() { return getter(); } }, {
        eventRevision: 1, operationId: sha("expired-grant")
      });
      writer.track("account.created", { step: "safe" }, {
        eventRevision: 1, operationId: sha("expired-grant-safe")
      });
      expect(getter).not.toHaveBeenCalled();
      expect(writer.getStatus()).toMatchObject({ capability: "expired", queuedEvents: 0 });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      wallClock.mockRestore();
      elapsedClock.mockRestore();
    }
  });

  it("drops expired volatile work after monotonic elapsed time despite a backward wall clock", async () => {
    let wallNow = Date.now();
    let elapsedNow = 10_000;
    const wallClock = vi.spyOn(Date, "now").mockImplementation(() => wallNow);
    const elapsedClock = vi.spyOn(globalThis.performance, "now").mockImplementation(() => elapsedNow);
    try {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(capability(300_000)), { status: 200 }));
      const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
      await writer.refreshCapability();
      writer.track("account.created", { step: "queued" }, {
        eventRevision: 1, operationId: sha("queue-expiry")
      });
      expect(writer.getStatus().queuedEvents).toBe(1);
      wallNow -= 60_000;
      elapsedNow += 300_001;
      await writer.flush();
      expect(writer.getStatus().queuedEvents).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      wallClock.mockRestore();
      elapsedClock.mockRestore();
    }
  });

  it("closes cached capture and clears volatile work when the monotonic clock resets", async () => {
    let elapsedNow = 10_000;
    const elapsedClock = vi.spyOn(globalThis.performance, "now").mockImplementation(() => elapsedNow);
    try {
      const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(capability()), { status: 200 }));
      const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
      await writer.refreshCapability();
      writer.track("account.created", { step: "queued" }, {
        eventRevision: 1, operationId: sha("clock-reset-queued")
      });
      expect(writer.getStatus().queuedEvents).toBe(1);
      elapsedNow = 0;
      writer.track("account.created", { step: "later" }, {
        eventRevision: 1, operationId: sha("clock-reset-later")
      });
      expect(writer.getStatus().capability).toBe("expired");
      await writer.flush();
      expect(writer.getStatus().queuedEvents).toBe(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      elapsedClock.mockRestore();
    }
  });

  it("rejects invalid names before traversing application data and never invokes getters", async () => {
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test",
      enabled: true, fetchImpl
    });
    let reads = 0;
    const hostile = { get signup_method() { reads += 1; throw new Error("must not run"); } };
    const options = { eventRevision: 1, operationId: sha("operation") };
    expect(await writer.prepare("bad name", hostile, options)).toEqual({ status: "unavailable", reason: "unsafe_input" });
    expect(await writer.prepare("account.created", hostile, options)).toEqual({ status: "unavailable", reason: "unsafe_input" });
    expect(reads).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("withholds a credential in app properties during local preparation", async () => {
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test", enabled: true
    });
    expect(await writer.prepare("account.created", { note: writerToken }, {
      eventRevision: 1, operationId: sha("operation")
    })).toEqual({ status: "unavailable", reason: "unsafe_input" });
  });

  it("rejects occurrence times outside the seven-day intake window before preparing", async () => {
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, serviceName: "accounts-api", environment: "test", enabled: true
    });
    expect(await writer.prepare("account.created", {}, {
      eventRevision: 1, operationId: sha("operation"),
      occurredAt: new Date(Date.now() - 8 * 86_400_000).toISOString()
    })).toEqual({ status: "unavailable", reason: "unsafe_input" });
  });

  it("keeps a disabled writer inert, including an analytics-only configuration", async () => {
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, fetchImpl });
    expect(await writer.deliver([prepared()])).toEqual({ status: "unavailable", reason: "disabled" });
    expect(writer.getStatus()).toEqual({
      enabled: false, inFlight: false, queuedEvents: 0, queuedBytes: 0,
      capability: "unchecked", lastFailure: "disabled", lastReceipt: null
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses the shared destination byte vector and withholds a protected-content change", async () => {
    const original = prepared();
    expect(original.destination_binding).toBe(destinationVector);
    const event = JSON.parse(original.event_json) as { payload: { properties: Record<string, string> } };
    event.payload.properties["note"] = writerToken;
    const eventJson = JSON.stringify(event);
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([{ ...original, event_json: eventJson, prepared_content_hash: sha(eventJson) }]))
      .toEqual({ status: "unavailable", reason: "policy_changed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("negotiates the server capability and returns only a matching durable indexed receipt", async () => {
    const record = prepared();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(receipt(record)), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    const result = await writer.deliver([record]);
    expect(result.status).toBe("received");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${endpoint}/v1/sdk/config`);
    expect(fetchImpl.mock.calls[1]?.[0]).toBe(`${endpoint}/v1/analytics/deliver`);
    expect(JSON.parse(fetchImpl.mock.calls[1]?.[1]?.body as string)).toEqual({ events: [JSON.parse(record.event_json)] });
    expect(fetchImpl.mock.calls[1]?.[1]?.redirect).toBe("manual");
  });

  it("withholds a changed record before networking and never converts a bad receipt to success", async () => {
    const record = prepared();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...receipt(record), submitted: 2 }), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([{ ...record, prepared_content_hash: sha("other") }])).toEqual({ status: "unavailable", reason: "integrity_failure" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await writer.deliver([record])).toEqual({ status: "unavailable", reason: "protocol_failure" });
  });

  it("keeps financial payloads closed before capability negotiation", async () => {
    const original = prepared();
    const event = JSON.parse(original.event_json) as { payload: { money: unknown; financial: unknown } };
    event.payload.money = { amount_minor: "100", currency: "USD", exponent: 2 };
    event.payload.financial = { kind: "payment", payment_id: sha("payment"), subscription_id: null };
    const eventJson = JSON.stringify(event);
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([{ ...original, event_json: eventJson, prepared_content_hash: sha(eventJson) }])).toEqual({ status: "unavailable", reason: "unsupported" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("withholds a custom-identity business record with unexpected consent before networking", async () => {
    const original = prepared();
    const event = JSON.parse(original.event_json) as {
      correlation: { user_id_hash: string | null; namespace_revision: number | null };
      payload: { privacy: { mode: string; consent_granted: boolean } };
    };
    event.correlation.user_id_hash = sha("user");
    event.correlation.namespace_revision = 1;
    event.payload.privacy.mode = "custom";
    event.payload.privacy.consent_granted = true;
    const eventJson = JSON.stringify(event);
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([{
      ...original,
      event_json: eventJson,
      prepared_content_hash: sha(eventJson)
    }])).toEqual({ status: "unavailable", reason: "policy_changed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps records with the wrong destination, expiry or unsafe count in the application outbox", async () => {
    const record = prepared();
    const fetchImpl = vi.fn();
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([{ ...record, destination_binding: sha("another destination") }]))
      .toEqual({ status: "unavailable", reason: "destination_mismatch" });
    expect(await writer.deliver([{
      ...record,
      prepared_at: new Date(Date.now() - 86_400_000).toISOString(),
      expires_at: new Date(Date.now() - 1_000).toISOString()
    }])).toEqual({ status: "unavailable", reason: "record_expired" });
    expect(await writer.deliver(Array.from({ length: 257 }, () => record)))
      .toEqual({ status: "unavailable", reason: "capacity_exceeded" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not send while the authenticated capability is disabled or unavailable", async () => {
    const record = prepared();
    const disabled = { analytics_semantic: {
      ...capability().analytics_semantic, enabled: false, unavailable_reason: "not_enabled",
      allowed_producers: [], allowed_purposes: []
    } };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(disabled), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "analytics_delivery_unavailable" }), { status: 503 }));
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([record])).toEqual({ status: "unavailable", reason: "capability_unavailable" });
    expect(await writer.deliver([record])).toEqual({ status: "unavailable", reason: "capability_unavailable" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns the canonical retryable indexed receipt without deleting or retrying records itself", async () => {
    const record = prepared();
    const throttled = {
      ...receipt(record), accepted: 0, rejected: 1, accepted_events: [],
      errors: [{ index: 0, reason: "rate_limited" }]
    };
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(throttled), { status: 429 }));
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([record])).toEqual({ status: "received", receipt: throttled });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("bounds a stalled capability request and refuses overlapping outbox calls", async () => {
    const record = prepared();
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })) as unknown as typeof fetch;
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, requestTimeoutMs: 5, fetchImpl });
    const first = writer.deliver([record]);
    expect(await writer.deliver([record])).toEqual({ status: "unavailable", reason: "capacity_exceeded" });
    expect(await first).toEqual({ status: "unavailable", reason: "timeout" });
  });

  it("rejects malformed writer configuration and empty input without network access", async () => {
    const fetchImpl = vi.fn();
    const invalid = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken: "dbundle_proj_wrong", endpoint, enabled: true, fetchImpl
    });
    expect(await invalid.deliver([prepared()])).toEqual({ status: "unavailable", reason: "authentication_required" });
    const valid = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await valid.deliver([])).toEqual({ status: "unavailable", reason: "unsafe_input" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("withholds a purpose the current capability does not authorize", async () => {
    const current = capability();
    current.analytics_semantic.allowed_purposes = ["product_analytics"];
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(current), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([prepared()])).toEqual({ status: "unavailable", reason: "unsupported" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("bounds a malformed capability response before attempting delivery", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("x".repeat(65_537), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([prepared()])).toEqual({ status: "unavailable", reason: "protocol_failure" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps records unresolved when delivery is unavailable or a receipt names another event", async () => {
    const record = prepared();
    const wrong = receipt(record);
    wrong.accepted_events[0]!.event_id = "00000000-0000-4000-8000-000000000999";
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "analytics_delivery_unavailable" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(capability()), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(wrong), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({ projectId, writerToken, endpoint, enabled: true, fetchImpl });
    expect(await writer.deliver([record])).toEqual({ status: "unavailable", reason: "capability_unavailable" });
    expect(await writer.deliver([record])).toEqual({ status: "unavailable", reason: "protocol_failure" });
  });
});
