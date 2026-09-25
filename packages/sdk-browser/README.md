# @debugbundle/sdk-browser

Browser SDK for DebugBundle.

![npm](https://img.shields.io/npm/v/%40debugbundle%2Fsdk-browser?label=npm)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)

Use this package to capture frontend exceptions, breadcrumbs, first-party request failures, browser device context, trace headers, and probe data. The recommended transport is a browser relay served by your backend.

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
  transportMode: "relay",
  endpoint: "/debugbundle/browser",
  service: "web",
  environment: "production"
});
```

The browser SDK starts capture only after `init()` is called. Importing the package has no side effects.

Lifecycle delivery is best effort. Relay mode uses a credential-free beacon when possible; direct-cloud mode uses authenticated `fetch(keepalive)` because ingestion requires a bearer header. Each SDK instance shares a 60-KiB lifecycle budget across debug and analytics requests. Keepalive capacity is released when its request settles. An accepted beacon has no completion signal, so its bytes remain reserved for that instance; ordinary delivery remains available. Other page code can consume the browser's shared quota. Events that do not fit, or whose keepalive request fails, remain queued for ordinary delivery while the page stays active. Closing the page can still lose pending events.

## Transport Modes

| Mode | Configuration | Use when |
| --- | --- | --- |
| Relay | `transportMode: "relay"`, plus `/debugbundle/browser` or an absolute backend relay URL | Recommended for full-stack apps. Browser events go to your backend first. |
| Direct cloud | `projectToken` plus the hosted endpoint | Frontend-only apps without a backend. Use a dedicated write-only token with allowed-origin restrictions. |

For relay setup, see <https://debugbundle.com/docs/sdks/browser-relay>.

### Configuration source precedence

1. Explicit `init(...)` fields win.
2. Omitted values fall back to package defaults such as `service: "browser-app"` and `environment: "development"`.
3. Capture-policy fields are server-owned and arrive from `GET /v1/sdk/config`; they are not accepted from local browser config.

Relay mode should configure only `transportMode`, the relay endpoint, and service/environment names. The same-origin relay path case, such as `/debugbundle/browser`, is inferred as relay for compatibility. Absolute backend relay URLs require `transportMode: "relay"` so the browser SDK stays credential-free and sends the relay batch shape. Direct-cloud mode requires a dedicated public write-only token and a real ingestion endpoint URL.

## What It Captures

- Frontend exceptions and unhandled promise rejections
- Recent breadcrumbs from clicks, route changes, console warnings/errors, and first-party network requests
- First-party request failures that should become incident signals
- Browser and device context such as user agent, viewport, screen, locale, connection type, and color scheme
- `X-DebugBundle-Trace-Id` headers on allowed outgoing requests for frontend/backend correlation
- Always-on probe ring buffers that flush with exceptions

Breadcrumbs are kept in memory and attached to frontend exceptions by default. They are not independently shipped unless configured.

Browser-native `window.error` and resource-load failures include sanitized `browser_event` metadata when the browser exposes it: event kind, message/file/line/column, opaque-error flag, technical resource target details, and page lifecycle state. URLs are stripped to origin plus path for absolute URLs or path only for relative URLs.

Global `unhandledrejection` captures include a bounded `rejection_reason` summary when the browser exposes the original reason. Error reasons preserve name/message, string reasons preserve a truncated preview, object reasons may preserve sanitized name/message plus type preview, and null/undefined reasons are represented explicitly.

The Browser SDK exposes a synchronous-return `beforeSend` hook for app-owned final redaction or local suppression. Version 3 defers invocation until capture returns and privacy-safe bounded admission; application callbacks must return promptly on the JavaScript event loop. Use project capture rules first for known operational noise because they are centralized and auditable, and use `networkFilter` for network breadcrumb/request capture choices.

Network wrapping is designed to preserve normal browser behavior. The SDK supports `fetch()` calls with `string`, `URL`, and `Request` inputs, and preserves caller headers provided as `Headers`, header tuple arrays, or records. When trace propagation is enabled for a request, the SDK adds `X-DebugBundle-Trace-Id` to the effective header set without dropping existing headers such as `Authorization`.

## Configuration

| Option | Default | Purpose |
| --- | --- | --- |
| `endpoint` | derived from transport | Relay or ingestion endpoint. |
| `transportMode` | inferred | Explicit `"relay"` or `"direct"` transport selection. Use `"relay"` for absolute backend relay URLs. |
| `projectToken` | none | Direct cloud write-only token for frontend-only deployments. Omit when using relay. |
| `service` | `browser-app` | Frontend service name shown on incidents and bundles. |
| `environment` | `development` | Runtime environment such as `production`, `staging`, or `development`. |
| `enabled` | `true` | Disable all capture without removing instrumentation. |
| `redactFields` | common sensitive fields | Additional field names to redact. |
| `sampleRate` | `1.0` | Per-event sampling rate. |
| `sessionSampleRate` | `1.0` | Per-session capture sampling rate. |
| `batchSize` | `10` | Events per batch before flushing; each send is capped at 256 events so a stalled send retains room for higher-priority events within the 512-event debug queue. |
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
| `requestTimeoutMs` | `5000` | Built-in fetch and keepalive fallback deadline in milliseconds, capped at 60,000. Custom transports must honor their `timeout_ms` request field. |

| `transport` | fetch transport | Custom transport function for tests or advanced routing. |
| `beforeSend` | none | Synchronous-return hook deferred until after capture returns and bounded admission; return an event to keep it or `null` to drop it. |

If the SDK is reconfigured while an old send is still pending, new events are discarded until that send settles. This bounds retained telemetry across configurations; custom transports should honor `timeout_ms` so recovery is prompt.
Repeated unload callbacks share one pending keepalive request per transport lane; ordinary sends resume after it settles. A failed request leaves its events queued for ordinary retry while the page remains active.
Explicit `flush()` waits for existing ordinary and keepalive sends under its shared finite deadline. Records acknowledged by one overlapping sender remain charged to the queue budget until the other sender releases them; late responses cannot requeue records already acknowledged. Both delivery paths honor rate-limit backoff and cap `Retry-After` at five minutes. Built-in direct ingestion requires a valid acknowledgement body; custom transports and legacy relays retain their documented bodyless HTTP-success fallback.
Duplicate-exception suppression summaries are included by automatic timer sends and page-unload delivery as well as explicit `flush()`.
The debug queue has a 512-event/8-MiB cap. Public log and exception capture reject known full-queue pressure before event construction, application context reads, or `beforeSend`; the same priority policy still allows eligible incidents to replace unsent lower-priority events. Accepted hooks run after capture returns, and final serialization enforces the exact byte limit before the next hook is invoked. Under pressure it keeps exceptions and failed requests ahead of ordinary traffic and retains existing ERROR records instead of repeatedly replacing them with later equal-priority logs. Dropped or displaced debug events are counted in one metadata-only `error_suppressed` queue-pressure summary when capacity returns, at most once per 30 seconds. If a later exception burst evicts the unsent summary, its count is retained for the next report. A page that closes before recovery can lose this best-effort summary.

`tracePropagationTargets` is separate from the relay `endpoint`. Same-origin application requests receive trace headers by default. For split frontend/backend deployments, add the backend API origin, such as `https://api.example.com`, when cross-origin first-party requests should receive `X-DebugBundle-Trace-Id` and be eligible for policy-driven request-failure promotion. Third-party absolute URLs are not traced by default.

