import type { FrameworkSdkBridge } from "./types.js";
import { types } from "node:util";

interface ResponseLifecycle {
  once?(event: string, listener: () => void): unknown;
  off?(event: string, listener: () => void): unknown;
}
/** Observe the existing response lifecycle; no interceptor or timeout inference. */
export function watchNodeRequestEnd(sdk: FrameworkSdkBridge, owner: object, rawResponse: unknown): { finish(): void; usesEvents: boolean } {
  const response = rawResponse !== null && typeof rawResponse === "object" && !types.isProxy(rawResponse) ? rawResponse as ResponseLifecycle : null;
  let complete = false, usesEvents = false;
  const finish = (): void => {
    if (complete) return; complete = true;
    try { sdk.finishRequestContext?.(owner); } catch { /* SDK cleanup never changes host response behavior. */ }
    try { response?.off?.("finish", finish); response?.off?.("close", finish); } catch { /* Already closed. */ }
  };
  try { if (sdk.finishRequestContext !== undefined && typeof response?.once === "function") {
    response.once("finish", finish); response.once("close", finish); usesEvents = true;
  } } catch { finish(); }
  return { finish, usesEvents };
}
