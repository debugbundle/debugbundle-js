import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { EventEnvelopeSchema, createEventEnvelope, type EventEnvelope } from "@debugbundle/shared-types";
import { createBrowserRelay, type BrowserRelayAcceptedBatch } from "../../../packages/sdk-node/src/relay.js";

type RelayComplianceFixtureRequest = {
  method: string;
  headers: Record<string, string>;
  ipAddress?: string;
  bodyJson?: unknown;
  bodyText?: string;
};

type RelayComplianceFixtureCase = {
  id: string;
  kind: string;
  request?: RelayComplianceFixtureRequest;
  expected?: {
    status: number;
    accepted?: number;
    rejected?: number;
    errors?: string[];
  };
  expectedEventFile?: EventEnvelope[];
};

const relayComplianceFixturePath = new URL("../../fixtures/relay-compliance.json", import.meta.url);
const relayComplianceFixtures = JSON.parse(fs.readFileSync(relayComplianceFixturePath, "utf8")) as {
  version: number;
  cases: RelayComplianceFixtureCase[];
};

function getRelayComplianceFixture(id: string): RelayComplianceFixtureCase {
  const fixture = relayComplianceFixtures.cases.find((candidate) => candidate.id === id);
  if (fixture === undefined) {
    throw new Error(`Missing relay compliance fixture: ${id}`);
  }

  return fixture;
}

function createFrontendExceptionEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return createEventEnvelope({
    event_id: "00000000-0000-4000-8000-000000000201",
    occurred_at: "2026-03-22T10:00:00.000Z",
    event_type: "frontend_exception",
    project_token: "dbundle_proj_browser",
    sdk_name: "evil-browser-sdk",
    sdk_version: "1.2.3",
    service: {
      name: "checkout-web",
      runtime: "browser",
      framework: "react",
      environment: "production"
    },
    correlation: {
      request_id: null,
      trace_id: "11111111-1111-4111-8111-111111111111",
      session_id: null,
      user_id_hash: null
    },
    payload: {
      name: "TypeError",
      message: "Cannot read properties of undefined",
      stack: "TypeError: Cannot read properties of undefined\n    at CheckoutButton.tsx:12:5",
      route: "/checkout",
      browser: {
        name: "Chrome",
        version: "135.0.0"
      },
      breadcrumbs: [
        {
          breadcrumb_type: "route_change",
          route: "/checkout",
          data: {},
          ts: "2026-03-22T09:59:59.000Z"
        }
      ],
      device: {
        user_agent: "Mozilla/5.0",
        os: {
          name: "macOS",
          version: "15.0"
        },
        device_type: "desktop",
        screen: {
          width: 1728,
          height: 1117
        },
        viewport: {
          width: 1440,
          height: 900
        },
        device_pixel_ratio: 2,
        touch_capable: false,
        language: "en-US",
        connection_type: "4g",
        color_scheme_preference: "light"
      },
      dom_context: {
        mode: "lightweight",
        html_excerpt: "<button>Checkout</button>"
      }
    },
    ...overrides
  });
}

function createBrowserRequestEvent(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return createEventEnvelope({
    event_id: "00000000-0000-4000-8000-000000000203",
    occurred_at: "2026-03-22T10:02:00.000Z",
    event_type: "request_event",
    project_token: "dbundle_proj_browser",
    sdk_name: "@debugbundle/sdk-browser",
    sdk_version: "1.2.3",
    service: {
      name: "checkout-web",
      runtime: "browser",
      framework: null,
      environment: "production"
    },
    correlation: {
      request_id: null,
      trace_id: "22222222-2222-4222-8222-222222222222",
      session_id: null,
      user_id_hash: null
    },
    payload: {
      method: "POST",
      path: "/v1/billing/checkout",
      query: { plan: "team" },
      headers: {},
      response_status: 503,
      duration_ms: 84
    },
    ...overrides
  });
}

function createBrowserRelayRequest(input: {
  batch?: unknown[];
  headers?: Record<string, string>;
  ipAddress?: string;
  body?: string;
} = {}): {
  headers: Record<string, string>;
  body: string;
  ipAddress: string;
} {
  return {
    headers: {
      "content-type": "application/json; charset=utf-8",
      host: "app.example.com",
      origin: "https://app.example.com",
      ...input.headers
    },
    body: input.body ?? JSON.stringify({ batch: input.batch ?? [createFrontendExceptionEvent()] }),
    ipAddress: input.ipAddress ?? "203.0.113.10"
  };
}

