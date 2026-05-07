# @debugbundle/sdk-browser

Browser SDK for DebugBundle.

Use this package to capture frontend exceptions, breadcrumbs, probe data, and browser device context. The recommended transport is the same-origin browser relay served by your backend.

## Install

Stable npm release:

```bash
npm install @debugbundle/sdk-browser
```

## Example

```ts
import { createDebugBundleBrowserSdk } from "@debugbundle/sdk-browser";

const debugbundle = createDebugBundleBrowserSdk();

debugbundle.init({
  endpoint: "/debugbundle/browser",
  service: "example-web",
  environment: "production"
});
```

## Notes

- Published from the standalone `debugbundle/debugbundle-js` repository.
- Depends on the core-owned published `@debugbundle/shared-types` and `@debugbundle/redaction` packages.