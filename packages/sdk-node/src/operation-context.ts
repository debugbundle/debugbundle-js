import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { types } from "node:util";
import { sanitizeTelemetry } from "@debugbundle/redaction";
import { truncateUtf8, type EvidenceScope, type ExecutionContext } from "@debugbundle/shared-types";
import type { CaptureRequestInput, NodeOperationOptions } from "./types.js";

interface Operation { active: boolean; kind: ExecutionContext["kind"]; name: string | null; started: number; limit: number | null; scope: EvidenceScope }
interface Store { request?: CaptureRequestInput; operation?: Operation }
function own(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

/** No process uptime or shared mutable current-operation slot. Async scopes and
 * request-owner cleanup keep concurrent jobs and late detached tasks isolated. */
export class NodeOperationContext {
  private readonly storage = new AsyncLocalStorage<Store>();
  private readonly owners = new WeakMap<object, Operation>();
  getStore(): Store | undefined { return this.storage.getStore(); }
  private create(options: NodeOperationOptions): Operation | undefined {
    try {
      if (types.isProxy(options)) return undefined;
      const kind = own(options, "kind"), label = own(options, "name"), limit = own(options, "limitMs");
      const protectedLabel = typeof label === "string" ? sanitizeTelemetry(label) : null;
      return { active: true, kind: kind === "request" || kind === "command" || kind === "job" ? kind : "unknown",
        name: protectedLabel?.ok && typeof protectedLabel.value === "string" ? truncateUtf8(protectedLabel.value, 128) : null,
        started: performance.now(), limit: typeof limit === "number" && Number.isFinite(limit) && limit >= 0 ? limit : null,
        scope: { kind: "operation", operation_id: randomUUID() } };
    } catch { return undefined; }
  }
  runRequest<Result>(request: CaptureRequestInput, callback: () => Result, owner?: object): Result {
    let operation: Operation | undefined;
    const validOwner = owner !== null && (typeof owner === "object" || typeof owner === "function");
    if (validOwner) try {
      const route = types.isProxy(request) ? undefined : own(request, "routeTemplate");
      operation = this.create({ kind: "request", ...(typeof route === "string" ? { name: route } : {}) });
    } catch { /* An unavailable request label must not prevent the handler. */ }
    if (validOwner && owner && operation) {
      const previous = this.owners.get(owner); if (previous) previous.active = false;
      this.owners.set(owner, operation);
    }
    return this.storage.run({ request, ...(operation === undefined ? {} : { operation }) }, callback);
  }
  finishRequest(owner: object): void { const operation = this.owners.get(owner); if (operation) operation.active = false; this.owners.delete(owner); }
  async runOperation<Result>(options: NodeOperationOptions, callback: () => Result | Promise<Result>): Promise<Result> {
    const operation = this.create(options), request = this.getStore()?.request;
    try { return await this.storage.run({ ...(request === undefined ? {} : { request }), ...(operation === undefined ? {} : { operation }) }, callback); }
    finally { if (operation) operation.active = false; }
  }
  snapshot(): ExecutionContext | undefined {
    try {
      const operation = this.getStore()?.operation;
      return operation?.active ? { version: 1, kind: operation.kind, name: operation.name, elapsed_ms: Math.max(0, performance.now() - operation.started), limit_ms: operation.limit } : undefined;
    } catch { return undefined; }
  }
  scope(): EvidenceScope | undefined { const operation = this.getStore()?.operation; return operation?.active ? { ...operation.scope } : undefined; }
  dispose(): void { this.storage.disable(); }
}
