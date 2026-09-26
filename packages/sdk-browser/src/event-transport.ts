import { getNavigatorSource } from "./runtime.js";
import { boundedRetryAfterMs, boundedTransportTimeoutMs, buildBrowserTransportRequestBody, parseRetryAfter } from "./fetch-transport.js";
import { decideBrowserAcknowledgement } from "./ingestion-acknowledgement.js";
import { createBrowserSuppressionEvent } from "./suppression.js";
import type {
  ActiveConfig,
  BrowserAnalyticsEventEnvelope,
  DebugBundleBrowserTransportEvent
} from "./types.js";

export type BrowserTransportLaneName = "debug" | "analytics";

interface BrowserTransportLane {
  events: DebugBundleBrowserTransportEvent[];
  prepared: WeakSet<DebugBundleBrowserTransportEvent>;
  preparing: boolean;
  preparationTimer: ReturnType<typeof setTimeout> | null;
  inFlightEvents: Map<DebugBundleBrowserTransportEvent, number>;
  beaconCommitted: boolean;
  keepalivePending: boolean;
  keepalivePromise: Promise<void> | null;
  detachedCount: number;
  detachedBytes: number;
  queuedBytes: number;
  sizes: WeakMap<DebugBundleBrowserTransportEvent, number>;
  flushPromise: Promise<void> | null;
  flushScheduled: boolean;
  flushRequestedDuringSend: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  nextRetryAt: number | null;
  consecutiveFailures: number;
  rejected: boolean;
  lastEventAt: number | null;
  pressureCount: number;
  pressureFirstAt: number | null;
  pressureLastAt: number | null;
  lastPressureReportAt: number | null;
  queueVersion: number;
  evictableVersion: number;
  evictableMask: number;
}

interface BrowserEventTransportCallbacks {
  beforeDebugFlush?(): void;
  prepareDebugEvent?(event: DebugBundleBrowserTransportEvent): DebugBundleBrowserTransportEvent | null;
  onDebugResponse(payload: unknown): void;
  onUnauthorized(
    lane: BrowserTransportLaneName,
    statusCode: 401 | 403,
    endpoint: string,
    body: unknown
  ): void;
  onAcknowledgementDiagnostic(
    lane: BrowserTransportLaneName,
    code: "invalid" | "terminal_rejection",
    detail: string
  ): void;
}

function createLane(): BrowserTransportLane {
  return {
    events: [],
    prepared: new WeakSet(),
    preparing: false,
    preparationTimer: null,
    inFlightEvents: new Map(),
    beaconCommitted: false,
    keepalivePending: false,
    keepalivePromise: null,
    detachedCount: 0,
    detachedBytes: 0,
    queuedBytes: 0,
    sizes: new WeakMap(),
    flushPromise: null,
    flushScheduled: false,
    flushRequestedDuringSend: false,
    timer: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
    rejected: false,
    lastEventAt: null,
    pressureCount: 0,
    pressureFirstAt: null,
    pressureLastAt: null,
    lastPressureReportAt: null,
    queueVersion: 0,
    evictableVersion: -1,
    evictableMask: 0
  };
}

const MAX_DEBUG_QUEUED_EVENTS = 512;
const MAX_ANALYTICS_QUEUED_EVENTS = 256;
const MAX_DEBUG_QUEUED_BYTES = 8 * 1024 * 1024;
const MAX_ANALYTICS_QUEUED_BYTES = 4 * 1024 * 1024;
// One instance shares this budget across both lanes and outstanding requests.
const MAX_UNLOAD_BODY_BYTES = 60 * 1024;
const PRESSURE_REPORT_INTERVAL_MS = 30_000;

function recordDebugPressure(lane: BrowserTransportLane): void {
  const now = Date.now();
  lane.pressureCount = Math.min(Number.MAX_SAFE_INTEGER, lane.pressureCount + 1);
  lane.pressureFirstAt ??= now;
  lane.pressureLastAt = now;
}

