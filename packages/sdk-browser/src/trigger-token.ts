import type { BrowserRemoteProbeDirective } from "./types.js";

const PROBE_TRIGGER_TOKEN_PREFIX = "dbundle_probe_";

interface ProbeTriggerTokenPayload {
  activation_id: string;
  label_pattern: string;
  service: string;
  environment: string;
  trigger_expires_at: string;
}

function decodeBase64Url(segment: string): string | null {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(segment, "base64url").toString("utf8");
    }

    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = globalThis.atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function decodeBase64UrlBytes(segment: string): Uint8Array | null {
  try {
    if (typeof Buffer !== "undefined") {
      return new Uint8Array(Buffer.from(segment, "base64url"));
    }

    const normalized = segment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = globalThis.atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function parsePayload(payloadSegment: string): ProbeTriggerTokenPayload | null {
  const decoded = decodeBase64Url(payloadSegment);
  if (decoded === null) {
    return null;
  }

  try {
    const parsed = JSON.parse(decoded) as Partial<ProbeTriggerTokenPayload>;
    if (
      typeof parsed.activation_id !== "string" ||
      typeof parsed.label_pattern !== "string" ||
      typeof parsed.service !== "string" ||
      typeof parsed.environment !== "string" ||
      typeof parsed.trigger_expires_at !== "string"
    ) {
      return null;
    }

    if (Number.isNaN(Date.parse(parsed.trigger_expires_at))) {
      return null;
    }

    return parsed as ProbeTriggerTokenPayload;
  } catch {
    return null;
  }
}

async function hasValidSignature(payloadSegment: string, signatureSegment: string, triggerTokenKey: string): Promise<boolean> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined || typeof subtle.verify !== "function") {
    return false;
  }

  const signatureBytes = decodeBase64UrlBytes(signatureSegment);
  if (signatureBytes === null) {
    return false;
  }
  const signatureBuffer = Uint8Array.from(signatureBytes).buffer;

  const key = await subtle.importKey(
    "raw",
    new TextEncoder().encode(triggerTokenKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  return subtle.verify("HMAC", key, signatureBuffer, new TextEncoder().encode(payloadSegment));
}

export async function validateBrowserTriggerToken(input: {
	token: string;
	triggerTokenKey: string | null;
	nowMs: number;
}): Promise<BrowserRemoteProbeDirective | null> {
  if (input.triggerTokenKey === null || !input.token.startsWith(PROBE_TRIGGER_TOKEN_PREFIX)) {
    return null;
  }

  const encoded = input.token.slice(PROBE_TRIGGER_TOKEN_PREFIX.length);
  const separatorIndex = encoded.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === encoded.length - 1) {
    return null;
  }

  const payloadSegment = encoded.slice(0, separatorIndex);
  const signatureSegment = encoded.slice(separatorIndex + 1);
  if (!(await hasValidSignature(payloadSegment, signatureSegment, input.triggerTokenKey))) {
    return null;
  }

  const payload = parsePayload(payloadSegment);
  if (payload === null || Date.parse(payload.trigger_expires_at) <= input.nowMs) {
    return null;
  }

  return {
    activationId: payload.activation_id,
    labelPattern: payload.label_pattern,
    service: payload.service,
    environment: payload.environment,
    expiresAt: payload.trigger_expires_at,
    triggerExpiresAt: payload.trigger_expires_at
  };
}
