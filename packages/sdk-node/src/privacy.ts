import { sanitizeTelemetry, sanitizeBrowserStackUrls } from "@debugbundle/redaction";
import {
  DiagnosticContextPayloadSchema,
  EventEnvelopeSchema,
  EvidenceReferenceSchema,
  ExceptionEvidenceV1Schema,
  ExecutionContextSchema,
  ResourceObservationsSchema,
  withoutOptionalExceptionEvidence,
  type EventEnvelope
} from "@debugbundle/shared-types";

const MAX_PROTECTED_BYTES = 256 * 1024;
const ALLOWED_HTML_RESOURCE_TAGS = new Set([
  "script",
  "link",
  "img",
  "audio",
  "video",
  "source",
  "iframe",
  "object",
  "embed",
  "input"
]);
const ALLOWED_READY_STATES = new Set(["loading", "interactive", "complete"]);
const ALLOWED_VISIBILITY_STATES = new Set(["visible", "hidden", "prerender", "unloaded"]);
const ALLOWED_REJECTION_KINDS = new Set(["error", "string", "object", "null", "undefined", "unknown"]);
const ALLOWED_EVIDENCE_LIMIT_REASONS = new Set(["budget_exceeded", "unsafe", "unsupported", "unknown"]);
const ALLOWED_EVIDENCE_LIMIT_KEYS = new Set(["version", "exception_evidence", "execution", "resource_observations"]);
const ALLOWED_BROWSER_EVENT_KEYS = new Set([
  "kind",
  "message",
  "file_name",
  "line_number",
  "column_number",
  "target",
  "page",
  "opaque"
]);
const ALLOWED_TARGET_KEYS = new Set(["tag_name", "source_url", "attributes"]);
const ALLOWED_TARGET_ATTR_STRING_KEYS = ["rel", "as", "type", "media", "cross_origin"] as const;
const ALLOWED_TARGET_ATTR_BOOL_KEYS = ["async", "defer", "integrity_present"] as const;
const ALLOWED_TARGET_ATTR_KEYS = new Set<string>([
  ...ALLOWED_TARGET_ATTR_STRING_KEYS,
  ...ALLOWED_TARGET_ATTR_BOOL_KEYS
]);
const ALLOWED_PAGE_KEYS = new Set(["url", "referrer", "ready_state", "visibility_state"]);
const ALLOWED_REJECTION_KEYS = new Set(["kind", "name", "message", "preview"]);

type KeyOptions = {
  additionalKeys: readonly string[];
  exactKeys: readonly string[];
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function readOwnData(record: Record<string, unknown>, key: string): { ok: true; present: boolean; value: unknown } | { ok: false } {
  if (!Object.prototype.hasOwnProperty.call(record, key)) {
    return { ok: true, present: false, value: undefined };
  }
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor)) {
    return { ok: false };
  }
  return { ok: true, present: true, value: descriptor.value };
}

function isPlainDataTree(value: unknown, seen = new WeakSet<object>(), depth = 0): boolean {
  if (value === null || value === undefined || typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object" || depth > 16 || seen.has(value)) {
    return false;
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !isPlainDataTree(descriptor.value, seen, depth + 1)) {
          return false;
        }
      }
      return true;
    }
    if (!isPlainObject(value)) {
      return false;
    }
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor) || !isPlainDataTree(descriptor.value, seen, depth + 1)) {
        return false;
      }
    }
    return true;
  } finally {
    seen.delete(value);
  }
}

function scrubString(value: string, options: KeyOptions): string | null {
  const result = sanitizeTelemetry(value, options);
  return result.ok && typeof result.value === "string" ? result.value : null;
}

function scrubNullableString(value: unknown, options: KeyOptions): { ok: true; value: string | null } | { ok: false } {
  if (value === null) {
    return { ok: true, value: null };
  }
  if (typeof value !== "string") {
    return { ok: false };
  }
  const scrubbed = scrubString(value, options);
  return scrubbed === null ? { ok: false } : { ok: true, value: scrubbed };
}

function hasOnlyAllowedKeys(record: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(record).every((key) => allowed.has(key));
}

