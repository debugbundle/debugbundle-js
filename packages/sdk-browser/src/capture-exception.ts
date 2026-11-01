import { createEventEnvelope, type EventEnvelope, type EvidenceDeliveryState } from "@debugbundle/shared-types";
import { normalizeError } from "./runtime.js";
import { snapshotBrowserEvidence } from "./exception-evidence.js";
import { SDK_NAME, SDK_VERSION, SDK_SCHEMA_VERSION, type ActiveConfig, type BrowserBreadcrumb, type BrowserCorrelationFields, type BrowserDeviceInfo, type BrowserProbeBufferItem, type CaptureBrowserExceptionContext } from "./types.js";

export function createBrowserExceptionEvent(input: { error: unknown; context: CaptureBrowserExceptionContext; config: ActiveConfig;
  device: BrowserDeviceInfo | null; breadcrumbs: BrowserBreadcrumb[]; probeData: { version: 1; items: BrowserProbeBufferItem[] };
  route: string | null; correlation: BrowserCorrelationFields; evidence: EvidenceDeliveryState }): EventEnvelope {
  const { error, context, config, device, breadcrumbs, probeData, route, correlation, evidence } = input;
      const normalizedError = normalizeError(error);
      const browser = device?.browser ?? { name: "Unknown", version: "0" };
      const domContext =
        typeof context.target?.outerHTML === "string" && context.target.outerHTML.length > 0
          ? {
              mode: "lightweight" as const,
              html_excerpt: context.target.outerHTML
            }
          : null;

      const graph = evidence.supports("exception_evidence_v1") && config.captureExceptionEvidence !== false ? snapshotBrowserEvidence(error, normalizedError) : undefined;
      const event = createEventEnvelope({
        schema_version: SDK_SCHEMA_VERSION,
        event_type: "frontend_exception",
        ...(config.projectToken === null ? {} : { project_token: config.projectToken }),
        sdk_name: SDK_NAME,
        sdk_version: SDK_VERSION,
        service: {
          name: config.service,
          runtime: "browser",
          framework: null,
          environment: config.environment
        },
        occurred_at: new Date().toISOString(),
        correlation: correlation,
        payload: {
          ...(graph === undefined ? {} : { exception_evidence: graph }),
          name: normalizedError.name,
          message: normalizedError.message,
          stack: normalizedError.stack,
          route: context.route ?? route,
          browser,
          breadcrumbs,
          probe_data: probeData,
          device:
            device === null
              ? null
              : {
                  user_agent: device.user_agent,
                  os: device.os,
                  device_type: device.device_type,
                  screen: device.screen,
                  viewport: device.viewport,
                  device_pixel_ratio: device.device_pixel_ratio,
                  touch_capable: device.touch_capable,
                  language: device.language,
                  connection_type: device.connection_type,
                  color_scheme_preference: device.color_scheme_preference
                },
          dom_context: domContext
        }
      });

      if (context.browser_event !== undefined) {
        (event.payload as Record<string, unknown>)["browser_event"] = context.browser_event;
      }
      if (context.rejection_reason !== undefined) {
        (event.payload as Record<string, unknown>)["rejection_reason"] = context.rejection_reason;
      }

  return event;
}
