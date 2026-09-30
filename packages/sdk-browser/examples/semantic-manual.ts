import {
  createDebugBundleBrowserSdk,
  type DebugBundleBrowserAnalytics
} from "../src/index.js";

export interface ManualSignupAnalytics {
  started(): void;
  completed(): void;
  getStatus(): ReturnType<DebugBundleBrowserAnalytics["getStatus"]>;
  dispose(): void;
}

/** Direct project-token mode only; the server capability still decides whether capture starts. */
export function createManualSignupAnalytics(
  projectToken: string,
  endpoint: string
): ManualSignupAnalytics {
  const sdk = createDebugBundleBrowserSdk();
  sdk.init({
    projectToken,
    endpoint,
    transportMode: "direct",
    service: "signup-web",
    environment: "production",
    analytics: { enabled: true, schemaVersion: "2026-09-analytics-02" }
  });
  return {
    started(): void {
      sdk.analytics.track("signup.started", {}, { eventRevision: 1 });
    },
    completed(): void {
      sdk.analytics.track("signup.completed", {}, { eventRevision: 1 });
    },
    getStatus: () => sdk.analytics.getStatus(),
    dispose: () => sdk.dispose()
  };
}