function sanitizeBrowserEventBlock(raw: unknown, options: KeyOptions): Record<string, unknown> | null {
  if (!isPlainObject(raw) || !isPlainDataTree(raw) || !hasOnlyAllowedKeys(raw, ALLOWED_BROWSER_EVENT_KEYS)) {
    return null;
  }
  const kind = raw["kind"];
  const opaque = raw["opaque"];
  const lineNumber = raw["line_number"];
  const columnNumber = raw["column_number"];
  if (
    (kind !== "window_error" && kind !== "resource_error") ||
    typeof opaque !== "boolean" ||
    (lineNumber !== null && (typeof lineNumber !== "number" || !Number.isInteger(lineNumber) || lineNumber < 0)) ||
    (columnNumber !== null && (typeof columnNumber !== "number" || !Number.isInteger(columnNumber) || columnNumber < 0))
  ) {
    return null;
  }
  const message = scrubNullableString(raw["message"], options);
  const fileName = scrubNullableString(raw["file_name"], options);
  if (!message.ok || !fileName.ok) {
    return null;
  }

  let targetOut: Record<string, unknown> | null = null;
  const rawTarget = raw["target"];
  if (rawTarget !== null) {
    if (!isPlainObject(rawTarget) || !hasOnlyAllowedKeys(rawTarget, ALLOWED_TARGET_KEYS)) {
      return null;
    }
    let tagNameOut: string | null;
    const rawTagName = rawTarget["tag_name"];
    if (rawTagName === null) {
      tagNameOut = null;
    } else if (typeof rawTagName === "string") {
      if (ALLOWED_HTML_RESOURCE_TAGS.has(rawTagName.toLowerCase())) {
        tagNameOut = rawTagName;
      } else {
        const sanitizedTag = sanitizeTelemetry({ tag_name: rawTagName }, options);
        if (!sanitizedTag.ok || !isPlainObject(sanitizedTag.value) || typeof sanitizedTag.value["tag_name"] !== "string") {
          return null;
        }
        tagNameOut = sanitizedTag.value["tag_name"];
      }
    } else {
      return null;
    }
    const sourceUrl = scrubNullableString(rawTarget["source_url"], options);
    if (!sourceUrl.ok) {
      return null;
    }
    targetOut = {
      tag_name: tagNameOut,
      source_url: sourceUrl.value
    };
    if (Object.prototype.hasOwnProperty.call(rawTarget, "attributes") && rawTarget["attributes"] !== undefined) {
      const rawAttrs = rawTarget["attributes"];
      if (!isPlainObject(rawAttrs) || !hasOnlyAllowedKeys(rawAttrs, ALLOWED_TARGET_ATTR_KEYS)) {
        return null;
      }
      const attrsOut: Record<string, unknown> = {};
      for (const key of ALLOWED_TARGET_ATTR_STRING_KEYS) {
        if (Object.prototype.hasOwnProperty.call(rawAttrs, key) && rawAttrs[key] !== undefined) {
          const attrValue = rawAttrs[key];
          if (typeof attrValue !== "string") return null;
          const scrubbed = scrubString(attrValue, options);
          if (scrubbed === null) return null;
          attrsOut[key] = scrubbed;
        }
      }
      for (const key of ALLOWED_TARGET_ATTR_BOOL_KEYS) {
        if (Object.prototype.hasOwnProperty.call(rawAttrs, key) && rawAttrs[key] !== undefined) {
          if (typeof rawAttrs[key] !== "boolean") return null;
          attrsOut[key] = rawAttrs[key];
        }
      }
      targetOut["attributes"] = attrsOut;
    }
  }

  const out: Record<string, unknown> = {
    kind,
    message: message.value,
    file_name: fileName.value,
    line_number: lineNumber,
    column_number: columnNumber,
    target: targetOut,
    opaque
  };

  if (Object.prototype.hasOwnProperty.call(raw, "page") && raw["page"] !== undefined) {
    const rawPage = raw["page"];
    if (!isPlainObject(rawPage) || !hasOnlyAllowedKeys(rawPage, ALLOWED_PAGE_KEYS)) {
      return null;
    }
    const pageUrl = scrubNullableString(rawPage["url"], options);
    const pageReferrer = scrubNullableString(rawPage["referrer"], options);
    const readyState = rawPage["ready_state"];
    const visibilityState = rawPage["visibility_state"];
    if (
      !pageUrl.ok ||
      !pageReferrer.ok ||
      (readyState !== null && (typeof readyState !== "string" || !ALLOWED_READY_STATES.has(readyState))) ||
      (visibilityState !== null && (typeof visibilityState !== "string" || !ALLOWED_VISIBILITY_STATES.has(visibilityState)))
    ) {
      return null;
    }
    out["page"] = {
      url: pageUrl.value,
      referrer: pageReferrer.value,
      ready_state: readyState,
      visibility_state: visibilityState
    };
  }

  return out;
}

