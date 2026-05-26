import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readJsonFile<T>(relativePath: string): T {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8")) as T;
}

describe("debugbundle-js repository metadata", () => {
  it("includes required standalone governance and tooling files", (): void => {
    const requiredFiles = [
      "CODE_OF_CONDUCT.md",
      "CONTRIBUTING.md",
      "SECURITY.md",
      "eslint.config.mjs",
      "tsconfig.base.json",
      "tsconfig.json",
      "vitest.config.ts",
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug_report.yml",
      ".github/ISSUE_TEMPLATE/feature_request.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml"
    ];

    for (const relativePath of requiredFiles) {
      expect(existsSync(path.join(repoRoot, relativePath)), relativePath).toBe(true);
    }
  });

  it("keeps only sdk-node and sdk-browser as authoritative local packages", (): void => {
    expect(existsSync(path.join(repoRoot, "packages/shared-types"))).toBe(false);
    expect(existsSync(path.join(repoRoot, "packages/redaction"))).toBe(false);

    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const changelog = readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
    const security = readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
    expect(readme).toContain("remain core-owned source");
    expect(readme).toContain("published npm dependencies");
    expect(readme).toContain("published from this repository");
    expect(readme).toContain("npm install @debugbundle/sdk-node");
    expect(readme).toContain("npm install @debugbundle/sdk-browser");
    expect(readme).not.toContain("@debugbundle/sdk-node@next");
    expect(readme).not.toContain("@debugbundle/sdk-browser@next");

    expect(changelog).toContain("## [Unreleased]");
    expect(changelog).toContain("minimum supported runtime for `@debugbundle/sdk-node`");
    expect(changelog).toMatch(/## \[0\.1\.0\] - \d{4}-\d{2}-\d{2}/);
    expect(security).toContain("https://github.com/debugbundle/debugbundle-js/security/advisories/new");

    const issueTemplate = readFileSync(path.join(repoRoot, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8");
    expect(issueTemplate).toContain("Node.js 22");

    const ciWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(ciWorkflow).toContain("sdk-node-runtime:");
    expect(ciWorkflow).toContain('node-version: "22"');
    expect(ciWorkflow).toContain("pnpm install --config.engine-strict=false --frozen-lockfile");
    expect(ciWorkflow).toContain("pnpm --filter @debugbundle/sdk-node build");
    expect(ciWorkflow).toContain("pnpm vitest run tests/packages/sdk-node --config vitest.config.ts");
  });

  it("uses published shared package dependencies instead of workspace links", (): void => {
    const rootPackage = readJsonFile<{
      engines: { node: string };
      scripts: Record<string, string>;
      repository: { url: string };
    }>("package.json");
    const sdkNodePackage = readJsonFile<{
      engines: { node: string };
      private: boolean;
      repository: { url: string };
      dependencies: Record<string, string>;
    }>("packages/sdk-node/package.json");
    const sdkBrowserPackage = readJsonFile<{
      private: boolean;
      repository: { url: string };
      dependencies: Record<string, string>;
    }>("packages/sdk-browser/package.json");

    expect(rootPackage.repository.url).toContain("debugbundle/debugbundle-js");
    expect(rootPackage.engines.node).toBe(">=24 <25");
    expect(rootPackage.scripts).toMatchObject({
      lint: expect.any(String),
      typecheck: expect.any(String),
      test: expect.any(String),
      build: expect.any(String)
    });

    expect(sdkNodePackage.private).toBe(false);
    expect(sdkBrowserPackage.private).toBe(false);
    expect(sdkNodePackage.engines.node).toBe(">=22");
    expect(sdkNodePackage.repository.url).toContain("debugbundle/debugbundle-js");
    expect(sdkBrowserPackage.repository.url).toContain("debugbundle/debugbundle-js");
    expect(sdkNodePackage.dependencies["@debugbundle/shared-types"]).not.toBe("workspace:*");
    expect(sdkNodePackage.dependencies["@debugbundle/redaction"]).not.toBe("workspace:*");
    expect(sdkBrowserPackage.dependencies["@debugbundle/shared-types"]).not.toBe("workspace:*");
    expect(sdkBrowserPackage.dependencies["@debugbundle/redaction"]).not.toBe("workspace:*");

    const sdkNodeReadme = readFileSync(path.join(repoRoot, "packages/sdk-node/README.md"), "utf8");
    expect(sdkNodeReadme).toContain("Requires Node.js 22 or newer.");
  });

  it("keeps the shared release smoke and documentation gates wired for both SDK packages", (): void => {
    const rootPackage = readJsonFile<{
      scripts: Record<string, string>;
    }>("package.json");
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const sdkNodeReadme = readFileSync(path.join(repoRoot, "packages/sdk-node/README.md"), "utf8");
    const sdkBrowserReadme = readFileSync(path.join(repoRoot, "packages/sdk-browser/README.md"), "utf8");
    const ciWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const releaseWorkflow = readFileSync(path.join(repoRoot, ".github/workflows/release.yml"), "utf8");

    expect(existsSync(path.join(repoRoot, "scripts/smoke-release.mjs"))).toBe(true);
    expect(rootPackage.scripts).toMatchObject({
      "smoke:packed": expect.any(String),
      "smoke:registry": expect.any(String)
    });

    expect(ciWorkflow).toContain("pnpm smoke:packed");
    expect(releaseWorkflow).toContain("pnpm smoke:packed");
    expect(releaseWorkflow).toContain("pnpm smoke:registry");

    expect(readme).toContain("capture-policy fields are server-owned");
    expect(readme).toContain("Configuration source precedence");
    expect(readme).toContain("Runtime support labels");
    expect(readme).toContain("Dependency alignment");
    expect(readme).toContain("Service naming guidance");
    expect(readme).toContain("Safe startup behavior");
    expect(readme).toContain("First-event verification");
    expect(readme).toContain("pnpm smoke:packed");

    expect(sdkNodeReadme).toContain("local-only mode");
    expect(sdkNodeReadme).toContain("same-origin relay");
    expect(sdkNodeReadme).toContain("Safe startup behavior");
    expect(sdkNodeReadme).toContain("First-event verification");

    expect(sdkBrowserReadme).toContain("write-only token");
    expect(sdkBrowserReadme).toContain("same-origin relay");
    expect(sdkBrowserReadme).toContain("First-event verification");
  });

  it("derives emitted sdk_version values from the published package versions", (): void => {
    const sdkNodePackage = readJsonFile<{ version: string }>("packages/sdk-node/package.json");
    const sdkBrowserPackage = readJsonFile<{ version: string }>("packages/sdk-browser/package.json");
    const sdkNodeTypes = readFileSync(path.join(repoRoot, "packages/sdk-node/src/types.ts"), "utf8");
    const sdkBrowserTypes = readFileSync(path.join(repoRoot, "packages/sdk-browser/src/types.ts"), "utf8");

    expect(sdkNodeTypes).toContain('import packageJson from "../package.json"');
    expect(sdkNodeTypes).toContain("export const SDK_VERSION = packageJson.version;");
    expect(sdkNodePackage.version).toBe(readJsonFile<{ version: string }>("package.json").version);

    expect(sdkBrowserTypes).toContain('import packageJson from "../package.json"');
    expect(sdkBrowserTypes).toContain("export const SDK_VERSION = packageJson.version;");
    expect(sdkBrowserPackage.version).toBe(readJsonFile<{ version: string }>("package.json").version);
  });
});
