import { z } from "zod";
import { DiagnosticContextPayloadSchema, ExceptionEvidenceV1Schema, ResourceObservationsSchema } from "@debugbundle/shared-types";

export const BROWSER_RELAY_EVENT_TYPES = [
  "frontend_exception",
  "error_suppressed",
  "frontend_breadcrumb",
  "request_event",
  "probe_event",
  "diagnostic_context",
  "analytics_event"
] as const;

export type BrowserRelayEventType = (typeof BROWSER_RELAY_EVENT_TYPES)[number];

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

const AnalyticsCorrelationSchema = z.object({
  session_id: z.string().min(1).max(128),
  visitor_id_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/i).nullable(),
  user_id_hash: z.string().regex(/^sha256:[a-f0-9]{64}$/i).nullable(),
  trace_id: z.string().min(1).max(128).nullable(),
  deploy_id: z.string().min(1).max(128).nullable()
});

const AnalyticsRouteSchema = z.object({
  path: z.string().min(1).max(2048),
  normalized_path: z.string().min(1).max(2048),
  title: z.string().max(200).nullable()
});

const AnalyticsPayloadSchema = z.object({
  kind: z.enum([
    "session_start",
    "page_view",
    "route_change",
    "action",
    "funnel_step",
    "conversion",
    "journey_marker",
    "session_summary"
  ]),
  privacy: z.object({
    mode: z.enum(["strict", "standard", "custom"]),
    consent_granted: z.boolean()
  }),
  session: z.object({
    duration_ms: z.number().int().min(0).max(86_400_000),
    pageviews: z.number().int().min(0).max(100_000)
  }).optional(),
  signal: z.object({
    action_key: z.string().nullable(),
    funnel_key: z.string().nullable(),
    step_key: z.string().nullable(),
    conversion_key: z.string().nullable(),
    marker_key: z.string().nullable()
  }).optional(),
  route: AnalyticsRouteSchema.nullable().optional(),
  previous_route: AnalyticsRouteSchema.nullable().optional(),
  dimensions: z.record(z.string(), z.unknown()),
  custom_dimensions: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
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
  exception_evidence: ExceptionEvidenceV1Schema.optional(),
  resource_observations: ResourceObservationsSchema.optional(),
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
  correlation: CorrelationSchema.optional(),
  context: z.record(z.string(), z.unknown()).optional()
});

export const BrowserRelayEventSchema = z.discriminatedUnion("event_type", [
  BrowserRelayEnvelopeBaseSchema.extend({ event_type: z.literal("diagnostic_context"), payload: DiagnosticContextPayloadSchema }),
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
  }),
  BrowserRelayEnvelopeBaseSchema.extend({
    event_type: z.literal("analytics_event"),
    correlation: AnalyticsCorrelationSchema,
    payload: AnalyticsPayloadSchema
  })
]);

export type BrowserRelayEvent = z.infer<typeof BrowserRelayEventSchema>;
export type BrowserRelayForwardEvent = BrowserRelayEvent & { project_token: string };