function sanitizeRejectionReasonBlock(raw: unknown, options: KeyOptions): Record<string, unknown> | null {
  if (!isPlainObject(raw) || !isPlainDataTree(raw) || !hasOnlyAllowedKeys(raw, ALLOWED_REJECTION_KEYS)) {
    return null;
  }
  const kind = raw["kind"];
  if (typeof kind !== "string" || !ALLOWED_REJECTION_KINDS.has(kind)) {
    return null;
  }
  const out: Record<string, unknown> = { kind };
  for (const field of ["name", "message", "preview"] as const) {
    if (Object.prototype.hasOwnProperty.call(raw, field) && raw[field] !== undefined) {
      const value = raw[field];
      if (typeof value !== "string") return null;
      const scrubbed = scrubString(value, options);
      if (scrubbed === null) return null;
      out[field] = scrubbed;
    }
  }
  return out;
}

function sanitizeExceptionEvidenceBlock(raw: unknown, options: KeyOptions): Record<string, unknown> | null {
  if (!isPlainObject(raw) || !isPlainDataTree(raw)) {
    return null;
  }
  const parsed = ExceptionEvidenceV1Schema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const nodes: Record<string, unknown>[] = [];
  for (const node of parsed.data.nodes) {
    const name = scrubString(node.name, options);
    const message = scrubString(node.message, options);
    const stack = node.stack === null ? null : scrubString(sanitizeBrowserStackUrls(node.stack), options);
    if (name === null || message === null || (node.stack !== null && stack === null)) {
      return null;
    }
    const frames: Record<string, unknown>[] = [];
    for (const frame of node.frames) {
      const fn = frame.function === null ? null : scrubString(frame.function, options);
      const file = frame.file === null ? null : scrubString(sanitizeBrowserStackUrls(frame.file), options);
      if ((frame.function !== null && fn === null) || (frame.file !== null && file === null)) {
        return null;
      }
      frames.push({
        function: fn,
        file,
        line: frame.line,
        column: frame.column,
        classification: frame.classification
      });
    }
    nodes.push({
      id: node.id,
      name,
      message,
      stack,
      trace_origin: node.trace_origin,
      parsing_status: node.parsing_status,
      frames,
      relationships: node.relationships.map((edge) => ({ kind: edge.kind, target_id: edge.target_id }))
    });
  }
  return {
    version: parsed.data.version,
    runtime: parsed.data.runtime,
    root_id: parsed.data.root_id,
    nodes,
    truncated: parsed.data.truncated,
    unavailable_reason: parsed.data.unavailable_reason
  };
}

function sanitizeResourceObservationsBlock(raw: unknown, options: KeyOptions): Record<string, unknown> | null {
  if (!isPlainObject(raw) || !isPlainDataTree(raw)) {
    return null;
  }
  const parsed = ResourceObservationsSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const items: Record<string, unknown>[] = [];
  for (const item of parsed.data.items) {
    const sourceUrl = item.source_url === null ? null : scrubString(item.source_url, options);
    if (item.source_url !== null && sourceUrl === null) {
      return null;
    }
    if (item.kind === "timing") {
      items.push({
        kind: item.kind,
        observed_at: item.observed_at,
        source_url: sourceUrl,
        availability: item.availability,
        response_status: item.response_status,
        duration_ms: item.duration_ms,
        transfer_size_bytes: item.transfer_size_bytes
      });
    } else {
      items.push({
        kind: item.kind,
        observed_at: item.observed_at,
        source_url: sourceUrl,
        effective_directive: item.effective_directive,
        disposition: item.disposition,
        document_status_code: item.document_status_code
      });
    }
  }
  return { version: parsed.data.version, items };
}

function sanitizeExecutionBlock(raw: unknown, options: KeyOptions): Record<string, unknown> | null {
  if (!isPlainObject(raw) || !isPlainDataTree(raw)) {
    return null;
  }
  const parsed = ExecutionContextSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  const name = parsed.data.name === null ? null : scrubString(parsed.data.name, options);
  if (parsed.data.name !== null && name === null) {
    return null;
  }
  return {
    version: parsed.data.version,
    kind: parsed.data.kind,
    name,
    elapsed_ms: parsed.data.elapsed_ms,
    limit_ms: parsed.data.limit_ms
  };
}