function recordDebugDrop(lane: BrowserTransportLane, event: DebugBundleBrowserTransportEvent): void {
  if (event.event_type !== "error_suppressed" || event.payload.fingerprint !== "browser-queue-pressure") {
    recordDebugPressure(lane);
    return;
  }
  const count = event.payload.suppressed_count;
  const first = Date.parse(event.payload.first_seen);
  const last = Date.parse(event.payload.last_seen);
  if (!Number.isSafeInteger(count) || count <= 0 || !Number.isFinite(first) || !Number.isFinite(last)) return;
  lane.pressureCount = Math.min(Number.MAX_SAFE_INTEGER, lane.pressureCount + count);
  lane.pressureFirstAt = lane.pressureFirstAt === null ? first : Math.min(lane.pressureFirstAt, first);
  lane.pressureLastAt = lane.pressureLastAt === null ? last : Math.max(lane.pressureLastAt, last);
  // This report never reached the sender; its previous 30-second slot is still available.
  lane.lastPressureReportAt = null;
}

function invalidateAdmission(lane: BrowserTransportLane): void {
  lane.queueVersion = (lane.queueVersion + 1) % 1_000_000_000;
}

function hasEvictableEvent(lane: BrowserTransportLane, maxPriority: number): boolean {
  if (lane.evictableVersion !== lane.queueVersion) {
    lane.evictableMask = 0;
    for (const candidate of lane.events) {
      if (!lane.inFlightEvents.has(candidate)) lane.evictableMask |= 1 << eventPriority(candidate);
    }
    lane.evictableVersion = lane.queueVersion;
  }
  return (lane.evictableMask & ((1 << (maxPriority + 1)) - 1)) !== 0;
}

function capturePriority(kind: DebugBundleBrowserTransportEvent["event_type"], level?: string, status?: number): number {
  if (kind === "frontend_exception" || kind === "backend_exception") return 3;
  if (kind === "error_suppressed") return 2;
  if (kind === "log_event") return level === "error" || level === "critical" ? 2 : 0;
  if (kind === "request_event" && status !== undefined && status >= 400) return 2;
  return 1;
}

function eventPriority(event: DebugBundleBrowserTransportEvent): number {
  return capturePriority(event.event_type,
    event.event_type === "log_event" ? event.payload.level : undefined,
    event.event_type === "request_event" ? event.payload.response_status : undefined);
}

function eventBytes(lane: BrowserTransportLane, event: DebugBundleBrowserTransportEvent): number | null {
  const cached = lane.sizes.get(event);
  if (cached !== undefined) return cached;
  try {
    const json = JSON.stringify(event);
    if (json === undefined) return null;
    const bytes = new TextEncoder().encode(json).byteLength;
    lane.sizes.set(event, bytes);
    return bytes;
  } catch {
    return null;
  }
}

function retainSend(lane: BrowserTransportLane, events: readonly DebugBundleBrowserTransportEvent[]): void {
  for (const event of events) {
    lane.inFlightEvents.set(event, (lane.inFlightEvents.get(event) ?? 0) + 1);
  }
  invalidateAdmission(lane);
}

function releaseSend(lane: BrowserTransportLane, events: readonly DebugBundleBrowserTransportEvent[]): void {
  for (const event of events) {
    const retained = lane.inFlightEvents.get(event) ?? 0;
    if (retained <= 1) lane.inFlightEvents.delete(event);
    else lane.inFlightEvents.set(event, retained - 1);
  }
  updateDetachedRetention(lane);
  invalidateAdmission(lane);
}

/** Acknowledged records remain charged while another sender still owns them. */
function updateDetachedRetention(lane: BrowserTransportLane): void {
  const queued = new Set(lane.events);
  lane.detachedCount = 0;
  lane.detachedBytes = 0;
  for (const event of lane.inFlightEvents.keys()) {
    if (queued.has(event)) continue;
    lane.detachedCount += 1;
    lane.detachedBytes += lane.sizes.get(event) ?? 0;
  }
}

