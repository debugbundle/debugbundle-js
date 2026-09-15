import { createRequire } from "node:module";

import type { CaptureLogContext, DebugBundleDiagnostic, LogLevel, LoggerAttachmentResult, LoggerCaptureApi, ModuleResolver } from "./types.js";
import { sanitizeUnknown } from "./utils.js";
import { attachNativeLogger } from "./logger-emission.js";

const LOGGER_LEVEL_MAP: Record<string, LogLevel> = {
  trace: "debug",
  debug: "debug",
  info: "info",
  warn: "warning",
  warning: "warning",
  error: "error",
  fatal: "critical"
};

function defaultResolveModule(moduleName: string): string {
  return createRequire(import.meta.url).resolve(moduleName);
}

function canResolve(resolveModule: ModuleResolver, moduleName: string): boolean {
  try {
    resolveModule(moduleName);
    return true;
  } catch {
    return false;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function getFunction(record: Record<string, unknown>, key: string): ((...args: unknown[]) => unknown) | null {
  const value = record[key];
  return typeof value === "function" ? (value as (...args: unknown[]) => unknown) : null;
}

function looksLikePinoLogger(record: Record<string, unknown>): boolean {
  return ["info", "warn", "error"].every((methodName) => getFunction(record, methodName) !== null);
}

function looksLikeWinstonLogger(record: Record<string, unknown>): boolean {
  return getFunction(record, "log") !== null || ["info", "warn", "error"].every((methodName) => getFunction(record, methodName) !== null);
}

function looksLikeBunyanLogger(record: Record<string, unknown>): boolean {
  return ["info", "warn", "error", "fatal"].every((methodName) => getFunction(record, methodName) !== null);
}

function normalizeLoggerCall(level: LogLevel, args: unknown[]): { message: string; context: CaptureLogContext } {
  let message = `${level} log`;
  const context: CaptureLogContext = {};
  let messageCaptured = false;

  for (const [index, argument] of args.entries()) {
    if (typeof argument === "string" && !messageCaptured) {
      message = argument;
      messageCaptured = true;
      continue;
    }

    if (argument instanceof Error) {
      if (!messageCaptured) {
        message = argument.message;
        messageCaptured = true;
      }

      context[`arg_${index}`] = {
        name: argument.name,
        message: argument.message,
        stack: argument.stack ?? null
      };
      continue;
    }

    context[`arg_${index}`] = sanitizeUnknown(argument);
  }

  return {
    message,
    context
  };
}

function patchMethod(
  record: Record<string, unknown>,
  methodName: string,
  level: LogLevel,
  captureApi: LoggerCaptureApi,
  restorers: Array<() => void>
): void {
  const original = getFunction(record, methodName);
  if (original === null) {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(record, methodName);
  let active = true;
  const wrapped = (...args: unknown[]): unknown => {
    const result = Reflect.apply(original, record, args);
    try {
      if (!active || record["silent"] === true) return result;
      const enabled = getFunction(record, "isLevelEnabled");
      if (enabled !== null && Reflect.apply(enabled, record, [methodName]) === false) return result;
      const normalized = normalizeLoggerCall(level, args);
      captureApi.captureLog(normalized.message, level, normalized.context);
    } catch {
      // SDK capture failures must preserve the application's logger result.
    }
    return result;
  };

  record[methodName] = wrapped;
  restorers.push(() => {
    active = false;
    if (record[methodName] !== wrapped) return;
    if (descriptor === undefined) delete record[methodName];
    else Object.defineProperty(record, methodName, descriptor);
  });
}

export function attachLoggerIntegration(input: {
  logger: unknown;
  captureApi: LoggerCaptureApi;
  resolveModule?: ModuleResolver;
  onDiagnostic?: (diagnostic: DebugBundleDiagnostic) => void;
}): LoggerAttachmentResult {
  const loggerRecord = asRecord(input.logger);
  if (loggerRecord === null) {
    return { attached: false };
  }

  const restorers: Array<() => void> = [];
  let capturing = false;
  const captureApi: LoggerCaptureApi = { captureLog: (message, level, context): void => {
    if (capturing) return;
    capturing = true;
    try { input.captureApi.captureLog(message, level, context); }
    finally { capturing = false; }
  } };
  const restoreAll = (): void => {
    for (const restore of [...restorers].reverse()) {
      try { restore(); } catch { /* A changed or frozen logger must not break cleanup. */ }
    }
  };

  try {
    const resolveModule = input.resolveModule ?? defaultResolveModule;
    const supportsPinoModule = canResolve(resolveModule, "pino");
    const supportsWinstonModule = canResolve(resolveModule, "winston");
    const supportsBunyanModule = canResolve(resolveModule, "bunyan");
    const hasLogMethod = getFunction(loggerRecord, "log") !== null;
    const hasTraceMethod = getFunction(loggerRecord, "trace") !== null;
    const supportsBunyan = supportsBunyanModule || (looksLikeBunyanLogger(loggerRecord) && hasTraceMethod);
    const supportsPino = supportsPinoModule || (looksLikePinoLogger(loggerRecord) && !hasLogMethod && !hasTraceMethod);
    const supportsWinston = supportsWinstonModule || looksLikeWinstonLogger(loggerRecord);

    const native = attachNativeLogger(loggerRecord, captureApi);
    if (native !== null) return native;
    if (supportsPino) {
      patchMethod(loggerRecord, "debug", "debug", captureApi, restorers);
      patchMethod(loggerRecord, "info", "info", captureApi, restorers);
      patchMethod(loggerRecord, "warn", "warning", captureApi, restorers);
      patchMethod(loggerRecord, "error", "error", captureApi, restorers);
      patchMethod(loggerRecord, "fatal", "critical", captureApi, restorers);
      return {
        attached: restorers.length > 0,
        ...(restorers.length === 0
          ? {}
          : {
              restore: (): void => {
                restoreAll();
              }
            })
      };
    }

    if (supportsBunyan) {
      for (const [methodName, level] of Object.entries(LOGGER_LEVEL_MAP)) {
        patchMethod(loggerRecord, methodName, level, captureApi, restorers);
      }

      return {
        attached: restorers.length > 0,
        ...(restorers.length === 0
          ? {}
          : {
              restore: (): void => {
                restoreAll();
              }
            })
      };
    }

    if (supportsWinston) {
      patchMethod(loggerRecord, "debug", "debug", captureApi, restorers);
      patchMethod(loggerRecord, "info", "info", captureApi, restorers);
      patchMethod(loggerRecord, "warn", "warning", captureApi, restorers);
      patchMethod(loggerRecord, "error", "error", captureApi, restorers);
      patchMethod(loggerRecord, "log", "info", captureApi, restorers);
      return {
        attached: restorers.length > 0,
        ...(restorers.length === 0
          ? {}
          : {
              restore: (): void => {
                restoreAll();
              }
            })
      };
    }
  } catch (error) {
    restoreAll();
    try { input.onDiagnostic?.({
      code: "logger_attach_failed",
      message: "sdk-node failed to attach a logger integration",
      metadata: {
        error: sanitizeUnknown(error)
      }
    }); } catch { /* Diagnostic callbacks must not break application logging. */ }
  }

  return { attached: false };
}
