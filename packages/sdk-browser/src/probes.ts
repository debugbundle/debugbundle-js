import { sanitizeTelemetry, type JsonValue } from "@debugbundle/redaction";
import { ResolvedCapturePolicySchema } from "@debugbundle/shared-types";

import { parseRemoteCaptureRulesPayload } from "./capture-rules.js";
import { createInitialRemoteProbeState } from "./capture-helpers.js";
import {
  deriveSdkConfigEndpoint,
  getHistorySource,
  getLocationSource,
  normalizeUnknownRecord,
  parseIngestionProbeDirectives,
  parseRemoteAnalyticsConfigPayload,
  parseRemoteProbeConfigPayload
} from "./runtime.js";
import { validateBrowserTriggerToken } from "./trigger-token.js";
import { browserEvidenceEndpoint } from "./evidence-controller.js";
import { boundedTransportTimeoutMs } from "./fetch-transport.js";
import { readBoundedBrowserJson } from "./response-json.js";
import type {
  ActiveConfig,
  BrowserProbeBufferItem,
  BrowserRemoteAnalyticsConfig,
  BrowserRemoteProbeDirective,
  BrowserRemoteProbeState
} from "./types.js";

const evidencePolicySchema = ResolvedCapturePolicySchema.partial();
/** Legacy config parsing stays permissive. Capability proof additionally
 * requires valid declared policy fields and an HTTP success response. */
