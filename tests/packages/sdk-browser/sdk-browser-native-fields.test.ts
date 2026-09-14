import { expect, it } from "vitest";
import { countFormFields, hasErrorDetails, readNativeField } from "../../../packages/sdk-browser/src/native-fields.js";
import { captureNativeError, captureNativeRejection } from "../../../packages/sdk-browser/src/native-error-hooks.js";

it("bounds native form inspection and tolerates malformed or inaccessible collections", () => {
  for (const length of [undefined, null, "10", -1, Infinity, NaN]) {
    expect(countFormFields({ elements: { length } })).toBe(0);
  }
  const read: string[] = [];
  const elements = new Proxy({ length: 10_000 }, { get(target, key) {
    if (key === "length") return target.length;
    read.push(String(key));
    return { name: key === "0" ? "" : "present" };
  } });
  expect(countFormFields({ elements })).toBe(999);
  expect(read).toHaveLength(1000);
  expect(countFormFields({ elements: { length: 2.7, 0: null, 1: { name: 42 } } })).toBe(0);
  expect(readNativeField(() => undefined, "length")).toBe(0);
  expect(hasErrorDetails(null)).toBe(false);
  expect(hasErrorDetails({ stack: "Error: available" })).toBe(true);
});

it("isolates capture failures in both native hooks", () => {
  const fail = () => { throw new Error("instrumentation failed"); };
  expect(() => captureNativeError({}, fail)).not.toThrow();
  expect(() => captureNativeRejection({ reason: "reason" }, fail)).not.toThrow();
});
