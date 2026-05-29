import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { debugBundleRelay } from "../../../packages/sdk-node/src/relay-express.js";
import { debugBundleRelayPlugin } from "../../../packages/sdk-node/src/relay-fastify.js";
import { createNextjsRelayHandler } from "../../../packages/sdk-node/src/relay-nextjs.js";

type PackageJsonLike = {
  exports?: Record<string, string>;
};

function readPackageJson(): PackageJsonLike {
  return JSON.parse(fs.readFileSync(new URL("../../../packages/sdk-node/package.json", import.meta.url), "utf8")) as PackageJsonLike;
}

function createBrowserRequestBody(): string {
  return JSON.stringify({
    batch: [
      {
        schema_version: "2026-03-01",
        event_id: "00000000-0000-4000-8000-000000000401",
        event_type: "frontend_exception",
        sdk_name: "spoofed-browser-sdk",
        sdk_version: "0.1.0",
        service: {
          name: "checkout-web",
          environment: "production",
          runtime: "browser",
          framework: "react"
        },
        occurred_at: "2026-03-22T10:00:00.000Z",
        correlation: {
          request_id: null,
          trace_id: "550e8400-e29b-41d4-a716-446655440000",
          session_id: null,
          user_id_hash: null
        },
        payload: {
          name: "TypeError",
          message: "Checkout button failed",
          stack: "TypeError: Checkout button failed\n    at onClick (checkout.tsx:10:5)",
          route: "/checkout",
          browser: {
            name: "Chrome",
            version: "135.0.0"
          }
        }
      }
    ]
  });
}

function relayHeaders(): Record<string, string> {
  return {
    host: "app.example.com",
    origin: "https://app.example.com",
    "content-type": "application/json"
  };
}

