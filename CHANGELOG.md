# Changelog

## [Unreleased]

## [1.7.2] - 2026-09-15

### Fixed

- Respect Pino levels, silent mode and log-method hooks; Bunyan levels and enabled probes; Winston levels, silent mode and format filters. Capture each accepted record once.
- Preserve native logger results and errors, isolate recursive capture and SDK callback failures, and safely detach cached/child emitters.

### Changed

- Align Browser SDK and shared dependencies at 1.7.2; browser runtime behavior is unchanged.


## [1.7.1] - 2026-09-14

### Fixed

- Preserve native and cross-realm browser errors, promise rejection reasons, source coordinates and resource identity through guarded fixed-field reads.
- Capture structural click/form breadcrumbs from native DOM fields without reading form values or page text; cap form inspection and preserve page-cache lifecycle behavior.
- Strip credentials, query and fragment from HTTP(S) stack locations, including URLs containing parentheses, while retaining file/line/column; avoid synthetic listener stacks when the browser provides no application error.

## [1.7.0] - 2026-09-13

### Changed

- License the Node and Browser SDKs under Apache 2.0 and ship the complete license in both npm artifacts.
- Consume Apache-licensed shared types and redaction packages at 1.7.0.
- Publish through GitHub Actions trusted publishing without a long-lived npm token.

## [1.6.0] - 2026-07-28

### Fixed

- Reconcile Node and Browser connected ingestion acknowledgements per event, retaining retryable rejections and preventing rejected-only batches from reporting successful delivery.
- Keep browser unload delivery beacon-first while applying acknowledgement reconciliation to the keepalive fallback.
- Remove a consent-withdrawal race that could briefly retain the standard analytics visitor value during asynchronous initialization.

### Changed

- Run browser-global and relay test files serially for deterministic isolation on constrained CI runners.
- Enforce at least 80% statements, branches, functions, and lines for every executable source file in CI and release verification.
- Align the Node and Browser SDKs with `@debugbundle/shared-types@1.6.0` and `@debugbundle/redaction@1.6.0`.

## [1.5.0] - 2026-07-17

### Added

- Corrected the semantic release line for the AnalyticsBundle browser capability: opt-in analytics event capture, journey markers, structural actions, visitor identity, restrictive remote settings, friction signals, and isolated analytics transport are available as a backward-compatible minor release.

## [1.4.1] - 2026-07-16

### Added

- Added `debugbundle.analytics.marker(name, dimensions?)` for bounded, privacy-sanitized semantic journey markers and one unload-safe `session_summary` analytics event on a non-persisted page exit.
- Added default-off `analytics.trackActions` structural browser action capture. It emits fixed generic action keys without target text, selectors, IDs, URLs, attributes, or input values, independently from debug click breadcrumbs.
- Direct browser SDKs now hydrate bounded project analytics settings from the existing SDK-config response as a restrictive overlay that cannot enable analytics or widen local capture.
- Direct browser `analytics.privacyMode: "standard"` now derives a project-scoped first-party anonymous visitor hash for returning-visitor metrics without persisting or emitting the project token or raw visitor value. It falls back safely to session-only capture when browser storage or Web Crypto is unavailable and removes the stored value when consent is withdrawn or settings force strict privacy.
- Added bounded browser friction markers behind `analytics.trackFrictionSignals`: repeated clicks, eligible non-interactive dead clicks, and quick route reversals emit fixed marker keys only, with ephemeral in-memory timing/object identity and restrictive remote settings support.

### Changed

- Aligned the published JS SDK family to `@debugbundle/shared-types@1.4.1` and `@debugbundle/redaction@1.4.1` for the AnalyticsBundle release.

## [1.4.0] - 2026-06-20

### Changed

- Aligned the published JS SDK family to `@debugbundle/shared-types@1.4.0` and `@debugbundle/redaction@1.4.0` so the released Node and Browser SDK packages consume the latest capture-rule suggestion contract and bundle metadata updates from core.

## [1.3.1] - 2026-06-19

### Fixed
- Normalized canonical event-envelope emission across the broader SDK release train by aligning the published JS SDK family to `@debugbundle/shared-types@1.3.1` and `@debugbundle/redaction@1.3.1`.

## [1.3.0] - 2026-06-17

