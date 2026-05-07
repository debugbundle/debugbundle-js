# debugbundle-js

JavaScript SDK monorepo for DebugBundle.

## Packages

| Package | npm Name | Description |
|---------|----------|-------------|
| `packages/sdk-node` | `@debugbundle/sdk-node` | Node.js backend SDK |
| `packages/sdk-browser` | `@debugbundle/sdk-browser` | Browser SDK |

## External Dependencies

`@debugbundle/shared-types` and `@debugbundle/redaction` remain core-owned source in the main DebugBundle repository during the current Phase 22 split. This repository consumes those packages as published npm dependencies rather than treating them as local workspace-owned source.

## Release Ownership

- `@debugbundle/sdk-node` and `@debugbundle/sdk-browser` are published from this repository.
- `@debugbundle/shared-types` and `@debugbundle/redaction` remain core-owned and are published from `debugbundle/debugbundle`.
- Release the core-owned shared packages for a given version before publishing the SDK packages here.
- The SDK packages in this repository ship with the same version.

Install the stable SDK packages with:

```bash
npm install @debugbundle/sdk-node
npm install @debugbundle/sdk-browser
```

Version-pin rollbacks stay explicit:

```bash
npm install @debugbundle/sdk-node@0.1.0
npm install @debugbundle/sdk-browser@0.1.0
```

## Release Checklist

- Add a package-level `README.md` for every publishable SDK package and ensure the publish staging step copies it into the final npm artifact.
- Include `LICENSE` in each staged npm artifact.
- Keep npm provenance disabled unless the repo/source-hosting constraints explicitly support it.
- Validate the staged tarballs before publish.
- Validate a clean install from npm after publish, not only from locally packed tarballs.
- Confirm the matching stable shared-package version is already published from core before releasing the SDK packages here.

## Development

This directory is available here as a local clone of the standalone `debugbundle/debugbundle-js` repository for coordinated multi-repo work.

- Install and validate it as its own pnpm workspace from this directory.
- Keep `sdk-node` and `sdk-browser` as the only authoritative source packages here.
- Treat `@debugbundle/shared-types` and `@debugbundle/redaction` as published dependencies owned from core until a later deliberate extraction moves them.
