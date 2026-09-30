import { getConsoleSource, normalizeUnknownRecord } from "./runtime.js";
import type { BrowserTransportLaneName } from "./event-transport.js";

/** Browser transport diagnostics contain status metadata only, never event bodies or credentials. */
export class BrowserTransportDiagnostics {
  private readonly reportedAcknowledgements = new Set<string>();

  public reset(): void {
    this.reportedAcknowledgements.clear();
  }

  public unauthorized(lane: BrowserTransportLaneName, statusCode: 401 | 403, endpoint: string, body: unknown): void {
    const consoleSource = getConsoleSource();
    if (consoleSource === null) return;
    const bodyRecord = normalizeUnknownRecord(body);
    const errorCode = typeof bodyRecord["error"] === "string" && bodyRecord["error"].length > 0
      ? bodyRecord["error"] : null;
    const detail = errorCode === null ? "" : ` (${errorCode})`;
    const laneLabel = lane === "debug" ? "browser SDK" : "browser analytics";
    const message = `DebugBundle ${laneLabel} disabled after ingestion returned ${statusCode} for ${endpoint}. ` +
      `Check the project token or relay configuration${detail}.`;
    if (typeof consoleSource.error === "function") consoleSource.error(message);
    else consoleSource.warn?.(message);
  }

  public acknowledgement(lane: BrowserTransportLaneName, code: "invalid" | "terminal_rejection", detail: string): void {
    const key = `${lane}:${code}:${detail}`;
    if (this.reportedAcknowledgements.has(key)) return;
    this.reportedAcknowledgements.add(key);
    const consoleSource = getConsoleSource();
    const laneLabel = lane === "debug" ? "browser SDK" : "browser analytics";
    consoleSource?.warn?.(code === "invalid"
      ? `DebugBundle ${laneLabel} retained events after an invalid ingestion acknowledgement (${detail}).`
      : `DebugBundle ${laneLabel} removed terminally rejected events (${detail}).`);
  }
}