function createBrowserRelayRequestFromFixture(request: RelayComplianceFixtureRequest): {
  headers: Record<string, string>;
  body: string;
  ipAddress: string;
} {
  return {
    headers: request.headers,
    body: request.bodyText ?? JSON.stringify(request.bodyJson ?? { batch: [] }),
    ipAddress: request.ipAddress ?? "203.0.113.10"
  };
}

describe("createBrowserRelay", () => {
  it("accepts valid browser events and strips trust-sensitive fields before handing them off", async () => {
    const fixture = getRelayComplianceFixture("credential-smuggling-payload");
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });
    const request = createBrowserRelayRequestFromFixture(fixture.request ?? { method: "POST", headers: {} });

    const response = await relay(request);

    expect(response).toEqual({
      status: fixture.expected?.status ?? 202,
      body: {
        accepted: fixture.expected?.accepted ?? 1,
        rejected: fixture.expected?.rejected ?? 0,
        errors: fixture.expected?.errors ?? []
      }
    });
    expect(onAccept).toHaveBeenCalledTimes(1);

    const accepted = onAccept.mock.calls[0]?.[0];
    expect(accepted?.events).toHaveLength(1);
    expect(accepted?.headers["authorization"]).toBeUndefined();
    expect(accepted?.headers["cookie"]).toBeUndefined();
    expect(accepted?.headers["x-api-key"]).toBeUndefined();
    expect(accepted?.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(accepted?.events[0]).toMatchObject(fixture.expectedEventFile?.[0] ?? {});
    expect("project_token" in (accepted?.events[0] ?? {})).toBe(false);
    expect("organization_id" in (accepted?.events[0] ?? {})).toBe(false);
  });

  it("rejects non-browser event types while still accepting valid browser events in the same batch", async () => {
    const fixture = getRelayComplianceFixture("mixed-valid-invalid-batch");
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });
    const response = await relay(createBrowserRelayRequestFromFixture(fixture.request ?? { method: "POST", headers: {} }));

    expect(response.status).toBe(fixture.expected?.status ?? 400);
    expect(response.body).toEqual({
      accepted: fixture.expected?.accepted ?? 1,
      rejected: fixture.expected?.rejected ?? 1,
      errors: fixture.expected?.errors ?? []
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0]?.[0].events).toHaveLength(1);
    expect(onAccept.mock.calls[0]?.[0].events[0]?.event_type).toBe("frontend_exception");
  });

  it("accepts browser-native exception metadata from relay batches", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });
    const event = createFrontendExceptionEvent();
    (event.payload as Record<string, unknown>)["browser_event"] = {
      kind: "resource_error",
      message: null,
      file_name: null,
      line_number: null,
      column_number: null,
      target: {
        tag_name: "script",
        source_url: "https://cdn.example/app.js"
      },
      opaque: true
    };

    const response = await relay(
      createBrowserRelayRequest({
        batch: [event]
      })
    );

    expect(response.status).toBe(202);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0]?.[0].events[0]).toMatchObject({
      event_type: "frontend_exception",
      payload: {
        browser_event: {
          kind: "resource_error",
          target: {
            source_url: "https://cdn.example/app.js"
          }
        }
      }
    });
  });

  it("accepts browser request_event payloads for relay-mode request failure incidents", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });

    const response = await relay(
      createBrowserRelayRequest({
        batch: [createBrowserRequestEvent()]
      })
    );

    expect(response).toEqual({
      status: 202,
      body: {
        accepted: 1,
        rejected: 0,
        errors: []
      }
    });
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onAccept.mock.calls[0]?.[0].events[0]).toMatchObject({
      event_type: "request_event",
      sdk_name: "@debugbundle/sdk-browser",
      payload: {
        path: "/v1/billing/checkout",
        query: { plan: "team" },
        response_status: 503
      }
    });
  });

  it("rejects requests from non-matching origins using the default same-origin policy", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });

    const response = await relay(
      createBrowserRelayRequest({
        headers: {
          origin: "https://evil.example.com"
        }
      })
    );

    expect(response).toEqual({ status: 403 });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("accepts requests using referer fallback and explicit allowlist configuration", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({
      allowedOrigins: ["https://dashboard.example.net"],
      onAccept
    });

    const response = await relay(
      createBrowserRelayRequest({
        headers: {
          host: "relay.internal.example",
          origin: "",
          referer: "https://dashboard.example.net/settings"
        }
      })
    );

    expect(response.status).toBe(202);
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("rejects text/plain relay bodies so browser relay requests stay on the canonical application/json contract", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });

    const response = await relay(
      createBrowserRelayRequest({
        headers: {
          "content-type": "text/plain"
        }
      })
    );

    expect(response).toEqual({
      status: 400,
      body: {
        accepted: 0,
        rejected: 0,
        errors: ["Relay requests must use Content-Type: application/json."]
      }
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("rejects requests with unsupported content types", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });

    const response = await relay(
      createBrowserRelayRequest({
        headers: {
          "content-type": "text/html"
        }
      })
    );

    expect(response).toEqual({
      status: 400,
      body: {
        accepted: 0,
        rejected: 0,
        errors: ["Relay requests must use Content-Type: application/json."]
      }
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("rejects request bodies that use the legacy events alias instead of batch", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });

    const response = await relay(
      createBrowserRelayRequest({
        body: JSON.stringify({ events: [createFrontendExceptionEvent()] })
      })
    );

    expect(response).toEqual({
      status: 400,
      body: {
        accepted: 0,
        rejected: 0,
        errors: ["Relay request body must be valid JSON with a batch array."]
      }
    });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("rejects request bodies over the 256 KB limit", async () => {
    const onAccept = vi.fn<(input: BrowserRelayAcceptedBatch) => Promise<void>>().mockResolvedValue();
    const relay = createBrowserRelay({ onAccept });

    const response = await relay(
      createBrowserRelayRequest({
        body: "x".repeat(262_145)
      })
    );

    expect(response).toEqual({ status: 413 });
    expect(onAccept).not.toHaveBeenCalled();
  });

  it("applies per-IP rate limiting with the default 60 requests per minute", async () => {
    let currentTime = Date.parse("2026-03-22T10:00:00.000Z");
    const relay = createBrowserRelay({
      now: () => new Date(currentTime),
      onAccept: async () => undefined
    });

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const response = await relay(createBrowserRelayRequest());
      expect(response.status).toBe(202);
    }

    const rateLimited = await relay(createBrowserRelayRequest());
    expect(rateLimited).toEqual({ status: 429 });

    currentTime += 60_001;

    const recovered = await relay(createBrowserRelayRequest());
    expect(recovered.status).toBe(202);
  });

  it("writes validated browser events to the local events directory in the same array format as file transport", async () => {
    const eventsDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-local-"));

    try {
      const relay = createBrowserRelay({
        projectMode: "local-only",
        localEventsDir: eventsDir
      });

      const response = await relay(createBrowserRelayRequest());

      expect(response).toEqual({
        status: 202,
        body: {
          accepted: 1,
          rejected: 0,
          errors: []
        }
      });

      const files = fs.readdirSync(eventsDir).filter((fileName) => fileName.endsWith(".events.json"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^\d+-\d+-checkout-web\.events\.json$/);

      const storedBatch = JSON.parse(fs.readFileSync(path.join(eventsDir, files[0] ?? ""), "utf8")) as unknown;
      expect(Array.isArray(storedBatch)).toBe(true);

      const parsedBatch = storedBatch as unknown[];
      expect(parsedBatch).toHaveLength(1);
      expect(EventEnvelopeSchema.parse(parsedBatch[0])).toMatchObject({
        event_type: "frontend_exception",
        sdk_name: "@debugbundle/sdk-browser",
        service: {
          name: "checkout-web",
          environment: "production"
        }
      });
    } finally {
      fs.rmSync(eventsDir, { recursive: true, force: true });
    }
  });

  it("writes connected durable relay batches to spool before forwarding with server-side credentials", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-spool-"));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      status: 202,
      headers: {
        get: vi.fn().mockReturnValue(null)
      }
    } as unknown as Response);

    try {
      const relay = createBrowserRelay({
        projectMode: "connected",
        spoolDir,
        projectToken: "dbundle_proj_server",
        endpoint: "https://api.debugbundle.com/v1/events",
        fetchImpl: fetchMock
      });

      const response = await relay(
        createBrowserRelayRequest({
          headers: {
            authorization: "Bearer browser-should-not-forward"
          }
        })
      );

      expect(response).toEqual({
        status: 202,
        body: {
          accepted: 1,
          rejected: 0,
          errors: []
        }
      });

      const files = fs.readdirSync(spoolDir).filter((fileName) => fileName.endsWith(".events.json"));
      expect(files).toHaveLength(1);
      expect(fs.readdirSync(spoolDir).filter((fileName) => fileName.endsWith(".delivered"))).toEqual([
        `${files[0]}.delivered`
      ]);

      const spooledBatch = JSON.parse(fs.readFileSync(path.join(spoolDir, files[0] ?? ""), "utf8")) as unknown;
      expect(Array.isArray(spooledBatch)).toBe(true);

      const parsedSpooledBatch = spooledBatch as unknown[];
      expect(parsedSpooledBatch).toHaveLength(1);
      expect(parsedSpooledBatch[0]).not.toHaveProperty("project_token");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.debugbundle.com/v1/events");
      expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
        method: "POST",
        headers: {
          Authorization: "Bearer dbundle_proj_server",
          "Content-Type": "application/json"
        }
      });

      const forwardedBodyRaw = fetchMock.mock.calls[0]?.[1]?.body;
      expect(typeof forwardedBodyRaw).toBe("string");
      if (typeof forwardedBodyRaw !== "string") {
        throw new Error("Expected connected relay request body to be a string.");
      }
      const forwardedBody = JSON.parse(forwardedBodyRaw) as {
        events?: Array<Record<string, unknown>>;
      };
      expect(forwardedBody.events).toHaveLength(1);
      expect(forwardedBody.events?.[0]).toMatchObject({
        project_token: "dbundle_proj_server",
        sdk_name: "@debugbundle/sdk-browser"
      });
    } finally {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("retains durable spool files when connected cloud forwarding fails", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-spool-failed-"));
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new Error("cloud unavailable"));

    try {
      const relay = createBrowserRelay({
        projectMode: "connected",
        spoolDir,
        projectToken: "dbundle_proj_server",
        endpoint: "https://api.debugbundle.com/v1/events",
        fetchImpl: fetchMock
      });

      const response = await relay(createBrowserRelayRequest());

      expect(response).toEqual({
        status: 202,
        body: {
          accepted: 1,
          rejected: 0,
          errors: []
        }
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const files = fs.readdirSync(spoolDir).filter((fileName) => fileName.endsWith(".events.json"));
      expect(files).toHaveLength(1);
  expect(fs.readdirSync(spoolDir).filter((fileName) => fileName.endsWith(".delivered"))).toEqual([]);

      const spooledBatch = JSON.parse(fs.readFileSync(path.join(spoolDir, files[0] ?? ""), "utf8")) as unknown[];
      expect(spooledBatch).toHaveLength(1);
      expect(EventEnvelopeSchema.parse(spooledBatch[0])).toMatchObject({
        event_type: "frontend_exception",
        sdk_name: "@debugbundle/sdk-browser"
      });
      expect(spooledBatch[0]).not.toHaveProperty("project_token");
    } finally {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("forwards low-latency connected relay batches directly to cloud without writing a spool file", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-low-latency-"));
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue({
      status: 202,
      headers: {
        get: vi.fn().mockReturnValue(null)
      }
    } as unknown as Response);

    try {
      const relay = createBrowserRelay({
        projectMode: "connected",
        durableWrite: false,
        spoolDir,
        projectToken: "dbundle_proj_server",
        endpoint: "https://api.debugbundle.com/v1/events",
        fetchImpl: fetchMock
      });

      const response = await relay(createBrowserRelayRequest());

      expect(response).toEqual({
        status: 202,
        body: {
          accepted: 1,
          rejected: 0,
          errors: []
        }
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.debugbundle.com/v1/events");

      const forwardedBodyRaw = fetchMock.mock.calls[0]?.[1]?.body;
      expect(typeof forwardedBodyRaw).toBe("string");
      if (typeof forwardedBodyRaw !== "string") {
        throw new Error("Expected low-latency relay request body to be a string.");
      }
      const forwardedBody = JSON.parse(forwardedBodyRaw) as {
        events?: Array<Record<string, unknown>>;
      };
      expect(forwardedBody.events).toHaveLength(1);
      expect(forwardedBody.events?.[0]).toMatchObject({
        project_token: "dbundle_proj_server",
        sdk_name: "@debugbundle/sdk-browser"
      });

      expect(fs.readdirSync(spoolDir)).toEqual([]);
    } finally {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("fails low-latency relay requests when cloud forwarding is not configured and does not write a spool file", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-relay-low-latency-misconfig-"));

    try {
      const relay = createBrowserRelay({
        projectMode: "connected",
        durableWrite: false,
        spoolDir,
        projectToken: "dbundle_proj_server"
      });

      const response = await relay(createBrowserRelayRequest());

      expect(response).toEqual({ status: 500 });
      expect(fs.readdirSync(spoolDir)).toEqual([]);
    } finally {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });
});
