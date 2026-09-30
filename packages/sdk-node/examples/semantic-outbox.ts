import { createHmac } from "node:crypto";
import type { AnalyticsDeliveryReceipt, AnalyticsPreparedEvent } from "@debugbundle/shared-types";
import type { SemanticAnalyticsNodeDelivery } from "../src/index.js";

interface PendingRow {
  id: string;
  record: AnalyticsPreparedEvent;
}

interface Transaction {
  insertAccount(accountId: string): Promise<void>;
  insertAnalyticsOutbox(record: AnalyticsPreparedEvent): Promise<void>;
  acknowledgeIfCurrent(
    rowId: string,
    preparedContentHash: string,
    accepted: AnalyticsDeliveryReceipt["accepted_events"][number]
  ): Promise<void>;
  markTerminalIfCurrent(rowId: string, preparedContentHash: string, reason: string): Promise<void>;
}

const RETRYABLE_REJECTIONS = new Set([
  "rate_limited", "monthly_quota_exceeded", "analytics_quota_exceeded"
]);

/** Implement these methods with the application's own durable database. */
export interface AccountStore {
  transaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T>;
  pendingAnalytics(limit: number): Promise<PendingRow[]>;
}

/** The HMAC hides even a guessable business key; the same operation gets the same reference. */
function operationReference(secret: Uint8Array, opaqueOperationKey: string): string {
  return `sha256:${createHmac("sha256", secret)
    .update("debugbundle:account-created:v1:")
    .update(opaqueOperationKey)
    .digest("hex")}`;
}

export async function createAccountWithAnalytics(input: {
  store: AccountStore;
  analytics: SemanticAnalyticsNodeDelivery;
  accountId: string;
  traceId?: string | null;
  opaqueOperationKey: string;
  operationSecret: Uint8Array;
}): Promise<void> {
  const request = input.analytics.withContext({ traceId: input.traceId ?? null });
  const prepared = await request.prepare("account.created", {}, {
    eventRevision: 1,
    operationId: operationReference(input.operationSecret, input.opaqueOperationKey)
  });
  await input.store.transaction(async (tx) => {
    await tx.insertAccount(input.accountId);
    if (prepared.status === "prepared") await tx.insertAnalyticsOutbox(prepared.record);
  });
  // A missing prepared record is an instrumentation gap; it does not undo the account transaction.
}

export async function deliverAccountAnalytics(input: {
  store: AccountStore;
  analytics: SemanticAnalyticsNodeDelivery;
}): Promise<void> {
  const pending = await input.store.pendingAnalytics(100);
  if (pending.length === 0) return;
  const result = await input.analytics.deliver(pending.map((row) => row.record));
  if (result.status !== "received") return;

  await input.store.transaction(async (tx) => {
    for (const accepted of result.receipt.accepted_events) {
      const row = pending[accepted.index];
      if (row === undefined) throw new Error("analytics_receipt_index_out_of_range");
      await tx.acknowledgeIfCurrent(row.id, row.record.prepared_content_hash, accepted);
    }
    for (const error of result.receipt.errors) {
      if (RETRYABLE_REJECTIONS.has(error.reason)) continue;
      const row = pending[error.index];
      if (row === undefined) throw new Error("analytics_receipt_index_out_of_range");
      await tx.markTerminalIfCurrent(row.id, row.record.prepared_content_hash, error.reason);
    }
  });
  // The store excludes terminal rows from pendingAnalytics and retains them for owner review.
  // Rate/quota rows remain pending; local failure above never changes a row.
}