function sanitizeDiagnosticContextPayload(raw: unknown, options: KeyOptions): Record<string, unknown> | null {
  if (!isPlainObject(raw) || !isPlainDataTree(raw)) {
    return null;
  }
  const parsed = DiagnosticContextPayloadSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  if (parsed.data.kind === "recovery") {
    const operation = parsed.data.operation === undefined ? undefined : scrubString(parsed.data.operation, options);
    if (parsed.data.operation !== undefined && operation === null) {
      return null;
    }
    return {
      version: parsed.data.version,
      kind: parsed.data.kind,
      failure_ref: parsed.data.failure_ref,
      scope: parsed.data.scope,
      attempt_id: parsed.data.attempt_id,
      state: parsed.data.state,
      ...(operation === undefined ? {} : { operation }),
      ...(parsed.data.status_code === undefined ? {} : { status_code: parsed.data.status_code }),
      ...(parsed.data.duration_ms === undefined ? {} : { duration_ms: parsed.data.duration_ms })
    };
  }
  const observations = sanitizeResourceObservationsBlock(parsed.data.observations, options);
  if (observations === null) {
    return null;
  }
  return {
    version: parsed.data.version,
    kind: parsed.data.kind,
    failure_ref: parsed.data.failure_ref,
    scope: parsed.data.scope,
    source_event_id: parsed.data.source_event_id,
    observations
  };
}

function isValidEvidenceLimits(raw: unknown): raw is Record<string, unknown> {
  if (!isPlainObject(raw) || !isPlainDataTree(raw) || !hasOnlyAllowedKeys(raw, ALLOWED_EVIDENCE_LIMIT_KEYS)) {
    return false;
  }
  if (raw["version"] !== 1) {
    return false;
  }
  for (const [key, value] of Object.entries(raw)) {
    if (key === "version") continue;
    if (typeof value !== "string" || !ALLOWED_EVIDENCE_LIMIT_REASONS.has(value)) {
      return false;
    }
  }
  return true;
}

function shallowClonePlainOwn(record: Record<string, unknown>): Record<string, unknown> | null {
  const clone: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const entry = readOwnData(record, key);
    if (!entry.ok) return null;
    clone[key] = entry.value;
  }
  return clone;
}

