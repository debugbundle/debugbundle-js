import { sanitizeTelemetry } from "@debugbundle/redaction";
import { ResourceObservationSchema, SanitizedEvidenceUrlSchema, type DiagnosticCaptureBudget, type DiagnosticContextPayload,
  type EventEnvelope, type EvidenceReference, type ResourceObservation, type ResourceObservations } from "@debugbundle/shared-types";

const WINDOW = 30_000, MAX_BYTES = 32 * 1024;
interface RetainedObservation { observation: ResourceObservation; matchAt: number; seenAt: number; identitySafe: boolean; bytes: number; sequence: number }
export interface PassiveFailure { event_id: string; occurred_at: string; reference: EvidenceReference;
  service: EventEnvelope["service"]; correlation: EventEnvelope["correlation"]; source_url: string; identitySafe: boolean }
const identities = new WeakMap<object, boolean>();
/** Keep a collision flag alongside normalized metadata, never a raw URL/DOM node. */
export function rememberResourceIdentity(metadata: object, raw: string | null): void {
  identities.set(metadata, raw !== null && safeResourceUrl(raw)?.identitySafe === true);
}
export function resourceIdentitySafe(metadata: object): boolean { return identities.get(metadata) ?? true; }
export function safeResourceUrl(raw: unknown): { url: string; identitySafe: boolean } | null {
  if (typeof raw !== "string" || raw.length > 8192) return null;
  try {
    const url = new URL(raw, globalThis.location?.href ?? "https://evidence.invalid");
    const identitySafe = !url.search && !url.hash && !url.username && !url.password;
    url.search = ""; url.hash = ""; url.username = ""; url.password = "";
    const scrub = sanitizeTelemetry(url.href);
    const parsed = scrub.ok ? SanitizedEvidenceUrlSchema.safeParse(scrub.value) : null;
    return parsed?.success ? { url: parsed.data, identitySafe: identitySafe && parsed.data === url.href } : null;
  } catch { return null; }
}
function number(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
/** Invoke only fixed platform prototype getters: own application accessors on
 * native entries/events are never inspected or executed. */
function platformField(value: unknown, type: "PerformanceResourceTiming" | "SecurityPolicyViolationEvent", key: string): unknown {
  const constructor = (globalThis as Record<string, unknown>)[type];
  if (typeof constructor !== "function") return undefined;
  let prototype: object | null = constructor.prototype as object;
  for (let depth = 0; prototype !== null && depth < 4; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
    if (descriptor?.get) { try { return descriptor.get.call(value); } catch { return undefined; } }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return undefined;
}

/** One passive observer and expiry/coalescing timer per page. No historical
 * performance-buffer scan, buffer resize/clear, network request or DOM retention. */
export class PassiveResourceCollector {
  private observations: RetainedObservation[] = [];
  private pending = new Map<string, { source: PassiveFailure; after: number }>();
  private sequence = 0;
  private observer: PerformanceObserver | null = null;
  private listener: ((event: Event) => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private timingSupported = false;
  public constructor(private readonly budget: DiagnosticCaptureBudget,
    private readonly emit: (source: PassiveFailure, payload: DiagnosticContextPayload) => void,
    private readonly now: () => number = Date.now) {}

  public enable(enabled: boolean): void {
    if (enabled === this.active) return;
    this.reset(); if (!enabled) return; this.active = true;
    try {
      if (typeof PerformanceObserver === "function") {
        this.observer = new PerformanceObserver((list) => {
          if (!this.active) return;
          try {
            const entries = PerformanceObserverEntryList.prototype.getEntries.call(list);
            for (let n = 0; n < Math.min(entries.length, 20); n++) this.captureTiming(entries[n]);
          } catch { /* Unavailable native data must not escape the observer callback. */ }
        });
        this.observer.observe({ type: "resource", buffered: false }); this.timingSupported = true;
      }
    } catch { try { this.observer?.disconnect(); } catch { /* Partially initialized observer. */ } this.observer = null; }
    try {
      if (typeof globalThis.addEventListener === "function") {
        this.listener = (event) => { try { this.captureCsp(event); } catch { /* Optional platform evidence. */ } };
        globalThis.addEventListener("securitypolicyviolation", this.listener);
      }
    } catch { this.listener = null; }
  }
  private captureTiming(entry: unknown): void {
    const read = (field: string): unknown => platformField(entry, "PerformanceResourceTiming", field);
    const identity = safeResourceUrl(read("name")); if (identity === null) return;
    const status = number(read("responseStatus"), 599), start = number(read("startTime"));
    const duration = number(read("duration")), transfer = number(read("transferSize"));
    const origin = number(globalThis.performance?.timeOrigin);
    const at = start !== null && origin !== null ? origin + start : this.now();
    this.record({ kind: "timing", observed_at: new Date(this.now()).toISOString(), source_url: identity.url,
      availability: status !== null && status >= 100 ? "observed" : "withheld", response_status: status !== null && status >= 100 ? status : null,
      duration_ms: duration, transfer_size_bytes: transfer === null ? null : Math.floor(transfer) }, at,
      identity.identitySafe && !(number(read("redirectEnd")) ?? 0));
  }
  private captureCsp(event: unknown): void {
    const read = (field: string): unknown => platformField(event, "SecurityPolicyViolationEvent", field);
    const blocked = read("blockedURI");
    // Platform markers such as inline/eval are not relative resource locations.
    if (typeof blocked !== "string" || !/^https?:\/\//i.test(blocked)) return;
    const identity = safeResourceUrl(blocked); if (identity === null) return;
    const status = number(read("statusCode"), 599);
    const parsed = ResourceObservationSchema.safeParse({ kind: "csp", observed_at: new Date(this.now()).toISOString(), source_url: identity.url,
      effective_directive: read("effectiveDirective"), disposition: read("disposition"), document_status_code: status !== null && status >= 100 ? status : null });
    if (parsed.success) this.record(parsed.data, this.now(), identity.identitySafe);
  }
  /** Normalized DTO boundary shared by native adapters and deterministic tests. */
  public record(observation: ResourceObservation, matchAt: number, identitySafe = true): void {
    if (!this.active || !Number.isFinite(matchAt)) return;
    const protectedObservation = sanitizeTelemetry(observation);
    const parsed = protectedObservation.ok ? ResourceObservationSchema.safeParse(protectedObservation.value) : null; if (!parsed?.success) return;
    this.prune();
    const bytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength + 96;
    if (bytes > MAX_BYTES) return;
    this.observations.push({ observation: parsed.data, matchAt, identitySafe, seenAt: this.now(), bytes, sequence: ++this.sequence });
    while (this.observations.length > 20 || this.observations.reduce((sum, value) => sum + value.bytes, 0) > MAX_BYTES) this.observations.shift();
    this.schedule(true);
  }
  public snapshot(sourceUrl: string, at: number, identitySafe = true, sourceId?: string): ResourceObservations {
    this.prune();
    const candidates = this.observations.filter(item => item.observation.source_url === sourceUrl && Math.abs(item.matchAt - at) <= WINDOW);
    const timings = candidates.filter(item => item.observation.kind === "timing");
    const ambiguous = !identitySafe || candidates.some(item => !item.identitySafe) || timings.length > 1 ||
      [...this.pending.values()].some(({ source }) => source.event_id !== sourceId && source.source_url === sourceUrl && Math.abs(Date.parse(source.occurred_at) - at) <= WINDOW);
    const fallback: ResourceObservation = { kind: "timing", observed_at: new Date(this.now()).toISOString(), source_url: sourceUrl,
      availability: ambiguous ? "ambiguous" : this.timingSupported ? "no_match" : "unsupported", response_status: null, duration_ms: null, transfer_size_bytes: null };
    const selected = ambiguous ? [fallback] : [...(timings.length ? timings.map(item => item.observation) : [fallback]),
      ...candidates.filter(item => item.observation.kind === "csp").map(item => item.observation)];
    return { version: 1, items: selected.slice(0, 5) };
  }
  public watch(source: PassiveFailure): void {
    if (!this.active || this.pending.has(source.event_id)) return;
    this.prune();
    const bytes = new TextEncoder().encode(JSON.stringify({ source, after: this.sequence })).byteLength;
    if (this.pending.size >= 50 || !this.budget.retainMetadata(source.event_id, bytes)) return;
    this.pending.set(source.event_id, { source, after: this.sequence }); this.schedule(false);
  }
  private prune(): void {
    const now = this.now(); this.observations = this.observations.filter(item => now >= item.seenAt && now < item.seenAt + WINDOW);
    for (const [id, { source }] of this.pending) if (now < Date.parse(source.occurred_at) || now >= Date.parse(source.occurred_at) + WINDOW) {
      this.pending.delete(id); this.budget.releaseMetadata(id);
    }
  }
  private schedule(immediate: boolean): void {
    if (this.timer !== null) clearTimeout(this.timer);
    if (!this.active || this.observations.length === 0 && this.pending.size === 0) { this.timer = null; return; }
    const expiry = Math.min(...this.observations.map(item => item.seenAt + WINDOW), ...[...this.pending.values()].map(({ source }) => Date.parse(source.occurred_at) + WINDOW));
    this.timer = setTimeout(() => {
      this.timer = null; this.prune();
      for (const [id, { source, after }] of this.pending) {
        if (!this.observations.some(item => item.sequence > after && item.observation.source_url === source.source_url && Math.abs(item.matchAt - Date.parse(source.occurred_at)) <= WINDOW)) continue;
        const observations = this.snapshot(source.source_url, Date.parse(source.occurred_at), source.identitySafe, source.event_id);
        this.pending.delete(id); this.budget.releaseMetadata(id);
        try { this.emit(source, { ...source.reference, kind: "resource_observation", source_event_id: id, observations }); }
        catch { /* An unavailable optional DTO must not escape the timer callback. */ }
      }
      this.schedule(false);
    }, immediate ? 0 : Math.max(1, expiry - this.now()));
  }
  public reset(): void {
    this.active = false; this.timingSupported = false;
    try { this.observer?.disconnect(); } catch { /* Teardown remains best effort. */ }
    this.observer = null;
    try { if (this.listener !== null) globalThis.removeEventListener?.("securitypolicyviolation", this.listener); } catch { /* Host teardown cannot escape. */ }
    this.listener = null; if (this.timer !== null) clearTimeout(this.timer); this.timer = null;
    for (const id of this.pending.keys()) this.budget.releaseMetadata(id);
    this.pending.clear(); this.observations = []; this.sequence = 0;
  }
}
