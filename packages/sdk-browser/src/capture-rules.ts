import type {
  BrowserCaptureRule,
  BrowserCaptureRuleAction,
  BrowserCaptureRuleEvaluationResult,
  BrowserCaptureRuleMatcher,
  BrowserCaptureRuleRuntime,
  BrowserCaptureRuleSampleEventClass,
  BrowserCaptureRuleUrlMatcher,
  EventEnvelope
} from "./types.js";

type BrowserCaptureRuleEvaluationUrl = {
  host?: string;
  path: string;
};

type BrowserCaptureRuleEvaluationContext = {
  project_id: string;
  event_id: string;
  event_type: EventEnvelope["event_type"];
  service?: string;
  environment?: string;
  runtime: BrowserCaptureRuleRuntime;
  first_party?: boolean;
  error_name?: string;
  message?: string;
  browser_event_kind?: "window_error" | "resource_error";
  browser_event_opaque?: boolean;
  client_kind?: "human" | "bot" | "unknown";
  bot_family?: string;
  resource_url?: BrowserCaptureRuleEvaluationUrl;
  request_url?: BrowserCaptureRuleEvaluationUrl;
  status_code?: number;
  fingerprint?: {
    version: string;
    value: string;
  };
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRuntime(value: string | null | undefined): BrowserCaptureRuleRuntime {
  switch (value?.trim().toLowerCase()) {
    case "browser":
      return "browser";
    case "node":
    case "nodejs":
      return "node";
    case "python":
      return "python";
    case "php":
      return "php";
    case "java":
      return "java";
    case "go":
    case "golang":
      return "go";
    case "ruby":
      return "ruby";
    default:
      return "unknown";
  }
}

function normalizePath(value: string): string {
  const path = value.split(/[?#]/, 1)[0] ?? "";
  if (path.length === 0) {
    return "/";
  }

  return path.startsWith("/") ? path : `/${path}`;
}

function normalizeEvaluationUrl(value: string | null | undefined): {
  url?: BrowserCaptureRuleEvaluationUrl;
  first_party?: boolean;
} {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) {
    return {};
  }

  if (trimmed.startsWith("/")) {
    return {
      url: { path: normalizePath(trimmed) },
      first_party: true
    };
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return {
        url: {
          ...(parsed.hostname.length > 0 ? { host: parsed.hostname.toLowerCase() } : {}),
          path: normalizePath(parsed.pathname)
        },
        first_party: false
      };
    }
  } catch {
    return {};
  }

  return {};
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .map((entry) => asString(entry))
    .filter((entry): entry is string => entry !== null);

  return values.length > 0 ? Array.from(new Set(values)) : undefined;
}

function parseNumberArray(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const values = value
    .map((entry) => asInteger(entry))
    .filter((entry): entry is number => entry !== null);

  return values.length > 0 ? Array.from(new Set(values)).sort((left, right) => left - right) : undefined;
}

function parseStatusRanges(value: unknown): Array<{ start: number; end: number }> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ranges = value
    .map((entry) => {
      const record = asRecord(entry);
      const start = asInteger(record?.["start"]);
      const end = asInteger(record?.["end"]);
      if (start === null || end === null || start > end) {
        return null;
      }

      return { start, end };
    })
    .filter((entry): entry is { start: number; end: number } => entry !== null);

  return ranges.length > 0 ? ranges : undefined;
}

function parseUrlMatcher(value: unknown): BrowserCaptureRuleUrlMatcher | undefined {
  const record = asRecord(value);
  if (record === null) {
    return undefined;
  }

  const host = asString(record["host"])?.toLowerCase();
  const hostSuffix = asString(record["host_suffix"])?.toLowerCase();
  const pathPrefix = asString(record["path_prefix"]);
  const pathEquals = asString(record["path_equals"]);

  if (host === undefined && hostSuffix === undefined && pathPrefix === undefined && pathEquals === undefined) {
    return undefined;
  }

  return {
    ...(host === undefined ? {} : { host }),
    ...(hostSuffix === undefined ? {} : { host_suffix: hostSuffix }),
    ...(pathPrefix === null ? {} : { path_prefix: normalizePath(pathPrefix) }),
    ...(pathEquals === null ? {} : { path_equals: normalizePath(pathEquals) })
  };
}

