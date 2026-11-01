import { EvidenceReferenceSchema, stripUnsupportedEvidence, type DiagnosticCaptureBudget, type EventEnvelope, type EvidenceDeliveryState } from "@debugbundle/shared-types";
import type { BoundedEventBuffer } from "./buffer-admission.js";
import type { ActiveConfig, RemoteProbeConfigSnapshot } from "./types.js";

export function allowsNodeRecovery(config: ActiveConfig, remote: RemoteProbeConfigSnapshot, evidence: EvidenceDeliveryState): boolean {
  return config.captureRecoveryObservations === true && evidence.supports("recovery_v1") &&
    remote.capturePolicy.preset !== "minimal" && remote.capturePolicy.captureDiagnosticContext !== false;
}
/** Reconcile after hooks and on every retry. Hooks retain their canonical ability
 * to change identity or type; the new protected event owns the bounded receipt. */
export function reconcileNodeDiagnostic(input: { original: EventEnvelope; replacement: EventEnvelope | null;
  config: ActiveConfig; remote: RemoteProbeConfigSnapshot; evidence: EvidenceDeliveryState;
  budget: DiagnosticCaptureBudget; buffer: BoundedEventBuffer }): EventEnvelope | null {
  const { original, replacement, budget } = input;
  if (replacement?.event_type === "diagnostic_context") {
    if (replacement.payload.kind !== "recovery" || !allowsNodeRecovery(input.config, input.remote, input.evidence) ||
      !(original.event_type === "diagnostic_context"
        ? budget.replace(original.event_id, replacement.event_id, replacement.payload, input.buffer.eventBytes(replacement), Date.now())
        : budget.reserve(replacement.event_id, replacement.payload, input.buffer.eventBytes(replacement), Date.now()))) {
      if (original.event_type === "diagnostic_context") budget.release([original.event_id]);
      return null;
    }
  } else {
    if (original.event_type === "diagnostic_context") budget.release([original.event_id]);
    if (replacement !== null) {
      const reference = EvidenceReferenceSchema.safeParse(replacement.context?.["evidence_reference"]);
      if (reference.success) budget.registerFailure(reference.data, replacement.event_id, Date.parse(replacement.occurred_at));
    }
  }
  return replacement;
}

export function observeNodeEvidenceResponse(state: EvidenceDeliveryState, body: unknown, required: boolean, valid = true): boolean {
  const record = body !== null && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  return required || Object.prototype.hasOwnProperty.call(record, "evidence_capabilities") ? state.observe(valid ? record["evidence_capabilities"] : undefined) : false;
}
export function finalizeNodeEvidenceBatch(input: { batch: EventEnvelope[]; buffer: BoundedEventBuffer; evidence: EvidenceDeliveryState;
  finalized: WeakSet<EventEnvelope>; reconcile(original: EventEnvelope, replacement: EventEnvelope | null): EventEnvelope | null;
  adjustOwnership(count: number, bytes: number): void;
  wireEvent?(event: EventEnvelope): EventEnvelope | null }): void {
  for (let index = 0; index < input.batch.length; index++) {
    const original = input.batch[index]!, stripped = stripUnsupportedEvidence(original, input.evidence.descriptor);
    const replacement = input.reconcile(original, stripped !== null && input.wireEvent ? input.wireEvent(stripped) : stripped);
    const bytes = input.buffer.eventBytes(original);
    if (replacement === null) { input.batch.splice(index--, 1); input.adjustOwnership(-1, -bytes); }
    else if (replacement !== original) {
      input.batch[index] = replacement; input.finalized.add(replacement);
      input.adjustOwnership(0, input.buffer.eventBytes(replacement) - bytes);
    }
  }
}
/** A canonical rejection after negotiated loss of support may retry only the
 * stripped original. Policy/security rejections and standalone context never do. */
export function downgradeRejectedNodeErrors(batch: EventEnvelope[], errors: Array<{ index: number; reason: string }>, state: EvidenceDeliveryState): EventEnvelope[] {
  const result: EventEnvelope[] = [];
  for (const error of errors) {
    const original = batch[error.index];
    if (error.reason !== "invalid_event" || !original || (original.event_type !== "backend_exception" && original.event_type !== "frontend_exception")) continue;
    const reduced = stripUnsupportedEvidence(original, state.descriptor);
    if (reduced !== null && reduced !== original) result.push(reduced);
  }
  return result;
}
