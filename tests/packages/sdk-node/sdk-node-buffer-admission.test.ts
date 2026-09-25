import { describe, expect, it } from "vitest";
import type { EventEnvelope } from "@debugbundle/shared-types";
import { admitBufferedEvent, BoundedEventBuffer, restoreBufferedEvents } from "../../../packages/sdk-node/src/buffer-admission.js";

function event(id: string, kind: "warning" | "error" | "exception" | "suppression" | "request" | "failed-request"): EventEnvelope {
  if (kind === "exception") return { event_id: id, event_type: "backend_exception" } as EventEnvelope;
  if (kind === "suppression") return { event_id: id, event_type: "error_suppressed" } as EventEnvelope;
  if (kind === "request" || kind === "failed-request") return {
    event_id: id,
    event_type: "request_event",
    payload: { response_status: kind === "failed-request" ? 503 : 200 }
  } as EventEnvelope;
  return { event_id: id, event_type: "log_event", payload: { level: kind } } as EventEnvelope;
}

describe("Node buffered delivery priority", () => {
  it("retains an older exception when later warnings fill the queue", () => {
    const buffer = [event("root", "exception"), event("warning-1", "warning")];
    expect(admitBufferedEvent(buffer, event("warning-2", "warning"), 2)?.event_id).toBe("warning-1");
    expect(buffer.map((item) => item.event_id)).toEqual(["root", "warning-2"]);
  });

  it("drops an incoming warning before a queue of higher-priority incidents", () => {
    const buffer = [event("root", "exception"), event("error", "error")];
    expect(admitBufferedEvent(buffer, event("warning", "warning"), 2)?.event_id).toBe("warning");
    expect(buffer.map((item) => item.event_id)).toEqual(["root", "error"]);
  });

  it("bounds failed sends while giving a retried exception precedence", () => {
    const buffer = [event("warning", "warning"), event("error", "error")];
    const dropped = restoreBufferedEvents(buffer, [event("retry-root", "exception")], 2);
    expect(dropped.map((item) => item.event_id)).toEqual(["warning"]);
    expect(buffer.map((item) => item.event_id)).toEqual(["retry-root", "error"]);
  });

  it("does not displace a retained exception with a lower-priority retry", () => {
    const buffer = [event("root", "exception")];
    const dropped = restoreBufferedEvents(buffer, [event("retry-warning", "warning")], 1);
    expect(dropped.map((item) => item.event_id)).toEqual(["retry-warning"]);
    expect(buffer.map((item) => item.event_id)).toEqual(["root"]);
  });

  it("ranks aggregate and request evidence between exceptions and warning logs", () => {
    const buffer = [event("request", "request"), event("warning", "warning")];
    expect(admitBufferedEvent(buffer, event("aggregate", "suppression"), 2)?.event_id).toBe("warning");
    expect(buffer.map((item) => item.event_id)).toEqual(["request", "aggregate"]);
  });

  it("does not let ordinary request traffic replace a failed request incident", () => {
    const buffer = [event("failure", "failed-request")];
    expect(admitBufferedEvent(buffer, event("ordinary", "request"), 1)?.event_id).toBe("ordinary");
    expect(buffer.map((item) => item.event_id)).toEqual(["failure"]);
  });

  it("gives a retried failed request precedence over ordinary queued requests", () => {
    const buffer = new BoundedEventBuffer();
    expect(buffer.admit(event("ordinary", "request"), 1, 8_192)).toEqual([]);
    expect(buffer.restore([event("failure", "failed-request")], 1, 8_192)
      .map((item) => item.event_id)).toEqual(["ordinary"]);
    expect(buffer.events.map((item) => item.event_id)).toEqual(["failure"]);
  });

  it("bounds equal-priority construction attempts even when every queued event is an error", () => {
    const buffer = new BoundedEventBuffer();
    expect(buffer.admit(event("first", "error"), 2, 8_192)).toEqual([]);
    expect(buffer.admit(event("second", "error"), 2, 8_192)).toEqual([]);

    let admitted = 0;
    for (let index = 0; index < 10_000; index += 1) {
      if (buffer.canAdmit("log_event", "error", 2, 8_192)) admitted += 1;
    }

    expect(admitted).toBeLessThanOrEqual(40);
    expect(buffer.preflightDropCount).toBeGreaterThanOrEqual(9_960);
  });

  it("always admits a failed request over ordinary requests despite equal-priority sampling", () => {
    const buffer = new BoundedEventBuffer();
    expect(buffer.admit(event("first", "request"), 1, 8_192)).toEqual([]);
    expect(buffer.canAdmit("request_event", undefined, 1, 8_192)).toBe(true);
    expect(buffer.canAdmit("request_event", undefined, 1, 8_192, 503)).toBe(true);
  });

  it("evicts enough lower-priority bytes for an exception without partial loss on rejection", () => {
    const buffer = new BoundedEventBuffer();
    const warning = (id: string) => ({ ...event(id, "warning"), payload: {
      level: "warning", message: "x".repeat(120)
    } }) as EventEnvelope;
    const root = event("root", "exception");
    const maxBytes = Buffer.byteLength(JSON.stringify(warning("one"))) +
      Buffer.byteLength(JSON.stringify(warning("two"))) + 1;
    expect(buffer.admit(warning("one"), 4, maxBytes)).toEqual([]);
    expect(buffer.admit(warning("two"), 4, maxBytes)).toEqual([]);
    expect(buffer.admit(root, 4, maxBytes).map((item) => item.event_id)).toEqual(["one"]);
    expect(buffer.events.map((item) => item.event_id)).toEqual(["two", "root"]);

    const largeWarning = { ...warning("third"), payload: { level: "warning", message: "x".repeat(290) } } as EventEnvelope;
    expect(Buffer.byteLength(JSON.stringify(largeWarning))).toBeLessThan(maxBytes);
    expect(buffer.admit(largeWarning, 4, maxBytes)).toEqual([largeWarning]);
    expect(buffer.events.map((item) => item.event_id)).toEqual(["two", "root"]);
  });
});
