import { sanitizeTelemetry } from "@debugbundle/redaction";
import { AnalyticsEventEnvelopeSchema } from "@debugbundle/shared-types";
import type { BrowserAnalyticsEventEnvelope } from "./types.js";

/** Snapshot only protected data properties; never retain caller objects or accessors. */
export function snapshotAnalyticsInput(
  value: unknown,
  additionalKeys: readonly string[]
): Record<string, unknown> | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (keys.length > 32) return null;
    const primitives: Record<string, string | number | boolean | null> = Object.create(
      null
    ) as Record<string, string | number | boolean | null>;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      const item: unknown = descriptor.value;
      if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
      if (
        item === null ||
        typeof item === "string" ||
        typeof item === "boolean" ||
        (typeof item === "number" && Number.isFinite(item))
      )
        primitives[key] = item;
    }
    const result = sanitizeTelemetry(primitives, { additionalKeys, maxTotalBytes: 4096 });
    return result.ok &&
      result.value !== null &&
      typeof result.value === "object" &&
      !Array.isArray(result.value)
      ? result.value
      : null;
  } catch {
    return null;
  }
}

/** Preserve schema-defined identity scalars while protecting all captured event fields. */
export function protectBrowserAnalyticsEvent(
  event: BrowserAnalyticsEventEnvelope,
  additionalKeys: readonly string[]
): BrowserAnalyticsEventEnvelope | null {
  try {
    for (const value of Object.values(event.correlation)) {
      if (typeof value !== "string") continue;
      const checked = sanitizeTelemetry(value, { additionalKeys });
      if (!checked.ok || checked.value !== value) return null;
    }
    const result = sanitizeTelemetry(
      { service: event.service, payload: event.payload },
      {
        additionalKeys,
        maxTotalBytes: 16 * 1024
      }
    );
    if (
      !result.ok ||
      result.value === null ||
      typeof result.value !== "object" ||
      Array.isArray(result.value)
    )
      return null;
    const parsed = AnalyticsEventEnvelopeSchema.safeParse({
      ...event,
      service: result.value["service"],
      payload: result.value["payload"]
    });
    return parsed.success ? (parsed.data as BrowserAnalyticsEventEnvelope) : null;
  } catch {
    return null;
  }
}

export function analyticsSnapshotBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
