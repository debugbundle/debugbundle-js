# @debugbundle/sdk-browser

Browser SDK for DebugBundle.

![npm](https://img.shields.io/npm/v/%40debugbundle%2Fsdk-browser?label=npm)
![License](https://img.shields.io/badge/license-AGPL--3.0--only-blue)

Use this package to capture frontend exceptions, breadcrumbs, first-party request failures, browser device context, trace headers, and probe data. The recommended transport is a same-origin browser relay served by your backend.

## Installation

```bash
npm install @debugbundle/sdk-browser
```

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
- Browser project tokens are never needed when using the relay.
- Breadcrumb and probe buffers are in-memory only.

## Documentation

- Browser SDK docs: <https://debugbundle.com/docs/sdks/browser>
- Browser relay: <https://debugbundle.com/docs/sdks/browser-relay>
- SDK overview: <https://debugbundle.com/docs/sdks>
- Repository: <https://github.com/debugbundle/debugbundle-js>

## License

AGPL-3.0-only.
