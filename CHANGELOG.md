# Changelog

## [Unreleased]

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