function admitEvent(
  lane: BrowserTransportLane,
  event: DebugBundleBrowserTransportEvent,
  limit: number,
  maxBytes: number,
  preferRetained = false,
  onDrop?: (dropped: DebugBundleBrowserTransportEvent) => void
): boolean {
  const incomingPriority = eventPriority(event);
  const allowEqualPriorityEviction = !preferRetained && incomingPriority < 2;
  const maxVictimPriority = incomingPriority - (allowEqualPriorityEviction ? 0 : 1);
  if (lane.events.length + lane.detachedCount >= limit && !hasEvictableEvent(lane, maxVictimPriority)) {
    onDrop?.(event);
    return false;
  }
  const bytes = eventBytes(lane, event);
  if (bytes === null || bytes > maxBytes) {
    onDrop?.(event);
    return false;
  }
  if (lane.queuedBytes + lane.detachedBytes + bytes > maxBytes && !hasEvictableEvent(lane, maxVictimPriority)) {
    onDrop?.(event);
    return false;
  }

  while (lane.events.length + lane.detachedCount >= limit || lane.queuedBytes + lane.detachedBytes + bytes > maxBytes) {
    let victimIndex = -1;
    let victimPriority = incomingPriority;
    for (let index = 0; index < lane.events.length; index += 1) {
      if (lane.inFlightEvents.has(lane.events[index]!)) continue;
      const priority = eventPriority(lane.events[index]!);
      if (priority < victimPriority || (allowEqualPriorityEviction && priority === victimPriority && victimIndex < 0)) {
        victimIndex = index;
        victimPriority = priority;
      }
    }
    if (victimIndex < 0) {
      onDrop?.(event);
      return false;
    }
    const [victim] = lane.events.splice(victimIndex, 1);
    if (victim !== undefined) {
      lane.queuedBytes -= lane.sizes.get(victim) ?? 0;
      invalidateAdmission(lane);
      onDrop?.(victim);
    }
  }
  lane.events.push(event);
  lane.queuedBytes += bytes;
  invalidateAdmission(lane);
  return true;
}

export class BrowserEventTransport {
  private config: ActiveConfig | null = null;
  private flushCycle: Promise<void> | null = null;
  private keepaliveBytes = 0;
  // Beacon exposes no completion signal. Keep its reservation for this instance;
  // ordinary transport remains available after the lifecycle budget is consumed.
  private beaconBytes = 0;
  private debug = createLane();
  private analytics = createLane();
  private readonly retiredDebug = new Set<BrowserTransportLane>();
  private readonly retiredAnalytics = new Set<BrowserTransportLane>();

  public constructor(private readonly callbacks: BrowserEventTransportCallbacks) {}

  public configure(config: ActiveConfig): void {
    this.reset();
    this.config = config;
  }

  public get debugRejected(): boolean {
    return this.debug.rejected;
  }

  public get status(): "healthy" | "degraded" | "disconnected" {
    if (this.config === null || this.debug.rejected || this.debug.consecutiveFailures >= 3) {
      return "disconnected";
    }
    return this.debug.nextRetryAt === null ? "healthy" : "degraded";
  }

  public get lastEventAt(): number | null {
    const values = [this.debug.lastEventAt, this.analytics.lastEventAt].filter(
      (value): value is number => value !== null
    );
    return values.length === 0 ? null : Math.max(...values);
  }

  /** Reject known queue exhaustion before callers construct events or invoke hooks. */
  public canCaptureDebug(kind: DebugBundleBrowserTransportEvent["event_type"], level?: string, status?: number): boolean {
    const lane = this.debug;
    if (this.config === null || lane.rejected || lane.beaconCommitted || this.retiredDebug.size > 0) return false;
    if (lane.events.length + lane.detachedCount < MAX_DEBUG_QUEUED_EVENTS &&
        lane.queuedBytes + lane.detachedBytes < MAX_DEBUG_QUEUED_BYTES) return true;
    const priority = capturePriority(kind, level, status);
    // Match admission: lower-priority traffic rotates; incident evidence never
    // displaces an equal-priority event or a batch still owned by a sender.
    if (hasEvictableEvent(lane, priority < 2 ? priority : priority - 1)) return true;
    recordDebugPressure(lane);
    return false;
  }

  public enqueueDebug(event: DebugBundleBrowserTransportEvent, needsPreparation = false): void {
    if (!needsPreparation) this.debug.prepared.add(event);
    this.enqueue("debug", event);
    if (needsPreparation) this.schedulePreparation(this.debug);
  }

  private schedulePreparation(lane: BrowserTransportLane): void {
    if (lane.preparationTimer !== null || this.debug !== lane) return;
    lane.preparationTimer = setTimeout(() => {
      lane.preparationTimer = null;
      if (this.debug !== lane) return;
      this.prepareDebugEvents(lane, 32);
      if (lane.events.some(event => !lane.prepared.has(event))) this.schedulePreparation(lane);
    }, 0);
  }

  public enqueueAnalytics(event: BrowserAnalyticsEventEnvelope): void {
    this.enqueue("analytics", event);
  }

