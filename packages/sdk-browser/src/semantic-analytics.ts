import { sanitizeTelemetry } from "@debugbundle/redaction";
import {
  AnalyticsCapabilitiesSchema,
  MAX_SEMANTIC_ANALYTICS_EVENT_BYTES,
  SEMANTIC_ANALYTICS_SCHEMA_VERSION,
  SemanticAnalyticsEventSchema,
  type AnalyticsCapabilities,
  type SemanticAnalyticsEvent
} from "@debugbundle/shared-types";
import { getCryptoSource, getDocumentSource, getLocationSource, normalizeSampleRate } from "./runtime.js";
import { buildAnalyticsDimensions, getStructuralActionKey, isDeadClickCandidate } from "./analytics-normalization.js";
import { BrowserAnalyticsFrictionTracker } from "./analytics-friction.js";
import { SDK_NAME, SDK_VERSION, type ActiveConfig, type BrowserRemoteAnalyticsConfig,
  type BrowserDeviceInfo, type DebugBundleBrowserAnalyticsConfig,
  type DebugBundleBrowserAnalyticsPageViewInput } from "./types.js";

export interface SemanticBrowserTrackOptions {
  eventRevision: number;
  eventId?: string;
  occurredAt?: string;
}

export interface SemanticBrowserStatus {
  state: "unsupported" | "pending" | "enabled" | "consent_required" | "sampled_out" | "expired" | "unavailable";
  pending_events: number;
  pending_bytes: number;
  last_receipt: { accepted: number; retryable: number; terminal: number } | null;
}

interface PendingSemanticCapture {
  name: string;
  properties: Record<string, unknown>;
  options: SemanticBrowserTrackOptions;
  bytes: number;
}

const MAX_PENDING_EVENTS = 16;
const MAX_PENDING_BYTES = 64 * 1024;
const MIN_REFRESH_INTERVAL_MS = 60_000;
const AUTOMATIC_EVENT_NAMES = {
  session_start: "session.start", page_view: "page.view",
  route_change: "route.change", session_summary: "session.summary"
} as const;
type AutomaticKind = keyof typeof AUTOMATIC_EVENT_NAMES;
type SafeRoute = { normalized_path: string };
const STATIC_ROUTE_PATTERN = /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/;
const BROWSER_FAMILIES: Record<string, string> = { Chrome: "chrome", Firefox: "firefox", Safari: "safari" };
const OS_FAMILIES: Record<string, string> = { macOS: "macos", Windows: "windows", Android: "android", iOS: "ios" };

function buildSemanticClient(device: BrowserDeviceInfo | null): SemanticAnalyticsEvent["payload"]["client"] {
  const dimensions = buildAnalyticsDimensions(device, false, {});
  const major = (value: number | null): number | null => value !== null && value <= 10_000 ? value : null;
  return {
    auth_state: "anonymous", device_type: dimensions.device_type,
    browser_family: BROWSER_FAMILIES[dimensions.browser_family ?? ""] ?? null,
    browser_major: major(dimensions.browser_major),
    os_family: OS_FAMILIES[dimensions.os_family ?? ""] ?? null,
    os_major: major(dimensions.os_major),
    language: dimensions.language, locale: dimensions.locale,
    viewport_bucket: dimensions.viewport_bucket
  };
}

function buildSemanticAcquisition(device: BrowserDeviceInfo | null, landingRoute: SafeRoute | null):
  SemanticAnalyticsEvent["payload"]["acquisition"] {
  const dimensions = buildAnalyticsDimensions(device, true, {});
  const campaign = (value: string | null): string | null =>
    value !== null && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
  const domain = dimensions.referrer_domain?.toLowerCase() ?? null;
  const labels = domain?.split(".") ?? [];
  const safeDomain = domain !== null && domain.length <= 253 && labels.length >= 2 &&
    !/^[0-9.]+$/.test(domain) && labels.every((label) =>
      label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) ? domain : null;
  return {
    landing_route: landingRoute, referrer_domain: safeDomain,
    utm_source: campaign(dimensions.utm_source),
    utm_medium: campaign(dimensions.utm_medium),
    utm_campaign: campaign(dimensions.utm_campaign)
  };
}

