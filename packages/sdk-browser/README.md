# @debugbundle/sdk-browser

Browser SDK for DebugBundle.

![npm](https://img.shields.io/npm/v/%40debugbundle%2Fsdk-browser?label=npm)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)

Use this package to capture frontend exceptions, breadcrumbs, first-party request failures, browser device context, trace headers, and probe data. The recommended transport is a same-origin browser relay served by your backend.

## Installation

```bash
npm install @debugbundle/sdk-browser
```

Keep `@debugbundle/sdk-browser` and `@debugbundle/sdk-node` on the same release version. If you pin the core-owned support packages directly, keep `@debugbundle/shared-types` and `@debugbundle/redaction` on the same version too.

## Quick Start

```ts
import { createDebugBundleBrowserSdk } from "@debugbundle/sdk-browser";

const debugbundle = createDebugBundleBrowserSdk();

debugbundle.init({
  endpoint: "/debugbundle/browser",
  service: "web",
  environment: "production"
});
```

The browser SDK starts capture only after `init()` is called. Importing the package has no side effects.

## Transport Modes

| Mode | Configuration | Use when |
| --- | --- | --- |
| Relay | `endpoint: "/debugbundle/browser"` | Recommended for full-stack apps. Browser events go to your backend first. |
| Direct cloud | `projectToken` plus the hosted endpoint | Frontend-only apps without a backend. Use a dedicated write-only token with allowed-origin restrictions. |

For relay setup, see <https://debugbundle.com/docs/sdks/browser-relay>.

### Configuration source precedence

1. Explicit `init(...)` fields win.
2. Omitted values fall back to package defaults such as `service: "browser-app"` and `environment: "development"`.
3. Capture-policy fields are server-owned and arrive from `GET /v1/sdk/config`; they are not accepted from local browser config.

Relay mode should configure only the same-origin path plus the service/environment names. Direct-cloud mode requires a dedicated public write-only token and a real ingestion endpoint URL.

## What It Captures

- Frontend exceptions and unhandled promise rejections
- Recent breadcrumbs from clicks, route changes, console warnings/errors, and first-party network requests
- First-party request failures that should become incident signals
- Browser and device context such as user agent, viewport, screen, locale, connection type, and color scheme
- `X-DebugBundle-Trace-Id` headers on allowed outgoing requests for frontend/backend correlation
- Always-on probe ring buffers that flush with exceptions

Breadcrumbs are kept in memory and attached to frontend exceptions by default. They are not independently shipped unless configured.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `endpoint` | derived from transport | Relay or ingestion endpoint. |
| `projectToken` | none | Direct cloud write-only token for frontend-only deployments. Omit when using relay. |
| `service` | `browser-app` | Frontend service name shown on incidents and bundles. |
| `environment` | `development` | Runtime environment such as `production`, `staging`, or `development`. |
| `enabled` | `true` | Disable all capture without removing instrumentation. |
| `redactFields` | common sensitive fields | Additional field names to redact. |
| `sampleRate` | `1.0` | Per-event sampling rate. |
| `sessionSampleRate` | `1.0` | Per-session capture sampling rate. |
| `batchSize` | `10` | Events per batch before flushing. |
| `flushInterval` | `3000` | Flush interval in milliseconds. |
| `logLevel` | `warning` | Minimum captured browser log severity. |
| `maxBreadcrumbs` | `10` | Breadcrumb ring-buffer size. |
| `breadcrumbsOnErrorOnly` | `true` | Attach breadcrumbs to exceptions instead of shipping them independently. |
| `captureNetwork` | `true` | Capture first-party network breadcrumbs and failure signals. |
| `captureClicks` | `true` | Capture click breadcrumbs. |
| `captureRouteChanges` | `true` | Capture route-change breadcrumbs. |
| `captureConsole` | `false` | Capture console warnings and errors. |
| `networkFilter` | default failure filtering | Include or exclude requests by URL, status, or response time. |
| `maxEventsPerSession` | `100` | Cap non-exception events per browser session. |
| `tracePropagationTargets` | same-origin | URLs allowed to receive `X-DebugBundle-Trace-Id`. |
| `maxProbeLabels` | `50` | Maximum distinct probe labels buffered in memory. |
| `maxProbeEntriesPerLabel` | `10` | Maximum entries retained per probe label. |
| `probeFlushOnError` | `true` | Attach buffered probe data to captured exceptions. |
| `requestTimeoutMs` | `5000` | Transport timeout in milliseconds. |
| `transport` | fetch transport | Custom transport function for tests or advanced routing. |

## Service naming guidance

Keep the browser service name distinct from backend deployables inside the same DebugBundle project. A common pattern is `checkout-web` for the browser frontend and `checkout-api` for the backend relay host.

When you send through a same-origin relay, the browser service name should stay browser-owned. The backend relay should not overwrite it unless you intentionally want a shared surface name.

## Explicit Capture

```ts
debugbundle.captureException(error, { route: window.location.pathname });
debugbundle.captureLog("checkout warning", "warning", { cartId });
debugbundle.captureMessage("user started checkout");
debugbundle.probe("checkout.cart", { itemCount: cart.items.length });

await debugbundle.flush();
```

## Safety and Privacy

- SDK failures are caught internally and do not break the host page.
- Sensitive fields are redacted before transport.
- Duplicate event storms are suppressed locally.
- Browser project tokens are never needed when using the same-origin relay.
- Breadcrumb and probe buffers are in-memory only.

## Safe startup behavior

- Relay mode keeps browser-visible credentials out of the page and does not require a token in frontend config.
- Invalid relay paths or missing direct-cloud credentials fail closed without crashing the host page.
- `status()` exposes whether the SDK is healthy, degraded, or disconnected.
- Auth-rejected direct-cloud responses stop pretending capture is healthy and clear buffered events only after the endpoint explicitly rejects the token.

## First-event verification

Minimal application check:

```ts
import { createDebugBundleBrowserSdk } from "@debugbundle/sdk-browser";

const debugbundle = createDebugBundleBrowserSdk();

debugbundle.init({
  endpoint: "/debugbundle/browser",
  service: "checkout-web",
  environment: "development"
});

debugbundle.captureException(new Error("debugbundle browser smoke"));
await debugbundle.flush();
console.log(debugbundle.status());
```

Repository-level verification runs the same clean-install smoke used by CI and release:

```bash
pnpm build
pnpm smoke:packed
```

## Documentation

- Browser SDK docs: <https://debugbundle.com/docs/sdks/browser>
- Browser relay: <https://debugbundle.com/docs/sdks/browser-relay>
- SDK overview: <https://debugbundle.com/docs/sdks>
- Repository: <https://github.com/debugbundle/debugbundle-js>

## License

AGPL-3.0-only.
