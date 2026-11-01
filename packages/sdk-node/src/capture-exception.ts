import { createEventEnvelope, type EventEnvelope, type EvidenceDeliveryState, type ExecutionContext, type EvidenceScope } from "@debugbundle/shared-types";
import { nodeEvidenceReference } from "./diagnostic-capture.js";
import { buildNodeCorrelation, buildNodeRequestSnapshot, buildNodeResponseSnapshot, buildNodeServiceDescriptor, consumeNodeProbeData } from "./event-support.js";
import { snapshotNodeException } from "./exception-evidence.js";
import { detectProcessRuntimeFacts } from "./utils.js";
import { SDK_NAME, SDK_VERSION, SDK_SCHEMA_VERSION, type ActiveConfig, type CaptureExceptionContext, type CaptureRequestInput, type ProbeBufferItem } from "./types.js";

export function createNodeExceptionEvent(input: { error: unknown; context: CaptureExceptionContext; config: ActiveConfig;
  request: CaptureRequestInput | undefined; fields: Record<string, unknown>; probeBuffers: Map<string, ProbeBufferItem[]>;
  evidence: EvidenceDeliveryState; fatal: boolean; execution?: ExecutionContext; defaultScope?: EvidenceScope }): EventEnvelope {
  const { config, context } = input;
  const reference = input.evidence.supports("recovery_v1") ? nodeEvidenceReference(context, input.defaultScope) : null;
  const execution = input.execution === undefined || config.captureExceptionEvidence === false || !input.evidence.supports("exception_evidence_v1") ? undefined : input.execution;
  const otherBytes = Buffer.byteLength(JSON.stringify({ execution, evidence_reference: reference ?? undefined }), "utf8");
  const snapshot = snapshotNodeException(input.error, config.captureExceptionEvidence !== false && input.evidence.supports("exception_evidence_v1"),
    { fatal: input.fatal, budgetBytes: (input.fatal ? 4096 : 32 * 1024) - otherBytes - 64 });
  const request = buildNodeRequestSnapshot(context.request, config.redactFields), response = buildNodeResponseSnapshot(context.response, config.redactFields);
  const probeData = config.probeFlushOnError ? consumeNodeProbeData(input.probeBuffers) : null, runtime = detectProcessRuntimeFacts();
  const event = createEventEnvelope({ schema_version: SDK_SCHEMA_VERSION, event_type: "backend_exception", project_token: config.projectToken,
    sdk_name: SDK_NAME, sdk_version: SDK_VERSION, service: buildNodeServiceDescriptor(config), occurred_at: new Date().toISOString(),
    correlation: buildNodeCorrelation(context.correlation, context.request ?? input.request, input.fields),
    payload: { name: snapshot.legacy.name, message: snapshot.legacy.message, stack: snapshot.legacy.stack, handled: context.handled ?? false,
      request, response, runtime: { version: runtime.version }, ...(snapshot.evidence === undefined ? {} : { exception_evidence: snapshot.evidence }),
      ...(probeData === null ? {} : { probe_data: probeData }),
      ...(execution === undefined ? {} : { execution }) },
    ...(!snapshot.evidence_omitted && reference === null ? {} : { context: { ...(reference === null ? {} : { evidence_reference: reference }),
      ...(snapshot.evidence_omitted ? { evidence_limits: { version: 1, exception_evidence: snapshot.evidence_omitted } } : {}) } }) });
  if (event.event_type === "backend_exception") event.payload.runtime = runtime;
  return event;
}
