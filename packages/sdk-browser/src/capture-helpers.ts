import {
  getLocationSource,
  matchesBrowserPattern,
  matchesStatusCodeFilter
} from "./runtime.js";
import { hasErrorDetails, readNativeField, readNativeFields } from "./native-fields.js";
import type {
  ActiveConfig,
  BrowserCapturePreset,
  BrowserCaptureRequestEvents,
  BrowserHttpMethod,
  BrowserRejectionReasonContext,
  BrowserRemoteProbeState
} from "./types.js";

const DEFAULT_REQUEST_FAILURE_PRESET: BrowserCapturePreset = "balanced";
const DEFAULT_REQUEST_CAPTURE_EVENTS: BrowserCaptureRequestEvents = "failures_only";
const DEFAULT_IMMEDIATE_CLIENT_ERROR_STATUSES: number[] = [];
const MAX_REJECTION_REASON_PREVIEW_LENGTH = 500;
const BALANCED_IMMEDIATE_REQUEST_STATUSES = new Set([408, 423, 424, 425, 429]);
const INVESTIGATIVE_IMMEDIATE_REQUEST_STATUSES = new Set([...BALANCED_IMMEDIATE_REQUEST_STATUSES, 409]);

export function createInitialRemoteProbeState(): BrowserRemoteProbeState {
  return {
    probesEnabled: false,
    remoteProbesEnabled: false,
    directives: [],
    triggerTokenKey: null,
    requestFailurePreset: DEFAULT_REQUEST_FAILURE_PRESET,
    requestCaptureEvents: DEFAULT_REQUEST_CAPTURE_EVENTS,
    immediateClientErrorStatuses: [...DEFAULT_IMMEDIATE_CLIENT_ERROR_STATUSES],
    immediateClientErrorPathRules: []
  };
}

function rejectionFallback(message: string, name = "Error"): Error {
  const error = new Error(message);
  error.name = name;
  // Preserve the existing Error return shape without claiming SDK frames are
  // the stack of a primitive/object rejection.
  error.stack = `${name}: ${message}`;
  return error;
}

export function normalizeUnhandledRejectionReason(reason: unknown): {
  error: unknown;
  rejectionReason: BrowserRejectionReasonContext;
} {
  if (hasErrorDetails(reason) && typeof readNativeField(reason, "stack") === "string") {
    const fields = readNativeFields(reason, ["name", "message"]);
    return {
      error: reason,
      rejectionReason: {
        kind: "error",
        name: readReasonStringField(fields, "name") ?? "Error",
        message: truncateRejectionReasonPreview(readReasonStringField(fields, "message") ?? "Unknown rejection error")
      }
    };
  }

  if (typeof reason === "string") {
    const preview = truncateRejectionReasonPreview(reason.length > 0 ? reason : "[empty string]");
    return {
      error: rejectionFallback(reason.length > 0 ? reason : "Unhandled promise rejection"),
      rejectionReason: { kind: "string", preview }
    };
  }

  if (reason === null) {
    return {
      error: rejectionFallback("Unhandled promise rejection: null"),
      rejectionReason: { kind: "null", preview: "null" }
    };
  }

  if (reason === undefined) {
    return {
      error: rejectionFallback("Unhandled promise rejection: undefined"),
      rejectionReason: { kind: "undefined", preview: "undefined" }
    };
  }

  const record = readNativeFields(reason, ["name", "message"]);
  const name = readReasonStringField(record, "name");
  const message = readReasonStringField(record, "message");
  const constructorName = readNativeField(readNativeField(reason, "constructor"), "name");
  const preview = typeof constructorName === "string" && constructorName.length > 0 ? constructorName : "object";

  return {
    error: rejectionFallback(message ?? "Unhandled promise rejection", name ?? "Error"),
    rejectionReason: {
      kind: "object",
      ...(name === undefined ? {} : { name }),
      ...(message === undefined ? {} : { message }),
      preview
    }
  };
}

