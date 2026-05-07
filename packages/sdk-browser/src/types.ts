import type { EventEnvelope } from "@debugbundle/shared-types";
export type { EventEnvelope };

export const SDK_NAME = "@debugbundle/sdk-browser";
export const SDK_VERSION = "0.1.0";
export const SDK_SCHEMA_VERSION = "2026-03-01";
export const DEFAULT_ENDPOINT = "https://api.debugbundle.com/v1/events";
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
export type BreadcrumbType = "route_change" | "click" | "form_submit" | "console_log" | "network_request";
export type BrowserPattern = string | RegExp;
export interface BrowserRequestMetadata {
  operation?: string;
  initiator?: string;
  feature?: string;
}

export type BrowserFetchInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  keepalive?: boolean;
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

export type BrowserFetch = (input: string, init?: BrowserFetchInit) => Promise<BrowserFetchResponse>;

export interface BrowserCryptoSource {
  randomUUID?: () => string;
}

export interface BrowserEventSource {
  addEventListener(eventName: string, listener: (event: unknown) => void): void;
  removeEventListener(eventName: string, listener: (event: unknown) => void): void;
}

export interface BrowserDocumentSource extends BrowserEventSource {
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
}

export interface DebugBundleBrowserTransportRequest {
  endpoint: string;
  headers: Record<string, string>;
  events: EventEnvelope[];
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
}

export interface CaptureBrowserExceptionContext {
  route?: string | null;
  target?: Record<string, unknown> & {
    outerHTML?: string;
  };
}

export interface DebugBundleBrowserSdk {
  readonly status: "healthy" | "degraded" | "disconnected";
  readonly lastEventAt: number | null;
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
  fetchImpl: BrowserFetch | null;
  transport: DebugBundleBrowserTransport;
  transportMode: BrowserTransportMode;
}