function parseMatcher(value: unknown): BrowserCaptureRuleMatcher | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const eventTypes = parseStringArray(record["event_types"]) as EventEnvelope["event_type"][] | undefined;
  const services = parseStringArray(record["services"]);
  const environments = parseStringArray(record["environments"]);
  const runtimeValues = parseStringArray(record["runtime"]);
  const firstParty = asBoolean(record["first_party"]);
  const errorName = asString(record["error_name"]);
  const messageContains = asString(record["message_contains"]);
  const messageEquals = asString(record["message_equals"]);
  const browserEventOpaque = asBoolean(record["browser_event_opaque"]);
  const clientKind =
    record["client_kind"] === "human" || record["client_kind"] === "bot" || record["client_kind"] === "unknown"
      ? record["client_kind"]
      : null;
  const botFamily = asString(record["bot_family"]);
  const resourceUrl = parseUrlMatcher(record["resource_url"]);
  const requestUrl = parseUrlMatcher(record["request_url"]);
  const statusCodes = parseNumberArray(record["status_codes"]);
  const statusRanges = parseStatusRanges(record["status_ranges"]);

  const matcher: BrowserCaptureRuleMatcher = {
    ...(eventTypes === undefined ? {} : { event_types: eventTypes }),
    ...(services === undefined ? {} : { services }),
    ...(environments === undefined ? {} : { environments }),
    ...(runtimeValues === undefined ? {} : { runtime: runtimeValues.map((entry) => normalizeRuntime(entry)) }),
    ...(firstParty === null ? {} : { first_party: firstParty }),
    ...(errorName === null ? {} : { error_name: errorName }),
    ...(messageContains === null ? {} : { message_contains: messageContains }),
    ...(messageEquals === null ? {} : { message_equals: messageEquals }),
    ...(record["browser_event_kind"] === "window_error" || record["browser_event_kind"] === "resource_error"
      ? { browser_event_kind: record["browser_event_kind"] }
      : {}),
    ...(browserEventOpaque === null ? {} : { browser_event_opaque: browserEventOpaque }),
    ...(clientKind === null ? {} : { client_kind: clientKind }),
    ...(botFamily === null ? {} : { bot_family: botFamily }),
    ...(resourceUrl === undefined ? {} : { resource_url: resourceUrl }),
    ...(requestUrl === undefined ? {} : { request_url: requestUrl }),
    ...(statusCodes === undefined ? {} : { status_codes: statusCodes }),
    ...(statusRanges === undefined ? {} : { status_ranges: statusRanges })
  };

  const fingerprintRecord = asRecord(record["fingerprint"]);
  const fingerprintVersion = asString(fingerprintRecord?.["version"]);
  const fingerprintValue = asString(fingerprintRecord?.["value"]);
  if (fingerprintVersion !== null && fingerprintValue !== null) {
    matcher.fingerprint = {
      version: fingerprintVersion,
      value: fingerprintValue
    };
  }

  const narrowingKeys = [
    matcher.services,
    matcher.environments,
    matcher.runtime,
    matcher.first_party,
    matcher.error_name,
    matcher.message_contains,
    matcher.message_equals,
    matcher.browser_event_kind,
    matcher.browser_event_opaque,
    matcher.client_kind,
    matcher.bot_family,
    matcher.resource_url,
    matcher.request_url,
    matcher.status_codes,
    matcher.status_ranges,
    matcher.fingerprint
  ];

  if (!narrowingKeys.some((entry) => entry !== undefined)) {
    return null;
  }

  if (
    matcher.browser_event_kind === "resource_error" &&
    matcher.resource_url === undefined &&
    matcher.fingerprint === undefined
  ) {
    return null;
  }

  return matcher;
}

function classifyClientFromUserAgent(userAgent: string | null): {
  client_kind: "human" | "bot" | "unknown";
  bot_family?: string;
} {
  if (userAgent === null) {
    return { client_kind: "unknown" };
  }

  const lower = userAgent.toLowerCase();
  const knownBots: Array<{ family: string; markers: readonly string[] }> = [
    { family: "Googlebot", markers: ["googlebot", "adsbot-google", "google-inspectiontool"] },
    { family: "Bingbot", markers: ["bingbot", "msnbot"] },
    { family: "DuckDuckBot", markers: ["duckduckbot"] },
    { family: "Applebot", markers: ["applebot"] },
    { family: "YandexBot", markers: ["yandexbot"] },
    { family: "Baiduspider", markers: ["baiduspider"] },
    { family: "FacebookBot", markers: ["facebookexternalhit", "facebot"] },
    { family: "LinkedInBot", markers: ["linkedinbot"] },
    { family: "TwitterBot", markers: ["twitterbot"] },
    { family: "Slackbot", markers: ["slackbot"] }
  ];
  const knownBot = knownBots.find((entry) => entry.markers.some((marker) => lower.includes(marker)));
  if (knownBot !== undefined) {
    return { client_kind: "bot", bot_family: knownBot.family };
  }
  if (/\b(bot|crawler|spider|slurp)\b/.test(lower)) {
    return { client_kind: "bot", bot_family: "OtherBot" };
  }

  return { client_kind: "human" };
}

