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

`@debugbundle/shared-types` and `@debugbundle/redaction` are published npm dependencies owned from the core `debugbundle/debugbundle` repository.

## Install

```bash
npm install @debugbundle/sdk-node
npm install @debugbundle/sdk-browser
```

The Node.js SDK requires Node.js 22 or newer. Repository development uses Node.js 24 and pnpm 10.

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

## Browser Relay

The Node.js SDK includes relay exports for backend routes that receive browser events and forward them with the server-side project token.

| Runtime | Import |
| --- | --- |
| Generic Node.js | `@debugbundle/sdk-node/relay` |
| Express | `@debugbundle/sdk-node/relay/express` |
| Fastify | `@debugbundle/sdk-node/relay/fastify` |
| Next.js API route | `@debugbundle/sdk-node/relay/nextjs` |

See <https://debugbundle.com/docs/sdks/browser-relay>.

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
- Run `pnpm prepare:release` and inspect the staged npm artifacts.
- Validate a clean install from the published npm packages after release.

## Documentation

- SDK overview: <https://debugbundle.com/docs/sdks>
- Node.js SDK: <https://debugbundle.com/docs/sdks/node>
- Browser SDK: <https://debugbundle.com/docs/sdks/browser>
- Browser relay: <https://debugbundle.com/docs/sdks/browser-relay>
- Core product repo: <https://github.com/debugbundle/debugbundle>

## License

AGPL-3.0-only. See `LICENSE`.
