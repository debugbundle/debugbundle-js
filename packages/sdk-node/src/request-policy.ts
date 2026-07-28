import type { CapturePolicy, CaptureRequestInput, CaptureResponseInput, HttpMethod } from "./types.js";

const BALANCED_IMMEDIATE_REQUEST_STATUSES = new Set([408, 423, 424, 425, 429]);
const INVESTIGATIVE_IMMEDIATE_REQUEST_STATUSES = new Set([...BALANCED_IMMEDIATE_REQUEST_STATUSES, 409]);

export function isImmediateRequestIncidentStatus(
  statusCode: number,
  preset: string,
  immediateClientErrorStatuses: readonly number[] = [],
  requestPath?: string,
  httpMethod?: string,
  immediateClientErrorPathRules: CapturePolicy["immediateClientErrorPathRules"] = []
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
  if (matchesImmediateClientErrorPathRule(statusCode, requestPath, httpMethod, immediateClientErrorPathRules)) {
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

export function shouldCaptureNodeRequestEvent(
  capturePolicy: CapturePolicy,
  request: CaptureRequestInput,
  response: CaptureResponseInput
): boolean {
  const policy = capturePolicy.captureRequestEvents;
  const statusCode = response.statusCode ?? response.status ?? 0;
  if (
    isImmediateRequestIncidentStatus(
      statusCode,
      capturePolicy.preset,
      capturePolicy.immediateClientErrorStatuses,
      request.path ?? request.url,
      request.method,
      capturePolicy.immediateClientErrorPathRules
    )
  ) {
    return true;
  }
  if (policy === "off") {
    return false;
  }
  if (policy === "all") {
    return true;
  }
  if (policy === "failures_only") {
    return statusCode >= 500;
  }
  // "filtered" has no user-defined filters yet, so only immediate failures above are kept.
  return false;
}

function matchesImmediateClientErrorPathRule(
  statusCode: number,
  requestPath: string | undefined,
  httpMethod: string | undefined,
  rules: CapturePolicy["immediateClientErrorPathRules"]
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
    if (rule.methods.length > 0 && (normalizedMethod === null || !rule.methods.includes(normalizedMethod as HttpMethod))) {
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
    return new URL(value, "https://debugbundle.local").pathname || "/";
  } catch {
    const queryIndex = value.indexOf("?");
    const fragmentIndex = value.indexOf("#");
    const end =
      queryIndex === -1
        ? fragmentIndex === -1
          ? value.length
          : fragmentIndex
        : fragmentIndex === -1
          ? queryIndex
          : Math.min(queryIndex, fragmentIndex);
    const path = value.slice(0, end);
    return path.startsWith("/") && path.length > 0 ? path : "/";
  }
}
