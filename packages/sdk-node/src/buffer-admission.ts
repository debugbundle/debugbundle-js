import type { EventEnvelope } from "@debugbundle/shared-types";

function eventPriority(event: EventEnvelope): number {
  return capturePriority(
    event.event_type,
    event.event_type === "log_event" ? event.payload.level : undefined,
    event.event_type === "request_event" ? event.payload.response_status : undefined
  );
}

function capturePriority(kind: EventEnvelope["event_type"], level?: string, responseStatus?: number): number {
  if (kind === "backend_exception" || kind === "frontend_exception") return 3;
  if (kind === "error_suppressed") return 2;
  if (kind === "log_event") return level === "error" || level === "critical" ? 2 : 0;
  if (kind === "request_event" && responseStatus !== undefined && responseStatus >= 400) return 2;
  return 1;
}

function pressureClass(kind: EventEnvelope["event_type"], level?: string): string {
  if (kind === "log_event") {
    return ["debug", "info", "warning", "error", "critical"].includes(level ?? "") ? level! : "log";
  }
  if (kind === "backend_exception" || kind === "frontend_exception") return "exception";
  if (kind === "request_event") return "request";
  return "other";
}

export interface QueuePressureSnapshot {
  kind: string;
  count: number;
  firstSeenAtMs: number;
  lastSeenAtMs: number;
}

/** Bounded admission retains the highest-value evidence when a sender falls behind. */
export function admitBufferedEvent(buffer: EventEnvelope[], event: EventEnvelope, capacity: number): EventEnvelope | null {
  if (buffer.length < capacity) {
    buffer.push(event);
    return null;
  }

  const incomingPriority = eventPriority(event);
  let victimIndex = -1;
  let victimPriority = incomingPriority;
  for (let index = 0; index < buffer.length; index += 1) {
    const priority = eventPriority(buffer[index]!);
    if (priority < victimPriority || (priority === victimPriority && victimIndex < 0)) {
      victimIndex = index;
      victimPriority = priority;
    }
  }
  if (victimIndex < 0) return event;
  const [dropped] = buffer.splice(victimIndex, 1);
  buffer.push(event);
  return dropped ?? null;
}

export function restoreBufferedEvents(buffer: EventEnvelope[], events: EventEnvelope[], capacity: number): EventEnvelope[] {
  const outstanding = [...events, ...buffer];
  buffer.length = 0;
  const dropped: EventEnvelope[] = [];
  for (const event of outstanding) {
    if (buffer.length < capacity) {
      buffer.push(event);
      continue;
    }
    const victimIndex = buffer.findIndex((candidate) => eventPriority(candidate) < eventPriority(event));
    if (victimIndex < 0) {
      dropped.push(event);
      continue;
    }
    const [loss] = buffer.splice(victimIndex, 1);
    if (loss !== undefined) dropped.push(loss);
    buffer.push(event);
  }
  return dropped;
}

/** Tracks only protected events; count and bytes include a batch owned by the sender. */
export class BoundedEventBuffer {
  readonly events: EventEnvelope[] = [];
  private readonly sizes = new WeakMap<EventEnvelope, number>();
  private bytes = 0;
  private readonly priorityCounts = [0, 0, 0, 0];
  private equalPriorityAttempts = 0;
  private rejectedBeforeConstruction = 0;
  private readonly pressure = new Map<string, QueuePressureSnapshot>();

  get preflightDropCount(): number { return this.rejectedBeforeConstruction; }

  pressureSnapshots(): QueuePressureSnapshot[] {
    return [...this.pressure.values()].map((entry) => ({ ...entry }));
  }

  acknowledgePressure(kind: string, count: number): void {
    const entry = this.pressure.get(kind);
    if (entry === undefined) return;
    entry.count -= count;
    if (entry.count <= 0) this.pressure.delete(kind);
    else entry.firstSeenAtMs = entry.lastSeenAtMs;
  }

  private recordPressure(kind: EventEnvelope["event_type"], level?: string): void {
    const label = pressureClass(kind, level);
    const now = Date.now();
    const entry = this.pressure.get(label);
    if (entry === undefined) this.pressure.set(label, { kind: label, count: 1, firstSeenAtMs: now, lastSeenAtMs: now });
    else {
      entry.count = Math.min(Number.MAX_SAFE_INTEGER, entry.count + 1);
      entry.lastSeenAtMs = now;
    }
  }

  private recordEventPressure(event: EventEnvelope): void {
    this.recordPressure(event.event_type, event.event_type === "log_event" ? event.payload.level : undefined);
  }

  private clearEvents(): void {
    this.events.length = 0;
    this.bytes = 0;
    this.priorityCounts.fill(0);
  }

