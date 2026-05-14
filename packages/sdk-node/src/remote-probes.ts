import {
  BALANCED_CAPTURE_POLICY,
  DEFAULT_PROBES_POLL_INTERVAL_MS,
  type CapturePolicy,
  type RemoteProbeConfigSnapshot,
  type RemoteProbeDirective
} from "./types.js";

const VALID_CAPTURE_LOGS = new Set(["off", "error", "warning", "info"]);
const VALID_CAPTURE_REQUEST_EVENTS = new Set(["off", "failures_only", "filtered", "all"]);
const VALID_CAPTURE_BREADCRUMBS = new Set(["local_only", "exception_only", "standalone"]);
const VALID_CAPTURE_PROBE_EVENTS = new Set(["buffer_only", "standalone_when_activated"]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseImmediateClientErrorStatuses(value: unknown): number[] | null {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    return null;
  }

  const statuses = value
    .filter((entry): entry is number => typeof entry === "number" && Number.isInteger(entry) && entry >= 400 && entry <= 499)
    .sort((left, right) => left - right);

  if (statuses.length !== value.length || statuses.length > 12) {
    return null;
  }

  return Array.from(new Set(statuses));
}

function parseDirective(value: unknown): RemoteProbeDirective | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const id = asString(record["id"]);
  const labelPattern = asString(record["label_pattern"]);
  const service = asString(record["service"]);
  const environment = asString(record["environment"]);
  const expiresAt = asString(record["expires_at"]);

  if (id === null || labelPattern === null || service === null || environment === null || expiresAt === null) {
    return null;
  }

  if (Number.isNaN(Date.parse(expiresAt))) {
    return null;
  }

  return {
    id,
    labelPattern,
    service,
    environment,
    expiresAt
  };
}

export function parseCapturePolicy(value: unknown): CapturePolicy | null {
  if (value === undefined || value === null) {
    return BALANCED_CAPTURE_POLICY;
  }

  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const preset = asString(record["preset"]) ?? BALANCED_CAPTURE_POLICY.preset;
  const captureLogs = asString(record["capture_logs"]);
  const captureRequestEvents = asString(record["capture_request_events"]);
  const captureBreadcrumbs = asString(record["capture_breadcrumbs"]);
  const captureProbeEvents = asString(record["capture_probe_events"]);
  const immediateClientErrorStatuses = parseImmediateClientErrorStatuses(record["immediate_client_error_statuses"]);

  if (captureLogs === null || !VALID_CAPTURE_LOGS.has(captureLogs)) {
    return null;
  }
  if (captureRequestEvents === null || !VALID_CAPTURE_REQUEST_EVENTS.has(captureRequestEvents)) {
    return null;
  }
  if (captureBreadcrumbs === null || !VALID_CAPTURE_BREADCRUMBS.has(captureBreadcrumbs)) {
    return null;
  }
  if (captureProbeEvents === null || !VALID_CAPTURE_PROBE_EVENTS.has(captureProbeEvents)) {
    return null;
  }
  if (immediateClientErrorStatuses === null) {
    return null;
  }

  return {
    preset,
    captureLogs: captureLogs as CapturePolicy["captureLogs"],
    captureRequestEvents: captureRequestEvents as CapturePolicy["captureRequestEvents"],
    captureBreadcrumbs: captureBreadcrumbs as CapturePolicy["captureBreadcrumbs"],
    captureProbeEvents: captureProbeEvents as CapturePolicy["captureProbeEvents"],
    immediateClientErrorStatuses
  };
}

export function parseRemoteProbeConfig(
  payload: unknown,
  fallbackPollIntervalMs: number,
  nowMs: number
): RemoteProbeConfigSnapshot | null {
  const record = asRecord(payload);
  if (record === null) {
    return null;
  }

  const probesEnabled = record["probes_enabled"] === true;
  const remoteProbesEnabled = record["remote_probes_enabled"] === true;
  const pollIntervalCandidate = record["poll_interval_ms"];
  const pollIntervalMs =
    typeof pollIntervalCandidate === "number" && Number.isFinite(pollIntervalCandidate) && pollIntervalCandidate > 0
      ? Math.floor(pollIntervalCandidate)
      : fallbackPollIntervalMs;

  const directives = Array.isArray(record["active_probes"])
    ? record["active_probes"]
        .map((directive) => parseDirective(directive))
        .filter((directive): directive is RemoteProbeDirective => directive !== null)
        .filter((directive) => Date.parse(directive.expiresAt) > nowMs)
    : [];

  const capturePolicy = parseCapturePolicy(record["capture_policy"]);
  if (capturePolicy === null) {
    return null;
  }

  return {
    probesEnabled,
    remoteProbesEnabled,
    directives,
    pollIntervalMs: remoteProbesEnabled ? pollIntervalMs : DEFAULT_PROBES_POLL_INTERVAL_MS,
    triggerTokenKey: asString(record["trigger_token_key"]),
    capturePolicy
  };
}

export function findMatchingRemoteProbeDirectives(
  directives: RemoteProbeDirective[],
  label: string,
  service: string,
  environment: string,
  nowMs: number
): RemoteProbeDirective[] {
  return directives.filter((directive) => {
    if (Date.parse(directive.expiresAt) <= nowMs) {
      return false;
    }

    if (directive.service !== "*" && directive.service !== service) {
      return false;
    }

    if (directive.environment !== "*" && directive.environment !== environment) {
      return false;
    }

    return matchesLabelPattern(directive.labelPattern, label);
  });
}

function matchesLabelPattern(pattern: string, label: string): boolean {
  if (pattern === "*") {
    return true;
  }

  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return label === prefix || label.startsWith(`${prefix}.`);
  }

  return pattern === label;
}
