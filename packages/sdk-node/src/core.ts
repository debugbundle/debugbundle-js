import { AsyncLocalStorage } from "node:async_hooks";

import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { resolveDefaultNodeTransport } from "./file-transport.js";
import { attachLoggerIntegration } from "./logger-integrations.js";
import { createExpressMiddleware, createFastifyPlugin, createNextHandlerWrapper } from "./framework-integrations.js";
import { findMatchingRemoteProbeDirectives, parseRemoteProbeConfig } from "./remote-probes.js";
import { EventSuppressionTracker } from "./suppression.js";
import { resolveRequestTriggerDirectives } from "./trigger-token.js";
import {
  BALANCED_CAPTURE_POLICY,
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENDPOINT,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_BUFFERED_EVENTS,
  DEFAULT_MAX_PROBE_ENTRIES,
  DEFAULT_MAX_PROBE_LABELS,
  DEFAULT_PROBES_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOG_LEVEL_ORDER,
  MINIMAL_CAPTURE_POLICY,
  SDK_NAME,
  SDK_SCHEMA_VERSION,
  SDK_VERSION,
  type ActiveConfig,
  type CaptureExceptionContext,
  type CaptureLogContext,
  type CapturePolicy,
  type CaptureRequestContext,
  type CaptureRequestInput,
  type CaptureResponseInput,
  type CorrelationFields,
  type DebugBundleDiagnostic,
  type DebugBundleNodeInitConfig,
  type FrameworkSdkBridge,
  type LogLevel,
  type NextApiHandler,
  type NextWrappedHandler,
  type RemoteProbeConfigSnapshot,
  type RemoteProbeDirective,
  type ProbeBufferItem,
  type ProbeOptions
} from "./types.js";
import {
  buildSdkConfigEndpoint,
  detectRuntimeContext,
  ensureObject,
  extractHeaderValue,
  fetchWithTimeout,
  normalizeError,
  normalizeFiniteNumber,
  normalizeSampleRate,
  redactObject,
  sanitizeMetadataObject,
  sanitizeUnknown
} from "./utils.js";

function normalizeLogLevel(level: string | undefined): LogLevel {
  if (level === undefined) {
    return DEFAULT_LOG_LEVEL;
  }

  return level in LOG_LEVEL_ORDER ? (level as LogLevel) : DEFAULT_LOG_LEVEL;
}

export class DebugBundleNodeSdk implements FrameworkSdkBridge {
  private config: ActiveConfig | null = null;
  private buffer: EventEnvelope[] = [];
  private nextRetryAt: number | null = null;
  private _lastEventAt: number | null = null;
  private _consecutiveFailures = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private remoteProbePollTimer: ReturnType<typeof setTimeout> | null = null;
  private flushPromise: Promise<void> | null = null;
  private contextFields: Record<string, unknown> = {};
  private probeBuffers = new Map<string, ProbeBufferItem[]>();
  private remoteConfigFetchedOnce = false;
  private remoteProbeConfigEtag: string | null = null;
  private readonly requestContextStorage = new AsyncLocalStorage<{
    request: CaptureRequestInput;
  }>();
  private remoteProbeConfig: RemoteProbeConfigSnapshot = {
    probesEnabled: false,
    remoteProbesEnabled: false,
    directives: [],
    pollIntervalMs: DEFAULT_PROBES_POLL_INTERVAL_MS,
    triggerTokenKey: null,
    capturePolicy: BALANCED_CAPTURE_POLICY
  };
  private uncaughtExceptionHandler: ((error: Error) => void) | null = null;
  private unhandledRejectionHandler: ((reason: unknown) => void) | null = null;
  private originalConsoleError: typeof console.error | null = null;
  private originalConsoleWarn: typeof console.warn | null = null;
  private signalHandler: (() => void) | null = null;
  private beforeExitHandler: (() => void) | null = null;
  private loggerRestorers: Array<() => void> = [];
  private attachedLoggers = new WeakSet<object>();
  private readonly suppressionTracker = new EventSuppressionTracker();

