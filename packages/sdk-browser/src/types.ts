import packageJson from "../package.json" with { type: "json" };
import type { EventEnvelope } from "@debugbundle/shared-types";
import type { BrowserBeforeSendHook } from "./before-send.js";
export type { EventEnvelope };

export const SDK_NAME = "@debugbundle/sdk-browser";
export const SDK_VERSION = packageJson.version;
export const SDK_SCHEMA_VERSION = "2026-03-01";
export const DEFAULT_ENDPOINT = "https://api.debugbundle.com/v1/events";
export const DEFAULT_RELAY_ENDPOINT = "/debugbundle/browser";
export const DEFAULT_BATCH_SIZE = 10;
export const DEFAULT_FLUSH_INTERVAL_MS = 3_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_MAX_BREADCRUMBS = 10;
export const DEFAULT_SAMPLE_RATE = 1;
export const DEFAULT_SESSION_SAMPLE_RATE = 1;
export const DEFAULT_MAX_EVENTS_PER_SESSION = 100;
export const MAX_BODY_CAPTURE_BYTES = 4_096;
export const LOG_LEVELS = ["debug", "info", "warning", "error", "critical"] as const;
export const LOG_LEVEL_ORDER: Record<BrowserLogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50
};
export const DEFAULT_LOG_LEVEL: BrowserLogLevel = "warning";

export type BrowserLogLevel = (typeof LOG_LEVELS)[number];
export type BrowserTransportMode = "direct" | "relay";
export type BrowserAnalyticsPrivacyMode = "strict" | "standard" | "custom";
export type BrowserAnalyticsEventKind =
  | "session_start"
  | "page_view"
  | "route_change"
  | "action"
  | "funnel_step"
  | "conversion"
  | "journey_marker"
  | "session_summary";
export type BreadcrumbType = "route_change" | "click" | "form_submit" | "console_log" | "network_request";
export type BrowserPattern = string;
export type BrowserCapturePreset = "minimal" | "balanced" | "investigative";
export type BrowserCaptureRequestEvents = "off" | "failures_only" | "filtered" | "all";
export type BrowserHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export interface BrowserImmediateClientErrorPathRule {
  statusCode: number;
  pathPattern: string;
  methods: BrowserHttpMethod[];
}
export type BrowserCaptureRuleAction = "demote" | "sample" | "drop";
export type BrowserCaptureRuleSampleEventClass = "preserve" | "context";
export type BrowserCaptureRuleEventType = EventEnvelope["event_type"];
export type BrowserCaptureRuleRuntime = "browser" | "node" | "python" | "php" | "java" | "go" | "ruby" | "unknown";
export type BrowserCaptureRuleEventClass = "incident_signal" | "context_signal" | "operational_signal";
export interface BrowserRequestMetadata {
  operation?: string;
  initiator?: string;
  feature?: string;
}

export interface BrowserCaptureRuleUrlMatcher {
  host?: string;
  host_suffix?: string;
  path_prefix?: string;
  path_equals?: string;
}

export interface BrowserCaptureRuleMatcher {
  event_types?: readonly BrowserCaptureRuleEventType[];
  services?: readonly string[];
  environments?: readonly string[];
  runtime?: readonly BrowserCaptureRuleRuntime[];
  first_party?: boolean;
  error_name?: string;
  message_contains?: string;
  message_equals?: string;
  browser_event_kind?: "window_error" | "resource_error";
  browser_event_opaque?: boolean;
  client_kind?: "human" | "bot" | "unknown";
  bot_family?: string;
  resource_url?: BrowserCaptureRuleUrlMatcher;
  request_url?: BrowserCaptureRuleUrlMatcher;
  status_codes?: readonly number[];
  status_ranges?: readonly { start: number; end: number }[];
  fingerprint?: {
    version: string;
    value: string;
  };
}

