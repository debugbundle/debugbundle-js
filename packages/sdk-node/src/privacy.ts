import { sanitizeTelemetry, sanitizeBrowserStackUrls } from "@debugbundle/redaction";
import { EventEnvelopeSchema, withoutOptionalExceptionEvidence, type EventEnvelope } from "@debugbundle/shared-types";

/** Preserve protocol identifiers and transport auth while protecting captured application data. */
export function protectNodeEvent(event: EventEnvelope, additionalKeys: readonly string[]): EventEnvelope | null {
  const fallback = (): EventEnvelope | null => {
    const reduced = withoutOptionalExceptionEvidence(event, true);
    if (reduced === null) return null;
    return protectNodeEvent(reduced, additionalKeys) ?? protectNodeEvent(withoutOptionalExceptionEvidence(event, false)!, additionalKeys);
  };
  for (const value of [event.schema_version, event.sdk_name, event.sdk_version,
    ...Object.values(event.correlation ?? {})]) {
    if (typeof value !== "string") continue;
    const checked = sanitizeTelemetry(value, { additionalKeys });
    if (!checked.ok || checked.value !== value) return null;
  }
  const graph = (event.event_type === "backend_exception" || event.event_type === "frontend_exception") ? event.payload.exception_evidence : undefined;
  const payload = graph === undefined ? event.payload : { ...event.payload, exception_evidence: { ...graph, nodes: graph.nodes.map((node) => ({ ...node,
    stack: node.stack === null ? null : sanitizeBrowserStackUrls(node.stack), frames: node.frames.map((frame) => ({ ...frame, file: frame.file === null ? null : sanitizeBrowserStackUrls(frame.file) })) })) } };
  const result = sanitizeTelemetry({ payload, service: event.service, context: event.context ?? {} }, {
    additionalKeys
  });
  if (!result.ok) return fallback();
  // The root is always an object here; Object() also keeps schema validation fail-closed if that contract changes.
  const protectedFields = Object(result.value) as Record<string, unknown>;
  const parsed = EventEnvelopeSchema.safeParse({
    ...event,
    payload: protectedFields["payload"],
    service: protectedFields["service"],
    ...(event.context === undefined ? {} : { context: protectedFields["context"] })
  });
  return parsed.success ? parsed.data : fallback();
}
