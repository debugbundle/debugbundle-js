import {
  DEFAULT_LOG_LEVEL,
  LOG_LEVELS,
  type BrowserConsoleLike,
  type BrowserCryptoSource,
  type BrowserDocumentSource,
  type BrowserEventSource,
  type BrowserFetch,
  type BrowserHistorySource,
  type BrowserLocationSource,
  type BrowserLogLevel,
  type BrowserNavigatorSource,
  type BrowserNetworkFilterConfig,
  type BrowserPattern,
  type BrowserRemoteProbeDirective,
  type BrowserRemoteProbeState,
  type BrowserScreenSource,
  type BrowserTransportMode,
  type BrowserWindowMetrics,
  type BrowserXmlHttpRequestConstructor,
  DEFAULT_ENDPOINT,
  type DebugBundleBrowserTransport,
  type DebugBundleBrowserTransportResponse,
  type EventEnvelope,
  type NormalizedBrowserNetworkFilter
} from "./types.js";

export interface ResolvedBrowserTransport {
  mode: BrowserTransportMode | "disabled";
  endpoint: string | null;
  projectToken: string | null;
}

export function getWindowSource(): (BrowserEventSource & BrowserWindowMetrics) | null {
  const candidate = (globalThis as Record<string, unknown>)["window"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserEventSource & BrowserWindowMetrics;
}

export function getDocumentSource(): BrowserDocumentSource | null {
  const candidate = (globalThis as Record<string, unknown>)["document"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserDocumentSource;
}

export function getHistorySource(): BrowserHistorySource | null {
  const candidate = (globalThis as Record<string, unknown>)["history"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserHistorySource;
}

export function getNavigatorSource(): BrowserNavigatorSource | null {
  const candidate = (globalThis as Record<string, unknown>)["navigator"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserNavigatorSource;
}

export function getLocationSource(): BrowserLocationSource | null {
  const candidate = (globalThis as Record<string, unknown>)["location"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserLocationSource;
}

export function getScreenSource(): BrowserScreenSource | null {
  const candidate = (globalThis as Record<string, unknown>)["screen"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserScreenSource;
}

export function getMatchMedia(): ((query: string) => { matches: boolean }) | null {
  const candidate = (globalThis as Record<string, unknown>)["matchMedia"];
  return typeof candidate === "function" ? (candidate as (query: string) => { matches: boolean }) : null;
}

export function getFetchSource(): BrowserFetch | null {
  const candidate = (globalThis as Record<string, unknown>)["fetch"];
  return typeof candidate === "function" ? (candidate as BrowserFetch) : null;
}

export function getConsoleSource(): BrowserConsoleLike | null {
  const candidate = (globalThis as Record<string, unknown>)["console"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserConsoleLike;
}

export function getCryptoSource(): BrowserCryptoSource | null {
  const candidate = (globalThis as Record<string, unknown>)["crypto"];
  if (candidate === null || typeof candidate !== "object") {
    return null;
  }

  return candidate as BrowserCryptoSource;
}

export function getXmlHttpRequestConstructor(): BrowserXmlHttpRequestConstructor | null {
  const candidate = (globalThis as Record<string, unknown>)["XMLHttpRequest"];
  return typeof candidate === "function" ? (candidate as BrowserXmlHttpRequestConstructor) : null;
}

export function normalizePositiveNumber(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }

  return Math.floor(value);
}

export function normalizeSampleRate(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  if (value <= 0) {
    return 0;
  }

  if (value >= 1) {
    return 1;
  }

  return value;
}

export function normalizeLogLevel(level: string | undefined): BrowserLogLevel {
  return LOG_LEVELS.includes(level as BrowserLogLevel) ? (level as BrowserLogLevel) : DEFAULT_LOG_LEVEL;
}

export function normalizeUnknownRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(Object.entries(value));
}

export function normalizeError(error: unknown): { name: string; message: string; stack: string } {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: error.message || "Unknown browser error",
      stack: error.stack || `${error.name || "Error"}: ${error.message || "Unknown browser error"}`
    };
  }

  if (typeof error === "string") {
    return {
      name: "Error",
      message: error,
      stack: `Error: ${error}`
    };
  }

  return {
    name: "Error",
    message: "Unknown browser error",
    stack: "Error: Unknown browser error"
  };
}

export function captureCallerTrace(skipFrames: number, maxFrames: number): string[] {
  const sentinel: { stack?: string } = {};
  const captureStackTrace = (
    Error as unknown as {
      captureStackTrace?: (target: object, constructorOpt: (...args: never[]) => unknown) => void;
    }
  ).captureStackTrace;

  if (typeof captureStackTrace === "function") {
    captureStackTrace(sentinel, captureCallerTrace);
  } else {
    sentinel.stack = new Error().stack ?? "";
    skipFrames += 1;
  }

  const stack = sentinel.stack;
  if (!stack) return [];

  const lines = stack.split("\n");
  const frames: string[] = [];

  let frameIndex = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^Error:?\s*$/.test(trimmed)) continue;

    if (frameIndex < skipFrames) {
      frameIndex++;
      continue;
    }

    frames.push(trimmed.startsWith("at ") ? trimmed.slice(3) : trimmed);
    if (frames.length >= maxFrames) break;
    frameIndex++;
  }

  return frames;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1_000);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return Math.max(0, parsed - Date.now());
}

