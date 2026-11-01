import { createEventEnvelope, type DiagnosticContextPayload, type EventEnvelope } from "@debugbundle/shared-types";
import { SDK_NAME, SDK_SCHEMA_VERSION, SDK_VERSION, type ActiveConfig, type BrowserCorrelationFields } from "./types.js";

export function createBrowserDiagnosticEvent(config: ActiveConfig, payload: DiagnosticContextPayload,
  correlation: EventEnvelope["correlation"] | BrowserCorrelationFields, service?: EventEnvelope["service"]): EventEnvelope {
  const event = createEventEnvelope({ schema_version: SDK_SCHEMA_VERSION, event_type: "diagnostic_context",
    ...(config.projectToken === null ? {} : { project_token: config.projectToken }), sdk_name: SDK_NAME, sdk_version: SDK_VERSION,
    service: service ?? { name: config.service, runtime: "browser", framework: null, environment: config.environment },
    occurred_at: new Date().toISOString(), correlation, payload });
  if (config.projectToken === null) delete event.project_token;
  return event;
}
