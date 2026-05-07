import { createHash } from "node:crypto";

const DUPLICATE_WINDOW_MS = 30_000;
const LOOP_WINDOW_MS = 2_000;
const LOOP_THRESHOLD = 10;
const LOOP_RESET_AFTER_MS = 60_000;
const LOOP_CHECKPOINT_MS = 30_000;
const MAX_NORMAL_EVENTS_PER_WINDOW = 3;

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
  const nextState = createState(nowMs);
  Object.assign(state, nextState);
}

function markSuppressed(state: SuppressionState, nowMs: number): void {
  if (state.pendingSuppressedCount === 0) {
    state.pendingFirstSeenAtMs = state.windowStartedAtMs;
  }

  state.pendingSuppressedCount += 1;
  state.pendingLastSeenAtMs = nowMs;
}

export class EventSuppressionTracker {
  private readonly states = new Map<string, SuppressionState>();

  public reset(): void {
    this.states.clear();
  }

  public shouldCapture(key: string, nowMs: number): boolean {
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

      aggregates.push({
        fingerprint: createHash("sha256").update(key).digest("hex"),
        suppressedCount: state.pendingSuppressedCount,
        firstSeen: new Date(state.pendingFirstSeenAtMs).toISOString(),
        lastSeen: new Date(state.pendingLastSeenAtMs).toISOString(),
        windowSeconds: DUPLICATE_WINDOW_MS / 1_000
      });

      state.pendingSuppressedCount = 0;
      state.pendingFirstSeenAtMs = null;
      state.pendingLastSeenAtMs = null;
      state.lastAggregateEmittedAtMs = nowMs;

      if (!state.suppressionMode && nowMs - state.lastSeenAtMs >= LOOP_RESET_AFTER_MS) {
        this.states.delete(key);
      }
    }

    return aggregates;
  }
}