import { isPromise } from "node:util/types";
import { EventEnvelopeSchema, EvidenceReferenceSchema, withoutOptionalExceptionEvidence, type EventEnvelope } from "@debugbundle/shared-types";

export type NodeBeforeSendHook = (event: EventEnvelope) => EventEnvelope | null;

type EmitDiagnostic = (code: string, message: string, metadata?: Record<string, unknown>) => void;

function cloneEvent(event: EventEnvelope): EventEnvelope {
  return JSON.parse(JSON.stringify(event)) as EventEnvelope;
}

export function applyNodeBeforeSend(
  event: EventEnvelope,
  beforeSend: NodeBeforeSendHook | undefined,
  emitDiagnostic: EmitDiagnostic
): EventEnvelope | null {
  if (beforeSend === undefined) {
    return event;
  }

  try {
    const result = beforeSend(cloneEvent(event));
    if (result === null) {
      return null;
    }

    if (result === undefined) {
      return event;
    }

    if (isPromise(result)) {
      // Invocation is deferred, but the return contract stays synchronous. Native
      // subscription also handles cross-realm promises without trusting .catch.
      void Promise.prototype.then.call(result, undefined, () => undefined);
      emitDiagnostic("before_send_invalid_event", "sdk-node beforeSend returned an invalid event");
      return event;
    }

    const parsed = parseHookReplacement(result);
    if (!parsed.success) {
      emitDiagnostic("before_send_invalid_event", "sdk-node beforeSend returned an invalid event");
      return event;
    }

    return parsed.data;
  } catch (caught) {
    emitDiagnostic("before_send_failed", "sdk-node beforeSend hook failed", {
      error: caught
    });
    return event;
  }
}

/** Only the shared schema's aggregate byte refinements permit reduction.
 * Malformed graphs, fields and envelopes retain the established invalid fallback. */
function parseHookReplacement(result: EventEnvelope): ReturnType<typeof EventEnvelopeSchema.safeParse> {
  const parsed = EventEnvelopeSchema.safeParse(result);
  if (parsed.success || !parsed.error.issues.every(issue =>
    issue.code === "custom" && [
      "Added exception evidence exceeds its UTF-8 byte budget",
      "Exception evidence exceeds its total UTF-8 JSON byte budget",
      "Resource observations exceed byte budget"
    ].includes(issue.message)
  )) return parsed;
  const reduced = withoutOptionalExceptionEvidence(result, true);
  if (reduced === null) return parsed;
  if (EvidenceReferenceSchema.safeParse(reduced.context?.["evidence_reference"]).success) {
    reduced.context = { ...reduced.context };
    delete reduced.context["evidence_reference"];
  }
  return EventEnvelopeSchema.safeParse(reduced);
}
