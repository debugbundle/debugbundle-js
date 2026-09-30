import { createBrowserTraceId, normalizeSampleRate } from "./runtime.js";
import { BrowserAnalyticsFrictionTracker } from "./analytics-friction.js";
import {
  analyticsSnapshotBytes,
  protectBrowserAnalyticsEvent,
  snapshotAnalyticsInput
} from "./analytics-privacy.js";
import {
  buildAnalyticsDimensions,
  getAnalyticsProjectTokenFields,
  getStructuralActionKey,
  isDeadClickCandidate,
  normalizeAnalyticsPrivacyMode,
  normalizeAnalyticsRoute,
  normalizeAnalyticsSignal,
  omitBuiltInAnalyticsDimensions,
  removeStoredAnalyticsVisitor,
  resolveStandardAnalyticsVisitor,
  sanitizeAnalyticsCustomDimensions
} from "./analytics-normalization.js";
import {
  SDK_NAME,
  SDK_VERSION,
  type ActiveConfig,
  type BrowserAnalyticsCustomDimensions,
  type BrowserAnalyticsEventEnvelope,
  type BrowserAnalyticsEventKind,
  type BrowserAnalyticsPrivacyMode,
  type BrowserRemoteAnalyticsConfig,
  type BrowserDeviceInfo,
  type DebugBundleBrowserAnalytics,
  type DebugBundleBrowserAnalyticsConfig
} from "./types.js";

const ANALYTICS_EVENT_SCHEMA_VERSION = "2026-07-analytics-01";
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const MAX_PENDING_STANDARD_EVENTS = 16;
const MAX_PENDING_BYTES = 64 * 1024;

type SignalKind = Extract<
  BrowserAnalyticsEventKind,
  "action" | "funnel_step" | "conversion" | "journey_marker"
>;
type PendingCapture =
  | { kind: "page"; eventKind: "page_view" | "route_change"; input: Record<string, unknown> }
  | {
      kind: "signal";
      eventKind: SignalKind;
      signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>;
      dimensions: BrowserAnalyticsCustomDimensions;
    }
  | { kind: "context"; dimensions: Record<string, unknown> }
  | { kind: "user"; hash: string | null }
  | { kind: "structural"; actionKey: string };

interface BrowserAnalyticsActiveConfig {
  enabled: boolean;
  privacyMode: BrowserAnalyticsPrivacyMode;
  consentRequired: boolean;
  consentGranted: boolean;
  consentExplicitlySet: boolean;
  trackPageViews: boolean;
  trackRouteChanges: boolean;
  trackSessions: boolean;
  trackReferrers: boolean;
  captureActions: boolean;
  trackActions: boolean;
  trackFrictionSignals: boolean;
  sampleRate: number;
  sessionId: string;
  sessionStartedAtMs: number;
  sessionPageviews: number;
  captureReady: boolean;
  pendingCaptures: PendingCapture[];
  pendingBytes: number;
  visitorIdHash: string | null;
  visitorStorageKey: string | null;
  visitorInitializationPending: boolean;
  generation: number;
  pendingEvents: BrowserAnalyticsEventEnvelope[];
  userIdHash: string | null;
  context: BrowserAnalyticsCustomDimensions;
}

export class BrowserAnalyticsController {
  private active: BrowserAnalyticsActiveConfig | null = null;
  private lastRoute: BrowserAnalyticsEventEnvelope["payload"]["route"] = null;
  private sessionSummaryCaptured = false;
  private readonly frictionTracker = new BrowserAnalyticsFrictionTracker();

  public constructor(
    private readonly host: {
      getConfig(): ActiveConfig | null;
      getDeviceInfo(): BrowserDeviceInfo | null;
      getCurrentRoute(): string | null;
      getSessionId(): string;
      enqueue(event: BrowserAnalyticsEventEnvelope): void;
      revoke(): void;
      canCapture(): boolean;
    }
  ) {}

