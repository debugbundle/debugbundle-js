import { types } from "node:util";

/** Bounded weak identity receipts for logger/hook + explicit/framework reports. */
export class ExceptionIdentity {
  private entries: Array<{ error: WeakRef<object>; scope: string; automatic: boolean; at: number }> = [];
  admit(error: unknown, scope: string | undefined, automatic: boolean): boolean {
    if (scope === undefined) return true;
    if (error === null || typeof error !== "object" || types.isProxy(error) || !types.isNativeError(error)) return true;
    const now = performance.now();
    this.entries = this.entries.filter(entry => entry.error.deref() !== undefined && now - entry.at < 30_000);
    const previous = this.entries.find(entry => entry.error.deref() === error && entry.scope === scope);
    if (previous !== undefined && automatic !== previous.automatic) {
      this.entries = this.entries.filter(entry => entry !== previous);
      return false;
    }
    return true;
  }
  remember(error: unknown, scope: string | undefined, automatic: boolean): void {
    if (scope === undefined || error === null || typeof error !== "object" || types.isProxy(error) || !types.isNativeError(error)) return;
    const now = performance.now();
    this.entries = this.entries.filter(entry => entry.error.deref() !== undefined && now - entry.at < 30_000
      && !(entry.error.deref() === error && entry.scope === scope));
    if (this.entries.length === 128) this.entries.shift();
    this.entries.push({ error: new WeakRef(error), scope, automatic, at: now });
  }
}
