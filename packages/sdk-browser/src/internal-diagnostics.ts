import { sanitizeTelemetry } from "@debugbundle/redaction";
import { getConsoleSource } from "./runtime.js";
import type { BrowserTransportLaneName } from "./event-transport.js";

let depth = 0;
export const inBrowserDiagnostic = (): boolean => depth > 0;
export const diagnosticCode = (value: string): string =>
  value.length <= 64 && !value.startsWith("dbundle_") && /^[a-z][a-z0-9_]*$/.test(value) ? value : "unknown_rejection";

/** Preserve existing local console warnings without retaining raw server detail. */
export class BrowserInternalDiagnostics {
  private readonly seen = new Set<string>();
  private at = 0;
  private count = 0;
  private pending = false;
  reset(): void { this.seen.clear(); this.at = 0; this.count = 0; }

  unauthorized(lane: BrowserTransportLaneName, status: number, endpoint: string, body: unknown, fields: string[]): void {
    try {
      const descriptor = body !== null && typeof body === "object" ? Object.getOwnPropertyDescriptor(body, "error") : undefined;
      const error: unknown = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
      const detail = typeof error === "string" && error.length > 0 ? ` (${diagnosticCode(error)})` : "";
      this.emit("error", `DebugBundle ${lane === "debug" ? "browser SDK" : "browser analytics"} disabled after ingestion returned ${status} for ${endpoint.length <= 2048 ? endpoint : "configured endpoint"}. Check the project token or relay configuration${detail}.`, fields);
    } catch { /* Hostile transport responses cannot affect lane rejection. */ }
  }

  acknowledgement(lane: BrowserTransportLaneName, code: "invalid" | "terminal_rejection", detail: string, fields: string[]): void {
    const safe = detail.split(",", 5).map(diagnosticCode).join(",");
    const key = `${lane}:${code}:${safe}`;
    this.emit("warn", code === "invalid"
      ? `DebugBundle ${lane === "debug" ? "browser SDK" : "browser analytics"} retained events after an invalid ingestion acknowledgement (${safe}).`
      : `DebugBundle ${lane === "debug" ? "browser SDK" : "browser analytics"} removed terminally rejected events (${safe}).`, fields, key);
  }

  private emit(level: "error" | "warn", message: string, fields: string[], key?: string): void {
    if (inBrowserDiagnostic() || this.pending) return;
    depth++;
    try {
      const now = Date.now();
      if (now - this.at >= 60_000) { this.at = now; this.count = 0; this.seen.clear(); }
      if (this.count >= 10 || (key !== undefined && this.seen.has(key))) return;
      this.count++;
      if (key !== undefined) this.seen.add(key);
      const safe = sanitizeTelemetry(message, { additionalKeys: fields });
      if (!safe.ok || typeof safe.value !== "string") return;
      const consoleSource = getConsoleSource();
      const sink = consoleSource?.[level] ?? consoleSource?.warn;
      const result: unknown = sink?.call(consoleSource, safe.value);
      // Native Promise subscription also accepts cross-realm Promises; arbitrary
      // thenable getters are never invoked. Ordinary console returns undefined.
      if (result !== null && typeof result === "object") {
        this.pending = true;
        try { void Promise.prototype.then.call(result, () => { this.pending = false; }, () => { this.pending = false; }); }
        catch { this.pending = false; /* Not a native Promise. */ }
      }
    } catch { /* Diagnostic output is best effort and cannot change ACK state. */ }
    finally { depth--; }
  }
}
