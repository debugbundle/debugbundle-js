import {
  createBrowserTraceId,
  getDocumentSource,
  getLocationSource,
  normalizeSampleRate
} from "./runtime.js";
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

interface BrowserAnalyticsActiveConfig {
  enabled: boolean;
  privacyMode: BrowserAnalyticsPrivacyMode;
  consentRequired: boolean;
  consentGranted: boolean;
  trackPageViews: boolean;
  trackRouteChanges: boolean;
  trackSessions: boolean;
  trackReferrers: boolean;
  trackActions: boolean;
  sampleRate: number;
  sessionId: string;
  userIdHash: string | null;
  context: BrowserAnalyticsCustomDimensions;
}

export class BrowserAnalyticsController {
  private active: BrowserAnalyticsActiveConfig | null = null;
  private lastRoute: BrowserAnalyticsEventEnvelope["payload"]["route"] = null;
  private sessionSummaryCaptured = false;

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
      trackPageViews: config?.trackPageViews !== false,
      trackRouteChanges: config?.trackRouteChanges !== false,
      trackSessions: config?.trackSessions !== false,
      trackReferrers: config?.trackReferrers !== false,
      trackActions: config?.trackActions === true,
      sampleRate,
      sessionId: createBrowserTraceId(),
      userIdHash: null,
      context: {}
    };
    this.lastRoute = null;
  }

  public reset(): void {
    this.active = null;
    this.lastRoute = null;
    this.sessionSummaryCaptured = false;
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

  public shouldCaptureStructuralActions(): boolean {
    return this.active?.trackActions === true && this.active.consentGranted;
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

  private capturePageView(input: DebugBundleBrowserAnalyticsPageViewInput, kind: "page_view" | "route_change"): void {
    const route = normalizeRoute(input.path ?? this.host.getCurrentRoute(), input.title ?? null);
    if (route === null) {
      return;
    }

    const previousRoute = kind === "route_change" ? this.lastRoute : null;
    if (this.enqueue(kind, {}, route, {}, previousRoute)) {
      this.lastRoute = route;
    }
  }

  private captureSignal(
    kind: Extract<BrowserAnalyticsEventKind, "action" | "funnel_step" | "conversion" | "journey_marker">,
    signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>,
    dimensions: Record<string, unknown>
  ): void {
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
        visitor_id_hash: null,
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

    this.host.enqueue(event);
    return true;
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
