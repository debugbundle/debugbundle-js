import {
  createBrowserTraceId,
  getCryptoSource,
  getDocumentSource,
  getLocalStorageSource,
  getLocationSource
} from "./runtime.js";
import type {
  ActiveConfig,
  BrowserAnalyticsCustomDimensions,
  BrowserAnalyticsCustomDimensionValue,
  BrowserAnalyticsDimensions,
  BrowserAnalyticsEventEnvelope,
  BrowserAnalyticsPrivacyMode,
  BrowserDeviceInfo
} from "./types.js";

const MAX_CUSTOM_DIMENSIONS = 8;
const MAX_CUSTOM_KEY_LENGTH = 64;
const MAX_CUSTOM_STRING_LENGTH = 128;
const SIGNAL_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const CUSTOM_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const SENSITIVE_KEY_PATTERN = /(password|passwd|secret|token|authorization|cookie|email|phone|address|card|credit|ssn|user.?id|order.?id|ticket.?id|workspace.?id)/i;
const STRUCTURAL_ACTION_KEYS_BY_TAG: Record<string, string> = {
  a: "click.link",
  button: "click.button",
  input: "click.input",
  select: "click.select",
  summary: "click.summary"
};
const STRUCTURAL_ACTION_KEYS_BY_ROLE: Record<string, string> = {
  button: "click.button",
  checkbox: "click.checkbox",
  link: "click.link",
  menuitem: "click.menuitem",
  radio: "click.radio",
  switch: "click.switch",
  tab: "click.tab"
};
const STRUCTURAL_INPUT_TYPES = new Set(["button", "checkbox", "radio", "reset", "submit"]);
const NON_FRICTION_CONTROL_TAGS = new Set(["input", "textarea", "select", "option", "label"]);
const STANDARD_VISITOR_STORAGE_PREFIX = "debugbundle.analytics.visitor.v1";
const BUILT_IN_DIMENSION_KEYS = new Set([
  "auth_state",
  "device_type",
  "browser_family",
  "browser_major",
  "os_family",
  "os_major",
  "language",
  "locale",
  "viewport_bucket",
  "referrer_domain",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "country_code",
  "region_code"
]);

export interface StandardAnalyticsVisitor {
  storageKey: string;
  visitorIdHash: string;
}

export async function resolveStandardAnalyticsVisitor(projectToken: string): Promise<StandardAnalyticsVisitor | null> {
  const projectScopeHash = await hashAnalyticsValue(projectToken);
  if (projectScopeHash === null) {
    return null;
  }

  const storageKey = `${STANDARD_VISITOR_STORAGE_PREFIX}.${projectScopeHash.slice("sha256:".length)}`;
  const visitorId = getOrCreateStoredVisitor(storageKey);
  if (visitorId === null) {
    return null;
  }

  const visitorIdHash = await hashAnalyticsValue(`${projectScopeHash}:${visitorId}`);
  return visitorIdHash === null ? null : { storageKey, visitorIdHash };
}

export function removeStoredAnalyticsVisitor(storageKey: string): void {
  try {
    getLocalStorageSource()?.removeItem(storageKey);
  } catch {
    // Storage access must never affect host application behavior.
  }
}

export function normalizeAnalyticsPrivacyMode(value: unknown): BrowserAnalyticsPrivacyMode {
  return value === "standard" || value === "custom" ? value : "strict";
}

export function getAnalyticsProjectTokenFields(config: ActiveConfig): Record<string, string> {
  return config.projectToken === null ? {} : { project_token: config.projectToken };
}

export function normalizeAnalyticsSignal(
  signal: Partial<BrowserAnalyticsEventEnvelope["payload"]["signal"]>
): BrowserAnalyticsEventEnvelope["payload"]["signal"] {
  return {
    action_key: normalizeSignalKey(signal.action_key),
    funnel_key: normalizeSignalKey(signal.funnel_key),
    step_key: normalizeSignalKey(signal.step_key),
    conversion_key: normalizeSignalKey(signal.conversion_key),
    marker_key: normalizeSignalKey(signal.marker_key)
  };
}

