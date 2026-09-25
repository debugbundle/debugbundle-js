import { vi } from "vitest";
import {
  createDebugBundleSdk,
  type DebugBundleNodeSdk
} from "../../packages/sdk-node/src/index.js";

export const activeSdks: DebugBundleNodeSdk[] = [];

export function createSdk(
  overrides: Parameters<DebugBundleNodeSdk["init"]>[0] = {}
): { sdk: DebugBundleNodeSdk; transport: ReturnType<typeof vi.fn> } {
  const transport = vi.fn().mockResolvedValue({ status: 202 });
  const sdk = createDebugBundleSdk();
  activeSdks.push(sdk);
  sdk.init({
    projectToken: "dbundle_proj_test",
    service: "checkout-api",
    environment: "production",
    flushInterval: 60_000,
    transport,
    ...overrides
  });
  return { sdk, transport };
}
