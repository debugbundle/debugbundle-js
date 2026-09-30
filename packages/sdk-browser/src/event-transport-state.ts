import type { ActiveConfig, DebugBundleBrowserTransportEvent } from "./types.js";

export interface BrowserTransportLane {
  events: DebugBundleBrowserTransportEvent[];
  prepared: WeakSet<DebugBundleBrowserTransportEvent>;
  preparing: boolean;
  preparationTimer: ReturnType<typeof setTimeout> | null;
  inFlightEvents: Map<DebugBundleBrowserTransportEvent, number>;
  beaconCommitted: boolean;
  keepalivePending: boolean;
  keepalivePromise: Promise<void> | null;
  keepaliveController: AbortController | null;
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

export function createLane(): BrowserTransportLane {
  return {
    events: [],
    prepared: new WeakSet(),
    preparing: false,
    preparationTimer: null,
    inFlightEvents: new Map(),
    beaconCommitted: false,
    keepalivePending: false,
    keepalivePromise: null,
    keepaliveController: null,
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

export const MAX_DEBUG_QUEUED_EVENTS = 512;
export const MAX_ANALYTICS_QUEUED_EVENTS = 256;
export const MAX_DEBUG_QUEUED_BYTES = 8 * 1024 * 1024;
export const MAX_ANALYTICS_QUEUED_BYTES = 4 * 1024 * 1024;
// One instance shares this budget across both lanes and outstanding requests.
export const MAX_UNLOAD_BODY_BYTES = 60 * 1024;
export const PRESSURE_REPORT_INTERVAL_MS = 30_000;

export function recordDebugPressure(lane: BrowserTransportLane): void {
  const now = Date.now();
  lane.pressureCount = Math.min(Number.MAX_SAFE_INTEGER, lane.pressureCount + 1);
  lane.pressureFirstAt ??= now;
  lane.pressureLastAt = now;
}

export function recordDebugDrop(
  lane: BrowserTransportLane,
  event: DebugBundleBrowserTransportEvent
): void {
  if (
    event.event_type !== "error_suppressed" ||
    event.payload.fingerprint !== "browser-queue-pressure"
  ) {
    recordDebugPressure(lane);
    return;
  }
  const count = event.payload.suppressed_count;
  const first = Date.parse(event.payload.first_seen);
  const last = Date.parse(event.payload.last_seen);
  if (
    !Number.isSafeInteger(count) ||
    count <= 0 ||
    !Number.isFinite(first) ||
    !Number.isFinite(last)
  )
    return;
  lane.pressureCount = Math.min(Number.MAX_SAFE_INTEGER, lane.pressureCount + count);
  lane.pressureFirstAt =
    lane.pressureFirstAt === null ? first : Math.min(lane.pressureFirstAt, first);
  lane.pressureLastAt = lane.pressureLastAt === null ? last : Math.max(lane.pressureLastAt, last);
  // This report never reached the sender; its previous 30-second slot is still available.
  lane.lastPressureReportAt = null;
}

export function invalidateAdmission(lane: BrowserTransportLane): void {
  lane.queueVersion = (lane.queueVersion + 1) % 1_000_000_000;
}

export function hasEvictableEvent(lane: BrowserTransportLane, maxPriority: number): boolean {
  if (lane.evictableVersion !== lane.queueVersion) {
    lane.evictableMask = 0;
    for (const candidate of lane.events) {
      if (!lane.inFlightEvents.has(candidate)) lane.evictableMask |= 1 << eventPriority(candidate);
    }
    lane.evictableVersion = lane.queueVersion;
  }
  return (lane.evictableMask & ((1 << (maxPriority + 1)) - 1)) !== 0;
}

export function capturePriority(
  kind: DebugBundleBrowserTransportEvent["event_type"],
  level?: string,
  status?: number
): number {
  if (kind === "frontend_exception" || kind === "backend_exception") return 3;
  if (kind === "error_suppressed") return 2;
  if (kind === "log_event") return level === "error" || level === "critical" ? 2 : 0;
  if (kind === "request_event" && status !== undefined && status >= 400) return 2;
  return 1;
}

export function eventPriority(event: DebugBundleBrowserTransportEvent): number {
  return capturePriority(
    event.event_type,
    event.event_type === "log_event" ? event.payload.level : undefined,
    event.event_type === "request_event" ? event.payload.response_status : undefined
  );
}

export function eventBytes(
  lane: BrowserTransportLane,
  event: DebugBundleBrowserTransportEvent
): number | null {
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

export function retainSend(
  lane: BrowserTransportLane,
  events: readonly DebugBundleBrowserTransportEvent[]
): void {
  for (const event of events) {
    lane.inFlightEvents.set(event, (lane.inFlightEvents.get(event) ?? 0) + 1);
  }
  invalidateAdmission(lane);
}

export function releaseSend(
  lane: BrowserTransportLane,
  events: readonly DebugBundleBrowserTransportEvent[]
): void {
  for (const event of events) {
    const retained = lane.inFlightEvents.get(event) ?? 0;
    if (retained <= 1) lane.inFlightEvents.delete(event);
    else lane.inFlightEvents.set(event, retained - 1);
  }
  updateDetachedRetention(lane);
  invalidateAdmission(lane);
}

/** Acknowledged records remain charged while another sender still owns them. */
export function updateDetachedRetention(lane: BrowserTransportLane): void {
  const queued = new Set(lane.events);
  lane.detachedCount = 0;
  lane.detachedBytes = 0;
  for (const event of lane.inFlightEvents.keys()) {
    if (queued.has(event)) continue;
    lane.detachedCount += 1;
    lane.detachedBytes += lane.sizes.get(event) ?? 0;
  }
}

export function admitEvent(
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
  if (
    lane.events.length + lane.detachedCount >= limit &&
    !hasEvictableEvent(lane, maxVictimPriority)
  ) {
    onDrop?.(event);
    return false;
  }
  const bytes = eventBytes(lane, event);
  if (bytes === null || bytes > maxBytes) {
    onDrop?.(event);
    return false;
  }
  if (
    lane.queuedBytes + lane.detachedBytes + bytes > maxBytes &&
    !hasEvictableEvent(lane, maxVictimPriority)
  ) {
    onDrop?.(event);
    return false;
  }

  while (
    lane.events.length + lane.detachedCount >= limit ||
    lane.queuedBytes + lane.detachedBytes + bytes > maxBytes
  ) {
    let victimIndex = -1;
    let victimPriority = incomingPriority;
    for (let index = 0; index < lane.events.length; index += 1) {
      if (lane.inFlightEvents.has(lane.events[index]!)) continue;
      const priority = eventPriority(lane.events[index]!);
      if (
        priority < victimPriority ||
        (allowEqualPriorityEviction && priority === victimPriority && victimIndex < 0)
      ) {
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

export function reconcileLeadingEvents(
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
    if (count === 0) {
      queued.push(event);
      continue;
    }
    selected.set(event, count - 1);
    const retryCount = retries.get(event) ?? 0;
    if (retryCount > 0) {
      retryable.push(event);
      retries.set(event, retryCount - 1);
    }
  }
  lane.events = [...retryable, ...queued];
  lane.queuedBytes = lane.events.reduce((total, event) => total + (lane.sizes.get(event) ?? 0), 0);
  updateDetachedRetention(lane);
  invalidateAdmission(lane);
}

export async function readResponseBody(response: {
  json?: () => Promise<unknown>;
}): Promise<unknown> {
  if (typeof response.json !== "function") {
    return undefined;
  }
  return response.json().catch(() => undefined);
}

export function getTransportHeaders(config: ActiveConfig): Record<string, string> {
  return config.projectToken === null
    ? { "content-type": "application/json" }
    : {
        "content-type": "application/json",
        authorization: `Bearer ${config.projectToken}`
      };
}