  public get status(): "healthy" | "degraded" | "disconnected" {
    if (this.config === null) {
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

  public init(config: DebugBundleNodeInitConfig): void {
    this.dispose();

    const detection = detectRuntimeContext();
    const projectToken = config.projectToken?.trim();
    const enabled = config.enabled ?? true;
    if (!enabled || projectToken === undefined || projectToken.length === 0) {
      this.emitDiagnostic("sdk_disabled", "sdk-node initialized without a valid project token");
      return;
    }

    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const environment = config.environment ?? process.env["NODE_ENV"] ?? "development";
    const service = config.service ?? detection.service ?? "node-service";
    const resolvedTransport =
      config.transport === undefined
        ? resolveDefaultNodeTransport({
            environment,
            projectMode: config.projectMode ?? "connected",
            projectToken,
            endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
            fetchImpl,
            ...(config.localEventsDir === undefined ? {} : { localEventsDir: config.localEventsDir }),
            serviceName: service,
          })
        : {
            transport: config.transport,
            shouldRefreshRemoteConfig: true,
          };

    this.config = {
      projectToken,
      environment,
      service,
      framework: config.framework ?? detection.framework,
      redactFields: config.redactFields ?? ["password", "secret", "token", "authorization", "cookie", "ssn", "credit_card"],
      sampleRate: normalizeSampleRate(config.sampleRate),
      batchSize: normalizeFiniteNumber(config.batchSize, DEFAULT_BATCH_SIZE, 1),
      flushInterval: normalizeFiniteNumber(config.flushInterval, DEFAULT_FLUSH_INTERVAL_MS, 1),
      endpoint: config.endpoint ?? DEFAULT_ENDPOINT,
      logLevel: normalizeLogLevel(config.logLevel),
      maxBufferedEvents: normalizeFiniteNumber(config.maxBufferedEvents, DEFAULT_MAX_BUFFERED_EVENTS, 1),
      probesPollInterval: normalizeFiniteNumber(config.probesPollInterval, DEFAULT_PROBES_POLL_INTERVAL_MS, 1),
      maxProbeLabels: normalizeFiniteNumber(config.maxProbeLabels, DEFAULT_MAX_PROBE_LABELS, 1),
      maxProbeEntriesPerLabel: normalizeFiniteNumber(config.maxProbeEntriesPerLabel, DEFAULT_MAX_PROBE_ENTRIES, 1),
      probeFlushOnError: config.probeFlushOnError ?? true,
      requestTimeoutMs: normalizeFiniteNumber(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1),
      fetchImpl,
      transport: resolvedTransport.transport,
      autoDetectLoggers: config.autoDetectLoggers ?? true,
      ...(config.resolveModule === undefined ? {} : { resolveModule: config.resolveModule }),
      ...(config.onDiagnostic === undefined ? {} : { onDiagnostic: config.onDiagnostic })
    };

    if (resolvedTransport.diagnostic !== undefined) {
      this.emitDiagnostic(
        resolvedTransport.diagnostic.code,
        resolvedTransport.diagnostic.message,
        resolvedTransport.diagnostic.metadata
      );
    }

    this.captureExceptions();
    this.captureRejections();
    this.registerShutdownFlush();

    if (config.captureConsole === true) {
      this.captureConsole();
    }

    if (config.logger !== undefined && this.config.autoDetectLoggers) {
      this.attachLogger(config.logger);
    }

    if (resolvedTransport.shouldRefreshRemoteConfig) {
      void this.refreshRemoteProbeConfig();
    }
  }

  public dispose(): void {
    this.clearFlushTimer();
    this.clearRemoteProbePollTimer();
    this.restoreConsole();

    if (this.uncaughtExceptionHandler !== null) {
      process.off("uncaughtException", this.uncaughtExceptionHandler);
      this.uncaughtExceptionHandler = null;
    }

    if (this.unhandledRejectionHandler !== null) {
      process.off("unhandledRejection", this.unhandledRejectionHandler);
      this.unhandledRejectionHandler = null;
    }

    if (this.signalHandler !== null) {
      process.off("SIGINT", this.signalHandler);
      process.off("SIGTERM", this.signalHandler);
      this.signalHandler = null;
    }

    if (this.beforeExitHandler !== null) {
      process.off("beforeExit", this.beforeExitHandler);
      this.beforeExitHandler = null;
    }

    for (const restore of this.loggerRestorers.reverse()) {
      restore();
    }

    this.loggerRestorers = [];
    this.attachedLoggers = new WeakSet<object>();
    this.config = null;
    this.buffer = [];
    this.nextRetryAt = null;
    this._lastEventAt = null;
    this._consecutiveFailures = 0;
    this.flushPromise = null;
    this.contextFields = {};
    this.probeBuffers.clear();
    this.remoteProbeConfigEtag = null;
    this.remoteConfigFetchedOnce = false;
    this.remoteProbeConfig = {
      probesEnabled: false,
      remoteProbesEnabled: false,
      directives: [],
      pollIntervalMs: DEFAULT_PROBES_POLL_INTERVAL_MS,
      triggerTokenKey: null,
      capturePolicy: BALANCED_CAPTURE_POLICY
    };
    this.suppressionTracker.reset();
  }

  public attachLogger(logger: unknown): boolean {
    const config = this.config;
    if (config === null || !config.autoDetectLoggers || logger === null || typeof logger !== "object") {
      return false;
    }

    const loggerObject = logger;
    if (this.attachedLoggers.has(loggerObject)) {
      return true;
    }

    const attachment = attachLoggerIntegration({
      logger,
      captureApi: this,
      ...(config.resolveModule === undefined ? {} : { resolveModule: config.resolveModule }),
      onDiagnostic: (diagnostic: DebugBundleDiagnostic) => this.emitDiagnostic(diagnostic.code, diagnostic.message, diagnostic.metadata)
    });

    if (!attachment.attached) {
      return false;
    }

    this.attachedLoggers.add(loggerObject);
    if (attachment.restore !== undefined) {
      this.loggerRestorers.push(attachment.restore);
    }

    return true;
  }

  public express(): ReturnType<typeof createExpressMiddleware> {
    return createExpressMiddleware(this);
  }

  public fastify(): ReturnType<typeof createFastifyPlugin> {
    return createFastifyPlugin(this);
  }

  public nextjs<Request extends {
    method?: string;
    url?: string;
    headers?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: unknown;
    logger?: unknown;
    log?: unknown;
  }, Response extends { statusCode?: number }, Result>(handler: NextApiHandler<Request, Response, Result>): NextWrappedHandler<Request, Response, Result> {
    return createNextHandlerWrapper(this, handler);
  }

  public captureException(error: unknown, context: CaptureExceptionContext = {}): void {
    const config = this.config;
    if (config === null || !this.shouldCapture(config.sampleRate)) {
      return;
    }

    try {
      const normalizedError = normalizeError(error);
      const request = this.buildRequestSnapshot(context.request);
      const response = this.buildResponseSnapshot(context.response);
      const probeData = config.probeFlushOnError ? this.consumeProbeData() : null;

      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "backend_exception",
        project_token: config.projectToken,
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: this.buildServiceDescriptor(config),
        occurred_at: new Date().toISOString(),
        correlation: this.buildCorrelation(context.correlation, context.request),
        payload: {
          name: normalizedError.name,
          message: normalizedError.message,
          stack: normalizedError.stack ?? `${normalizedError.name}: ${normalizedError.message}`,
          handled: context.handled ?? false,
          request,
          response,
          runtime: {
            version: process.version
          },
          ...(probeData === null ? {} : { probe_data: probeData })
        }
      });

      this.enqueueEvent(event);
    } catch (caught) {
      this.emitDiagnostic("capture_exception_failed", "sdk-node failed to capture exception", {
        error: ensureObject(caught)
      });
    }
  }

