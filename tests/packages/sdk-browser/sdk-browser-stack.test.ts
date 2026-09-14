import { expect, it } from "vitest";
import { sanitizeBrowserStack } from "../../../packages/sdk-browser/src/browser-stack.js";

it.each([
  ["at http://localhost:3000/app.js:12:9", "at http://localhost:3000/app.js:12:9"],
  ["at fn (https://user:secret@example.com/app.js?token=secret#state:12:9)", "at fn (https://example.com/app.js:12:9)"],
  ["fn@https://example.com/app.js?token=secret:12", "fn@https://example.com/app.js:12"],
  ["https://example.com/app.js?token=secret", "https://example.com/app.js"],
  ["at http://[invalid]?token=secret:2:3", "at [unavailable-url]:2:3"],
  ["at fn (https://user:pa)secret@example.com/app.js?token=one)secret#state:12:24)", "at fn (https://example.com/app.js:12:24)"],
  ["fn@https://example.com/app.js?token=one)secret:12:24", "fn@https://example.com/app.js:12:24"],
  ["at fn (https://example.com/app(1).js:12:24)", "at fn (https://example.com/app(1).js:12:24)"],
  ["Error: example\n at app.js:2:3", "Error: example\n at app.js:2:3"]
])("sanitizes stack location %s", (source, expected) => {
  expect(sanitizeBrowserStack(source)).toBe(expected);
});
