import { sanitizeTelemetry } from "@debugbundle/redaction";
import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { BrowserAnalyticsController } from "./analytics.js";
import { applyBrowserBeforeSend } from "./before-send.js";
import {
  isImmediateRequestIncidentStatus,
  shouldCaptureBrowserNetworkRequest,
  shouldCaptureFailedBrowserNetworkRequest,
  shouldCaptureRequestStatus
} from "./capture-helpers.js";
import { applyBrowserCaptureRules, buildBrowserSuppressionKey } from "./event-pipeline.js";
import { collectDeviceInfo, installConsoleHook, installNetworkHook } from "./hooks.js";
import { captureNativeError, captureNativeRejection } from "./native-error-hooks.js";
import { countFormFields, readNativeField, readStructuralTarget } from "./native-fields.js";
import { EventSuppressionTracker } from "./suppression.js";
import { BrowserEventTransport, type BrowserTransportLaneName } from "./event-transport.js";
import { BrowserProbeController } from "./probes.js";
import { protectBrowserEvent } from "./privacy.js";
import {
  buildSelector,
  createFetchTransport,
  getConsoleSource,
  getDocumentSource,
  getFetchSource,
  getHistorySource,
  getLocationSource,
  getWindowSource,
  createBrowserTraceId,
  normalizeBoolean,
  normalizeError,
  normalizeLogLevel,
  normalizeNetworkFilter,
  normalizePositiveNumber,
  normalizeSampleRate,
  normalizeTracePropagationTargets,
  normalizeUnknownRecord,
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
  type BrowserCorrelationFields,
  type BrowserDeviceInfo,
  type BrowserAnalyticsEventEnvelope,
  type BrowserFetch,
  type BrowserLogLevel,
  type BrowserRemoteProbeDirective,
  type BrowserRemoteProbeState,
  type BrowserXmlHttpRequestConstructor,
  type CaptureBrowserExceptionContext,
  type DebugBundleBrowserInitConfig,
  type DebugBundleBrowserSdk,
  type DebugBundleBrowserTransportEvent
} from "./types.js";

export type {
  CaptureBrowserExceptionContext,
  DebugBundleBrowserInitConfig,
  DebugBundleBrowserSdk,
  DebugBundleBrowserAnalytics,
  DebugBundleBrowserAnalyticsConfig,
  DebugBundleBrowserTransportEvent,
  BrowserRequestMetadata,
  DebugBundleBrowserTransport,
  DebugBundleBrowserTransportRequest,
  DebugBundleBrowserTransportResponse
} from "./types.js";
export type { BrowserBeforeSendHook } from "./before-send.js";

export class BrowserSdk implements DebugBundleBrowserSdk {
  private config: ActiveConfig | null = null;
  private breadcrumbs: BrowserBreadcrumb[] = [];
  private persistentContext: Record<string, unknown> = {};
  private deviceInfo: BrowserDeviceInfo | null = null;
  private browserSessionId: string | null = null;
  private analyticsInitialization: Promise<void> | null = null;
  private registeredListeners: Array<() => void> = [];
  private originalPushState: ((state: unknown, title: string, url?: string | URL | null) => void) | null = null;
  private originalReplaceState: ((state: unknown, title: string, url?: string | URL | null) => void) | null = null;
  private originalFetch: BrowserFetch | null = null;
  private originalXmlHttpRequest: BrowserXmlHttpRequestConstructor | null = null;
  private originalConsoleError: ((...args: unknown[]) => void) | null = null;
  private originalConsoleWarn: ((...args: unknown[]) => void) | null = null;
  private sessionSampledIn = true;
  private sessionEventCount = 0;
  private reportedAcknowledgementDiagnostics = new Set<string>();
  private readonly suppressionTracker = new EventSuppressionTracker();
  private readonly probeController = new BrowserProbeController({
    getConfig: () => this.config,
    isDebugRejected: () => this.eventTransport.debugRejected,
    isSessionSampledIn: () => this.sessionSampledIn,
    emitProbeEvent: ({ label, data, directive }) => this.emitProbeEvent(label, data, directive),
    applyRemoteAnalytics: (config) => this.analyticsController.applyRemoteSettings(config)
  });
  private readonly eventTransport = new BrowserEventTransport({
    onDebugResponse: (payload) => this.probeController.updateFromIngestionResponse(payload),
    onUnauthorized: (lane, statusCode, endpoint, body) => {
      this.reportUnauthorizedTransportFailure(lane, statusCode, endpoint, body);
    },
    onAcknowledgementDiagnostic: (lane, code, detail) => {
      this.reportAcknowledgementDiagnostic(lane, code, detail);
    }
  });
  private readonly analyticsController = new BrowserAnalyticsController({
    getConfig: () => this.config,
    getDeviceInfo: () => this.deviceInfo,
    getCurrentRoute: () => this.getCurrentRoute(),
    getSessionId: () => this.browserSessionId ?? createBrowserTraceId(),
    enqueue: (event) => this.enqueueAnalyticsEvent(event)
  });

