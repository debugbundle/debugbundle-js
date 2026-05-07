# Changelog

## [Unreleased]

## [0.1.0] - 2026-05-07

### Added
- Initial JavaScript SDK monorepo with `@debugbundle/sdk-node` (Node.js backend SDK) and `@debugbundle/sdk-browser` (browser SDK).
- Node.js SDK: core `init`, `captureException`, `captureError`, `captureLog`, `captureRequest`, `captureMessage`, `setContext`, `flush`, and `probe` surface with buffered HTTP transport, client-side redaction, duplicate suppression, and probe ring-buffer management.
- Node.js SDK: Express, Fastify, and Next.js relay middleware for automatic request/response capture and scoped context propagation.
- Browser SDK: core capture surface with `fetch`/`XMLHttpRequest` interception, global error and unhandled-rejection hooks, and console-level log capture.