/** Preserve validated closed SDK protocol structures while protecting captured application data (SEC-23a). */
export function protectNodeEvent(
  event: EventEnvelope,
  additionalKeys: readonly string[],
  exactKeys: readonly string[] = []
): EventEnvelope | null {
  const options: KeyOptions = { additionalKeys, exactKeys };
  const fallback = (): EventEnvelope | null => {
    const reduced = withoutOptionalExceptionEvidence(event, true);
    if (reduced === null) return null;
    return (
      protectNodeEvent(reduced, additionalKeys, exactKeys) ??
      protectNodeEvent(withoutOptionalExceptionEvidence(event, false)!, additionalKeys, exactKeys)
    );
  };
  for (const value of [
    event.schema_version,
    event.sdk_name,
    event.sdk_version,
    ...Object.values(event.correlation ?? {})
  ]) {
    if (typeof value !== "string") continue;
    const checked = sanitizeTelemetry(value, options);
    if (!checked.ok || checked.value !== value) return null;
  }

  if (!isPlainObject(event.payload)) {
    return fallback();
  }
  const rawPayload = shallowClonePlainOwn(event.payload as unknown as Record<string, unknown>);
  if (rawPayload === null) {
    return null;
  }

  const preservedPayloadFields: Record<string, unknown> = {};
  let diagnosticPayload: Record<string, unknown> | null = null;

  if (event.event_type === "diagnostic_context") {
    diagnosticPayload = sanitizeDiagnosticContextPayload(rawPayload, options);
    if (diagnosticPayload === null) {
      return null;
    }
  } else {
    if (event.event_type === "frontend_exception") {
      if (Object.prototype.hasOwnProperty.call(rawPayload, "browser_event") && rawPayload["browser_event"] !== undefined) {
        const safeBrowserEvent = sanitizeBrowserEventBlock(rawPayload["browser_event"], options);
        if (safeBrowserEvent !== null) {
          preservedPayloadFields["browser_event"] = safeBrowserEvent;
          delete rawPayload["browser_event"];
        }
      }
      if (Object.prototype.hasOwnProperty.call(rawPayload, "rejection_reason") && rawPayload["rejection_reason"] !== undefined) {
        const safeRejectionReason = sanitizeRejectionReasonBlock(rawPayload["rejection_reason"], options);
        if (safeRejectionReason !== null) {
          preservedPayloadFields["rejection_reason"] = safeRejectionReason;
          delete rawPayload["rejection_reason"];
        }
      }
      if (
        Object.prototype.hasOwnProperty.call(rawPayload, "resource_observations") &&
        rawPayload["resource_observations"] !== undefined
      ) {
        const safeObservations = sanitizeResourceObservationsBlock(rawPayload["resource_observations"], options);
        if (safeObservations !== null) {
          preservedPayloadFields["resource_observations"] = safeObservations;
          delete rawPayload["resource_observations"];
        }
      }
    }
    if (event.event_type === "backend_exception" || event.event_type === "frontend_exception") {
      if (
        Object.prototype.hasOwnProperty.call(rawPayload, "exception_evidence") &&
        rawPayload["exception_evidence"] !== undefined
      ) {
        const safeGraph = sanitizeExceptionEvidenceBlock(rawPayload["exception_evidence"], options);
        if (safeGraph !== null) {
          preservedPayloadFields["exception_evidence"] = safeGraph;
          delete rawPayload["exception_evidence"];
        }
      }
    }
    if (event.event_type === "backend_exception") {
      if (Object.prototype.hasOwnProperty.call(rawPayload, "execution") && rawPayload["execution"] !== undefined) {
        const safeExecution = sanitizeExecutionBlock(rawPayload["execution"], options);
        if (safeExecution !== null) {
          preservedPayloadFields["execution"] = safeExecution;
          delete rawPayload["execution"];
        }
      }
    }
    if (event.event_type === "error_suppressed" && rawPayload["reason"] === "queue_pressure") {
      preservedPayloadFields["reason"] = "queue_pressure";
      delete rawPayload["reason"];
    }
  }

  let rawContext: Record<string, unknown> = {};
  const preservedContextFields: Record<string, unknown> = {};
  if (event.context !== undefined) {
    if (!isPlainObject(event.context)) {
      return fallback();
    }
    const clonedContext = shallowClonePlainOwn(event.context);
    if (clonedContext === null) {
      return null;
    }
    rawContext = clonedContext;
    if (
      Object.prototype.hasOwnProperty.call(rawContext, "evidence_reference") &&
      isPlainDataTree(rawContext["evidence_reference"])
    ) {
      const parsedRef = EvidenceReferenceSchema.safeParse(rawContext["evidence_reference"]);
      if (parsedRef.success) {
        preservedContextFields["evidence_reference"] = parsedRef.data;
        delete rawContext["evidence_reference"];
      }
    }
    if (
      Object.prototype.hasOwnProperty.call(rawContext, "evidence_limits") &&
      isValidEvidenceLimits(rawContext["evidence_limits"])
    ) {
      preservedContextFields["evidence_limits"] = rawContext["evidence_limits"];
      delete rawContext["evidence_limits"];
    }
  }

  const result = sanitizeTelemetry(
    {
      payload: diagnosticPayload === null ? rawPayload : {},
      service: event.service,
      context: rawContext
    },
    options
  );
  if (!result.ok || !isPlainObject(result.value)) return fallback();

  const protectedPayload =
    diagnosticPayload !== null
      ? diagnosticPayload
      : isPlainObject(result.value["payload"])
        ? { ...result.value["payload"], ...preservedPayloadFields }
        : result.value["payload"];
  const protectedContext = isPlainObject(result.value["context"])
    ? { ...result.value["context"], ...preservedContextFields }
    : result.value["context"];

  const assembled = {
    payload: protectedPayload,
    service: result.value["service"],
    ...(event.context === undefined ? {} : { context: protectedContext })
  };
  if (new TextEncoder().encode(JSON.stringify(assembled)).length > MAX_PROTECTED_BYTES) {
    return fallback();
  }

  const parsed = EventEnvelopeSchema.safeParse({
    ...event,
    payload: assembled.payload,
    service: assembled.service,
    ...(event.context === undefined ? {} : { context: assembled.context })
  });
  return parsed.success ? parsed.data : fallback();
}
