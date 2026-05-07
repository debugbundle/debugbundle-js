import { createHmac, timingSafeEqual } from "node:crypto";

import type { CaptureRequestInput, RemoteProbeDirective } from "./types.js";
import { extractHeaderValue } from "./utils.js";

const PROBE_TRIGGER_TOKEN_PREFIX = "dbundle_probe_";
const QUERY_PARAMETER_NAME = "_debug_probe";
const HEADER_NAME = "x-debugbundle-probe-trigger";

interface ProbeTriggerTokenPayload {
  activation_id: string;
  label_pattern: string;
  service: string;
  environment: string;
  trigger_expires_at: string;
}

function getQueryValue(query: Record<string, unknown> | undefined, key: string): string | null {
  if (query === undefined) {
    return null;
  }

  const value = query[key];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (Array.isArray(value)) {
    const first = value.find((entry): entry is string => typeof entry === "string" && entry.length > 0);
    return typeof first === "string" ? first : null;
  }

  return null;
}

function decodePayloadSegment(payloadSegment: string): ProbeTriggerTokenPayload | null {
  try {
    const json = Buffer.from(payloadSegment, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const candidate = parsed as Partial<ProbeTriggerTokenPayload>;

    if (
      typeof candidate.activation_id !== "string" ||
      typeof candidate.label_pattern !== "string" ||
      typeof candidate.service !== "string" ||
      typeof candidate.environment !== "string" ||
      typeof candidate.trigger_expires_at !== "string"
    ) {
      return null;
    }

    if (Number.isNaN(Date.parse(candidate.trigger_expires_at))) {
      return null;
    }

    return candidate as ProbeTriggerTokenPayload;
  } catch {
    return null;
  }
}

function hasValidSignature(payloadSegment: string, signatureSegment: string, triggerTokenKey: string): boolean {
  const expected = createHmac("sha256", triggerTokenKey).update(payloadSegment, "utf8").digest();
  const actual = Buffer.from(signatureSegment, "base64url");
  if (expected.length !== actual.length) {
    return false;
  }

  return timingSafeEqual(expected, actual);
}

function extractTriggerToken(request: CaptureRequestInput | undefined): string | null {
  if (request === undefined) {
    return null;
  }

  const headerToken = extractHeaderValue(request.headers, HEADER_NAME);
  if (headerToken !== null && headerToken.length > 0) {
    return headerToken;
  }

  return getQueryValue(request.query, QUERY_PARAMETER_NAME);
}

export function resolveRequestTriggerDirectives(input: {
  request: CaptureRequestInput | undefined;
  triggerTokenKey: string | null;
  nowMs: number;
}): RemoteProbeDirective[] {
  if (input.triggerTokenKey === null) {
    return [];
  }

  const token = extractTriggerToken(input.request);
  if (token === null || !token.startsWith(PROBE_TRIGGER_TOKEN_PREFIX)) {
    return [];
  }

  const encoded = token.slice(PROBE_TRIGGER_TOKEN_PREFIX.length);
  const separatorIndex = encoded.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === encoded.length - 1) {
    return [];
  }

  const payloadSegment = encoded.slice(0, separatorIndex);
  const signatureSegment = encoded.slice(separatorIndex + 1);
  if (!hasValidSignature(payloadSegment, signatureSegment, input.triggerTokenKey)) {
    return [];
  }

  const payload = decodePayloadSegment(payloadSegment);
  if (payload === null || Date.parse(payload.trigger_expires_at) <= input.nowMs) {
    return [];
  }

  return [
    {
      id: payload.activation_id,
      labelPattern: payload.label_pattern,
      service: payload.service,
      environment: payload.environment,
      expiresAt: payload.trigger_expires_at
    }
  ];
}
