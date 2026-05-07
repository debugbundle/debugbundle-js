import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const outputRoot = path.resolve(process.argv[2] ?? ".tmp/npm-release");

const packageDefinitions = [
  {
    sourceDir: "packages/sdk-node",
    outputDir: "sdk-node",
    readmePath: "packages/sdk-node/README.md",
    exportMap: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      },
      "./relay": {
        types: "./dist/relay.d.ts",
        import: "./dist/relay.js"
      },
      "./relay/express": {
        types: "./dist/relay-express.d.ts",
        import: "./dist/relay-express.js"
      },
      "./relay/fastify": {
        types: "./dist/relay-fastify.d.ts",
        import: "./dist/relay-fastify.js"
      },
      "./relay/nextjs": {
        types: "./dist/relay-nextjs.d.ts",
        import: "./dist/relay-nextjs.js"
      }
    }
  },
  {
    sourceDir: "packages/sdk-browser",
    outputDir: "sdk-browser",
    readmePath: "packages/sdk-browser/README.md",
    exportMap: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js"
      }
    }
  }
];

const coreOwnedDependencies = new Set(["@debugbundle/shared-types", "@debugbundle/redaction"]);

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function copyOptionalFile(relativePath, outputDir, fileName) {
  if (relativePath === undefined) {
    return;
  }

  const sourcePath = path.join(repoRoot, relativePath);
  if (!existsSync(sourcePath)) {
    return;
  }

  cpSync(sourcePath, path.join(outputDir, fileName));
}

rmSync(outputRoot, { recursive: true, force: true });
mkdirSync(outputRoot, { recursive: true });

for (const definition of packageDefinitions) {
  const sourcePackageJson = readJson(path.join(definition.sourceDir, "package.json"));
  const distAbsoluteDir = path.join(repoRoot, definition.sourceDir, "dist");

  if (!existsSync(distAbsoluteDir)) {
    throw new Error(`missing build output for ${sourcePackageJson.name}: ${distAbsoluteDir}`);
  }

  const outputDir = path.join(outputRoot, definition.outputDir);
  mkdirSync(outputDir, { recursive: true });
  cpSync(distAbsoluteDir, path.join(outputDir, "dist"), { recursive: true });
  copyOptionalFile(definition.readmePath, outputDir, "README.md");
  copyOptionalFile("LICENSE", outputDir, "LICENSE");

  const publishDependencies = Object.fromEntries(
    Object.entries(sourcePackageJson.dependencies ?? {}).map(([dependencyName, dependencyVersion]) => {
      if (coreOwnedDependencies.has(dependencyName)) {
        return [dependencyName, sourcePackageJson.version];
      }

      return [dependencyName, dependencyVersion];
    })
  );

  const publishPackageJson = {
    name: sourcePackageJson.name,
    version: sourcePackageJson.version,
    private: false,
    type: "module",
    license: sourcePackageJson.license,
    description: sourcePackageJson.description,
    repository: sourcePackageJson.repository,
    bugs: sourcePackageJson.bugs,
    homepage: sourcePackageJson.homepage,
    files: ["dist", "README.md", "LICENSE"],
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: definition.exportMap,
    publishConfig: {
      access: "public"
    },
    dependencies: publishDependencies
  };

  writeFileSync(path.join(outputDir, "package.json"), `${JSON.stringify(publishPackageJson, null, 2)}\n`);
}