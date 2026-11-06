import { captureNodeProbe } from "./probe-capture.js";
import { fetchNodeRemoteConfig, evidenceDiscoveryEndpoint } from "./remote-config-client.js";
import { allowsNodeRecovery, reconcileNodeDiagnostic, finalizeNodeEvidenceBatch, observeNodeEvidenceResponse, downgradeRejectedNodeErrors } from "./evidence-delivery.js";
import { createNodeRecoveryEvent } from "./diagnostic-capture.js";
import { NodeLifecycleHooks } from "./lifecycle.js";
import { createNodeExceptionEvent } from "./capture-exception.js";
import { NodeOperationContext } from "./operation-context.js";
import { sanitizeTelemetry } from "@debugbundle/redaction";

import { createEventEnvelope, DiagnosticCaptureBudget, EvidenceDeliveryState, type EventEnvelope } from "@debugbundle/shared-types";
import { resolveDefaultNodeTransport, isFileTransport } from "./file-transport.js";
import { fitNodeWireEvent, deferNodeWireTail } from "./wire-batch.js";
import { BoundedEventBuffer } from "./buffer-admission.js";
import { finalizeNodeBatch } from "./delivery-hooks.js";
import { protectNodeEvent } from "./privacy.js";
import { attachLoggerIntegration } from "./logger-integrations.js";
import { nativeLoggerContext } from "./logger-error.js";
import { ExceptionIdentity } from "./exception-identity.js";
import { createExpressMiddleware, createFastifyPlugin, createNextHandlerWrapper } from "./framework-integrations.js";
import { decideIngestionAcknowledgement } from "./ingestion-acknowledgement.js";
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
  emitNodeDiagnostic,
  matchNodeProbeDirectives,
  normalizeLogLevel,
  pruneNodeProbeDirectives,
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
  type CaptureRecoveryInput,
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
  type ProbeOptions,
  type NodeOperationOptions
} from "./types.js";
import {
  boundedRetryAfterMs, requiresIngestionAcknowledgement,
  detectRuntimeContext,
  ensureObject,
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
  private requestContextStorage = new NodeOperationContext();
  private remoteProbeConfig: RemoteProbeConfigSnapshot = {
    probesEnabled: false,
    remoteProbesEnabled: false,
    directives: [],
    pollIntervalMs: DEFAULT_PROBES_POLL_INTERVAL_MS,
    triggerTokenKey: null,
    capturePolicy: BALANCED_CAPTURE_POLICY,
    captureRules: []
  };
  private evidence = new EvidenceDeliveryState();
  private readonly diagnosticBudget = new DiagnosticCaptureBudget();
  private readonly lifecycle = new NodeLifecycleHooks({ capture: (error, fatal) => this.captureExceptionInternal(error, { handled: false }, fatal),
    log: (message, level) => this.captureLog(message, level), flush: () => this.flush() });
  private loggerRestorers: Array<() => void> = [];
  private attachedLoggers = new WeakSet<object>();
  private exceptionIdentity = new ExceptionIdentity();
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
            shouldRefreshRemoteConfig: config.projectMode !== "local-only",
          };

    this.evidence = new EvidenceDeliveryState(config.evidenceCapabilities);
    this.config = {
      captureExceptionEvidence: config.captureExceptionEvidence ?? true,
      captureRecoveryObservations: config.captureRecoveryObservations ?? false,
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
    this.lifecycle.dispose();
    this.requestContextStorage.dispose();
    this.requestContextStorage = new NodeOperationContext();

    for (const restore of this.loggerRestorers.reverse()) {
      restore();
    }

    this.loggerRestorers = [];
    this.attachedLoggers = new WeakSet<object>();
    this.exceptionIdentity = new ExceptionIdentity();
    this.config = null;
    this.evidence = new EvidenceDeliveryState();
    this.diagnosticBudget.clear();
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
    this.captureExceptionInternal(error, context, false);
  }

  /** Logger adapters retain native exception evidence after both native and SDK filtering. */
  public captureLoggedException(error: Error, level: LogLevel, context?: CaptureLogContext): void {
    if (this.config === null || !shouldCaptureNodeLog(this.config, this.remoteProbeConfig.capturePolicy, level)) return;
    this.captureExceptionInternal(error, { handled: true }, false, true, context);
  }

  private captureExceptionInternal(error: unknown, context: CaptureExceptionContext, fatal: boolean, automatic = fatal, loggerContext?: CaptureLogContext): void {
    const config = this.config;
    if (config === null || !this.boundedBuffer.canAdmit("backend_exception", undefined,
      config.maxBufferedEvents - this.inFlightCount, config.maxBufferedBytes - this.inFlightBytes)
      || ((fatal || config.beforeSend === undefined) && !shouldCaptureNodeSample(config.sampleRate))) {
      return;
    }

    try {
      const execution = this.requestContextStorage.snapshot();
      const defaultScope = this.requestContextStorage.scope();
      // Deferred hooks can reject the first report; retain both candidates in that case.
      const identityScope = config.beforeSend === undefined && defaultScope !== undefined ? JSON.stringify(defaultScope) : undefined;
      if (!this.exceptionIdentity.admit(error, identityScope, automatic)) return;
      const event = createNodeExceptionEvent({ error, context, config, request: this.requestContextStorage.getStore()?.request,
        fields: this.contextFields, probeBuffers: this.probeBuffers, evidence: this.evidence, fatal,
        ...(defaultScope === undefined ? {} : { defaultScope }),
        ...(execution === undefined ? {} : { execution }) });
      if (loggerContext !== undefined) event.context = { ...event.context, ...nativeLoggerContext(loggerContext) };

      if (this.enqueueEvent(event, fatal)) this.exceptionIdentity.remember(error, identityScope, automatic);
    } catch (caught) {
      this.emitDiagnostic("capture_exception_failed", "sdk-node failed to capture exception", {
        error: ensureObject(caught)
      });
    }
  }

  public captureError(error: unknown, context: CaptureExceptionContext = {}): void {
    this.captureException(error, context);
  }

  public captureRecovery(observation: CaptureRecoveryInput): void {
    const config = this.config;
    if (config === null || !allowsNodeRecovery(config, this.remoteProbeConfig, this.evidence) ||
      !this.boundedBuffer.canAdmit("diagnostic_context", undefined, config.maxBufferedEvents - this.inFlightCount,
        config.maxBufferedBytes - this.inFlightBytes) || (config.beforeSend === undefined && !shouldCaptureNodeSample(config.sampleRate))) return;
    try {
      const defaultScope = this.requestContextStorage.scope();
      const event = createNodeRecoveryEvent({ observation, config, request: this.requestContextStorage.getStore()?.request,
        fields: this.contextFields, ...(defaultScope === undefined ? {} : { defaultScope }) });
      const safe = event === null ? null : protectNodeEvent(event, config.redactFields);
      if (safe?.event_type !== "diagnostic_context" || !this.diagnosticBudget.reserve(safe.event_id, safe.payload,
        this.boundedBuffer.eventBytes(safe), Date.now())) return;
      if (!this.enqueueEvent(safe)) this.diagnosticBudget.release([safe.event_id]);
    } catch {
      // Explicit observations remain optional and cannot affect application work.
    }
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

  public runWithRequestContext<Result>(request: CaptureRequestInput, callback: () => Result, owner?: object): Result {
    return this.requestContextStorage.runRequest(request, callback, owner);
  }
  public finishRequestContext(owner: object): void { this.requestContextStorage.finishRequest(owner); }
  public runWithOperationContext<Result>(options: NodeOperationOptions, callback: () => Result | Promise<Result>): Promise<Result> {
    return this.requestContextStorage.runOperation(options, callback);
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
      const generation = this.generation;
      captureNodeProbe({ config, label, data, options, buffers: this.probeBuffers, directives: this.getMatchingRemoteProbeDirectives(label, Date.now()),
        request: this.requestContextStorage.getStore()?.request, fields: this.contextFields,
        current: () => generation === this.generation, enqueue: (event) => this.enqueueInternalEvent(event) });
    } catch (caught) {
      this.emitDiagnostic("probe_failed", "sdk-node failed to capture probe", {
        label,
        error: ensureObject(caught)
      });
    }
  }

  public captureExceptions(): void { if (this.config !== null) this.lifecycle.captureExceptions(); }
  public captureRejections(): void { if (this.config !== null) this.lifecycle.captureRejections(); }
  public captureConsole(): void { if (this.config !== null) this.lifecycle.captureConsole(); }
  private registerShutdownFlush(): void { this.lifecycle.registerShutdownFlush(); }

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
        const dropped = this.boundedBuffer.restore(events, config.maxBufferedEvents - this.inFlightCount + batch.length,
          config.maxBufferedBytes - this.inFlightBytes + batchBytes);
        this.diagnosticBudget.release(dropped.filter((event) => event.event_type === "diagnostic_context").map((event) => event.event_id));
      };
      const reconcile = (original: EventEnvelope, replacement: EventEnvelope | null): EventEnvelope | null =>
        reconcileNodeDiagnostic({ original, replacement, config, remote: this.remoteProbeConfig, evidence: this.evidence,
          budget: this.diagnosticBudget, buffer: this.boundedBuffer });

      try {
        finalizeNodeBatch({ batch, buffer: this.boundedBuffer, config, remote: this.remoteProbeConfig,
          finalized: this.finalizedEvents, suppression: this.suppressionTracker, current: () => this.generation === generation,
          ownership: () => ({ count: this.inFlightCount, bytes: this.inFlightBytes }),
          reconcile,
          evicted: events => this.diagnosticBudget.release(events.filter(event => event.event_type === "diagnostic_context").map(event => event.event_id)),
          adjustOwnership: (count, delta) => {
            this.inFlightCount += count;
            this.inFlightBytes += delta;
            batchBytes += delta;
          },
          diagnostic: (code, message, metadata) => this.emitDiagnostic(code, message, metadata)
        });
        if (this.generation !== generation) return;
        finalizeNodeEvidenceBatch({ batch, buffer: this.boundedBuffer, evidence: this.evidence, finalized: this.finalizedEvents, reconcile,
          wireEvent: isFileTransport(config.transport) ? event => event : fitNodeWireEvent,
          adjustOwnership: (count, delta) => { this.inFlightCount += count; this.inFlightBytes += delta; batchBytes += delta; } });
        if (!isFileTransport(config.transport)) deferNodeWireTail({ batch, buffer: this.boundedBuffer,
          adjustOwnership: (count, delta) => { this.inFlightCount += count; this.inFlightBytes += delta; batchBytes += delta; },
          capacity: () => ({ count: config.maxBufferedEvents - this.inFlightCount, bytes: config.maxBufferedBytes - this.inFlightBytes }),
          dropped: events => this.diagnosticBudget.release(events.filter(event => event.event_type === "diagnostic_context").map(event => event.event_id)) });
        for (const aggregate of buildNodeSuppressionAggregateEvents(this.suppressionTracker, config)) {
          this.enqueueInternalEvent(aggregate);
        }
        if (batch.length === 0) continue;
        const response = await config.transport({
          endpoint: requiresIngestionAcknowledgement(config.transport) ? evidenceDiscoveryEndpoint(config.endpoint) : config.endpoint,
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
          const evidenceDowngraded = observeNodeEvidenceResponse(this.evidence, response.body, requiresIngestionAcknowledgement(config.transport), acknowledgement.kind === "acknowledged");
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
            this.diagnosticBudget.release(batch.filter((event) => event.event_type === "diagnostic_context").map((event) => event.event_id));
            this.nextRetryAt = null;
            this._lastEventAt = Date.now();
            this._consecutiveFailures = 0;
            continue;
          }

          const retryableEvents = acknowledgement.retryableIndices
            .map((index) => batch[index])
            .filter((event): event is EventEnvelope => event !== undefined);
          if (evidenceDowngraded) {
            for (const event of downgradeRejectedNodeErrors(batch, acknowledgement.terminalErrors, this.evidence)) {
              this.finalizedEvents.add(event); retryableEvents.push(event);
            }
          }
          const retries = new Set(retryableEvents);
          this.diagnosticBudget.release(batch.filter((event) => event.event_type === "diagnostic_context" && !retries.has(event)).map((event) => event.event_id));
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

  private enqueueEvent(event: EventEnvelope, bypassHook = false): boolean {
    const protectedInput = protectNodeEvent(event, this.config?.redactFields ?? []);
    if (protectedInput === null) return false;
    if (!bypassHook && this.config?.beforeSend !== undefined) {
      return this.enqueueInternalEvent(protectedInput);
    }
    const resolvedEvent = applyNodeCaptureRules(protectedInput, this.remoteProbeConfig.captureRules);
    if (resolvedEvent === null) {
      return false;
    }

    const finalEvent = protectNodeEvent(resolvedEvent, this.config?.redactFields ?? []);
    if (finalEvent === null) return false;
    event = finalEvent;
    const suppressionKey = buildNodeSuppressionKey(event);
    if (suppressionKey !== null && !this.suppressionTracker.shouldCapture(suppressionKey, Date.now())) {
      this.scheduleFlush();
      return false;
    }

    return this.enqueueInternalEvent(event, !bypassHook);
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
    this.diagnosticBudget.release(dropped.filter((item) => item.event_type === "diagnostic_context").map((item) => item.event_id));
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

  private emitDiagnostic(code: string, message: string, metadata?: Record<string, unknown>): void {
    emitNodeDiagnostic(this.config, code, message, metadata);
  }

  private async refreshRemoteProbeConfig(): Promise<void> {
    const config = this.config;
    if (config === null) {
      return;
    }
    const generation = this.generation;

    try {
      const result = await fetchNodeRemoteConfig(config, this.remoteProbeConfigEtag);
      if (this.generation !== generation) return;
      if (result.etag !== null) this.remoteProbeConfigEtag = result.etag;
      if (result.kind === "not_modified") {
        this.remoteProbeConfig = pruneNodeProbeDirectives(this.remoteProbeConfig, Date.now());
        this.scheduleRemoteProbePoll(this.remoteProbeConfig.pollIntervalMs);
        return;
      }
      if (result.kind !== "ready") {
        if (result.kind === "invalid") { this.evidence.observe(undefined); this.emitDiagnostic("remote_probe_config_invalid", "sdk-node received an invalid remote probe config payload"); }
        this.applyMinimalPolicyFallbackIfNeeded(); this.scheduleRemoteProbePoll(config.probesPollInterval); return;
      }
      const parsed = result.snapshot;
      this.evidence.observe(result.capabilities);
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
