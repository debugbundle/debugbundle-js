import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createSemanticAnalyticsNodeDelivery } from "../../../packages/sdk-node/src/index.js";

const projectId = "11111111-1111-4111-8111-111111111111";
const writerToken = `dbundle_anl_${"A".repeat(43)}`;
const endpoint = "https://analytics.example.invalid/api";
const sha = (value: string): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;

function grant(revision: number | null) {
  const now = Date.now();
  return { analytics_semantic: {
    protocol: "2026-09-analytics-capabilities-01", project_id: projectId,
    principal: "server_writer", server_time: new Date(now).toISOString(),
    expires_at: new Date(now + 60_000).toISOString(), enabled: true, unavailable_reason: null,
    schema_version: "2026-09-analytics-02", scope: { kind: "project", project_id: projectId },
    scope_revision: 1, catalog_revision: 1, namespace_revision: revision,
    identity_scope: revision === null ? null : { kind: "project", project_id: projectId },
    known_identity_allowed: revision !== null, allowed_producers: ["server"],
    allowed_purposes: ["business_measurement"], consent_required: false, privacy_mode: "custom",
    sample_rate: 1, max_event_bytes: 16_384, max_batch_events: 256, max_batch_bytes: 262_144,
    max_properties: 20, detailed_retention_days: 90, max_event_age_seconds: 604_800,
    correction_seconds: 172_800, receipt_retention_days: 90, retry_after_max_ms: 300_000
  } };
}

describe("Node semantic server namespace", () => {
  it("prepares protected per-fact identity offline and sends only under a matching fresh grant", async () => {
    const sent: unknown[] = [];
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (path.endsWith("/v1/sdk/config"))
        return new Response(JSON.stringify(grant(2)), { status: 200 });
      const body = JSON.parse(init?.body as string) as { events: Array<{ event_id: string; operation_id: string }> };
      sent.push(...body.events);
      return new Response(JSON.stringify({
        protocol: "2026-09-analytics-delivery-01", project_id: projectId,
        submitted: 1, accepted: 1, rejected: 0, errors: [],
        accepted_events: [{
          index: 0, event_id: body.events[0]!.event_id,
          operation_id: body.events[0]!.operation_id,
          content_hash: sha("protected"), accepted_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 86_400_000).toISOString(), duplicate: false
        }]
      }), { status: 200 });
    });
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, enabled: true, fetchImpl
    });
    const result = await writer.prepare("account.created", { signup_method: "email" }, {
      eventRevision: 1, operationId: sha("operation"),
      identity: { namespaceRevision: 2, userIdHash: sha("user") }
    });
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;
    expect(JSON.parse(result.record.event_json)).toMatchObject({
      correlation: { namespace_revision: 2, user_id_hash: sha("user") },
      payload: { privacy: { mode: "custom" } }
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await writer.deliver([result.record])).status).toBe("received");
    expect(sent).toHaveLength(1);
  });

  it("fences prepared known identity after namespace rotation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(grant(3)), { status: 200 }));
    const writer = createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, endpoint, enabled: true, fetchImpl
    });
    const result = await writer.prepare("account.created", {}, {
      eventRevision: 1, operationId: sha("operation"),
      identity: { namespaceRevision: 2, userIdHash: sha("user") }
    });
    expect(result.status).toBe("prepared");
    if (result.status !== "prepared") return;
    expect((await writer.deliver([result.record])).status).toBe("unavailable");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
