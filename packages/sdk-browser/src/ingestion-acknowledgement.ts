import type { DebugBundleIngestionAcknowledgement } from "./types.js";

const RETRYABLE_REASONS = new Set([
  "rate_limited",
  "monthly_quota_exceeded",
  "analytics_quota_exceeded"
]);

export type BrowserAcknowledgementDecision =
  | { kind: "legacy" }
  | { kind: "protocol_failure"; reason: string }
  | {
      kind: "acknowledged";
      accepted: number;
      retryableIndices: number[];
      terminalErrors: Array<{ index: number; reason: string }>;
    };

export function decideBrowserAcknowledgement(
  body: unknown,
  batchLength: number,
  required = false
): BrowserAcknowledgementDecision {
  if (!hasAcknowledgementFields(body)) {
    return required ? { kind: "protocol_failure", reason: "missing_acknowledgement" } : { kind: "legacy" };
  }
  const acknowledgement = body;
  if (
    !isCount(acknowledgement.accepted) ||
    !isCount(acknowledgement.rejected) ||
    !Array.isArray(acknowledgement.errors) ||
    acknowledgement.accepted + acknowledgement.rejected !== batchLength ||
    acknowledgement.errors.length !== acknowledgement.rejected
  ) {
    return { kind: "protocol_failure", reason: "inconsistent_counts" };
  }

  const seen = new Set<number>();
  const retryableIndices: number[] = [];
  const terminalErrors: Array<{ index: number; reason: string }> = [];
  for (const error of acknowledgement.errors) {
    if (
      !error ||
      typeof error !== "object" ||
      !Number.isInteger(error.index) ||
      error.index < 0 ||
      error.index >= batchLength ||
      typeof error.reason !== "string" ||
      error.reason.length === 0 ||
      seen.has(error.index)
    ) {
      return { kind: "protocol_failure", reason: "invalid_error_index" };
    }
    seen.add(error.index);
    if (RETRYABLE_REASONS.has(error.reason)) {
      retryableIndices.push(error.index);
    } else {
      terminalErrors.push({ index: error.index, reason: error.reason });
    }
  }

  return {
    kind: "acknowledged",
    accepted: acknowledgement.accepted,
    retryableIndices,
    terminalErrors
  };
}

function hasAcknowledgementFields(
  body: unknown
): body is Partial<DebugBundleIngestionAcknowledgement> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  return "accepted" in body || "rejected" in body || "errors" in body;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
