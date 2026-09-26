import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { sanitizeTelemetry, type JsonObject, type JsonValue } from "@debugbundle/redaction";
import type { DebugBundleTransport, DebugBundleTransportRequest, DebugBundleTransportResponse, RuntimeDetectionResult } from "./types.js";

const MAX_SANITIZE_DEPTH = 8;
const MAX_SANITIZE_STRING_LENGTH = 2_048;
const MAX_SANITIZE_ARRAY_ITEMS = 50;
const MAX_SANITIZE_OBJECT_KEYS = 50;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;
// Only SDK-owned HTTP transports require a canonical response; file/custom transports retain compatibility.
const HTTP_TRANSPORTS = new WeakSet<DebugBundleTransport>();

export function requiresIngestionAcknowledgement(transport: DebugBundleTransport): boolean {
  return HTTP_TRANSPORTS.has(transport);
}

export function boundedRetryAfterMs(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, value)) : 1_000;
}
const TRUNCATED_MARKER = "[Truncated]";

export interface ProcessRuntimeFacts {
  version: string;
  platform: string | null;
  arch: string | null;
  pid: number | null;
  cwd: string | null;
  uptime_sec: number | null;
  hostname: string | null;
  memory: {
    rss: number | null;
    heap_total: number | null;
    heap_used: number | null;
    external: number | null;
    peak: number | null;
  } | null;
}

export function detectRuntimeContext(): RuntimeDetectionResult {
  try {
    const packageJson = JSON.parse(requireFile("package.json")) as {
      name?: unknown;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    const dependencies = {
      ...(packageJson.dependencies ?? {}),
      ...(packageJson.devDependencies ?? {})
    };

    let framework: string | null = null;
    if ("next" in dependencies) {
      framework = "nextjs";
    } else if ("fastify" in dependencies) {
      framework = "fastify";
    } else if ("express" in dependencies) {
      framework = "express";
    }

    return {
      service: typeof packageJson.name === "string" && packageJson.name.length > 0 ? packageJson.name : null,
      framework
    };
  } catch {
    return {
      service: null,
      framework: null
    };
  }
}

function readRuntimeString(callback: () => string): string | null {
  try {
    const value = callback();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function readRuntimeNumber(callback: () => number): number | null {
  try {
    const value = callback();
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

export function detectProcessRuntimeFacts(): ProcessRuntimeFacts {
  let memory: ProcessRuntimeFacts["memory"] = null;
  try {
    const usage = process.memoryUsage();
    memory = {
      rss: readRuntimeNumber(() => usage.rss),
      heap_total: readRuntimeNumber(() => usage.heapTotal),
      heap_used: readRuntimeNumber(() => usage.heapUsed),
      external: readRuntimeNumber(() => usage.external),
      peak: null
    };
  } catch {
    memory = null;
  }

  return {
    version: process.version,
    platform: readRuntimeString(() => process.platform),
    arch: readRuntimeString(() => process.arch),
    pid: readRuntimeNumber(() => process.pid),
    cwd: readRuntimeString(() => process.cwd()),
    uptime_sec: readRuntimeNumber(() => Number(process.uptime().toFixed(3))),
    hostname: readRuntimeString(() => hostname()),
    memory
  };
}

function requireFile(fileName: string): string {
  const cwd = process.cwd();
  if (!isAbsolute(cwd) || cwd !== normalize(cwd) || cwd !== resolve(cwd)) {
    throw new Error("runtime_context_cwd_must_be_canonical_absolute_path");
  }

  return readFileSync(join(cwd, fileName), "utf8");
}

export function normalizeFiniteNumber(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(minimum, Math.floor(value));
}

export function normalizeSampleRate(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1;
  }

  return Math.min(1, Math.max(0, value));
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || value.trim() === "") {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, seconds * 1_000));
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, parsed - Date.now()));
}

export function normalizeError(input: unknown): Error {
  if (input instanceof Error) {
    return input;
  }

  if (typeof input === "string") {
    return new Error(input);
  }

  try {
    return new Error(JSON.stringify(sanitizeUnknown(input)));
  } catch {
    return new Error("Unknown error");
  }
}

