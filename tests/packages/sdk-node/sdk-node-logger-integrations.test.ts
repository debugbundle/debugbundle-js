import { describe, expect, it, vi } from "vitest";

import { attachLoggerIntegration } from "../../../packages/sdk-node/src/logger-integrations.js";

function getAttachmentResult(input: Parameters<typeof attachLoggerIntegration>[0]): {
  attached: boolean;
  restore?: () => void;
} {
  return attachLoggerIntegration(input) as {
    attached: boolean;
    restore?: () => void;
  };
}

describe("sdk-node logger integrations", () => {
  it("should ignore non-object and unsupported logger inputs", (): void => {
    const captureLog = vi.fn();

    expect(attachLoggerIntegration({ logger: null, captureApi: { captureLog } })).toEqual({ attached: false });
    expect(
      attachLoggerIntegration({
        logger: { child: vi.fn() },
        captureApi: { captureLog },
        resolveModule: () => {
          throw new Error("missing logger module");
        }
      })
    ).toEqual({ attached: false });
  });

  it("should attach pino-like loggers, normalize arguments, and restore patched methods", (): void => {
    const captureLog = vi.fn();
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn()
    };

    const attachment = getAttachmentResult({
      logger,
      captureApi: { captureLog },
      resolveModule: () => {
        throw new Error("missing logger module");
      }
    });

    expect(attachment.attached).toBe(true);
    logger.info({ query: "SELECT 1" }, "slow query");
    logger.error(new Error("kaboom"));
    logger.fatal("fatal issue");

    expect(captureLog).toHaveBeenNthCalledWith(
      1,
      "slow query",
      "info",
      {
        arg_0: { query: "SELECT 1" }
      }
    );
    expect(captureLog).toHaveBeenNthCalledWith(2, "kaboom", "error", expect.any(Object));
    const errorContext = captureLog.mock.calls[1]?.[2] as Record<string, unknown> | undefined;
    const errorArg = errorContext?.["arg_0"] as { name?: string; message?: string; stack?: string | null } | undefined;
    expect(errorArg?.name).toBe("Error");
    expect(errorArg?.message).toBe("kaboom");
    expect(typeof errorArg?.stack).toBe("string");
    expect(captureLog).toHaveBeenNthCalledWith(3, "fatal issue", "critical", {});

    captureLog.mockClear();
    attachment.restore?.();
    logger.warn("after restore");
    expect(captureLog).not.toHaveBeenCalled();
  });

  it("should attach winston-like loggers through the log method", (): void => {
    const captureLog = vi.fn();
    const logger = {
      log: vi.fn()
    };

    const attachment = getAttachmentResult({
      logger,
      captureApi: { captureLog },
      resolveModule: (moduleName: string) => {
        if (moduleName === "winston") {
          return "/virtual/winston/index.js";
        }

        throw new Error(`missing ${moduleName}`);
      }
    });

    expect(attachment.attached).toBe(true);
    logger.log("winston log", { requestId: "req_1" });
    expect(captureLog).toHaveBeenCalledWith("winston log", "info", { arg_1: { requestId: "req_1" } });
  });

  it("should classify bunyan-like loggers ahead of winston heuristics and capture trace or fatal output", (): void => {
    const captureLog = vi.fn();
    const logger = {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn()
    };

    const attachment = getAttachmentResult({
      logger,
      captureApi: { captureLog },
      resolveModule: () => {
        throw new Error("missing logger module");
      }
    });

    expect(attachment.attached).toBe(true);
    logger.trace("trace line");
    logger.fatal("fatal line");

    expect(captureLog).toHaveBeenNthCalledWith(1, "trace line", "debug", {});
    expect(captureLog).toHaveBeenNthCalledWith(2, "fatal line", "critical", {});
  });

  it("should report diagnostics when patching a logger throws", (): void => {
    const captureLog = vi.fn();
    const onDiagnostic = vi.fn();
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      fatal: vi.fn()
    } as Record<string, unknown>;

    Object.defineProperty(logger, "info", {
      configurable: true,
      writable: false,
      value: vi.fn()
    });

    const attachment = getAttachmentResult({
      logger,
      captureApi: { captureLog },
      resolveModule: (moduleName: string) => {
        if (moduleName === "pino") {
          return "/virtual/pino/index.js";
        }

        throw new Error(`missing ${moduleName}`);
      },
      onDiagnostic
    });

    expect(attachment).toEqual({ attached: false });
    const diagnostic = onDiagnostic.mock.calls[0]?.[0] as { code?: string; message?: string; metadata?: Record<string, unknown> } | undefined;
    expect(diagnostic?.code).toBe("logger_attach_failed");
    expect(diagnostic?.message).toBe("sdk-node failed to attach a logger integration");
    const diagnosticError = diagnostic?.metadata?.["error"] as { name?: string } | undefined;
    expect(diagnosticError?.name).toBe("TypeError");
  });
});