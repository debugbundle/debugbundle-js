import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { isAbsolute, join, normalize, resolve } from "node:path";

import { redact, type JsonObject, type JsonValue } from "@debugbundle/redaction";
import type { DebugBundleTransport, DebugBundleTransportRequest, DebugBundleTransportResponse, RuntimeDetectionResult } from "./types.js";

const MAX_SANITIZE_DEPTH = 8;
const MAX_SANITIZE_STRING_LENGTH = 2_048;
const MAX_SANITIZE_ARRAY_ITEMS = 50;
const MAX_SANITIZE_OBJECT_KEYS = 50;
const MAX_RETRY_AFTER_MS = 5 * 60 * 1_000;
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
  if (value === null) {
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
    const sanitizedEntries = value
      .slice(0, MAX_SANITIZE_ARRAY_ITEMS)
      .map((entry) => sanitizeUnknownInternal(entry, seen, depth + 1));

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
    const entries = Object.entries(value).slice(0, MAX_SANITIZE_OBJECT_KEYS);
    for (const [key, nestedValue] of entries) {
      output[key] = sanitizeUnknownInternal(nestedValue, seen, depth + 1);
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

  const sanitized = sanitizeUnknown(metadata);
  if (sanitized === null || Array.isArray(sanitized) || typeof sanitized !== "object") {
    return undefined;
  }

  return sanitized;
}

export function redactObject(value: unknown, sensitiveKeys: string[]): JsonObject {
  return redact(ensureObject(value), { sensitiveKeys }).redacted;
}

export function extractHeaderValue(headers: Record<string, unknown> | undefined, headerName: string): string | null {
  if (headers === undefined) {
    return null;
  }

  const normalizedName = headerName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== normalizedName) {
      continue;
    }

    const sanitized = sanitizeUnknown(value);
    if (sanitized === null) {
      return null;
    }

    if (Array.isArray(sanitized)) {
      return sanitized.map((entry) => stringifyJsonValue(entry)).join(",");
    }

    return stringifyJsonValue(sanitized);
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
  return async (request: DebugBundleTransportRequest): Promise<DebugBundleTransportResponse> => {
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

      return {
        status: response.status,
        ...(retryAfterMs === undefined ? {} : { retry_after_ms: retryAfterMs })
      };
    } finally {
      clearTimeout(timeout);
    }
  };
}