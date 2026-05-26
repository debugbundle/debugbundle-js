# @debugbundle/sdk-node

Node.js SDK for DebugBundle.

![npm](https://img.shields.io/npm/v/%40debugbundle%2Fsdk-node?label=npm)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)

Use this package to capture backend exceptions, request metadata, structured logs, runtime context, and probe data from Node.js services. It also ships browser relay handlers for full-stack apps that use `@debugbundle/sdk-browser`.

Requires Node.js 22 or newer.

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
| `maxBufferedEvents` | `1000` | In-memory buffer cap before new events are dropped. |
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
| `resolveModule` | Node resolution | Custom module resolver for logger auto-detection. |
| `onDiagnostic` | none | Callback for SDK internal diagnostics. |

### Configuration source precedence

1. Explicit `init(...)` fields win.
2. Omitted `environment` and `service` values fall back to runtime detection or the package defaults.
3. Capture-policy fields and project capture rules are server-owned and arrive from `GET /v1/sdk/config`; they are not accepted from local SDK config.

Use process environment, framework config, or your own typed startup config to supply `projectToken`, `service`, and `environment` before calling `init(...)`.

## Remote capture rules

Active project capture rules arrive through `GET /v1/sdk/config` and are applied locally when the Node runtime can do so without changing application behavior:

- `drop` discards matching events before buffering and transport
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

## Documentation

- Node.js SDK docs: <https://debugbundle.com/docs/sdks/node>
- SDK overview: <https://debugbundle.com/docs/sdks>
- Browser relay: <https://debugbundle.com/docs/sdks/browser-relay>
- Repository: <https://github.com/debugbundle/debugbundle-js>

## License

AGPL-3.0-only.