  public readonly api: DebugBundleBrowserAnalytics = {
    getStatus: () => ({ mode: "legacy", semantic: null }),
    setConsent: (value) => {
      if (typeof value !== "boolean") return;
      if (this.active !== null) {
        this.active.consentGranted = value;
        this.active.consentExplicitlySet = true;
        if (!value) {
          this.invalidate(this.active);
        } else if (this.active.captureReady) {
          void this.initializeStandardVisitor(this.active);
        }
      }
    },
    pageView: (input = {}) => {
      this.capturePageView(input, "page_view");
    },
    track: (name, dimensions = {}) => {
      this.captureSignal("action", { action_key: name }, dimensions);
    },
    funnel: (name, step, dimensions = {}) => {
      this.captureSignal("funnel_step", { funnel_key: name, step_key: step }, dimensions);
    },
    convert: (name, dimensions = {}) => {
      this.captureSignal("conversion", { conversion_key: name }, dimensions);
    },
    marker: (name, dimensions = {}) => {
      this.captureSignal("journey_marker", { marker_key: name }, dimensions);
    },
    setContext: (dimensions) => {
      this.setContext(dimensions);
    },
    setUserHash: (hash) => {
      this.setUserHash(hash);
    }
  };

  public configure(
    config: DebugBundleBrowserAnalyticsConfig | undefined,
    options: { deferCapture?: boolean } = {}
  ): void {
    this.sessionSummaryCaptured = false;
    // Explicit successor selection never falls back to the installed V1 emitter.
    const enabled = config?.enabled === true && config.schemaVersion === undefined;
    if (!enabled) {
      this.active = null;
      this.lastRoute = null;
      return;
    }

    const sampleRate = normalizeSampleRate(config?.sampleRate, 1);
    if (sampleRate <= 0 || Math.random() > sampleRate) {
      this.active = null;
      this.lastRoute = null;
      return;
    }

    const privacyMode = normalizeAnalyticsPrivacyMode(config?.privacyMode);
    const consentRequired = config?.consentRequired === true;
    this.active = {
      enabled,
      privacyMode,
      consentRequired,
      consentGranted: !consentRequired,
      consentExplicitlySet: false,
      trackPageViews: config?.trackPageViews !== false,
      trackRouteChanges: config?.trackRouteChanges !== false,
      trackSessions: config?.trackSessions !== false,
      trackReferrers: config?.trackReferrers !== false,
      captureActions: true,
      trackActions: config?.trackActions === true,
      trackFrictionSignals: config?.trackFrictionSignals !== false,
      sampleRate,
      sessionId: this.host.getSessionId(),
      sessionStartedAtMs: Date.now(),
      sessionPageviews: 0,
      captureReady: options.deferCapture !== true,
      pendingCaptures: [],
      pendingBytes: 0,
      visitorIdHash: null,
      visitorStorageKey: null,
      visitorInitializationPending: false,
      generation: 0,
      pendingEvents: [],
      userIdHash: null,
      context: {}
    };
    this.lastRoute = null;
    this.frictionTracker.reset();
    if (this.active.captureReady) {
      void this.initializeStandardVisitor(this.active);
    }
  }

  public markCaptureReady(): void {
    const active = this.active;
    if (active === null || active.captureReady) {
      return;
    }
    active.captureReady = true;
    void this.initializeStandardVisitor(active);
    this.captureSessionStart();
    this.captureInitialPageView();
    while (active.pendingCaptures.length > 0) {
      const capture = active.pendingCaptures.shift()!;
      active.pendingBytes -= analyticsSnapshotBytes(capture);
      this.executeCapture(capture);
    }
  }

  public reset(): void {
    if (this.active !== null) this.invalidate(this.active);
    this.active = null;
    this.lastRoute = null;
    this.sessionSummaryCaptured = false;
    this.frictionTracker.reset();
  }

  public captureSessionStart(): void {
    if (this.active?.trackSessions !== true) {
      return;
    }

    this.enqueue("session_start", {}, null, {});
  }

  public captureSessionSummary(): void {
    if (this.active?.trackSessions !== true || this.sessionSummaryCaptured) {
      return;
    }

    if (this.enqueue("session_summary", {}, this.lastRoute, {})) {
      this.sessionSummaryCaptured = true;
    }
  }

