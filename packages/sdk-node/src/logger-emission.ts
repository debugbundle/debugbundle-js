import type { CaptureLogContext, LogLevel, LoggerAttachmentResult, LoggerCaptureApi } from "./types.js";
import { sanitizeUnknown } from "./utils.js";
import { nativeLoggedError } from "./logger-error.js";

type Logger = Record<PropertyKey, unknown>;
type NativeMethod = (this: Logger, ...args: unknown[]) => unknown;

function object(value: unknown): Logger | null {
  return value !== null && typeof value === "object" ? value as Logger : null;
}

function level(value: unknown): LogLevel | null {
  if (typeof value === "number") {
    return value >= 60 ? "critical" : value >= 50 ? "error" : value >= 40 ? "warning" : value >= 30 ? "info" : "debug";
  }
  const levels: Record<string, LogLevel> = { trace: "debug", debug: "debug", info: "info", warn: "warning", warning: "warning", error: "error", fatal: "critical", critical: "critical" };
  return typeof value === "string" ? levels[value] ?? null : null;
}

function pinoWriteSymbol(logger: Logger): symbol | undefined {
  // Pino exports this symbol in pino.symbols; discover it on the actual logger
  // so separate installed Pino copies keep their own symbol identity.
  let current: object | null = logger;
  const seen = new Set<object>();
  while (current !== null && !seen.has(current) && seen.size < 32) {
    seen.add(current);
    const key = Object.getOwnPropertySymbols(current).find(symbol => symbol.description === "pino.write");
    if (key !== undefined) return key;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

export function attachNativeLogger(logger: Logger, captureApi: LoggerCaptureApi): LoggerAttachmentResult | null {
  const pinoKey = pinoWriteSymbol(logger);
  const kind = pinoKey !== undefined ? "pino" : typeof logger["_emit"] === "function" && typeof logger["level"] === "function" ? "bunyan"
    : typeof logger["push"] === "function" && typeof logger["isLevelEnabled"] === "function" && typeof logger["log"] === "function" ? "winston" : null;
  if (kind === null) return null;
  const key = pinoKey ?? (kind === "bunyan" ? "_emit" : "push");
  const original = logger[key];
  if (typeof original !== "function") return null;
  const descriptor = Object.getOwnPropertyDescriptor(logger, key);
  let active = true;
  let capturing = false;
  let callError: Error | undefined;
  const methodRestorers: Array<() => void> = [];

  // Bunyan/Winston may serialise away Error identity before the accepted emit.
  // Carry it only on the synchronous native call stack; capture still happens
  // exclusively after the logger's own filters/formatters accepted the record.
  try {
  if (captureApi.captureLoggedException !== undefined) {
    for (const method of ["trace", "debug", "info", "warn", "warning", "error", "fatal", "critical", "log"]) {
      const native = logger[method];
      if (typeof native !== "function") continue;
      const owned = Object.getOwnPropertyDescriptor(logger, method);
      const instrumented: NativeMethod = function (...args) {
        if (!active) return Reflect.apply(native, this, args);
        const previous = callError;
        try {
          callError = args.slice(0, 3).map(nativeLoggedError).find(error => error !== undefined);
          return Reflect.apply(native, this, args);
        } finally { callError = previous; }
      };
      logger[method] = instrumented;
      methodRestorers.push(() => {
        if (logger[method] !== instrumented) return;
        if (owned === undefined) delete logger[method]; else Object.defineProperty(logger, method, owned);
      });
    }
  }

  const wrapped: NativeMethod = function (...args): unknown {
    // Invoke the native emission path exactly once. Application logger errors
    // and return values belong to the application, not to SDK failure handling.
    const result: unknown = Reflect.apply(original, this, args);
    if (!active || capturing) return result;
    capturing = true;
    try {
      let message: unknown;
      let severity: unknown;
      let fields: Logger = {};
      if (kind === "pino") {
        const entry = object(args[0]);
        message = args[1] ?? (args[0] instanceof Error ? args[0].message : entry?.["msg"] ?? entry?.["message"]);
        severity = args[2];
        if (entry !== null) fields = { arg_0: args[0] instanceof Error
          ? { name: args[0].name, message: args[0].message, stack: args[0].stack ?? null } : entry };
      } else {
        const entry = object(args[0]);
        if (entry === null || (kind === "bunyan" && args[1] === true)) return result;
        message = kind === "bunyan" ? entry["msg"] : entry["message"];
        severity = entry[Symbol.for("level")] ?? entry["level"];
        if (kind === "winston" && Reflect.apply(this["isLevelEnabled"] as NativeMethod, this, [severity]) !== true) return result;
        fields = { ...entry };
        delete fields["msg"];
        delete fields["message"];
        delete fields["level"];
      }
      const normalizedLevel = level(severity);
      if (normalizedLevel !== null) {
        const error = callError ?? nativeLoggedError(args[0]);
        if ((normalizedLevel === "error" || normalizedLevel === "critical") && error !== undefined && captureApi.captureLoggedException !== undefined) {
          captureApi.captureLoggedException(error, normalizedLevel, { ...sanitizeUnknown(fields) as CaptureLogContext, logger: kind,
            ...(typeof message === "string" ? { log_message: message } : {}) });
          return result;
        }
        captureApi.captureLog(typeof message === "string" ? message : `${normalizedLevel} log`, normalizedLevel, sanitizeUnknown(fields) as CaptureLogContext);
      }
    } catch {
      // Instrumentation, hostile fields and capture callbacks cannot break logs.
    } finally {
      capturing = false;
    }
    return result;
  };
  logger[key] = wrapped;
  return { attached: true, restore: (): void => {
    active = false;
    for (const restore of methodRestorers) { try { restore(); } catch { /* Inactive wrappers preserve native calls. */ } }
    try {
      if (logger[key] !== wrapped) return;
      if (descriptor === undefined) delete logger[key];
      else Object.defineProperty(logger, key, descriptor);
    } catch {
      // A logger frozen after attachment retains an inactive native wrapper.
    }
  } };
  } catch {
    active = false;
    for (const restore of methodRestorers.reverse()) { try { restore(); } catch { /* Inactive wrappers retain native behaviour. */ } }
    return { attached: false };
  }

}
