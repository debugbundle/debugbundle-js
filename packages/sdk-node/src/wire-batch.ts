import { EVENT_INGESTION_MAX_BODY_BYTES, type EventEnvelope } from "@debugbundle/shared-types";
import type { BoundedEventBuffer } from "./buffer-admission.js";
export { fitEventToIngestionWire as fitNodeWireEvent } from "@debugbundle/shared-types";

/** Normalized relay DTOs, including final server credentials, only. */
export function nodeWireBatches<T>(events: readonly T[]): T[][] {
  const chunks: T[][] = [];
  let chunk: T[] = [], bytes = 13;
  for (const event of events) {
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (size + 13 > EVENT_INGESTION_MAX_BODY_BYTES) throw new Error("node_event_exceeds_wire_limit");
    if (bytes + size + (chunk.length === 0 ? 0 : 1) > EVENT_INGESTION_MAX_BODY_BYTES) {
      chunks.push(chunk); chunk = []; bytes = 13;
    }
    bytes += size + (chunk.length === 0 ? 0 : 1); chunk.push(event);
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

/** Return unsent finalized events to the existing queue before transport starts.
 * They retain their hook cache and remain charged independently of this chunk. */
export function deferNodeWireTail(input: {
  batch: EventEnvelope[]; buffer: BoundedEventBuffer;
  adjustOwnership(count: number, bytes: number): void;
  capacity(): { count: number; bytes: number };
  dropped(events: EventEnvelope[]): void;
}): void {
  let count = 0, bytes = 13;
  for (const event of input.batch) {
    const cost = input.buffer.eventBytes(event) + (count === 0 ? 0 : 1);
    if (bytes + cost > EVENT_INGESTION_MAX_BODY_BYTES) break;
    bytes += cost; count++;
  }
  if (count === 0 && input.batch.length > 0) throw new Error("node_event_exceeds_wire_limit");
  const tail = input.batch.splice(count);
  if (tail.length === 0) return;
  const tailBytes = tail.reduce((total, event) => total + input.buffer.eventBytes(event), 0);
  input.adjustOwnership(-tail.length, -tailBytes);
  const capacity = input.capacity();
  input.dropped(input.buffer.restore(tail, capacity.count, capacity.bytes));
}
