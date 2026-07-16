import type { EventEnvelope } from "@debugbundle/shared-types";

import { evaluateBrowserCaptureRulesForEvent } from "./capture-rules.js";
import type { ActiveConfig, BrowserBreadcrumb, BrowserCaptureRuleEvaluationResult } from "./types.js";

export function applyBrowserCaptureRules(input: {
  config: ActiveConfig | null;
  event: EventEnvelope;
  currentRoute: string | null;
  now: string;
}): { event: EventEnvelope | null; breadcrumb: BrowserBreadcrumb | null } {
  const { config, event } = input;
  if (config === null || config.captureRules.length === 0) {
    return { event, breadcrumb: null };
  }

  const projectId = config.captureRules[0]?.project_id;
  if (typeof projectId !== "string" || projectId.length === 0) {
    return { event, breadcrumb: null };
  }

  try {
    const captureRule = evaluateBrowserCaptureRulesForEvent(
      config.captureRules,
      projectId,
      event,
      input.now
    );
    if (captureRule === null) {
      return { event, breadcrumb: null };
    }
    if (captureRule.outcome === "drop" || captureRule.outcome === "sampled_out") {
      return { event: null, breadcrumb: null };
    }
    if (
      event.event_type === "frontend_exception" &&
      (captureRule.outcome === "demote" || captureRule.sample_event_class === "context")
    ) {
      return {
        event: null,
        breadcrumb: createDemotedExceptionBreadcrumb(event, captureRule, input.currentRoute)
      };
    }
    if (
      event.event_type === "request_event" &&
      (captureRule.outcome === "demote" || captureRule.sample_event_class === "context")
    ) {
      return { event: null, breadcrumb: null };
    }
  } catch {
    return { event, breadcrumb: null };
  }

  return { event, breadcrumb: null };
}

export function buildBrowserSuppressionKey(event: EventEnvelope): string | null {
  if (event.event_type === "frontend_exception") {
    const stackFrame = event.payload.stack.split("\n")[1]?.trim() ?? null;
    return JSON.stringify({
      event_type: event.event_type,
      name: event.payload.name,
      message: event.payload.message,
      stack_frame: stackFrame,
      route: event.payload.route
    });
  }
  if (event.event_type === "log_event") {
    return JSON.stringify({
      event_type: event.event_type,
      level: event.payload.level,
      message: event.payload.message,
      attributes: event.payload.attributes
    });
  }
  if (event.event_type === "request_event") {
    return JSON.stringify({
      event_type: event.event_type,
      method: event.payload.method,
      path: event.payload.path,
      response_status: event.payload.response_status
    });
  }
  return null;
}

function createDemotedExceptionBreadcrumb(
  event: Extract<EventEnvelope, { event_type: "frontend_exception" }>,
  captureRule: BrowserCaptureRuleEvaluationResult,
  currentRoute: string | null
): BrowserBreadcrumb {
  const payload = event.payload as Record<string, unknown>;
  const browserEventRecord = typeof payload["browser_event"] === "object" && payload["browser_event"] !== null
    ? payload["browser_event"] as Record<string, unknown>
    : null;
  const targetRecord = typeof browserEventRecord?.["target"] === "object" && browserEventRecord["target"] !== null
    ? browserEventRecord["target"] as Record<string, unknown>
    : null;
  const browserEventKind = browserEventRecord?.["kind"] === "window_error" || browserEventRecord?.["kind"] === "resource_error"
    ? browserEventRecord["kind"]
    : undefined;
  const sourceUrl = typeof targetRecord?.["source_url"] === "string"
    ? targetRecord["source_url"]
    : typeof browserEventRecord?.["file_name"] === "string"
      ? browserEventRecord["file_name"]
      : null;

  return {
    ts: event.occurred_at,
    breadcrumb_type: "console_log",
    route: event.payload.route ?? currentRoute,
    data: {
      level: "error",
      message: `${event.payload.name}: ${event.payload.message}`,
      source: "capture_rule_demoted_exception",
      capture_rule_action: captureRule.action,
      capture_rule_outcome: captureRule.outcome,
      ...(browserEventKind === undefined ? {} : { browser_event_kind: browserEventKind }),
      ...(sourceUrl === null ? {} : { source_url: sourceUrl })
    }
  };
}
