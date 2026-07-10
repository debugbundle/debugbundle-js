import {
  createBrowserTraceId,
  getCryptoSource,
  getDocumentSource,
  getLocalStorageSource,
  getLocationSource,
  normalizeSampleRate
} from "./runtime.js";
import { BrowserAnalyticsFrictionTracker } from "./analytics-friction.js";
import {
  SDK_NAME,
  SDK_VERSION,
  type ActiveConfig,
  type BrowserAnalyticsCustomDimensions,
  type BrowserAnalyticsCustomDimensionValue,
  type BrowserAnalyticsDimensions,
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
const MAX_CUSTOM_DIMENSIONS = 8;
const MAX_CUSTOM_KEY_LENGTH = 64;
const MAX_CUSTOM_STRING_LENGTH = 128;
const SIGNAL_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const CUSTOM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/i;
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|authorization|cookie|email|phone|address|card|credit|ssn|user.?id|order.?id|ticket.?id|workspace.?id)/i;
const STRUCTURAL_ACTION_KEYS_BY_TAG: Record<string, string> = {
  a: "click.link",
  button: "click.button",
  input: "click.input",
  select: "click.select",
  summary: "click.summary"
};
const STRUCTURAL_ACTION_KEYS_BY_ROLE: Record<string, string> = {
  button: "click.button",
  checkbox: "click.checkbox",
  link: "click.link",
  menuitem: "click.menuitem",
  radio: "click.radio",
  switch: "click.switch",
  tab: "click.tab"
};
const STRUCTURAL_INPUT_TYPES = new Set(["button", "checkbox", "radio", "reset", "submit"]);
const STANDARD_VISITOR_STORAGE_PREFIX = "debugbundle.analytics.visitor.v1";
const MAX_PENDING_STANDARD_EVENTS = 16;
const NON_FRICTION_CONTROL_TAGS = new Set(["input", "textarea", "select", "option", "label"]);

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
        } else {
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
      if (this.active === null) {
        return;
      }
      this.active.userIdHash = typeof hash === "string" && HASH_PATTERN.test(hash) ? hash.toLowerCase() : null;
    }
  };

  public configure(config: DebugBundleBrowserAnalyticsConfig | undefined): void {
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

    const privacyMode = normalizePrivacyMode(config?.privacyMode);
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
      sessionId: createBrowserTraceId(),
      visitorIdHash: null,
      visitorStorageKey: null,
      visitorInitializationPending: false,
      pendingEvents: [],
      userIdHash: null,
      context: {}
    };
    this.lastRoute = null;
    this.frictionTracker.reset();
    void this.initializeStandardVisitor(this.active);
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
    if (this.active?.trackRouteChanges !== true) {
      return;
    }

    this.capturePageView({ path }, "route_change");
  }

  public applyRemoteSettings(remote: BrowserRemoteAnalyticsConfig): void {
    const active = this.active;
    if (active === null) {
      return;
    }

    active.enabled = active.enabled && remote.enabled;
    if (remote.privacyMode === "strict") {
      active.privacyMode = "strict";
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
    return this.active?.trackActions === true && this.active.captureActions && this.active.consentGranted;
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

    this.enqueue("action", { action_key: actionKey }, this.lastRoute, {});
  }

  public captureFrictionClick(target: Record<string, unknown>, targetIdentity: unknown): void {
    if (!this.shouldCaptureFrictionSignals() || targetIdentity === null || typeof targetIdentity !== "object") {
      return;
    }

    const markerKey = this.frictionTracker.recordClick(
      targetIdentity,
      getStructuralActionKey(target) !== null,
      isDeadClickCandidate(target),
      Date.now()
    );
    if (markerKey === null) {
      return;
    }

    this.enqueue("journey_marker", { marker_key: markerKey }, this.lastRoute, {});
  }

  private capturePageView(input: DebugBundleBrowserAnalyticsPageViewInput, kind: "page_view" | "route_change"): void {
    const route = normalizeRoute(input.path ?? this.host.getCurrentRoute(), input.title ?? null);
    if (route === null) {
      return;
    }

    const previousRoute = kind === "route_change" ? this.lastRoute : null;
    if (this.enqueue(kind, {}, route, {}, previousRoute)) {
      this.lastRoute = route;
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

    const normalizedSignal = normalizeSignal(signal);
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
      sanitizeCustomDimensions(dimensions)
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
      ...getProjectTokenFields(sdkConfig),
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
        signal: normalizeSignal(signal),
        route,
        ...(previousRoute !== null ? { previous_route: previousRoute } : {}),
        dimensions: buildDimensions(this.host.getDeviceInfo(), active, mergedDimensions),
        custom_dimensions: mergedDimensions
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
      const projectScopeHash = await hashAnalyticsValue(projectToken);
      if (projectScopeHash === null) {
        return;
      }

      const storageKey = `${STANDARD_VISITOR_STORAGE_PREFIX}.${projectScopeHash.slice("sha256:".length)}`;
      active.visitorStorageKey = storageKey;
      if (this.active !== active || active.privacyMode !== "standard" || !active.consentGranted) {
        removeStoredVisitor(storageKey);
        return;
      }

      const visitorId = getOrCreateStoredVisitor(storageKey);
      if (visitorId === null) {
        return;
      }

      const visitorIdHash = await hashAnalyticsValue(`${projectScopeHash}:${visitorId}`);
      if (this.active === active && active.privacyMode === "standard" && active.consentGranted) {
        active.visitorIdHash = visitorIdHash;
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
      removeStoredVisitor(active.visitorStorageKey);
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
    const sanitized = sanitizeCustomDimensions(dimensions);
    if (authState === "anonymous" || authState === "authenticated" || authState === "unknown") {
      sanitized["auth_state"] = authState;
    }

    active.context = {
      ...active.context,
      ...sanitized
    };
  }
}

function getOrCreateStoredVisitor(storageKey: string): string | null {
  const storage = getLocalStorageSource();
  if (storage === null) {
    return null;
  }

  try {
    const existing = storage.getItem(storageKey);
    if (isStoredVisitorId(existing)) {
      return existing;
    }

    const visitorId = createBrowserTraceId();
    if (!isStoredVisitorId(visitorId)) {
      return null;
    }
    storage.setItem(storageKey, visitorId);
    return visitorId;
  } catch {
    return null;
  }
}

function removeStoredVisitor(storageKey: string): void {
  try {
    getLocalStorageSource()?.removeItem(storageKey);
  } catch {
    // Storage access must never affect host application behavior.
  }
}

function isStoredVisitorId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9-]{16,128}$/i.test(value);
}