  public readonly analytics = this.analyticsController.api;

  private get remoteProbeState(): BrowserRemoteProbeState {
    return this.probeController.state;
  }

  public get status(): "healthy" | "degraded" | "disconnected" {
    return this.eventTransport.status;
  }

  public get lastEventAt(): number | null {
    return this.eventTransport.lastEventAt;
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
      requestsAnalyticsConfig: config.analytics?.enabled === true,
      captureRules: [],
      fetchImpl: getFetchSource(),
      transport: config.transport ?? createFetchTransport(),
      transportMode: resolvedTransport.mode,
      ...(config.beforeSend === undefined ? {} : { beforeSend: config.beforeSend })
    };

    this.eventTransport.configure(this.config);
    this.sessionSampledIn = this.config.sessionSampleRate >= 1 || Math.random() < this.config.sessionSampleRate;
    this.sessionEventCount = 0;
    this.browserSessionId = createBrowserTraceId();
    this.deviceInfo = collectDeviceInfo();
    const deferAnalyticsCapture =
      this.config.requestsAnalyticsConfig &&
      this.config.transportMode === "direct" &&
      this.config.projectToken !== null &&
      this.config.fetchImpl !== null;
    this.analyticsController.configure(config.analytics, { deferCapture: deferAnalyticsCapture });
    const remoteInitialization = this.probeController.initialize();
    this.installBrowserHooks();
    if (deferAnalyticsCapture) {
      const activeConfig = this.config;
      this.analyticsInitialization = remoteInitialization.finally(() => {
        if (this.config !== activeConfig) {
          return;
        }
        this.analyticsController.markCaptureReady();
      });
    } else {
      this.analyticsController.captureSessionStart();
      this.analyticsController.captureInitialPageView();
    }
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
      const probeData = config.probeFlushOnError
        ? this.probeController.consumeBufferedData()
        : { version: 1 as const, items: [] };
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
      if (context.rejection_reason !== undefined) {
        (event.payload as Record<string, unknown>)["rejection_reason"] = context.rejection_reason;
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
      const protectedAttributes = sanitizeTelemetry({
        ...this.persistentContext,
        ...normalizeUnknownRecord(context)
      }, { additionalKeys: config.redactFields });
      if (!protectedAttributes.ok || protectedAttributes.value === null ||
          Array.isArray(protectedAttributes.value) || typeof protectedAttributes.value !== "object") return;
      const attributes = protectedAttributes.value;

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
    if (config === null || typeof key !== "string" || key.length > 128 || key.trim().length === 0) {
      return;
    }

    try {
      const result = sanitizeTelemetry({ ...this.persistentContext, [key]: value }, { additionalKeys: config.redactFields });
      if (!result.ok || result.value === null || Array.isArray(result.value) || typeof result.value !== "object") return;
      this.persistentContext = result.value;
    } catch {
      return;
    }
  }

  public probe(label: string, data: unknown): void {
    this.probeController.capture(label, data);
  }

  public async flush(): Promise<void> {
    await this.analyticsInitialization;
    this.enqueueSuppressionAggregates();
    await this.eventTransport.flush();
  }