export function createFetchTransport(): DebugBundleBrowserTransport {
  const fetchImpl = getFetchSource();

  return async (request): Promise<DebugBundleBrowserTransportResponse> => {
    if (fetchImpl === null) {
      throw new Error("fetch unavailable");
    }

    const response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: buildBrowserTransportRequestBody(request.endpoint, request.events)
    });

    const retryAfterMs = parseRetryAfter(response.headers?.get("Retry-After") ?? null);

    return {
      status: response.status,
      body: typeof response.json === "function" ? await response.json() : undefined,
      ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs })
    };
  };
}

export function buildBrowserTransportRequestBody(endpoint: string, events: EventEnvelope[]): string {
  if (isAbsoluteHttpUrl(endpoint)) {
    return JSON.stringify({ events });
  }

  return JSON.stringify({ batch: events });
}

function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isValidRelayEndpointPath(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) {
    return false;
  }

  try {
    const parsed = new URL(value, "https://debugbundle.local");
    return parsed.origin === "https://debugbundle.local";
  } catch {
    return false;
  }
}

export function resolveBrowserTransport(input: {
  endpoint?: string | undefined;
  projectToken?: string | undefined;
}): ResolvedBrowserTransport {
  const endpoint = input.endpoint?.trim();
  const projectToken = input.projectToken?.trim();

  if (endpoint !== undefined && endpoint.length > 0) {
    if (isAbsoluteHttpUrl(endpoint)) {
      if (projectToken === undefined || projectToken.length === 0) {
        return {
          mode: "disabled",
          endpoint: null,
          projectToken: null
        };
      }

      return {
        mode: "direct",
        endpoint,
        projectToken
      };
    }

    if (isValidRelayEndpointPath(endpoint)) {
      return {
        mode: "relay",
        endpoint,
        projectToken: null
      };
    }

    return {
      mode: "disabled",
      endpoint: null,
      projectToken: null
    };
  }

  if (projectToken !== undefined && projectToken.length > 0) {
    return {
      mode: "direct",
      endpoint: DEFAULT_ENDPOINT,
      projectToken
    };
  }

  return {
    mode: "disabled",
    endpoint: null,
    projectToken: null
  };
}

