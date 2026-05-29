import { redact, type JsonValue } from "@debugbundle/redaction";
import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { evaluateBrowserCaptureRulesForEvent, parseRemoteCaptureRulesPayload } from "./capture-rules.js";
import { collectDeviceInfo, installConsoleHook, installNetworkHook } from "./hooks.js";
import { EventSuppressionTracker } from "./suppression.js";
import { validateBrowserTriggerToken } from "./trigger-token.js";
import {
  buildSelector,
  buildBrowserTransportRequestBody,
  createFetchTransport,
  deriveSdkConfigEndpoint,
  getConsoleSource,
  getDocumentSource,
  getFetchSource,
  getHistorySource,
  getLocationSource,
  getNavigatorSource,
  getWindowSource,
  matchesBrowserPattern,
  matchesStatusCodeFilter,
  normalizeBrowserErrorEvent,
  normalizeBoolean,
  normalizeError,
  normalizeLogLevel,
  normalizeNetworkFilter,
  normalizePositiveNumber,
  normalizeSampleRate,
  normalizeTracePropagationTargets,
  normalizeUnknownRecord,
  parseIngestionProbeDirectives,
  parseRemoteProbeConfigPayload,
  resolveBrowserTransport,
} from "./runtime.js";
import {
  DEFAULT_BATCH_SIZE,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_BREADCRUMBS,
  DEFAULT_MAX_EVENTS_PER_SESSION,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SAMPLE_RATE,
  DEFAULT_SESSION_SAMPLE_RATE,
  LOG_LEVEL_ORDER,
  SDK_NAME,
  SDK_SCHEMA_VERSION,
  SDK_VERSION,
  type ActiveConfig,
  type BrowserBreadcrumb,
  type BrowserCaptureRequestEvents,
  type BrowserCapturePreset,
  type BrowserCorrelationFields,
  type BrowserDeviceInfo,
  type BrowserFetch,
  type BrowserLogLevel,
  type BrowserProbeBufferItem,
  type BrowserCaptureRuleEvaluationResult,
  type BrowserRemoteProbeDirective,
  type BrowserRemoteProbeState,
  type BrowserXmlHttpRequestConstructor,
  type CaptureBrowserExceptionContext,
  type DebugBundleBrowserInitConfig,
  type DebugBundleBrowserSdk
} from "./types.js";

const DEFAULT_REQUEST_FAILURE_PRESET: BrowserCapturePreset = "balanced";
const DEFAULT_REQUEST_CAPTURE_EVENTS: BrowserCaptureRequestEvents = "failures_only";
const DEFAULT_IMMEDIATE_CLIENT_ERROR_STATUSES: number[] = [];

function createInitialRemoteProbeState(): BrowserRemoteProbeState {
  return {
    probesEnabled: false,
    remoteProbesEnabled: false,
    directives: [],
    triggerTokenKey: null,
    requestFailurePreset: DEFAULT_REQUEST_FAILURE_PRESET,
    requestCaptureEvents: DEFAULT_REQUEST_CAPTURE_EVENTS,
    immediateClientErrorStatuses: [...DEFAULT_IMMEDIATE_CLIENT_ERROR_STATUSES]
  };
}

export type {
  CaptureBrowserExceptionContext,
  DebugBundleBrowserInitConfig,
  DebugBundleBrowserSdk,
  BrowserRequestMetadata,
  DebugBundleBrowserTransport,
  DebugBundleBrowserTransportRequest,
  DebugBundleBrowserTransportResponse
} from "./types.js";

const BALANCED_IMMEDIATE_REQUEST_STATUSES = new Set([408, 423, 424, 425, 429]);
const INVESTIGATIVE_IMMEDIATE_REQUEST_STATUSES = new Set([...BALANCED_IMMEDIATE_REQUEST_STATUSES, 409]);
const BALANCED_STANDARD_ANOMALY_STATUSES = new Set([401, 403, 404, 409, 422]);
const BALANCED_HIGH_VOLUME_ANOMALY_STATUSES = new Set([400, 410]);
const INVESTIGATIVE_ANOMALY_STATUSES = new Set([...BALANCED_STANDARD_ANOMALY_STATUSES, ...BALANCED_HIGH_VOLUME_ANOMALY_STATUSES]);

function isImmediateRequestIncidentStatus(
  statusCode: number,
  preset: BrowserCapturePreset,
  immediateClientErrorStatuses: readonly number[] = []
): boolean {
  if (!Number.isFinite(statusCode)) {
    return false;
  }

  if (statusCode >= 500) {
    return true;
  }

  if (immediateClientErrorStatuses.includes(statusCode)) {
    return true;
  }

  if (preset === "investigative") {
    return INVESTIGATIVE_IMMEDIATE_REQUEST_STATUSES.has(statusCode);
  }

  if (preset === "balanced") {
    return BALANCED_IMMEDIATE_REQUEST_STATUSES.has(statusCode);
  }

  return false;
}

function isRequestAnomalyCandidateStatus(statusCode: number, preset: BrowserCapturePreset): boolean {
  if (!Number.isFinite(statusCode) || statusCode < 400 || statusCode >= 500) {
    return false;
  }

  if (preset === "investigative") {
    return INVESTIGATIVE_ANOMALY_STATUSES.has(statusCode);
  }

  if (preset === "balanced") {
    return BALANCED_STANDARD_ANOMALY_STATUSES.has(statusCode) || BALANCED_HIGH_VOLUME_ANOMALY_STATUSES.has(statusCode);
  }

  return false;
}

function shouldCaptureRequestStatus(
  statusCode: number,
  preset: BrowserCapturePreset,
  policy: BrowserCaptureRequestEvents,
  immediateClientErrorStatuses: readonly number[] = []
): boolean {
  if (isImmediateRequestIncidentStatus(statusCode, preset, immediateClientErrorStatuses)) {
    return true;
  }

  if (policy === "all") {
    return Number.isFinite(statusCode) && statusCode >= 400;
  }

  if (policy === "failures_only") {
    return isRequestAnomalyCandidateStatus(statusCode, preset);
  }

  return false;
}