export interface BrowserCaptureRule {
  id: string;
  project_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  action: BrowserCaptureRuleAction;
  matcher: BrowserCaptureRuleMatcher;
  sample_rate: number | null;
  sample_event_class: BrowserCaptureRuleSampleEventClass | null;
  created_by_user_id: string | null;
  created_from_incident_id: string | null;
  created_from_event_id: string | null;
  expires_at: string | null;
  hit_count: number;
  last_matched_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BrowserCaptureRuleEvaluationResult {
  rule_id: string;
  action: BrowserCaptureRuleAction;
  outcome: "demote" | "drop" | "sampled_in" | "sampled_out";
  sample_rate: number | null;
  sample_event_class: BrowserCaptureRuleSampleEventClass | null;
}

export type BrowserFetchInput = string | URL | Request;

export type BrowserFetchInit = Omit<RequestInit, "headers"> & {
  headers?: HeadersInit;
  debugbundle?: BrowserRequestMetadata;
};

export interface BrowserNetworkFilterConfig {
  urlPatterns?: string[];
  urlDenyPatterns?: string[];
  statusCodes?: number[];
  minResponseTime?: number;
}

export interface NormalizedBrowserNetworkFilter {
  urlPatterns: string[];
  urlDenyPatterns: string[];
  statusCodes: number[];
  minResponseTime: number | null;
}

export interface BrowserProbeBufferItem {
  label: string;
  data: Record<string, unknown>;
  timestamp: string;
  activation_id: string | null;
}

export interface BrowserCorrelationFields {
  request_id: string | null;
  trace_id: string | null;
  session_id: string | null;
  user_id_hash: string | null;
}

export interface BrowserAnalyticsCorrelationFields {
  session_id: string;
  visitor_id_hash: string | null;
  user_id_hash: string | null;
  trace_id: string | null;
  deploy_id: string | null;
}

export interface BrowserAnalyticsDimensions {
  auth_state: "anonymous" | "authenticated" | "unknown";
  device_type: "desktop" | "mobile" | "tablet" | "unknown";
  browser_family: string | null;
  browser_major: number | null;
  os_family: string | null;
  os_major: number | null;
  language: string | null;
  locale: string | null;
  viewport_bucket: "small" | "medium" | "large" | "unknown";
  referrer_domain: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  country_code: string | null;
  region_code: string | null;
}

export type BrowserAnalyticsCustomDimensionValue = string | number | boolean | null;
export type BrowserAnalyticsCustomDimensions = Record<string, BrowserAnalyticsCustomDimensionValue>;

export interface BrowserAnalyticsEventEnvelope {
  schema_version: "2026-07-analytics-01";
  event_id: string;
  event_type: "analytics_event";
  project_token?: string;
  occurred_at: string;
  sdk_name: string;
  sdk_version: string;
  service: {
    name: string;
    runtime: "browser";
    framework: string | null;
    environment: string;
  };
  correlation: BrowserAnalyticsCorrelationFields;
  payload: {
    kind: BrowserAnalyticsEventKind;
    signal: {
      action_key: string | null;
      funnel_key: string | null;
      step_key: string | null;
      conversion_key: string | null;
      marker_key: string | null;
    };
    route: {
      path: string;
      normalized_path: string;
      title: string | null;
    } | null;
    previous_route?: {
      path: string;
      normalized_path: string;
      title: string | null;
    } | null;
    dimensions: BrowserAnalyticsDimensions;
    custom_dimensions: BrowserAnalyticsCustomDimensions;
  };
}

export type DebugBundleBrowserTransportEvent = EventEnvelope | BrowserAnalyticsEventEnvelope;

export interface BrowserBreadcrumb {
  ts: string;
  breadcrumb_type: BreadcrumbType;
  route?: string | null;
  data: Record<string, unknown>;
}

export interface BrowserDeviceInfo {
  user_agent: string | null;
  os: {
    name: string | null;
    version: string | null;
  };
  browser: {
    name: string;
    version: string;
  };
  device_type: "desktop" | "mobile" | "tablet" | "unknown";
  screen: {
    width: number;
    height: number;
  };
  viewport: {
    width: number;
    height: number;
  };
  device_pixel_ratio: number | null;
  touch_capable: boolean | null;
  language: string | null;
  connection_type: string | null;
  color_scheme_preference: "light" | "dark" | "no-preference" | null;
}

export interface BrowserFetchResponse {
  status: number;
  headers?: {
    get(name: string): string | null;
  };
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
  clone?: () => BrowserFetchResponse;
}

export type BrowserFetch = (input: BrowserFetchInput, init?: BrowserFetchInit) => Promise<BrowserFetchResponse>;

export interface BrowserCryptoSource {
  randomUUID?: () => string;
}

export interface BrowserEventSource {
  addEventListener(eventName: string, listener: (event: unknown) => void, options?: boolean | { capture?: boolean }): void;
  removeEventListener(eventName: string, listener: (event: unknown) => void, options?: boolean | { capture?: boolean }): void;
}

export interface BrowserDocumentSource extends BrowserEventSource {
  readyState?: string;
  referrer?: string;
  visibilityState?: string;
}

export interface BrowserHistorySource {
  pushState(state: unknown, title: string, url?: string | URL | null): void;
  replaceState(state: unknown, title: string, url?: string | URL | null): void;
}

export interface BrowserNavigatorSource {
  userAgent?: string;
  language?: string;
  maxTouchPoints?: number;
  connection?: {
    effectiveType?: unknown;
  } | null;
  sendBeacon?: (url: string, data?: string | Blob) => boolean;
}

export interface BrowserLocationSource {
  pathname?: string;
  search?: string;
  href?: string;
}

export interface BrowserScreenSource {
  width?: number;
  height?: number;
}

export interface BrowserWindowMetrics {
  innerWidth?: number;
  innerHeight?: number;
  devicePixelRatio?: number;
}

export type BrowserConsoleLike = {
  error?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
};

export interface BrowserXmlHttpRequest extends BrowserEventSource {
  status?: number;
  open(method: string, url: string, async?: boolean): void;
  send(body?: unknown): void;
  setRequestHeader(name: string, value: string): void;
}

export type BrowserXmlHttpRequestConstructor = new () => BrowserXmlHttpRequest;

export interface BrowserRemoteProbeDirective {
  activationId: string;
  labelPattern: string;
  service: string;
  environment: string;
  expiresAt: string;
  triggerExpiresAt: string | null;
}

export interface BrowserRemoteProbeState {
  probesEnabled: boolean;
  remoteProbesEnabled: boolean;
  directives: BrowserRemoteProbeDirective[];
  triggerTokenKey: string | null;
  requestFailurePreset: BrowserCapturePreset;
  requestCaptureEvents: BrowserCaptureRequestEvents;
  immediateClientErrorStatuses: number[];
  immediateClientErrorPathRules: BrowserImmediateClientErrorPathRule[];
}

export interface DebugBundleBrowserTransportRequest {
  endpoint: string;
  headers: Record<string, string>;
  events: DebugBundleBrowserTransportEvent[];
  transportMode: BrowserTransportMode;
  timeout_ms: number;
}

export interface DebugBundleBrowserTransportResponse {
  status: number;
  body?: unknown;
  retry_after_ms?: number;
}

export type DebugBundleBrowserTransport = (
  request: DebugBundleBrowserTransportRequest
) => Promise<DebugBundleBrowserTransportResponse>;

export interface DebugBundleBrowserInitConfig {
  projectToken?: string;
  environment?: string;
  service?: string;
  enabled?: boolean;
  redactFields?: string[];
  tracePropagationTargets?: BrowserPattern[];
  sampleRate?: number;
  batchSize?: number;
  flushInterval?: number;
  endpoint?: string;
  transportMode?: BrowserTransportMode;
  logLevel?: BrowserLogLevel;
  maxBreadcrumbs?: number;
  breadcrumbsOnErrorOnly?: boolean;
  captureNetwork?: boolean;
  captureClicks?: boolean;
  captureRouteChanges?: boolean;
  captureConsole?: boolean;
  networkFilter?: BrowserNetworkFilterConfig;
  sessionSampleRate?: number;
  maxEventsPerSession?: number;
  maxProbeLabels?: number;
  maxProbeEntriesPerLabel?: number;
  probeFlushOnError?: boolean;
  requestTimeoutMs?: number;
  transport?: DebugBundleBrowserTransport;
  beforeSend?: BrowserBeforeSendHook;
  analytics?: DebugBundleBrowserAnalyticsConfig;
}

export interface DebugBundleBrowserAnalyticsConfig {
  enabled?: boolean;
  privacyMode?: BrowserAnalyticsPrivacyMode;
  consentRequired?: boolean;
  trackPageViews?: boolean;
  trackRouteChanges?: boolean;
  trackSessions?: boolean;
  trackReferrers?: boolean;
  trackActions?: boolean;
  trackFrictionSignals?: boolean;
  sampleRate?: number;
  journeySampleRate?: number;
}

export interface DebugBundleBrowserAnalyticsPageViewInput {
  path?: string;
  title?: string | null;
}

export interface DebugBundleBrowserAnalytics {
  setConsent(value: boolean): void;
  pageView(input?: DebugBundleBrowserAnalyticsPageViewInput): void;
  track(name: string, dimensions?: Record<string, unknown>): void;
  funnel(name: string, step: string, dimensions?: Record<string, unknown>): void;
  convert(name: string, dimensions?: Record<string, unknown>): void;
  marker(name: string, dimensions?: Record<string, unknown>): void;
  setContext(dimensions: Record<string, unknown>): void;
  setUserHash(hash: string | null): void;
}

export interface CaptureBrowserExceptionContext {
  route?: string | null;
  target?: Record<string, unknown> & {
    outerHTML?: string;
  };
  browser_event?: BrowserExceptionEventContext;
  rejection_reason?: BrowserRejectionReasonContext;
}

export interface BrowserRejectionReasonContext {
  kind: "error" | "string" | "object" | "null" | "undefined" | "unknown";
  name?: string;
  message?: string;
  preview?: string;
}

export interface BrowserExceptionEventContext {
  kind: "window_error" | "resource_error";
  message: string | null;
  file_name: string | null;
  line_number: number | null;
  column_number: number | null;
  target: {
    tag_name: string | null;
    source_url: string | null;
    attributes?: {
      rel?: string;
      as?: string;
      type?: string;
      media?: string;
      cross_origin?: string;
      async?: boolean;
      defer?: boolean;
      integrity_present?: boolean;
    };
  } | null;
  page?: {
    url: string | null;
    referrer: string | null;
    ready_state: "loading" | "interactive" | "complete" | null;
    visibility_state: "visible" | "hidden" | "prerender" | "unloaded" | null;
  };
  opaque: boolean;
}

export interface DebugBundleBrowserSdk {
  readonly status: "healthy" | "degraded" | "disconnected";
  readonly lastEventAt: number | null;
  readonly analytics: DebugBundleBrowserAnalytics;
  init(config: DebugBundleBrowserInitConfig): void;
  captureException(error: unknown, context?: CaptureBrowserExceptionContext): void;
  captureError(error: unknown, context?: CaptureBrowserExceptionContext): void;
  captureLog(message: string, level: BrowserLogLevel, context?: Record<string, unknown>): void;
  captureRequest(request: unknown, response?: unknown, context?: Record<string, unknown>): void;
  captureMessage(message: string, level?: BrowserLogLevel, context?: Record<string, unknown>): void;
  setContext(key: string, value: unknown): void;
  probe(label: string, data: unknown): void;
  flush(): Promise<void>;
  dispose(): void;
}

export interface ActiveConfig {
  projectToken: string | null;
  environment: string;
  service: string;
  enabled: boolean;
  redactFields: string[];
  tracePropagationTargets: BrowserPattern[];
  sampleRate: number;
  batchSize: number;
  flushInterval: number;
  endpoint: string;
  logLevel: BrowserLogLevel;
  maxBreadcrumbs: number;
  breadcrumbsOnErrorOnly: boolean;
  captureNetwork: boolean;
  captureClicks: boolean;
  captureRouteChanges: boolean;
  captureConsole: boolean;
  networkFilter: NormalizedBrowserNetworkFilter;
  sessionSampleRate: number;
  maxEventsPerSession: number;
  maxProbeLabels: number;
  maxProbeEntriesPerLabel: number;
  probeFlushOnError: boolean;
  requestTimeoutMs: number;
  captureRules: BrowserCaptureRule[];
  fetchImpl: BrowserFetch | null;
  transport: DebugBundleBrowserTransport;
  transportMode: BrowserTransportMode;
  beforeSend?: BrowserBeforeSendHook;
}