async function hashAnalyticsValue(value: string): Promise<string | null> {
  const cryptoSource = getCryptoSource();
  const TextEncoderConstructor = (globalThis as Record<string, unknown>)["TextEncoder"] as
    | (new () => { encode(input: string): Uint8Array })
    | undefined;
  if (typeof cryptoSource?.subtle?.digest !== "function" || TextEncoderConstructor === undefined) {
    return null;
  }

  const digest = await cryptoSource.subtle.digest("SHA-256", new TextEncoderConstructor().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function normalizePrivacyMode(value: unknown): BrowserAnalyticsPrivacyMode {
  return value === "standard" || value === "custom" ? value : "strict";
}

function getProjectTokenFields(config: ActiveConfig): Record<string, string> {
  return config.projectToken === null ? {} : { project_token: config.projectToken };
}

function normalizeSignal(
  signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>
): BrowserAnalyticsEventEnvelope["payload"]["signal"] {
  return {
    action_key: normalizeSignalKey(signal.action_key),
    funnel_key: normalizeSignalKey(signal.funnel_key),
    step_key: normalizeSignalKey(signal.step_key),
    conversion_key: normalizeSignalKey(signal.conversion_key),
    marker_key: normalizeSignalKey(signal.marker_key)
  };
}

function normalizeSignalKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return SIGNAL_KEY_PATTERN.test(trimmed) && trimmed.length <= 120 ? trimmed : null;
}

function getStructuralActionKey(target: Record<string, unknown>): string | null {
  const role = normalizeStructuralActionValue(target["role"]);
  if (role !== null && STRUCTURAL_ACTION_KEYS_BY_ROLE[role] !== undefined) {
    return STRUCTURAL_ACTION_KEYS_BY_ROLE[role];
  }

  const tagName = normalizeStructuralActionValue(target["tagName"]);
  if (tagName === null) {
    return null;
  }

  if (tagName === "input") {
    const inputType = normalizeStructuralActionValue(target["type"]);
    if (inputType !== null && STRUCTURAL_INPUT_TYPES.has(inputType)) {
      return `click.input.${inputType}`;
    }
  }

  return STRUCTURAL_ACTION_KEYS_BY_TAG[tagName] ?? null;
}

function isDeadClickCandidate(target: Record<string, unknown>): boolean {
  const tagName = normalizeStructuralActionValue(target["tagName"]);
  return tagName !== null && !NON_FRICTION_CONTROL_TAGS.has(tagName);
}

function normalizeStructuralActionValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 32 ? normalized : null;
}

