import { AsyncLocalStorage } from "node:async_hooks";
import { sanitizeTelemetry } from "@debugbundle/redaction";

import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { resolveDefaultNodeTransport } from "./file-transport.js";
import { BoundedEventBuffer } from "./buffer-admission.js";
import { finalizeNodeBatch } from "./delivery-hooks.js";
import { protectNodeEvent } from "./privacy.js";
import { attachLoggerIntegration } from "./logger-integrations.js";
import { createExpressMiddleware, createFastifyPlugin, createNextHandlerWrapper } from "./framework-integrations.js";
import { decideIngestionAcknowledgement } from "./ingestion-acknowledgement.js";
import { parseRemoteProbeConfig } from "./remote-probes.js";
import { shouldCaptureNodeRequestEvent } from "./request-policy.js";
import {
  buildInternalSdkPaths,
  applyNodeCaptureRules,
  buildNodeCorrelation,
  buildNodeLogAttributes,
  buildNodeRequestSnapshot,
  buildNodeResponseSnapshot,
  buildNodeServiceDescriptor,
  buildNodeSuppressionKey,
  buildNodeSuppressionAggregateEvents,
  buildNodeQueuePressureEvent,
  buildNodeRequestEvent,
  consumeNodeProbeData,
  emitNodeDiagnostic,
  matchNodeProbeDirectives,
  normalizeLogLevel,
  pruneNodeProbeDirectives,
  formatNodeConsoleMessage,
  normalizeNodeRequestPath,
  shouldCaptureNodeLog,
  shouldCaptureNodeSample
} from "./event-support.js";
import { EventSuppressionTracker } from "./suppression.js";
import {
  BALANCED_CAPTURE_POLICY,
  DEFAULT_BATCH_SIZE,
  DEFAULT_ENDPOINT,
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_MAX_BUFFERED_EVENTS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_PROBE_ENTRIES,
  DEFAULT_MAX_PROBE_LABELS,
  DEFAULT_PROBES_POLL_INTERVAL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  MINIMAL_CAPTURE_POLICY,
  SDK_NAME,
  SDK_SCHEMA_VERSION,
  SDK_VERSION,
  type ActiveConfig,
  type CaptureExceptionContext,
  type CaptureLogContext,
  type CaptureRequestContext,
  type CaptureRequestInput,
  type CaptureResponseInput,
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
  boundedRetryAfterMs, requiresIngestionAcknowledgement,
  detectRuntimeContext,
  detectProcessRuntimeFacts,
  ensureObject,
  fetchWithTimeout,
  normalizeError,
  normalizeFiniteNumber,
  normalizeSampleRate,
  redactObject,
} from "./utils.js";

export class DebugBundleNodeSdk implements FrameworkSdkBridge {
  private config: ActiveConfig | null = null;
  private readonly boundedBuffer = new BoundedEventBuffer();
  private buffer: EventEnvelope[] = this.boundedBuffer.events;
  private finalizedEvents = new WeakSet<EventEnvelope>();
  private inFlightCount = 0;
  private inFlightBytes = 0;
  private generation = 0;
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
    capturePolicy: BALANCED_CAPTURE_POLICY,
    captureRules: []
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
      maxBufferedBytes: normalizeFiniteNumber(config.maxBufferedBytes, DEFAULT_MAX_BUFFERED_BYTES, 1),
      probesPollInterval: normalizeFiniteNumber(config.probesPollInterval, DEFAULT_PROBES_POLL_INTERVAL_MS, 1),
      maxProbeLabels: normalizeFiniteNumber(config.maxProbeLabels, DEFAULT_MAX_PROBE_LABELS, 1),
      maxProbeEntriesPerLabel: normalizeFiniteNumber(config.maxProbeEntriesPerLabel, DEFAULT_MAX_PROBE_ENTRIES, 1),
      probeFlushOnError: config.probeFlushOnError ?? true,
      requestTimeoutMs: normalizeFiniteNumber(config.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, 1),
      captureRules: [],
      fetchImpl,
      transport: resolvedTransport.transport,
      ...(config.beforeSend === undefined ? {} : { beforeSend: config.beforeSend }),
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
    this.generation++;
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
    this.boundedBuffer.clear();
    this.finalizedEvents = new WeakSet<EventEnvelope>();
    this.inFlightCount = 0;
    this.inFlightBytes = 0;
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
      capturePolicy: BALANCED_CAPTURE_POLICY,
      captureRules: []
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
    if (config === null || !this.boundedBuffer.canAdmit("backend_exception", undefined,
      config.maxBufferedEvents - this.inFlightCount, config.maxBufferedBytes - this.inFlightBytes)
      || (config.beforeSend === undefined && !shouldCaptureNodeSample(config.sampleRate))) {
      return;
    }

