import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Browser fixtures replace process globals, and relay tests bind transient
    // resources. Run files serially so those application-level boundaries stay
    // isolated and deterministic under constrained CI runners.
    fileParallelism: false,
    include: ["tests/**/*.test.ts"],
    exclude: ["packages/**/dist/**"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      // The Node index is an export-only barrel with no executable statements;
      // package import and typechecking tests cover that public surface.
      exclude: ["packages/**/src/**/*.d.ts", "packages/sdk-node/src/index.ts"],
      reporter: ["text", "json", "json-summary"],
      thresholds: {
        perFile: true,
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80
      }
    }
  }
});
