SHELL := /bin/sh
NODE_IMAGE ?= node:24-alpine
NODE_RUN = docker run --rm -v "$(CURDIR):/workspace" --tmpfs /workspace/.tmp -w /workspace $(NODE_IMAGE) sh -lc

.PHONY: release-prepare-check release-packed-check
release-prepare-check:
	$(NODE_RUN) 'corepack enable && corepack prepare pnpm@11.3.0 --activate && pnpm install --no-frozen-lockfile && pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm build && pnpm smoke:packed'

release-packed-check:
	$(NODE_RUN) 'corepack enable && corepack prepare pnpm@11.3.0 --activate && pnpm smoke:packed'
