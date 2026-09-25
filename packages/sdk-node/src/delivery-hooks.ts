import type { EventEnvelope } from "@debugbundle/shared-types";
import type { BoundedEventBuffer } from "./buffer-admission.js";
import { applyNodeBeforeSendEvent, applyNodeCaptureRules, shouldCaptureNodeLog, shouldCaptureNodeSample, buildNodeSuppressionKey, normalizeLogLevel } from "./event-support.js";
import { protectNodeEvent } from "./privacy.js";
import { shouldCaptureNodeRequestEvent } from "./request-policy.js";
import type { EventSuppressionTracker } from "./suppression.js";
import type { ActiveConfig, RemoteProbeConfigSnapshot } from "./types.js";

type Diagnostic = (code: string, message: string, metadata?: Record<string, unknown>) => void;

function prepareReplacement(event: EventEnvelope, config: ActiveConfig,
  remote: RemoteProbeConfigSnapshot, diagnostic: Diagnostic): EventEnvelope | null {
  const replacement = applyNodeBeforeSendEvent(event, config.beforeSend, diagnostic);
  if (replacement === null) return null;
  const safe = protectNodeEvent(replacement, config.redactFields);
  if (safe === null) return null;
  if (safe.event_type === "log_event" && !shouldCaptureNodeLog(config, remote.capturePolicy, normalizeLogLevel(safe.payload.level))) return null;
  if (safe.event_type === "request_event" && !shouldCaptureNodeRequestEvent(remote.capturePolicy,
    { method: safe.payload.method, path: safe.payload.path }, { statusCode: safe.payload.response_status })) return null;
  // Original probes already passed directive authentication, including signed
  // request activations independent of global polling. Gate new transformations.
  if (safe.event_type === "probe_event" && event.event_type !== "probe_event" &&
    (!remote.probesEnabled || !remote.remoteProbesEnabled
      || remote.capturePolicy.captureProbeEvents !== "standalone_when_activated")) return null;
  return applyNodeCaptureRules(safe, remote.captureRules, event.occurred_at);
}

/** Finalizes the existing reserved batch in place; no second retained event queue. */
export function finalizeNodeBatch(input: {
  batch: EventEnvelope[];
  buffer: BoundedEventBuffer;
  config: ActiveConfig;
  remote: RemoteProbeConfigSnapshot;
  finalized: WeakSet<EventEnvelope>;
  suppression: EventSuppressionTracker;
  current(): boolean;
  ownership(): { count: number; bytes: number };
  adjustOwnership(count: number, bytes: number): void;
  diagnostic: Diagnostic;
}): void {
  for (let index = 0; index < input.batch.length; index++) {
    if (!input.current()) return;
    const original = input.batch[index]!;
    if (input.finalized.has(original)) continue;
    const originalBytes = input.buffer.eventBytes(original);
    let output = prepareReplacement(original, input.config, input.remote, input.diagnostic);
    if (!input.current()) return;
    if (output !== null && !shouldCaptureNodeSample(input.config.sampleRate)) output = null;
    if (output !== null) {
      const key = buildNodeSuppressionKey(output);
      if (key !== null && !input.suppression.shouldCapture(key, Date.parse(original.occurred_at))) output = null;
    }
    // A hook may dispose/reinitialize the SDK. Never write old ownership into
    // the new generation, and never send the stale event after that callback.
    if (!input.current()) return;
    const held = input.ownership();
    const bytes = output === null ? null : input.buffer.fitDetached(output,
      input.config.maxBufferedEvents - held.count + 1,
      input.config.maxBufferedBytes - held.bytes + originalBytes);
    if (output === null || bytes === null) {
      input.batch.splice(index--, 1);
      input.adjustOwnership(-1, -originalBytes);
    } else {
      input.batch[index] = output;
      input.finalized.add(output);
      input.adjustOwnership(0, bytes - originalBytes);
    }
    // Earlier originals are no longer in the batch before another callback
    // executes. Final payloads stay charged and are reused verbatim on retry.
  }
}
