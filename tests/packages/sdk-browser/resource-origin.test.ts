import { expect, it } from "vitest";
import { evaluateResourceOrigin } from "../../../packages/sdk-browser/src/resource-origin.js";

it.each([null, "", "data:private", "javascript:alert(1)", "https://[broken", " https://example.com/app.js", "//cdn.example/app.js", "/\\cdn.example/app.js", `/${"x".repeat(1025)}`, "x".repeat(4097)])("does not infer a target or origin from unsupported evidence %s", source => {
  expect(evaluateResourceOrigin(source, null)).toEqual({});
});
it("keeps a root-relative path usable when the page origin is absent", () => {
  expect(evaluateResourceOrigin("/assets/app.js?secret=value#private", null)).toEqual({ url: { path: "/assets/app.js" }, first_party: true });
});
it("uses the origin for comparison while retaining legacy hostname rule matching", () => {
  expect(evaluateResourceOrigin("https://user:secret@app.example:8443/app.js?secret=value", "https://app.example:8443/page")).toEqual({ url: { host: "app.example", path: "/app.js" }, first_party: true });
  expect(evaluateResourceOrigin("https://app.example", "invalid")).toEqual({ url: { host: "app.example", path: "/" } });
});
