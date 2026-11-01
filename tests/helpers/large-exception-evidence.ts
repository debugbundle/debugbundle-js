import type { ExceptionEvidenceV1 } from "@debugbundle/shared-types";

export function largeExceptionEvidence(runtime: "node" | "browser" = "browser"): ExceptionEvidenceV1 {
  return {
    version: 1, runtime, root_id: 0, truncated: false, unavailable_reason: null,
    nodes: [0, 1].map(id => ({ id, name: "Error", message: "synthetic", stack: "é".repeat(id === 0 ? 8000 : 7000),
      trace_origin: "runtime_reported" as const, parsing_status: "unparsed" as const, frames: [],
      relationships: id === 0 ? [{ kind: "cause" as const, target_id: 1 }] : [] }))
  };
}