export function isImmediateRequestIncidentStatus(
  statusCode: number,
  preset: BrowserCapturePreset,
  immediateClientErrorStatuses: readonly number[] = [],
  requestPath?: string,
  httpMethod?: string,
  immediateClientErrorPathRules: BrowserRemoteProbeState["immediateClientErrorPathRules"] = []
): boolean {
  if (!Number.isFinite(statusCode)) {
    return false;
  }
  if (statusCode >= 500 || immediateClientErrorStatuses.includes(statusCode)) {
    return true;
  }
  if (matchesImmediateClientErrorPathRule(statusCode, requestPath, httpMethod, immediateClientErrorPathRules)) {
    return true;
  }
  if (preset === "investigative") {
    return INVESTIGATIVE_IMMEDIATE_REQUEST_STATUSES.has(statusCode);
  }
  return preset === "balanced" && BALANCED_IMMEDIATE_REQUEST_STATUSES.has(statusCode);
}

export function shouldCaptureRequestStatus(
  statusCode: number,
  preset: BrowserCapturePreset,
  policy: BrowserCaptureRequestEvents,
  immediateClientErrorStatuses: readonly number[] = [],
  requestPath?: string,
  httpMethod?: string,
  immediateClientErrorPathRules: BrowserRemoteProbeState["immediateClientErrorPathRules"] = []
): boolean {
  if (isImmediateRequestIncidentStatus(
    statusCode,
    preset,
    immediateClientErrorStatuses,
    requestPath,
    httpMethod,
    immediateClientErrorPathRules
  )) {
    return true;
  }
  if (policy === "all") {
    return Number.isFinite(statusCode) && statusCode >= 400;
  }
  return policy === "failures_only" && statusCode >= 500;
}

export function shouldCaptureBrowserNetworkRequest(
  config: ActiveConfig | null,
  url: string,
  statusCode: number,
  durationMs: number
): boolean {
  if (config === null || !matchesNetworkFilter(config, url, durationMs)) {
    return false;
  }

  return matchesStatusCodeFilter(statusCode, config.networkFilter.statusCodes);
}

export function shouldCaptureFailedBrowserNetworkRequest(
  config: ActiveConfig | null,
  url: string,
  durationMs: number
): boolean {
  return config !== null && matchesNetworkFilter(config, url, durationMs);
}

function matchesNetworkFilter(config: ActiveConfig, url: string, durationMs: number): boolean {
  const filter = config.networkFilter;
  if (filter.urlPatterns.length > 0 && !filter.urlPatterns.some((pattern) => matchesBrowserPattern(url, pattern))) {
    return false;
  }
  if (filter.urlDenyPatterns.some((pattern) => matchesBrowserPattern(url, pattern))) {
    return false;
  }
  return filter.minResponseTime === null || durationMs >= filter.minResponseTime;
}

function truncateRejectionReasonPreview(value: string): string {
  return value.length > MAX_REJECTION_REASON_PREVIEW_LENGTH
    ? `${value.slice(0, MAX_REJECTION_REASON_PREVIEW_LENGTH)}[truncated]`
    : value;
}

function readReasonStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? truncateRejectionReasonPreview(value.trim())
    : undefined;
}

function matchesImmediateClientErrorPathRule(
  statusCode: number,
  requestPath: string | undefined,
  httpMethod: string | undefined,
  rules: BrowserRemoteProbeState["immediateClientErrorPathRules"]
): boolean {
  if (statusCode < 400 || statusCode > 499 || requestPath === undefined) {
    return false;
  }
  const normalizedPath = normalizeRequestPath(requestPath);
  const normalizedMethod = typeof httpMethod === "string" ? httpMethod.toUpperCase() : null;
  return rules.some((rule) => {
    if (rule.statusCode !== statusCode) {
      return false;
    }
    if (rule.methods.length > 0 && (normalizedMethod === null || !rule.methods.includes(normalizedMethod as BrowserHttpMethod))) {
      return false;
    }
    if (rule.pathPattern.endsWith("*")) {
      return normalizedPath.startsWith(rule.pathPattern.slice(0, -1));
    }
    return normalizedPath === rule.pathPattern;
  });
}

function normalizeRequestPath(value: string): string {
  try {
    return new URL(value, getLocationSource()?.href ?? "https://debugbundle.local").pathname || "/";
  } catch {
    const queryIndex = value.indexOf("?");
    const fragmentIndex = value.indexOf("#");
    const end = queryIndex === -1
      ? (fragmentIndex === -1 ? value.length : fragmentIndex)
      : fragmentIndex === -1
        ? queryIndex
        : Math.min(queryIndex, fragmentIndex);
    const path = value.slice(0, end);
    return path.startsWith("/") && path.length > 0 ? path : "/";
  }
}