### AnalyticsBundle Capture

Analytics is opt-in and remains separate from debug capture:

```ts
debugbundle.init({
  transportMode: "relay",
  endpoint: "/debugbundle/browser",
  service: "checkout-web",
  environment: "production",
  analytics: {
    enabled: true,
    trackActions: true
  }
});

debugbundle.analytics.marker("checkout.validation_failed", {
  attempt_bucket: 3
});
```

`marker()` emits a bounded `journey_marker` with a privacy-safe marker key and optional low-cardinality dimensions. `trackActions: true` additionally emits generic structural action keys such as `click.button` and `click.link`; it is independent from debug `captureClicks` and never retains target text, selectors, IDs, URLs, attributes, or form values. `trackFrictionSignals` defaults to true and emits only fixed `friction.repeated_click`, `friction.dead_click`, and `friction.backtrack` markers from bounded in-memory click timing and route reversal heuristics; it never serializes target-derived data. The SDK emits one `session_summary` before a non-persisted `pagehide` and uses the configured transport mode's bounded lifecycle delivery path. It does not emit a summary when a page enters the back-forward cache.

For direct-cloud installs, `privacyMode: "standard"` keeps an opaque first-party anonymous visitor value in browser storage under a key derived from the SHA-256 digest of the public write-only project token. Events contain only a separate SHA-256-derived `visitor_id_hash`, enabling returning-visitor metrics without persisting or emitting the token or raw value. The SDK removes that value when consent is withdrawn or server settings force strict privacy. If browser storage or Web Crypto is unavailable, it safely falls back to session-only analytics. Relay installs remain session-only for visitor identity until the relay has an authenticated project-scope bootstrap; the relay/ingestion path still enforces project settings.

