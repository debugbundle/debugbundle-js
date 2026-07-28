import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { applyNodeBeforeSend } from "./before-send.js";
import { evaluateNodeCaptureRulesForEvent } from "./capture-rules.js";
import { EventSuppressionTracker } from "./suppression.js";
import {
  LOG_LEVEL_ORDER,
  SDK_NAME,
  SDK_SCHEMA_VERSION,
  SDK_VERSION,
  type ActiveConfig,
  type CaptureLogContext,
  type CaptureRequestInput,
  type CaptureResponseInput,
  type CorrelationFields,
  type LogLevel,
  type ProbeBufferItem
} from "./types.js";
import { buildSdkConfigEndpoint, extractHeaderValue, redactObject, sanitizeUnknown } from "./utils.js";

export function buildNodeServiceDescriptor(config: ActiveConfig): EventEnvelope["service"] {
  return {
    name: config.service,
    runtime: "node",
    ...(config.framework === null ? {} : { framework: config.framework }),
    environment: config.environment
  };
}

export function buildNodeCorrelation(
  correlation: Partial<CorrelationFields> | undefined,
  request: CaptureRequestInput | undefined,
  contextFields: Readonly<Record<string, unknown>>
): CorrelationFields {
  const readContextString = (key: string): string | null => {
    const value = contextFields[key];
    return typeof value === "string" ? value : null;
  };
  return {
    request_id: correlation?.request_id ?? readContextString("request_id") ?? extractHeaderValue(request?.headers, "x-request-id"),
    trace_id:
      correlation?.trace_id ?? readContextString("trace_id") ?? extractHeaderValue(request?.headers, "x-debugbundle-trace-id"),
    session_id: correlation?.session_id ?? readContextString("session_id"),
    user_id_hash: correlation?.user_id_hash ?? readContextString("user_id_hash")
  };
}

export function buildNodeRequestSnapshot(
  request: CaptureRequestInput | undefined,
  sensitiveKeys: string[]
): {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  query: Record<string, unknown>;
  body: unknown;
  route_template: string | null;
} {
  return {
    method: request?.method ?? "UNKNOWN",
    path: request?.path ?? request?.url ?? "/",
    headers: redactObject(request?.headers ?? {}, sensitiveKeys),
    query: redactObject(request?.query ?? {}, sensitiveKeys),
    body: request?.body === undefined ? null : redactObject(request.body, sensitiveKeys),
    route_template: request?.routeTemplate ?? null
  };
}

export function buildNodeResponseSnapshot(
  response: CaptureResponseInput | undefined,
  sensitiveKeys: string[]
): {
  status_code: number;
  headers?: Record<string, unknown>;
  body?: unknown;
} {
  const statusCode = response?.statusCode ?? response?.status ?? 0;
  const snapshot: { status_code: number; headers?: Record<string, unknown>; body?: unknown } = {
    status_code: statusCode
  };

  if (response?.headers !== undefined && Object.keys(response.headers).length > 0) {
    snapshot.headers = redactObject(response.headers, sensitiveKeys);
  }

  if (response?.body !== undefined && statusCode >= 400) {
    snapshot.body = redactObject(response.body, sensitiveKeys);
  }

  return snapshot;
}

export function buildNodeLogAttributes(
  context: CaptureLogContext,
  contextFields: Readonly<Record<string, unknown>>,
  sensitiveKeys: string[]
): Record<string, unknown> {
  const attributes: Record<string, unknown> = {};
  if (Object.keys(contextFields).length > 0) {
    attributes["context"] = { ...contextFields };
  }

  const rest: Record<string, unknown> = { ...context };
  delete rest["correlation"];
  const redacted = redactObject(rest, sensitiveKeys);
  for (const [key, value] of Object.entries(redacted)) {
    attributes[key] = value;
  }

  return attributes;
}

export function consumeNodeProbeData(
  probeBuffers: Map<string, ProbeBufferItem[]>
): { version: 1; items: ProbeBufferItem[] } | null {
  if (probeBuffers.size === 0) {
    return null;
  }

  const items: ProbeBufferItem[] = [];
  probeBuffers.forEach((entries: ProbeBufferItem[]) => {
    entries.forEach((entry: ProbeBufferItem) => {
      items.push(entry);
    });
  });
  probeBuffers.clear();
  return {
    version: 1,
    items
  };
}

