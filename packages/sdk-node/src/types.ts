import type { JsonObject, JsonValue } from "@debugbundle/redaction";
import type { EventEnvelope } from "@debugbundle/shared-types";

export const SDK_NAME = "@debugbundle/sdk-node";
export const SDK_VERSION = "0.1.0";
export const SDK_SCHEMA_VERSION = "2026-03-01";

export const DEFAULT_ENDPOINT = "https://api.debugbundle.com/v1/events";
export const DEFAULT_BATCH_SIZE = 50;
export const DEFAULT_FLUSH_INTERVAL_MS = 2_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_LOG_LEVEL = "warning";
export const DEFAULT_MAX_BUFFERED_EVENTS = 1_000;
export const DEFAULT_PROBES_POLL_INTERVAL_MS = 60_000;
export const DEFAULT_MAX_PROBE_LABELS = 50;
export const DEFAULT_MAX_PROBE_ENTRIES = 10;

export const LOG_LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  critical: 50
} as const;

export type LogLevel = keyof typeof LOG_LEVEL_ORDER;
export type DebugBundleProjectMode = "connected" | "local-only";

export type CaptureLogs = "off" | "error" | "warning" | "info";
export type CaptureRequestEvents = "off" | "failures_only" | "filtered" | "all";
export type CaptureBreadcrumbs = "local_only" | "exception_only" | "standalone";
export type CaptureProbeEvents = "buffer_only" | "standalone_when_activated";

export interface CapturePolicy {
  preset: string;
  captureLogs: CaptureLogs;
  captureRequestEvents: CaptureRequestEvents;
  captureBreadcrumbs: CaptureBreadcrumbs;
  captureProbeEvents: CaptureProbeEvents;
  immediateClientErrorStatuses: number[];
}

export const BALANCED_CAPTURE_POLICY: CapturePolicy = {
  preset: "balanced",
  captureLogs: "warning",
  captureRequestEvents: "failures_only",
  captureBreadcrumbs: "exception_only",
  captureProbeEvents: "buffer_only",
  immediateClientErrorStatuses: []
};

export const MINIMAL_CAPTURE_POLICY: CapturePolicy = {
  preset: "minimal",
  captureLogs: "error",
  captureRequestEvents: "failures_only",
  captureBreadcrumbs: "local_only",
  captureProbeEvents: "buffer_only",
  immediateClientErrorStatuses: []
};

export interface RuntimeDetectionResult {
  service: string | null;
  framework: string | null;
}

export interface CorrelationFields {
  request_id: string | null;
  trace_id: string | null;
  session_id: string | null;
  user_id_hash: string | null;
}

export interface DebugBundleTransportRequest {
  endpoint: string;
  headers: Record<string, string>;
  events: EventEnvelope[];
  timeout_ms: number;
}

export interface DebugBundleTransportResponse {
  status: number;
  retry_after_ms?: number;
  writtenFilePath?: string;
}

export type DebugBundleTransport = (
  request: DebugBundleTransportRequest
) => Promise<DebugBundleTransportResponse>;

export interface DebugBundleDiagnostic {
  code: string;
  message: string;
  metadata?: JsonObject;
}

export interface CaptureRequestInput {
  method?: string;
  path?: string;
  url?: string;
  headers?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  routeTemplate?: string | null;
}

export interface CaptureResponseInput {
  statusCode?: number;
  status?: number;
  durationMs?: number;
  headers?: Record<string, unknown>;
  body?: unknown;
}

export interface CaptureExceptionContext {
  handled?: boolean;
  request?: CaptureRequestInput;
  response?: CaptureResponseInput;
  correlation?: Partial<CorrelationFields>;
}

export interface CaptureRequestContext {
  durationMs?: number;
  correlation?: Partial<CorrelationFields>;
}

export interface CaptureLogContext {
  correlation?: Partial<CorrelationFields>;
  [key: string]: unknown;
}

export interface ProbeOptions {
  heavy?: boolean;
}

export type ModuleResolver = (moduleName: string) => string;

export interface DebugBundleNodeInitConfig {
  projectToken?: string;
  environment?: string;
  service?: string;
  framework?: string | null;
  projectMode?: DebugBundleProjectMode;
  localEventsDir?: string;
  enabled?: boolean;
  redactFields?: string[];
  sampleRate?: number;
  batchSize?: number;
  flushInterval?: number;
  endpoint?: string;
  logLevel?: LogLevel;
  maxBufferedEvents?: number;
  probesPollInterval?: number;
  maxProbeLabels?: number;
  maxProbeEntriesPerLabel?: number;
  probeFlushOnError?: boolean;
  requestTimeoutMs?: number;
  transport?: DebugBundleTransport;
  fetchImpl?: typeof fetch;
  onDiagnostic?: (diagnostic: DebugBundleDiagnostic) => void;
  logger?: unknown;
  resolveModule?: ModuleResolver;
  captureConsole?: boolean;
  autoDetectLoggers?: boolean;
}

export interface ActiveConfig {
  projectToken: string;
  environment: string;
  service: string;
  framework: string | null;
  redactFields: string[];
  sampleRate: number;
  batchSize: number;
  flushInterval: number;
  endpoint: string;
  logLevel: LogLevel;
  maxBufferedEvents: number;
  probesPollInterval: number;
  maxProbeLabels: number;
  maxProbeEntriesPerLabel: number;
  probeFlushOnError: boolean;
  requestTimeoutMs: number;
  fetchImpl: typeof fetch;
  transport: DebugBundleTransport;
  autoDetectLoggers: boolean;
  resolveModule?: ModuleResolver;
  onDiagnostic?: (diagnostic: DebugBundleDiagnostic) => void;
}

export interface RemoteProbeDirective {
  id: string;
  labelPattern: string;
  service: string;
  environment: string;
  expiresAt: string;
}

export interface RemoteProbeConfigSnapshot {
  probesEnabled: boolean;
  remoteProbesEnabled: boolean;
  directives: RemoteProbeDirective[];
  pollIntervalMs: number;
  triggerTokenKey: string | null;
  capturePolicy: CapturePolicy;
}

export interface ProbeBufferItem {
  label: string;
  data: JsonObject;
  timestamp: string;
  activation_id: string | null;
}

export interface LoggerCaptureApi {
  captureLog(message: string, level: LogLevel, context?: CaptureLogContext): void;
}

export interface LoggerAttachmentResult {
  attached: boolean;
  restore?: () => void;
}

export interface FrameworkSdkBridge {
  attachLogger(logger: unknown): boolean;
  captureConsole(): void;
  captureException(error: unknown, context?: CaptureExceptionContext): void;
  captureRequest(request: CaptureRequestInput, response: CaptureResponseInput, context?: CaptureRequestContext): void;
  shouldInstrumentRequest?(request: CaptureRequestInput): boolean;
  runWithRequestContext?<Result>(request: CaptureRequestInput, callback: () => Result): Result;
}

export type NextApiHandler<Request, Response, Result> = (req: Request, res: Response) => Result | Promise<Result>;

export type NextWrappedHandler<Request, Response, Result> = (req: Request, res: Response) => Promise<Result>;

export type ProbePayload = JsonValue;