  public dispose(): void {
    this.eventTransport.reset();
    this.breadcrumbs = [];
    this.persistentContext = {};
    this.deviceInfo = null;
    this.browserSessionId = null;
    this.analyticsInitialization = null;
    this.config = null;
    this.sessionSampledIn = true;
    this.sessionEventCount = 0;
    this.reportedAcknowledgementDiagnostics.clear();
    this.suppressionTracker.reset();
    this.probeController.reset();
    this.analyticsController.reset();

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

  private reportUnauthorizedTransportFailure(
    lane: BrowserTransportLaneName,
    statusCode: 401 | 403,
    endpoint: string,
    body: unknown
  ): void {
    const consoleSource = getConsoleSource();
    if (consoleSource === null) {
      return;
    }

    const bodyRecord = normalizeUnknownRecord(body);
    const errorCode = typeof bodyRecord["error"] === "string" && bodyRecord["error"].length > 0 ? bodyRecord["error"] : null;
    const detail = errorCode === null ? "" : ` (${errorCode})`;
    const laneLabel = lane === "debug" ? "browser SDK" : "browser analytics";
    const message =
      `DebugBundle ${laneLabel} disabled after ingestion returned ${statusCode} for ${endpoint}. ` +
      `Check the project token or relay configuration${detail}.`;

    if (typeof consoleSource.error === "function") {
      consoleSource.error(message);
      return;
    }

    consoleSource.warn?.(message);
  }

  private reportAcknowledgementDiagnostic(
    lane: BrowserTransportLaneName,
    code: "invalid" | "terminal_rejection",
    detail: string
  ): void {
    const key = `${lane}:${code}:${detail}`;
    if (this.reportedAcknowledgementDiagnostics.has(key)) {
      return;
    }
    this.reportedAcknowledgementDiagnostics.add(key);
    const consoleSource = getConsoleSource();
    const laneLabel = lane === "debug" ? "browser SDK" : "browser analytics";
    consoleSource?.warn?.(
      code === "invalid"
        ? `DebugBundle ${laneLabel} retained events after an invalid ingestion acknowledgement (${detail}).`
        : `DebugBundle ${laneLabel} removed terminally rejected events (${detail}).`
    );
  }

  private installBrowserHooks(): void {
    const windowSource = getWindowSource();
    if (windowSource !== null) {
      const onPageHide = (event: unknown): void => {
        if (readNativeField(event, "persisted") !== true) {
          this.analyticsController.captureSessionSummary();
        }
        this.flushViaBeacon();
      };
      const onError = (event: unknown): void => {
        captureNativeError(event, (error, context) => this.captureException(error, context));
      };
      const onUnhandledRejection = (event: unknown): void => {
        captureNativeRejection(event, (error, context) => this.captureException(error, context));
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
        const captureDebugClick = this.config?.captureClicks === true;
        const captureAnalyticsAction = this.analyticsController.shouldCaptureStructuralActions();
        const captureAnalyticsFriction = this.analyticsController.shouldCaptureFrictionSignals();
        if (!captureDebugClick && !captureAnalyticsAction && !captureAnalyticsFriction) {
          return;
        }

        const targetIdentity = readNativeField(event, "target");
        const target = readStructuralTarget(targetIdentity);
        if (captureDebugClick) {
          const selector = buildSelector(target);
          if (selector !== null) {
            this.addBreadcrumb({
              ts: new Date().toISOString(),
              breadcrumb_type: "click",
              data: {
                selector
              }
            });
          }
        }

        if (captureAnalyticsAction) {
          this.analyticsController.captureStructuralAction(target);
        }
        if (captureAnalyticsFriction) {
          this.analyticsController.captureFrictionClick(target, targetIdentity);
        }
      };

      const onSubmit = (event: unknown): void => {
        const targetIdentity = readNativeField(event, "target");
        const target = readStructuralTarget(targetIdentity);
        const selector = buildSelector(target) ?? "form";
        const fieldCount = countFormFields(targetIdentity);

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
      (url, statusCode, durationMs) => shouldCaptureBrowserNetworkRequest(this.config, url, statusCode, durationMs),
      (url, durationMs) => shouldCaptureFailedBrowserNetworkRequest(this.config, url, durationMs),
      () => this.getCurrentRoute()
    );
    this.originalFetch = networkHooks.originalFetch;
    this.originalXmlHttpRequest = networkHooks.originalXmlHttpRequest;
  }

  private createCorrelation(): BrowserCorrelationFields {
    return {
      request_id: null,
      trace_id: null,
      session_id: this.browserSessionId,
      user_id_hash: null
    };
  }

  private addBreadcrumb(breadcrumb: BrowserBreadcrumb): void {
    const config = this.config;
    if (config === null || this.eventTransport.debugRejected || !this.shouldCaptureBreadcrumb()) {
      return;
    }

    const protectedBreadcrumb = sanitizeTelemetry(breadcrumb, { additionalKeys: config.redactFields });
    if (!protectedBreadcrumb.ok || protectedBreadcrumb.value === null ||
        Array.isArray(protectedBreadcrumb.value) || typeof protectedBreadcrumb.value !== "object") return;
    breadcrumb = protectedBreadcrumb.value as unknown as BrowserBreadcrumb;

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
    this.analyticsController.captureRouteChange(route);
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

  private emitProbeEvent(
    label: string,
    data: Record<string, unknown>,
    directive: BrowserRemoteProbeDirective
  ): void {
    const config = this.config;
    if (config === null) {
      return;
    }
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
          label,
          data,
          activation_id: directive.activationId,
          probe_label_pattern: directive.labelPattern
        }
      }),
      false
    );
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
        this.remoteProbeState.immediateClientErrorStatuses,
        typeof data["url"] === "string" ? data["url"] : undefined,
        typeof data["method"] === "string" ? data["method"] : undefined,
        this.remoteProbeState.immediateClientErrorPathRules
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
    const protectedInput = protectBrowserEvent(event, this.config?.redactFields ?? []);
    if (protectedInput === null) return;
    const beforeSendEvent = applyBrowserBeforeSend(protectedInput, this.config?.beforeSend);
    if (beforeSendEvent === null) {
      return;
    }