  public flush(): Promise<void> {
    if (this.debug.events.length === 0 && this.analytics.events.length === 0 && this.debug.pressureCount === 0 &&
        this.debug.flushPromise === null && this.analytics.flushPromise === null &&
        !this.debug.keepalivePending && !this.analytics.keepalivePending) return Promise.resolve();
    if (this.flushCycle !== null) return this.flushCycle;
    const deadline = boundedTransportTimeoutMs(this.config?.requestTimeoutMs ?? 5_000);
    let finish!: () => void;
    const result = new Promise<void>(resolve => { finish = resolve; });
    this.flushCycle = result;
    const timer = setTimeout(finish, deadline);
    // Keep this shared cycle even after its deadline until the owned sender
    // settles. Repeated flush calls cannot create extra timers/waiter chains.
    void (async () => {
      await Promise.all([this.flushLaneToIdle("debug"), this.flushLaneToIdle("analytics")]);
    })().catch(() => undefined).finally(() => {
      clearTimeout(timer);
      if (this.flushCycle === result) this.flushCycle = null;
      finish();
    });
    return result;
  }

  private async flushLaneToIdle(laneName: BrowserTransportLaneName): Promise<void> {
    // At most two 256-event sends drain a stable lane. Bound explicit flush if
    // the host keeps capturing or a sender cannot make progress.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const lane = this.getLane(laneName);
      const before = lane.events.length;
      if (before === 0 && lane.pressureCount === 0 && lane.flushPromise === null && !lane.keepalivePending) return;
      await this.flushLane(laneName);
      if (this.getLane(laneName) !== lane || lane.events.length === 0 ||
          lane.events.length >= before || lane.nextRetryAt !== null) return;
    }
  }

  public scheduleDebug(delayMs?: number): void {
    this.schedule("debug", delayMs);
  }

  public flushViaBeacon(): void {
    this.flushLaneViaBeacon("debug");
    this.flushLaneViaBeacon("analytics");
  }

  public reset(): void {
    this.clearLaneTimer(this.debug);
    if (this.debug.preparationTimer !== null) clearTimeout(this.debug.preparationTimer);
    this.clearLaneTimer(this.analytics);
    // Old sends may still finish; release unsent records and ignore their result.
    if (this.debug.inFlightEvents.size > 0) this.retiredDebug.add(this.debug);
    if (this.analytics.inFlightEvents.size > 0) this.retiredAnalytics.add(this.analytics);
    this.debug.events = [];
    this.debug.queuedBytes = 0;
    invalidateAdmission(this.debug);
    this.analytics.events = [];
    this.analytics.queuedBytes = 0;
    invalidateAdmission(this.analytics);
    this.debug = createLane();
    this.analytics = createLane();
    this.config = null;
  }

  private enqueue(laneName: BrowserTransportLaneName, event: DebugBundleBrowserTransportEvent): void {
    const config = this.config;
    const lane = this.getLane(laneName);
    if (config === null || lane.rejected || lane.beaconCommitted || this.getRetired(laneName).size > 0) {
      return;
    }

    admitEvent(lane, event,
      laneName === "debug" ? MAX_DEBUG_QUEUED_EVENTS : MAX_ANALYTICS_QUEUED_EVENTS,
      laneName === "debug" ? MAX_DEBUG_QUEUED_BYTES : MAX_ANALYTICS_QUEUED_BYTES,
      false, laneName === "debug" ? (dropped) => recordDebugDrop(lane, dropped) : undefined);
    if (lane.events.length >= Math.min(config.batchSize, 256)) {
      if (lane.flushScheduled) return;
      lane.flushScheduled = true;
      queueMicrotask(() => {
        if (this.getLane(laneName) !== lane) return;
        lane.flushScheduled = false;
        void this.flushLane(laneName);
      });
      return;
    }
    this.schedule(laneName);
  }

  private async flushLane(laneName: BrowserTransportLaneName): Promise<void> {
    const config = this.config;
    const lane = this.getLane(laneName);
    if (config === null || lane.rejected ||
        this.getRetired(laneName).size > 0) {
      return;
    }
    if (lane.keepalivePending) return lane.keepalivePromise ?? undefined;
    if (lane.flushPromise !== null) {
      lane.flushRequestedDuringSend = true;
      return lane.flushPromise;
    }
    if (lane.nextRetryAt !== null && Date.now() < lane.nextRetryAt) {
      return;
    }

    if (laneName === "debug") {
      try { this.callbacks.beforeDebugFlush?.(); } catch { /* SDK callbacks cannot disrupt delivery. */ }
      this.enqueuePressureReport(lane, config);
    }
    if (lane.events.length === 0) return;

    this.clearLaneTimer(lane);
    if (laneName === "debug") this.prepareDebugEvents(lane, Math.min(config.batchSize, 256));
    if (this.getLane(laneName) !== lane || lane.preparing) return;
    const events = lane.events.filter(event => laneName !== "debug" || lane.prepared.has(event))
      .slice(0, Math.min(config.batchSize, 256));
    if (events.length === 0) {
      if (lane.events.length > 0) this.schedule(laneName, 0);
      return;
    }
    retainSend(lane, events);
    let acknowledged = false;
    let finishSend!: () => void;
    const completion = new Promise<void>(resolve => { finishSend = resolve; });
    // Reserve ownership before any custom sender can throw or reenter. Assigning
    // after invocation can overwrite synchronous cleanup with a stale promise.
    lane.flushPromise = completion;
    void (async () => {
      try {
        const response = await config.transport({
          endpoint: config.endpoint,
          headers: getTransportHeaders(config),
          events,
          transportMode: config.transportMode,
          timeout_ms: config.requestTimeoutMs
        });
        if (this.getLane(laneName) !== lane) return;

        if (response.status >= 200 && response.status < 300) {
          this.reconcileSuccessfulResponse(
            laneName,
            lane,
            events,
            response.body,
            response.retry_after_ms,
            config.requireAcknowledgement === true
          );
          acknowledged = true;
          return;
        }

        this.reconcileFailure(laneName, lane, config, response.status, response.body, response.retry_after_ms);
      } catch {
        lane.consecutiveFailures += 1;
      } finally {
        releaseSend(lane, events);
        if (lane.inFlightEvents.size === 0) lane.beaconCommitted = false;
        if (lane.inFlightEvents.size === 0) this.getRetired(laneName).delete(lane);
        lane.flushPromise = null;
        const flushRequestedDuringSend = lane.flushRequestedDuringSend;
        lane.flushRequestedDuringSend = false;
        if (this.getLane(laneName) === lane && !lane.rejected) {
          if (lane.events.length > 0 || flushRequestedDuringSend) {
            const retryDelay = lane.nextRetryAt === null
              ? flushRequestedDuringSend || acknowledged && lane.events.length >= Math.min(config.batchSize, 256)
                ? 0 : undefined
              : Math.max(0, lane.nextRetryAt - Date.now());
            this.schedule(laneName, retryDelay);
          } else if (laneName === "debug" && lane.pressureCount > 0) {
            const nextReportAt = (lane.lastPressureReportAt ?? 0) + PRESSURE_REPORT_INTERVAL_MS;
            this.schedule(laneName, Math.max(0, nextReportAt - Date.now()));
          }
        }
      }
    })().catch(() => undefined).finally(finishSend);

    return completion;
  }

  private reconcileFailure(laneName: BrowserTransportLaneName, lane: BrowserTransportLane, config: ActiveConfig,
    status: number, body: unknown, retryAfterMs?: number): void {
    lane.consecutiveFailures += 1;
    if (status === 401 || status === 403) {
      lane.rejected = true;
      lane.nextRetryAt = null;
      lane.events = [];
      lane.queuedBytes = 0;
      updateDetachedRetention(lane);
      invalidateAdmission(lane);
      this.callbacks.onUnauthorized(laneName, status, config.endpoint, body);
    } else if (status === 429 || status >= 500 && retryAfterMs !== undefined) {
      lane.nextRetryAt = Date.now() + boundedRetryAfterMs(retryAfterMs);
    }
  }

  private prepareDebugEvents(lane: BrowserTransportLane, limit: number): void {
    if (lane.preparing) return;
    lane.preparing = true;
    try {
      for (let prepared = 0; prepared < limit; prepared += 1) {
        // Keep only one original/replacement pair alive. Retaining a batch of
        // originals while hooks expand replacements would escape the byte cap.
        const original = lane.events.find(event => !lane.prepared.has(event) && !lane.inFlightEvents.has(event));
        if (original === undefined) break;
        let replacement: DebugBundleBrowserTransportEvent | null = original;
        try { replacement = this.callbacks.prepareDebugEvent?.(original) ??
          (this.callbacks.prepareDebugEvent === undefined ? original : null); }
        catch { replacement = null; }
        if (this.debug !== lane) return;
        const index = lane.events.indexOf(original);
        if (index < 0) continue; // Reentrant capture may have evicted this event.
        lane.events.splice(index, 1);
        lane.queuedBytes -= lane.sizes.get(original) ?? 0;
        invalidateAdmission(lane);
        if (replacement === null) continue;
        lane.prepared.add(replacement);
        if (admitEvent(lane, replacement, MAX_DEBUG_QUEUED_EVENTS, MAX_DEBUG_QUEUED_BYTES,
          true, dropped => recordDebugDrop(lane, dropped))) {
          // Preserve admission order without assuming replacement IDs are unique.
          lane.events.pop();
          lane.events.splice(Math.min(index, lane.events.length), 0, replacement);
        }
      }
    } finally { lane.preparing = false; }
  }

  private schedule(laneName: BrowserTransportLaneName, delayMs?: number): void {
    const config = this.config;
    const lane = this.getLane(laneName);
    if (config === null || lane.rejected || this.getRetired(laneName).size > 0) {
      return;
    }
    this.clearLaneTimer(lane);
    lane.timer = setTimeout(() => {
      lane.timer = null;
      void this.flushLane(laneName);
    }, delayMs ?? config.flushInterval);
  }

  private enqueuePressureReport(lane: BrowserTransportLane, config: ActiveConfig): void {
    if (lane.pressureCount === 0 || lane.pressureFirstAt === null || lane.pressureLastAt === null) return;
    const now = Date.now();
    if (lane.lastPressureReportAt !== null && now - lane.lastPressureReportAt < PRESSURE_REPORT_INTERVAL_MS) return;
    if (lane.events.length >= MAX_DEBUG_QUEUED_EVENTS) return;

    try {
      const event = createBrowserSuppressionEvent(config, {
        fingerprint: "browser-queue-pressure",
        suppressedCount: lane.pressureCount,
        firstSeen: new Date(lane.pressureFirstAt).toISOString(),
        lastSeen: new Date(lane.pressureLastAt).toISOString(),
        windowSeconds: Math.max(1, Math.ceil((lane.pressureLastAt - lane.pressureFirstAt) / 1_000))
      });
      const bytes = eventBytes(lane, event);
      if (bytes === null || lane.queuedBytes + bytes > MAX_DEBUG_QUEUED_BYTES) return;
      if (!admitEvent(lane, event, MAX_DEBUG_QUEUED_EVENTS, MAX_DEBUG_QUEUED_BYTES, true)) return;
      lane.prepared.add(event);
      lane.pressureCount = 0;
      lane.pressureFirstAt = null;
      lane.pressureLastAt = null;
      lane.lastPressureReportAt = now;
    } catch {
      // The aggregate must never disrupt delivery of accepted application events.
    }
  }

  private flushLaneViaBeacon(laneName: BrowserTransportLaneName): void {
    const config = this.config;
    const lane = this.getLane(laneName);
    if (config === null || lane.events.length === 0 || lane.rejected ||
        lane.keepalivePending || this.getRetired(laneName).size > 0 ||
        lane.nextRetryAt !== null && Date.now() < lane.nextRetryAt) {
      return;
    }

    // Unload may transmit only finalized records. Running a pending application
    // hook here would bypass its deferred boundary and can hold page shutdown.
    const pendingEvents: DebugBundleBrowserTransportEvent[] = [];
    const availableBytes = MAX_UNLOAD_BODY_BYTES - this.keepaliveBytes - this.beaconBytes;
    let bodyBytes = buildBrowserTransportRequestBody(config.transportMode, []).length;
    for (const event of lane.events) {
      if (laneName === "debug" && !lane.prepared.has(event) && this.callbacks.prepareDebugEvent !== undefined) continue;
      const bytes = eventBytes(lane, event);
      if (bytes === null || bodyBytes + bytes + (pendingEvents.length === 0 ? 0 : 1) > availableBytes) continue;
      pendingEvents.push(event);
      bodyBytes += bytes + (pendingEvents.length === 1 ? 0 : 1);
      if (pendingEvents.length >= 256) break;
    }
    if (pendingEvents.length === 0) {
      // A large individual event needs the ordinary transport while the page is still active.
      this.schedule(laneName, 0);
      return;
    }
    const body = buildBrowserTransportRequestBody(config.transportMode, pendingEvents);
    const requestBytes = new TextEncoder().encode(body).byteLength;
    if (requestBytes > availableBytes) {
      this.schedule(laneName, 0);
      return;
    }
    const flushViaKeepalive = (): void => {
      if (config.fetchImpl === null) {
        void this.flushLane(laneName);
        return;
      }
      if (typeof AbortController !== "function") {
        this.schedule(laneName, 0);
        return;
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), boundedTransportTimeoutMs(config.requestTimeoutMs));
      lane.keepalivePending = true;
      this.keepaliveBytes += requestBytes;
      retainSend(lane, pendingEvents);
      lane.keepalivePromise = Promise.resolve().then(() => config.fetchImpl!(config.endpoint, {
        method: "POST", headers: getTransportHeaders(config), body, keepalive: true,
        signal: controller.signal
      })).then(async (response) => {
        if (this.getLane(laneName) !== lane) return;
        const retryAfterMs = parseRetryAfter(response.headers?.get("Retry-After") ?? null);
        if (response.status >= 200 && response.status < 300) {
          const responseBody = await readResponseBody(response);
          if (controller.signal.aborted) return;
          this.reconcileSuccessfulResponse(laneName, lane, pendingEvents, responseBody, retryAfterMs, config.transportMode === "direct");
          this.clearLaneTimer(lane);
        } else {
          this.reconcileFailure(laneName, lane, config, response.status, undefined, retryAfterMs);
        }
      }).catch(() => undefined).finally(() => {
        clearTimeout(timeout);
        this.keepaliveBytes -= requestBytes;
        releaseSend(lane, pendingEvents);
        lane.keepalivePending = false;
        lane.keepalivePromise = null;
        if (lane.inFlightEvents.size === 0) lane.beaconCommitted = false;
        if (lane.inFlightEvents.size === 0) this.getRetired(laneName).delete(lane);
        if (this.getLane(laneName) === lane && lane.events.length > 0 && !lane.rejected) {
          this.schedule(laneName, lane.nextRetryAt === null ? lane.events.length > pendingEvents.length ? 0 : undefined
            : Math.max(0, lane.nextRetryAt - Date.now()));
        }
      });
    };

    // Direct ingestion requires a bearer header, which sendBeacon cannot set.
    if (config.transportMode === "direct") {
      flushViaKeepalive();
      return;
    }

    const navigatorSource = getNavigatorSource();
    // Relay beacons remain credential-free. A declined/unavailable beacon uses
    // keepalive fetch so acknowledgements can be reconciled when possible.
    if (typeof navigatorSource?.sendBeacon !== "function") {
      flushViaKeepalive();
      return;
    }

    this.beaconBytes += requestBytes;
    let accepted = false;
    try {
      const beaconBody = typeof Blob === "function"
        ? new Blob([body], { type: "application/json" })
        : body;
      if (navigatorSource.sendBeacon(config.endpoint, beaconBody)) {
        accepted = true;
        const selected = new Map<DebugBundleBrowserTransportEvent, number>();
        for (const event of pendingEvents) selected.set(event, (selected.get(event) ?? 0) + 1);
        lane.events = lane.events.filter(event => {
          const remaining = selected.get(event) ?? 0;
          if (remaining === 0) return true;
          selected.set(event, remaining - 1);
          return false;
        });
        lane.queuedBytes -= pendingEvents.reduce((total, event) => total + (lane.sizes.get(event) ?? 0), 0);
        updateDetachedRetention(lane);
        invalidateAdmission(lane);
        // A concurrent send still owns its snapshot; pause capture until it settles.
        lane.beaconCommitted = lane.inFlightEvents.size > 0;
        lane.nextRetryAt = null;
        this.clearLaneTimer(lane);
        if (lane.events.length > 0 && !lane.beaconCommitted) this.schedule(laneName, 0);
        return;
      }
    } catch {
      // Browser beacon failures must never escape a page lifecycle listener.
    } finally {
      if (!accepted) this.beaconBytes -= requestBytes;
    }
    flushViaKeepalive();
  }

  private getLane(name: BrowserTransportLaneName): BrowserTransportLane {
    return name === "debug" ? this.debug : this.analytics;
  }

  private getRetired(name: BrowserTransportLaneName): Set<BrowserTransportLane> {
    return name === "debug" ? this.retiredDebug : this.retiredAnalytics;
  }

  private reconcileSuccessfulResponse(
    laneName: BrowserTransportLaneName,
    lane: BrowserTransportLane,
    events: DebugBundleBrowserTransportEvent[],
    body: unknown,
    retryAfterMs: number | undefined,
    requireAcknowledgement = false
  ): void {
    if (this.getLane(laneName) !== lane) return;
    const acknowledgement = decideBrowserAcknowledgement(body, events.length, requireAcknowledgement);
    if (acknowledgement.kind === "protocol_failure") {
      lane.consecutiveFailures += 1;
      lane.nextRetryAt = Date.now() + boundedRetryAfterMs(retryAfterMs);
      this.callbacks.onAcknowledgementDiagnostic(laneName, "invalid", acknowledgement.reason);
      return;
    }
    if (laneName === "debug") {
      this.callbacks.onDebugResponse(body);
    }
    if (acknowledgement.kind === "legacy") {
      reconcileLeadingEvents(lane, events, []);
      lane.nextRetryAt = null;
      lane.lastEventAt = Date.now();
      lane.consecutiveFailures = 0;
      return;
    }

    const retryableEvents = acknowledgement.retryableIndices
      .map((index) => events[index])
      .filter((event): event is DebugBundleBrowserTransportEvent => event !== undefined);
    reconcileLeadingEvents(lane, events, retryableEvents);
    if (acknowledgement.terminalErrors.length > 0) {
      const reasons = [...new Set(acknowledgement.terminalErrors.map((error) => error.reason))].join(",");
      this.callbacks.onAcknowledgementDiagnostic(laneName, "terminal_rejection", reasons);
    }
    if (acknowledgement.accepted > 0) {
      lane.lastEventAt = Date.now();
    }
    if (retryableEvents.length > 0) {
      lane.consecutiveFailures += 1;
      lane.nextRetryAt = Date.now() + boundedRetryAfterMs(retryAfterMs);
      return;
    }
    lane.nextRetryAt = null;
    lane.consecutiveFailures = acknowledgement.accepted > 0 ? 0 : 3;
  }

  private clearLaneTimer(lane: BrowserTransportLane): void {
    if (lane.timer !== null) {
      clearTimeout(lane.timer);
      lane.timer = null;
    }
  }
}

