import assert from "node:assert/strict";
import { types } from "node:util";

const first = new Error("synthetic first"), second = new Error("synthetic second");
const firstStack = Object.getOwnPropertyDescriptor(first, "stack"), secondStack = Object.getOwnPropertyDescriptor(second, "stack");
assert.equal(types.isNativeError(first), true);
assert.ok(firstStack && secondStack);
if ("get" in firstStack) assert.equal(firstStack.get, secondStack.get);
console.log(JSON.stringify({ runtime: process.version, stack: "value" in firstStack ? "data" : "accessor",
  sharedNativeGetter: firstStack.get === secondStack.get, errorBrandAvailable: typeof Error.isError === "function" }));
