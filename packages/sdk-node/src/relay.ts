import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";

import { z } from "zod";

import { createFileTransport, resolveDefaultLocalEventsDir } from "./file-transport.js";
import type { DebugBundleProjectMode, DebugBundleTransport } from "./types.js";
import { createFetchTransport } from "./utils.js";
import { EventEnvelopeSchema, type EventEnvelope } from "@debugbundle/shared-types";

const DEFAULT_BROWSER_RELAY_MAX_BODY_BYTES = 256 * 1024;
const DEFAULT_BROWSER_RELAY_RATE_LIMIT_PER_MINUTE = 60;
const BROWSER_SDK_NAME = "@debugbundle/sdk-browser";
const RELAY_SPOOL_DELIVERED_MARKER_SUFFIX = ".delivered";

const BROWSER_RELAY_EVENT_TYPES = [
  "frontend_exception",
  "error_suppressed",
  "frontend_breadcrumb",
  "request_event",
  "probe_event"
] as const;

type BrowserRelayEventType = (typeof BROWSER_RELAY_EVENT_TYPES)[number];
type BrowserRelayEvent = Extract<EventEnvelope, { event_type: BrowserRelayEventType }>;

const ServiceSchema = z.object({
  name: z.string().min(1),
  runtime: z.string().min(1).nullable().optional(),
  framework: z.string().min(1).nullable().optional(),
  environment: z.string().min(1)
});

const CorrelationSchema = z.object({
  request_id: z.string().nullable(),
  trace_id: z.string().nullable(),
  session_id: z.string().nullable(),
  user_id_hash: z.string().nullable()
});

const FrontendBreadcrumbPayloadSchema = z.object({
  breadcrumb_type: z.enum(["route_change", "click", "form_submit", "console_log", "network_request"]),
  route: z.string().min(1).nullable().optional(),
  data: z.record(z.string(), z.unknown())
});

const FrontendExceptionBreadcrumbSchema = FrontendBreadcrumbPayloadSchema.extend({
  ts: z.string().datetime()
});

const DeviceInfoSchema = z.object({
  user_agent: z.string().nullable(),
  os: z.object({
    name: z.string().nullable(),
    version: z.string().nullable()
  }),
  device_type: z.enum(["desktop", "mobile", "tablet", "unknown"]),
  screen: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  }),
  viewport: z.object({
    width: z.number().int().nonnegative(),
    height: z.number().int().nonnegative()
  }),
  device_pixel_ratio: z.number().positive().nullable(),
  touch_capable: z.boolean().nullable(),
  language: z.string().nullable(),
  connection_type: z.string().nullable(),
  color_scheme_preference: z.enum(["light", "dark", "no-preference"]).nullable()
});

const InlineProbeDataSchema = z.object({
  version: z.literal(1),
  items: z.array(
    z.object({
      label: z.string().min(1),
      data: z.record(z.string(), z.unknown()),
      timestamp: z.string().datetime(),
      activation_id: z.string().uuid().nullable()
    })
  )
});

const BrowserExceptionEventSchema = z.object({
  kind: z.enum(["window_error", "resource_error"]),
  message: z.string().nullable(),
  file_name: z.string().nullable(),
  line_number: z.number().int().nonnegative().nullable(),
  column_number: z.number().int().nonnegative().nullable(),
  target: z
    .object({
      tag_name: z.string().nullable(),
      source_url: z.string().nullable(),
      attributes: z.object({
        rel: z.string().optional(),
        as: z.string().optional(),
        type: z.string().optional(),
        media: z.string().optional(),
        cross_origin: z.string().optional(),
        async: z.boolean().optional(),
        defer: z.boolean().optional(),
        integrity_present: z.boolean().optional()
      }).optional()
    })
    .nullable(),
  page: z.object({
    url: z.string().nullable(),
    referrer: z.string().nullable(),
    ready_state: z.enum(["loading", "interactive", "complete"]).nullable(),
    visibility_state: z.enum(["visible", "hidden", "prerender", "unloaded"]).nullable()
  }).optional(),
  opaque: z.boolean()
});

