import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const mode = process.argv[2];

if (mode !== "packed" && mode !== "registry") {
  throw new Error(`unsupported_smoke_mode:${String(mode)}`);
}

const sdkNodePackage = readJson("packages/sdk-node/package.json");
const sdkBrowserPackage = readJson("packages/sdk-browser/package.json");

if (sdkNodePackage.version !== sdkBrowserPackage.version) {
  throw new Error(`mismatched_sdk_versions:${sdkNodePackage.version}:${sdkBrowserPackage.version}`);
}

const releaseVersion = process.env.DEBUGBUNDLE_SMOKE_VERSION?.trim() || sdkNodePackage.version;
const sharedPackageVersion = sdkNodePackage.dependencies["@debugbundle/shared-types"];
const redactionPackageVersion = sdkNodePackage.dependencies["@debugbundle/redaction"];
const serverProjectToken = "dbundle_proj_smoke_server";
const preparedPackagesDir = path.join(repoRoot, ".tmp", "npm-release");
const npmPackagesDir = path.join(repoRoot, ".tmp", "npm-packages");

async function main() {
  if (mode === "packed") {
    preparePackedArtifacts();
  } else {
    await waitForPublishedPackages();
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "debugbundle-js-smoke-"));

  try {
    writeFileSync(
      path.join(tempDir, "package.json"),
      `${JSON.stringify(
        {
          name: "debugbundle-js-release-smoke",
          private: true,
          type: "module"
        },
        null,
        2
      )}\n`
    );

    installSmokeDependencies(tempDir);
    writeFileSync(path.join(tempDir, "smoke.mjs"), buildSmokeScript({ releaseVersion, serverProjectToken }));
    runCommand(process.execPath, [path.join(tempDir, "smoke.mjs")], { cwd: tempDir });
    console.log("installed Node/Browser delivery and privacy canaries passed");
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function preparePackedArtifacts() {
  rmSync(preparedPackagesDir, { recursive: true, force: true });
  rmSync(npmPackagesDir, { recursive: true, force: true });
  mkdirSync(path.dirname(preparedPackagesDir), { recursive: true });

  runCommand(process.execPath, [path.join(repoRoot, "scripts/prepare-release.mjs"), ".tmp/npm-release"], {
    cwd: repoRoot
  });

  mkdirSync(npmPackagesDir, { recursive: true });
  runCommand("npm", ["pack", path.join(preparedPackagesDir, "sdk-node"), "--pack-destination", npmPackagesDir], {
    cwd: repoRoot
  });
  runCommand("npm", ["pack", path.join(preparedPackagesDir, "sdk-browser"), "--pack-destination", npmPackagesDir], {
    cwd: repoRoot
  });
}

function installSmokeDependencies(tempDir) {
  const installArgs = ["install", "--prefix", tempDir, "--no-package-lock", "express@5.1.0"];

  if (mode === "packed") {
    const localRedactionPackage = process.env.DEBUGBUNDLE_SMOKE_REDACTION_TARBALL?.trim();
    const localSharedPackage = process.env.DEBUGBUNDLE_SMOKE_SHARED_TYPES_TARBALL?.trim();
    installArgs.push(
      localSharedPackage || `@debugbundle/shared-types@${sharedPackageVersion}`,
      localRedactionPackage || `@debugbundle/redaction@${redactionPackageVersion}`,
      path.join(npmPackagesDir, `debugbundle-sdk-node-${releaseVersion}.tgz`),
      path.join(npmPackagesDir, `debugbundle-sdk-browser-${releaseVersion}.tgz`)
    );
  } else {
    installArgs.push(
      `@debugbundle/shared-types@${sharedPackageVersion}`,
      `@debugbundle/redaction@${redactionPackageVersion}`,
      `@debugbundle/sdk-node@${releaseVersion}`,
      `@debugbundle/sdk-browser@${releaseVersion}`
    );
  }

  runCommand("npm", installArgs, { cwd: repoRoot });
}

async function waitForPublishedPackages() {
  const packageNames = ["@debugbundle/sdk-node", "@debugbundle/sdk-browser"];

  for (const packageName of packageNames) {
    let published = false;

    for (let attempt = 1; attempt <= 30; attempt += 1) {
      const result = spawnSync("npm", ["view", `${packageName}@${releaseVersion}`, "version"], {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: "pipe"
      });

      if (result.status === 0) {
        process.stdout.write(result.stdout);
        published = true;
        break;
      }

      if (attempt < 30) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
      }
    }

    if (!published) {
      throw new Error(`package_not_visible_on_registry:${packageName}@${releaseVersion}`);
    }
  }
}