export function normalizeBoolean(value: boolean | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeNetworkPatterns(value: BrowserPattern[] | undefined): BrowserPattern[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((pattern): pattern is BrowserPattern => typeof pattern === "string" || pattern instanceof RegExp);
}

function normalizeStringPatterns(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((pattern): pattern is string => typeof pattern === "string");
}

export function normalizeTracePropagationTargets(value: BrowserPattern[] | undefined): BrowserPattern[] {
  return normalizeNetworkPatterns(value);
}

export function normalizeNetworkFilter(value: BrowserNetworkFilterConfig | undefined): NormalizedBrowserNetworkFilter {
  const statusCodes = Array.isArray(value?.statusCodes)
    ? value.statusCodes
        .filter((statusCode): statusCode is number => typeof statusCode === "number" && Number.isFinite(statusCode))
        .map((statusCode) => Math.trunc(statusCode))
    : [400, 599];

  return {
    urlPatterns: normalizeStringPatterns(value?.urlPatterns),
    urlDenyPatterns: normalizeStringPatterns(value?.urlDenyPatterns),
    statusCodes: statusCodes.length > 0 ? statusCodes : [400, 599],
    minResponseTime:
      typeof value?.minResponseTime === "number" && Number.isFinite(value.minResponseTime) && value.minResponseTime > 0
        ? Math.trunc(value.minResponseTime)
        : null
  };
}

export function deriveSdkConfigEndpoint(endpoint: string): string {
  if (endpoint.endsWith("/v1/events")) {
    return `${endpoint.slice(0, -"/events".length)}/sdk/config`;
  }

  if (endpoint.endsWith("/events")) {
    return `${endpoint.slice(0, -"/events".length)}/sdk/config`;
  }

  return endpoint;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseRemoteProbeDirective(value: unknown, nowMs: number): BrowserRemoteProbeDirective | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const activationId = asString(record["activation_id"]);
  const labelPattern = asString(record["label_pattern"]);
  const service = asString(record["service"]);
  const environment = asString(record["environment"]);
  const expiresAt = asString(record["expires_at"]);
  const triggerExpiresAt = asString(record["trigger_expires_at"]);

  if (
    activationId === null ||
    labelPattern === null ||
    service === null ||
    environment === null ||
    expiresAt === null ||
    Number.isNaN(Date.parse(expiresAt))
  ) {
    return null;
  }

  if (Date.parse(expiresAt) <= nowMs) {
    return null;
  }

  return {
    activationId,
    labelPattern,
    service,
    environment,
    expiresAt,
    triggerExpiresAt: triggerExpiresAt !== null && !Number.isNaN(Date.parse(triggerExpiresAt)) ? triggerExpiresAt : null
  };
}

export function parseRemoteProbeConfigPayload(payload: unknown, nowMs: number): BrowserRemoteProbeState | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }

  return {
    probesEnabled: record["probes_enabled"] === true,
    remoteProbesEnabled: record["remote_probes_enabled"] === true,
    directives: Array.isArray(record["active_probes"])
      ? record["active_probes"]
          .map((directive) => parseRemoteProbeDirective(directive, nowMs))
          .filter((directive): directive is BrowserRemoteProbeDirective => directive !== null)
      : [],
    triggerTokenKey: asString(record["trigger_token_key"])
  };
}

export function parseIngestionProbeDirectives(payload: unknown, nowMs: number): BrowserRemoteProbeDirective[] | null {
  const record = asRecord(payload);
  const directivesRecord = record === null ? null : asRecord(record["probe_directives"]);
  if (directivesRecord === null || !Array.isArray(directivesRecord["active_probes"])) {
    return null;
  }

  return directivesRecord["active_probes"]
    .map((directive) => parseRemoteProbeDirective(directive, nowMs))
    .filter((directive): directive is BrowserRemoteProbeDirective => directive !== null);
}

export function stringifyConsoleArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") {
        return arg;
      }

      if (arg instanceof Error) {
        return arg.message;
      }

      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .trim();
}

export function matchesBrowserPattern(value: string, pattern: BrowserPattern): boolean {
  if (typeof pattern === "string") {
    return value.includes(pattern);
  }

  pattern.lastIndex = 0;
  return pattern.test(value);
}