const FrontendExceptionPayloadSchema = z.object({
  name: z.string().min(1),
  message: z.string().min(1),
  stack: z.string().min(1),
  route: z.string().min(1).nullable().optional(),
  browser: z.object({
    name: z.string().min(1),
    version: z.string().min(1)
  }),
  breadcrumbs: z.array(FrontendExceptionBreadcrumbSchema).optional(),
  device: DeviceInfoSchema.nullable().optional(),
  browser_event: BrowserExceptionEventSchema.optional(),
  dom_context: z.object({
    mode: z.literal("lightweight"),
    html_excerpt: z.string().min(1)
  }).nullable().optional(),
  probe_data: InlineProbeDataSchema.optional()
});

const ErrorSuppressedPayloadSchema = z.object({
  fingerprint: z.string().min(1),
  suppressed_count: z.number().int().nonnegative(),
  window_seconds: z.number().int().positive(),
  first_seen: z.string().datetime(),
  last_seen: z.string().datetime()
});

const RequestEventPayloadSchema = z.object({
  method: z.string().min(1),
  path: z.string().min(1),
  query: z.record(z.string(), z.unknown()),
  headers: z.record(z.string(), z.unknown()),
  body: z.unknown().nullable().optional(),
  response_status: z.number().int().nonnegative(),
  duration_ms: z.number().nonnegative(),
  route_template: z.string().min(1).nullable().optional(),
  response_headers: z.record(z.string(), z.unknown()).optional(),
  response_body: z.unknown().optional()
});

const ProbeEventPayloadSchema = z.object({
  label: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  activation_id: z.string().uuid().nullable(),
  probe_label_pattern: z.string().min(1)
});

const BrowserRelayEnvelopeBaseSchema = z.object({
  schema_version: z.string().min(1),
  event_id: z.string().uuid(),
  event_type: z.enum(BROWSER_RELAY_EVENT_TYPES),
  sdk_name: z.string().min(1).optional(),
  sdk_version: z.string().min(1),
  service: ServiceSchema,
  occurred_at: z.string().datetime(),
  correlation: CorrelationSchema.optional()
});

const BrowserRelayEventSchema = z.discriminatedUnion("event_type", [
  BrowserRelayEnvelopeBaseSchema.extend({
    event_type: z.literal("frontend_exception"),
    payload: FrontendExceptionPayloadSchema
  }),
  BrowserRelayEnvelopeBaseSchema.extend({
    event_type: z.literal("error_suppressed"),
    payload: ErrorSuppressedPayloadSchema
  }),
  BrowserRelayEnvelopeBaseSchema.extend({
    event_type: z.literal("frontend_breadcrumb"),
    payload: FrontendBreadcrumbPayloadSchema
  }),
  BrowserRelayEnvelopeBaseSchema.extend({
    event_type: z.literal("request_event"),
    payload: RequestEventPayloadSchema
  }),
  BrowserRelayEnvelopeBaseSchema.extend({
    event_type: z.literal("probe_event"),
    payload: ProbeEventPayloadSchema
  })
]);

const BrowserRelayRequestBodySchema = z.object({
  batch: z.array(z.unknown())
});

const STRIPPED_REQUEST_HEADERS = new Set(["authorization", "cookie", "x-api-key"]);

export interface BrowserRelayRequest {
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
  };
}

export interface BrowserRelayOptions {
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

function buildCorsHeaders(origin: string): Record<string, string> {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
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

function parseEventEnvelopeWithBrowserMetadata(candidate: unknown): EventEnvelope {
  if (candidate !== null && typeof candidate === "object") {
    const record = candidate as Record<string, unknown>;
    const payload = record["payload"];

    if (record["event_type"] === "frontend_exception" && payload !== null && typeof payload === "object") {
      const { browser_event: browserEvent, ...payloadWithoutBrowserEvent } = payload as Record<string, unknown>;
      const event = EventEnvelopeSchema.parse({
        ...record,
        payload: payloadWithoutBrowserEvent
      });

      if (browserEvent !== undefined) {
        (event.payload as Record<string, unknown>)["browser_event"] = browserEvent;
      }

      return event;
    }
  }

  return EventEnvelopeSchema.parse(candidate);
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

  return normalizedEvent as BrowserRelayEvent;
}

function resolveDefaultRelaySpoolDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".debugbundle", "local", "browser-relay-spool");
}