function buildSmokeScript(input) {
  return `import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { once } from "node:events";

import express from "express";
import { createDebugBundleSdk } from "@debugbundle/sdk-node";
import { debugBundleRelay } from "@debugbundle/sdk-node/relay/express";
import { createDebugBundleBrowserSdk } from "@debugbundle/sdk-browser";

const releaseVersion = ${JSON.stringify(input.releaseVersion)};
const serverProjectToken = ${JSON.stringify(input.serverProjectToken)};

// The installed SDK handles application errors. A failing smoke assertion must
// still terminate the test instead of becoming another captured SDK event.
const failSmoke = (error) => {
  console.error("installed_consumer_failed", error instanceof Error ? error.message : "unknown");
  process.exit(1);
};
process.on("uncaughtExceptionMonitor", failSmoke);
process.on("unhandledRejection", failSmoke);
setTimeout(() => failSmoke(new Error("installed_consumer_timeout")), 30_000).unref();

const ingestionRequests = [];
const relayRequests = [];
let sawNodeMessageEvent = false;
let sawBrowserExceptionEvent = false;
let sawBrowserResourceErrorEvent = false;
let sawBrowserDirectUnloadEvent = false;

function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value
  });
}

const ingestionServer = createHttpServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/events") {
    response.statusCode = 404;
    response.end();
    return;
  }

  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  assert.doesNotMatch(rawBody, /PACKED_(?:SOURCE|HOOK)_SECRET/);
  const parsedBody = JSON.parse(rawBody);
  assert.equal(request.headers.authorization, \`Bearer \${serverProjectToken}\`);
  assert.ok(Array.isArray(parsedBody.events));

  for (const event of parsedBody.events) {
    if (
      event.sdk_name === "@debugbundle/sdk-node" &&
      event.event_type === "log_event" &&
      event.payload?.message === "node smoke message"
    ) {
      assert.equal(typeof event.event_id, "string");
      assert.equal(typeof event.occurred_at, "string");
      assert.equal(event.sdk_version, releaseVersion);
      assert.equal(event.service?.name, "smoke-api");
      assert.equal(event.service?.environment, "smoke-test");
      assert.equal(event.correlation?.trace_id, "trace-smoke-node-123");
      assert.equal(event.context?.marker, "safe-hook-marker", "node_hook_marker_missing");
      sawNodeMessageEvent = true;
    }

    if (
      event.sdk_name === "@debugbundle/sdk-browser" &&
      event.event_type === "frontend_exception" &&
      event.payload?.message === "browser smoke exception"
    ) {
      assert.equal(typeof event.event_id, "string");
      assert.equal(typeof event.occurred_at, "string");
      assert.equal(event.sdk_version, releaseVersion);
      assert.equal(event.service?.name, "smoke-web");
      assert.equal(event.service?.environment, "smoke-test");
      assert.equal(event.project_token, serverProjectToken);
      sawBrowserExceptionEvent = true;
    }

    if (
      event.sdk_name === "@debugbundle/sdk-browser" &&
      event.event_type === "frontend_exception" &&
      event.payload?.browser_event?.kind === "resource_error"
    ) {
      assert.equal(event.payload.browser_event.opaque, true);
      assert.equal(event.payload.browser_event.target?.source_url, \`\${appOrigin}/assets/plugin.js\`);
      assert.deepEqual(event.payload.browser_event.target?.attributes, {
        cross_origin: "anonymous",
        async: true,
        defer: false,
        integrity_present: true
      });
      assert.deepEqual(event.payload.browser_event.page, {
        url: \`\${appOrigin}/smoke-browser\`,
        referrer: \`\${appOrigin}/previous\`,
        ready_state: "complete",
        visibility_state: "visible"
      });
      sawBrowserResourceErrorEvent = true;
    }

    if (
      event.sdk_name === "@debugbundle/sdk-browser" &&
      event.event_type === "log_event" &&
      event.payload?.message === "browser direct unload"
    ) {
      assert.equal(event.sdk_version, releaseVersion);
      assert.equal(event.project_token, serverProjectToken);
      sawBrowserDirectUnloadEvent = true;
    }
  }

  ingestionRequests.push({
    headers: request.headers,
    body: parsedBody
  });

  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({
    accepted: parsedBody.events.length,
    rejected: 0,
    errors: [],
    probe_directives: []
  }));
});

ingestionServer.listen(0, "127.0.0.1");
await once(ingestionServer, "listening");
const ingestionAddress = ingestionServer.address();
assert(ingestionAddress !== null && typeof ingestionAddress === "object");
const ingestionOrigin = \`http://127.0.0.1:\${ingestionAddress.port}\`;

const nodeSdk = createDebugBundleSdk();
nodeSdk.init({
  projectToken: serverProjectToken,
  service: "smoke-api",
  environment: "smoke-test",
  endpoint: \`\${ingestionOrigin}/v1/events\`,
  beforeSend(event) {
    assert.doesNotMatch(JSON.stringify(event), /PACKED_SOURCE_SECRET/);
    event.context = { marker: "safe-hook-marker", password: "PACKED_HOOK_SECRET" };
    return event;
  }
});

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(nodeSdk.express());

app.get("/smoke-node", (_request, response) => {
  nodeSdk.captureMessage("node smoke message", "error", {
    source: "smoke-route", password: "PACKED_SOURCE_SECRET"
  });
  response.status(200).json({ ok: true });
});

app.post(
  "/debugbundle/browser",
  (request, _response, next) => {
    relayRequests.push({
      headers: request.headers,
      body: request.body
    });
    next();
  },
  debugBundleRelay({
    projectToken: serverProjectToken,
    endpoint: \`\${ingestionOrigin}/v1/events\`,
    allowedOrigins: [],
    service: undefined,
    environment: undefined
  })
);

const appServer = createHttpServer(app);
appServer.listen(0, "127.0.0.1");
await once(appServer, "listening");
const appAddress = appServer.address();
assert(appAddress !== null && typeof appAddress === "object");
const appOrigin = \`http://127.0.0.1:\${appAddress.port}\`;

const nodeResponse = await fetch(\`\${appOrigin}/smoke-node\`, {
  headers: {
    "x-debugbundle-trace-id": "trace-smoke-node-123",
    connection: "close"
  }
});
assert.equal(nodeResponse.status, 200);
await nodeSdk.flush();

const nativeFetch = globalThis.fetch.bind(globalThis);
const directUnloadRequests = [];
const windowListeners = new Map();
const documentListeners = new Map();

defineGlobal("window", {
  innerWidth: 1280,
  innerHeight: 720,
  devicePixelRatio: 2,
  addEventListener(type, handler) {
    windowListeners.set(type, handler);
  },
  removeEventListener(type) {
    windowListeners.delete(type);
  }
});
defineGlobal("document", {
  readyState: "complete",
  referrer: \`\${appOrigin}/previous?token=secret#hash\`,
  visibilityState: "visible",
  addEventListener(type, handler) {
    documentListeners.set(type, handler);
  },
  removeEventListener(type) {
    documentListeners.delete(type);
  }
});
defineGlobal("history", {
  pushState() {},
  replaceState() {}
});
defineGlobal("location", {
  href: \`\${appOrigin}/smoke-browser?token=secret#hash\`,
  pathname: "/smoke-browser",
  search: "?token=secret"
});
defineGlobal("navigator", {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  language: "en-US",
  maxTouchPoints: 0,
  connection: {
    effectiveType: "4g"
  },
  sendBeacon() {
    throw new Error("direct_unload_must_not_use_beacon");
  }
});
defineGlobal("screen", {
  width: 1440,
  height: 900
});
defineGlobal("matchMedia", () => ({ matches: false }));
defineGlobal("fetch", async (input, init = {}) => {
  const isRelativePath = typeof input === "string" && input.startsWith("/");
  const requestUrl = isRelativePath ? new URL(input, appOrigin).toString() : input;
  if (requestUrl === \`\${ingestionOrigin}/v1/events\` && init.keepalive) {
    directUnloadRequests.push({ headers: new Headers(init.headers ?? {}), body: init.body });
  }
  const headers = new Headers(init.headers ?? {});
  if (isRelativePath) {
    headers.set("origin", appOrigin);
    headers.set("referer", \`\${appOrigin}/smoke-browser\`);
    headers.set("connection", "close");
  }

  return nativeFetch(requestUrl, {
    ...init,
    headers
  });
});

const browserSdk = createDebugBundleBrowserSdk();
browserSdk.init({
  endpoint: "/debugbundle/browser",
  service: "smoke-web",
  environment: "smoke-test",
  captureNetwork: false,
  captureClicks: false,
  captureRouteChanges: false,
  captureConsole: false,
  flushInterval: 60_000,
  beforeSend(event) {
    assert.doesNotMatch(JSON.stringify(event), /PACKED_SOURCE_SECRET/);
    event.context = { marker: "safe-hook-marker", password: "PACKED_HOOK_SECRET" };
    return event;
  }
});
browserSdk.setContext("password", "PACKED_SOURCE_SECRET");
browserSdk.captureException(new Error("browser smoke exception"));
const browserErrorHandler = windowListeners.get("error");
assert.equal(typeof browserErrorHandler, "function");
browserErrorHandler({
  message: "Script error.",
  filename: \`\${appOrigin}/assets/app.js?token=secret#hash\`,
  lineno: 12,
  colno: 34,
  target: {
    tagName: "SCRIPT",
    src: \`\${appOrigin}/assets/plugin.js?token=secret#hash\`,
    crossOrigin: "anonymous",
    async: true,
    defer: false,
    integrity: "sha384-smoke"
  }
});
await browserSdk.flush();
browserSdk.dispose();

const directBrowserSdk = createDebugBundleBrowserSdk();
directBrowserSdk.init({
  projectToken: serverProjectToken,
  transportMode: "direct",
  endpoint: \`\${ingestionOrigin}/v1/events\`,
  service: "smoke-web",
  environment: "smoke-test",
  captureNetwork: false,
  captureClicks: false,
  captureRouteChanges: false,
  captureConsole: false,
  flushInterval: 60_000
});
directBrowserSdk.captureMessage("browser direct unload", "error");
const pagehideHandler = windowListeners.get("pagehide");
assert.equal(typeof pagehideHandler, "function");
pagehideHandler({ persisted: false });
for (let attempt = 0; attempt < 100 && !sawBrowserDirectUnloadEvent; attempt += 1) {
  await new Promise(resolve => setTimeout(resolve, 25));
}
assert.equal(sawBrowserDirectUnloadEvent, true);
assert.equal(directUnloadRequests.length, 1);
assert.equal(directUnloadRequests[0].headers.get("authorization"), \`Bearer \${serverProjectToken}\`);
assert.ok(Buffer.byteLength(directUnloadRequests[0].body) <= 60 * 1024);
directBrowserSdk.dispose();

defineGlobal("fetch", nativeFetch);
nodeSdk.dispose();

assert.equal(relayRequests.length, 1);
const relayRequest = relayRequests[0];
assert.doesNotMatch(JSON.stringify(relayRequest.body), /PACKED_(?:SOURCE|HOOK)_SECRET/);
assert.equal(relayRequest.body.batch[0].context?.marker, "safe-hook-marker", "browser_hook_marker_missing");
assert.equal(relayRequest.headers.authorization, undefined);
assert.ok(Array.isArray(relayRequest.body.batch));
assert.equal(relayRequest.body.batch.length, 2);
assert.equal(relayRequest.body.batch[0].project_token, undefined);
assert.equal(relayRequest.body.batch[0].service.name, "smoke-web");
assert.ok(ingestionRequests.length >= 2);
assert.equal(sawNodeMessageEvent, true);
assert.equal(sawBrowserExceptionEvent, true);
assert.equal(sawBrowserResourceErrorEvent, true);
assert.equal(sawBrowserDirectUnloadEvent, true);

ingestionServer.closeAllConnections?.();
appServer.closeAllConnections?.();
ingestionServer.close();
appServer.close();
process.exit(0);
`;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
}

function runCommand(command, args, options) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: "inherit",
    timeout: options.timeout ?? 300_000
  });

  if (result.status !== 0) {
    throw new Error(`command_failed:${command}:${result.status ?? "signal"}`);
  }
}

await main();