export function getStructuralActionKey(target: Record<string, unknown>): string | null {
  const role = normalizeStructuralActionValue(target["role"]);
  if (role !== null && STRUCTURAL_ACTION_KEYS_BY_ROLE[role] !== undefined) {
    return STRUCTURAL_ACTION_KEYS_BY_ROLE[role];
  }

  const tagName = normalizeStructuralActionValue(target["tagName"]);
  if (tagName === null) {
    return null;
  }
  if (tagName === "input") {
    const inputType = normalizeStructuralActionValue(target["type"]);
    if (inputType !== null && STRUCTURAL_INPUT_TYPES.has(inputType)) {
      return `click.input.${inputType}`;
    }
  }
  return STRUCTURAL_ACTION_KEYS_BY_TAG[tagName] ?? null;
}

export function isDeadClickCandidate(target: Record<string, unknown>): boolean {
  const tagName = normalizeStructuralActionValue(target["tagName"]);
  return tagName !== null && !NON_FRICTION_CONTROL_TAGS.has(tagName);
}

export function normalizeAnalyticsRoute(
  path: string | null | undefined,
  title: string | null
): BrowserAnalyticsEventEnvelope["payload"]["route"] {
  if (typeof path !== "string" || path.trim().length === 0) {
    return null;
  }

  try {
    const parsed = new URL(path, getLocationSource()?.href ?? "https://debugbundle.local");
    return { path: parsed.pathname || "/", normalized_path: parsed.pathname || "/", title: normalizeTitle(title) };
  } catch {
    const queryIndex = path.indexOf("?");
    const fragmentIndex = path.indexOf("#");
    const end = queryIndex === -1
      ? (fragmentIndex === -1 ? path.length : fragmentIndex)
      : fragmentIndex === -1 ? queryIndex : Math.min(queryIndex, fragmentIndex);
    const normalized = path.slice(0, end).trim();
    if (normalized.length === 0) {
      return null;
    }
    const normalizedPath = normalized.startsWith("/") ? normalized : `/${normalized}`;
    return { path: normalizedPath, normalized_path: normalizedPath, title: normalizeTitle(title) };
  }
}

export function sanitizeAnalyticsCustomDimensions(input: Record<string, unknown>): BrowserAnalyticsCustomDimensions {
  const output: BrowserAnalyticsCustomDimensions = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    if (Object.keys(output).length >= MAX_CUSTOM_DIMENSIONS) {
      break;
    }
    const key = normalizeCustomDimensionKey(rawKey);
    if (key === null || BUILT_IN_DIMENSION_KEYS.has(key)) {
      continue;
    }
    const value = normalizeCustomDimensionValue(key, rawValue);
    if (value !== undefined) {
      output[key] = value;
    }
  }
  return output;
}

export function omitBuiltInAnalyticsDimensions(
  dimensions: BrowserAnalyticsCustomDimensions
): BrowserAnalyticsCustomDimensions {
  const output = { ...dimensions };
  for (const key of BUILT_IN_DIMENSION_KEYS) {
    delete output[key];
  }
  return output;
}

export function buildAnalyticsDimensions(
  device: BrowserDeviceInfo | null,
  trackReferrers: boolean,
  customDimensions: BrowserAnalyticsCustomDimensions
): BrowserAnalyticsDimensions {
  const language = normalizeLocale(device?.language ?? null);
  const locationSource = getLocationSource();
  const params = new URLSearchParams(typeof locationSource?.search === "string" ? locationSource.search.replace(/^\?/, "") : "");
  return {
    auth_state: normalizeAuthState(customDimensions["auth_state"]),
    device_type: device?.device_type ?? "unknown",
    browser_family: normalizeDimensionText(device?.browser.name ?? null, 80),
    browser_major: parseMajorVersion(device?.browser.version ?? null),
    os_family: normalizeDimensionText(device?.os.name ?? null, 80),
    os_major: parseMajorVersion(device?.os.version ?? null),
    language,
    locale: language,
    viewport_bucket: getViewportBucket(device),
    referrer_domain: trackReferrers ? getReferrerDomain() : null,
    utm_source: normalizeDimensionText(params.get("utm_source"), 128),
    utm_medium: normalizeDimensionText(params.get("utm_medium"), 128),
    utm_campaign: normalizeDimensionText(params.get("utm_campaign"), 128),
    country_code: null,
    region_code: null
  };
}

