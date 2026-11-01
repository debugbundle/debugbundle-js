import { types } from "node:util";
import { createEventEnvelope, DiagnosticContextPayloadSchema, EvidenceReferenceSchema, type EventEnvelope, type EvidenceReference, type EvidenceScope } from "@debugbundle/shared-types";
import { buildNodeCorrelation, buildNodeServiceDescriptor } from "./event-support.js";
import { SDK_NAME, SDK_SCHEMA_VERSION, SDK_VERSION, type ActiveConfig, type CaptureExceptionContext, type CaptureRecoveryInput, type CaptureRequestInput } from "./types.js";
const UNSAFE = Symbol("unsafe-field");
function own(value: unknown, field: string): unknown {
  if (value === null || typeof value !== "object" || types.isProxy(value)) return UNSAFE;
  const descriptor = Object.getOwnPropertyDescriptor(value, field);
  return descriptor === undefined ? undefined : "value" in descriptor ? descriptor.value : UNSAFE;
}
function scope(value: unknown, fallback?: EvidenceScope): unknown {
  if (value === undefined) return fallback;
  const kind = own(value, "kind");
  return kind === "page" ? { kind, page_id: own(value, "page_id") } : kind === "operation" ? { kind, operation_id: own(value, "operation_id") } : null;
}
/** Inspect only explicit local option data, without invoking proxy/accessor code. */
export function nodeEvidenceReference(input: CaptureExceptionContext | CaptureRecoveryInput, fallback?: EvidenceScope): EvidenceReference | null {
  const parsed = EvidenceReferenceSchema.safeParse({ version: 1, failure_ref: own(input, "failureRef"), scope: scope(own(input, "evidenceScope"), fallback) });
  return parsed.success ? parsed.data : null;
}
export function createNodeRecoveryEvent(input: { observation: CaptureRecoveryInput; config: ActiveConfig; defaultScope?: EvidenceScope;
  request: CaptureRequestInput | undefined; fields: Record<string, unknown> }): EventEnvelope | null {
  const reference = nodeEvidenceReference(input.observation, input.defaultScope);
  if (reference === null) return null;
  const optional = (local: string, wire: string): Record<string, unknown> => { const value = own(input.observation, local); return value === undefined ? {} : { [wire]: value }; };
  const parsed = DiagnosticContextPayloadSchema.safeParse({ ...reference, kind: "recovery", attempt_id: own(input.observation, "attemptId"), state: own(input.observation, "state"),
    ...optional("operation", "operation"), ...optional("statusCode", "status_code"), ...optional("durationMs", "duration_ms") });
  if (!parsed.success) return null;
  const rawCorrelation = own(input.observation, "correlation");
  const correlation: Record<string, string | null> = {};
  for (const field of ["request_id", "trace_id", "session_id", "user_id_hash"]) { const value = own(rawCorrelation, field); if (value === null || typeof value === "string") correlation[field] = value; }
  return createEventEnvelope({ schema_version: SDK_SCHEMA_VERSION, event_type: "diagnostic_context", project_token: input.config.projectToken,
    sdk_name: SDK_NAME, sdk_version: SDK_VERSION, service: buildNodeServiceDescriptor(input.config), occurred_at: new Date().toISOString(),
    correlation: buildNodeCorrelation(correlation, input.request, input.fields), payload: parsed.data });
}
