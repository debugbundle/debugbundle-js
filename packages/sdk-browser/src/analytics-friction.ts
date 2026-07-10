const FRICTION_CLICK_THRESHOLD = 3;
const FRICTION_CLICK_WINDOW_MS = 2_000;
const FRICTION_CLICK_COOLDOWN_MS = 10_000;
const FRICTION_BACKTRACK_WINDOW_MS = 10_000;

interface FrictionClickState {
  count: number;
  lastClickedAtMs: number;
  cooldownUntilMs: number;
}

interface RouteTransitionState {
  fromPath: string;
  toPath: string;
  occurredAtMs: number;
}

export class BrowserAnalyticsFrictionTracker {
  private clickStates = new WeakMap<object, FrictionClickState>();
  private recentRouteTransition: RouteTransitionState | null = null;

  public reset(): void {
    this.clickStates = new WeakMap<object, FrictionClickState>();
    this.recentRouteTransition = null;
  }

  public recordClick(
    targetIdentity: unknown,
    isStructuralTarget: boolean,
    isDeadClickCandidate: boolean,
    nowMs: number
  ): "friction.repeated_click" | "friction.dead_click" | null {
    if (targetIdentity === null || typeof targetIdentity !== "object") {
      return null;
    }

    const prior = this.clickStates.get(targetIdentity);
    if (prior !== undefined && nowMs < prior.cooldownUntilMs) {
      return null;
    }

    const count = prior !== undefined && nowMs - prior.lastClickedAtMs <= FRICTION_CLICK_WINDOW_MS ? prior.count + 1 : 1;
    const nextState: FrictionClickState = {
      count,
      lastClickedAtMs: nowMs,
      cooldownUntilMs: 0
    };
    if (count < FRICTION_CLICK_THRESHOLD) {
      this.clickStates.set(targetIdentity, nextState);
      return null;
    }

    const markerKey = isStructuralTarget
      ? "friction.repeated_click"
      : isDeadClickCandidate
        ? "friction.dead_click"
        : null;
    if (markerKey === null) {
      this.clickStates.set(targetIdentity, nextState);
      return null;
    }

    this.clickStates.set(targetIdentity, {
      count: 0,
      lastClickedAtMs: nowMs,
      cooldownUntilMs: nowMs + FRICTION_CLICK_COOLDOWN_MS
    });
    return markerKey;
  }

  public recordRouteTransition(
    fromPath: string | null,
    toPath: string | null,
    nowMs: number
  ): "friction.backtrack" | null {
    if (fromPath === null || toPath === null || fromPath === toPath) {
      return null;
    }

    const prior = this.recentRouteTransition;
    const isBacktrack =
      prior !== null &&
      nowMs - prior.occurredAtMs <= FRICTION_BACKTRACK_WINDOW_MS &&
      prior.fromPath === toPath &&
      prior.toPath === fromPath;
    this.recentRouteTransition = { fromPath, toPath, occurredAtMs: nowMs };
    return isBacktrack ? "friction.backtrack" : null;
  }
}