function getOrCreateStoredVisitor(storageKey: string): string | null {
  const storage = getLocalStorageSource();
  if (storage === null) {
    return null;
  }
  try {
    const existing = storage.getItem(storageKey);
    if (typeof existing === "string" && /^[a-f0-9-]{16,128}$/i.test(existing)) {
      return existing;
    }
    const visitorId = createBrowserTraceId();
    if (!/^[a-f0-9-]{16,128}$/i.test(visitorId)) {
      return null;
    }
    storage.setItem(storageKey, visitorId);
    return visitorId;
  } catch {
    return null;
  }
}

async function hashAnalyticsValue(value: string): Promise<string | null> {
  const cryptoSource = getCryptoSource();
  const TextEncoderConstructor = (globalThis as Record<string, unknown>)["TextEncoder"] as
    | (new () => { encode(input: string): Uint8Array })
    | undefined;
  if (typeof cryptoSource?.subtle?.digest !== "function" || TextEncoderConstructor === undefined) {
    return null;
  }
  const digest = await cryptoSource.subtle.digest("SHA-256", new TextEncoderConstructor().encode(value));
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function normalizeSignalKey(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return SIGNAL_KEY_PATTERN.test(trimmed) && trimmed.length <= 120 ? trimmed : null;
}

function normalizeStructuralActionValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized.length <= 32 ? normalized : null;
}

function normalizeTitle(value: string | null): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : null;
}

function normalizeCustomDimensionKey(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CUSTOM_KEY_LENGTH && CUSTOM_KEY_PATTERN.test(trimmed) && !SENSITIVE_KEY_PATTERN.test(trimmed)
    ? trimmed
    : null;
}

function normalizeCustomDimensionValue(key: string, value: unknown): BrowserAnalyticsCustomDimensionValue | undefined {
  if (value === null || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= -1_000_000 && value <= 1_000_000) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_CUSTOM_STRING_LENGTH && !SENSITIVE_KEY_PATTERN.test(trimmed) && !SENSITIVE_KEY_PATTERN.test(key)
    ? trimmed
    : undefined;
}

function normalizeAuthState(value: unknown): BrowserAnalyticsDimensions["auth_state"] {
  return value === "authenticated" || value === "unknown" ? value : "anonymous";
}

function normalizeDimensionText(value: string | null, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, maxLength) : null;
}

function normalizeLocale(value: string | null): string | null {
  const normalized = normalizeDimensionText(value, 35);
  return normalized !== null && /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(normalized) ? normalized : null;
}

function parseMajorVersion(value: string | null): number | null {
  const major = typeof value === "string" ? Number.parseInt(value.split(".")[0] ?? "", 10) : Number.NaN;
  return Number.isFinite(major) && major >= 0 ? major : null;
}

function getViewportBucket(device: BrowserDeviceInfo | null): BrowserAnalyticsDimensions["viewport_bucket"] {
  const width = device?.viewport.width ?? 0;
  return width <= 0 ? "unknown" : width < 640 ? "small" : width < 1024 ? "medium" : "large";
}

function getReferrerDomain(): string | null {
  const referrer = getDocumentSource()?.referrer;
  if (typeof referrer !== "string" || referrer.trim().length === 0) {
    return null;
  }
  try {
    const hostname = new URL(referrer).hostname;
    return hostname.length > 0 && hostname.length <= 255 ? hostname : null;
  } catch {
    return null;
  }
}
