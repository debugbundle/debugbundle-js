# @debugbundle/sdk-node

Node.js SDK for DebugBundle.

![npm](https://img.shields.io/npm/v/%40debugbundle%2Fsdk-node?label=npm)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

Use this package to capture backend exceptions, request metadata, structured logs, runtime context, and probe data from Node.js services. It also ships browser relay handlers for full-stack apps that use `@debugbundle/sdk-browser`.

Requires Node.js 22 or newer.

## Logger filtering

Node logger integrations capture records after native source filtering: Pino levels/silent mode/log-method hooks, Bunyan levels, and Winston levels/silent mode/format filters. Bunyan enabled queries do not create events. Native output, results and exceptions are preserved, and SDK callback failures cannot interrupt logging. Destination-specific transport filters are separate from DebugBundle's own minimum capture level. Use `captureLog()` for explicit reporting independent of automatic logger capture.

## Installation

```bash
npm install @debugbundle/sdk-node
```

Keep `@debugbundle/sdk-node`, `@debugbundle/sdk-browser`, `@debugbundle/shared-types`, and `@debugbundle/redaction` on matching versions when you pin them explicitly. Public examples must not mix JS SDK family versions.

## Quick Start

```ts
import { debugbundle } from "@debugbundle/sdk-node";

debugbundle.init({
  projectToken: process.env.DEBUGBUNDLE_PROJECT_TOKEN,
  service: "checkout-api",
  environment: "production"
});

debugbundle.captureExceptions();
debugbundle.captureRejections();
```

Handled errors, logs, messages, and probes can be captured explicitly:

```ts
debugbundle.captureException(error);
debugbundle.captureLog("payment retry failed", "warning", { orderId });
debugbundle.captureMessage("checkout worker started");
debugbundle.probe("checkout.cart", { itemCount: cart.items.length });

await debugbundle.flush();
```

## Candidate semantic analytics capture and outbox delivery (unreleased source)

The source candidate exports a separate, default-disabled server analytics client. It does not change the installed debug `init()`, capture, or `flush()`. It requires an explicitly issued `dbundle_anl_` server writer credential and a current project-only capability; a space-scoped grant is rejected before capture or delivery. `prepare` locally finalizes a nonfinancial business milestone with a caller-owned stable opaque operation hash; it makes no network request and does not own a transaction. The application stores the returned record with its business change, then its outbox worker calls `deliver`. Manual `track` is a separate best-effort path for observations that do not need the application's durable outbox. Server business events are sessionless and do not enter the first browser session funnel. `withContext({traceId?, deployId?})` provides an isolated correlation-only request scope. Per-fact `identity` accepts only protected references under a configured project namespace; `deliver` checks the fresh authenticated namespace and known-identity grant before sending. The application derives references on its backend with the canonical keyed HMAC contract and never passes raw identifiers or the key to this SDK. Subject erasure and the complete identity release gate remain open, so the default API capability is disabled and this candidate cannot deliver to the default service. Automatic capture and framework binding remain open.

The [typed transaction/outbox recipe](examples/semantic-outbox.ts) is compiled with the candidate SDK source. Its store interface must be implemented with the application's database: account creation and prepared-record insertion share one transaction. Delivery records accepted indexes and marks terminally rejected rows for review using a compare-and-set on the prepared content hash; rate and quota rejections stay pending. The sample's policy lets account creation succeed when preparation is unavailable, leaving an instrumentation gap that reports cannot treat as verified source coverage. The recipe is not part of the shipped SDK runtime.

The [source-only HTTP preparation recipe](examples/semantic-http.ts) compiles against the same candidate. An application handler passes its authenticated measurement decision, and the recipe accepts only a UUID v4 trace header before creating a request scope. It exposes `prepare` only: resetting the scope after the handler would discard unsent best-effort `track` work. Prepared outbox records remain application-owned and can be inserted with the business transaction. This does not authenticate an application user or enable known identity; Express/Fastify adapters and their installed-mode checks remain open.

For a known user fact, the application derives a protected `userIdHash` from its authenticated user on its backend and supplies the current configured `namespaceRevision` in that fact's `identity` option. `prepare` can run offline; `deliver` rechecks the current server capability, so a rotated namespace leaves the old prepared record unresolved for the application's outbox policy. An anonymous-only reference uses `anonymousIdHash` and standard privacy. The SDK never derives identity from a global debug context.

```ts
await analytics.prepare("account.created", { signup_method: "email" }, {
  eventRevision: 1,
  operationId,
  identity: { namespaceRevision, userIdHash } // Protected sha256: HMAC reference.
});
```

```ts
import { createSemanticAnalyticsNodeDelivery } from "@debugbundle/sdk-node";
import type { SemanticAnalyticsNodeDelivery } from "@debugbundle/sdk-node";
import type { AnalyticsPreparedEvent, AnalyticsDeliveryReceipt } from "@debugbundle/shared-types";

async function prepareAccountCreated(
  analytics: SemanticAnalyticsNodeDelivery,
  operationId: string,
  persistWithBusinessTransaction: (record: AnalyticsPreparedEvent) => Promise<void>
): Promise<void> {
  const result = await analytics.prepare("account.created", { signup_method: "email" }, {
    eventRevision: 1,
    operationId // Stable sha256: hash of an opaque business-operation key.
  });
  if (result.status === "prepared") await persistWithBusinessTransaction(result.record);
  // The application's instrumentation policy handles unavailable preparation.
}

async function deliverPending(
  analytics: SemanticAnalyticsNodeDelivery,
  outboxRecords: AnalyticsPreparedEvent[],
  persistReceiptAndResolveIndexes: (receipt: AnalyticsDeliveryReceipt) => Promise<void>
): Promise<void> {
  // Load finalized records after the business transaction commits.
  const result = await analytics.deliver(outboxRecords);
  if (result.status === "received") {
    // Acknowledge accepted indexes; quarantine terminal errors; retry only rate/quota errors.
    await persistReceiptAndResolveIndexes(result.receipt);
  }
  // An unavailable result leaves every record owned by the application.
}

const projectId = process.env.DEBUGBUNDLE_PROJECT_ID;
const writerToken = process.env.DEBUGBUNDLE_ANALYTICS_WRITER_TOKEN;
const analytics = projectId && writerToken
  ? createSemanticAnalyticsNodeDelivery({
      projectId, writerToken, serviceName: "accounts-api", environment: "production", enabled: true
    })
  : null;
// Pass this writer to the two application-owned functions above when non-null.
```

For a best-effort server observation, explicitly negotiate first and inspect `getStatus()` before calling `track`. This call never returns a durable receipt; use `prepare`/`deliver` for business facts that must survive process loss.

```ts
async function recordBestEffortAccountCreated(operationId: string): Promise<void> {
  await analytics?.refreshCapability();
  const request = analytics?.withContext({ traceId: "safe-trace-reference" });
  request?.track("account.created", { signup_method: "email" }, {
    eventRevision: 1,
    operationId // Stable opaque sha256: business-operation hash.
  });
  await analytics?.flush(); // One bounded attempt for queued best-effort records.
}
```

Each request scope owns only its unsent volatile records. `request.setConsent(false)` synchronously removes that scope's pending records; another request's records remain queued. `request.reset()` clears its correlation context and leaves that facade inert. A revoked scope cannot dispatch after an in-progress capability refresh, but bytes already sent cannot be recalled. Scoped `prepare` uses the scope's trace/deploy values even if a call supplies different ones; the application still owns any prepared record it has committed to its outbox. Invalid context or getters yield an inert scope. This is correlation only: no session, user or account identity is inferred. The scope does not own a sender; use the parent `flush()` or `deliver()` as appropriate.

`track` does not traverse application properties until an authenticated, enabled server capability has been checked and remains current. Wall time and monotonic elapsed time both bound that grant; a clock rollback cannot extend it. It finalizes the same protected nonfinancial record locally, then holds at most 256 records / 4 MiB for five minutes in a volatile lane. That lifetime also expires by monotonic elapsed time. It schedules a send after one second. A valid indexed receipt removes accepted and terminally rejected records; only rate and quota rejections remain for bounded retry. If a refreshed capability lowers the size limit, a record that cannot fit by itself is discarded so it cannot block smaller queued records; local status records `capacity_exceeded`. Process exit can still lose this lane; it does not own an application transaction or replace an outbox.

`prepare` requires a business event name, declared event revision and stable `sha256:` operation reference, validates protected properties/measurements, and returns an immutable record or a fixed unavailable reason. Optional service and environment default to `node-service` and `NODE_ENV` (or `development`), matching the installed debug SDK defaults. `deliver` checks record integrity, destination, expiry, privacy and a fresh authenticated semantic capability before one bounded HTTP attempt. A protected known-user fact requires the same active namespace and known-identity permission in that capability. It returns a canonical indexed receipt only when the server acknowledges the original batch; a local timeout or protocol failure returns `unavailable`. `getStatus()` reports local enablement, volatile queue count/bytes, in-flight state, last observed capability state, a fixed failure reason, and bounded accepted/retryable/terminal counts from the last valid receipt. These are local historical observations, contain no event or identity values, and do not claim current server authority. Financial facts remain withheld. The outbox path has no SDK-owned retry queue or file aggregation path, and concurrent explicit delivery calls return `capacity_exceeded`. Browser and relay code must never receive this credential. Candidate shared-types and redaction packages must be linked locally for source verification; the published 2.1.0 dependency does not yet contain this V2 contract.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `projectToken` | none | Write-only DebugBundle project token. Required unless the SDK is disabled. |
| `service` | auto-detected or `node-service` | Service name shown on incidents and bundles. |
| `environment` | `NODE_ENV` or `development` | Runtime environment such as `production`, `staging`, or `development`. |
| `projectMode` | `connected` | Use `local-only` to write events to `.debugbundle/local/events/`. |
| `endpoint` | `https://api.debugbundle.com/v1/events` | Ingestion endpoint for connected mode or self-hosting. |
| `enabled` | `true` | Disable all capture without removing instrumentation. |
| `redactFields` | common sensitive fields | Additional field names to redact. |
| `logLevel` | `warning` | Minimum captured log severity. |
| `sampleRate` | `1.0` | Fraction of events to keep before transport. |
| `batchSize` | `50` | Events per batch before flushing. |
| `flushInterval` | `2000` | Flush interval in milliseconds. |
| `maxBufferedEvents` | `1000` | Total queued and in-flight event cap. Under pressure, lower-priority logs and ordinary requests yield to exceptions and failed requests; equal-priority replacements are sampled after the first replacement. A full in-flight batch cannot be displaced. Queue losses are summarized after capacity returns. |
| `maxBufferedBytes` | `8388608` (8 MiB) | Total serialized bytes owned by queued and in-flight events. An event larger than the available byte budget is discarded; queued lower-priority events can be evicted for higher-priority evidence. |
| `localEventsDir` | `.debugbundle/local/events` | Local file transport directory. |
| `requestTimeoutMs` | `5000` | HTTP transport timeout in milliseconds. |
| `maxProbeLabels` | `50` | Maximum distinct probe labels buffered in memory. |
| `maxProbeEntriesPerLabel` | `10` | Maximum entries retained per probe label. |
| `probeFlushOnError` | `true` | Attach buffered probe data to captured exceptions. |
| `captureConsole` | `false` | Wrap `console.error` and `console.warn`. |
| `autoDetectLoggers` | `true` | Detect supported logger integrations when possible. |
| `logger` | none | Optional logger instance to attach during initialization. |
| `transport` | auto-selected | Custom transport function for tests or advanced routing. |
| `fetchImpl` | global `fetch` | Custom Fetch implementation. |
| `beforeSend` | none | Synchronous-return hook deferred until after capture returns and bounded admission; return an event to keep it or `null` to drop it. |
| `resolveModule` | Node resolution | Custom module resolver for logger auto-detection. |
| `onDiagnostic` | none | Callback for SDK internal diagnostics. |

### Configuration source precedence

1. Explicit `init(...)` fields win.
2. Omitted `environment` and `service` values fall back to runtime detection or the package defaults.
3. Capture-policy fields and project capture rules are server-owned and arrive from `GET /v1/sdk/config`; they are not accepted from local SDK config.

Use process environment, framework config, or your own typed startup config to supply `projectToken`, `service`, and `environment` before calling `init(...)`.

### Local beforeSend hook

Use `beforeSend` for app-owned final redaction or tenant-specific suppression. Version 3 runs it after capture returns and privacy-safe bounded admission, before final project capture rules, sampling, suppression and transport. Callbacks execute on the JavaScript event loop and must return promptly. Queue pressure may drop an event before its callback runs. See the [version 3 migration guide](https://github.com/debugbundle/debugbundle-js/blob/main/MIGRATION-3.0.md).

```ts
debugbundle.init({
  projectToken: process.env.DEBUGBUNDLE_PROJECT_TOKEN,
  service: "checkout-api",
  environment: "production",
  beforeSend(event) {
    if (event.event_type === "log_event" && event.payload.message.includes("expected healthcheck")) {
      return null;
    }

    return event;
  }
});
```

If the hook throws or returns an invalid event, the SDK keeps the original event and emits an internal diagnostic. Use project capture rules first for operational noise because they are centralized and enforced by ingestion and worker backstops.

## Remote capture rules

Active project capture rules arrive through `GET /v1/sdk/config` and are applied locally when the Node runtime can do so without changing application behavior:

- `drop` discards matching events before transport; when a hook is configured, final rule evaluation follows protected admission and that hook
- `sample` discards matching events only when the deterministic sampling decision resolves to sampled out
- `demote` still ships today and relies on ingestion/worker backstop enforcement, because the Node SDK does not have a browser-style breadcrumb/context downgrade channel yet

This keeps the project-wide rule contract consistent with the browser SDK while leaving room for richer backend-local demotion later.

## Frameworks and Logging

The SDK supports vanilla Node.js plus Express, Fastify, and Next.js integration helpers. It can capture uncaught exceptions, unhandled rejections, request context, response status and duration, and supported logger output.

Logger capture is intentionally in-process. DebugBundle attaches to logger transports or handlers; it does not read application log files.

## Browser Relay

Use a same-origin relay when pairing this package with `@debugbundle/sdk-browser` so browser JavaScript never receives the server-side project token.

| Runtime | Import |
| --- | --- |
| Generic Node.js | `@debugbundle/sdk-node/relay` |
| Express | `@debugbundle/sdk-node/relay/express` |
| Fastify | `@debugbundle/sdk-node/relay/fastify` |
| Next.js API route | `@debugbundle/sdk-node/relay/nextjs` |

See <https://debugbundle.com/docs/sdks/browser-relay>.

Relay behavior summary:

- same-origin is the default when `allowedOrigins` is omitted
- split frontend/backend hosts should set explicit allowed origins
- relay adapters answer allowed CORS `OPTIONS` preflight and add matching CORS headers to allowed POST responses
- requests must use `Content-Type: application/json`
- request bodies are capped at `256 KB`
- per-IP rate limiting is enabled
- browser-supplied credentials and trust-sensitive fields are stripped
- local-only mode writes accepted batches to `.debugbundle/local/events/`
- connected mode can durably spool accepted batches before forwarding
- forwarding always uses the server-side project token
- disabling the relay or omitting a usable token leaves the host app running and the SDK status degraded or disconnected

## Service naming guidance

Use separate service names for each deployable surface in one DebugBundle project. A common pattern is:

- browser frontend: `checkout-web`
- backend API: `checkout-api`
- worker: `checkout-worker`

When the browser sends through this relay, keep the browser service name browser-specific unless you intentionally override it for a shared edge/backend surface.

## Safe startup behavior

- Connected mode without a usable `projectToken` must not crash the host process.
- `status()` reports `disconnected` or `degraded` when capture cannot ship successfully.
- Local-only mode stays valid without a remote token and writes event files instead.
- Failed or rejected transport responses never bubble uncaught exceptions into application code.

## First-event verification

Minimal application check:

```ts
import { debugbundle } from "@debugbundle/sdk-node";

debugbundle.init({
  projectToken: process.env.DEBUGBUNDLE_PROJECT_TOKEN,
  service: "checkout-api",
  environment: "development",
  endpoint: "http://127.0.0.1:3004/v1/events"
});

debugbundle.captureMessage("debugbundle node smoke", "warning");
await debugbundle.flush();
console.log(debugbundle.status());
```

Repository-level verification uses the same clean-install smoke path as CI and release:

```bash
pnpm build
pnpm smoke:packed
```

## Safety Guarantees

- SDK failures are caught internally.
- The SDK does not block the request/response cycle for ingestion.
- Sensitive fields are redacted before transport.
- Duplicate event storms are suppressed locally.
- Local-only mode writes event files atomically.

Persistent context is sanitized as a complete snapshot, with at most 50 keys and 128 characters per key. Combined scanning is capped at 256 KiB; unsafe updates are withheld. Protocol credentials used for signed probe activation are read separately from captured telemetry.

## Documentation

- Node.js SDK docs: <https://debugbundle.com/docs/sdks/node>
- SDK overview: <https://debugbundle.com/docs/sdks>
- Browser relay: <https://debugbundle.com/docs/sdks/browser-relay>
- Repository: <https://github.com/debugbundle/debugbundle-js>

## License

Apache-2.0.
