import { EventEnvelopeSchema, EvidenceReferenceSchema, withoutOptionalExceptionEvidence, type EventEnvelope } from "@debugbundle/shared-types";

export type BrowserBeforeSendHook = (event: EventEnvelope) => EventEnvelope | null;

function cloneEvent(event: EventEnvelope): EventEnvelope {
  return JSON.parse(JSON.stringify(event)) as EventEnvelope;
}

export function applyBrowserBeforeSend(
  event: EventEnvelope,
  beforeSend: BrowserBeforeSendHook | undefined
): EventEnvelope | null {
  if (beforeSend === undefined) {
    return event;
  }

  try {
    const result = beforeSend(cloneEvent(event));
    // Hooks have synchronous return contracts. Contain mistaken async failures
    // before treating their Promise as invalid and keeping the protected original.
    if (result instanceof Promise) {
      void result.catch(() => undefined);
      return event;
    }
    if (result === null) {
      return null;
    }

    if (result === undefined) {
      return event;
    }

    const parsed = parseHookReplacement(result);
    return parsed.success ? parsed.data : event;
  } catch {
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
