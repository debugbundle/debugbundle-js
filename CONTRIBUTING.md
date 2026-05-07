# Contributing

## Development Workflow

1. Create a feature branch from `main`.
2. Implement changes using Red/Green TDD.
3. Enable Corepack and install dependencies: `corepack enable && corepack prepare pnpm@10.32.1 --activate && pnpm install`.
4. Run local checks:
   - `pnpm lint`
   - `pnpm typecheck`
   - `pnpm test`
   - `pnpm build`
5. Update docs when package behavior or installation guidance changes.
6. Open a pull request with validation evidence.

## Rules

- Keep the SDK fail-open toward host applications and fail-closed around internal validation.
- Keep framework adapters thin over the shared SDK core.
- Do not reintroduce workspace-owned copies of `@debugbundle/shared-types` or `@debugbundle/redaction` in this repository without a deliberate extraction update.