import type { IncomingMessage } from "node:http";
import type {
  SemanticAnalyticsNodeDelivery,
  SemanticAnalyticsNodeScope
} from "../src/index.js";

const TRACE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Call from an HTTP handler after the application has authenticated its request. */
export async function withHttpSemanticPreparation<T>(input: {
  analytics: SemanticAnalyticsNodeDelivery;
  request: Pick<IncomingMessage, "headers">;
  businessMeasurementAllowed: boolean;
  handle: (scope: Pick<SemanticAnalyticsNodeScope, "prepare">) => Promise<T>;
}): Promise<T> {
  const header = input.request.headers["x-debugbundle-trace-id"];
  const traceId = typeof header === "string" && TRACE_ID.test(header) ? header : null;
  const scope = input.analytics.withContext({ traceId });
  if (!input.businessMeasurementAllowed) scope.setConsent(false);
  try {
    // Only preparation is exposed: request-end reset would drop volatile track work.
    // The handler owns the business transaction and durable outbox.
    return await input.handle({ prepare: (...args) => scope.prepare(...args) });
  } finally {
    // A later request cannot inherit queued work or correlation from this scope.
    scope.reset();
  }
}
