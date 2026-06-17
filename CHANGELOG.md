# Changelog

## [Unreleased]

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