### Fixed
- Browser SDK fetch wrapping now preserves native `Headers`, header tuple arrays, record headers, and `Request` object headers when adding DebugBundle trace headers.

## [1.2.0] - 2026-06-09

### Added
- Added synchronous `beforeSend` hooks to `@debugbundle/sdk-node` and `@debugbundle/sdk-browser` for app-owned local event filtering or final redaction before buffering.
- Browser unhandled-rejection capture now preserves a bounded `rejection_reason` summary when the browser exposes the original rejection value.

### Changed
- Widened the standalone JS SDK repository tooling engine range to Node.js 24 through Node.js 26 and added Node.js 26 to CI.
- Aligned the published shared-package dependencies to `@debugbundle/shared-types@1.2.0` and `@debugbundle/redaction@1.2.0`.

## [1.1.0] - 2026-06-08

### Added
- Browser and Node remote capture-policy handling now supports path-scoped immediate client-error incident rules so explicitly configured `4xx` routes promote to standalone `request_event` incident signals without widening the status globally.

### Changed
- Unpromoted `4xx` browser and backend request telemetry now remains context-only even under repeated traffic, while `5xx` handling and explicitly promoted client-error behavior are preserved.
- Aligned the published shared-package dependencies to `@debugbundle/shared-types@1.1.0` and `@debugbundle/redaction@1.1.0`.

## [1.0.1] - 2026-06-03

### Added
- Browser SDK global error capture now attaches optional sanitized page lifecycle context and resource-target attributes to `frontend_exception.payload.browser_event`, improving opaque `window_error` and `resource_error` bundles without changing existing event fields.

### Fixed
- Node relay validation now accepts and preserves the enriched browser-native error metadata emitted by the browser SDK.
- Aligned the published shared package dependencies to `@debugbundle/shared-types@1.0.1` and `@debugbundle/redaction@1.0.1`.

## [1.0.0] - 2026-05-31

### Changed
- Promoted `@debugbundle/sdk-node` and `@debugbundle/sdk-browser` to the first stable `1.0.0` JavaScript SDK family release.
- Aligned the published shared package dependencies to `@debugbundle/shared-types@1.0.0` and `@debugbundle/redaction@1.0.0`.

## [0.1.11] - 2026-05-29

### Added
- Explicit browser relay transport selection for split frontend and backend deployments, so absolute relay URLs stay on the relay contract instead of falling back to direct-cloud ingestion.

### Fixed
- Added relay preflight handling and matching CORS headers for explicitly allowed split-host browser relay traffic.

## [0.1.8] - 2026-05-19

### Changed
- Node relay handling now enforces the canonical V1 relay request contract with `Content-Type: application/json` and a `batch` body property only, backed by the shared relay compliance fixtures.

## [0.1.7] - 2026-05-19

### Changed
- Declared Node.js 22 as the minimum supported runtime for `@debugbundle/sdk-node` while keeping the standalone SDK repository tooling pinned to Node.js 24.x.

## [0.1.1] - 2026-05-11

### Changed
- Browser SDK network hooks now promote first-party 5xx `fetch`/`XMLHttpRequest` responses to standalone `request_event` incident signals while retaining the network breadcrumb.
- Node SDK capture-policy fallback defaults now match the service policy presets, including 5xx request capture in minimal and balanced modes.

### Fixed
- Node and browser relay handling now accepts browser-originated `request_event` payloads so relay transport supports promoted 5xx request failures.
- Node request capture preserves 5xx request events even when local request-event capture is otherwise disabled.

## [0.1.0] - 2026-05-07

### Added
- Initial JavaScript SDK monorepo with `@debugbundle/sdk-node` (Node.js backend SDK) and `@debugbundle/sdk-browser` (browser SDK).
- Node.js SDK: core `init`, `captureException`, `captureError`, `captureLog`, `captureRequest`, `captureMessage`, `setContext`, `flush`, and `probe` surface with buffered HTTP transport, client-side redaction, duplicate suppression, and probe ring-buffer management.
- Node.js SDK: Express, Fastify, and Next.js relay middleware for automatic request/response capture and scoped context propagation.
- Browser SDK: core capture surface with `fetch`/`XMLHttpRequest` interception, global error and unhandled-rejection hooks, and console-level log capture.