  public prepareForUnload(): void {
    const active = this.active;
    if (active?.visitorInitializationPending === true) {
      active.visitorInitializationPending = false;
      this.flushPendingEvents(active);
    }
  }

  public captureInitialPageView(): void {
    if (this.active?.trackPageViews !== true) {
      return;
    }

    this.capturePageView({}, "page_view");
  }

  public captureRouteChange(path: string): void {
    if (this.active?.trackRouteChanges === true) {
      this.capturePageView({ path }, "route_change");
    }
  }

  public applyRemoteSettings(remote: BrowserRemoteAnalyticsConfig): void {
    const active = this.active;
    if (active === null) {
      return;
    }

    const tightened =
      (active.enabled && !remote.enabled) ||
      (active.privacyMode !== "strict" && remote.privacyMode === "strict") ||
      (!active.consentRequired && remote.consentRequired && !active.consentExplicitlySet) ||
      (active.trackPageViews && !remote.capturePageViews) ||
      (active.trackRouteChanges && !remote.captureRouteChanges) ||
      (active.captureActions && !remote.captureActions) ||
      (active.trackFrictionSignals && !remote.captureFrictionSignals);
    if (tightened) this.invalidate(active);

    active.enabled = active.enabled && remote.enabled;
    if (remote.privacyMode === "strict") {
      active.privacyMode = "strict";
      active.userIdHash = null;
      this.clearStandardVisitor(active);
    }
    active.consentRequired = active.consentRequired || remote.consentRequired;
    if (active.consentRequired && !active.consentExplicitlySet) {
      active.consentGranted = false;
      this.clearStandardVisitor(active);
    }
    active.trackPageViews = active.trackPageViews && remote.capturePageViews;
    active.trackRouteChanges = active.trackRouteChanges && remote.captureRouteChanges;
    active.captureActions = active.captureActions && remote.captureActions;
    active.trackActions = active.trackActions && remote.captureActions;
    active.trackFrictionSignals = active.trackFrictionSignals && remote.captureFrictionSignals;
    if (!active.enabled) {
      this.clearStandardVisitor(active);
    }
  }

  public shouldCaptureStructuralActions(): boolean {
    return (
      this.active?.enabled === true &&
      this.active.trackActions &&
      this.active.captureActions &&
      this.active.consentGranted
    );
  }

  public shouldCaptureFrictionSignals(): boolean {
    return (
      this.active?.enabled === true &&
      this.active.trackFrictionSignals &&
      this.active.consentGranted
    );
  }

  public captureStructuralAction(target: Record<string, unknown>): void {
    if (!this.canCapture() || !this.shouldCaptureStructuralActions()) {
      return;
    }

    const snapshot = this.snapshot(target);
    if (snapshot === null) return;
    const actionKey = getStructuralActionKey(snapshot);
    if (actionKey === null) {
      return;
    }
    this.captureStructuralKey(actionKey);
  }

  public captureFrictionClick(target: Record<string, unknown>, targetIdentity: unknown): void {
    if (
      !this.canCapture() ||
      !this.shouldCaptureFrictionSignals() ||
      targetIdentity === null ||
      typeof targetIdentity !== "object"
    ) {
      return;
    }

    const snapshot = this.snapshot(target);
    if (snapshot === null) return;
    if (!this.shouldCaptureFrictionSignals()) {
      return;
    }
    const markerKey = this.frictionTracker.recordClick(
      targetIdentity,
      getStructuralActionKey(snapshot) !== null,
      isDeadClickCandidate(snapshot),
      Date.now()
    );
    if (markerKey !== null) {
      this.captureSignal("journey_marker", { marker_key: markerKey }, {});
    }
  }