function reconcileLeadingEvents(
  lane: BrowserTransportLane,
  events: DebugBundleBrowserTransportEvent[],
  retainedEvents: DebugBundleBrowserTransportEvent[]
): void {
  const selected = new Map<DebugBundleBrowserTransportEvent, number>();
  const retries = new Map<DebugBundleBrowserTransportEvent, number>();
  for (const event of events) selected.set(event, (selected.get(event) ?? 0) + 1);
  for (const event of retainedEvents) retries.set(event, (retries.get(event) ?? 0) + 1);
  const queued: DebugBundleBrowserTransportEvent[] = [];
  const retryable: DebugBundleBrowserTransportEvent[] = [];
  // Only retain records still queued. An overlapping sender may already have
  // acknowledged them; a stale retryable response cannot resurrect those records.
  for (const event of lane.events) {
    const count = selected.get(event) ?? 0;
    if (count === 0) { queued.push(event); continue; }
    selected.set(event, count - 1);
    const retryCount = retries.get(event) ?? 0;
    if (retryCount > 0) { retryable.push(event); retries.set(event, retryCount - 1); }
  }
  lane.events = [...retryable, ...queued];
  lane.queuedBytes = lane.events.reduce((total, event) => total + (lane.sizes.get(event) ?? 0), 0);
  updateDetachedRetention(lane);
  invalidateAdmission(lane);
}

async function readResponseBody(response: { json?: () => Promise<unknown> }): Promise<unknown> {
  if (typeof response.json !== "function") {
    return undefined;
  }
  return response.json().catch(() => undefined);
}

function getTransportHeaders(config: ActiveConfig): Record<string, string> {
  return config.projectToken === null
    ? { "content-type": "application/json" }
    : {
        "content-type": "application/json",
        authorization: `Bearer ${config.projectToken}`
      };
}
