import { redact, type JsonValue } from "@debugbundle/redaction";

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
import type {
  ActiveConfig,
  BrowserProbeBufferItem,
  BrowserRemoteAnalyticsConfig,
  BrowserRemoteProbeDirective,
  BrowserRemoteProbeState
} from "./types.js";

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
}

export class BrowserProbeController {
  private buffers = new Map<string, BrowserProbeBufferItem[]>();
  private remoteState: BrowserRemoteProbeState = createInitialRemoteProbeState();
  private pendingTriggerToken: string | null = null;
  private activeTriggerDirective: BrowserRemoteProbeDirective | null = null;

  public constructor(private readonly host: BrowserProbeControllerHost) {}

  public get state(): BrowserRemoteProbeState {
    return this.remoteState;
  }

  public initialize(): Promise<void> {
    this.pendingTriggerToken = consumeTriggerTokenFromLocation();
    return this.refreshRemoteConfig();
  }

  public reset(): void {
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
      const redacted = redact(normalizeProbeInput(data), {
        sensitiveKeys: config.redactFields
      }).redacted;
      const probeData = normalizeUnknownRecord(redacted);
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

    try {
      const response = await config.fetchImpl(deriveSdkConfigEndpoint(config.endpoint), {
        method: "GET",
        headers: {
          authorization: `Bearer ${config.projectToken}`,
          ...(config.requestsAnalyticsConfig ? { "x-debugbundle-analytics-config": "1" } : {})
        }
      });
      if (response.status === 304 || typeof response.json !== "function") {
        return;
      }

      const payload = await response.json();
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
      config.captureRules = parseRemoteCaptureRulesPayload(payload);
    } catch {
      return;
    }
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