function sampleSession(projectId: string, sessionId: string, sampleRate: number): boolean {
  if (sampleRate >= 1) return true;
  if (sampleRate <= 0) return false;
  let hash = 0x811c9dc5;
  for (const char of `${projectId}:${sessionId}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000 < sampleRate;
}

function monotonicNow(): number | null {
  try {
    const value = globalThis.performance.now();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

/** First direct-client V2 lane; unknown or expired authority never admits caller-owned input. */
export class BrowserSemanticAnalyticsController {
  private config: ActiveConfig | null = null;
  private capability: AnalyticsCapabilities | null = null;
  private capabilityLease: { startedAt: number; lifetimeMs: number } | null = null;
  private consentGranted = false;
  private consentExplicitlySet = false;
  private remoteEnabled = true;
  private remoteCaptureActions = true;
  private remoteCaptureFrictionSignals = true;
  private remoteCapturePageViews = true;
  private remoteCaptureRouteChanges = true;
  private trackSessions = false;
  private trackPageViews = false;
  private trackRouteChanges = false;
  private trackReferrers = false;
  private trackActions = false;
  private trackFrictionSignals = false;
  private localSampleRate = 1;
  private acquisitionSent = false;
  private acquisitionEventId: string | null = null;
  private lastReceipt: SemanticBrowserStatus["last_receipt"] = null;
  private initialAcquisition: SemanticAnalyticsEvent["payload"]["acquisition"] = null;
  private acquisitionCaptured = false;
  private allowedRoutes = new Set<string>();
  private initialCaptureRequested = false;
  private initialCaptured = false;
  private sessionStartedAtMs: number | null = null;
  private activeSinceMs: number | null = null;
  private activeDurationMs = 0;
  private sessionViews = 0;
  private sessionSummaryCaptured = false;
  private lastRoute: SafeRoute | null = null;
  private sampledIn = false;
  private unavailable = false;
  private pending: PendingSemanticCapture[] = [];
  private pendingBytes = 0;
  private pendingTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRefreshRequestedAt = 0;
  private readonly frictionTracker = new BrowserAnalyticsFrictionTracker();

  public constructor(private readonly host: {
    getSessionId(): string;
    getDeviceInfo(): BrowserDeviceInfo | null;
    canCapture(): boolean;
    canReservePending(count: number, bytes: number): boolean;
    enqueue(event: SemanticAnalyticsEvent): boolean;
    revoke(): void;
    requestCapabilityRefresh(): void;
  }) {}

  public configure(config: ActiveConfig | null, analytics?: DebugBundleBrowserAnalyticsConfig): void {
    this.config = config?.requestsSemanticAnalyticsConfig === true && config.transportMode === "direct"
      ? config : null;
    this.capability = null;
    this.capabilityLease = null;
    this.consentGranted = analytics?.consentRequired !== true;
    this.consentExplicitlySet = false;
    this.remoteEnabled = true;
    this.remoteCaptureActions = true;
    this.remoteCaptureFrictionSignals = true;
    this.remoteCapturePageViews = true;
    this.remoteCaptureRouteChanges = true;
    this.trackSessions = analytics?.trackSessions === true;
    this.trackPageViews = analytics?.trackPageViews === true;
    this.trackRouteChanges = analytics?.trackRouteChanges === true;
    this.trackReferrers = analytics?.trackReferrers === true;
    this.trackActions = analytics?.trackActions === true;
    this.trackFrictionSignals = analytics?.trackFrictionSignals === true;
    this.localSampleRate = normalizeSampleRate(analytics?.sampleRate, 1);
    this.acquisitionSent = false;
    this.acquisitionEventId = null;
    this.lastReceipt = null;
    this.initialAcquisition = null;
    this.acquisitionCaptured = false;
    try {
      const routes = analytics?.routeTemplates;
      this.allowedRoutes = new Set(Array.isArray(routes) ? routes.slice(0, 32).filter((route) =>
        typeof route === "string" && route.length <= 128 && STATIC_ROUTE_PATTERN.test(route)) : []);
    } catch {
      this.allowedRoutes = new Set();
    }
    this.resetLifecycle();
    this.sampledIn = false;
    this.unavailable = false;
    this.lastRefreshRequestedAt = Date.now();
    this.clearPending();
  }

  public reset(): void {
    this.config = null;
    this.capability = null;
    this.capabilityLease = null;
    this.consentGranted = false;
    this.consentExplicitlySet = false;
    this.remoteEnabled = true;
    this.remoteCaptureActions = true;
    this.remoteCaptureFrictionSignals = true;
    this.remoteCapturePageViews = true;
    this.remoteCaptureRouteChanges = true;
    this.allowedRoutes.clear();
    this.trackReferrers = false;
    this.trackActions = false;
    this.trackFrictionSignals = false;
    this.localSampleRate = 1;
    this.acquisitionSent = false;
    this.acquisitionEventId = null;
    this.lastReceipt = null;
    this.initialAcquisition = null;
    this.acquisitionCaptured = false;
    this.resetLifecycle();
    this.sampledIn = false;
    this.unavailable = false;
    this.clearPending();
  }

  public setConsent(granted: boolean): void {
    if (typeof granted !== "boolean" || this.config === null) return;
    this.consentGranted = granted;
    this.consentExplicitlySet = true;
    if (!granted) {
      this.clearPending();
      this.host.revoke();
      this.resetLifecycle();
    } else if (!this.initialCaptured) {
      this.captureInitialLifecycle();
    }
  }

  public applyRemoteSettings(remote: BrowserRemoteAnalyticsConfig): void {
    if (this.config === null) return;
    const tightened =
      (this.remoteEnabled && !remote.enabled) ||
      (this.remoteCaptureActions && !remote.captureActions) ||
      (this.remoteCaptureFrictionSignals && !remote.captureFrictionSignals) ||
      (this.remoteCapturePageViews && !remote.capturePageViews) ||
      (this.remoteCaptureRouteChanges && !remote.captureRouteChanges) ||
      (remote.consentRequired && !this.consentExplicitlySet);
    this.remoteEnabled = remote.enabled;
    this.remoteCaptureActions = remote.captureActions;
    this.remoteCaptureFrictionSignals = remote.captureFrictionSignals;
    this.remoteCapturePageViews = remote.capturePageViews;
    this.remoteCaptureRouteChanges = remote.captureRouteChanges;
    if (remote.consentRequired && !this.consentExplicitlySet) this.consentGranted = false;
    if (tightened) {
      this.clearPending();
      this.host.revoke();
      this.resetLifecycle();
    }
    if (remote.enabled && !this.initialCaptured) this.captureInitialLifecycle();
  }

  public getStatus(): SemanticBrowserStatus {
    const capability = this.capability;
    let state: SemanticBrowserStatus["state"];
    if (this.config === null) state = "unsupported";
    else if (!this.remoteEnabled) state = "unavailable";
    else if (!this.consentGranted) state = "consent_required";
    else if (capability === null) state = this.unavailable ? "unavailable" : "pending";
    else if (this.capabilityExpired()) state = "expired";
    else if (capability.consent_required && !this.consentExplicitlySet) state = "consent_required";
    else state = this.sampledIn ? "enabled" : "sampled_out";
    return { state, pending_events: this.pending.length, pending_bytes: this.pendingBytes,
      last_receipt: this.lastReceipt };
  }

  public acceptCapability(payload: unknown): void {
    if (this.config === null) return;
    const raw = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)["analytics_semantic"] : null;
    const parsed = AnalyticsCapabilitiesSchema.safeParse(raw);
    const capability = parsed.success ? parsed.data : null;
    const now = Date.now();
    const elapsedNow = monotonicNow();
    if (capability === null || !capability.enabled || capability.principal !== "project_token" ||
      capability.scope.kind !== "project" || capability.scope.project_id !== capability.project_id ||
      !capability.allowed_producers.includes("browser") ||
      !capability.allowed_purposes.includes("product_analytics") ||
      capability.privacy_mode !== "strict" || elapsedNow === null ||
      Date.parse(capability.server_time) > now + 300_000 ||
      Date.parse(capability.expires_at) <= now) {
      this.capability = null;
      this.capabilityLease = null;
      this.unavailable = true;
      this.clearPending();
      this.host.revoke();
      this.frictionTracker.reset();
      this.acquisitionSent = false;
      this.acquisitionEventId = null;
      this.initialAcquisition = null;
      this.acquisitionCaptured = false;
      return;
    }
    const previous = this.capability;
    const retainSampleDecision = previous !== null &&
      previous.project_id === capability.project_id &&
      previous.scope_revision === capability.scope_revision &&
      previous.sample_rate === capability.sample_rate;
    if (previous !== null &&
      (previous.project_id !== capability.project_id ||
        previous.scope_revision !== capability.scope_revision ||
        previous.catalog_revision !== capability.catalog_revision)) {
      this.host.revoke();
      this.frictionTracker.reset();
      this.acquisitionSent = false;
      this.acquisitionEventId = null;
      this.initialAcquisition = null;
      this.acquisitionCaptured = false;
    }
    this.capability = capability;
    this.capabilityLease = {
      startedAt: elapsedNow,
      lifetimeMs: Math.min(300_000, Date.parse(capability.expires_at) - now)
    };
    this.unavailable = false;
    this.config.semanticBatchEvents = capability.max_batch_events;
    this.config.semanticBatchBytes = capability.max_batch_bytes;
    if (!retainSampleDecision)
      this.sampledIn = sampleSession(capability.project_id, this.host.getSessionId(),
        Math.min(this.localSampleRate, capability.sample_rate));
    this.captureInitialAcquisition();
    const pending = this.pending;
    this.clearPending();
    for (const capture of pending) this.track(capture.name, capture.properties, capture.options);
    if (this.initialCaptureRequested && !this.initialCaptured) this.captureInitialLifecycle();
  }

  public captureInitialLifecycle(): void {
    this.initialCaptureRequested = true;
    if (this.initialCaptured || !this.canCaptureNow() || !this.host.canCapture()) return;
    this.initialCaptured = true;
    this.captureInitialAcquisition();
    try {
      const now = Date.now();
      if (this.trackSessions && this.emitAutomatic("session_start", null, null, null)) {
        this.sessionStartedAtMs = now;
        this.activeSinceMs = getDocumentSource()?.visibilityState === "hidden" ? null : now;
      }
      const route = this.safeRoute(getLocationSource()?.pathname);
      this.lastRoute = route;
      if (this.trackPageViews && this.remoteCapturePageViews && route !== null &&
        this.emitAutomatic("page_view", route, null, null)) this.sessionViews += 1;
    } catch {
      // A hostile browser global cannot escape from automatic SDK capture.
    }
  }

  public captureRouteChange(url?: string | URL | null): void {
    if (!this.trackRouteChanges || !this.remoteCaptureRouteChanges || !this.canCaptureNow() ||
      !this.host.canCapture()) return;
    const route = this.safeRoute(this.routePath(url));
    if (route === null || route.normalized_path === this.lastRoute?.normalized_path) return;
    const previousRoute = this.lastRoute;
    if (this.emitAutomatic("route_change", route, previousRoute, null)) {
      this.lastRoute = route;
      this.sessionViews += 1;
      if (this.shouldCaptureFrictionSignals()) {
        const marker = this.frictionTracker.recordRouteTransition(
          previousRoute?.normalized_path ?? null, route.normalized_path, Date.now());
        if (marker !== null) this.emitFrictionMarker(marker);
      }
    }
  }

  public pageView(input: DebugBundleBrowserAnalyticsPageViewInput = {}): void {
    if (!this.remoteCapturePageViews || !this.canCaptureNow() || !this.host.canCapture()) return;
    try {
      const requestedPath = input.path;
      const route = this.safeRoute(requestedPath === undefined ? getLocationSource()?.pathname : requestedPath);
      if (route === null) return;
      if (this.emitAutomatic("page_view", route, null, null)) {
        this.lastRoute = route;
        this.sessionViews += 1;
      }
    } catch {
      // Explicit page input must not throw into the host or expose a page title.
    }
  }

  public shouldCaptureStructuralActions(): boolean {
    return this.trackActions && this.remoteCaptureActions && this.canCaptureNow() && this.host.canCapture();
  }

  public captureStructuralAction(target: Record<string, unknown>): void {
    if (!this.shouldCaptureStructuralActions()) return;
    try {
      const name = getStructuralActionKey(target);
      if (name === null) return;
      this.emitFact({ kind: "semantic", name, eventRevision: 1, properties: {},
        eventId: getCryptoSource()?.randomUUID?.(), occurredAt: new Date().toISOString(),
        route: this.lastRoute, previousRoute: null, session: null });
    } catch {
      // Native target access and automatic capture cannot escape into the page.
    }
  }

  public shouldCaptureFrictionSignals(): boolean {
    return this.trackFrictionSignals && this.remoteCaptureFrictionSignals &&
      this.canCaptureNow() && this.host.canCapture();
  }

  public captureFrictionClick(target: Record<string, unknown>, targetIdentity: unknown): void {
    if (!this.shouldCaptureFrictionSignals()) return;
    try {
      const marker = this.frictionTracker.recordClick(targetIdentity,
        getStructuralActionKey(target) !== null, isDeadClickCandidate(target), Date.now());
      if (marker !== null) this.emitFrictionMarker(marker);
    } catch {
      // Native targets and friction heuristics cannot escape into the page.
    }
  }

  private emitFrictionMarker(name: string): void {
    this.emitFact({ kind: "journey_marker", name, eventRevision: 1, properties: {},
      eventId: getCryptoSource()?.randomUUID?.(), occurredAt: new Date().toISOString(),
      route: this.lastRoute, previousRoute: null, session: null });
  }

  public captureVisibilityChange(visibility: string | undefined): void {
    if (this.sessionStartedAtMs === null || this.sessionSummaryCaptured) return;
    const now = Date.now();
    if (visibility === "hidden") {
      if (this.activeSinceMs !== null) this.activeDurationMs += Math.max(0, now - this.activeSinceMs);
      this.activeSinceMs = null;
    } else if (visibility === "visible" && this.activeSinceMs === null) this.activeSinceMs = now;
  }

  public captureSessionSummary(): void {
    if (this.sessionStartedAtMs === null || this.sessionSummaryCaptured || !this.canCaptureNow() ||
      !this.host.canCapture()) return;
    const now = Date.now();
    const duration = Math.min(86_400_000, Math.max(0, now - this.sessionStartedAtMs));
    const active = Math.min(duration, this.activeDurationMs +
      (this.activeSinceMs === null ? 0 : Math.max(0, now - this.activeSinceMs)));
    if (this.emitAutomatic("session_summary", this.lastRoute, null, {
      duration_ms: duration, active_duration_ms: active, views: this.sessionViews
    })) this.sessionSummaryCaptured = true;
  }

  public beforeDispatch(): void {
    if (this.config !== null && !this.canCaptureNow()) {
      this.host.revoke();
      if (this.capability !== null && this.capabilityExpired())
        this.refreshIfDue();
    }
  }

  public track(name: string, properties: Record<string, unknown> = {}, options?: SemanticBrowserTrackOptions): void {
    const config = this.config;
    const capability = this.capability;
    if (config === null || !this.remoteEnabled || !this.remoteCaptureActions || !this.consentGranted) return;
    if (capability === null) {
      if (this.unavailable) this.refreshIfDue();
      else {
        this.retainPending(name, properties, options);
        this.refreshIfDue();
      }
      return;
    }
    if (!this.canCaptureNow()) {
      if (this.sampledIn && (!capability.consent_required || this.consentExplicitlySet) &&
        this.capabilityExpired()) {
        this.host.revoke();
        this.retainPending(name, properties, options);
        this.refreshIfDue();
      }
      return;
    }
    if (!this.host.canCapture()) return;
    if (typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(name)) return;
    try {
      const safeOptions = sanitizeTelemetry(options ?? {}, { maxTotalBytes: 1024 });
      if (!safeOptions.ok || safeOptions.value === null || Array.isArray(safeOptions.value) ||
        typeof safeOptions.value !== "object") return;
      const selected = safeOptions.value as Record<string, unknown>;
      if (Object.keys(selected).some((key) => !["eventRevision", "eventId", "occurredAt"].includes(key)) ||
        !Number.isSafeInteger(selected["eventRevision"]) || Number(selected["eventRevision"]) < 1) return;
      const safeProperties = sanitizeTelemetry(properties, {
        additionalKeys: config.redactFields, maxTotalBytes: MAX_SEMANTIC_ANALYTICS_EVENT_BYTES
      });
      if (!safeProperties.ok || safeProperties.value === null || Array.isArray(safeProperties.value) ||
        typeof safeProperties.value !== "object" ||
        Object.keys(safeProperties.value).length > capability.max_properties) return;
      const now = Date.now();
      const occurredAt = selected["occurredAt"] ?? new Date(now).toISOString();
      const occurredMs = typeof occurredAt === "string" ? Date.parse(occurredAt) : Number.NaN;
      if (!Number.isFinite(occurredMs) || occurredMs < now - Math.min(86_400, capability.max_event_age_seconds) * 1000 ||
        occurredMs > now + 300_000) return;
      const eventId = selected["eventId"] ?? getCryptoSource()?.randomUUID?.();
      this.emitFact({ kind: "semantic", name, eventRevision: Number(selected["eventRevision"]),
        properties: safeProperties.value as Record<string, unknown>, eventId, occurredAt,
        route: null, previousRoute: null, session: null });
    } catch {
      // Caller-owned getters, proxies and malformed values cannot escape into the page.
    }
  }

  private emitAutomatic(kind: AutomaticKind, route: SafeRoute | null, previousRoute: SafeRoute | null,
    session: SemanticAnalyticsEvent["payload"]["session"]): boolean {
    try {
      return this.emitFact({ kind, name: AUTOMATIC_EVENT_NAMES[kind], eventRevision: 1,
        properties: {}, eventId: getCryptoSource()?.randomUUID?.(), occurredAt: new Date().toISOString(),
        route, previousRoute, session });
    } catch {
      return false;
    }
  }

  private emitFact(input: {
    kind: SemanticAnalyticsEvent["payload"]["kind"];
    name: string;
    eventRevision: number;
    properties: Record<string, unknown>;
    eventId: unknown;
    occurredAt: unknown;
    route: SafeRoute | null;
    previousRoute: SafeRoute | null;
    session: SemanticAnalyticsEvent["payload"]["session"];
  }): boolean {
    const config = this.config;
    const capability = this.capability;
    if (config === null || capability === null || !this.canCaptureNow() || !this.host.canCapture()) return false;
    try {
      this.captureInitialAcquisition();
      const acquisition = this.trackReferrers && !this.acquisitionSent
        ? this.initialAcquisition
        : null;
      const parsed = SemanticAnalyticsEventSchema.safeParse({
        schema_version: SEMANTIC_ANALYTICS_SCHEMA_VERSION,
        event_type: "analytics_event",
        event_id: input.eventId,
        occurred_at: input.occurredAt,
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: { name: config.service, runtime: "browser", framework: null, environment: config.environment },
        producer: { kind: "browser", stream_id: null, sequence: null },
        operation_id: null,
        correlation: {
          session_id: this.host.getSessionId(), anonymous_id_hash: null, user_id_hash: null,
          account_id_hash: null, namespace_revision: null, trace_id: null, deploy_id: null
        },
        payload: {
          kind: input.kind, name: input.name, event_revision: input.eventRevision,
          purpose: "product_analytics", privacy: { mode: "strict", consent_granted: true },
          route: input.route, previous_route: input.previousRoute, screen: null,
          session: input.session, acquisition, client: buildSemanticClient(this.host.getDeviceInfo()),
          properties: input.properties, measurements: {}, money: null, financial: null
        }
      });
      if (!parsed.success) return false;
      const protectedFields = { service: parsed.data.service, payload: parsed.data.payload };
      const protectedResult = sanitizeTelemetry(protectedFields, { additionalKeys: config.redactFields });
      if (!protectedResult.ok || JSON.stringify(protectedResult.value) !== JSON.stringify(protectedFields)) return false;
      const eventBytes = new TextEncoder().encode(JSON.stringify(parsed.data)).byteLength;
      if (eventBytes > Math.min(MAX_SEMANTIC_ANALYTICS_EVENT_BYTES,
        capability.max_event_bytes, capability.max_batch_bytes - 16)) return false;
      if (!this.host.enqueue(parsed.data)) return false;
      if (acquisition !== null) {
        this.acquisitionSent = true;
        this.acquisitionEventId = parsed.data.event_id;
      }
      return true;
    } catch {
      return false;
    }
  }

  /** An indexed terminal rejection did not deliver the first-touch fact. */
  public onTerminalRejection(eventIds: readonly string[]): void {
    if (this.acquisitionEventId !== null && eventIds.includes(this.acquisitionEventId)) {
      this.acquisitionSent = false;
      this.acquisitionEventId = null;
    }
  }

  /** Last valid indexed ACK counts only; this is local transport evidence, not source verification. */
  public onReceipt(receipt: { accepted: number; retryable: number; terminal: number }): void {
    this.lastReceipt = { ...receipt };
  }

  private safeRoute(path: string | null | undefined): SafeRoute | null {
    return typeof path === "string" && this.allowedRoutes.has(path) ? { normalized_path: path } : null;
  }

  private captureInitialAcquisition(): void {
    if (!this.trackReferrers || this.acquisitionCaptured || !this.canCaptureNow() ||
      !this.host.canCapture()) return;
    // Keep the first authorized touch stable through route changes and admission retries.
    this.acquisitionCaptured = true;
    try {
      this.initialAcquisition = buildSemanticAcquisition(this.host.getDeviceInfo(),
        this.safeRoute(getLocationSource()?.pathname));
    } catch {
      this.initialAcquisition = null;
    }
  }

  private routePath(url?: string | URL | null): string | null {
    try {
      const href = getLocationSource()?.href;
      if (typeof href !== "string" || (typeof url === "string" && url.length > 2048)) return null;
      const base = new URL(href);
      const next = new URL(url ?? href, base);
      return next.origin === base.origin ? next.pathname : null;
    } catch {
      return null;
    }
  }

  private resetLifecycle(): void {
    this.frictionTracker.reset();
    this.acquisitionSent = false;
    this.acquisitionEventId = null;
    this.initialAcquisition = null;
    this.acquisitionCaptured = false;
    this.initialCaptureRequested = false;
    this.initialCaptured = false;
    this.sessionStartedAtMs = null;
    this.activeSinceMs = null;
    this.activeDurationMs = 0;
    this.sessionViews = 0;
    this.sessionSummaryCaptured = false;
    this.lastRoute = null;
  }

  private canCaptureNow(): boolean {
    const capability = this.capability;
    return capability !== null && this.remoteEnabled && this.consentGranted && this.sampledIn &&
      (!capability.consent_required || this.consentExplicitlySet) &&
      !this.capabilityExpired();
  }

  private capabilityExpired(): boolean {
    const capability = this.capability;
    const lease = this.capabilityLease;
    if (capability === null || lease === null || Date.parse(capability.expires_at) <= Date.now())
      return true;
    const now = monotonicNow();
    return now === null || now < lease.startedAt || now - lease.startedAt >= lease.lifetimeMs;
  }

  private retainPending(name: string, properties: Record<string, unknown>, options?: SemanticBrowserTrackOptions): void {
    const config = this.config;
    if (config === null || this.pending.length >= MAX_PENDING_EVENTS ||
      typeof name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(name)) return;
    try {
      const safeOptions = sanitizeTelemetry(options ?? {}, { maxTotalBytes: 1024 });
      const safeProperties = sanitizeTelemetry(properties, {
        additionalKeys: config.redactFields, maxTotalBytes: MAX_SEMANTIC_ANALYTICS_EVENT_BYTES
      });
      if (!safeOptions.ok || safeOptions.value === null || Array.isArray(safeOptions.value) ||
        typeof safeOptions.value !== "object" || !safeProperties.ok ||
        safeProperties.value === null || Array.isArray(safeProperties.value) ||
        typeof safeProperties.value !== "object") return;
      const selected = safeOptions.value as Record<string, unknown>;
      if (Object.keys(selected).some((key) => !["eventRevision", "eventId", "occurredAt"].includes(key)) ||
        !Number.isSafeInteger(selected["eventRevision"]) || Number(selected["eventRevision"]) < 1 ||
        Object.keys(safeProperties.value).length > 20) return;
      const eventId = selected["eventId"] ?? getCryptoSource()?.randomUUID?.();
      const occurredAt = selected["occurredAt"] ?? new Date(Date.now()).toISOString();
      if (typeof eventId !== "string" || typeof occurredAt !== "string") return;
      const snapshot: PendingSemanticCapture = {
        name,
        properties: safeProperties.value as Record<string, unknown>,
        options: { eventRevision: Number(selected["eventRevision"]), eventId, occurredAt },
        bytes: 0
      };
      snapshot.bytes = new TextEncoder().encode(JSON.stringify(snapshot)).byteLength;
      if (snapshot.bytes > MAX_SEMANTIC_ANALYTICS_EVENT_BYTES ||
        this.pendingBytes + snapshot.bytes > MAX_PENDING_BYTES ||
        !this.host.canReservePending(this.pending.length + 1, this.pendingBytes + snapshot.bytes)) return;
      this.pending.push(snapshot);
      this.pendingBytes += snapshot.bytes;
      this.pendingTimer ??= setTimeout(() => this.clearPending(), 2_000);
    } catch {
      // Only a protected detached snapshot may enter the short startup window.
    }
  }

  private clearPending(): void {
    if (this.pendingTimer !== null) clearTimeout(this.pendingTimer);
    this.pendingTimer = null;
    this.pending = [];
    this.pendingBytes = 0;
  }

  private refreshIfDue(): void {
    const now = Date.now();
    if (now - this.lastRefreshRequestedAt < MIN_REFRESH_INTERVAL_MS) return;
    this.lastRefreshRequestedAt = now;
    this.host.requestCapabilityRefresh();
  }
}