export class BrowserSdk implements DebugBundleBrowserSdk {
  private config: ActiveConfig | null = null;
  private bufferedEvents: EventEnvelope[] = [];
  private breadcrumbs: BrowserBreadcrumb[] = [];
  private persistentContext: Record<string, unknown> = {};
  private deviceInfo: BrowserDeviceInfo | null = null;
  private flushPromise: Promise<void> | null = null;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private nextRetryAt: number | null = null;
  private _lastEventAt: number | null = null;
  private _consecutiveFailures = 0;
  private authRejected = false;
  private registeredListeners: Array<() => void> = [];
  private originalPushState: ((state: unknown, title: string, url?: string | URL | null) => void) | null = null;
  private originalReplaceState: ((state: unknown, title: string, url?: string | URL | null) => void) | null = null;
  private originalFetch: BrowserFetch | null = null;
  private originalXmlHttpRequest: BrowserXmlHttpRequestConstructor | null = null;
  private originalConsoleError: ((...args: unknown[]) => void) | null = null;
  private originalConsoleWarn: ((...args: unknown[]) => void) | null = null;
  private sessionSampledIn = true;
  private sessionEventCount = 0;
  private probeBuffers = new Map<string, BrowserProbeBufferItem[]>();
  private readonly suppressionTracker = new EventSuppressionTracker();
  private remoteProbeState: BrowserRemoteProbeState = createInitialRemoteProbeState();
  private pendingTriggerToken: string | null = null;
  private activeTriggerDirective: BrowserRemoteProbeDirective | null = null;

  public get status(): "healthy" | "degraded" | "disconnected" {
    if (this.config === null) {
      return "disconnected";
    }

    if (this.authRejected) {
      return "disconnected";
    }

    if (this._consecutiveFailures >= 3) {
      return "disconnected";
    }

    if (this.nextRetryAt !== null) {
      return "degraded";
    }

    return "healthy";
  }

  public get lastEventAt(): number | null {
    return this._lastEventAt;
  }

