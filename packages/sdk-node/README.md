# @debugbundle/sdk-node

Node.js SDK for DebugBundle.

Use this package to capture backend exceptions, request metadata, logs, and probe data from Node.js services. It also ships the browser relay handlers through subpath exports.

## Install

Stable npm release:

```bash
npm install @debugbundle/sdk-node
```

## Example

```ts
import { debugbundle } from "@debugbundle/sdk-node";

debugbundle.init({
  projectToken: "dbundle_proj_example",
  endpoint: "https://api.debugbundle.com/v1/events",
  service: "example-api",
  environment: "production",
  framework: "fastify"
});

debugbundle.captureExceptions();
debugbundle.captureRejections();
```

## Relay Exports

- `@debugbundle/sdk-node/relay`
- `@debugbundle/sdk-node/relay/express`
- `@debugbundle/sdk-node/relay/fastify`
- `@debugbundle/sdk-node/relay/nextjs`

## Notes

- Published from the standalone `debugbundle/debugbundle-js` repository.
- Depends on the core-owned published `@debugbundle/shared-types` and `@debugbundle/redaction` packages.