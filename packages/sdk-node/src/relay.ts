import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";
import { BROWSER_RELAY_EVENT_TYPES, BrowserRelayEventSchema, type BrowserRelayEventType, type BrowserRelayEvent } from "./relay-schemas.js";
import { RelayEvidencePath, requestsRelayEvidence } from "./relay-evidence.js";
import { protectNodeEvent } from "./privacy.js";

import { createFileTransport, resolveDefaultLocalEventsDir } from "./file-transport.js";
import type { DebugBundleProjectMode, DebugBundleTransport } from "./types.js";
import { createFetchTransport } from "./utils.js";
import { EventEnvelopeSchema, type EventEnvelope, type EvidenceCapabilities } from "@debugbundle/shared-types";
import { sanitizeTelemetry } from "@debugbundle/redaction";

const DEFAULT_BROWSER_RELAY_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_BROWSER_RELAY_RATE_LIMIT_PER_MINUTE = 60;
const BROWSER_SDK_NAME = "@debugbundle/sdk-browser";
const RELAY_SPOOL_DELIVERED_MARKER_SUFFIX = ".delivered";

const BrowserRelayRequestBodySchema = z.object({
  batch: z.array(z.unknown())
});

const STRIPPED_REQUEST_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);

export interface BrowserRelayRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string | string[] | undefined>;
  body: string | Uint8Array;
  ipAddress?: string | null;
}

export interface BrowserRelayAcceptedBatch {
  events: BrowserRelayEvent[];
  headers: Record<string, string>;
  ipAddress: string | null;
  receivedAt: string;
}

export interface BrowserRelayResponse {
  status: number;
  headers?: Record<string, string>;
  body?: {
    accepted: number;
    rejected: number;
    errors: string[];
    evidence_errors?: Array<{ index: number; reason: string }>;
    evidence_capabilities?: EvidenceCapabilities;
  };
}

export interface BrowserRelayOptions {
  evidenceCapabilities?: EvidenceCapabilities;
  allowedOrigins?: string[];
  durableWrite?: boolean;
  environment?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  localEventsDir?: string;
  maxBodyBytes?: number;
  now?: () => Date;
  onAccept?: (input: BrowserRelayAcceptedBatch) => Promise<void> | void;
  projectToken?: string;
  projectMode?: DebugBundleProjectMode;
  rateLimitPerMinute?: number;
  service?: string;
  spoolDir?: string;
}

type RateLimitState = {
  timestamps: number[];
};

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/$/, "").toLowerCase();
}

function getNormalizedHeaders(headers: Record<string, string | string[] | undefined> | undefined): Record<string, string> {
  if (headers === undefined) {
    return {};
  }

  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) {
      continue;
    }

    normalized[key.toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
  }

  return normalized;
}

function stripSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (STRIPPED_REQUEST_HEADERS.has(key)) {
      continue;
    }

    sanitized[key] = value;
  }

  return sanitized;
}

function getSourceOrigin(headers: Record<string, string>): string | null {
  const origin = headers["origin"]?.trim();
  if (origin !== undefined && origin.length > 0) {
    return origin;
  }

  const referer = headers["referer"]?.trim();
  if (referer === undefined || referer.length === 0) {
    return null;
  }

  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function getExpectedHost(headers: Record<string, string>): string | null {
  const forwardedHost = headers["x-forwarded-host"]?.trim();
  if (forwardedHost !== undefined && forwardedHost.length > 0) {
    return forwardedHost.toLowerCase();
  }

  const host = headers["host"]?.trim();
  return host !== undefined && host.length > 0 ? host.toLowerCase() : null;
}

function isOriginAllowed(origin: string | null, headers: Record<string, string>, allowedOrigins: string[] | undefined): boolean {
  if (origin === null) {
    return false;
  }

  if (allowedOrigins !== undefined && allowedOrigins.length > 0) {
    const normalizedOrigin = normalizeOrigin(origin);
    return allowedOrigins.some((candidate) => normalizeOrigin(candidate) === normalizedOrigin);
  }

  const expectedHost = getExpectedHost(headers);
  if (expectedHost === null) {
    return false;
  }

  try {
    return new URL(origin).host.toLowerCase() === expectedHost;
  } catch {
    return false;
  }
}

function isAcceptedRelayContentType(contentType: string | undefined): boolean {
  if (contentType === undefined) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return normalized.includes("application/json");
}

function buildCorsHeaders(origin: string, evidence = false): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": evidence ? "content-type, x-debugbundle-evidence" : "content-type",
    "access-control-max-age": "600",
    vary: "Origin"
  };
}

function getBodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : Buffer.from(body).toString("utf8");
}

function getBodySize(body: string | Uint8Array): number {
  return typeof body === "string" ? Buffer.byteLength(body) : body.byteLength;
}

function getIssueMessage(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Invalid browser relay event payload.";
}

function parseEventEnvelopeWithBrowserMetadata(candidate: unknown): BrowserRelayEvent {
  if (candidate !== null && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    const payload = record["payload"];

    if (record["event_type"] === "analytics_event") {
      return BrowserRelayEventSchema.parse(record);
    }

    if (record["event_type"] === "frontend_exception" && payload !== null && typeof payload === "object") {
      const { browser_event: browserEvent, ...payloadWithoutBrowserEvent } = payload as Record<string, unknown>;
      const event = EventEnvelopeSchema.parse({
        ...record,
        payload: payloadWithoutBrowserEvent
      });

      if (browserEvent !== undefined) {
        (event.payload as Record<string, unknown>)["browser_event"] = browserEvent;
      }

      return event as BrowserRelayEvent;
    }
  }

  return EventEnvelopeSchema.parse(candidate) as BrowserRelayEvent;
}

function toBrowserRelayEvent(
  candidate: unknown,
  overrides: { service?: string; environment?: string }
): BrowserRelayEvent {
  const parsedCandidate = BrowserRelayEventSchema.parse(candidate);
  const normalizedEvent = parseEventEnvelopeWithBrowserMetadata({
    ...parsedCandidate,
    sdk_name: BROWSER_SDK_NAME,
    service: {
      ...parsedCandidate.service,
      ...(overrides.service === undefined ? {} : { name: overrides.service }),
      ...(overrides.environment === undefined ? {} : { environment: overrides.environment })
    }
  });

  return normalizedEvent;
}

function protectRelayEvent(event: BrowserRelayEvent): BrowserRelayEvent | null {
  if (event.event_type !== "analytics_event") return protectNodeEvent(event as EventEnvelope, []) as BrowserRelayEvent | null;
  for (const value of [event.schema_version, event.sdk_name, event.sdk_version,
    ...Object.values(event.correlation ?? {})]) {
    if (typeof value !== "string") continue;
    const checked = sanitizeTelemetry(value);
    if (!checked.ok || checked.value !== value) return null;
  }
  const sanitized = sanitizeTelemetry({ payload: event.payload, service: event.service });
  if (!sanitized.ok || sanitized.value === null || Array.isArray(sanitized.value) ||
      typeof sanitized.value !== "object") return null;
  const parsed = BrowserRelayEventSchema.safeParse({
    ...event,
    payload: sanitized.value["payload"],
    service: sanitized.value["service"]
  });
  return parsed.success ? parsed.data : null;
}

function resolveDefaultRelaySpoolDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".debugbundle", "local", "browser-relay-spool");
}

function markSpoolFileDelivered(writtenFilePath: string): void {
  try {
    const original = fs.lstatSync(writtenFilePath);
    if (!original.isFile() || original.isSymbolicLink()) return;
    const descriptor = fs.openSync(`${writtenFilePath}${RELAY_SPOOL_DELIVERED_MARKER_SUFFIX}`,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
        (typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0), 0o600);
    fs.closeSync(descriptor);
  } catch {
    // Durable acceptance already happened at the spool write; marker creation is maintenance metadata only.
  }
}