  public init(config: DebugBundleBrowserInitConfig): void {
    this.dispose();

    const enabled = config.enabled ?? true;
    const resolvedTransport = resolveBrowserTransport({
      endpoint: config.endpoint,
      projectToken: config.projectToken,
      transportMode: config.transportMode
    });

    if (!enabled || resolvedTransport.mode === "disabled" || resolvedTransport.endpoint === null) {
      return;
    }

    this.config = {
      projectToken: resolvedTransport.projectToken,
      environment: config.environment?.trim() || "development",
      service: config.service?.trim() || "browser-app",
      enabled,
      redactFields: config.redactFields ?? ["password", "secret", "token", "authorization", "cookie", "ssn", "credit_card"],
      tracePropagationTargets: normalizeTracePropagationTargets(config.tracePropagationTargets),
      sampleRate: normalizeSampleRate(config.sampleRate, DEFAULT_SAMPLE_RATE),
      batchSize: normalizePositiveNumber(config.batchSize, DEFAULT_BATCH_SIZE),
      flushInterval: normalizePositiveNumber(config.flushInterval, DEFAULT_FLUSH_INTERVAL_MS),
      endpoint: resolvedTransport.endpoint,
      logLevel: normalizeLogLevel(config.logLevel ?? DEFAULT_LOG_LEVEL),
      maxBreadcrumbs: normalizePositiveNumber(config.maxBreadcrumbs, DEFAULT_MAX_BREADCRUMBS),
      breadcrumbsOnErrorOnly: normalizeBoolean(config.breadcrumbsOnErrorOnly, true),
      captureNetwork: normalizeBoolean(config.captureNetwork, true),
      captureClicks: normalizeBoolean(config.captureClicks, true),
      captureRouteChanges: normalizeBoolean(config.captureRouteChanges, true),
      captureConsole: normalizeBoolean(config.captureConsole, false),
      networkFilter: normalizeNetworkFilter(config.networkFilter),
      sessionSampleRate: normalizeSampleRate(config.sessionSampleRate, DEFAULT_SESSION_SAMPLE_RATE),
      maxEventsPerSession: normalizePositiveNumber(config.maxEventsPerSession, DEFAULT_MAX_EVENTS_PER_SESSION),
      maxProbeLabels: normalizePositiveNumber(config.maxProbeLabels, 50),
      maxProbeEntriesPerLabel: normalizePositiveNumber(config.maxProbeEntriesPerLabel, 10),
      probeFlushOnError: normalizeBoolean(config.probeFlushOnError, true),
      requestTimeoutMs: normalizePositiveNumber(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
      captureRules: [],
      fetchImpl: getFetchSource(),
      transport: config.transport ?? createFetchTransport(),
      transportMode: resolvedTransport.mode
    };

    this.authRejected = false;
    this.sessionSampledIn = this.config.sessionSampleRate >= 1 || Math.random() < this.config.sessionSampleRate;
    this.sessionEventCount = 0;
    this.deviceInfo = collectDeviceInfo();
    this.pendingTriggerToken = this.consumeTriggerTokenFromLocation();
    void this.refreshRemoteProbeConfig();
    this.installBrowserHooks();
  }

  public captureException(error: unknown, context: CaptureBrowserExceptionContext = {}): void {
    const config = this.config;
    if (config === null) {
      return;
    }

    try {
      const normalizedError = normalizeError(error);
      const device = this.deviceInfo;
      const browser = device?.browser ?? { name: "Unknown", version: "0" };
      const breadcrumbs = this.consumeBreadcrumbs();
      const probeData = config.probeFlushOnError ? this.consumeProbeData() : { version: 1 as const, items: [] };
      const domContext =
        typeof context.target?.outerHTML === "string" && context.target.outerHTML.length > 0
          ? {
              mode: "lightweight" as const,
              html_excerpt: context.target.outerHTML
            }
          : null;

      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "frontend_exception",
        ...this.getProjectTokenFields(config),
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: {
          name: config.service,
          runtime: "browser",
          framework: null,
          environment: config.environment
        },
        occurred_at: new Date().toISOString(),
        correlation: this.createCorrelation(),
        payload: {
          name: normalizedError.name,
          message: normalizedError.message,
          stack: normalizedError.stack,
          route: context.route ?? this.getCurrentRoute(),
          browser,
          breadcrumbs,
          probe_data: probeData,
          device:
            device === null
              ? null
              : {
                  user_agent: device.user_agent,
                  os: device.os,
                  device_type: device.device_type,
                  screen: device.screen,
                  viewport: device.viewport,
                  device_pixel_ratio: device.device_pixel_ratio,
                  touch_capable: device.touch_capable,
                  language: device.language,
                  connection_type: device.connection_type,
                  color_scheme_preference: device.color_scheme_preference
                },
          dom_context: domContext
        }
      });

      if (context.browser_event !== undefined) {
        (event.payload as Record<string, unknown>)["browser_event"] = context.browser_event;
      }

      this.removeEmptyProjectToken(event, config);

      this.enqueueEvent(event);
    } catch {
      return;
    }
  }

  public captureError(error: unknown, context: CaptureBrowserExceptionContext = {}): void {
    this.captureException(error, context);
  }

  public captureLog(message: string, level: BrowserLogLevel, context: Record<string, unknown> = {}): void {
    const config = this.config;
    if (config === null || !this.shouldCaptureNonExceptionEvent()) {
      return;
    }

    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[config.logLevel]) {
      return;
    }

    try {
      const attributes = redact(
        {
          ...this.persistentContext,
          ...normalizeUnknownRecord(context)
        } as Record<string, JsonValue>,
        {
          sensitiveKeys: config.redactFields
        }
      ).redacted as Record<string, unknown>;

      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "log_event",
        ...this.getProjectTokenFields(config),
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: {
          name: config.service,
          runtime: "browser",
          framework: null,
          environment: config.environment
        },
        occurred_at: new Date().toISOString(),
        correlation: this.createCorrelation(),
        payload: {
          level,
          message,
          attributes
        }
      });

      this.removeEmptyProjectToken(event, config);

      this.enqueueEvent(event);
    } catch {
      return;
    }
  }

  public captureRequest(request: unknown, response?: unknown, context?: Record<string, unknown>): void {
    void request;
    void response;
    void context;
  }

  public captureMessage(message: string, level: BrowserLogLevel = "info", context: Record<string, unknown> = {}): void {
    this.captureLog(message, normalizeLogLevel(level), context);
  }

  public setContext(key: string, value: unknown): void {
    const config = this.config;
    if (config === null || key.trim().length === 0) {
      return;
    }

    const redacted = redact({ [key]: value } as Record<string, JsonValue>, {
      sensitiveKeys: config.redactFields
    }).redacted as Record<string, unknown>;
    this.persistentContext[key] = redacted[key] ?? null;
  }

  public probe(label: string, data: unknown): void {
    const config = this.config;
    const normalizedLabel = label.trim();
    if (config === null || normalizedLabel.length === 0) {
      return;
    }

    try {
      const redacted = redact(this.normalizeProbeInput(data), {
        sensitiveKeys: config.redactFields
      }).redacted;
      const probeData = normalizeUnknownRecord(redacted);

      this.bufferProbe(normalizedLabel, probeData);

      const matchingDirectives = this.getMatchingRemoteProbeDirectives(normalizedLabel, Date.now());
      if (!this.sessionSampledIn || matchingDirectives.length === 0) {
        return;
      }

      for (const directive of matchingDirectives) {
        this.enqueueEvent(
          this.createSdkEventEnvelope(config, {
            schema_version: SDK_SCHEMA_VERSION,
            event_type: "probe_event",
            ...this.getProjectTokenFields(config),
            sdk_name: SDK_NAME,
            sdk_version: SDK_VERSION,
            service: {
              name: config.service,
              runtime: "browser",
              framework: null,
              environment: config.environment
            },
            occurred_at: new Date().toISOString(),
            correlation: this.createCorrelation(),
            payload: {
              label: normalizedLabel,
              data: probeData,
              activation_id: directive.activationId,
              probe_label_pattern: directive.labelPattern
            }
          }),
          false
        );
      }
    } catch {
      return;
    }
  }

  public async flush(): Promise<void> {
    const config = this.config;
    if (config === null) {
      return;
    }

    this.enqueueSuppressionAggregates();

    if (this.bufferedEvents.length === 0) {
      return;
    }

    if (this.flushPromise !== null) {
      return this.flushPromise;
    }

    if (this.nextRetryAt !== null && Date.now() < this.nextRetryAt) {
      return;
    }

    if (this.authRejected) {
      return;
    }

    this.clearFlushTimer();

    const events = [...this.bufferedEvents];
    this.flushPromise = (async () => {
      try {
        const response = await config.transport({
          endpoint: config.endpoint,
          headers: this.getTransportHeaders(config),
          events,
          transportMode: config.transportMode,
          timeout_ms: config.requestTimeoutMs
        });

        if (response.status >= 200 && response.status < 300) {
          this.updateRemoteProbeStateFromIngestionResponse(response.body);
          this.nextRetryAt = null;
          this._lastEventAt = Date.now();
          this._consecutiveFailures = 0;
          if (this.bufferedEvents === events || this.sameLeadingEvents(events)) {
            this.bufferedEvents.splice(0, events.length);
          }
          return;
        }

        this._consecutiveFailures++;
        if (response.status === 401 || response.status === 403) {
          this.authRejected = true;
          this.nextRetryAt = null;
          this.reportUnauthorizedTransportFailure(response.status, config.endpoint, response.body);
          this.bufferedEvents = [];
          return;
        }

        if (response.status === 429) {
          this.nextRetryAt = Date.now() + (response.retry_after_ms ?? 1_000);
        }
      } catch {
        this._consecutiveFailures++;
        return;
      } finally {
        this.flushPromise = null;
        if (this.bufferedEvents.length > 0) {
          const retryDelay = this.nextRetryAt === null ? undefined : Math.max(0, this.nextRetryAt - Date.now());
          this.scheduleFlush(retryDelay);
        }
      }
    })();

    return this.flushPromise;
  }

  public dispose(): void {
    this.clearFlushTimer();
    this.flushPromise = null;
    this.bufferedEvents = [];
    this.breadcrumbs = [];
    this.probeBuffers = new Map<string, BrowserProbeBufferItem[]>();
    this.persistentContext = {};
    this.deviceInfo = null;
    this.config = null;
    this.sessionSampledIn = true;
    this.sessionEventCount = 0;
    this.nextRetryAt = null;
    this._lastEventAt = null;
    this._consecutiveFailures = 0;
    this.authRejected = false;
    this.suppressionTracker.reset();
    this.remoteProbeState = createInitialRemoteProbeState();
    this.pendingTriggerToken = null;
    this.activeTriggerDirective = null;

    while (this.registeredListeners.length > 0) {
      this.registeredListeners.pop()?.();
    }

    const historySource = getHistorySource();
    if (this.originalPushState !== null && historySource !== null) {
      historySource.pushState = this.originalPushState;
      this.originalPushState = null;
    }

    if (this.originalReplaceState !== null && historySource !== null) {
      historySource.replaceState = this.originalReplaceState;
      this.originalReplaceState = null;
    }

    const consoleSource = getConsoleSource();
    if (consoleSource !== null && this.originalConsoleError !== null) {
      consoleSource.error = this.originalConsoleError;
      this.originalConsoleError = null;
    }

    if (consoleSource !== null && this.originalConsoleWarn !== null) {
      consoleSource.warn = this.originalConsoleWarn;
      this.originalConsoleWarn = null;
    }

    if (this.originalFetch !== null) {
      (globalThis as Record<string, unknown>)["fetch"] = this.originalFetch;
      this.originalFetch = null;
    }

    if (this.originalXmlHttpRequest !== null) {
      (globalThis as Record<string, unknown>)["XMLHttpRequest"] = this.originalXmlHttpRequest;
      this.originalXmlHttpRequest = null;
    }
  }

  private reportUnauthorizedTransportFailure(statusCode: 401 | 403, endpoint: string, body: unknown): void {
    const consoleSource = getConsoleSource();
    if (consoleSource === null) {
      return;
    }

    const bodyRecord = normalizeUnknownRecord(body);
    const errorCode = typeof bodyRecord["error"] === "string" && bodyRecord["error"].length > 0 ? bodyRecord["error"] : null;
    const detail = errorCode === null ? "" : ` (${errorCode})`;
    const message =
      `DebugBundle browser SDK disabled after ingestion returned ${statusCode} for ${endpoint}. ` +
      `Check the project token or relay configuration${detail}.`;

    if (typeof consoleSource.error === "function") {
      consoleSource.error(message);
      return;
    }

    consoleSource.warn?.(message);
  }

  private installBrowserHooks(): void {
    const windowSource = getWindowSource();
    if (windowSource !== null) {
      const onPageHide = (): void => {
        this.flushViaBeacon();
      };
      const onError = (event: unknown): void => {
        const maybeError = normalizeUnknownRecord(event);
        const browserEvent = normalizeBrowserErrorEvent(event);
        const fallbackMessage = browserEvent.kind === "resource_error" ? "Browser resource load error" : "Window error";
        this.captureException(maybeError["error"] ?? maybeError["message"] ?? new Error(fallbackMessage), {
          browser_event: browserEvent
        });
      };
      const onUnhandledRejection = (event: unknown): void => {
        const maybeError = normalizeUnknownRecord(event);
        this.captureException(maybeError["reason"] ?? new Error("Unhandled promise rejection"));
      };

      windowSource.addEventListener("pagehide", onPageHide);
      windowSource.addEventListener("error", onError, true);
      windowSource.addEventListener("unhandledrejection", onUnhandledRejection);

      this.registeredListeners.push(() => windowSource.removeEventListener("pagehide", onPageHide));
      this.registeredListeners.push(() => windowSource.removeEventListener("error", onError, true));
      this.registeredListeners.push(() => windowSource.removeEventListener("unhandledrejection", onUnhandledRejection));
    }

    const documentSource = getDocumentSource();
    if (documentSource !== null) {
      const onClick = (event: unknown): void => {
        if (this.config?.captureClicks !== true) {
          return;
        }

        const target = normalizeUnknownRecord(normalizeUnknownRecord(event)["target"]);
        const selector = buildSelector(target);
        if (selector === null) {
          return;
        }

        this.addBreadcrumb({
          ts: new Date().toISOString(),
          breadcrumb_type: "click",
          data: {
            selector
          }
        });
      };

      const onSubmit = (event: unknown): void => {
        const target = normalizeUnknownRecord(normalizeUnknownRecord(event)["target"]);
        const selector = buildSelector(target) ?? "form";
        const elements = Array.isArray(target["elements"]) ? target["elements"] : [];
        const fieldCount = elements
          .map((entry) => normalizeUnknownRecord(entry))
          .filter((entry) => typeof entry["name"] === "string" && entry["name"].length > 0).length;

        this.addBreadcrumb({
          ts: new Date().toISOString(),
          breadcrumb_type: "form_submit",
          data: {
            form: selector,
            field_count: fieldCount
          }
        });
      };

      const onVisibilityChange = (): void => {
        if (documentSource.visibilityState === "hidden") {
          this.flushViaBeacon();
        }
      };

      documentSource.addEventListener("click", onClick);
      documentSource.addEventListener("submit", onSubmit);
      documentSource.addEventListener("visibilitychange", onVisibilityChange);

      this.registeredListeners.push(() => documentSource.removeEventListener("click", onClick));
      this.registeredListeners.push(() => documentSource.removeEventListener("submit", onSubmit));
      this.registeredListeners.push(() => documentSource.removeEventListener("visibilitychange", onVisibilityChange));
    }

    const historySource = getHistorySource();
    if (historySource !== null) {
      this.originalPushState = historySource.pushState.bind(historySource);
      this.originalReplaceState = historySource.replaceState.bind(historySource);

      historySource.pushState = (state: unknown, title: string, url?: string | URL | null): void => {
        this.originalPushState?.(state, title, url);
        this.captureRouteChange(url);
      };

      historySource.replaceState = (state: unknown, title: string, url?: string | URL | null): void => {
        this.originalReplaceState?.(state, title, url);
        this.captureRouteChange(url);
      };
    }

    const consoleHooks = installConsoleHook(this.config, (breadcrumb) => {
      this.addBreadcrumb(breadcrumb);
    });
    this.originalConsoleError = consoleHooks.originalConsoleError;
    this.originalConsoleWarn = consoleHooks.originalConsoleWarn;

    const networkHooks = installNetworkHook(
      this.config,
      (breadcrumb) => {
        this.addBreadcrumb(breadcrumb);
      },
      (breadcrumb) => {
        this.captureNetworkRequestFailure(breadcrumb);
      },
      (url, statusCode, durationMs) => this.shouldCaptureNetworkRequest(url, statusCode, durationMs),
      (url, durationMs) => this.shouldCaptureFailedNetworkRequest(url, durationMs),
      () => this.getCurrentRoute()
    );
    this.originalFetch = networkHooks.originalFetch;
    this.originalXmlHttpRequest = networkHooks.originalXmlHttpRequest;
  }

  private createCorrelation(): BrowserCorrelationFields {
    return {
      request_id: null,
      trace_id: null,
      session_id: null,
      user_id_hash: null
    };
  }

  private addBreadcrumb(breadcrumb: BrowserBreadcrumb): void {
    const config = this.config;
    if (config === null || this.authRejected || !this.shouldCaptureBreadcrumb()) {
      return;
    }

    if (config.breadcrumbsOnErrorOnly !== true) {
      this.enqueueEvent(this.createBreadcrumbEvent(breadcrumb));
      return;
    }

    this.breadcrumbs.push(breadcrumb);
    this.sessionEventCount += 1;
    while (this.breadcrumbs.length > config.maxBreadcrumbs) {
      this.breadcrumbs.shift();
    }
  }

  private bufferProbe(label: string, data: Record<string, unknown>): void {
    const config = this.config;
    if (config === null || this.authRejected) {
      return;
    }

    if (!this.probeBuffers.has(label) && this.probeBuffers.size >= config.maxProbeLabels) {
      return;
    }

    const buffer = this.probeBuffers.get(label) ?? [];
    buffer.push({
      label,
      data,
      timestamp: new Date().toISOString(),
      activation_id: null
    });

    while (buffer.length > config.maxProbeEntriesPerLabel) {
      buffer.shift();
    }

    this.probeBuffers.set(label, buffer);
  }

  private consumeProbeData(): { version: 1; items: BrowserProbeBufferItem[] } {
    const items = Array.from(this.probeBuffers.values()).flatMap((buffer) => buffer);
    this.probeBuffers.clear();
    return {
      version: 1,
      items
    };
  }

  private consumeBreadcrumbs(): BrowserBreadcrumb[] {
    const breadcrumbs = [...this.breadcrumbs];
    this.breadcrumbs = [];
    return breadcrumbs;
  }

  private captureRouteChange(url?: string | URL | null): void {
    if (this.config?.captureRouteChanges !== true) {
      return;
    }

    const route =
      typeof url === "string"
        ? url
        : url instanceof URL
          ? url.pathname
          : this.getCurrentRoute();

    if (route === null) {
      return;
    }

    this.addBreadcrumb({
      ts: new Date().toISOString(),
      breadcrumb_type: "route_change",
      route,
      data: {
        route
      }
    });
  }

  private createBreadcrumbEvent(breadcrumb: BrowserBreadcrumb): EventEnvelope {
    const config = this.config;
    if (config === null) {
      throw new Error("Browser SDK not initialized");
    }

    return this.createSdkEventEnvelope(config, {
      schema_version: SDK_SCHEMA_VERSION,
      event_type: "frontend_breadcrumb",
      ...this.getProjectTokenFields(config),
      sdk_name: SDK_NAME,
      sdk_version: SDK_VERSION,
      service: {
        name: config.service,
        runtime: "browser",
        framework: null,
        environment: config.environment
      },
      occurred_at: breadcrumb.ts,
      correlation: this.createCorrelation(),
      payload: {
        breadcrumb_type: breadcrumb.breadcrumb_type,
        route: breadcrumb.route ?? this.getCurrentRoute(),
        data: breadcrumb.data
      }
    });
  }

  private captureNetworkRequestFailure(breadcrumb: BrowserBreadcrumb): void {
    const config = this.config;
    if (config === null || breadcrumb.breadcrumb_type !== "network_request") {
      return;
    }

    const data = breadcrumb.data;
    const statusCode = typeof data["status_code"] === "number" ? data["status_code"] : 0;
    if (
      !shouldCaptureRequestStatus(
        statusCode,
        this.remoteProbeState.requestFailurePreset,
        this.remoteProbeState.requestCaptureEvents,
        this.remoteProbeState.immediateClientErrorStatuses
      )
    ) {
      return;
    }

    const rawUrl = typeof data["url"] === "string" && data["url"].length > 0 ? data["url"] : "/";
    const method = typeof data["method"] === "string" && data["method"].length > 0 ? data["method"] : "GET";
    const durationMs = typeof data["duration_ms"] === "number" && Number.isFinite(data["duration_ms"])
      ? data["duration_ms"]
      : 0;
    const requestTarget = this.resolveRequestTarget(rawUrl);

    this.enqueueEvent(
      this.createSdkEventEnvelope(config, {
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "request_event",
        ...this.getProjectTokenFields(config),
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: {
          name: config.service,
          runtime: "browser",
          framework: null,
          environment: config.environment
        },
        occurred_at: breadcrumb.ts,
        correlation: this.createCorrelation(),
        payload: {
          method,
          path: requestTarget.path,
          query: requestTarget.query,
          headers: {},
          response_status: statusCode,
          duration_ms: durationMs,
          ...(Object.prototype.hasOwnProperty.call(data, "request_body") ? { body: data["request_body"] } : {}),
          ...(typeof data["response_headers"] === "object" && data["response_headers"] !== null
            ? { response_headers: data["response_headers"] as Record<string, unknown> }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(data, "response_body") ? { response_body: data["response_body"] } : {})
        }
      }),
      false
    );
  }

  private resolveRequestTarget(rawUrl: string): { path: string; query: Record<string, string> } {
    const locationSource = getLocationSource();
    const baseHref = typeof locationSource?.href === "string" && locationSource.href.length > 0 ? locationSource.href : undefined;

    try {
      const parsedUrl = baseHref === undefined ? new URL(rawUrl) : new URL(rawUrl, baseHref);
      return {
        path: parsedUrl.pathname || "/",
        query: Object.fromEntries(parsedUrl.searchParams.entries())
      };
    } catch {
      return { path: rawUrl.startsWith("/") ? rawUrl : "/", query: {} };
    }
  }

  private getCurrentRoute(): string | null {
    const locationSource = getLocationSource();
    if (locationSource === null) {
      return null;
    }

    return typeof locationSource.pathname === "string" ? locationSource.pathname : null;
  }

  private enqueueEvent(event: EventEnvelope, countTowardSession = true): void {
    const resolvedEvent = this.applyCaptureRulesToEvent(event);
    if (resolvedEvent === null) {
      return;
    }

    if (!this.shouldCaptureBySampleRate(resolvedEvent)) {
      return;
    }

    const suppressionKey = this.buildSuppressionKey(resolvedEvent);
    if (suppressionKey !== null && !this.suppressionTracker.shouldCapture(suppressionKey, Date.now())) {
      this.scheduleFlush();
      return;
    }

    this.enqueueInternalEvent(resolvedEvent, countTowardSession);
  }

  private applyCaptureRulesToEvent(event: EventEnvelope): EventEnvelope | null {
    const config = this.config;
    if (config === null || config.captureRules.length === 0) {
      return event;
    }

    const projectId = config.captureRules[0]?.project_id;
    if (typeof projectId !== "string" || projectId.length === 0) {
      return event;
    }

    try {
      const captureRule = evaluateBrowserCaptureRulesForEvent(
        config.captureRules,
        projectId,
        event,
        new Date().toISOString()
      );

      if (captureRule === null) {
        return event;
      }

      if (captureRule.outcome === "drop" || captureRule.outcome === "sampled_out") {
        return null;
      }

      if (
        event.event_type === "frontend_exception" &&
        (captureRule.outcome === "demote" || captureRule.sample_event_class === "context")
      ) {
        this.addBreadcrumb(this.createDemotedExceptionBreadcrumb(event, captureRule));
        return null;
      }

      if (
        event.event_type === "request_event" &&
        (captureRule.outcome === "demote" || captureRule.sample_event_class === "context")
      ) {
        return null;
      }
    } catch {
      return event;
    }

    return event;
  }

  private createDemotedExceptionBreadcrumb(
    event: Extract<EventEnvelope, { event_type: "frontend_exception" }>,
    captureRule: BrowserCaptureRuleEvaluationResult
  ): BrowserBreadcrumb {
    const payload = event.payload as Record<string, unknown>;
    const browserEventRecord =
      typeof payload["browser_event"] === "object" && payload["browser_event"] !== null
        ? (payload["browser_event"] as Record<string, unknown>)
        : null;
    const targetRecord =
      typeof browserEventRecord?.["target"] === "object" && browserEventRecord["target"] !== null
        ? (browserEventRecord["target"] as Record<string, unknown>)
        : null;
    const browserEventKind =
      browserEventRecord?.["kind"] === "window_error" || browserEventRecord?.["kind"] === "resource_error"
        ? browserEventRecord["kind"]
        : undefined;
    const sourceUrl =
      typeof targetRecord?.["source_url"] === "string"
        ? targetRecord["source_url"]
        : typeof browserEventRecord?.["file_name"] === "string"
          ? browserEventRecord["file_name"]
          : null;

    return {
      ts: event.occurred_at,
      breadcrumb_type: "console_log",
      route: event.payload.route ?? this.getCurrentRoute(),
      data: {
        level: "error",
        message: `${event.payload.name}: ${event.payload.message}`,
        source: "capture_rule_demoted_exception",
        capture_rule_action: captureRule.action,
        capture_rule_outcome: captureRule.outcome,
        ...(browserEventKind === undefined ? {} : { browser_event_kind: browserEventKind }),
        ...(sourceUrl === null ? {} : { source_url: sourceUrl })
      }
    };
  }

  private enqueueInternalEvent(event: EventEnvelope, countTowardSession = true): void {
    const config = this.config;
    if (config === null || this.authRejected) {
      return;
    }

    this.bufferedEvents.push(event);
    if (countTowardSession && event.event_type !== "frontend_exception") {
      this.sessionEventCount += 1;
    }

    if (this.bufferedEvents.length >= config.batchSize) {
      queueMicrotask(() => {
        void this.flush();
      });
      return;
    }

    this.scheduleFlush();
  }

  private buildSuppressionKey(event: EventEnvelope): string | null {
    if (event.event_type === "frontend_exception") {
      const stackFrame = event.payload.stack.split("\n")[1]?.trim() ?? null;

      return JSON.stringify({
        event_type: event.event_type,
        name: event.payload.name,
        message: event.payload.message,
        stack_frame: stackFrame,
        route: event.payload.route
      });
    }

    if (event.event_type === "log_event") {
      return JSON.stringify({
        event_type: event.event_type,
        level: event.payload.level,
        message: event.payload.message,
        attributes: event.payload.attributes
      });
    }

    if (event.event_type === "request_event") {
      return JSON.stringify({
        event_type: event.event_type,
        method: event.payload.method,
        path: event.payload.path,
        response_status: event.payload.response_status
      });
    }

    return null;
  }

  private shouldCaptureBySampleRate(event: EventEnvelope): boolean {
    const config = this.config;
    if (config === null) {
      return false;
    }

    if (
      event.event_type === "frontend_exception" ||
      event.event_type === "error_suppressed" ||
      (
        event.event_type === "request_event" &&
        isImmediateRequestIncidentStatus(
          event.payload.response_status,
          this.remoteProbeState.requestFailurePreset,
          this.remoteProbeState.immediateClientErrorStatuses
        )
      )
    ) {
      return true;
    }

    return config.sampleRate >= 1 || Math.random() <= config.sampleRate;
  }

  private scheduleFlush(delayMs?: number): void {
    const config = this.config;
    if (config === null) {
      return;
    }

    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, delayMs ?? config.flushInterval);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private flushViaBeacon(): void {
    const config = this.config;
    const navigatorSource = getNavigatorSource();
    if (config === null || this.bufferedEvents.length === 0 || navigatorSource === null) {
      return;
    }

    const pendingEvents = [...this.bufferedEvents];
    const body = buildBrowserTransportRequestBody(config.transportMode, pendingEvents);

    const flushViaKeepalive = (): void => {
      if (config.fetchImpl === null) {
        void this.flush();
        return;
      }

      void config
        .fetchImpl(config.endpoint, {
          method: "POST",
          headers: this.getTransportHeaders(config),
          body,
          keepalive: true
        })
        .then(() => {
          if (this.bufferedEvents === pendingEvents || this.sameLeadingEvents(pendingEvents)) {
            this.bufferedEvents.splice(0, pendingEvents.length);
          }
          this.nextRetryAt = null;
          this.clearFlushTimer();
        })
        .catch(() => {
          return;
        });
    };

    if (typeof navigatorSource.sendBeacon !== "function") {
      flushViaKeepalive();
      return;
    }

    const beaconBody = typeof Blob === "function"
      ? new Blob([body], { type: "application/json" })
      : body;
    const accepted = navigatorSource.sendBeacon(config.endpoint, beaconBody);
    if (accepted) {
      this.bufferedEvents = [];
      this.nextRetryAt = null;
      this.clearFlushTimer();
      return;
    }

    flushViaKeepalive();
  }

  private sameLeadingEvents(events: EventEnvelope[]): boolean {
    if (this.bufferedEvents.length < events.length) {
      return false;
    }

    return events.every((event, index) => this.bufferedEvents[index]?.event_id === event.event_id);
  }

  private shouldCaptureNonExceptionEvent(): boolean {
    const config = this.config;
    if (config === null) {
      return false;
    }

    return this.sessionSampledIn && this.sessionEventCount < config.maxEventsPerSession;
  }

  private shouldCaptureBreadcrumb(): boolean {
    return this.shouldCaptureNonExceptionEvent();
  }

  private getProjectTokenFields(config: ActiveConfig): Record<string, string> {
    if (config.projectToken === null) {
      return {};
    }

    return {
      project_token: config.projectToken
    };
  }

  private getTransportHeaders(config: ActiveConfig): Record<string, string> {
    if (config.projectToken === null) {
      return {
        "content-type": "application/json"
      };
    }

    return {
      "content-type": "application/json",
      authorization: `Bearer ${config.projectToken}`
    };
  }

  private createSdkEventEnvelope(
    config: ActiveConfig,
    input: Parameters<typeof createEventEnvelope>[0]
  ): EventEnvelope {
    const event = createEventEnvelope(input);
    this.removeEmptyProjectToken(event, config);
    return event;
  }

  private removeEmptyProjectToken(event: EventEnvelope, config: ActiveConfig): void {
    if (config.projectToken !== null) {
      return;
    }

    delete (event as Record<string, unknown>)["project_token"];
  }

  private enqueueSuppressionAggregates(): void {
    const config = this.config;
    if (config === null) {
      return;
    }

    for (const aggregate of this.suppressionTracker.drainAggregates(Date.now())) {
      this.enqueueInternalEvent(
        this.createSdkEventEnvelope(config, {
          schema_version: SDK_SCHEMA_VERSION,
          event_type: "error_suppressed",
          ...this.getProjectTokenFields(config),
          sdk_name: SDK_NAME,
          sdk_version: SDK_VERSION,
          service: {
            name: config.service,
            runtime: "browser",
            framework: null,
            environment: config.environment
          },
          occurred_at: aggregate.lastSeen,
          payload: {
            fingerprint: aggregate.fingerprint,
            suppressed_count: aggregate.suppressedCount,
            window_seconds: aggregate.windowSeconds,
            first_seen: aggregate.firstSeen,
            last_seen: aggregate.lastSeen
          }
        }),
        false
      );
    }
  }

  private shouldCaptureNetworkRequest(url: string, statusCode: number, durationMs: number): boolean {
    const config = this.config;
    if (config === null) {
      return false;
    }

    const filter = config.networkFilter;
    if (filter.urlPatterns.length > 0 && !filter.urlPatterns.some((pattern) => matchesBrowserPattern(url, pattern))) {
      return false;
    }

    if (filter.urlDenyPatterns.some((pattern) => matchesBrowserPattern(url, pattern))) {
      return false;
    }

    if (filter.minResponseTime !== null && durationMs < filter.minResponseTime) {
      return false;
    }

    return matchesStatusCodeFilter(statusCode, filter.statusCodes);
  }

  private shouldCaptureFailedNetworkRequest(url: string, durationMs: number): boolean {
    const config = this.config;
    if (config === null) {
      return false;
    }

    const filter = config.networkFilter;
    if (filter.urlPatterns.length > 0 && !filter.urlPatterns.some((pattern) => matchesBrowserPattern(url, pattern))) {
      return false;
    }

    if (filter.urlDenyPatterns.some((pattern) => matchesBrowserPattern(url, pattern))) {
      return false;
    }

    if (filter.minResponseTime !== null && durationMs < filter.minResponseTime) {
      return false;
    }

    return true;
  }

  private pruneExpiredRemoteProbeDirectives(nowMs: number): void {
    const directives = this.remoteProbeState.directives.filter((directive) => Date.parse(directive.expiresAt) > nowMs);
    if (this.activeTriggerDirective !== null && Date.parse(this.activeTriggerDirective.expiresAt) <= nowMs) {
      this.activeTriggerDirective = null;
    }
    if (directives.length === this.remoteProbeState.directives.length) {
      return;
    }

    this.remoteProbeState = {
      ...this.remoteProbeState,
      directives
    };
  }

  private async refreshRemoteProbeConfig(): Promise<void> {
    const config = this.config;
    if (config === null || config.fetchImpl === null || config.transportMode !== "direct" || config.projectToken === null) {
      return;
    }

    try {
      const response = await config.fetchImpl(deriveSdkConfigEndpoint(config.endpoint), {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.projectToken}`
        }
      });

      if (response.status === 304 || typeof response.json !== "function") {
        return;
      }

      const payload = await response.json();
      const parsed = parseRemoteProbeConfigPayload(payload, Date.now());
      if (parsed !== null) {
        this.remoteProbeState = parsed;
        this.pruneExpiredRemoteProbeDirectives(Date.now());
        await this.activatePendingTriggerTokenIfPossible();
      }
      config.captureRules = parseRemoteCaptureRulesPayload(payload);
    } catch {
      return;
    }
  }

  private updateRemoteProbeStateFromIngestionResponse(payload: unknown): void {
    const directives = parseIngestionProbeDirectives(payload, Date.now());
    if (directives === null) {
      this.pruneExpiredRemoteProbeDirectives(Date.now());
      return;
    }

    this.remoteProbeState = {
      ...this.remoteProbeState,
      directives
    };
    this.pruneExpiredRemoteProbeDirectives(Date.now());
  }

  private consumeTriggerTokenFromLocation(): string | null {
    const locationSource = getLocationSource();
    const historySource = getHistorySource();
    const search = typeof locationSource?.search === "string" ? locationSource.search : "";
    if (search.length === 0) {
      return null;
    }

    const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
    const token = params.get("_debug_probe");
    if (token === null || token.length === 0) {
      return null;
    }

    params.delete("_debug_probe");
    const cleanedPath = `${locationSource?.pathname ?? ""}${params.toString().length > 0 ? `?${params.toString()}` : ""}`;
    historySource?.replaceState({}, "", cleanedPath);
    return token;
  }

  private async activatePendingTriggerTokenIfPossible(): Promise<void> {
    if (this.pendingTriggerToken === null) {
      return;
    }

    const directive = await validateBrowserTriggerToken({
      token: this.pendingTriggerToken,
      triggerTokenKey: this.remoteProbeState.triggerTokenKey,
      nowMs: Date.now()
    });

    this.pendingTriggerToken = null;
    this.activeTriggerDirective = directive;
  }

  private normalizeProbeInput(data: unknown): Record<string, JsonValue> {
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { value: data as JsonValue };
    }

    return data as Record<string, JsonValue>;
  }

  private getMatchingRemoteProbeDirectives(label: string, nowMs: number): BrowserRemoteProbeDirective[] {
    const config = this.config;
    if (
      config === null ||
      this.remoteProbeState.probesEnabled !== true ||
      this.remoteProbeState.remoteProbesEnabled !== true
    ) {
      return [];
    }

    this.pruneExpiredRemoteProbeDirectives(nowMs);
    const activeDirectives = this.activeTriggerDirective === null
      ? this.remoteProbeState.directives
      : [...this.remoteProbeState.directives, this.activeTriggerDirective];

    return activeDirectives.filter((directive) => {
      if (directive.service !== "*" && directive.service !== config.service) {
        return false;
      }

      if (directive.environment !== "*" && directive.environment !== config.environment) {
        return false;
      }

      return this.matchesProbeLabelPattern(directive.labelPattern, label);
    });
  }

  private matchesProbeLabelPattern(pattern: string, label: string): boolean {
    if (pattern === "*") {
      return true;
    }

    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return label === prefix || label.startsWith(`${prefix}.`);
    }

    return pattern === label;
  }
}

export function createDebugBundleBrowserSdk(): DebugBundleBrowserSdk {
  return new BrowserSdk();
}