function attachProjectToken(events: BrowserRelayEvent[], projectToken: string): EventEnvelope[] {
  return events.map((event) =>
    parseEventEnvelopeWithBrowserMetadata({
      ...event,
      project_token: projectToken
    })
  );
}

function markSpoolFileDelivered(writtenFilePath: string): void {
  try {
    fs.writeFileSync(`${writtenFilePath}${RELAY_SPOOL_DELIVERED_MARKER_SUFFIX}`, "", "utf8");
  } catch {
    // Durable acceptance already happened at the spool write; marker creation is maintenance metadata only.
  }
}

export function createBrowserRelay(options: BrowserRelayOptions = {}): (request: BrowserRelayRequest) => Promise<BrowserRelayResponse> {
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
    events: BrowserRelayEvent[]
  ): Promise<{ configured: boolean; succeeded: boolean }> => {
    if (connectedCloudTransport === null || options.endpoint === undefined || options.projectToken === undefined) {
      return {
        configured: false,
        succeeded: false
      };
    }

    const forwardResult = await connectedCloudTransport({
      endpoint: options.endpoint,
      headers: {},
      events: attachProjectToken(events, options.projectToken),
      timeout_ms: 5_000
    }).catch(() => null);

    return {
      configured: true,
      succeeded: forwardResult !== null && forwardResult.status >= 200 && forwardResult.status < 300
    };
  };

  return async (request: BrowserRelayRequest): Promise<BrowserRelayResponse> => {
    const receivedAt = now();
    const headers = getNormalizedHeaders(request.headers);
    const sourceOrigin = getSourceOrigin(headers);

    if (!isOriginAllowed(sourceOrigin, headers, options.allowedOrigins)) {
      return { status: 403 };
    }

    const corsHeaders = sourceOrigin === null ? undefined : buildCorsHeaders(sourceOrigin);
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

    const candidates = parsedBody.batch;

    for (const [index, candidate] of candidates.entries()) {
      const rawEventType =
        candidate !== null && typeof candidate === "object" && "event_type" in candidate
          ? (candidate as { event_type?: unknown }).event_type
          : undefined;

      if (typeof rawEventType !== "string" || !BROWSER_RELAY_EVENT_TYPES.includes(rawEventType as BrowserRelayEventType)) {
        errors.push(`batch[${index}]: Unsupported browser relay event type ${String(rawEventType)}.`);
        continue;
      }

      try {
        acceptedEvents.push(
          toBrowserRelayEvent(candidate, {
            ...(options.service === undefined ? {} : { service: options.service }),
            ...(options.environment === undefined ? {} : { environment: options.environment })
          })
        );
      } catch (error) {
        if (error instanceof z.ZodError) {
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
            events: acceptedEvents,
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
            events: acceptedEvents,
            timeout_ms: 0
          });

          if (spoolWriteResult.status !== 202) {
            return withHeaders({ status: 500 });
          }

          const forwardResult = await forwardConnectedEvents(acceptedEvents);
          if (forwardResult.configured && !forwardResult.succeeded) {
            // Keep the spool on disk for later recovery; the relay has already durably accepted the batch.
          } else if (forwardResult.succeeded && spoolWriteResult.writtenFilePath !== undefined) {
            markSpoolFileDelivered(spoolWriteResult.writtenFilePath);
          }
        } else {
          const forwardResult = await forwardConnectedEvents(acceptedEvents);
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
      status: errors.length === 0 ? 202 : 400,
      body: {
        accepted: acceptedEvents.length,
        rejected: errors.length,
        errors
      }
    });
  };
}
