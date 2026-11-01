import { SDK_NAME, SDK_VERSION, type ActiveConfig, type RemoteProbeConfigSnapshot } from "./types.js";
import { buildSdkConfigEndpoint } from "./utils.js";
import { parseRemoteProbeConfig } from "./remote-probes.js";
import { readBoundedNodeJson } from "./response-json.js";

export function evidenceDiscoveryEndpoint(endpoint: string): string {
  const url = new URL(endpoint); url.searchParams.set("debugbundle_evidence", "1"); return url.toString();
}
type RemoteResult = { kind: "not_modified" | "unavailable" | "invalid"; etag: string | null } |
  { kind: "ready"; etag: string | null; snapshot: RemoteProbeConfigSnapshot; capabilities: unknown };

/** Reuse the existing startup/refresh lifecycle. The deadline covers body reads
 * as well as headers; no capture-time request or extra polling is introduced. */
export async function fetchNodeRemoteConfig(config: ActiveConfig, etag: string | null): Promise<RemoteResult> {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const response = await config.fetchImpl(evidenceDiscoveryEndpoint(buildSdkConfigEndpoint(config.endpoint)), { method: "GET", signal: controller.signal,
      headers: { Authorization: `Bearer ${config.projectToken}`, "x-debugbundle-sdk": SDK_NAME, "x-debugbundle-sdk-version": SDK_VERSION, ...(etag === null ? {} : { "If-None-Match": etag }) } });
    const nextEtag = response.headers.get("etag");
    if (response.status === 304) return { kind: "not_modified", etag: nextEtag };
    if (response.status < 200 || response.status >= 300) return { kind: "unavailable", etag: nextEtag };
    const body = await readBoundedNodeJson(response, 256 * 1024, controller.signal), snapshot = parseRemoteProbeConfig(body, config.probesPollInterval, Date.now());
    if (snapshot === null) return { kind: "invalid", etag: nextEtag };
    return { kind: "ready", etag: nextEtag, snapshot, capabilities: body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)["evidence_capabilities"] : undefined };
  } finally { clearTimeout(timer); }
}