For direct-cloud installs, the SDK explicitly requests the project analytics capture block from `GET /v1/sdk/config` once during initialization. That server block can only restrict a local analytics opt-in: it can disable capture, turn off page/route/action capture, require explicit consent, or force strict privacy. It cannot enable analytics or broaden capture. Relay installs do not fetch it because the browser must not hold a project token.

Handled HTTP responses do not need to throw an exception to become request incidents. A failed response can emit a standalone `request_event` when it is first-party for trace propagation and matches the active capture preset, `immediate_client_error_statuses`, or an `immediate_client_error_path_rules` entry. Unpromoted `4xx` responses remain breadcrumbs/context.

### Local beforeSend hook

Use `beforeSend` for app-owned local policy such as final redaction, tenant-specific suppression, or filtering a browser signal that should never leave the page. Cheap level and policy checks and bounded admission run first. The hook then runs after capture returns, before final project capture rules, sampling, suppression, and transport. It executes on the JavaScript event loop, so the application callback must return promptly.

```ts
debugbundle.init({
  transportMode: "relay",
  endpoint: "/debugbundle/browser",
  service: "web",
  environment: "production",
  beforeSend(event) {
    if (event.event_type === "frontend_exception" && event.payload.message === "Expected local-only error") {
      return null;
    }

    return event;
  }
});
```

If the hook throws or returns an invalid event, the SDK keeps the original event. Browser SDK failures are swallowed so host pages keep running.

## Service naming guidance

Keep the browser service name distinct from backend deployables inside the same DebugBundle project. A common pattern is `checkout-web` for the browser frontend and `checkout-api` for the backend relay host.

When you send through a relay, the browser service name should stay browser-owned. The backend relay should not overwrite it unless you intentionally want a shared surface name.

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
- Browser project tokens are never needed when using relay mode.
- Breadcrumb and probe buffers are in-memory only.

Persistent context is sanitized as a complete snapshot, with at most 256 keys and 128 characters per key, and a 256 KiB combined budget. Unsafe updates are withheld while the previous protected context remains available.

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
  transportMode: "relay",
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

Apache-2.0.

## Browser error evidence

The global hooks retain native and cross-realm error messages, original application stacks and browser source coordinates where available. Resource failures retain a sanitized resource URL. Existing bounded click/form breadcrumbs contain structural selectors and a field count, never form values or page text. Form inspection stops after 1,000 controls. Native getter and instrumentation failures are swallowed.

HTTP(S) stack locations and browser-event page/resource URLs omit credentials, query and fragment. Source file/line/column remain useful. When a browser exposes only `Script error.` for a cross-origin script, its withheld message/stack cannot be recovered by a relay. Configure script CORS and `crossorigin="anonymous"` together where appropriate, initialize capture before application scripts, or pass the real error from an application error boundary. No synthetic SDK listener stack is presented as application evidence.


### Browser resource noise

Resource failures retain their target and page evidence; the server derives resource titles and cross-route grouping without a new capture payload or Bundle version. Noise rules should match the exact resource host/path, service and environment. Treat tracker blocking as a possible cause, not proof of a browser extension or network blocker. Google sign-in and application assets should remain actionable unless an operator explicitly decides otherwise.

Resource `first_party` evaluation compares the captured page and target origins (including scheme and port), rather than assuming every absolute URL is third-party. Absolute targets without a page origin stay unknown; root-relative targets remain same-origin. The SDK preserves external protocol-relative target hosts and strips credentials/query/fragment. Server enforcement remains authoritative for installed older SDKs; SDK-side drop/sample support can reduce transmission after compatible rules are adopted.

### Version 3 callback timing

Version 3 defers optional `beforeSend` callbacks until capture returns. Callbacks still execute on the browser event loop and must return promptly. Pending and finalized events share a bounded queue; overload may drop pending events before their hook runs. Unload delivery includes only finalized events, so call `await sdk.flush()` before intentional navigation when possible. See [the version 3 migration guide](https://github.com/debugbundle/debugbundle-js/blob/main/MIGRATION-3.0.md).
