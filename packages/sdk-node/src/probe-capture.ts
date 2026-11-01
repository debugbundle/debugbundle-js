import { createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { buildNodeCorrelation, buildNodeServiceDescriptor } from "./event-support.js";
import { redactObject } from "./utils.js";
import { SDK_NAME, SDK_VERSION, SDK_SCHEMA_VERSION, type ActiveConfig, type CaptureRequestInput, type ProbeOptions, type ProbeBufferItem, type RemoteProbeDirective } from "./types.js";

export function captureNodeProbe(input: { config: ActiveConfig; label: string; data: unknown; options: ProbeOptions;
  buffers: Map<string, ProbeBufferItem[]>; directives: RemoteProbeDirective[]; request: CaptureRequestInput | undefined; fields: Record<string, unknown>;
  current(): boolean; enqueue(event: EventEnvelope): unknown }): void {
  const { config, label, data, options } = input;
      const matchingDirectives = input.directives;
      if (options.heavy === true && matchingDirectives.length === 0) {
        return;
      }

      const resolved = typeof data === "function" ? (data as () => unknown)() : data;
      if (!input.current()) return;
      const redacted = redactObject(resolved, config.redactFields);

      if (options.heavy !== true) {
        if (!input.buffers.has(label) && input.buffers.size >= config.maxProbeLabels) {
          return;
        }

        const buffer = input.buffers.get(label) ?? [];
        buffer.push({
          label,
          data: redacted,
          timestamp: new Date().toISOString(),
          activation_id: null
        });

        while (buffer.length > config.maxProbeEntriesPerLabel) {
          buffer.shift();
        }

        input.buffers.set(label, buffer);
      }

      for (const directive of matchingDirectives) {
        input.enqueue(
          createEventEnvelope({
            schema_version: SDK_SCHEMA_VERSION,
            event_type: "probe_event",
            project_token: config.projectToken,
            sdk_name: SDK_NAME,
            sdk_version: SDK_VERSION,
            service: buildNodeServiceDescriptor(config),
            occurred_at: new Date().toISOString(),
            correlation: buildNodeCorrelation(
              undefined,
              input.request,
              input.fields
            ),
            payload: {
              label,
              data: redacted,
              activation_id: directive.id,
              probe_label_pattern: directive.labelPattern
            }
          })
        );
      }
}
