import { DiagnosticCaptureBudget, DiagnosticContextPayloadSchema, EvidenceDeliveryState, EvidenceReferenceSchema, EvidenceReferenceIdSchema, stripUnsupportedEvidence,
  type DiagnosticContextPayload, type EventEnvelope, type EvidenceReference } from "@debugbundle/shared-types";
import { protectBrowserEvent } from "./privacy.js";
import { PassiveResourceCollector, resourceIdentitySafe, safeResourceUrl, type PassiveFailure } from "./passive-resources.js";
import type { ActiveConfig, BrowserRemoteProbeState, CaptureBrowserExceptionContext, CaptureBrowserRecoveryInput } from "./types.js";

export function browserEvidenceEndpoint(endpoint: string): string {
  const hashAt = endpoint.indexOf("#"), clean = hashAt < 0 ? endpoint : endpoint.slice(0, hashAt);
  return `${clean}${clean.includes("?") ? "&" : "?"}debugbundle_evidence=1`;
}
function own(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function secureUuid(): string {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
/** Per destination state; no native error or DOM objects are retained here. */
export class BrowserEvidenceController {
  public proof = new EvidenceDeliveryState();
  private readonly budget = new DiagnosticCaptureBudget();
  private readonly identities = new WeakMap<EventEnvelope, boolean>();
  private config: ActiveConfig | null = null;
  private policy: BrowserRemoteProbeState | null = null;
  private late: ((source: PassiveFailure, payload: DiagnosticContextPayload) => EventEnvelope | null) | null = null;
  private enqueue: ((event: EventEnvelope) => void) | null = null;
  private readonly resources = new PassiveResourceCollector(this.budget, (source, payload) => {
    const config = this.config, policy = this.policy;
    if (config === null || policy === null || !this.allowedResources(config, policy)) return;
    try {
      const raw = this.late?.(source, payload), event = raw ? protectBrowserEvent(raw, config.redactFields) : null;
      if (event?.event_type === "diagnostic_context" && this.budget.reserve(event.event_id, event.payload, this.bytes(event), Date.now())) this.enqueue?.(event);
    } catch { /* Optional passive context cannot escape a platform callback. */ }
  });
  private pageId: string | null = null;
  public configure(config: unknown): void {
    this.reset(); this.proof = new EvidenceDeliveryState(own(config, "evidenceCapabilities"));
  }
  public setLateCapture(create: (source: PassiveFailure, payload: DiagnosticContextPayload) => EventEnvelope | null, enqueue: (event: EventEnvelope) => void): void {
    this.late = create; this.enqueue = enqueue;
  }
  public reset(): void { this.resources.reset(); this.proof = new EvidenceDeliveryState(); this.budget.clear(); this.pageId = null;
    this.config = null; this.policy = null; this.late = null; this.enqueue = null; }
  public update(config: ActiveConfig | null, policy: BrowserRemoteProbeState): void {
    this.config = config; this.policy = policy; this.resources.enable(config !== null && this.allowedResources(config, policy));
  }
  public observe(payload: unknown, required: boolean, valid = true): boolean {
    const supplied = payload !== null && typeof payload === "object" && Object.prototype.hasOwnProperty.call(payload, "evidence_capabilities");
    const changed = required || supplied ? this.proof.observe(valid ? own(payload, "evidence_capabilities") : undefined) : false;
    if (this.policy !== null) this.update(this.config, this.policy);
    return changed;
  }
  public reference(input: unknown): EvidenceReference | null {
    const failure = EvidenceReferenceIdSchema.safeParse(own(input, "failureRef")); if (!failure.success) return null;
    let scope = own(input, "evidenceScope");
    if (scope === undefined) {
      try { this.pageId ??= secureUuid(); } catch { return null; }
      scope = { kind: "page", page_id: this.pageId };
    }
    const parsed = EvidenceReferenceSchema.safeParse({ version: 1, failure_ref: failure.data, scope });
    return parsed.success ? parsed.data : null;
  }
  private allowed(config: ActiveConfig, policy: BrowserRemoteProbeState): boolean {
    return config.captureRecoveryObservations === true && this.proof.supports("recovery_v1") &&
      policy.requestFailurePreset !== "minimal" && policy.captureDiagnosticContext !== false;
  }
  private allowedResources(config: ActiveConfig, policy: BrowserRemoteProbeState): boolean {
    return config.captureResourceObservations !== false && this.proof.supports("resource_observations_v1") &&
      policy.requestFailurePreset !== "minimal" && policy.captureDiagnosticContext !== false;
  }
  public inheritIdentity(original: EventEnvelope, event: EventEnvelope): void {
    const before = original.event_type === "frontend_exception" ? original.payload.browser_event?.target?.source_url : null;
    const after = event.event_type === "frontend_exception" ? event.payload.browser_event?.target?.source_url : null;
    this.identities.set(event, before === after && this.identities.get(original) === true);
  }
  public prepareException(event: EventEnvelope, context: CaptureBrowserExceptionContext, config: ActiveConfig, policy: BrowserRemoteProbeState): void {
    this.update(config, policy);
    if (event.event_type !== "frontend_exception" || !this.allowedResources(config, policy) || event.payload.browser_event?.kind !== "resource_error") return;
    const target = context.browser_event?.target, url = safeResourceUrl(event.payload.browser_event.target?.source_url);
    if (url === null) return;
    let reference = this.reference(context);
    if (reference === null) {
      try { reference = this.reference({ failureRef: secureUuid() }); } catch { /* No insecure fallback. */ }
    }
    if (reference === null) return;
    const identitySafe = url.identitySafe && target !== null && target !== undefined && resourceIdentitySafe(target);
    this.identities.set(event, identitySafe);
    event.context = { ...event.context, evidence_reference: reference };
    event.payload.resource_observations = this.resources.snapshot(url.url, Date.parse(event.occurred_at), identitySafe, event.event_id);
  }
  public captureRecovery(input: CaptureBrowserRecoveryInput, config: ActiveConfig, policy: BrowserRemoteProbeState,
    create: (payload: DiagnosticContextPayload) => EventEnvelope, enqueue: (event: EventEnvelope) => void): void {
    if (!this.allowed(config, policy)) return;
    const reference = this.reference(input); if (reference === null) return;
    const optional = (local: string, wire: string): Record<string, unknown> => { const value = own(input, local); return value === undefined ? {} : { [wire]: value }; };
    const parsed = DiagnosticContextPayloadSchema.safeParse({ ...reference, kind: "recovery", attempt_id: own(input, "attemptId"), state: own(input, "state"),
      ...optional("operation", "operation"), ...optional("statusCode", "status_code"), ...optional("durationMs", "duration_ms") });
    if (!parsed.success) return;
    const event = protectBrowserEvent(create(parsed.data), config.redactFields);
    if (event?.event_type !== "diagnostic_context" || !this.budget.reserve(event.event_id, event.payload, this.bytes(event), Date.now())) return;
    enqueue(event);
  }
  public release(event: EventEnvelope): void { if (event.event_type === "diagnostic_context") this.budget.release([event.event_id]); }
  public reconcile(original: EventEnvelope, replacement: EventEnvelope | null, config: ActiveConfig | null, policy: BrowserRemoteProbeState): EventEnvelope | null {
    this.update(config, policy);
    const event = replacement === null ? null : stripUnsupportedEvidence(replacement, this.proof.descriptor);
    if (event?.event_type === "diagnostic_context") {
      if (config === null || !(event.payload.kind === "recovery" ? this.allowed(config, policy) : this.allowedResources(config, policy)) ||
        !(original.event_type === "diagnostic_context" ? this.budget.replace(original.event_id, event.event_id, event.payload, this.bytes(event), Date.now())
          : this.budget.reserve(event.event_id, event.payload, this.bytes(event), Date.now()))) {
        this.release(original); return null;
      }
    } else {
      this.release(original);
      const reference = EvidenceReferenceSchema.safeParse(event?.context?.["evidence_reference"]);
      if (event !== null && reference.success && this.budget.registerFailure(reference.data, event.event_id, Date.parse(event.occurred_at))) {
        this.inheritIdentity(original, event);
        const url = event.event_type === "frontend_exception" && event.payload.browser_event?.kind === "resource_error" ? safeResourceUrl(event.payload.browser_event.target?.source_url) : null;
        if (config !== null && url !== null && this.allowedResources(config, policy)) this.resources.watch({ event_id: event.event_id, occurred_at: event.occurred_at,
          reference: reference.data, service: event.service, correlation: event.correlation, source_url: url.url, identitySafe: this.identities.get(event) === true });
      }
    }
    return event;
  }
  private bytes(event: EventEnvelope): number { return new TextEncoder().encode(JSON.stringify(event)).byteLength; }
}
