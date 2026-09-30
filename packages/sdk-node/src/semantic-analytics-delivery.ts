import { createHash, randomUUID } from "node:crypto";
import { sanitizeTelemetry } from "@debugbundle/redaction";
import {
  AnalyticsCapabilitiesSchema,
  AnalyticsDeliveryReceiptSchema,
  AnalyticsPreparedEventSchema,
  SEMANTIC_ANALYTICS_SCHEMA_VERSION,
  SemanticAnalyticsEventSchema,
  type AnalyticsCapabilities,
  type AnalyticsDeliveryResult,
  type AnalyticsPreparationResult,
  type AnalyticsPreparedEvent,
  type SemanticAnalyticsEvent
} from "@debugbundle/shared-types";
import { SDK_VERSION } from "./types.js";
import { parseRetryAfter } from "./utils.js";

const MAX_BATCH_EVENTS = 256;
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_TRACK_BYTES = 4 * 1024 * 1024;
const TRACK_LIFETIME_MS = 5 * 60_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_ENDPOINT = "https://api.debugbundle.com";
const WRITER_TOKEN = /^dbundle_anl_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RETRYABLE_REJECTIONS = new Set([
  "rate_limited", "monthly_quota_exceeded", "analytics_quota_exceeded"
]);

function monotonicNow(): number | null {
  try {
    const value = globalThis.performance.now();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export interface SemanticAnalyticsNodeDeliveryConfig {
  projectId: string;
  writerToken: string;
  serviceName?: string;
  environment?: string;
  framework?: string | null;
  endpoint?: string;
  enabled?: boolean;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface SemanticAnalyticsNodePrepareOptions {
  eventRevision: number;
  operationId: string;
  eventId?: string;
  occurredAt?: string;
  measurements?: Record<string, { unit: string; value: string }>;
  traceId?: string | null;
  deployId?: string | null;
  identity?: {
    namespaceRevision: number;
    anonymousIdHash?: string | null;
    userIdHash?: string | null;
    accountIdHash?: string | null;
  };
}

/** Request correlation only; protected subject references are explicit per fact. */
export interface SemanticAnalyticsNodeContext {
  traceId?: string | null;
  deployId?: string | null;
}

export interface SemanticAnalyticsNodeScope {
  track(name: string, properties: Record<string, unknown>, options: SemanticAnalyticsNodePrepareOptions): void;
  prepare(name: string, properties: Record<string, unknown>, options: SemanticAnalyticsNodePrepareOptions): Promise<AnalyticsPreparationResult>;
  setConsent(granted: boolean): void;
  reset(): void;
  getStatus(): SemanticAnalyticsNodeStatus;
}

export interface SemanticAnalyticsNodeDelivery {
  withContext(context: SemanticAnalyticsNodeContext): SemanticAnalyticsNodeScope;
  refreshCapability(): Promise<SemanticAnalyticsNodeStatus>;
  track(name: string, properties: Record<string, unknown>, options: SemanticAnalyticsNodePrepareOptions): void;
  flush(): Promise<void>;
  prepare(name: string, properties: Record<string, unknown>, options: SemanticAnalyticsNodePrepareOptions): Promise<AnalyticsPreparationResult>;
  deliver(records: readonly AnalyticsPreparedEvent[]): Promise<AnalyticsDeliveryResult>;
  getStatus(): SemanticAnalyticsNodeStatus;
}

/** Metadata from this instance's last capability check, not a live server authorization claim. */
export interface SemanticAnalyticsNodeStatus {
  enabled: boolean;
  inFlight: boolean;
  queuedEvents: number;
  queuedBytes: number;
  capability: "unchecked" | "enabled" | "disabled" | "expired" | "unavailable";
  lastFailure: Extract<AnalyticsDeliveryResult, { status: "unavailable" }>["reason"] | null;
  lastReceipt: { accepted: number; retryable: number; terminal: number } | null;
}

function unavailable(reason: Extract<AnalyticsDeliveryResult, { status: "unavailable" }>["reason"]): AnalyticsDeliveryResult {
  return { status: "unavailable", reason };
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function protectedFieldsAreCurrent(event: SemanticAnalyticsEvent): boolean {
  // Protocol field names such as session_id are not application telemetry.
  const fields = {
    service: event.service, payload: event.payload,
    trace: event.correlation.trace_id, deploy: event.correlation.deploy_id
  };
  const protectedFields = sanitizeTelemetry(fields);
  return protectedFields.ok && JSON.stringify(protectedFields.value) === JSON.stringify(fields);
}

function protectedContext(input: SemanticAnalyticsNodeContext): { traceId: string | null; deployId: string | null } | null {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Object.keys(descriptors).some((key) => key !== "traceId" && key !== "deployId")) return null;
    if ([descriptors["traceId"], descriptors["deployId"]].some((entry) => entry !== undefined && !("value" in entry)))
      return null;
    const values = [descriptors["traceId"], descriptors["deployId"]].map((entry) => entry?.value ?? null);
    if (values.some((value) => value !== null && (typeof value !== "string" || value.length === 0 || value.length > 128)))
      return null;
    const context = { traceId: values[0] as string | null, deployId: values[1] as string | null };
    const protectedValue = sanitizeTelemetry(context, { maxTotalBytes: 512 });
    return protectedValue.ok && JSON.stringify(protectedValue.value) === JSON.stringify(context) ? context : null;
  } catch {
    return null;
  }
}

function canonicalEndpoint(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    ) return null;
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (reader === undefined) return null;
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(chunk.value);
    }
    const complete = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      complete.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete)) as unknown;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