function readDeviceUserAgent(payload: unknown): string | null {
  const record = asRecord(payload);
  const device = asRecord(record?.["device"]);
  return asString(device?.["user_agent"]);
}

function parseCaptureRule(value: unknown): BrowserCaptureRule | null {
  const record = asRecord(value);
  if (record === null) {
    return null;
  }

  const id = asString(record["id"]);
  const projectId = asString(record["project_id"]);
  const name = asString(record["name"]);
  const actionValue = record["action"];
  const matcher = parseMatcher(record["matcher"]);
  const enabled = asBoolean(record["enabled"]);
  const updatedAt = asString(record["updated_at"]);
  const createdAt = asString(record["created_at"]);
  const action: BrowserCaptureRuleAction | null =
    actionValue === "demote" || actionValue === "sample" || actionValue === "drop"
      ? actionValue
      : null;

  if (id === null || projectId === null || name === null || action === null || matcher === null || enabled === null || updatedAt === null || createdAt === null) {
    return null;
  }

  const sampleRate = record["sample_rate"] === null ? null : asNumber(record["sample_rate"]);
  const sampleEventClass: BrowserCaptureRuleSampleEventClass | null =
    record["sample_event_class"] === "preserve" || record["sample_event_class"] === "context"
      ? record["sample_event_class"]
      : record["sample_event_class"] === null || record["sample_event_class"] === undefined
        ? null
        : null;

  if (action === "sample" && (sampleRate === null || sampleEventClass === null)) {
    return null;
  }

  if (action !== "sample" && (sampleRate !== null || sampleEventClass !== null)) {
    return null;
  }

  return {
    id,
    project_id: projectId,
    name,
    description: record["description"] === null ? null : asString(record["description"]),
    enabled,
    action,
    matcher,
    sample_rate: sampleRate,
    sample_event_class: sampleEventClass,
    created_by_user_id: record["created_by_user_id"] === null ? null : asString(record["created_by_user_id"]),
    created_from_incident_id: record["created_from_incident_id"] === null ? null : asString(record["created_from_incident_id"]),
    created_from_event_id: record["created_from_event_id"] === null ? null : asString(record["created_from_event_id"]),
    expires_at: record["expires_at"] === null ? null : asString(record["expires_at"]),
    hit_count: asInteger(record["hit_count"]) ?? 0,
    last_matched_at: record["last_matched_at"] === null ? null : asString(record["last_matched_at"]),
    created_at: createdAt,
    updated_at: updatedAt
  };
}

export function parseRemoteCaptureRulesPayload(payload: unknown): BrowserCaptureRule[] {
  const record = asRecord(payload);
  if (record === null || !Array.isArray(record["capture_rules"])) {
    return [];
  }

  return record["capture_rules"]
    .map((candidate) => parseCaptureRule(candidate))
    .filter((rule): rule is BrowserCaptureRule => rule !== null);
}

