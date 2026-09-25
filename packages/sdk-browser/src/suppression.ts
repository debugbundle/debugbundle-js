import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { SDK_NAME, SDK_SCHEMA_VERSION, SDK_VERSION, type ActiveConfig } from "./types.js";

const DUPLICATE_WINDOW_MS = 30_000;
const LOOP_WINDOW_MS = 2_000;
const LOOP_THRESHOLD = 10;
const LOOP_RESET_AFTER_MS = 60_000;
const LOOP_CHECKPOINT_MS = 30_000;
const MAX_NORMAL_EVENTS_PER_WINDOW = 3;
const MAX_TRACKED_FINGERPRINTS = 2_048;
const MAX_DETAILED_AGGREGATES = 64;

interface SuppressionState {
  windowStartedAtMs: number;
  emittedCount: number;
  pendingSuppressedCount: number;
  pendingFirstSeenAtMs: number | null;
  pendingLastSeenAtMs: number | null;
  lastAggregateEmittedAtMs: number | null;
  loopWindowStartedAtMs: number;
  loopHitCount: number;
  suppressionMode: boolean;
  lastSeenAtMs: number;
}

export interface SuppressionAggregate {
  fingerprint: string;
  suppressedCount: number;
  firstSeen: string;
  lastSeen: string;
  windowSeconds: number;
}

export function createBrowserSuppressionEvent(
  config: ActiveConfig,
  aggregate: SuppressionAggregate
): EventEnvelope {
  return createEventEnvelope({
    schema_version: SDK_SCHEMA_VERSION,
    event_type: "error_suppressed",
    ...(config.projectToken === null ? {} : { project_token: config.projectToken }),
    sdk_name: SDK_NAME,
    sdk_version: SDK_VERSION,
    service: {
      name: config.service,
      runtime: "browser",
      framework: null,
      environment: config.environment
    },
    occurred_at: aggregate.lastSeen,
    payload: {
      fingerprint: aggregate.fingerprint,
      suppressed_count: aggregate.suppressedCount,
      window_seconds: aggregate.windowSeconds,
      first_seen: aggregate.firstSeen,
      last_seen: aggregate.lastSeen
    }
  });
}

function createState(nowMs: number): SuppressionState {
  return {
    windowStartedAtMs: nowMs,
    emittedCount: 0,
    pendingSuppressedCount: 0,
    pendingFirstSeenAtMs: null,
    pendingLastSeenAtMs: null,
    lastAggregateEmittedAtMs: null,
    loopWindowStartedAtMs: nowMs,
    loopHitCount: 0,
    suppressionMode: false,
    lastSeenAtMs: nowMs
  };
}

function resetState(state: SuppressionState, nowMs: number): void {
  Object.assign(state, createState(nowMs));
}

function markSuppressed(state: SuppressionState, nowMs: number): void {
  if (state.pendingSuppressedCount === 0) {
    state.pendingFirstSeenAtMs = state.windowStartedAtMs;
  }

  state.pendingSuppressedCount += 1;
  state.pendingLastSeenAtMs = nowMs;
}