/** Explicit outbox consumer; it never owns, edits or silently acknowledges caller records. */
export function createSemanticAnalyticsNodeDelivery(config: SemanticAnalyticsNodeDeliveryConfig): SemanticAnalyticsNodeDelivery {
  let projectId = "";
  let writerToken = "";
  let endpoint: string | null = null;
  let enabled = false;
  let timeoutMs = 5_000;
  let fetchImpl: typeof fetch = globalThis.fetch;
  let serviceName = "node-service";
  let environment = process.env["NODE_ENV"] ?? "development";
  let framework: string | null = null;
  try {
    projectId = typeof config.projectId === "string" ? config.projectId.toLowerCase() : "";
    writerToken = typeof config.writerToken === "string" ? config.writerToken : "";
    endpoint = canonicalEndpoint(config.endpoint ?? DEFAULT_ENDPOINT);
    enabled = config.enabled === true;
    const requestedTimeout = config.requestTimeoutMs ?? 5_000;
    if (Number.isFinite(requestedTimeout)) timeoutMs = Math.min(60_000, Math.max(1, Math.floor(requestedTimeout)));
    fetchImpl = config.fetchImpl ?? globalThis.fetch;
    serviceName = config.serviceName ?? serviceName;
    environment = config.environment ?? environment;
    framework = config.framework ?? null;
  } catch {
    // Malformed runtime configuration leaves this opt-in writer inert.
  }
  const binding = endpoint === null ? null : digest(JSON.stringify(["debugbundle.analytics.destination.v1", endpoint, projectId]));
  let busy = false;
  let capabilityState: SemanticAnalyticsNodeStatus["capability"] = "unchecked";
  let capabilityExpiresAt = 0;
  let capabilityLease: { startedAt: number; lifetimeMs: number } | null = null;
  let currentCapability: AnalyticsCapabilities | null = null;
  let lastFailure: SemanticAnalyticsNodeStatus["lastFailure"] = null;
  let lastReceipt: SemanticAnalyticsNodeStatus["lastReceipt"] = null;
  const tracked: Array<{ record: AnalyticsPreparedEvent; bytes: number; queuedAt: number;
    queuedElapsedAt: number; scope: symbol }> = [];
  let trackedBytes = 0;
  let trackFlushActive = false;
  let capabilityCheckActive = false;
  let trackRetryDelayMs = 30_000;
  let trackTimer: ReturnType<typeof setTimeout> | null = null;
  const fail = (reason: Exclude<SemanticAnalyticsNodeStatus["lastFailure"], null>): AnalyticsDeliveryResult => {
    lastFailure = reason;
    return unavailable(reason);
  };

  const expireTracked = (): void => {
    const elapsedNow = monotonicNow();
    if (elapsedNow === null || tracked.some((item) => elapsedNow < item.queuedElapsedAt)) {
      clearTracked();
      return;
    }
    const cutoff = Date.now() - TRACK_LIFETIME_MS;
    while (tracked[0] !== undefined && (tracked[0].queuedAt <= cutoff ||
      elapsedNow - tracked[0].queuedElapsedAt >= TRACK_LIFETIME_MS)) {
      trackedBytes -= tracked.shift()!.bytes;
    }
  };

  const capabilityExpired = (): boolean => {
    const lease = capabilityLease;
    if (lease === null || capabilityExpiresAt <= Date.now()) return true;
    const elapsedNow = monotonicNow();
    return elapsedNow === null || elapsedNow < lease.startedAt ||
      elapsedNow - lease.startedAt >= lease.lifetimeMs;
  };

  const clearTracked = (): void => {
    if (trackTimer !== null) clearTimeout(trackTimer);
    trackTimer = null;
    tracked.length = 0;
    trackedBytes = 0;
  };

  const dropScope = (scope: symbol): void => {
    for (let index = tracked.length - 1; index >= 0; index -= 1) {
      if (tracked[index]?.scope !== scope) continue;
      trackedBytes -= tracked[index]!.bytes;
      tracked.splice(index, 1);
    }
    if (tracked.length === 0 && trackTimer !== null) {
      clearTimeout(trackTimer);
      trackTimer = null;
    }
  };

  const dropOversizeTracked = (capability: AnalyticsCapabilities): void => {
    for (let index = tracked.length - 1; index >= 0; index -= 1) {
      const item = tracked[index]!;
      const eventBytes = Buffer.byteLength(item.record.event_json, "utf8");
      if (eventBytes <= capability.max_event_bytes &&
        eventBytes + 14 <= capability.max_batch_bytes) continue;
      trackedBytes -= item.bytes;
      tracked.splice(index, 1);
      lastFailure = "capacity_exceeded";
    }
  };

  const scheduleTracked = (delayMs: number): void => {
    if (trackTimer !== null || tracked.length === 0) return;
    trackTimer = setTimeout(() => {
      trackTimer = null;
      void client.flush();
    }, delayMs);
    trackTimer.unref?.();
  };

  const checkCapability = async (signal: AbortSignal): Promise<
    | { ok: true; capability: AnalyticsCapabilities }
    | { ok: false; reason: Exclude<SemanticAnalyticsNodeStatus["lastFailure"], null> }
  > => {
    if (endpoint === null) return { ok: false, reason: "authentication_required" };
    currentCapability = null;
    capabilityLease = null;
    try {
      const response = await fetchImpl(`${endpoint}/v1/sdk/config`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${writerToken}`,
          "X-DebugBundle-Analytics-Schema": SEMANTIC_ANALYTICS_SCHEMA_VERSION
        },
        redirect: "manual",
        signal
      });
      if (response.status === 401) {
        capabilityState = "unavailable";
        clearTracked();
        return { ok: false, reason: "authentication_required" };
      }
      if (response.status !== 200) {
        capabilityState = "unavailable";
        return { ok: false, reason: "capability_unavailable" };
      }
      const body = await boundedJson(response);
      if (body === null || typeof body !== "object" || !("analytics_semantic" in body)) {
        capabilityState = "unavailable";
        clearTracked();
        return { ok: false, reason: "protocol_failure" };
      }
      const parsed = AnalyticsCapabilitiesSchema.safeParse(body.analytics_semantic);
      if (!parsed.success || parsed.data.project_id.toLowerCase() !== projectId || parsed.data.principal !== "server_writer") {
        capabilityState = "unavailable";
        clearTracked();
        return { ok: false, reason: "protocol_failure" };
      }
      const capability = parsed.data;
      const now = Date.now();
      const elapsedNow = monotonicNow();
      if (capability.scope.kind !== "project" ||
        capability.scope.project_id.toLowerCase() !== projectId ||
        capability.consent_required ||
        elapsedNow === null || Date.parse(capability.server_time) > now + 300_000) {
        capabilityState = "unavailable";
        clearTracked();
        return { ok: false, reason: "unsupported" };
      }
      capabilityExpiresAt = Date.parse(capability.expires_at);
      capabilityState = !capability.enabled ? "disabled" : capabilityExpiresAt <= now ? "expired" : "enabled";
      if (capabilityState !== "enabled") {
        clearTracked();
        return { ok: false, reason: "capability_unavailable" };
      }
      if (!capability.allowed_producers.includes("server") ||
        !capability.allowed_purposes.includes("business_measurement")) {
        capabilityState = "unavailable";
        clearTracked();
        return { ok: false, reason: "unsupported" };
      }
      capabilityLease = { startedAt: elapsedNow,
        lifetimeMs: Math.min(300_000, capabilityExpiresAt - now) };
      currentCapability = capability;
      return { ok: true, capability };
    } catch {
      capabilityState = "unavailable";
      return { ok: false, reason: signal.aborted ? "timeout" : "transport_failure" };
    }
  };

  function prepareLocal(
    name: string,
    properties: Record<string, unknown>,
    options: SemanticAnalyticsNodePrepareOptions,
    context?: { traceId: string | null; deployId: string | null }
  ): AnalyticsPreparationResult {
      if (!enabled) return { status: "unavailable", reason: "disabled" };
      if (!UUID.test(projectId) || !WRITER_TOKEN.test(writerToken) || binding === null)
        return { status: "unavailable", reason: "unsupported" };
      // Reject cheap invalid input before walking application-owned properties.
      if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(name))
        return { status: "unavailable", reason: "unsafe_input" };
      try {
        const safeOptions = sanitizeTelemetry(options, { maxTotalBytes: 16 * 1024 });
        if (!safeOptions.ok || safeOptions.value === null || Array.isArray(safeOptions.value) ||
          typeof safeOptions.value !== "object")
          return { status: "unavailable", reason: "unsafe_input" };
        const own = safeOptions.value as Record<string, unknown>;
        if (Object.keys(own).some((key) => ![
          "eventRevision", "operationId", "eventId", "occurredAt", "measurements", "traceId", "deployId", "identity"
        ].includes(key)) ||
          !Number.isSafeInteger(own["eventRevision"]) || Number(own["eventRevision"]) < 1 ||
          typeof own["operationId"] !== "string" || !/^sha256:[a-f0-9]{64}$/.test(own["operationId"]))
          return { status: "unavailable", reason: "unsafe_input" };
        const identityValue = own["identity"];
        if (identityValue !== undefined &&
          (identityValue === null || typeof identityValue !== "object" || Array.isArray(identityValue)))
          return { status: "unavailable", reason: "unsafe_input" };
        const identity = identityValue as Record<string, unknown> | undefined;
        if (identity !== undefined &&
          (Object.keys(identity).some((key) => ![
            "namespaceRevision", "anonymousIdHash", "userIdHash", "accountIdHash"
          ].includes(key)) ||
            !Number.isSafeInteger(identity["namespaceRevision"]) ||
            Number(identity["namespaceRevision"]) < 1))
          return { status: "unavailable", reason: "unsafe_input" };
        const anonymousIdHash = identity?.["anonymousIdHash"] ?? null;
        const userIdHash = identity?.["userIdHash"] ?? null;
        const accountIdHash = identity?.["accountIdHash"] ?? null;
        if (identity !== undefined &&
          [anonymousIdHash, userIdHash, accountIdHash].every((value) => value === null))
          return { status: "unavailable", reason: "unsafe_input" };
        const safeProperties = sanitizeTelemetry(properties, { maxTotalBytes: 16 * 1024 });
        if (!safeProperties.ok || safeProperties.value === null || Array.isArray(safeProperties.value) || typeof safeProperties.value !== "object")
          return { status: "unavailable", reason: "unsafe_input" };
        const now = Date.now();
        const occurredAt = own["occurredAt"] ?? new Date(now).toISOString();
        const occurredMs = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
        if (!Number.isFinite(occurredMs) || occurredMs < now - 7 * 86_400_000 || occurredMs > now + 300_000)
          return { status: "unavailable", reason: "unsafe_input" };
        const candidate = SemanticAnalyticsEventSchema.safeParse({
          schema_version: SEMANTIC_ANALYTICS_SCHEMA_VERSION,
          event_type: "analytics_event",
          event_id: own["eventId"] ?? randomUUID(),
          occurred_at: occurredAt,
          sdk_name: "@debugbundle/sdk-node",
          sdk_version: SDK_VERSION,
          service: { name: serviceName, runtime: "node", framework, environment },
          producer: { kind: "server", stream_id: null, sequence: null },
          operation_id: own["operationId"],
          correlation: {
            session_id: null, anonymous_id_hash: anonymousIdHash, user_id_hash: userIdHash,
            account_id_hash: accountIdHash,
            namespace_revision: identity?.["namespaceRevision"] ?? null,
            trace_id: context === undefined ? own["traceId"] ?? null : context.traceId,
            deploy_id: context === undefined ? own["deployId"] ?? null : context.deployId
          },
          payload: {
            kind: "semantic", name, event_revision: own["eventRevision"],
            purpose: "business_measurement", privacy: {
              mode: identity === undefined ? "strict" : userIdHash !== null || accountIdHash !== null ? "custom" : "standard",
              consent_granted: false
            },
            route: null, previous_route: null, screen: null, session: null,
            acquisition: null, client: null, properties: safeProperties.value,
            measurements: own["measurements"] ?? {}, money: null, financial: null
          }
        });
        if (!candidate.success || !protectedFieldsAreCurrent(candidate.data))
          return { status: "unavailable", reason: "unsafe_input" };
        const eventJson = JSON.stringify(candidate.data);
        const record = AnalyticsPreparedEventSchema.safeParse({
          protocol: "2026-09-analytics-prepared-01",
          project_id: projectId,
          destination_binding: binding,
          prepared_at: new Date(now).toISOString(),
          expires_at: new Date(now + 7 * 86_400_000).toISOString(),
          event_id: candidate.data.event_id,
          operation_id: candidate.data.operation_id,
          event_json: eventJson,
          prepared_content_hash: digest(eventJson)
        });
        if (!record.success) return { status: "unavailable", reason: "capacity_exceeded" };
        return { status: "prepared", record: Object.freeze(record.data) };
      } catch {
        return { status: "unavailable", reason: "unsafe_input" };
      }
  }

  const rootScope = Symbol("root");
  const enqueueTracked = (
    scope: symbol, context: { traceId: string | null; deployId: string | null } | undefined,
    name: string, properties: Record<string, unknown>, options: SemanticAnalyticsNodePrepareOptions
  ): void => {
    try {
      const capability = currentCapability;
      if (capability === null || capabilityState !== "enabled" || capabilityExpired()) return;
      expireTracked();
      if (tracked.length >= MAX_BATCH_EVENTS) return;
      const result = prepareLocal(name, properties, options, context);
      if (result.status !== "prepared") return;
      const event = JSON.parse(result.record.event_json) as SemanticAnalyticsEvent;
      if (event.correlation.namespace_revision !== null &&
        (event.correlation.namespace_revision !== capability.namespace_revision ||
          capability.identity_scope?.kind !== "project" ||
          capability.identity_scope.project_id.toLowerCase() !== projectId ||
          ((event.correlation.user_id_hash !== null || event.correlation.account_id_hash !== null) &&
            !capability.known_identity_allowed))) return;
      const eventBytes = Buffer.byteLength(result.record.event_json, "utf8");
      if (Object.keys(event.payload.properties).length > capability.max_properties ||
        eventBytes > capability.max_event_bytes || eventBytes + 14 > capability.max_batch_bytes) return;
      const bytes = Buffer.byteLength(JSON.stringify(result.record), "utf8");
      if (trackedBytes + bytes > MAX_TRACK_BYTES) return;
      const queuedElapsedAt = monotonicNow();
      if (queuedElapsedAt === null) return;
      tracked.push({ record: result.record, bytes, queuedAt: Date.now(), queuedElapsedAt, scope });
      trackedBytes += bytes;
      scheduleTracked(1_000);
    } catch {
      // Best-effort capture cannot interrupt application code.
    }
  };

  const client: SemanticAnalyticsNodeDelivery & {
    deliver(records: readonly AnalyticsPreparedEvent[], mayDispatch?: () => boolean): Promise<AnalyticsDeliveryResult>;
  } = {
    withContext(input): SemanticAnalyticsNodeScope {
      let context = protectedContext(input);
      let granted = context !== null;
      const scope = Symbol("request");
      const facade: SemanticAnalyticsNodeScope = {
        track(name, properties, options): void {
          if (granted && context !== null) enqueueTracked(scope, context, name, properties, options);
        },
        prepare(name, properties, options): Promise<AnalyticsPreparationResult> {
          return Promise.resolve(granted && context !== null
            ? prepareLocal(name, properties, options, context)
            : { status: "unavailable", reason: "disabled" });
        },
        setConsent(next): void {
          if (next !== true) {
            granted = false;
            dropScope(scope);
          } else if (context !== null) {
            granted = true;
          }
        },
        reset(): void {
          dropScope(scope);
          context = null;
          granted = false;
        },
        getStatus(): SemanticAnalyticsNodeStatus {
          const status = client.getStatus();
          const own = tracked.filter((item) => item.scope === scope);
          return { ...status, queuedEvents: own.length,
            queuedBytes: own.reduce((sum, item) => sum + item.bytes, 0) };
        }
      };
      return Object.freeze(facade);
    },
    async refreshCapability(): Promise<SemanticAnalyticsNodeStatus> {
      if (!enabled) {
        lastFailure = "disabled";
        return client.getStatus();
      }
      if (!UUID.test(projectId) || !WRITER_TOKEN.test(writerToken) || endpoint === null) {
        lastFailure = "authentication_required";
        return client.getStatus();
      }
      if (busy || capabilityCheckActive) return client.getStatus();
      capabilityCheckActive = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const result = await checkCapability(controller.signal);
        lastFailure = result.ok ? null : result.reason;
      } finally {
        clearTimeout(timer);
        capabilityCheckActive = false;
      }
      return client.getStatus();
    },
    track(name, properties, options): void {
      enqueueTracked(rootScope, undefined, name, properties, options);
    },
    async flush(): Promise<void> {
      if (trackFlushActive) return;
      trackFlushActive = true;
      if (trackTimer !== null) clearTimeout(trackTimer);
      trackTimer = null;
      try {
        expireTracked();
        if (currentCapability !== null) dropOversizeTracked(currentCapability);
        const batch: typeof tracked = [];
        const maxEvents = Math.min(MAX_BATCH_EVENTS, currentCapability?.max_batch_events ?? MAX_BATCH_EVENTS);
        const maxBytes = Math.min(MAX_BATCH_BYTES, currentCapability?.max_batch_bytes ?? MAX_BATCH_BYTES);
        let bodyBytes = 13;
        for (const item of tracked) {
          const nextBytes = Buffer.byteLength(item.record.event_json, "utf8") + 1;
          if (batch.length >= maxEvents || bodyBytes + nextBytes > maxBytes) break;
          batch.push(item);
          bodyBytes += nextBytes;
        }
        if (batch.length === 0) return;
        const result = await client.deliver(batch.map((item) => item.record),
          () => batch.every((item) => tracked.includes(item)));
        let nextDelayMs = trackRetryDelayMs;
        if (result.status === "received") {
          if (result.receipt.accepted > 0 &&
            !result.receipt.errors.some((error) => RETRYABLE_REJECTIONS.has(error.reason)))
            nextDelayMs = 1_000;
          // Only bounded quota/rate failures remain retryable; every other indexed rejection is final.
          const finalized = [
            ...result.receipt.accepted_events.map((accepted) => accepted.index),
            ...result.receipt.errors
              .filter((error) => !RETRYABLE_REJECTIONS.has(error.reason))
              .map((error) => error.index)
          ];
          for (const finalizedIndex of finalized) {
            const item = batch[finalizedIndex];
            if (item === undefined) continue;
            const index = tracked.indexOf(item);
            if (index >= 0) {
              tracked.splice(index, 1);
              trackedBytes -= item.bytes;
            }
          }
        } else if (result.reason === "capacity_exceeded" && currentCapability !== null) {
          // A refreshed grant may shrink while an older queued event is already finalized.
          // Discard only records that cannot fit alone so later eligible records can progress.
          dropOversizeTracked(currentCapability);
        } else if (result.reason === "policy_changed") {
          nextDelayMs = 1_000;
        }
        if (tracked.length > 0) scheduleTracked(nextDelayMs);
      } catch {
        lastFailure = "transport_failure";
      } finally {
        trackFlushActive = false;
        expireTracked();
        scheduleTracked(30_000);
      }
    },
    getStatus(): SemanticAnalyticsNodeStatus {
      return {
        enabled,
        inFlight: busy || trackFlushActive || capabilityCheckActive,
        queuedEvents: tracked.length,
        queuedBytes: trackedBytes,
        capability: capabilityState === "enabled" && capabilityExpired() ? "expired" : capabilityState,
        lastFailure,
        lastReceipt
      };
    },
    prepare(name, properties, options): Promise<AnalyticsPreparationResult> {
      return Promise.resolve(prepareLocal(name, properties, options));
    },
    async deliver(records, mayDispatch?: () => boolean): Promise<AnalyticsDeliveryResult> {
      if (!enabled) return fail("disabled");
      if (!UUID.test(projectId) || !WRITER_TOKEN.test(writerToken) || endpoint === null || binding === null)
        return fail("authentication_required");
      if (busy) return fail("capacity_exceeded");
      if (!Array.isArray(records) || records.length === 0) return fail("unsafe_input");
      if (records.length > MAX_BATCH_EVENTS) return fail("capacity_exceeded");

      const now = Date.now();
      const events: SemanticAnalyticsEvent[] = [];
      try {
        for (const candidate of records) {
          const parsed = AnalyticsPreparedEventSchema.safeParse(candidate);
          if (!parsed.success) return fail("unsafe_input");
          const record = parsed.data;
          if (record.project_id.toLowerCase() !== projectId || record.destination_binding.toLowerCase() !== binding)
            return fail("destination_mismatch");
          if (digest(record.event_json) !== record.prepared_content_hash.toLowerCase())
            return fail("integrity_failure");
          if (Date.parse(record.expires_at) <= now) return fail("record_expired");
          if (Date.parse(record.prepared_at) > now + 300_000) return fail("unsafe_input");
          const event = SemanticAnalyticsEventSchema.parse(JSON.parse(record.event_json));
          // Financial facts remain unavailable until billing-source authority and durable dedupe exist.
          if (event.payload.money !== null || event.payload.financial !== null)
            return fail("unsupported");
          // The event carries only explicit server-owned protected references.
          if (event.payload.purpose !== "business_measurement" ||
            event.payload.privacy.consent_granted)
            return fail("policy_changed");
          // Protocol field names such as session_id are not application telemetry.
          if (!protectedFieldsAreCurrent(event)) return fail("policy_changed");
          events.push(event);
        }
      } catch {
        return fail("unsafe_input");
      }
      const body = JSON.stringify({ events });
      if (Buffer.byteLength(body, "utf8") > MAX_BATCH_BYTES) return fail("capacity_exceeded");

      busy = true;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      timer.unref?.();
      try {
        const auth = { Authorization: `Bearer ${writerToken}` };
        const checked = await checkCapability(controller.signal);
        if (!checked.ok) return fail(checked.reason);
        const capability = checked.capability;
        const privacyRank = { custom: 0, standard: 1, strict: 2 } as const;
        if (events.some((event) =>
          privacyRank[event.payload.privacy.mode] < privacyRank[capability.privacy_mode]))
          return fail("policy_changed");
        if (events.some((event) =>
          event.correlation.namespace_revision !== null &&
          (event.correlation.namespace_revision !== capability.namespace_revision ||
            capability.identity_scope?.kind !== "project" ||
            capability.identity_scope.project_id.toLowerCase() !== projectId ||
            ((event.correlation.user_id_hash !== null || event.correlation.account_id_hash !== null) &&
              !capability.known_identity_allowed))))
          return fail("policy_changed");
        if (events.length > capability.max_batch_events || Buffer.byteLength(body, "utf8") > capability.max_batch_bytes ||
          events.some((event) => Buffer.byteLength(JSON.stringify(event), "utf8") > capability.max_event_bytes))
          return fail("capacity_exceeded");
        if (capabilityExpired()) return fail("capability_unavailable");
        // Scope withdrawal removes queued objects; one final check fences an in-progress capability lookup.
        if (mayDispatch !== undefined && !mayDispatch()) return fail("policy_changed");

        const response = await fetchImpl(`${endpoint}/v1/analytics/deliver`, {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body,
          redirect: "manual",
          signal: controller.signal
        });
        trackRetryDelayMs = response.status === 429
          ? Math.max(30_000, parseRetryAfter(response.headers.get("Retry-After")) ?? 30_000)
          : 30_000;
        if (response.status === 401) return fail("authentication_required");
        if (response.status !== 200 && response.status !== 429)
          return fail(response.status === 503 ? "capability_unavailable" : "transport_failure");
        const receipt = AnalyticsDeliveryReceiptSchema.safeParse(await boundedJson(response));
        if (!receipt.success || receipt.data.project_id.toLowerCase() !== projectId || receipt.data.submitted !== events.length)
          return fail("protocol_failure");
        for (const accepted of receipt.data.accepted_events) {
          const event = events[accepted.index];
          if (event?.event_id.toLowerCase() !== accepted.event_id.toLowerCase() ||
            (event.operation_id?.toLowerCase() ?? null) !== (accepted.operation_id?.toLowerCase() ?? null))
            return fail("protocol_failure");
        }
        const retryable = receipt.data.errors.filter((error) =>
          RETRYABLE_REJECTIONS.has(error.reason)).length;
        lastReceipt = {
          accepted: receipt.data.accepted,
          retryable,
          terminal: receipt.data.rejected - retryable
        };
        lastFailure = null;
        return { status: "received", receipt: receipt.data };
      } catch {
        return fail(controller.signal.aborted ? "timeout" : "transport_failure");
      } finally {
        clearTimeout(timer);
        busy = false;
      }
    }
  };
  return client;
}
