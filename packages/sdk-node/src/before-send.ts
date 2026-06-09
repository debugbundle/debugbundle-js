import { EventEnvelopeSchema, type EventEnvelope } from "@debugbundle/shared-types";

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

    const parsed = EventEnvelopeSchema.safeParse(result);
    if (!parsed.success) {
      emitDiagnostic("before_send_invalid_event", "sdk-node beforeSend returned an invalid event");
      return event;
    }

    return parsed.data;
  } catch (caught) {
    emitDiagnostic("before_send_failed", "sdk-node beforeSend hook failed", {
      error: caught instanceof Error ? caught.message : String(caught)
    });
    return event;
  }
}
