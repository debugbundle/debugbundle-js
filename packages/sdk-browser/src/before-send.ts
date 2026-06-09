import { EventEnvelopeSchema, type EventEnvelope } from "@debugbundle/shared-types";

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
    if (result === null) {
      return null;
    }

    if (result === undefined) {
      return event;
    }

    const parsed = EventEnvelopeSchema.safeParse(result);
    return parsed.success ? parsed.data : event;
  } catch {
    return event;
  }
}