export function createBrowserRelay(options: BrowserRelayOptions = {}): (request: BrowserRelayRequest) => Promise<BrowserRelayResponse> {
  const evidence = new RelayEvidencePath(options.evidenceCapabilities);
  const now = options.now ?? (() => new Date());
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_BROWSER_RELAY_MAX_BODY_BYTES;
  const onAccept = options.onAccept ?? (() => undefined);
  const rateLimitPerMinute = options.rateLimitPerMinute ?? DEFAULT_BROWSER_RELAY_RATE_LIMIT_PER_MINUTE;
  const rateLimits = new Map<string, RateLimitState>();
  const localTransports = new Map<string, DebugBundleTransport>();
  const spoolTransports = new Map<string, DebugBundleTransport>();
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const connectedCloudTransport =
    options.projectMode === "local-only" || options.projectToken === undefined || fetchImpl === undefined
      ? null
      : createFetchTransport(fetchImpl, options.projectToken);

  const forwardConnectedEvents = async (
    events: BrowserRelayEvent[], discover: boolean
  ): Promise<{ configured: boolean; succeeded: boolean; complete: boolean }> => {
    if (connectedCloudTransport === null || options.endpoint === undefined || options.projectToken === undefined) {
      return {
        configured: false,
        succeeded: false,
        complete: false
      };
    }

    const result = await evidence.forward({ events, transport: connectedCloudTransport, endpoint: options.endpoint,
      projectToken: options.projectToken, discover }).catch(() => ({ succeeded: false, complete: false }));

    return {
      configured: true,
      ...result
    };
  };

  return async (request: BrowserRelayRequest): Promise<BrowserRelayResponse> => {
    const receivedAt = now();
    const headers = getNormalizedHeaders(request.headers);
    const discoverEvidence = requestsRelayEvidence(request.url, headers);
    const sourceOrigin = getSourceOrigin(headers);

    if (!isOriginAllowed(sourceOrigin, headers, options.allowedOrigins)) {
      return { status: 403 };
    }

    const corsHeaders = sourceOrigin === null ? undefined : buildCorsHeaders(sourceOrigin,
      headers["access-control-request-headers"]?.toLowerCase().split(",").some(value => value.trim() === "x-debugbundle-evidence"));
    const withHeaders = (response: BrowserRelayResponse): BrowserRelayResponse => {
      if (corsHeaders === undefined) {
        return response;
      }

      return {
        ...response,
        headers: {
          ...corsHeaders,
          ...response.headers
        }
      };
    };

    const requestMethod = request.method?.toUpperCase() ?? "POST";
    if (requestMethod === "OPTIONS") {
      return withHeaders({ status: 204 });
    }

    if (requestMethod !== "POST") {
      return withHeaders({ status: 405 });
    }

    if (!isAcceptedRelayContentType(headers["content-type"])) {
      return withHeaders({
        status: 400,
        body: {
          accepted: 0,
          rejected: 0,
          errors: ["Relay requests must use Content-Type: application/json."]
        }
      });
    }

    if (getBodySize(request.body) > maxBodyBytes) {
      return withHeaders({ status: 413 });
    }

    const ipAddress = request.ipAddress ?? null;
    const rateLimitKey = ipAddress ?? "unknown";
    const existingState = rateLimits.get(rateLimitKey) ?? { timestamps: [] };
    const currentWindowStart = receivedAt.getTime() - 60_000;
    existingState.timestamps = existingState.timestamps.filter((timestamp) => timestamp > currentWindowStart);

    if (existingState.timestamps.length >= rateLimitPerMinute) {
      rateLimits.set(rateLimitKey, existingState);
      return withHeaders({ status: 429 });
    }

    existingState.timestamps.push(receivedAt.getTime());
    rateLimits.set(rateLimitKey, existingState);

    let parsedBody: { batch: unknown[] };
    try {
      parsedBody = BrowserRelayRequestBodySchema.parse(JSON.parse(getBodyText(request.body)));
    } catch {
      return withHeaders({
        status: 400,
        body: {
          accepted: 0,
          rejected: 0,
          errors: ["Relay request body must be valid JSON with a batch array."]
        }
      });
    }

    const acceptedEvents: BrowserRelayEvent[] = [];
    const errors: string[] = [];
    const canonicalErrors: Array<{ index: number; reason: string }> = [];

    const candidates = parsedBody.batch;

    for (const [index, candidate] of candidates.entries()) {
      const rawEventType =
        candidate !== null && typeof candidate === "object" && "event_type" in candidate
          ? (candidate as { event_type?: unknown }).event_type
          : undefined;

      if (typeof rawEventType !== "string" || !BROWSER_RELAY_EVENT_TYPES.includes(rawEventType as BrowserRelayEventType)) {
        canonicalErrors.push({ index, reason: "invalid_event" });
        errors.push(`batch[${index}]: Unsupported browser relay event type ${String(rawEventType)}.`);
        continue;
      }

      try {
        const protectedEvent = protectRelayEvent(
          toBrowserRelayEvent(candidate, {
            ...(options.service === undefined ? {} : { service: options.service }),
            ...(options.environment === undefined ? {} : { environment: options.environment })
          })
        );
        if (protectedEvent === null) {
          canonicalErrors.push({ index, reason: "invalid_event" });
          errors.push(`batch[${index}]: Privacy sanitation failed.`);
          continue;
        }
        let supported = evidence.prepare(protectedEvent);
        if (supported !== null && connectedCloudTransport !== null && options.endpoint !== undefined && options.projectToken !== undefined)
          supported = evidence.prepareForward(supported, options.projectToken);
        if (supported === null) { canonicalErrors.push({ index, reason: "invalid_event" }); errors.push(`batch[${index}]: Unsupported evidence context.`); continue; }
        acceptedEvents.push(supported);
      } catch (error) {
        if (error instanceof z.ZodError) {
          canonicalErrors.push({ index, reason: "invalid_event" });
          errors.push(`batch[${index}]: ${getIssueMessage(error)}`);
          continue;
        }

        throw error;
      }
    }

    if (acceptedEvents.length > 0) {
      try {
        const serviceName = acceptedEvents[0]?.service.name ?? options.service ?? "service";

        if (options.projectMode === "local-only") {
          const localTransport = localTransports.get(serviceName) ?? createFileTransport({
            eventsDir: options.localEventsDir ?? resolveDefaultLocalEventsDir(),
            serviceName
          });
          localTransports.set(serviceName, localTransport);

          const localWriteResult = await localTransport({
            endpoint: "local://browser-relay",
            headers: {},
            events: acceptedEvents as EventEnvelope[],
            timeout_ms: 0
          });

          if (localWriteResult.status !== 202) {
            return withHeaders({ status: 500 });
          }
        } else if (options.durableWrite !== false) {
          const spoolTransport = spoolTransports.get(serviceName) ?? createFileTransport({
            eventsDir: options.spoolDir ?? resolveDefaultRelaySpoolDir(),
            serviceName
          });
          spoolTransports.set(serviceName, spoolTransport);

          const spoolWriteResult = await spoolTransport({
            endpoint: "local://browser-relay-spool",
            headers: {},
            events: acceptedEvents as EventEnvelope[],
            timeout_ms: 0
          });

          if (spoolWriteResult.status !== 202) {
            return withHeaders({ status: 500 });
          }

          const forwardResult = await forwardConnectedEvents(acceptedEvents, discoverEvidence);
          if (forwardResult.configured && !forwardResult.succeeded) {
            // Keep the spool on disk for later recovery; the relay has already durably accepted the batch.
          } else if (forwardResult.complete && spoolWriteResult.writtenFilePath !== undefined) {
            markSpoolFileDelivered(spoolWriteResult.writtenFilePath);
          }
        } else {
          const forwardResult = await forwardConnectedEvents(acceptedEvents, discoverEvidence);
          if (!forwardResult.configured || !forwardResult.succeeded) {
            return withHeaders({ status: 500 });
          }
        }

        await onAccept({
          events: acceptedEvents,
          headers: stripSensitiveHeaders(headers),
          ipAddress,
          receivedAt: receivedAt.toISOString()
        });
      } catch {
        return withHeaders({ status: 500 });
      }
    }

    return withHeaders({
      status: discoverEvidence || errors.length === 0 ? 202 : 400,
      body: {
        accepted: acceptedEvents.length,
        rejected: errors.length,
        errors,
        ...(discoverEvidence ? { evidence_capabilities: evidence.descriptor, evidence_errors: canonicalErrors } : {})
      }
    });
  };
}
