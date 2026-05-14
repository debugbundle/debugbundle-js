import { describe, expect, it } from "vitest";

import { parseRemoteProbeConfig, findMatchingRemoteProbeDirectives, parseCapturePolicy } from "../../../packages/sdk-node/src/remote-probes.js";
import { BALANCED_CAPTURE_POLICY } from "../../../packages/sdk-node/src/types.js";

describe("sdk-node remote probe helpers", () => {
  it("should parse remote probe config payloads and filter invalid directives", (): void => {
    expect(parseRemoteProbeConfig(null, 30_000, Date.parse("2026-03-15T00:00:00.000Z"))).toBeNull();

    expect(
      parseRemoteProbeConfig(
        {
          probes_enabled: true,
          remote_probes_enabled: true,
          active_probes: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              label_pattern: "checkout.*",
              service: "checkout-api",
              environment: "production",
              expires_at: "2026-03-20T00:00:00.000Z"
            },
            {
              id: "expired",
              label_pattern: "expired.*",
              service: "checkout-api",
              environment: "production",
              expires_at: "2026-03-10T00:00:00.000Z"
            },
            {
              id: "bad",
              label_pattern: "bad.*",
              service: "checkout-api",
              environment: "production",
              expires_at: "not-a-date"
            }
          ],
          poll_interval_ms: 45_500,
          trigger_token_key: "trigger-key"
        },
        30_000,
        Date.parse("2026-03-15T00:00:00.000Z")
      )
    ).toEqual({
      probesEnabled: true,
      remoteProbesEnabled: true,
      directives: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          labelPattern: "checkout.*",
          service: "checkout-api",
          environment: "production",
          expiresAt: "2026-03-20T00:00:00.000Z"
        }
      ],
      pollIntervalMs: 45500,
      triggerTokenKey: "trigger-key",
      capturePolicy: BALANCED_CAPTURE_POLICY
    });
  });

  it("should use the default poll interval when remote probes are disabled or poll values are invalid", (): void => {
    expect(
      parseRemoteProbeConfig(
        {
          probes_enabled: true,
          remote_probes_enabled: false,
          active_probes: [],
          poll_interval_ms: 5
        },
        30_000,
        Date.parse("2026-03-15T00:00:00.000Z")
      )
    ).toMatchObject({
      probesEnabled: true,
      remoteProbesEnabled: false,
      pollIntervalMs: 60000,
      triggerTokenKey: null
    });

    expect(
      parseRemoteProbeConfig(
        {
          probes_enabled: false,
          remote_probes_enabled: true,
          active_probes: [],
          poll_interval_ms: -1
        },
        30_000,
        Date.parse("2026-03-15T00:00:00.000Z")
      )
    ).toMatchObject({
      probesEnabled: false,
      remoteProbesEnabled: true,
      pollIntervalMs: 30000
    });
  });

  it("should match directives by expiry, service, environment, and label pattern", (): void => {
    const directives = [
      {
        id: "1",
        labelPattern: "*",
        service: "*",
        environment: "*",
        expiresAt: "2026-03-20T00:00:00.000Z"
      },
      {
        id: "2",
        labelPattern: "checkout.*",
        service: "checkout-api",
        environment: "production",
        expiresAt: "2026-03-20T00:00:00.000Z"
      },
      {
        id: "3",
        labelPattern: "payment.tax",
        service: "checkout-api",
        environment: "production",
        expiresAt: "2026-03-20T00:00:00.000Z"
      },
      {
        id: "4",
        labelPattern: "checkout.*",
        service: "billing-api",
        environment: "production",
        expiresAt: "2026-03-20T00:00:00.000Z"
      },
      {
        id: "5",
        labelPattern: "checkout.*",
        service: "checkout-api",
        environment: "staging",
        expiresAt: "2026-03-20T00:00:00.000Z"
      },
      {
        id: "6",
        labelPattern: "checkout.*",
        service: "checkout-api",
        environment: "production",
        expiresAt: "2026-03-10T00:00:00.000Z"
      }
    ];

    expect(
      findMatchingRemoteProbeDirectives(
        directives,
        "checkout.tax",
        "checkout-api",
        "production",
        Date.parse("2026-03-15T00:00:00.000Z")
      ).map((directive) => directive.id)
    ).toEqual(["1", "2"]);

    expect(
      findMatchingRemoteProbeDirectives(
        directives,
        "payment.tax",
        "checkout-api",
        "production",
        Date.parse("2026-03-15T00:00:00.000Z")
      ).map((directive) => directive.id)
    ).toEqual(["1", "3"]);
  });
});

describe("sdk-node capture policy parsing", () => {
  it("should default to balanced when capture_policy is absent", (): void => {
    const result = parseRemoteProbeConfig(
      {
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        poll_interval_ms: 30_000
      },
      30_000,
      Date.now()
    );
    expect(result).not.toBeNull();
    expect(result!.capturePolicy).toEqual(BALANCED_CAPTURE_POLICY);
  });

  it("should parse a valid capture policy from the config response", (): void => {
    const result = parseRemoteProbeConfig(
      {
        probes_enabled: true,
        remote_probes_enabled: false,
        active_probes: [],
        poll_interval_ms: 30_000,
        capture_policy: {
          preset: "minimal",
          capture_logs: "error",
          capture_request_events: "off",
          capture_breadcrumbs: "local_only",
          capture_probe_events: "buffer_only",
          immediate_client_error_statuses: [401, 403]
        }
      },
      30_000,
      Date.now()
    );
    expect(result).not.toBeNull();
    expect(result!.capturePolicy).toEqual({
      preset: "minimal",
      captureLogs: "error",
      captureRequestEvents: "off",
      captureBreadcrumbs: "local_only",
      captureProbeEvents: "buffer_only",
      immediateClientErrorStatuses: [401, 403]
    });
  });

  it("should reject config when capture_policy has invalid values", (): void => {
    expect(
      parseRemoteProbeConfig(
        {
          probes_enabled: true,
          remote_probes_enabled: false,
          active_probes: [],
          capture_policy: {
            preset: "custom",
            capture_logs: "verbose",
            capture_request_events: "all",
            capture_breadcrumbs: "local_only",
            capture_probe_events: "buffer_only"
          }
        },
        30_000,
        Date.now()
      )
    ).toBeNull();
  });

  it("should reject config when capture_policy is a non-object", (): void => {
    expect(
      parseRemoteProbeConfig(
        {
          probes_enabled: true,
          remote_probes_enabled: false,
          active_probes: [],
          capture_policy: "minimal"
        },
        30_000,
        Date.now()
      )
    ).toBeNull();
  });

  it("should parse all valid capture_logs levels", (): void => {
    for (const level of ["off", "error", "warning", "info"]) {
      const policy = parseCapturePolicy({
        preset: "custom",
        capture_logs: level,
        capture_request_events: "all",
        capture_breadcrumbs: "local_only",
        capture_probe_events: "buffer_only",
        immediate_client_error_statuses: []
      });
      expect(policy).not.toBeNull();
      expect(policy!.captureLogs).toBe(level);
    }
  });

  it("should parse all valid capture_request_events modes", (): void => {
    for (const mode of ["off", "failures_only", "filtered", "all"]) {
      const policy = parseCapturePolicy({
        preset: "custom",
        capture_logs: "warning",
        capture_request_events: mode,
        capture_breadcrumbs: "local_only",
        capture_probe_events: "buffer_only",
        immediate_client_error_statuses: []
      });
      expect(policy).not.toBeNull();
      expect(policy!.captureRequestEvents).toBe(mode);
    }
  });
});