function validEvidenceConfig(payload: unknown, status: number): boolean {
  if (status < 200 || status >= 300 || payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  for (const field of ["probes_enabled", "remote_probes_enabled"])
    if (record[field] !== undefined && typeof record[field] !== "boolean") return false;
  if (record["active_probes"] !== undefined && !Array.isArray(record["active_probes"])) return false;
  return record["capture_policy"] == null || evidencePolicySchema.safeParse(record["capture_policy"]).success;
}

interface BrowserProbeControllerHost {
  getConfig(): ActiveConfig | null;
  isDebugRejected(): boolean;
  isSessionSampledIn(): boolean;
  emitProbeEvent(input: {
    label: string;
    data: Record<string, unknown>;
    directive: BrowserRemoteProbeDirective;
  }): void;
  applyRemoteAnalytics(config: BrowserRemoteAnalyticsConfig): void;
  observeEvidence?(payload: unknown, valid?: boolean): void;
}

export class BrowserProbeController {
  private buffers = new Map<string, BrowserProbeBufferItem[]>();
  private remoteState: BrowserRemoteProbeState = createInitialRemoteProbeState();
  private pendingTriggerToken: string | null = null;
  private activeTriggerDirective: BrowserRemoteProbeDirective | null = null;
  private configAbort: AbortController | null = null;

  public constructor(private readonly host: BrowserProbeControllerHost) {}

  public get state(): BrowserRemoteProbeState {
    return this.remoteState;
  }

  public initialize(): Promise<void> {
    this.pendingTriggerToken = consumeTriggerTokenFromLocation();
    return this.refreshRemoteConfig();
  }

  public reset(): void {
    this.configAbort?.abort(); this.configAbort = null;
    this.buffers = new Map<string, BrowserProbeBufferItem[]>();
    this.remoteState = createInitialRemoteProbeState();
    this.pendingTriggerToken = null;
    this.activeTriggerDirective = null;
  }

  public capture(label: string, data: unknown): void {
    const config = this.host.getConfig();
    const normalizedLabel = label.trim();
    if (config === null || normalizedLabel.length === 0) {
      return;
    }

    try {
      const protectedData = sanitizeTelemetry(normalizeProbeInput(data), { additionalKeys: config.redactFields });
      if (!protectedData.ok) return;
      const probeData = normalizeUnknownRecord(protectedData.value);
      this.buffer(normalizedLabel, probeData);

      const matchingDirectives = this.getMatchingDirectives(normalizedLabel, Date.now());
      if (!this.host.isSessionSampledIn()) {
        return;
      }
      for (const directive of matchingDirectives) {
        this.host.emitProbeEvent({ label: normalizedLabel, data: probeData, directive });
      }
    } catch {
      return;
    }
  }

  public consumeBufferedData(): { version: 1; items: BrowserProbeBufferItem[] } {
    const items = Array.from(this.buffers.values()).flatMap((buffer) => buffer);
    this.buffers.clear();
    return { version: 1, items };
  }

  public updateFromIngestionResponse(payload: unknown): void {
    const directives = parseIngestionProbeDirectives(payload, Date.now());
    if (directives !== null) {
      this.remoteState = { ...this.remoteState, directives };
    }
    this.pruneExpiredDirectives(Date.now());
  }

  private buffer(label: string, data: Record<string, unknown>): void {
    const config = this.host.getConfig();
    if (config === null || this.host.isDebugRejected()) {
      return;
    }
    if (!this.buffers.has(label) && this.buffers.size >= config.maxProbeLabels) {
      return;
    }

    const buffer = this.buffers.get(label) ?? [];
    buffer.push({
      label,
      data,
      timestamp: new Date().toISOString(),
      activation_id: null
    });
    while (buffer.length > config.maxProbeEntriesPerLabel) {
      buffer.shift();
    }
    this.buffers.set(label, buffer);
  }

  private async refreshRemoteConfig(): Promise<void> {
    const config = this.host.getConfig();
    if (config === null || config.fetchImpl === null || config.transportMode !== "direct" || config.projectToken === null) {
      return;
    }
    if (typeof AbortController !== "function") return;
    const controller = new AbortController(); this.configAbort = controller;
    const timeout = setTimeout(() => controller.abort(), boundedTransportTimeoutMs(config.requestTimeoutMs));

    try {
      const response = await config.fetchImpl(browserEvidenceEndpoint(deriveSdkConfigEndpoint(config.endpoint)), {
        method: "GET",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${config.projectToken}`,
          ...(config.requestsAnalyticsConfig ? { "x-debugbundle-analytics-config": "1" } : {})
        }
      });
      if (response.status === 304 || typeof response.json !== "function") {
        return;
      }

      // Custom fetch adapters without native streams retain their established
      // JSON/readiness timing; real HTTP bodies use the bounded reader.
      const payload = response.body === undefined ? await response.json() : await readBoundedBrowserJson(response, controller.signal);
      if (controller.signal.aborted) return;
      if (this.host.getConfig() !== config) return;
      if (payload === undefined) { this.host.observeEvidence?.(undefined); return; }
      const analyticsConfig = parseRemoteAnalyticsConfigPayload(payload);
      if (analyticsConfig !== null) {
        this.host.applyRemoteAnalytics(analyticsConfig);
      }
      const parsed = parseRemoteProbeConfigPayload(payload, Date.now());
      if (parsed !== null) {
        this.remoteState = parsed;
        this.pruneExpiredDirectives(Date.now());
        await this.activatePendingTriggerToken();
      }
      if (this.host.getConfig() !== config) return;
      this.host.observeEvidence?.(payload, validEvidenceConfig(payload, response.status));
      config.captureRules = parseRemoteCaptureRulesPayload(payload);
    } catch {
      return;
    } finally { clearTimeout(timeout); if (this.configAbort === controller) this.configAbort = null; }
  }

  private pruneExpiredDirectives(nowMs: number): void {
    const directives = this.remoteState.directives.filter((directive) => Date.parse(directive.expiresAt) > nowMs);
    if (this.activeTriggerDirective !== null && Date.parse(this.activeTriggerDirective.expiresAt) <= nowMs) {
      this.activeTriggerDirective = null;
    }
    if (directives.length !== this.remoteState.directives.length) {
      this.remoteState = { ...this.remoteState, directives };
    }
  }

  private async activatePendingTriggerToken(): Promise<void> {
    if (this.pendingTriggerToken === null) {
      return;
    }
    const directive = await validateBrowserTriggerToken({
      token: this.pendingTriggerToken,
      triggerTokenKey: this.remoteState.triggerTokenKey,
      nowMs: Date.now()
    });
    this.pendingTriggerToken = null;
    this.activeTriggerDirective = directive;
  }

  private getMatchingDirectives(label: string, nowMs: number): BrowserRemoteProbeDirective[] {
    const config = this.host.getConfig();
    if (config === null || !this.remoteState.probesEnabled || !this.remoteState.remoteProbesEnabled) {
      return [];
    }

    this.pruneExpiredDirectives(nowMs);
    const activeDirectives = this.activeTriggerDirective === null
      ? this.remoteState.directives
      : [...this.remoteState.directives, this.activeTriggerDirective];
    return activeDirectives.filter((directive) => {
      if (directive.service !== "*" && directive.service !== config.service) {
        return false;
      }
      if (directive.environment !== "*" && directive.environment !== config.environment) {
        return false;
      }
      return matchesProbeLabelPattern(directive.labelPattern, label);
    });
  }
}

function consumeTriggerTokenFromLocation(): string | null {
  const locationSource = getLocationSource();
  const search = typeof locationSource?.search === "string" ? locationSource.search : "";
  if (search.length === 0) {
    return null;
  }

  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const token = params.get("_debug_probe");
  if (token === null || token.length === 0) {
    return null;
  }

  params.delete("_debug_probe");
  const cleanedPath = `${locationSource?.pathname ?? ""}${params.toString().length > 0 ? `?${params.toString()}` : ""}`;
  getHistorySource()?.replaceState({}, "", cleanedPath);
  return token;
}

export function normalizeProbeInput(data: unknown): Record<string, JsonValue> {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { value: data as JsonValue };
  }
  return data as Record<string, JsonValue>;
}

export function matchesProbeLabelPattern(pattern: string, label: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return label === prefix || label.startsWith(`${prefix}.`);
  }
  return pattern === label;
}