    const protectedResult = protectBrowserEvent(beforeSendEvent, this.config?.redactFields ?? []);
    if (protectedResult === null) return;

    const captureRuleResult = applyBrowserCaptureRules({
      config: this.config,
      event: protectedResult,
      currentRoute: this.getCurrentRoute(),
      now: new Date().toISOString()
    });
    if (captureRuleResult.breadcrumb !== null) {
      this.addBreadcrumb(captureRuleResult.breadcrumb);
    }
    const resolvedEvent = captureRuleResult.event;
    if (resolvedEvent === null) {
      return;
    }

    if (!this.shouldCaptureBySampleRate(resolvedEvent)) {
      return;
    }

    const suppressionKey = buildBrowserSuppressionKey(resolvedEvent);
    if (suppressionKey !== null && !this.suppressionTracker.shouldCapture(suppressionKey, Date.now())) {
      this.eventTransport.scheduleDebug();
      return;
    }

    this.enqueueInternalEvent(resolvedEvent, countTowardSession, false);
  }

  private enqueueAnalyticsEvent(event: BrowserAnalyticsEventEnvelope): void {
    this.eventTransport.enqueueAnalytics(event);
  }

  private enqueueInternalEvent(event: DebugBundleBrowserTransportEvent, countTowardSession = true, applyBeforeSend = true): void {
    const config = this.config;
    if (config === null || this.eventTransport.debugRejected) {
      return;
    }

    if (applyBeforeSend && event.event_type !== "analytics_event") {
      const protectedInput = protectBrowserEvent(event, config.redactFields);
      if (protectedInput === null) return;
      const beforeSendEvent = applyBrowserBeforeSend(protectedInput, config.beforeSend);
      if (beforeSendEvent === null) {
        return;
      }

      event = beforeSendEvent;
    }

    if (event.event_type !== "analytics_event") {
      const protectedResult = protectBrowserEvent(event, config.redactFields);
      if (protectedResult === null) return;
      event = protectedResult;
    }

    this.eventTransport.enqueueDebug(event);
    if (countTowardSession && event.event_type !== "frontend_exception") {
      this.sessionEventCount += 1;
    }

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
          this.remoteProbeState.immediateClientErrorStatuses,
          event.payload.path,
          event.payload.method,
          this.remoteProbeState.immediateClientErrorPathRules
        )
      )
    ) {
      return true;
    }

    return config.sampleRate >= 1 || Math.random() <= config.sampleRate;
  }

  private flushViaBeacon(): void {
    this.analyticsController.prepareForUnload();
    this.eventTransport.flushViaBeacon();
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

}

export function createDebugBundleBrowserSdk(): DebugBundleBrowserSdk {
  return new BrowserSdk();
}