function buildFingerprint(key: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

export class EventSuppressionTracker {
  private readonly states = new Map<string, SuppressionState>();
  private overflowCount = 0;
  private overflowFirstAtMs: number | null = null;
  private overflowLastAtMs: number | null = null;

  public get trackedCount(): number { return this.states.size; }

  public reset(): void {
    this.states.clear();
    this.overflowCount = 0;
    this.overflowFirstAtMs = null;
    this.overflowLastAtMs = null;
  }

  public shouldCapture(key: string, nowMs: number): boolean {
    if (!this.states.has(key) && this.states.size >= MAX_TRACKED_FINGERPRINTS) {
      const oldest = this.states.entries().next().value;
      if (oldest !== undefined) {
        this.addOverflow(oldest[1]);
        this.states.delete(oldest[0]);
      }
    }
    const state = this.states.get(key) ?? createState(nowMs);
    this.states.set(key, state);

    if (state.suppressionMode && nowMs - state.lastSeenAtMs >= LOOP_RESET_AFTER_MS) {
      resetState(state, nowMs);
    }

    if (nowMs - state.windowStartedAtMs >= DUPLICATE_WINDOW_MS) {
      state.windowStartedAtMs = nowMs;
      state.emittedCount = 0;
    }

    if (nowMs - state.loopWindowStartedAtMs >= LOOP_WINDOW_MS) {
      state.loopWindowStartedAtMs = nowMs;
      state.loopHitCount = 0;
    }

    state.loopHitCount += 1;
    state.lastSeenAtMs = nowMs;

    if (state.loopHitCount > LOOP_THRESHOLD) {
      state.suppressionMode = true;
    }

    if (state.suppressionMode) {
      markSuppressed(state, nowMs);
      return false;
    }

    if (state.emittedCount < MAX_NORMAL_EVENTS_PER_WINDOW) {
      state.emittedCount += 1;
      return true;
    }

    markSuppressed(state, nowMs);
    return false;
  }

  public drainAggregates(nowMs: number): SuppressionAggregate[] {
    const aggregates: SuppressionAggregate[] = [];

    for (const [key, state] of this.states.entries()) {
      if (state.pendingSuppressedCount === 0 || state.pendingFirstSeenAtMs === null || state.pendingLastSeenAtMs === null) {
        continue;
      }

      if (state.suppressionMode && state.lastAggregateEmittedAtMs !== null && nowMs - state.lastAggregateEmittedAtMs < LOOP_CHECKPOINT_MS) {
        continue;
      }

      if (aggregates.length < MAX_DETAILED_AGGREGATES) {
        aggregates.push({
          fingerprint: buildFingerprint(key),
          suppressedCount: state.pendingSuppressedCount,
          firstSeen: new Date(state.pendingFirstSeenAtMs).toISOString(),
          lastSeen: new Date(state.pendingLastSeenAtMs).toISOString(),
          windowSeconds: DUPLICATE_WINDOW_MS / 1_000
        });
      } else {
        this.addOverflow(state);
      }

      state.pendingSuppressedCount = 0;
      state.pendingFirstSeenAtMs = null;
      state.pendingLastSeenAtMs = null;
      state.lastAggregateEmittedAtMs = nowMs;

      if (!state.suppressionMode && nowMs - state.lastSeenAtMs >= LOOP_RESET_AFTER_MS) {
        this.states.delete(key);
      }
    }

    if (this.overflowCount > 0 && this.overflowFirstAtMs !== null && this.overflowLastAtMs !== null) {
      aggregates.push({
        fingerprint: buildFingerprint("suppression_state_pressure"),
        suppressedCount: this.overflowCount,
        firstSeen: new Date(this.overflowFirstAtMs).toISOString(),
        lastSeen: new Date(this.overflowLastAtMs).toISOString(),
        windowSeconds: DUPLICATE_WINDOW_MS / 1_000
      });
      this.overflowCount = 0;
      this.overflowFirstAtMs = null;
      this.overflowLastAtMs = null;
    }

    return aggregates;
  }

  private addOverflow(state: SuppressionState): void {
    if (state.pendingSuppressedCount === 0 || state.pendingFirstSeenAtMs === null || state.pendingLastSeenAtMs === null) return;
    this.overflowCount = Math.min(Number.MAX_SAFE_INTEGER, this.overflowCount + state.pendingSuppressedCount);
    this.overflowFirstAtMs = this.overflowFirstAtMs === null
      ? state.pendingFirstSeenAtMs
      : Math.min(this.overflowFirstAtMs, state.pendingFirstSeenAtMs);
    this.overflowLastAtMs = this.overflowLastAtMs === null
      ? state.pendingLastSeenAtMs
      : Math.max(this.overflowLastAtMs, state.pendingLastSeenAtMs);
  }
}