describe("sdk-node relay adapters", () => {
  it("declares relay subpath exports in the sdk-node package manifest", () => {
    const packageJson = readPackageJson();

    expect(packageJson.exports).toMatchObject({
      ".": "./src/index.ts",
      "./relay": "./src/relay.ts",
      "./relay/express": "./src/relay-express.ts",
      "./relay/fastify": "./src/relay-fastify.ts",
      "./relay/nextjs": "./src/relay-nextjs.ts"
    });
  });

  it("writes accepted browser events through the Express adapter in local-only mode", async () => {
    const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-express-"));

    try {
      const middleware = debugBundleRelay({
        projectMode: "local-only",
        localEventsDir: eventsDir
      });
      const json = vi.fn();
      const end = vi.fn();
      const set = vi.fn();
      const status = vi.fn(() => ({ json, end }));
      const response = {
        set,
        status
      };

      await middleware(
        {
          method: "POST",
          headers: relayHeaders(),
          body: JSON.parse(createBrowserRequestBody()),
          ip: "127.0.0.1"
        },
        response as unknown as {
          status: (code: number) => { json: (body: unknown) => void; end: () => void };
        }
      );

      expect(status).toHaveBeenCalledWith(202);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          "access-control-allow-origin": "https://app.example.com",
          vary: "Origin"
        })
      );
      expect(json).toHaveBeenCalledWith({ accepted: 1, rejected: 0, errors: [] });
      expect(fs.readdirSync(eventsDir).filter((fileName) => fileName.endsWith(".events.json"))).toHaveLength(1);
    } finally {
      fs.rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  it("answers Express relay OPTIONS preflight with CORS headers", async () => {
    const middleware = debugBundleRelay({ allowedOrigins: ["https://web.example.com"] });
    const end = vi.fn();
    const set = vi.fn();
    const status = vi.fn(() => ({ end }));

    await middleware(
      {
        method: "OPTIONS",
        headers: {
          host: "api.example.com",
          origin: "https://web.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        },
        body: undefined,
        ip: "127.0.0.1"
      },
      { set, status } as unknown as {
        set: (headers: Record<string, string>) => void;
        status: (code: number) => { end: () => void };
      }
    );

    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        "access-control-allow-origin": "https://web.example.com",
        "access-control-allow-methods": "POST, OPTIONS"
      })
    );
    expect(status).toHaveBeenCalledWith(204);
    expect(end).toHaveBeenCalled();
  });

  it("registers a Fastify POST /debugbundle/browser route that writes local-only relay files", async () => {
    const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-fastify-"));

    try {
      const routes: Array<{ method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<void> | void }> = [];
      const fastify = {
        route: vi.fn((definition: { method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<void> | void }) => {
          routes.push(definition);
        })
      };

      debugBundleRelayPlugin(
        fastify as unknown as {
          route: (definition: { method: "POST" | "OPTIONS"; url: string; handler: (request: unknown, reply: unknown) => Promise<void> }) => void;
        },
        {
          projectMode: "local-only",
          localEventsDir: eventsDir
        },
        vi.fn()
      );

      expect(routes).toHaveLength(2);
      const postRoute = routes.find((route) => route.method === "POST");
      expect(postRoute).toMatchObject({
        method: "POST",
        url: "/debugbundle/browser"
      });
      expect(routes.find((route) => route.method === "OPTIONS")).toMatchObject({
        method: "OPTIONS",
        url: "/debugbundle/browser"
      });

      const send = vi.fn();
      const code = vi.fn(() => ({ send }));
      const header = vi.fn();

      await postRoute?.handler(
        {
          method: "POST",
          headers: relayHeaders(),
          body: JSON.parse(createBrowserRequestBody()),
          ip: "127.0.0.1"
        },
        {
          header,
          code
        }
      );

      expect(code).toHaveBeenCalledWith(202);
      expect(header).toHaveBeenCalledWith("access-control-allow-origin", "https://app.example.com");
      expect(send).toHaveBeenCalledWith({ accepted: 1, rejected: 0, errors: [] });
      expect(fs.readdirSync(eventsDir).filter((fileName) => fileName.endsWith(".events.json"))).toHaveLength(1);
    } finally {
      fs.rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  it("registers a Fastify OPTIONS preflight route", async () => {
    const routes: Array<{ method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<void> | void }> = [];
    const fastify = {
      route: vi.fn((definition: { method: string; url: string; handler: (request: unknown, reply: unknown) => Promise<void> | void }) => {
        routes.push(definition);
      })
    };

    debugBundleRelayPlugin(
      fastify as unknown as {
        route: (definition: { method: "OPTIONS" | "POST"; url: string; handler: (request: unknown, reply: unknown) => Promise<void> }) => void;
      },
      {
        allowedOrigins: ["https://web.example.com"]
      },
      vi.fn()
    );

    const optionsRoute = routes.find((route) => route.method === "OPTIONS");
    const send = vi.fn();
    const code = vi.fn(() => ({ send }));
    const header = vi.fn();

    await optionsRoute?.handler(
      {
        method: "OPTIONS",
        headers: {
          host: "api.example.com",
          origin: "https://web.example.com",
          "access-control-request-method": "POST"
        },
        ip: "127.0.0.1"
      },
      { header, code }
    );

    expect(header).toHaveBeenCalledWith("access-control-allow-origin", "https://web.example.com");
    expect(code).toHaveBeenCalledWith(204);
    expect(send).toHaveBeenCalledWith(undefined);
  });

  it("returns a Next.js POST handler that writes local-only relay files", async () => {
    const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-nextjs-"));

    try {
      const handler = createNextjsRelayHandler({
        projectMode: "local-only",
        localEventsDir: eventsDir
      });

      const response = await handler(
        new Request("https://app.example.com/debugbundle/browser", {
          method: "POST",
          headers: relayHeaders(),
          body: createBrowserRequestBody()
        })
      );

      expect(response.status).toBe(202);
      await expect(response.json()).resolves.toEqual({ accepted: 1, rejected: 0, errors: [] });
      expect(fs.readdirSync(eventsDir).filter((fileName) => fileName.endsWith(".events.json"))).toHaveLength(1);
    } finally {
      fs.rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  it("returns a Next.js OPTIONS handler response with CORS headers", async () => {
    const handler = createNextjsRelayHandler({ allowedOrigins: ["https://web.example.com"] });

    const response = await handler(
      new Request("https://api.example.com/debugbundle/browser", {
        method: "OPTIONS",
        headers: {
          host: "api.example.com",
          origin: "https://web.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type"
        }
      })
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://web.example.com");
    expect(response.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});