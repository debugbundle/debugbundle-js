import {
  createBrowserTraceId,
  normalizeSampleRate
} from "./runtime.js";
import { BrowserAnalyticsFrictionTracker } from "./analytics-friction.js";
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
  type DebugBundleBrowserAnalyticsConfig,
  type DebugBundleBrowserAnalyticsPageViewInput
} from "./types.js";

const ANALYTICS_EVENT_SCHEMA_VERSION = "2026-07-analytics-01";
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const MAX_PENDING_STANDARD_EVENTS = 16;

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
  pendingCaptures: Array<() => void>;
  visitorIdHash: string | null;
  visitorStorageKey: string | null;
  visitorInitializationPending: boolean;
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
    }
  ) {}

  public readonly api: DebugBundleBrowserAnalytics = {
    setConsent: (value) => {
      if (this.active !== null) {
        this.active.consentGranted = value;
        this.active.consentExplicitlySet = true;
        if (!value) {
          this.clearStandardVisitor(this.active);
        } else if (this.active.captureReady) {
          void this.initializeStandardVisitor(this.active);
        }
      }
    },
    pageView: (input = {}) => {
      this.captureWhenReady(() => this.capturePageView(input, "page_view"));
    },
    track: (name, dimensions = {}) => {
      this.captureWhenReady(() => this.captureSignal("action", { action_key: name }, dimensions));
    },
    funnel: (name, step, dimensions = {}) => {
      this.captureWhenReady(() => this.captureSignal("funnel_step", { funnel_key: name, step_key: step }, dimensions));
    },
    convert: (name, dimensions = {}) => {
      this.captureWhenReady(() => this.captureSignal("conversion", { conversion_key: name }, dimensions));
    },
    marker: (name, dimensions = {}) => {
      this.captureWhenReady(() => this.captureSignal("journey_marker", { marker_key: name }, dimensions));
    },
    setContext: (dimensions) => {
      this.captureWhenReady(() => this.setContext(dimensions));
    },
    setUserHash: (hash) => {
      this.captureWhenReady(() => {
        if (this.active === null) {
          return;
        }
        this.active.userIdHash =
          this.active.privacyMode !== "strict" && typeof hash === "string" && HASH_PATTERN.test(hash)
            ? hash.toLowerCase()
            : null;
      });
    }
  };

  public configure(
    config: DebugBundleBrowserAnalyticsConfig | undefined,
    options: { deferCapture?: boolean } = {}
  ): void {
    this.sessionSummaryCaptured = false;
    const enabled = config?.enabled === true;
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
      visitorIdHash: null,
      visitorStorageKey: null,
      visitorInitializationPending: false,
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
    const pendingCaptures = active.pendingCaptures;
    active.pendingCaptures = [];
    this.captureSessionStart();
    this.captureInitialPageView();
    for (const capture of pendingCaptures) {
      capture();
    }
  }

  public reset(): void {
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
    this.captureWhenReady(() => {
      if (this.active?.trackRouteChanges === true) {
        this.capturePageView({ path }, "route_change");
      }
    });
  }

  public applyRemoteSettings(remote: BrowserRemoteAnalyticsConfig): void {
    const active = this.active;
    if (active === null) {
      return;
    }

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
    return this.active?.enabled === true && this.active.trackActions && this.active.captureActions && this.active.consentGranted;
  }

  public shouldCaptureFrictionSignals(): boolean {
    return this.active?.enabled === true && this.active.trackFrictionSignals && this.active.consentGranted;
  }

  public captureStructuralAction(target: Record<string, unknown>): void {
    if (!this.shouldCaptureStructuralActions()) {
      return;
    }

    const actionKey = getStructuralActionKey(target);
    if (actionKey === null) {
      return;
    }

    this.captureWhenReady(() => {
      if (this.shouldCaptureStructuralActions()) {
        this.enqueue("action", { action_key: actionKey }, this.lastRoute, {});
      }
    });
  }

  public captureFrictionClick(target: Record<string, unknown>, targetIdentity: unknown): void {
    if (!this.shouldCaptureFrictionSignals() || targetIdentity === null || typeof targetIdentity !== "object") {
      return;
    }

    this.captureWhenReady(() => {
      if (!this.shouldCaptureFrictionSignals()) {
        return;
      }
      const markerKey = this.frictionTracker.recordClick(
        targetIdentity,
        getStructuralActionKey(target) !== null,
        isDeadClickCandidate(target),
        Date.now()
      );
      if (markerKey !== null) {
        this.enqueue("journey_marker", { marker_key: markerKey }, this.lastRoute, {});
      }
    });
  }

  private capturePageView(input: DebugBundleBrowserAnalyticsPageViewInput, kind: "page_view" | "route_change"): void {
    const route = normalizeAnalyticsRoute(input.path ?? this.host.getCurrentRoute(), input.title ?? null);
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
    kind: Extract<BrowserAnalyticsEventKind, "action" | "funnel_step" | "conversion" | "journey_marker">,
    signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>,
    dimensions: Record<string, unknown>
  ): void {
    if (kind === "action" && this.active?.captureActions !== true) {
      return;
    }

    const normalizedSignal = normalizeAnalyticsSignal(signal);
    if (
      (kind === "action" && normalizedSignal.action_key === null) ||
      (kind === "funnel_step" && (normalizedSignal.funnel_key === null || normalizedSignal.step_key === null)) ||
      (kind === "conversion" && normalizedSignal.conversion_key === null) ||
      (kind === "journey_marker" && normalizedSignal.marker_key === null)
    ) {
      return;
    }

    this.enqueue(
      kind,
      normalizedSignal,
      kind === "journey_marker" ? this.lastRoute : null,
      sanitizeAnalyticsCustomDimensions(dimensions)
    );
  }

  private enqueue(
    kind: BrowserAnalyticsEventKind,
    signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>,
    route: BrowserAnalyticsEventEnvelope["payload"]["route"],
    dimensions: BrowserAnalyticsCustomDimensions,
    previousRoute: BrowserAnalyticsEventEnvelope["payload"]["route"] = null
  ): boolean {
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
                duration_ms: Math.min(86_400_000, Math.max(0, Date.now() - active.sessionStartedAtMs)),
                pageviews: active.sessionPageviews
              }
            }
          : {}),
        signal: normalizeAnalyticsSignal(signal),
        route,
        ...(previousRoute !== null ? { previous_route: previousRoute } : {}),
        dimensions: buildAnalyticsDimensions(this.host.getDeviceInfo(), active.trackReferrers, mergedDimensions),
        custom_dimensions: omitBuiltInAnalyticsDimensions(mergedDimensions)
      }
    };

    if (active.visitorInitializationPending) {
      if (active.pendingEvents.length < MAX_PENDING_STANDARD_EVENTS) {
        active.pendingEvents.push(event);
      }
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
    try {
      const visitor = await resolveStandardAnalyticsVisitor(projectToken);
      if (visitor === null) {
        return;
      }
      active.visitorStorageKey = visitor.storageKey;
      if (this.active !== active || active.privacyMode !== "standard" || !active.consentGranted) {
        removeStoredAnalyticsVisitor(visitor.storageKey);
        return;
      }
      if (this.active === active && active.privacyMode === "standard" && active.consentGranted) {
        active.visitorIdHash = visitor.visitorIdHash;
      }
    } catch {
      // Browser storage and crypto APIs are optional; analytics falls back to session-only.
    } finally {
      if (this.active === active) {
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
    active.pendingEvents = [];
  }

  private flushPendingEvents(active: BrowserAnalyticsActiveConfig): void {
    const pendingEvents = active.pendingEvents;
    active.pendingEvents = [];
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
    if (active === null) {
      return;
    }

    const authState = dimensions["auth_state"];
    const sanitized = sanitizeAnalyticsCustomDimensions(dimensions);
    if (authState === "anonymous" || authState === "authenticated" || authState === "unknown") {
      sanitized["auth_state"] = authState;
    }

    active.context = {
      ...active.context,
      ...sanitized
    };
  }

  private captureWhenReady(capture: () => void): void {
    const active = this.active;
    if (active === null) {
      return;
    }
    if (active.captureReady) {
      capture();
      return;
    }
    if (active.pendingCaptures.length < MAX_PENDING_STANDARD_EVENTS) {
      active.pendingCaptures.push(capture);
    }
  }
}
