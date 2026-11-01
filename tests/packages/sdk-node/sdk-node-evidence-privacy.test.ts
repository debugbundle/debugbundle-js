import { expect, it } from "vitest";
import { createEventEnvelope, type ExceptionEvidenceV1 } from "@debugbundle/shared-types";
import { protectNodeEvent } from "../../../packages/sdk-node/src/privacy.js";
const graph = (message: string): ExceptionEvidenceV1 => ({ version: 1, runtime: "node", root_id: 0, truncated: false, unavailable_reason: null, nodes: [{ id: 0, name: "Error", message,
  stack: "Error: failed\n at run (https://user:pass@static.example.test/a.js?ordinary=private:12:3)", trace_origin: "runtime_reported", parsing_status: "parsed",
  frames: [{ function: "run", file: "https://user:pass@static.example.test/a.js?ordinary=private", line: 12, column: 3, classification: "unknown" }], relationships: [] }] });
function event(evidence: ExceptionEvidenceV1) { return createEventEnvelope({ event_type: "backend_exception", service: { name: "test", environment: "test" }, payload: {
  name: "Error", message: "original failure", stack: "unavailable", handled: true, request: { method: "GET", path: "/", query: {}, headers: {} }, response: { status_code: 500 }, runtime: { version: "24" }, exception_evidence: evidence } }); }
it("protects all added cause stacks and frame URL state before retaining an event", () => {
  const safe = protectNodeEvent(event(graph("cause")), []);
  expect(safe).not.toBeNull(); const serialized = JSON.stringify(safe);
  expect(serialized).not.toContain("private"); expect(serialized).not.toContain("user:pass");
  expect(serialized).toContain("https://static.example.test/a.js");
});
it("drops an over-budget post-redaction addition while retaining an admissible original error", () => {
  const safe = protectNodeEvent(event(graph("token=x ".repeat(256))), []);
  expect(safe).not.toBeNull(); expect(safe?.payload).toMatchObject({ message: "original failure" });
  expect(safe?.payload).not.toHaveProperty("exception_evidence");
  expect(safe?.context?.["evidence_limits"]).toMatchObject({ version: 1, exception_evidence: "budget_exceeded" });
});