  clear(): void {
    this.clearEvents();
    this.equalPriorityAttempts = 0;
    this.rejectedBeforeConstruction = 0;
    this.pressure.clear();
  }

  canAdmit(kind: EventEnvelope["event_type"], level: string | undefined, maxEvents: number, maxBytes: number,
    responseStatus?: number): boolean {
    if (maxEvents <= 0 || maxBytes <= 0) {
      this.recordPreflightDrop(kind, level);
      return false;
    }
    if (this.events.length < maxEvents && this.bytes < maxBytes) return true;
    const incoming = capturePriority(kind, level, responseStatus);
    for (let priority = 0; priority < incoming; priority += 1) {
      if (this.priorityCounts[priority]! > 0) return true;
    }
    if (this.priorityCounts[incoming]! > 0) {
      // Keep a bounded sample of later equal-priority failures without making
      // every replacement run privacy and application hooks on the event loop.
      this.equalPriorityAttempts = (this.equalPriorityAttempts + 1) % 256;
      if (this.equalPriorityAttempts === 1) return true;
    }
    this.recordPreflightDrop(kind, level);
    return false;
  }

  private recordPreflightDrop(kind: EventEnvelope["event_type"], level?: string): void {
    this.rejectedBeforeConstruction = Math.min(Number.MAX_SAFE_INTEGER, this.rejectedBeforeConstruction + 1);
    this.recordPressure(kind, level);
  }

  takeBatch(count: number): { events: EventEnvelope[]; bytes: number } {
    const events = this.events.splice(0, count);
    let bytes = 0;
    for (const event of events) {
      bytes += this.sizes.get(event) ?? 0;
      // Weak size entries remain available while the sender owns this event.
      this.priorityCounts[eventPriority(event)]!--;
    }
    this.bytes -= bytes;
    return { events, bytes };
  }

  eventBytes(event: EventEnvelope): number {
    return this.sizes.get(event) ?? Buffer.byteLength(JSON.stringify(event), "utf8");
  }

  /** Fit a sender replacement against queued ownership, evicting only lower priority work. */
  fitDetached(event: EventEnvelope, maxEvents: number, maxBytes: number): number | null {
    if (this.admit(event, maxEvents, maxBytes, false).includes(event)) return null;
    const bytes = this.sizes.get(event)!;
    this.events.pop(); // Successful admission always appends this exact object.
    this.bytes -= bytes;
    this.priorityCounts[eventPriority(event)]!--;
    return bytes;
  }

  admit(event: EventEnvelope, maxEvents: number, maxBytes: number, evictEqual = true, recordPressure = true): EventEnvelope[] {
    let bytes: number;
    try {
      bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    } catch {
      if (recordPressure) this.recordEventPressure(event);
      return [event];
    }
    if (bytes > maxBytes || maxEvents <= 0) {
      if (recordPressure) this.recordEventPressure(event);
      return [event];
    }
    if (this.events.length < maxEvents && this.bytes + bytes <= maxBytes) {
      this.events.push(event);
      this.sizes.set(event, bytes);
      this.bytes += bytes;
      this.priorityCounts[eventPriority(event)]!++;
      return [];
    }

    const incomingPriority = eventPriority(event);
    const candidates = this.events.map((item, index) => ({ item, index, priority: eventPriority(item) }))
      .filter((candidate) => candidate.priority < incomingPriority ||
        (evictEqual && candidate.priority === incomingPriority))
      .sort((left, right) => left.priority - right.priority || left.index - right.index);
    const victims: typeof candidates = [];
    let freedBytes = 0;
    for (const candidate of candidates) {
      if (this.events.length - victims.length < maxEvents && this.bytes - freedBytes + bytes <= maxBytes) break;
      victims.push(candidate);
      freedBytes += this.sizes.get(candidate.item) ?? 0;
    }
    if (this.events.length - victims.length >= maxEvents || this.bytes - freedBytes + bytes > maxBytes) {
      if (recordPressure) this.recordEventPressure(event);
      return [event];
    }
    for (const victim of [...victims].sort((left, right) => right.index - left.index)) {
      this.events.splice(victim.index, 1);
      this.sizes.delete(victim.item);
      this.priorityCounts[victim.priority]!--;
    }
    this.bytes -= freedBytes;
    this.events.push(event);
    this.sizes.set(event, bytes);
    this.bytes += bytes;
    this.priorityCounts[incomingPriority]!++;
    if (recordPressure) victims.forEach((victim) => this.recordEventPressure(victim.item));
    return victims.map((victim) => victim.item);
  }

  restore(events: EventEnvelope[], maxEvents: number, maxBytes: number): EventEnvelope[] {
    const outstanding = [...events, ...this.events];
    this.clearEvents();
    return outstanding.flatMap((event) => this.admit(event, maxEvents, maxBytes, false));
  }
}
