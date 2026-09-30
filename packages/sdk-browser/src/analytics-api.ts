import type { DebugBundleBrowserAnalytics } from "./types.js";
import type { BrowserSemanticAnalyticsController } from "./semantic-analytics.js";

/** Keep installed V1 method behavior while routing explicit successor capture separately. */
export function createBrowserAnalyticsApi(
  legacy: DebugBundleBrowserAnalytics,
  semantic: BrowserSemanticAnalyticsController,
  usesSemantic: () => boolean
): DebugBundleBrowserAnalytics {
  return {
    ...legacy,
    getStatus() {
      return usesSemantic() ? { mode: "semantic", semantic: semantic.getStatus() } : legacy.getStatus();
    },
    setConsent(value) {
      legacy.setConsent(value);
      semantic.setConsent(value);
    },
    pageView(input) {
      if (usesSemantic()) semantic.pageView(input);
      else legacy.pageView(input);
    },
    track(name, properties, options) {
      if (usesSemantic()) semantic.track(name, properties, options);
      else legacy.track(name, properties);
    }
  };
}