  private capturePageView(input: unknown, kind: "page_view" | "route_change"): void {
    if (!this.canCapture()) return;
    const snapshot = this.snapshot(input);
    if (snapshot === null) return;
    const routeInput = this.snapshot({
      path: typeof snapshot["path"] === "string" ? snapshot["path"] : this.host.getCurrentRoute(),
      title: typeof snapshot["title"] === "string" ? snapshot["title"] : null
    });
    if (routeInput === null) return;
    if (this.deferCapture({ kind: "page", eventKind: kind, input: routeInput })) return;
    const route = normalizeAnalyticsRoute(
      typeof routeInput["path"] === "string" ? routeInput["path"] : null,
      typeof routeInput["title"] === "string" ? routeInput["title"] : null
    );
    if (route === null) {
      return;
    }

    const previousRoute = kind === "route_change" ? this.lastRoute : null;
    if (this.enqueue(kind, {}, route, {}, previousRoute)) {
      this.lastRoute = route;
      if (this.active !== null) {
        this.active.sessionPageviews += 1;
      }
      if (kind === "route_change") {
        this.captureBacktrackFriction(previousRoute, route);
      }
    }
  }

  private captureBacktrackFriction(
    previousRoute: BrowserAnalyticsEventEnvelope["payload"]["route"],
    route: BrowserAnalyticsEventEnvelope["payload"]["route"]
  ): void {
    if (!this.shouldCaptureFrictionSignals() || previousRoute === null || route === null) {
      return;
    }

    const fromPath = previousRoute.normalized_path;
    const toPath = route.normalized_path;
    if (fromPath === null || toPath === null || fromPath === toPath) {
      return;
    }

    const markerKey = this.frictionTracker.recordRouteTransition(fromPath, toPath, Date.now());
    if (markerKey !== null) {
      this.enqueue("journey_marker", { marker_key: markerKey }, route, {});
    }
  }

  private captureSignal(
    kind: Extract<
      BrowserAnalyticsEventKind,
      "action" | "funnel_step" | "conversion" | "journey_marker"
    >,
    signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>,
    dimensions: Record<string, unknown>
  ): void {
    if (!this.canCapture()) return;
    if (kind === "action" && this.active?.captureActions !== true) {
      return;
    }

    const protectedSignal = this.snapshot(signal);
    if (protectedSignal === null) return;
    const normalizedSignal = normalizeAnalyticsSignal(protectedSignal);
    if (
      (kind === "action" && normalizedSignal.action_key === null) ||
      (kind === "funnel_step" &&
        (normalizedSignal.funnel_key === null || normalizedSignal.step_key === null)) ||
      (kind === "conversion" && normalizedSignal.conversion_key === null) ||
      (kind === "journey_marker" && normalizedSignal.marker_key === null)
    ) {
      return;
    }

    const snapshot = this.snapshot(dimensions);
    if (snapshot === null) return;
    const sanitized = sanitizeAnalyticsCustomDimensions(snapshot);
    if (
      this.deferCapture({
        kind: "signal",
        eventKind: kind,
        signal: normalizedSignal,
        dimensions: sanitized
      })
    )
      return;

    this.enqueue(
      kind,
      normalizedSignal,
      kind === "journey_marker" ? this.lastRoute : null,
      sanitized
    );
  }

  private enqueue(
    kind: BrowserAnalyticsEventKind,
    signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>,
    route: BrowserAnalyticsEventEnvelope["payload"]["route"],
    dimensions: BrowserAnalyticsCustomDimensions,
    previousRoute: BrowserAnalyticsEventEnvelope["payload"]["route"] = null
  ): boolean {
    try {
      if (!this.canCapture() || this.active?.captureReady !== true) return false;
      const sdkConfig = this.host.getConfig();
      const active = this.active;
      if (sdkConfig === null || active === null || !active.enabled || !active.consentGranted) {
        return false;
      }

      const mergedDimensions = {
        ...active.context,
        ...dimensions
      };
      const event: BrowserAnalyticsEventEnvelope = {
        schema_version: ANALYTICS_EVENT_SCHEMA_VERSION,
        event_id: createBrowserTraceId(),
        event_type: "analytics_event",
        ...getAnalyticsProjectTokenFields(sdkConfig),
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: {
          name: sdkConfig.service,
          runtime: "browser",
          framework: null,
          environment: sdkConfig.environment
        },
        occurred_at: new Date().toISOString(),
        correlation: {
          session_id: active.sessionId,
          visitor_id_hash: active.visitorIdHash,
          user_id_hash: active.userIdHash,
          trace_id: null,
          deploy_id: null
        },
        payload: {
          kind,
          privacy: {
            mode: active.privacyMode,
            consent_granted: active.consentGranted
          },
          ...(kind === "session_summary"
            ? {
                session: {
                  duration_ms: Math.min(
                    86_400_000,
                    Math.max(0, Date.now() - active.sessionStartedAtMs)
                  ),
                  pageviews: active.sessionPageviews
                }
              }
            : {}),
          signal: normalizeAnalyticsSignal(signal),
          route,
          ...(previousRoute !== null ? { previous_route: previousRoute } : {}),
          dimensions: buildAnalyticsDimensions(
            this.host.getDeviceInfo(),
            active.trackReferrers,
            mergedDimensions
          ),
          custom_dimensions: omitBuiltInAnalyticsDimensions(mergedDimensions)
        }
      };

      const protectedEvent = protectBrowserAnalyticsEvent(event, sdkConfig.redactFields);
      return protectedEvent !== null && this.retainOrEnqueue(active, protectedEvent);
    } catch {
      // Optional browser metadata/serialization must not escape into application capture.
      return false;
    }
  }