function normalizeRoute(path: string | null | undefined, title: string | null): BrowserAnalyticsEventEnvelope["payload"]["route"] {
  if (typeof path !== "string" || path.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(path, getLocationSource()?.href ?? "https://debugbundle.local");
    return {
      path: parsed.pathname || "/",
      normalized_path: parsed.pathname || "/",
      title: normalizeTitle(title)
    };
  } catch {
    const queryIndex = path.indexOf("?");
    const fragmentIndex = path.indexOf("#");
    const end =
      queryIndex === -1
        ? (fragmentIndex === -1 ? path.length : fragmentIndex)
        : fragmentIndex === -1
          ? queryIndex
          : Math.min(queryIndex, fragmentIndex);
    const normalized = path.slice(0, end).trim();
    return normalized.length > 0
      ? {
          path: normalized.startsWith("/") ? normalized : `/${normalized}`,
          normalized_path: normalized.startsWith("/") ? normalized : `/${normalized}`,
          title: normalizeTitle(title)
        }
      : null;
  }
}

function normalizeTitle(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

function sanitizeCustomDimensions(input: Record<string, unknown>): BrowserAnalyticsCustomDimensions {
  const output: BrowserAnalyticsCustomDimensions = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (Object.keys(output).length >= MAX_CUSTOM_DIMENSIONS) {
      break;
    }

    const key = normalizeCustomDimensionKey(rawKey);
    if (key === null || key === "auth_state") {
      continue;
    }

    const value = normalizeCustomDimensionValue(key, rawValue);
    if (value !== undefined) {
      output[key] = value;
    }
  }

  return output;
}

function normalizeCustomDimensionKey(value: string): string | null {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_CUSTOM_KEY_LENGTH ||
    !CUSTOM_KEY_PATTERN.test(trimmed) ||
    SENSITIVE_KEY_PATTERN.test(trimmed)
  ) {
    return null;
  }

  return trimmed;
}

function normalizeCustomDimensionValue(key: string, value: unknown): BrowserAnalyticsCustomDimensionValue | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= -1_000_000 && value <= 1_000_000) {
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      trimmed.length === 0 ||
      trimmed.length > MAX_CUSTOM_STRING_LENGTH ||
      SENSITIVE_KEY_PATTERN.test(trimmed) ||
      SENSITIVE_KEY_PATTERN.test(key)
    ) {
      return undefined;
    }
    return trimmed;
  }

  return undefined;
}

function buildDimensions(
  device: BrowserDeviceInfo | null,
  active: BrowserAnalyticsActiveConfig,
  customDimensions: BrowserAnalyticsCustomDimensions
): BrowserAnalyticsDimensions {
  const language = normalizeLocale(device?.language ?? null);
  const locationSource = getLocationSource();
  const params = new URLSearchParams(typeof locationSource?.search === "string" ? locationSource.search.replace(/^\?/, "") : "");
  return {
    auth_state: normalizeAuthState(customDimensions["auth_state"]),
    device_type: device?.device_type ?? "unknown",
    browser_family: normalizeDimensionText(device?.browser.name ?? null, 80),
    browser_major: parseMajorVersion(device?.browser.version ?? null),
    os_family: normalizeDimensionText(device?.os.name ?? null, 80),
    os_major: parseMajorVersion(device?.os.version ?? null),
    language,
    locale: language,
    viewport_bucket: getViewportBucket(device),
    referrer_domain: active.trackReferrers ? getReferrerDomain() : null,
    utm_source: normalizeDimensionText(params.get("utm_source"), 128),
    utm_medium: normalizeDimensionText(params.get("utm_medium"), 128),
    utm_campaign: normalizeDimensionText(params.get("utm_campaign"), 128),
    country_code: null,
    region_code: null
  };
}

function normalizeAuthState(value: unknown): BrowserAnalyticsDimensions["auth_state"] {
  return value === "authenticated" || value === "unknown" ? value : "anonymous";
}

function normalizeDimensionText(value: string | null, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function normalizeLocale(value: string | null): string | null {
  const normalized = normalizeDimensionText(value, 35);
  return normalized !== null && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(normalized) ? normalized : null;
}

function parseMajorVersion(value: string | null): number | null {
  const major = typeof value === "string" ? Number.parseInt(value.split(".")[0] ?? "", 10) : Number.NaN;
  return Number.isFinite(major) && major >= 0 ? major : null;
}

function getViewportBucket(device: BrowserDeviceInfo | null): BrowserAnalyticsDimensions["viewport_bucket"] {
  const width = device?.viewport.width ?? 0;
  if (width <= 0) {
    return "unknown";
  }
  if (width < 640) {
    return "small";
  }
  if (width < 1024) {
    return "medium";
  }
  return "large";
}

function getReferrerDomain(): string | null {
  const referrer = getDocumentSource()?.referrer;
  if (typeof referrer !== "string" || referrer.trim().length === 0) {
    return null;
  }

  try {
    const hostname = new URL(referrer).hostname;
    return hostname.length > 0 && hostname.length <= 255 ? hostname : null;
  } catch {
    return null;
  }
}
