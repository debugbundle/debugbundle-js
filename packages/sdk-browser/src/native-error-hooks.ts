import { normalizeUnhandledRejectionReason } from "./capture-helpers.js";
import { hasErrorDetails, readNativeField } from "./native-fields.js";
import { normalizeBrowserErrorEvent } from "./runtime.js";
import type { CaptureBrowserExceptionContext } from "./types.js";

type Capture = (error: unknown, context: CaptureBrowserExceptionContext) => void;

export function captureNativeError(event: unknown, capture: Capture): void {
  try {
    const browserEvent = normalizeBrowserErrorEvent(event);
    const fallback = browserEvent.kind === "resource_error" ? "Browser resource load error" : "Window error";
    // A fallback message has no application stack; do not fabricate a listener stack.
    const error = readNativeField(event, "error");
    capture(hasErrorDetails(error) || typeof error === "string" ? error : browserEvent.message ?? fallback, { browser_event: browserEvent });
  } catch {
    // Browser instrumentation must never throw into the application's event loop.
  }
}

export function captureNativeRejection(event: unknown, capture: Capture): void {
  try {
    const rejection = normalizeUnhandledRejectionReason(readNativeField(event, "reason"));
    capture(rejection.error, { rejection_reason: rejection.rejectionReason });
  } catch {
    // Isolate host/proxy access failures just like the window error hook.
  }
}