function truncateSanitizedString(value: string): string {
  const protectedValue = sanitizeTelemetry(value);
  if (!protectedValue.ok || typeof protectedValue.value !== "string") return TRUNCATED_MARKER;
  value = protectedValue.value;
  if (value.length <= MAX_SANITIZE_STRING_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_SANITIZE_STRING_LENGTH - "...[truncated]".length)}...[truncated]`;
}

function sanitizeUnknownInternal(value: unknown, seen: WeakSet<object>, depth: number): JsonValue {
  if (depth >= MAX_SANITIZE_DEPTH) {
    return TRUNCATED_MARKER;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === "string") {
    return truncateSanitizedString(value);
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack ?? null
    };
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return truncateSanitizedString(value.toString("utf8"));
  }

  if (Array.isArray(value)) {
    const sanitizedEntries = Array.from({ length: Math.min(value.length, MAX_SANITIZE_ARRAY_ITEMS) }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      return descriptor !== undefined && "value" in descriptor
        ? sanitizeUnknownInternal(descriptor.value, seen, depth + 1) : null;
    });

    if (value.length > MAX_SANITIZE_ARRAY_ITEMS) {
      sanitizedEntries.push(TRUNCATED_MARKER);
    }

    return sanitizedEntries;
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const output: JsonObject = {};
    const keys = Object.keys(value).slice(0, MAX_SANITIZE_OBJECT_KEYS);
    for (const key of keys) {
      if (key.length > 128) continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) output[key] = sanitizeUnknownInternal(descriptor.value, seen, depth + 1);
    }
    seen.delete(value);
    return output;
  }

  if (typeof value === "function") {
    return "[Function]";
  }

  if (typeof value === "symbol") {
    return value.description ?? "Symbol";
  }

  return "[Unsupported]";
}

export function sanitizeUnknown(value: unknown, seen: WeakSet<object> = new WeakSet()): JsonValue {
  return sanitizeUnknownInternal(value, seen, 0);
}

export function stringifyJsonValue(value: JsonValue): string {
  if (value === null) {
    return "null";
  }

  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

export function ensureObject(value: unknown): JsonObject {
  const sanitized = sanitizeUnknown(value);
  if (sanitized !== null && !Array.isArray(sanitized) && typeof sanitized === "object") {
    return sanitized;
  }

  return {
    value: sanitized
  };
}

export function sanitizeMetadataObject(metadata: Record<string, unknown> | undefined): JsonObject | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  const sanitized = sanitizeTelemetry(sanitizeUnknown(metadata));
  if (!sanitized.ok || sanitized.value === null || Array.isArray(sanitized.value) ||
      typeof sanitized.value !== "object") {
    return undefined;
  }

  return sanitized.value;
}

export function redactObject(value: unknown, sensitiveKeys: string[]): JsonObject {
  const sanitized = sanitizeTelemetry(ensureObject(value), { additionalKeys: sensitiveKeys });
  if (!sanitized.ok || sanitized.value === null || Array.isArray(sanitized.value) ||
      typeof sanitized.value !== "object") {
    throw new Error("privacy_sanitization_failed");
  }
  return sanitized.value;
}

export function extractHeaderValue(headers: Record<string, unknown> | undefined, headerName: string): string | null {
  if (headers === undefined) {
    return null;
  }

  const normalizedName = headerName.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== normalizedName) {
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(headers, key);
    if (descriptor === undefined || !("value" in descriptor) || descriptor.value === null) return null;
    // This is a protocol read (including signed probe credentials), not telemetry.
    // Preserve bounded strings here; captured header snapshots are protected separately.
    const values: unknown[] = Array.isArray(descriptor.value) ? descriptor.value : [descriptor.value];
    if (values.length > MAX_SANITIZE_ARRAY_ITEMS) return null;
    const parts: string[] = [];
    for (let index = 0; index < values.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(values, String(index));
      if (entry === undefined || !("value" in entry)) return null;
      const part = typeof entry.value === "string" ? entry.value : stringifyJsonValue(sanitizeUnknown(entry.value));
      if (part.length > MAX_SANITIZE_STRING_LENGTH) return null;
      parts.push(part);
    }
    const joined = parts.join(",");
    return joined.length <= MAX_SANITIZE_STRING_LENGTH ? joined : null;
  }

  return null;
}

export function buildSdkConfigEndpoint(endpoint: string): string {
  if (endpoint.endsWith("/events")) {
    return `${endpoint.slice(0, -"/events".length)}/sdk/config`;
  }

  return `${endpoint.replace(/\/$/, "")}/sdk/config`;
}

export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetchImpl(url, {
      ...init,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function createFetchTransport(fetchImpl: typeof fetch, projectToken: string): DebugBundleTransport {
  const transport = async (request: DebugBundleTransportRequest): Promise<DebugBundleTransportResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeout_ms);

    try {
      const response = await fetchImpl(request.endpoint, {
        method: "POST",
        headers: {
          ...request.headers,
          Authorization: `Bearer ${projectToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ events: request.events }),
        signal: controller.signal
      });

      const retryAfterMs = parseRetryAfter(response.headers.get("Retry-After"));
      const body: unknown = typeof response.json === "function"
        ? await response.json().catch(() => undefined)
        : undefined;

      return {
        status: response.status,
        ...(body === undefined ? {} : { body }),
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs })
      };
    } finally {
      clearTimeout(timeout);
    }
  };
  HTTP_TRANSPORTS.add(transport);
  return transport;
}