    try {
      const normalizedError = normalizeError(error);
      const request = buildNodeRequestSnapshot(context.request, config.redactFields);
      const response = buildNodeResponseSnapshot(context.response, config.redactFields);
      const probeData = config.probeFlushOnError ? consumeNodeProbeData(this.probeBuffers) : null;
      const runtime = detectProcessRuntimeFacts();

      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "backend_exception",
        project_token: config.projectToken,
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: buildNodeServiceDescriptor(config),
        occurred_at: new Date().toISOString(),
        correlation: buildNodeCorrelation(
          context.correlation,
          context.request ?? this.requestContextStorage.getStore()?.request,
          this.contextFields
        ),
        payload: {
          name: normalizedError.name,
          message: normalizedError.message,
          stack: normalizedError.stack ?? `${normalizedError.name}: ${normalizedError.message}`,
          handled: context.handled ?? false,
          request,
          response,
          runtime: {
            version: runtime.version
          },
          ...(probeData === null ? {} : { probe_data: probeData })
        }
      });

      if (event.event_type === "backend_exception") {
        event.payload.runtime = runtime;
      }

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
    if (config === null) {
      return;
    }

    if (!shouldCaptureNodeLog(config, this.remoteProbeConfig.capturePolicy, level)) return;
    if (!this.boundedBuffer.canAdmit("log_event", level,
      config.maxBufferedEvents - this.inFlightCount, config.maxBufferedBytes - this.inFlightBytes)) return;
    if ((config.beforeSend === undefined && !shouldCaptureNodeSample(config.sampleRate))) return;

    try {
      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "log_event",
        project_token: config.projectToken,
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: buildNodeServiceDescriptor(config),
        occurred_at: new Date().toISOString(),
        correlation: buildNodeCorrelation(
          context.correlation,
          this.requestContextStorage.getStore()?.request,
          this.contextFields
        ),
        payload: {
          level,
          message,
          attributes: buildNodeLogAttributes(context, this.contextFields, config.redactFields)
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
    if (config === null) return;

    try {
      if (!shouldCaptureNodeRequestEvent(this.remoteProbeConfig.capturePolicy, request, response)) return;
      const responseStatus = response.statusCode ?? response.status;
      if (!this.boundedBuffer.canAdmit("request_event", undefined,
        config.maxBufferedEvents - this.inFlightCount, config.maxBufferedBytes - this.inFlightBytes, responseStatus)
        || (config.beforeSend === undefined && !shouldCaptureNodeSample(config.sampleRate))) return;

      const requestSnapshot = buildNodeRequestSnapshot(request, config.redactFields);
      const responseSnapshot = buildNodeResponseSnapshot(response, config.redactFields);
      const event = buildNodeRequestEvent({
        config, requestSnapshot, responseSnapshot,
        correlation: buildNodeCorrelation(context.correlation, request, this.contextFields),
        durationMs: context.durationMs ?? response.durationMs ?? 0
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
    if (typeof key !== "string" || key.length === 0 || key.length > 128) {
      return;
    }

    const config = this.config;
    if (config === null) {
      return;
    }

    try {
      if (!Object.hasOwn(this.contextFields, key) && Object.keys(this.contextFields).length >= 50) return;
      const result = sanitizeTelemetry({ ...this.contextFields, [key]: value }, {
        additionalKeys: config.redactFields
      });
      if (result.ok && result.value !== null && !Array.isArray(result.value) && typeof result.value === "object") this.contextFields = redactObject(result.value, config.redactFields);
    } catch {
      // A failed mandatory scrub must not retain a raw context value.
    }
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

    const requestPath = normalizeNodeRequestPath(request.path ?? request.url ?? request.routeTemplate ?? null);
    if (requestPath === null) {
      return true;
    }

    return !buildInternalSdkPaths(config).includes(requestPath);
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
            service: buildNodeServiceDescriptor(config),
            occurred_at: new Date().toISOString(),
            correlation: buildNodeCorrelation(
              undefined,
              this.requestContextStorage.getStore()?.request,
              this.contextFields
            ),
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
      this.captureLog(formatNodeConsoleMessage(args), "error");
    };

    console.warn = (...args: unknown[]): void => {
      this.originalConsoleWarn?.(...args);
      this.captureLog(formatNodeConsoleMessage(args), "warning");
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
    const generation = this.generation;
    // Establish single-flight ownership before any callback/transport executes,
    // including when batch-full capture or a hook reenters flush().
    const flushPromise = Promise.resolve().then(() => this.flushInternal(generation));
    this.flushPromise = flushPromise;

    try {
      await flushPromise;
    } finally {
      if (this.generation === generation && this.flushPromise === flushPromise) {
        this.flushPromise = null;
      }
      if (this.generation === generation && this.buffer.length > 0) {
        const retryDelay = this.nextRetryAt === null ? undefined : Math.max(0, this.nextRetryAt - Date.now());
        this.scheduleFlush(retryDelay);
      }
    }
  }

  private async flushInternal(generation: number): Promise<void> {
    const config = this.config;
    if (config === null) {
      return;
    }

    if (this.nextRetryAt !== null && Date.now() < this.nextRetryAt) {
      return;
    }

    if (this.config !== null) {
      for (const aggregateEvent of buildNodeSuppressionAggregateEvents(this.suppressionTracker, this.config)) {
        this.enqueueInternalEvent(aggregateEvent);
      }
    }

    let pressureAttempted = false;
    while (this.generation === generation) {
      if (this.buffer.length === 0) {
        if (pressureAttempted) return;
        pressureAttempted = true;
        for (const snapshot of this.boundedBuffer.pressureSnapshots()) {
          const aggregate = buildNodeQueuePressureEvent(snapshot, config);
          if (this.enqueueInternalEvent(aggregate, false, false)) {
            this.boundedBuffer.acknowledgePressure(snapshot.kind, snapshot.count);
            break;
          }
        }
        if (this.buffer.length === 0) return;
      }
      const { events: batch, bytes } = this.boundedBuffer.takeBatch(config.batchSize);
      let batchBytes = bytes;
      this.inFlightCount += batch.length;
      this.inFlightBytes += batchBytes;
      const restoreBatch = (events: EventEnvelope[]): void => {
        this.boundedBuffer.restore(events, config.maxBufferedEvents - this.inFlightCount + batch.length,
          config.maxBufferedBytes - this.inFlightBytes + batchBytes);
      };

      try {
        finalizeNodeBatch({ batch, buffer: this.boundedBuffer, config, remote: this.remoteProbeConfig,
          finalized: this.finalizedEvents, suppression: this.suppressionTracker, current: () => this.generation === generation,
          ownership: () => ({ count: this.inFlightCount, bytes: this.inFlightBytes }),
          adjustOwnership: (count, delta) => {
            this.inFlightCount += count;
            this.inFlightBytes += delta;
            batchBytes += delta;
          },
          diagnostic: (code, message, metadata) => this.emitDiagnostic(code, message, metadata)
        });
        if (this.generation !== generation) return;
        for (const aggregate of buildNodeSuppressionAggregateEvents(this.suppressionTracker, config)) {
          this.enqueueInternalEvent(aggregate);
        }
        if (batch.length === 0) continue;
        const response = await config.transport({
          endpoint: config.endpoint,
          headers: {
            "x-debugbundle-sdk": SDK_NAME,
            "x-debugbundle-sdk-version": SDK_VERSION
          },
          events: batch,
          timeout_ms: config.requestTimeoutMs
        });
        if (this.generation !== generation) return;

        if (response.status >= 200 && response.status < 300) {
          const acknowledgement = decideIngestionAcknowledgement(response.body, batch.length, requiresIngestionAcknowledgement(config.transport));
          if (acknowledgement.kind === "protocol_failure") {
            restoreBatch(batch);
            this.nextRetryAt = Date.now() + boundedRetryAfterMs(response.retry_after_ms);
            this._consecutiveFailures++;
            this.emitDiagnostic(
              "ingestion_acknowledgement_invalid",
              "sdk-node retained a batch after an invalid ingestion acknowledgement",
              { reason: acknowledgement.reason }
            );
            return;
          }
          if (acknowledgement.kind === "legacy") {
            this.nextRetryAt = null;
            this._lastEventAt = Date.now();
            this._consecutiveFailures = 0;
            continue;
          }

          const retryableEvents = acknowledgement.retryableIndices
            .map((index) => batch[index])
            .filter((event): event is EventEnvelope => event !== undefined);
          if (acknowledgement.terminalErrors.length > 0) {
            this.emitDiagnostic(
              "ingestion_events_rejected",
              "sdk-node removed terminally rejected ingestion events",
              {
                rejected_count: acknowledgement.terminalErrors.length,
                reasons: [...new Set(acknowledgement.terminalErrors.map((error) => error.reason))]
              }
            );
          }
          if (acknowledgement.accepted > 0) {
            this._lastEventAt = Date.now();
          }
          if (retryableEvents.length > 0) {
            restoreBatch(retryableEvents);
            this.nextRetryAt = Date.now() + boundedRetryAfterMs(response.retry_after_ms);
            this._consecutiveFailures++;
            return;
          }
          this.nextRetryAt = null;
          this._consecutiveFailures = acknowledgement.accepted > 0 ? 0 : 3;
          continue;
        }

        restoreBatch(batch);
        this._consecutiveFailures++;
        if (response.status === 429 || response.status >= 500 && response.retry_after_ms !== undefined) {
          this.nextRetryAt = Date.now() + boundedRetryAfterMs(response.retry_after_ms);
        }
        return;
      } catch (caught) {
        if (this.generation !== generation) return;
        restoreBatch(batch);
        this._consecutiveFailures++;
        this.emitDiagnostic("flush_failed", "sdk-node failed to flush buffered events", {
          error: ensureObject(caught)
        });
        return;
      } finally {
        if (this.generation === generation) {
          this.inFlightCount -= batch.length;
          this.inFlightBytes -= batchBytes;
        }
      }
    }
  }

  private enqueueEvent(event: EventEnvelope): void {
    const protectedInput = protectNodeEvent(event, this.config?.redactFields ?? []);
    if (protectedInput === null) return;
    if (this.config?.beforeSend !== undefined) {
      this.enqueueInternalEvent(protectedInput);
      return;
    }
    const resolvedEvent = applyNodeCaptureRules(protectedInput, this.remoteProbeConfig.captureRules);
    if (resolvedEvent === null) {
      return;
    }

    const finalEvent = protectNodeEvent(resolvedEvent, this.config?.redactFields ?? []);
    if (finalEvent === null) return;
    event = finalEvent;
    const suppressionKey = buildNodeSuppressionKey(event);
    if (suppressionKey !== null && !this.suppressionTracker.shouldCapture(suppressionKey, Date.now())) {
      this.scheduleFlush();
      return;
    }

    this.enqueueInternalEvent(event);
  }

  private enqueueInternalEvent(event: EventEnvelope, applyBeforeSend = true, recordPressure = true): boolean {
    const config = this.config;
    if (config === null) {
      return false;
    }

    const protectedInput = protectNodeEvent(event, config.redactFields);
    if (protectedInput === null) return false;
    event = protectedInput;
    if (!applyBeforeSend || config.beforeSend === undefined) this.finalizedEvents.add(event);

    const dropped = this.boundedBuffer.admit(event, Math.max(0, config.maxBufferedEvents - this.inFlightCount),
      Math.max(0, config.maxBufferedBytes - this.inFlightBytes), true, recordPressure);
    if (dropped.includes(event)) return false;

    if (this.buffer.length >= config.batchSize && (this.nextRetryAt === null || Date.now() >= this.nextRetryAt)) {
      void this.flush();
      return true;
    }

    this.scheduleFlush();
    return true;
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

  private emitDiagnostic(code: string, message: string, metadata?: Record<string, unknown>): void {
    emitNodeDiagnostic(this.config, code, message, metadata);
  }

  private async refreshRemoteProbeConfig(): Promise<void> {
    const config = this.config;
    if (config === null) {
      return;
    }
    const generation = this.generation;

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
      if (this.generation !== generation) return;

      const nextEtag = response.headers.get("etag");
      if (nextEtag !== null) {
        this.remoteProbeConfigEtag = nextEtag;
      }

      if (response.status === 304) {
        this.remoteProbeConfig = pruneNodeProbeDirectives(this.remoteProbeConfig, Date.now());
        this.scheduleRemoteProbePoll(this.remoteProbeConfig.pollIntervalMs);
        return;
      }

      if (response.status < 200 || response.status >= 300) {
        this.applyMinimalPolicyFallbackIfNeeded();
        this.scheduleRemoteProbePoll(config.probesPollInterval);
        return;
      }

      const body: unknown = await response.json();
      if (this.generation !== generation) return;
      const parsed = parseRemoteProbeConfig(body, config.probesPollInterval, Date.now());
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
      if (this.generation !== generation) return;
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
    if (config === null) return [];
    const result = matchNodeProbeDirectives({ snapshot: this.remoteProbeConfig,
      request: this.requestContextStorage.getStore()?.request, label, config, nowMs });
    this.remoteProbeConfig = result.snapshot;
    return result.directives;
  }

}

export function createDebugBundleSdk(): DebugBundleNodeSdk {
  return new DebugBundleNodeSdk();
}

export const debugbundle = createDebugBundleSdk();