function buildEvaluationContext(projectId: string, event: EventEnvelope): BrowserCaptureRuleEvaluationContext {
  const base: BrowserCaptureRuleEvaluationContext = {
    project_id: projectId,
    event_id: event.event_id,
    event_type: event.event_type,
    service: event.service.name,
    environment: event.service.environment,
    runtime: normalizeRuntime(event.service.runtime)
  };
  const client = classifyClientFromUserAgent(readDeviceUserAgent(event.payload));
  const baseWithClient: BrowserCaptureRuleEvaluationContext = {
    ...base,
    ...client
  };

  if (event.event_type === "frontend_exception") {
    const payload = event.payload as Record<string, unknown>;
    const browserEvent =
      typeof payload["browser_event"] === "object" && payload["browser_event"] !== null
        ? (payload["browser_event"] as Record<string, unknown>)
        : null;
    const target =
      typeof browserEvent?.["target"] === "object" && browserEvent["target"] !== null
        ? (browserEvent["target"] as Record<string, unknown>)
        : null;
    const sourceUrl =
      typeof target?.["source_url"] === "string"
        ? target["source_url"]
        : typeof browserEvent?.["file_name"] === "string"
          ? browserEvent["file_name"]
          : null;
    const browserEventKind =
      browserEvent?.["kind"] === "window_error" || browserEvent?.["kind"] === "resource_error"
        ? browserEvent["kind"]
        : undefined;
    const resourceUrl = normalizeEvaluationUrl(sourceUrl);
    return {
      ...baseWithClient,
      ...(resourceUrl.first_party === undefined ? {} : { first_party: resourceUrl.first_party }),
      error_name: event.payload.name,
      message: event.payload.message,
      ...(browserEventKind === undefined ? {} : { browser_event_kind: browserEventKind }),
      ...(typeof browserEvent?.["opaque"] === "boolean" ? { browser_event_opaque: browserEvent["opaque"] } : {}),
      ...(resourceUrl.url === undefined ? {} : { resource_url: resourceUrl.url })
    };
  }

  if (event.event_type === "request_event") {
    const requestUrl = normalizeEvaluationUrl(event.payload.path);
    return {
      ...baseWithClient,
      first_party: requestUrl.first_party ?? true,
      ...(requestUrl.url === undefined ? {} : { request_url: requestUrl.url }),
      status_code: event.payload.response_status
    };
  }

  if (event.event_type === "frontend_breadcrumb" && event.payload.breadcrumb_type === "network_request") {
    const rawUrl = typeof event.payload.data["url"] === "string" ? event.payload.data["url"] : null;
    const requestUrl = normalizeEvaluationUrl(rawUrl);
    const statusCode = typeof event.payload.data["status_code"] === "number" ? event.payload.data["status_code"] : undefined;
    return {
      ...baseWithClient,
      ...(requestUrl.first_party === undefined ? {} : { first_party: requestUrl.first_party }),
      ...(requestUrl.url === undefined ? {} : { request_url: requestUrl.url }),
      ...(statusCode === undefined ? {} : { status_code: statusCode })
    };
  }

  if (event.event_type === "log_event") {
    return {
      ...baseWithClient,
      message: event.payload.message
    };
  }

  return baseWithClient;
}

function matchesUrlMatcher(
  matcher: BrowserCaptureRuleUrlMatcher | undefined,
  value: BrowserCaptureRuleEvaluationUrl | undefined
): boolean {
  if (matcher === undefined) {
    return true;
  }

  if (value === undefined) {
    return false;
  }

  if (matcher.host !== undefined && value.host !== matcher.host) {
    return false;
  }

  if (matcher.host_suffix !== undefined && (value.host === undefined || !value.host.endsWith(matcher.host_suffix))) {
    return false;
  }

  if (matcher.path_equals !== undefined && value.path !== matcher.path_equals) {
    return false;
  }

  if (matcher.path_prefix !== undefined && !value.path.startsWith(matcher.path_prefix)) {
    return false;
  }

  return true;
}

function matchesRule(rule: BrowserCaptureRule, context: BrowserCaptureRuleEvaluationContext): boolean {
  const matcher = rule.matcher;

  if (matcher.event_types !== undefined && !matcher.event_types.includes(context.event_type)) {
    return false;
  }
  if (matcher.services !== undefined && (context.service === undefined || !matcher.services.includes(context.service))) {
    return false;
  }
  if (matcher.environments !== undefined && (context.environment === undefined || !matcher.environments.includes(context.environment))) {
    return false;
  }
  if (matcher.runtime !== undefined && !matcher.runtime.includes(context.runtime)) {
    return false;
  }
  if (matcher.first_party !== undefined && matcher.first_party !== context.first_party) {
    return false;
  }
  if (matcher.error_name !== undefined && matcher.error_name !== context.error_name) {
    return false;
  }
  if (matcher.message_equals !== undefined && matcher.message_equals !== context.message) {
    return false;
  }
  if (matcher.message_contains !== undefined && (context.message === undefined || !context.message.includes(matcher.message_contains))) {
    return false;
  }
  if (matcher.browser_event_kind !== undefined && matcher.browser_event_kind !== context.browser_event_kind) {
    return false;
  }
  if (matcher.browser_event_opaque !== undefined && matcher.browser_event_opaque !== context.browser_event_opaque) {
    return false;
  }
  if (matcher.client_kind !== undefined && matcher.client_kind !== context.client_kind) {
    return false;
  }
  if (matcher.bot_family !== undefined && matcher.bot_family !== context.bot_family) {
    return false;
  }
  if (!matchesUrlMatcher(matcher.resource_url, context.resource_url)) {
    return false;
  }
  if (!matchesUrlMatcher(matcher.request_url, context.request_url)) {
    return false;
  }
  if (matcher.status_codes !== undefined && (context.status_code === undefined || !matcher.status_codes.includes(context.status_code))) {
    return false;
  }
  if (
    matcher.status_ranges !== undefined &&
    (
      context.status_code === undefined ||
      !matcher.status_ranges.some((range) => {
        const statusCode = context.status_code;
        return statusCode !== undefined && statusCode >= range.start && statusCode <= range.end;
      })
    )
  ) {
    return false;
  }
  if (
    matcher.fingerprint !== undefined &&
    (
      context.fingerprint === undefined ||
      context.fingerprint.version !== matcher.fingerprint.version ||
      context.fingerprint.value !== matcher.fingerprint.value
    )
  ) {
    return false;
  }

  return true;
}

