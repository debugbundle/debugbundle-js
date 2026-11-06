SHELL := /bin/sh
NODE_IMAGE ?= node:24-alpine
COREPACK_SETUP = if ! command -v corepack >/dev/null 2>&1; then npm install --global corepack@0.34.1 >/dev/null; fi && corepack enable
NODE_RUN = docker run --rm -v "$(CURDIR):/workspace" --tmpfs /workspace/.tmp -w /workspace $(NODE_IMAGE) sh -lc

.PHONY: test-focused check
.PHONY: native-runtime-check
native-runtime-check:
	$(NODE_RUN) 'node scripts/check-native-runtime.mjs'

.PHONY: install-dependencies
install-dependencies:
	$(NODE_RUN) '$(COREPACK_SETUP) && corepack pnpm install --no-frozen-lockfile'

test-focused:
	$(NODE_RUN) '$(COREPACK_SETUP) && corepack pnpm vitest run $(TEST_FILES)'

check:
	$(NODE_RUN) '$(COREPACK_SETUP) && corepack pnpm lint && corepack pnpm typecheck && corepack pnpm test:coverage && corepack pnpm build && corepack pnpm smoke:packed'

.PHONY: release-prepare-check release-packed-check
release-prepare-check:
	$(NODE_RUN) '$(COREPACK_SETUP) && corepack prepare pnpm@11.3.0 --activate && pnpm install --no-frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build && pnpm smoke:packed'

release-packed-check:
	$(NODE_RUN) '$(COREPACK_SETUP) && corepack prepare pnpm@11.3.0 --activate && pnpm smoke:packed'
