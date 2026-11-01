import { formatNodeConsoleMessage } from "./event-support.js";
import type { LogLevel } from "./types.js";

/** Own only the listeners installed by this instance; dispose is idempotent. */
export class NodeLifecycleHooks {
  private uncaught: ((error: Error) => void) | null = null;
  private rejection: ((reason: unknown) => void) | null = null;
  private signal: (() => void) | null = null;
  private beforeExit: (() => void) | null = null;
  private error: typeof console.error | null = null;
  private warn: typeof console.warn | null = null;
  constructor(private readonly api: { capture(error: unknown, fatal: boolean): void; log(message: string, level: LogLevel): void; flush(): Promise<void> }) {}
  captureExceptions(): void {
    if (this.uncaught !== null) return;
    this.uncaught = (error) => { this.api.capture(error, true); void this.api.flush(); };
    process.on("uncaughtException", this.uncaught);
  }
  captureRejections(): void {
    if (this.rejection !== null) return;
    this.rejection = (reason) => { this.api.capture(reason, false); void this.api.flush(); };
    process.on("unhandledRejection", this.rejection);
  }
  captureConsole(): void {
    if (this.error !== null || this.warn !== null) return;
    this.error = console.error; this.warn = console.warn;
    console.error = (...args: unknown[]) => { this.error?.(...args); this.api.log(formatNodeConsoleMessage(args), "error"); };
    console.warn = (...args: unknown[]) => { this.warn?.(...args); this.api.log(formatNodeConsoleMessage(args), "warning"); };
  }
  registerShutdownFlush(): void {
    if (this.signal !== null) return;
    this.signal = () => { void this.api.flush(); };
    this.beforeExit = () => { void this.api.flush(); };
    process.on("SIGINT", this.signal); process.on("SIGTERM", this.signal); process.on("beforeExit", this.beforeExit);
  }
  dispose(): void {
    if (this.uncaught !== null) process.off("uncaughtException", this.uncaught);
    if (this.rejection !== null) process.off("unhandledRejection", this.rejection);
    if (this.signal !== null) { process.off("SIGINT", this.signal); process.off("SIGTERM", this.signal); }
    if (this.beforeExit !== null) process.off("beforeExit", this.beforeExit);
    if (this.error !== null) console.error = this.error;
    if (this.warn !== null) console.warn = this.warn;
    this.uncaught = null; this.rejection = null; this.signal = null; this.beforeExit = null; this.error = null; this.warn = null;
  }
}