export function applyNodeBeforeSendEvent(
  event: EventEnvelope,
  beforeSend: ActiveConfig["beforeSend"],
  onDiagnostic: (code: string, message: string, metadata?: Record<string, unknown>) => void
): EventEnvelope | null {
  return applyNodeBeforeSend(event, beforeSend, onDiagnostic);
}

export function buildNodeSuppressionKey(event: EventEnvelope): string | null {
  if (event.event_type === "backend_exception") {
    return JSON.stringify({
      event_type: event.event_type,
      name: event.payload.name,
      message: event.payload.message,
      stack: event.payload.stack,
      path: event.payload.request.path,
      status: event.payload.response.status_code
    });
  }

  if (event.event_type === "log_event") {
    return JSON.stringify({
      event_type: event.event_type,
      level: event.payload.level,
      message: event.payload.message,
      attributes: event.payload.attributes
    });
  }

  if (event.event_type === "request_event") {
    return JSON.stringify({
      event_type: event.event_type,
      method: event.payload.method,
      path: event.payload.path,
      status: event.payload.response_status,
      route_template: event.payload.route_template ?? null
    });
  }

  return null;
}

export function applyNodeCaptureRules(event: EventEnvelope, captureRules: ActiveConfig["captureRules"]): EventEnvelope | null {
  if (captureRules.length === 0) {
    return event;
  }

  const projectId = captureRules[0]?.project_id;
  if (typeof projectId !== "string" || projectId.length === 0) {
    return event;
  }

  try {
    const captureRule = evaluateNodeCaptureRulesForEvent(captureRules, projectId, event, new Date().toISOString());
    if (captureRule?.outcome === "drop" || captureRule?.outcome === "sampled_out") {
      return null;
    }
  } catch {
    return event;
  }

  return event;
}

export function buildNodeSuppressionAggregateEvents(
  suppressionTracker: EventSuppressionTracker,
  config: ActiveConfig
): EventEnvelope[] {
  return suppressionTracker.drainAggregates(Date.now()).map((aggregate) =>
    createEventEnvelope({
      schema_version: SDK_SCHEMA_VERSION,
      event_type: "error_suppressed",
      project_token: config.projectToken,
      sdk_name: SDK_NAME,
      sdk_version: SDK_VERSION,
      service: buildNodeServiceDescriptor(config),
      occurred_at: aggregate.lastSeen,
      payload: {
        fingerprint: aggregate.fingerprint,
        suppressed_count: aggregate.suppressedCount,
        window_seconds: aggregate.windowSeconds,
        first_seen: aggregate.firstSeen,
        last_seen: aggregate.lastSeen
      }
    })
  );
}

export function shouldCaptureNodeSample(sampleRate: number): boolean {
  return sampleRate >= 1 || Math.random() <= sampleRate;
}

export function effectiveNodeLogThreshold(initLogLevel: LogLevel, policyLogLevel: LogLevel): LogLevel {
  return LOG_LEVEL_ORDER[initLogLevel] >= LOG_LEVEL_ORDER[policyLogLevel] ? initLogLevel : policyLogLevel;
}

export function formatNodeConsoleMessage(args: unknown[]): string {
  return args
    .map((arg) => {
      const sanitized = sanitizeUnknown(arg);
      return typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
    })
    .join(" ");
}

export function normalizeNodeRequestPath(value: string | null): string | null {
  if (value === null || value.trim().length === 0) {
    return null;
  }

  try {
    return new URL(value, "http://debugbundle.local").pathname;
  } catch {
    return value.startsWith("/") ? value : `/${value}`;
  }
}

export function buildInternalSdkPaths(config: ActiveConfig): string[] {
  return [config.endpoint, buildSdkConfigEndpoint(config.endpoint)]
    .map((value) => normalizeNodeRequestPath(value))
    .filter((value): value is string => value !== null);
}