function getSpecificityScore(rule: BrowserCaptureRule): number {
  const matcher = rule.matcher;
  let score = 0;

  if (matcher.fingerprint !== undefined) {
    score += 1000;
  }
  if (matcher.resource_url?.host !== undefined) {
    score += 250;
  }
  if (matcher.request_url?.host !== undefined) {
    score += 250;
  }
  if (matcher.resource_url?.path_equals !== undefined || matcher.request_url?.path_equals !== undefined) {
    score += 200;
  }
  if (matcher.status_codes !== undefined) {
    score += 150;
  }
  if (matcher.browser_event_kind !== undefined) {
    score += 100;
  }
  if (matcher.browser_event_opaque !== undefined) {
    score += 100;
  }
  if (matcher.resource_url?.host_suffix !== undefined || matcher.request_url?.host_suffix !== undefined) {
    score += 90;
  }
  if (matcher.resource_url?.path_prefix !== undefined || matcher.request_url?.path_prefix !== undefined) {
    score += 80;
  }
  if (matcher.error_name !== undefined) {
    score += 70;
  }
  if (matcher.message_equals !== undefined) {
    score += 60;
  }
  if (matcher.message_contains !== undefined) {
    score += 50;
  }
  if (matcher.bot_family !== undefined) {
    score += 45;
  }
  if (matcher.first_party !== undefined) {
    score += 40;
  }
  if (matcher.client_kind !== undefined) {
    score += 35;
  }
  if (matcher.services !== undefined) {
    score += 30;
  }
  if (matcher.environments !== undefined) {
    score += 20;
  }
  if (matcher.runtime !== undefined) {
    score += 10;
  }
  if (matcher.event_types !== undefined) {
    score += 5;
  }

  return score;
}

function compareRules(left: BrowserCaptureRule, right: BrowserCaptureRule): number {
  const specificityDifference = getSpecificityScore(right) - getSpecificityScore(left);
  if (specificityDifference !== 0) {
    return specificityDifference;
  }

  const updatedDifference = Date.parse(right.updated_at) - Date.parse(left.updated_at);
  if (updatedDifference !== 0) {
    return updatedDifference;
  }

  return left.id.localeCompare(right.id);
}

function stableUnitFloat(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) / 0x100000000;
}

function shouldSample(projectId: string, ruleId: string, eventId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) {
    return false;
  }

  if (sampleRate >= 1) {
    return true;
  }

  return stableUnitFloat(`${projectId}:${ruleId}:${eventId}`) < sampleRate;
}

export function evaluateBrowserCaptureRulesForEvent(
  rules: readonly BrowserCaptureRule[],
  projectId: string,
  event: EventEnvelope,
  now: string
): BrowserCaptureRuleEvaluationResult | null {
  const context = buildEvaluationContext(projectId, event);
  const activeRules = rules
    .filter((rule) => rule.enabled && (rule.expires_at === null || Date.parse(rule.expires_at) > Date.parse(now)))
    .sort(compareRules);

  for (const rule of activeRules) {
    if (!matchesRule(rule, context)) {
      continue;
    }

    if (rule.action === "demote") {
      return {
        rule_id: rule.id,
        action: "demote",
        outcome: "demote",
        sample_rate: null,
        sample_event_class: null
      };
    }

    if (rule.action === "drop") {
      return {
        rule_id: rule.id,
        action: "drop",
        outcome: "drop",
        sample_rate: null,
        sample_event_class: null
      };
    }

    const sampledIn = shouldSample(projectId, rule.id, event.event_id, rule.sample_rate ?? 0);
    return {
      rule_id: rule.id,
      action: "sample",
      outcome: sampledIn ? "sampled_in" : "sampled_out",
      sample_rate: rule.sample_rate,
      sample_event_class: rule.sample_event_class
    };
  }

  return null;
}
