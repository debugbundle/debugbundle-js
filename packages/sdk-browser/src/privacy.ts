import { sanitizeTelemetry } from "@debugbundle/redaction";
import { EventEnvelopeSchema, type EventEnvelope } from "@debugbundle/shared-types";

/** Protect captured application data without replacing event or transport identifiers. */
export function protectBrowserEvent(event: EventEnvelope, additionalKeys: readonly string[]): EventEnvelope | null {
  for (const value of [event.schema_version, event.sdk_name, event.sdk_version,
    ...Object.values(event.correlation ?? {})]) {
    if (typeof value !== "string") continue;
    const checked = sanitizeTelemetry(value, { additionalKeys });
    if (!checked.ok || checked.value !== value) return null;
  }
  const result = sanitizeTelemetry({ payload: event.payload, service: event.service, context: event.context ?? {} }, {
    additionalKeys
  });
  if (!result.ok) return null;
  // The root is always an object here; Object() also keeps schema validation fail-closed if that contract changes.
  const protectedFields = Object(result.value) as Record<string, unknown>;
  const parsed = EventEnvelopeSchema.safeParse({
    ...event,
    payload: protectedFields["payload"],
    service: protectedFields["service"],
    ...(event.context === undefined ? {} : { context: protectedFields["context"] })
  });
  return parsed.success ? parsed.data : null;
}