export function shouldInjectTraceHeader(url: string, tracePropagationTargets: BrowserPattern[] = []): boolean {
  const locationSource = getLocationSource();
  const locationHref = typeof locationSource?.href === "string" && locationSource.href.length > 0
    ? locationSource.href
    : null;

  let resolvedUrl: URL;
  try {
    resolvedUrl = locationHref !== null ? new URL(url, locationHref) : new URL(url);
  } catch {
    return false;
  }

  if (resolvedUrl.protocol !== "http:" && resolvedUrl.protocol !== "https:") {
    return false;
  }

  if (!isAbsoluteHttpUrl(url)) {
    return true;
  }

  if (locationHref !== null) {
    try {
      const currentUrl = new URL(locationHref);
      if (resolvedUrl.origin === currentUrl.origin) {
        return true;
      }
    } catch {
      // Ignore malformed location and fall through to explicit allowlist checks.
    }
  }

  return tracePropagationTargets.some((pattern) => matchesBrowserPattern(resolvedUrl.href, pattern));
}

export function matchesStatusCodeFilter(statusCode: number, filter: number[]): boolean {
  if (filter.includes(statusCode)) {
    return true;
  }

  if (filter.length === 2) {
    const [start, end] = filter;
    if (start !== undefined && end !== undefined && start < end) {
      return statusCode >= start && statusCode <= end;
    }
  }

  return false;
}

export function createBrowserTraceId(): string {
  const cryptoSource = getCryptoSource();
  if (typeof cryptoSource?.randomUUID === "function") {
    return cryptoSource.randomUUID();
  }

  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const randomValue = Math.floor(Math.random() * 16);
    const nibble = character === "x" ? randomValue : (randomValue & 0x3) | 0x8;
    return nibble.toString(16);
  });
}

export function buildSelector(target: Record<string, unknown>): string | null {
  const tagName = typeof target["tagName"] === "string" ? target["tagName"].toLowerCase() : null;
  if (tagName === null) {
    return null;
  }

  const id = typeof target["id"] === "string" && target["id"].length > 0 ? `#${target["id"]}` : "";
  return `${tagName}${id}`;
}

export function parseBrowserIdentity(userAgent: string | null): { name: string; version: string } {
  if (userAgent === null) {
    return { name: "Unknown", version: "0" };
  }

  const chromeMatch = /Chrome\/([\d.]+)/.exec(userAgent);
  if (chromeMatch !== null) {
    return { name: "Chrome", version: chromeMatch[1] ?? "0" };
  }

  const firefoxMatch = /Firefox\/([\d.]+)/.exec(userAgent);
  if (firefoxMatch !== null) {
    return { name: "Firefox", version: firefoxMatch[1] ?? "0" };
  }

  const safariMatch = /Version\/([\d.]+).*Safari/.exec(userAgent);
  if (safariMatch !== null) {
    return { name: "Safari", version: safariMatch[1] ?? "0" };
  }

  return { name: "Unknown", version: "0" };
}

export function parseOsIdentity(userAgent: string | null): { name: string | null; version: string | null } {
  if (userAgent === null) {
    return { name: null, version: null };
  }

  const macMatch = /Mac OS X ([\d_]+)/.exec(userAgent);
  if (macMatch !== null) {
    return {
      name: "macOS",
      version: (macMatch[1] ?? "").replaceAll("_", ".") || null
    };
  }

  const windowsMatch = /Windows NT ([\d.]+)/.exec(userAgent);
  if (windowsMatch !== null) {
    return { name: "Windows", version: windowsMatch[1] ?? null };
  }

  const androidMatch = /Android ([\d.]+)/.exec(userAgent);
  if (androidMatch !== null) {
    return { name: "Android", version: androidMatch[1] ?? null };
  }

  const iosMatch = /OS ([\d_]+) like Mac OS X/.exec(userAgent);
  if (iosMatch !== null) {
    return {
      name: "iOS",
      version: (iosMatch[1] ?? "").replaceAll("_", ".") || null
    };
  }

  return { name: null, version: null };
}

export function detectDeviceType(userAgent: string | null): "desktop" | "mobile" | "tablet" | "unknown" {
  if (userAgent === null) {
    return "unknown";
  }

  if (/Tablet|iPad/i.test(userAgent)) {
    return "tablet";
  }

  if (/Mobile|Android|iPhone/i.test(userAgent)) {
    return "mobile";
  }

  return "desktop";
}