  public captureError(error: unknown, context: CaptureExceptionContext = {}): void {
    this.captureException(error, context);
  }

  public captureLog(message: string, level: LogLevel, context: CaptureLogContext = {}): void {
    const config = this.config;
    if (config === null || !this.shouldCapture(config.sampleRate)) {
      return;
    }

    const policy = this.remoteProbeConfig.capturePolicy;
    if (policy.captureLogs === "off") {
      return;
    }

    const effectiveThreshold = this.effectiveLogThreshold(config.logLevel, policy);
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[effectiveThreshold]) {
      return;
    }

    try {
      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "log_event",
        project_token: config.projectToken,
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: this.buildServiceDescriptor(config),
        occurred_at: new Date().toISOString(),
        correlation: this.buildCorrelation(context.correlation),
        payload: {
          level,
          message,
          attributes: this.buildLogAttributes(context)
        }
      });

      this.enqueueEvent(event);
    } catch (caught) {
      this.emitDiagnostic("capture_log_failed", "sdk-node failed to capture log", {
        error: ensureObject(caught)
      });
    }
  }

  public captureRequest(request: CaptureRequestInput, response: CaptureResponseInput, context: CaptureRequestContext = {}): void {
    const config = this.config;
    if (config === null || !this.shouldCapture(config.sampleRate)) {
      return;
    }

    if (!this.shouldCaptureRequestEvent(response)) {
      return;
    }

    try {
      const requestSnapshot = this.buildRequestSnapshot(request);
      const responseSnapshot = this.buildResponseSnapshot(response);
      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "request_event",
        project_token: config.projectToken,
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: this.buildServiceDescriptor(config),
        occurred_at: new Date().toISOString(),
        correlation: this.buildCorrelation(context.correlation, request),
        payload: {
          method: requestSnapshot.method,
          path: requestSnapshot.path,
          query: requestSnapshot.query,
          headers: requestSnapshot.headers,
          ...(requestSnapshot.body === null ? {} : { body: requestSnapshot.body }),
          response_status: responseSnapshot.status_code,
          duration_ms: context.durationMs ?? response.durationMs ?? 0,
          ...(requestSnapshot.route_template === null ? {} : { route_template: requestSnapshot.route_template }),
          ...(responseSnapshot.headers !== undefined ? { response_headers: responseSnapshot.headers } : {}),
          ...(responseSnapshot.body !== undefined ? { response_body: responseSnapshot.body } : {})
        }
      });

      this.enqueueEvent(event);
    } catch (caught) {
      this.emitDiagnostic("capture_request_failed", "sdk-node failed to capture request", {
        error: ensureObject(caught)
      });
    }
  }

  public captureMessage(message: string, level: LogLevel = "info", context: CaptureLogContext = {}): void {
    this.captureLog(message, level, context);
  }

  public setContext(key: string, value: unknown): void {
    if (key.length === 0) {
      return;
    }

    const config = this.config;
    if (config === null) {
      return;
    }

    const redacted = redactObject({ [key]: value }, config.redactFields);
    this.contextFields[key] = redacted[key] ?? null;
  }

  public runWithRequestContext<Result>(request: CaptureRequestInput, callback: () => Result): Result {
    return this.requestContextStorage.run(
      {
        request
      },
      callback
    );
  }

  public shouldInstrumentRequest(request: CaptureRequestInput): boolean {
    const config = this.config;
    if (config === null) {
      return false;
    }

    const requestPath = this.normalizeRequestPath(request.path ?? request.url ?? request.routeTemplate ?? null);
    if (requestPath === null) {
      return true;
    }

    return !this.getInternalSdkPaths(config).includes(requestPath);
  }

  public probe(label: string, data: unknown, options: ProbeOptions = {}): void {
    const config = this.config;
    if (config === null || label.trim().length === 0) {
      return;
    }

    try {
      const matchingDirectives = this.getMatchingRemoteProbeDirectives(label, Date.now());
      if (options.heavy === true && matchingDirectives.length === 0) {
        return;
      }

      const resolved = typeof data === "function" ? (data as () => unknown)() : data;
      const redacted = redactObject(resolved, config.redactFields);

      if (options.heavy !== true) {
        if (!this.probeBuffers.has(label) && this.probeBuffers.size >= config.maxProbeLabels) {
          return;
        }

        const buffer = this.probeBuffers.get(label) ?? [];
        buffer.push({
          label,
          data: redacted,
          timestamp: new Date().toISOString(),
          activation_id: null
        });

        while (buffer.length > config.maxProbeEntriesPerLabel) {
          buffer.shift();
        }

        this.probeBuffers.set(label, buffer);
      }

      for (const directive of matchingDirectives) {
        this.enqueueInternalEvent(
          createEventEnvelope({
            schema_version: SDK_SCHEMA_VERSION,
            event_type: "probe_event",
            project_token: config.projectToken,
            sdk_name: SDK_NAME,
            sdk_version: SDK_VERSION,
            service: this.buildServiceDescriptor(config),
            occurred_at: new Date().toISOString(),
            correlation: this.buildCorrelation(undefined),
            payload: {
              label,
              data: redacted,
              activation_id: directive.id,
              probe_label_pattern: directive.labelPattern
            }
          })
        );
      }
    } catch (caught) {
      this.emitDiagnostic("probe_failed", "sdk-node failed to capture probe", {
        label,
        error: ensureObject(caught)
      });
    }
  }

  public captureExceptions(): void {
    if (this.config === null || this.uncaughtExceptionHandler !== null) {
      return;
    }

    this.uncaughtExceptionHandler = (error: Error): void => {
      this.captureException(error, { handled: false });
      void this.flush();
    };
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }

  public captureRejections(): void {
    if (this.config === null || this.unhandledRejectionHandler !== null) {
      return;
    }

    this.unhandledRejectionHandler = (reason: unknown): void => {
      this.captureException(normalizeError(reason), { handled: false });
      void this.flush();
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
  }

  public captureConsole(): void {
    if (this.config === null || this.originalConsoleError !== null || this.originalConsoleWarn !== null) {
      return;
    }

    this.originalConsoleError = console.error;
    this.originalConsoleWarn = console.warn;

    console.error = (...args: unknown[]): void => {
      this.originalConsoleError?.(...args);
      this.captureLog(this.formatConsoleMessage(args), "error");
    };

    console.warn = (...args: unknown[]): void => {
      this.originalConsoleWarn?.(...args);
      this.captureLog(this.formatConsoleMessage(args), "warning");
    };
  }

  private registerShutdownFlush(): void {
    if (this.signalHandler !== null) {
      return;
    }

    this.signalHandler = (): void => {
      void this.flush();
    };

    this.beforeExitHandler = (): void => {
      void this.flush();
    };

    process.on("SIGINT", this.signalHandler);
    process.on("SIGTERM", this.signalHandler);
    process.on("beforeExit", this.beforeExitHandler);
  }

  public async flush(): Promise<void> {
    if (this.config === null) {
      return;
    }

    if (this.flushPromise !== null) {
      return this.flushPromise;
    }

    this.clearFlushTimer();
    this.flushPromise = this.flushInternal();

    try {
      await this.flushPromise;
    } finally {
      this.flushPromise = null;
      if (this.buffer.length > 0) {
        const retryDelay = this.nextRetryAt === null ? undefined : Math.max(0, this.nextRetryAt - Date.now());
        this.scheduleFlush(retryDelay);
      }
    }
  }

  private async flushInternal(): Promise<void> {
    const config = this.config;
    if (config === null) {
      return;
    }

    if (this.nextRetryAt !== null && Date.now() < this.nextRetryAt) {
      return;
    }

    this.enqueueSuppressionAggregates();

    while (this.buffer.length > 0) {
      const batch = this.buffer.splice(0, config.batchSize);

      try {
        const response = await config.transport({
          endpoint: config.endpoint,
          headers: {
            "x-debugbundle-sdk": SDK_NAME,
            "x-debugbundle-sdk-version": SDK_VERSION
          },
          events: batch,
          timeout_ms: config.requestTimeoutMs
        });

        if (response.status >= 200 && response.status < 300) {
          this.nextRetryAt = null;
          this._lastEventAt = Date.now();
          this._consecutiveFailures = 0;
          continue;
        }

        this.buffer = [...batch, ...this.buffer];
        this._consecutiveFailures++;
        if (response.status === 429) {
          this.nextRetryAt = Date.now() + (response.retry_after_ms ?? 1_000);
        }
        return;
      } catch (caught) {
        this.buffer = [...batch, ...this.buffer];
        this._consecutiveFailures++;
        this.emitDiagnostic("flush_failed", "sdk-node failed to flush buffered events", {
          error: ensureObject(caught)
        });
        return;
      }
    }
  }

  private buildServiceDescriptor(config: ActiveConfig): EventEnvelope["service"] {
    return {
      name: config.service,
      runtime: "node",
      ...(config.framework === null ? {} : { framework: config.framework }),
      environment: config.environment
    };
  }

  private buildCorrelation(
    correlation: Partial<CorrelationFields> | undefined,
    request?: CaptureRequestInput
  ): CorrelationFields {
    const requestHeaders = (request ?? this.requestContextStorage.getStore()?.request)?.headers;
    return {
      request_id: correlation?.request_id ?? this.readContextString("request_id") ?? extractHeaderValue(requestHeaders, "x-request-id"),
      trace_id:
        correlation?.trace_id ?? this.readContextString("trace_id") ?? extractHeaderValue(requestHeaders, "x-debugbundle-trace-id"),
      session_id: correlation?.session_id ?? this.readContextString("session_id"),
      user_id_hash: correlation?.user_id_hash ?? this.readContextString("user_id_hash")
    };
  }

  private readContextString(key: string): string | null {
    const value = this.contextFields[key];
    return typeof value === "string" ? value : null;
  }

  private buildRequestSnapshot(request: CaptureRequestInput | undefined): {
    method: string;
    path: string;
    headers: Record<string, unknown>;
    query: Record<string, unknown>;
    body: unknown;
    route_template: string | null;
  } {
    const config = this.config;
    const sensitiveKeys = config?.redactFields ?? [];
    return {
      method: request?.method ?? "UNKNOWN",
      path: request?.path ?? request?.url ?? "/",
      headers: redactObject(request?.headers ?? {}, sensitiveKeys),
      query: redactObject(request?.query ?? {}, sensitiveKeys),
      body: request?.body === undefined ? null : redactObject(request.body, sensitiveKeys),
      route_template: request?.routeTemplate ?? null
    };
  }

  private buildResponseSnapshot(response: CaptureResponseInput | undefined): {
    status_code: number;
    headers?: Record<string, unknown>;
    body?: unknown;
  } {
    const config = this.config;
    const sensitiveKeys = config?.redactFields ?? [];
    const statusCode = response?.statusCode ?? response?.status ?? 0;

    const snapshot: { status_code: number; headers?: Record<string, unknown>; body?: unknown } = {
      status_code: statusCode
    };

    if (response?.headers !== undefined && Object.keys(response.headers).length > 0) {
      snapshot.headers = redactObject(response.headers, sensitiveKeys);
    }

    if (response?.body !== undefined && statusCode >= 400) {
      snapshot.body = redactObject(response.body, sensitiveKeys);
    }

    return snapshot;
  }

  private buildLogAttributes(context: CaptureLogContext): Record<string, unknown> {
    const config = this.config;
    const attributes: Record<string, unknown> = {};
    if (Object.keys(this.contextFields).length > 0) {
      attributes["context"] = { ...this.contextFields };
    }

    const rest: Record<string, unknown> = { ...context };
    delete rest["correlation"];
    const redacted = redactObject(rest, config?.redactFields ?? []);
    for (const [key, value] of Object.entries(redacted)) {
      attributes[key] = value;
    }

    return attributes;
  }

  private consumeProbeData(): { version: 1; items: ProbeBufferItem[] } | null {
    if (this.probeBuffers.size === 0) {
      return null;
    }

    const items = Array.from(this.probeBuffers.values()).flatMap((entries) => entries);
    this.probeBuffers.clear();
    return {
      version: 1,
      items
    };
  }

  private enqueueEvent(event: EventEnvelope): void {
    const suppressionKey = this.buildSuppressionKey(event);
    if (suppressionKey !== null && !this.suppressionTracker.shouldCapture(suppressionKey, Date.now())) {
      this.scheduleFlush();
      return;
    }

    this.enqueueInternalEvent(event);
  }

  private enqueueInternalEvent(event: EventEnvelope): void {
    const config = this.config;
    if (config === null) {
      return;
    }

    this.buffer.push(event);
    while (this.buffer.length > config.maxBufferedEvents) {
      this.buffer.shift();
    }

    if (this.buffer.length >= config.batchSize && (this.nextRetryAt === null || Date.now() >= this.nextRetryAt)) {
      void this.flush();
      return;
    }

    this.scheduleFlush();
  }

  private buildSuppressionKey(event: EventEnvelope): string | null {
    if (event.event_type === "backend_exception") {
      return JSON.stringify({
        event_type: event.event_type,
        name: event.payload.name,
        message: event.payload.message,
        stack: event.payload.stack,
        path: event.payload.request.path,
        status: event.payload.response.status_code
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
        status: event.payload.response_status,
        route_template: event.payload.route_template ?? null
      });
    }

    return null;
  }

  private shouldCapture(sampleRate: number): boolean {
    return sampleRate >= 1 || Math.random() <= sampleRate;
  }

  private effectiveLogThreshold(initLogLevel: LogLevel, policy: CapturePolicy): LogLevel {
    const policyLogLevel = policy.captureLogs as LogLevel;
    return LOG_LEVEL_ORDER[initLogLevel] >= LOG_LEVEL_ORDER[policyLogLevel] ? initLogLevel : policyLogLevel;
  }

  private shouldCaptureRequestEvent(response: CaptureResponseInput): boolean {
    const policy = this.remoteProbeConfig.capturePolicy.captureRequestEvents;
    const statusCode = response.statusCode ?? response.status ?? 0;
    if (statusCode >= 500) {
      return true;
    }
    if (policy === "off") {
      return false;
    }
    if (policy === "all") {
      return true;
    }
    if (policy === "failures_only") {
      return false;
    }
    // "filtered" — treat as failures_only for now (SDK has no user-defined filters)
    return false;
  }

  private scheduleFlush(delayMs?: number): void {
    const config = this.config;
    if (config === null || this.flushTimer !== null) {
      return;
    }

    const timeoutMs = delayMs ?? config.flushInterval;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, timeoutMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer !== null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private clearRemoteProbePollTimer(): void {
    if (this.remoteProbePollTimer !== null) {
      clearTimeout(this.remoteProbePollTimer);
      this.remoteProbePollTimer = null;
    }
  }

  private restoreConsole(): void {
    if (this.originalConsoleError !== null) {
      console.error = this.originalConsoleError;
      this.originalConsoleError = null;
    }

    if (this.originalConsoleWarn !== null) {
      console.warn = this.originalConsoleWarn;
      this.originalConsoleWarn = null;
    }
  }

  private formatConsoleMessage(args: unknown[]): string {
    return args
      .map((arg) => {
        const sanitized = sanitizeUnknown(arg);
        return typeof sanitized === "string" ? sanitized : JSON.stringify(sanitized);
      })
      .join(" ");
  }

  private emitDiagnostic(code: string, message: string, metadata?: Record<string, unknown>): void {
    try {
      const sanitizedMetadata = sanitizeMetadataObject(metadata);
      this.config?.onDiagnostic?.({
        code,
        message,
        ...(sanitizedMetadata === undefined ? {} : { metadata: sanitizedMetadata })
      });
    } catch {
      // Diagnostics must never destabilize the host.
    }
  }

  private enqueueSuppressionAggregates(): void {
    const config = this.config;
    if (config === null) {
      return;
    }

    for (const aggregate of this.suppressionTracker.drainAggregates(Date.now())) {
      this.enqueueInternalEvent(
        createEventEnvelope({
          schema_version: SDK_SCHEMA_VERSION,
          event_type: "error_suppressed",
          project_token: config.projectToken,
          sdk_name: SDK_NAME,
          sdk_version: SDK_VERSION,
          service: this.buildServiceDescriptor(config),
          occurred_at: aggregate.lastSeen,
          payload: {
            fingerprint: aggregate.fingerprint,
            suppressed_count: aggregate.suppressedCount,
            window_seconds: aggregate.windowSeconds,
            first_seen: aggregate.firstSeen,
            last_seen: aggregate.lastSeen
          }
        })
      );
    }
  }

  private getInternalSdkPaths(config: ActiveConfig): string[] {
    return [config.endpoint, buildSdkConfigEndpoint(config.endpoint)]
      .map((value) => this.normalizeRequestPath(value))
      .filter((value): value is string => value !== null);
  }

  private normalizeRequestPath(value: string | null): string | null {
    if (value === null || value.trim().length === 0) {
      return null;
    }

    try {
      return new URL(value, "http://debugbundle.local").pathname;
    } catch {
      return value.startsWith("/") ? value : `/${value}`;
    }
  }

  private async refreshRemoteProbeConfig(): Promise<void> {
    const config = this.config;
    if (config === null) {
      return;
    }

    const configEndpoint = buildSdkConfigEndpoint(config.endpoint);

    try {
      const response = await fetchWithTimeout(
        config.fetchImpl,
        configEndpoint,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.projectToken}`,
            "x-debugbundle-sdk": SDK_NAME,
            "x-debugbundle-sdk-version": SDK_VERSION,
            ...(this.remoteProbeConfigEtag === null ? {} : { "If-None-Match": this.remoteProbeConfigEtag })
          }
        },
        config.requestTimeoutMs
      );

      const nextEtag = response.headers.get("etag");
      if (nextEtag !== null) {
        this.remoteProbeConfigEtag = nextEtag;
      }

      if (response.status === 304) {
        this.pruneExpiredRemoteProbeDirectives(Date.now());
        this.scheduleRemoteProbePoll(this.remoteProbeConfig.pollIntervalMs);
        return;
      }

      if (response.status < 200 || response.status >= 300) {
        this.applyMinimalPolicyFallbackIfNeeded();
        this.scheduleRemoteProbePoll(config.probesPollInterval);
        return;
      }

      const parsed = parseRemoteProbeConfig(await response.json(), config.probesPollInterval, Date.now());
      if (parsed === null) {
        this.emitDiagnostic("remote_probe_config_invalid", "sdk-node received an invalid remote probe config payload");
        this.applyMinimalPolicyFallbackIfNeeded();
        this.scheduleRemoteProbePoll(config.probesPollInterval);
        return;
      }

      this.remoteProbeConfig = parsed;
      this.remoteConfigFetchedOnce = true;
      if (parsed.remoteProbesEnabled) {
        this.scheduleRemoteProbePoll(parsed.pollIntervalMs);
      } else {
        this.clearRemoteProbePollTimer();
      }
    } catch (caught) {
      this.emitDiagnostic("remote_probe_config_failed", "sdk-node failed to refresh remote probe config", {
        error: ensureObject(caught)
      });
      this.applyMinimalPolicyFallbackIfNeeded();
      this.scheduleRemoteProbePoll(config.probesPollInterval);
    }
  }

  private applyMinimalPolicyFallbackIfNeeded(): void {
    if (!this.remoteConfigFetchedOnce) {
      this.remoteProbeConfig = {
        ...this.remoteProbeConfig,
        capturePolicy: MINIMAL_CAPTURE_POLICY
      };
    }
  }

  private scheduleRemoteProbePoll(delayMs: number): void {
    const config = this.config;
    if (config === null || !this.remoteProbeConfig.remoteProbesEnabled) {
      return;
    }

    this.clearRemoteProbePollTimer();
    this.remoteProbePollTimer = setTimeout(() => {
      this.remoteProbePollTimer = null;
      void this.refreshRemoteProbeConfig();
    }, delayMs);
  }

  private getMatchingRemoteProbeDirectives(label: string, nowMs: number): RemoteProbeDirective[] {
    const config = this.config;
    if (config === null) {
      return [];
    }

    const matches: RemoteProbeDirective[] = [];

    if (this.remoteProbeConfig.probesEnabled && this.remoteProbeConfig.remoteProbesEnabled) {
      this.pruneExpiredRemoteProbeDirectives(nowMs);
      matches.push(
        ...findMatchingRemoteProbeDirectives(
          this.remoteProbeConfig.directives,
          label,
          config.service,
          config.environment,
          nowMs
        )
      );
    }

    const request = this.requestContextStorage.getStore()?.request;
    const requestDirectives = resolveRequestTriggerDirectives({
      request,
      triggerTokenKey: this.remoteProbeConfig.triggerTokenKey,
      nowMs
    });
    for (const directive of findMatchingRemoteProbeDirectives(requestDirectives, label, config.service, config.environment, nowMs)) {
      if (!matches.some((existing) => existing.id === directive.id)) {
        matches.push(directive);
      }
    }

    return matches;
  }

  private pruneExpiredRemoteProbeDirectives(nowMs: number): void {
    this.remoteProbeConfig = {
      ...this.remoteProbeConfig,
      directives: this.remoteProbeConfig.directives.filter((directive) => Date.parse(directive.expiresAt) > nowMs)
    };
  }
}

export function createDebugBundleSdk(): DebugBundleNodeSdk {
  return new DebugBundleNodeSdk();
}

export const debugbundle = createDebugBundleSdk();