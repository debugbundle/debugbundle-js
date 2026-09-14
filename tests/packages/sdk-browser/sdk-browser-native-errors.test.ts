import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import * as fixtures from "../../helpers/sdk-browser-fixtures.js";

// Web IDL properties live on native prototypes, unlike enumerable POJO fixtures.
function nativeFields(fields: Record<string, unknown>): object {
  const prototype = Object.create(null) as object;
  for (const [key, value] of Object.entries(fields)) {
    Object.defineProperty(prototype, key, { get: () => value });
  }
  return Object.create(prototype) as object;
}

describe("native browser error capture", () => {
  it.each([42, false, { privateValue: "must not serialize" }])("keeps the native message for a thrown non-Error value: %j", async (error) => {
    const { sdk, transport, globals } = fixtures.createSdk();
    globals.windowTarget.dispatch("error", nativeFields({ error, message: "Uncaught application value" }));
    await sdk.flush();
    const event = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.message).toBe("Uncaught application value");
    expect(event.payload.stack).not.toContain("onError");
    expect(JSON.stringify(event)).not.toContain("must not serialize");
  });
  it("retains structural breadcrumbs from inherited DOM fields before an error", async () => {
    const { sdk, transport, globals } = fixtures.createSdk({ captureClicks: true });
    const button = nativeFields({ tagName: "BUTTON", id: "submit", textContent: "Private value" });
    globals.documentTarget.dispatch("click", nativeFields({ target: button }));
    const form = nativeFields({ tagName: "FORM", id: "checkout", elements: nativeFields({ length: 2, "0": nativeFields({ name: "secret_field", value: "Private value" }), "1": nativeFields({ name: "email", value: "Private value" }) }) });
    globals.documentTarget.dispatch("submit", nativeFields({ target: form }));
    globals.windowTarget.dispatch("error", nativeFields({ message: "Checkout failed" }));
    await sdk.flush();
    const event = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.breadcrumbs).toEqual(expect.arrayContaining([
      expect.objectContaining({ breadcrumb_type: "click", data: { selector: "button#submit" } }),
      expect.objectContaining({ breadcrumb_type: "form_submit", data: { form: "form#checkout", field_count: 2 } })
    ]));
    expect(JSON.stringify(event)).not.toMatch(/Private value|secret_field/);
  });

  it("preserves inherited ErrorEvent information and the original application stack", async () => {
    const { sdk, transport, globals } = fixtures.createSdk();
    const error = new TypeError("Checkout state is unavailable");
    error.stack = "TypeError: Checkout state is unavailable\n    at submit (https://example.com/app.js:42:9)";
    globals.windowTarget.dispatch("error", nativeFields({
      error, message: error.message, filename: "https://example.com/app.js?token=secret#boot",
      lineno: 42, colno: 9, target: globals.windowTarget
    }));
    await sdk.flush();
    const event = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload).toMatchObject({
      name: "TypeError", message: error.message, stack: error.stack, route: "/checkout",
      browser_event: { kind: "window_error", opaque: false, file_name: "https://example.com/app.js", line_number: 42, column_number: 9 }
    });
    expect(JSON.stringify(event)).not.toContain("token=secret");
  });

  it("keeps native resource identity without collecting DOM text or attributes", async () => {
    const { sdk, transport, globals } = fixtures.createSdk();
    const target = nativeFields({ tagName: "SCRIPT", src: "https://user:secret@cdn.example/app.js?token=secret#boot", crossOrigin: "anonymous", outerHTML: "patient private data", textContent: "patient private data" });
    globals.windowTarget.dispatch("error", nativeFields({ target }));
    await sdk.flush();
    const event = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload).toMatchObject({
      message: "Browser resource load error",
      browser_event: { kind: "resource_error", opaque: true, target: { tag_name: "script", source_url: "https://cdn.example/app.js", attributes: { cross_origin: "anonymous" } } }
    });
    expect(JSON.stringify(event)).not.toMatch(/secret|patient private data/);
    expect(event.payload.stack).not.toContain("onError");
  });

  it("preserves inherited PromiseRejectionEvent reasons", async () => {
    const { sdk, transport, globals } = fixtures.createSdk();
    globals.windowTarget.dispatch("unhandledrejection", nativeFields({ reason: new Error("Save rejected") }));
    await sdk.flush();
    const event = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload.message).toBe("Save rejected");
  });

  it("removes credentials, query and fragment from inline rejection stack URLs while preserving source coordinates", async () => {
    const { sdk, transport, globals } = fixtures.createSdk();
    const error = new Error("Save rejected");
    error.stack = "Error: Save rejected\n    at submit (https://user:secret@example.com/checkout?token=secret#private:12:24)\nfn@https://example.com/app.js?token=secret:34:5";
    globals.windowTarget.dispatch("unhandledrejection", nativeFields({ reason: error }));
    await sdk.flush();
    const captured = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(captured.payload.stack).toBe("Error: Save rejected\n    at submit (https://example.com/checkout:12:24)\nfn@https://example.com/app.js:34:5");
    expect(error.stack).toContain("token=secret");
    expect(JSON.stringify(captured)).not.toMatch(/secret|private/);
  });

  it("preserves Error values created in another realm", async () => {
    const { sdk, transport, globals } = fixtures.createSdk();
    const error: unknown = runInNewContext('new TypeError("Frame failed")');
    globals.windowTarget.dispatch("error", nativeFields({ error, message: "Frame failed" }));
    await sdk.flush();
    const event = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(event.payload).toMatchObject({ name: "TypeError", message: "Frame failed", browser_event: { opaque: false } });
  });

  it("does not let throwing event getters escape into the host", async () => {
    const { sdk, transport, globals } = fixtures.createSdk();
    const event = Object.create(null) as object;
    Object.defineProperty(event, "error", { enumerable: true, get: () => { throw new Error("access denied"); } });
    Object.defineProperty(event, "message", { get: () => "Available message" });
    expect(() => globals.windowTarget.dispatch("error", event)).not.toThrow();
    await sdk.flush();
    expect(fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]).payload.message).toBe("Available message");
  });

  it("never walks arbitrary enumerable event fields", async () => {
    const { sdk, transport, globals } = fixtures.createSdk();
    const event = nativeFields({ message: "Script error.", error: null, filename: "", lineno: 0, colno: 0 });
    Object.defineProperty(event, "privateValue", { enumerable: true, get: () => { throw new Error("must not read"); } });
    expect(() => globals.windowTarget.dispatch("error", event)).not.toThrow();
    await sdk.flush();
    const captured = fixtures.getFrontendExceptionEvent(fixtures.createTransportEvents(transport, 0)[0]);
    expect(captured.payload).toMatchObject({ message: "Script error.", browser_event: { opaque: true, file_name: null } });
    expect(captured.payload.stack).not.toContain("onError");
  });
});