  private retainOrEnqueue(
    active: BrowserAnalyticsActiveConfig,
    event: BrowserAnalyticsEventEnvelope
  ): boolean {
    if (
      this.active !== active ||
      !active.enabled ||
      !active.consentGranted ||
      !this.host.canCapture()
    )
      return false;
    if (active.visitorInitializationPending) {
      const bytes = analyticsSnapshotBytes(event);
      if (
        active.pendingCaptures.length + active.pendingEvents.length >=
          MAX_PENDING_STANDARD_EVENTS ||
        active.pendingBytes + bytes > MAX_PENDING_BYTES
      )
        return false;
      active.pendingBytes += bytes;
      active.pendingEvents.push(event);
      return true;
    }
    this.host.enqueue(event);
    return true;
  }

  private async initializeStandardVisitor(active: BrowserAnalyticsActiveConfig): Promise<void> {
    if (
      active.privacyMode !== "standard" ||
      !active.enabled ||
      !active.consentGranted ||
      active.visitorIdHash !== null ||
      active.visitorInitializationPending
    ) {
      return;
    }

    const projectToken = this.host.getConfig()?.projectToken;
    if (projectToken === null || projectToken === undefined) {
      return;
    }

    active.visitorInitializationPending = true;
    const generation = active.generation;
    const current = (): boolean =>
      this.active === active &&
      active.generation === generation &&
      active.privacyMode === "standard" &&
      active.enabled &&
      active.consentGranted;
    try {
      const visitor = await resolveStandardAnalyticsVisitor(
        projectToken,
        (storageKey) => {
          if (!current()) return;
          active.visitorStorageKey = storageKey;
        },
        current
      );
      if (visitor === null || !current()) {
        return;
      }
      active.visitorStorageKey = visitor.storageKey;
      active.visitorIdHash = visitor.visitorIdHash;
    } catch {
      // Browser storage and crypto APIs are optional; analytics falls back to session-only.
    } finally {
      if (this.active === active && active.generation === generation) {
        active.visitorInitializationPending = false;
        this.flushPendingEvents(active);
      }
    }
  }

  private clearStandardVisitor(active: BrowserAnalyticsActiveConfig): void {
    if (active.visitorStorageKey !== null) {
      removeStoredAnalyticsVisitor(active.visitorStorageKey);
    }
    active.visitorIdHash = null;
    active.pendingBytes -= active.pendingEvents.reduce(
      (bytes, event) => bytes + analyticsSnapshotBytes(event),
      0
    );
    active.pendingEvents = [];
  }

  private invalidate(active: BrowserAnalyticsActiveConfig): void {
    active.generation += 1;
    this.host.revoke();
    this.clearStandardVisitor(active);
    active.visitorStorageKey = null;
    active.visitorInitializationPending = false;
    active.pendingCaptures = [];
    active.pendingBytes = 0;
    active.userIdHash = null;
    active.context = {};
    active.sessionId = createBrowserTraceId();
    active.sessionStartedAtMs = Date.now();
    active.sessionPageviews = 0;
    this.lastRoute = null;
    this.sessionSummaryCaptured = false;
    this.frictionTracker.reset();
  }

