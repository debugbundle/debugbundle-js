import { EvidenceCapabilityValues, EvidenceDeliveryState, EVENT_ENVELOPE_MAX_WIRE_BYTES, fitEventToIngestionWire, intersectEvidenceCapabilities, stripUnsupportedEvidence, type EvidenceCapabilities, type EventEnvelope } from "@debugbundle/shared-types";
import { performance } from "node:perf_hooks";
import { decideIngestionAcknowledgement } from "./ingestion-acknowledgement.js";
import { observeNodeEvidenceResponse } from "./evidence-delivery.js";
import { evidenceDiscoveryEndpoint } from "./remote-config-client.js";
import type { BrowserRelayEvent } from "./relay-schemas.js";
import type { DebugBundleTransport, DebugBundleTransportResponse } from "./types.js";
import { requiresIngestionAcknowledgement } from "./utils.js";
import { nodeWireBatches } from "./wire-batch.js";

interface ForwardInput { events: BrowserRelayEvent[]; transport: DebugBundleTransport; endpoint: string; projectToken: string; discover: boolean }
interface ForwardResult { succeeded: boolean; complete: boolean }

const RELAY_SUPPORT: EvidenceCapabilities = { version: 1, features: [...EvidenceCapabilityValues] };
/** A relay never infers downstream capability from its own parser version. */
export class RelayEvidencePath {
  private readonly downstream: EvidenceDeliveryState;
  public constructor(pin?: unknown) { this.downstream = new EvidenceDeliveryState(pin); }
  public get descriptor(): EvidenceCapabilities { return intersectEvidenceCapabilities([RELAY_SUPPORT, this.downstream.descriptor]); }
  public prepare(event: BrowserRelayEvent): BrowserRelayEvent | null {
    return event.event_type === "analytics_event" ? event : stripUnsupportedEvidence(event as EventEnvelope, this.descriptor) as BrowserRelayEvent | null;
  }

  public prepareForward(event: BrowserRelayEvent, projectToken: string): BrowserRelayEvent | null {
    const owned = { ...event, project_token: projectToken };
    if (event.event_type === "analytics_event") return Buffer.byteLength(JSON.stringify(owned)) <= EVENT_ENVELOPE_MAX_WIRE_BYTES ? event : null;
    const fitted = fitEventToIngestionWire(owned as EventEnvelope);
    if (fitted === null) return null;
    // Server credentials belong only to forwarding, never to onAccept callbacks.
    const projected = { ...fitted };
    delete projected.project_token;
    return projected as BrowserRelayEvent;
  }

  public async forward(input: ForwardInput): Promise<ForwardResult> {
    const deadline = performance.now() + 5000;
    let complete = true, proof: EvidenceCapabilities | undefined;
    const owned = input.events.map(event => ({ ...event, project_token: input.projectToken }));
    for (const chunk of nodeWireBatches(owned)) {
      const events: BrowserRelayEvent[] = [];
      for (const event of chunk) {
        const prepared = this.prepare(event);
        if (prepared === null) return { succeeded: false, complete: false };
        events.push(prepared);
      }
      const result = await this.forwardChunk({ ...input, events }, deadline);
      proof = proof === undefined ? this.descriptor : intersectEvidenceCapabilities([proof, this.descriptor]);
      this.downstream.observe(proof);
      if (!result.succeeded) return { succeeded: false, complete: false };
      complete &&= result.complete;
    }
    return { succeeded: true, complete };
  }

  private async forwardChunk(input: ForwardInput, deadline: number): Promise<ForwardResult> {
    const required = input.discover || requiresIngestionAcknowledgement(input.transport);
    const send = async (events: BrowserRelayEvent[]): Promise<DebugBundleTransportResponse | null> => {
      const remaining = Math.ceil(deadline - performance.now());
      if (remaining <= 0) return null;
      return input.transport({ endpoint: input.discover ? evidenceDiscoveryEndpoint(input.endpoint) : input.endpoint,
        headers: {}, events: events.map(event => ({ ...event, project_token: input.projectToken })) as EventEnvelope[], timeout_ms: remaining });
    };
    const response = await send(input.events);
    if (response === null || response.status < 200 || response.status >= 300) return { succeeded: false, complete: false };
    const ack = decideIngestionAcknowledgement(response.body, input.events.length, required);
    const lost = observeNodeEvidenceResponse(this.downstream, response.body, required, ack.kind === "acknowledged");
    if (ack.kind === "legacy") return { succeeded: true, complete: false };
    if (ack.kind === "protocol_failure") return { succeeded: false, complete: false };
    if (ack.accepted === input.events.length) return { succeeded: true, complete: true };
    if (!lost) return { succeeded: false, complete: false };
    const retry: BrowserRelayEvent[] = [];
    for (const error of ack.terminalErrors) {
      const original = input.events[error.index];
      if (error.reason !== "invalid_event" || !original || original.event_type !== "frontend_exception") continue;
      const stripped = this.prepare(original); if (stripped !== null && stripped !== original) retry.push(stripped);
    }
    if (retry.length === 0) return { succeeded: false, complete: false };
    const retried = await send(retry);
    if (retried === null || retried.status < 200 || retried.status >= 300) return { succeeded: false, complete: false };
    const retryAck = decideIngestionAcknowledgement(retried.body, retry.length, true);
    observeNodeEvidenceResponse(this.downstream, retried.body, required, retryAck.kind === "acknowledged");
    const complete = retryAck.kind === "acknowledged" && ack.accepted + retryAck.accepted === input.events.length;
    return { succeeded: complete, complete };
  }
}
export function requestsRelayEvidence(url: string | undefined, headers: Record<string, string>): boolean {
  if (headers["x-debugbundle-evidence"] === "1") return true;
  try { return new URL(url ?? "", "https://relay.invalid").searchParams.get("debugbundle_evidence") === "1"; } catch { return false; }
}
