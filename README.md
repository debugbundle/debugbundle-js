# debugbundle-js

JavaScript SDK repository for DebugBundle.

![CI](https://img.shields.io/github/actions/workflow/status/debugbundle/debugbundle-js/ci.yml?branch=main&label=ci)
![Node SDK](https://img.shields.io/npm/v/%40debugbundle%2Fsdk-node?label=sdk-node)
![Browser SDK](https://img.shields.io/npm/v/%40debugbundle%2Fsdk-browser?label=sdk-browser)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)

This repository publishes the DebugBundle JavaScript SDK packages used to capture backend Node.js failures and browser-side incidents, breadcrumbs, device context, request summaries, and probe data.

## Packages

| Package | npm name | Purpose |
| --- | --- | --- |
| `packages/sdk-node` | `@debugbundle/sdk-node` | Node.js backend capture, framework integrations, logger capture, file/HTTP transports, and browser relay handlers |
| `packages/sdk-browser` | `@debugbundle/sdk-browser` | Browser exception capture, breadcrumbs, network summaries, device context, trace headers, probes, and relay/direct transport |

`@debugbundle/shared-types` and `@debugbundle/redaction` are published npm dependencies owned from the core `debugbundle/debugbundle` repository. They remain core-owned source and are consumed here as published npm dependencies.

## Dependency alignment

`@debugbundle/sdk-node` and `@debugbundle/sdk-browser` ship as one versioned SDK family. Keep the package versions aligned in every public snippet and real application install.

```bash
npm install @debugbundle/sdk-node@0.1.9 @debugbundle/sdk-browser@0.1.9
```

If you pin `@debugbundle/shared-types` or `@debugbundle/redaction` directly for tooling or schema work, keep them on the same version as the SDK packages. The release workflow blocks partial JS SDK releases and the clean-install smoke path verifies the packed and published artifacts together.

## Install

```bash
npm install @debugbundle/sdk-node
npm install @debugbundle/sdk-browser
```

The Node.js SDK requires Node.js 22 or newer. Repository development uses Node.js 24 and pnpm 10.

## Runtime support labels

### `@debugbundle/sdk-node`

| Label | Version / lane |
| --- | --- |
| Minimum compatibility version | Node.js 22 |
| Recommended production version | Node.js 24 |
| Installed-base compatibility lane | Node.js 22 while it remains an active deployed baseline |
| Rolling CI lanes | Node.js 24 for lint, typecheck, tests, build, and packed-install smoke; Node.js 22 for runtime compatibility coverage |
| Out of scope | Node.js 20 and older |

### `@debugbundle/sdk-browser`

| Label | Version / lane |
| --- | --- |
| Minimum compatibility version | Evergreen browsers with `fetch`, `Promise`, `URL`, `crypto`, and DOM event APIs |
| Recommended production version | Current evergreen Chrome, Edge, Firefox, and Safari releases |
| Installed-base compatibility lane | Current evergreen browsers only; legacy frozen browsers are not compatibility targets |
| Rolling CI lanes | Repository smoke coverage runs the browser package through the published install path and the Node relay surface; cross-browser docs live on the public site |
| Out of scope | Internet Explorer, non-DOM runtimes, and legacy browser engines without `fetch` |

## Configuration source precedence

The package READMEs contain the full option tables. The short rule for this repo is:

1. Explicit `init(...)` fields win.
2. Runtime-derived defaults fill in omitted values such as environment or service fallback.
3. capture-policy fields are server-owned and arrive from `GET /v1/sdk/config`; they are not accepted from local SDK config.

For Node.js, connected mode usually receives `projectToken` from process environment and explicit `service` / `environment` values from application startup config. For browser relay mode, the frontend should configure only the same-origin relay path plus service and environment names. For direct-cloud browser mode, use a dedicated public write-only token with allowed-origin restrictions.

## Quick Start

### Node.js

```ts
import { debugbundle } from "@debugbundle/sdk-node";

debugbundle.init({
  projectToken: process.env.DEBUGBUNDLE_PROJECT_TOKEN,
  service: "api",
  environment: "production"
});

debugbundle.captureExceptions();
debugbundle.captureRejections();
```

### Browser

```ts
import { createDebugBundleBrowserSdk } from "@debugbundle/sdk-browser";

const debugbundle = createDebugBundleBrowserSdk();

debugbundle.init({
  endpoint: "/debugbundle/browser",
  service: "web",
  environment: "production"
});
```

For full-stack apps, route browser events through a same-origin relay so the project token stays server-side.

## Install examples for claimed modes

### Node.js local-only mode

```ts
import { debugbundle } from "@debugbundle/sdk-node";

debugbundle.init({
  service: "checkout-api",
  environment: "development",
  projectMode: "local-only",
  localEventsDir: ".debugbundle/local/events"
});
```

### Node.js connected mode

```ts
import { debugbundle } from "@debugbundle/sdk-node";

debugbundle.init({
  projectToken: process.env.DEBUGBUNDLE_PROJECT_TOKEN,
  service: "checkout-api",
  environment: "production"
});
```

### Browser relay mode

```ts
import { createDebugBundleBrowserSdk } from "@debugbundle/sdk-browser";

const debugbundle = createDebugBundleBrowserSdk();

debugbundle.init({
  endpoint: "/debugbundle/browser",
  service: "checkout-web",
  environment: "production"
});
```

### Browser direct-cloud mode

```ts
import { createDebugBundleBrowserSdk } from "@debugbundle/sdk-browser";

const debugbundle = createDebugBundleBrowserSdk();

debugbundle.init({
  endpoint: "https://api.debugbundle.com/v1/events",
  projectToken: "dbundle_proj_public_write_only",
  service: "marketing-site",
  environment: "production"
});
```

## Browser Relay

The Node.js SDK includes relay exports for backend routes that receive browser events and forward them with the server-side project token.

| Runtime | Import |
| --- | --- |
| Generic Node.js | `@debugbundle/sdk-node/relay` |
| Express | `@debugbundle/sdk-node/relay/express` |
| Fastify | `@debugbundle/sdk-node/relay/fastify` |
| Next.js API route | `@debugbundle/sdk-node/relay/nextjs` |

See <https://debugbundle.com/docs/sdks/browser-relay>.

Relay behavior summary:

- Same-origin is the default when `allowedOrigins` is omitted.
- Split frontend/backend hosts must set explicit allowed origins.
- Relay requests must use `Content-Type: application/json`.
- Relay bodies are capped at `256 KB`.
- Relay requests are rate limited per client IP.
- Browser-supplied `project_token`, `authorization`, `cookie`, and similar trust-sensitive fields are stripped before forwarding.
- Local-only mode writes accepted browser batches into `.debugbundle/local/events/`.
- Connected mode can durably spool accepted browser batches before forwarding to DebugBundle.
- Relay forwarding uses the server-side project token only.
- If relay handling is disabled or the backend lacks a usable project token, the host app keeps running and the SDK reports a degraded or disconnected status instead of pretending capture is healthy.

## Service naming guidance

Use distinct service names for each deployable surface that shares one DebugBundle project:

- Backend API: `checkout-api`
- Worker: `checkout-worker`
- Browser frontend: `checkout-web`

When a browser frontend sends through a relay, keep the browser service name browser-specific. The relay should preserve the browser-owned service identity unless you intentionally override it for a shared edge/backend surface.

## Safe startup behavior

- Node.js connected mode without a usable `projectToken` must not crash the host process. The SDK degrades to disconnected capture, leaves the app running, and exposes that state through `status()`.
- Node.js local-only mode can still write local event files without a remote token.
- Browser relay mode does not require a browser-visible token. If the relay path is invalid or unavailable, the page keeps running and the SDK stays disabled or disconnected rather than throwing into application code.
- Browser direct-cloud mode requires a dedicated public write-only token. Missing or rejected credentials fail closed and clear buffered events only after an explicit auth rejection from the endpoint.

## First-event verification

Use the package-level snippets for application code, then verify the repo-level publish path with the same clean-install smoke harness that CI and release use:

```bash
pnpm build
pnpm smoke:packed
```

After publish, the release workflow runs the same application-level verification against the npm registry:

```bash
DEBUGBUNDLE_SMOKE_VERSION=0.1.9 pnpm smoke:registry
```

## Safety Defaults

- SDK failures are swallowed internally and do not crash host applications.
- Sensitive field names are redacted before events leave the process.
- Duplicate and runaway event storms are suppressed locally.
- Backend SDKs can write to `.debugbundle/local/events/` in local-only mode.
- Browser SDKs keep breadcrumbs local by default and flush them with frontend exceptions.

## Development

```bash
corepack enable
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

This repo is intentionally standalone. Do not add source copies of `@debugbundle/shared-types` or `@debugbundle/redaction` here unless that ownership boundary is deliberately changed.

## Release

`@debugbundle/sdk-node` and `@debugbundle/sdk-browser` are published from this repository and should ship at the same SDK version.

Before publishing:

- Confirm the matching `@debugbundle/shared-types` and `@debugbundle/redaction` versions are already published from core.
- Run lint, typecheck, tests, and build.
- Run `pnpm smoke:packed` to build the staged artifacts, install them into a fresh consumer fixture, emit a real Node event through the Express middleware path, emit a real browser exception through the Express relay path, and validate the received event envelopes plus relay credential isolation.
- After publish, run `DEBUGBUNDLE_SMOKE_VERSION=<version> pnpm smoke:registry` or let the release workflow do it before the GitHub release is finalized.

## Documentation

- SDK overview: <https://debugbundle.com/docs/sdks>
- Node.js SDK: <https://debugbundle.com/docs/sdks/node>
- Browser SDK: <https://debugbundle.com/docs/sdks/browser>
- Browser relay: <https://debugbundle.com/docs/sdks/browser-relay>
- Core product repo: <https://github.com/debugbundle/debugbundle>

## License

AGPL-3.0-only. See `LICENSE`.