  private flushPendingEvents(active: BrowserAnalyticsActiveConfig): void {
    const pendingEvents = active.pendingEvents;
    active.pendingEvents = [];
    active.pendingBytes -= pendingEvents.reduce(
      (bytes, event) => bytes + analyticsSnapshotBytes(event),
      0
    );
    if (!active.enabled || !active.consentGranted) {
      return;
    }

    for (const event of pendingEvents) {
      event.correlation.visitor_id_hash = active.visitorIdHash;
      this.host.enqueue(event);
    }
  }

  private setContext(dimensions: Record<string, unknown>): void {
    const active = this.active;
    if (active === null || !this.canCapture()) {
      return;
    }

    const snapshot = this.snapshot(dimensions);
    if (snapshot === null) return;
    if (this.deferCapture({ kind: "context", dimensions: snapshot })) return;
    const authState = snapshot["auth_state"];
    const sanitized = sanitizeAnalyticsCustomDimensions(snapshot);
    if (authState === "anonymous" || authState === "authenticated" || authState === "unknown") {
      sanitized["auth_state"] = authState;
    }

    const merged = sanitizeAnalyticsCustomDimensions({
      ...active.context,
      ...sanitized
    });
    const effectiveAuthState = sanitized["auth_state"] ?? active.context["auth_state"];
    if (
      effectiveAuthState === "anonymous" ||
      effectiveAuthState === "authenticated" ||
      effectiveAuthState === "unknown"
    ) {
      merged["auth_state"] = effectiveAuthState;
    }
    active.context = merged;
  }

  private setUserHash(value: unknown): void {
    if (!this.canCapture() || this.active === null) return;
    const hash =
      this.active.privacyMode !== "strict" && typeof value === "string" && HASH_PATTERN.test(value)
        ? value.toLowerCase()
        : null;
    if (this.deferCapture({ kind: "user", hash })) return;
    this.active.userIdHash = hash;
  }

  private captureStructuralKey(actionKey: string): void {
    if (!this.canCapture() || !this.shouldCaptureStructuralActions()) return;
    if (this.deferCapture({ kind: "structural", actionKey })) return;
    this.enqueue("action", { action_key: actionKey }, this.lastRoute, {});
  }

  /** Queue only bounded SDK-owned primitives; a full queue still counts as deferred. */
  private deferCapture(capture: PendingCapture): boolean {
    const active = this.active;
    if (active === null || !active.enabled || !active.consentGranted) return true;
    if (active.captureReady) return false;
    const bytes = analyticsSnapshotBytes(capture);
    if (
      active.pendingCaptures.length + active.pendingEvents.length < MAX_PENDING_STANDARD_EVENTS &&
      active.pendingBytes + bytes <= MAX_PENDING_BYTES
    ) {
      active.pendingCaptures.push(capture);
      active.pendingBytes += bytes;
    }
    return true;
  }

  private executeCapture(capture: PendingCapture): void {
    switch (capture.kind) {
      case "page":
        this.capturePageView(capture.input, capture.eventKind);
        break;
      case "signal":
        this.captureSignal(capture.eventKind, capture.signal, capture.dimensions);
        break;
      case "context":
        this.setContext(capture.dimensions);
        break;
      case "user":
        this.setUserHash(capture.hash);
        break;
      case "structural":
        this.captureStructuralKey(capture.actionKey);
        break;
    }
  }

  private canCapture(): boolean {
    const active = this.active;
    return (
      active !== null &&
      active.enabled &&
      active.consentGranted &&
      this.host.canCapture() &&
      active.pendingCaptures.length + active.pendingEvents.length < MAX_PENDING_STANDARD_EVENTS &&
      active.pendingBytes < MAX_PENDING_BYTES
    );
  }

  private snapshot(value: unknown): Record<string, unknown> | null {
    return snapshotAnalyticsInput(value, this.host.getConfig()?.redactFields ?? []);
  }
}
