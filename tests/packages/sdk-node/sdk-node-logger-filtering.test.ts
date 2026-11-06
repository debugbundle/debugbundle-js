import { Writable } from "node:stream";
import bunyan from "bunyan";
import pino from "pino";
import winston from "winston";
import { describe, expect, it, vi } from "vitest";
import { nativeLoggedError, nativeLoggerContext } from "../../../packages/sdk-node/src/logger-error.js";
import { attachLoggerIntegration } from "../../../packages/sdk-node/src/logger-integrations.js";
import type { LoggerCaptureApi } from "../../../packages/sdk-node/src/types.js";

it("restores native logger methods if attachment fails partway through", () => {
  const logger = pino({ level: "error" }, { write: () => undefined });
  const debug = logger.debug;
  const error = logger.error;
  Object.defineProperty(logger, "error", { value: error, writable: false, configurable: false });
  const result = attachLoggerIntegration({ logger, captureApi: { captureLog: vi.fn(), captureLoggedException: vi.fn() } });
  expect(result.attached).toBe(false);
  expect(logger.debug).toBe(debug);
  expect(logger.error).toBe(error);
});

describe("native logger filtering", () => {
  it("bounds logger metadata without invoking nested getters, proxies or serializers", () => {
    let calls = 0;
    const hostile = new Proxy({}, { ownKeys() { calls++; throw new Error("host proxy"); } });
    const value = { hostile, text: "x".repeat(5000), list: Array.from({ length: 70 }, () => true),
      number: Infinity, nothing: null, fn: () => { calls++; } };
    Object.defineProperty(value, "getter", { enumerable: true, get() { calls++; throw new Error("host getter"); } });
    const snapshot = nativeLoggerContext(value);
    expect(calls).toBe(0);
    expect(snapshot).toMatchObject({ hostile: "[Unavailable]", getter: "[Unavailable]", number: null, nothing: null, fn: "[Unavailable]" });
    expect(snapshot["text"]).toMatch(/\[Truncated\]$/);
    expect(snapshot["list"]).toHaveLength(65);
    expect(nativeLoggerContext(hostile)).toEqual({});
    const cyclic: Record<string, unknown> = {}; cyclic["self"] = cyclic;
    expect(nativeLoggerContext(cyclic)).toMatchObject({ self: "[Circular]" });
    expect(nativeLoggerContext(Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`key${i}`, true])))).toHaveProperty("_debugbundle_truncated", true);
  });
  it("only promotes real native errors from safe own data slots", () => {
    const error = new Error("native");
    for (const key of ["err", "error", "exception"]) expect(nativeLoggedError({ [key]: error })).toBe(error);
    let calls = 0;
    const getter = Object.defineProperty({}, "err", { get() { calls++; throw error; } });
    for (const value of [null, "error", {}, { err: null }, { err: "text" }, getter, Object.create({ err: error }),
      new Proxy(error, { get() { calls++; throw error; } }), { error: new Proxy(error, {}) }]) {
      expect(nativeLoggedError(value)).toBeUndefined();
    }
    expect(calls).toBe(0);
  });
  it("retains the original native error through Pino, Bunyan and Winston serialization", () => {
    const loggers: Array<{ warn: (error: Error) => unknown; error: (error: Error) => unknown }> = [pino({ level: "error" }, { write: () => undefined }),
      bunyan.createLogger({ name: "synthetic", level: "error", stream: new Writable({ write(_chunk, _encoding, done) { done(); } }) }),
      winston.createLogger({ level: "error", transports: [new winston.transports.Stream({ stream: new Writable({ write(_chunk, _encoding, done) { done(); } }) })] })];
    for (const logger of loggers) {
      const captureLog = vi.fn(), captureLoggedException = vi.fn();
      const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog, captureLoggedException } });
      const error = new Error("synthetic outer", { cause: new TypeError("synthetic cause") });
      logger.warn(error);
      expect(captureLoggedException).not.toHaveBeenCalled();
      logger.error(error);
      expect(captureLoggedException).toHaveBeenCalledExactlyOnceWith(error, "error", expect.objectContaining({ logger: expect.any(String) }));
      expect(captureLog).not.toHaveBeenCalled();
      attachment.restore?.();
      logger.error(error);
      expect(captureLoggedException).toHaveBeenCalledTimes(1);
    }
  });
  it("deactivates capture when the application freezes a native emitter before detach", () => {
    const logger = pino({ level: "warn" }, { write: () => undefined });
    const captureLog = vi.fn();
    const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog } });
    Object.defineProperty(logger, pino.symbols.writeSym, { writable: false, configurable: false });
    expect(() => attachment.restore?.()).not.toThrow();
    logger.warn("after detach");
    expect(captureLog).not.toHaveBeenCalled();
  });

  it("isolates hostile logger detection and diagnostic callbacks", () => {
    const logger = new Proxy({}, { get() { throw new Error("getter failed"); } });
    expect(attachLoggerIntegration({ logger, captureApi: { captureLog: vi.fn() }, onDiagnostic() { throw new Error("diagnostic failed"); } })).toEqual({ attached: false });
  });

  it("preserves generic loggers during recursive capture, detach and native failures", () => {
    const warn = vi.fn();
    const logger = { info: vi.fn(), warn, error: vi.fn(() => { throw new Error("native failure"); }) };
    const captureLog = vi.fn(() => { logger.warn("nested"); });
    const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog } });
    const cached = logger.warn;
    logger.warn("accepted");
    expect(captureLog).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(() => logger.error()).toThrow("native failure");
    expect(logger.error).not.toBeUndefined();
    const replacement = vi.fn();
    logger.warn = replacement;
    attachment.restore?.();
    cached("detached");
    expect(logger.warn).toBe(replacement);
    expect(captureLog).toHaveBeenCalledTimes(1);
    attachment.restore?.();
  });

  it("preserves Pino error details and all standard severity mappings", () => {
    const logger = pino({ level: "trace" }, { write: () => undefined });
    const captureLog = vi.fn<LoggerCaptureApi["captureLog"]>();
    const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog } });
    logger.trace("trace");
    logger.debug("debug");
    logger.info("info");
    logger.warn({ orderId: 1 }, "warning");
    logger.error(new Error("error object"));
    logger.fatal({ msg: "fatal object" });
    expect(captureLog.mock.calls.map(call => call[1])).toEqual(["debug", "debug", "info", "warning", "error", "critical"]);
    expect(captureLog).toHaveBeenNthCalledWith(5, "error object", "error", {
      arg_0: { name: "Error", message: "error object", stack: expect.stringContaining("error object") }
    });
    expect(captureLog).toHaveBeenNthCalledWith(6, "fatal object", "critical", { arg_0: { msg: "fatal object" } });
    attachment.restore?.();
  });

  it("preserves an existing native emitter and a newer application replacement when detached", () => {
    const logger = pino({ level: "warn" }, { write: () => undefined });
    const key = pino.symbols.writeSym;
    const native = Reflect.get(logger, key) as (...args: unknown[]) => unknown;
    Object.defineProperty(logger, key, { value: native, writable: true, configurable: true });
    const first = attachLoggerIntegration({ logger, captureApi: { captureLog: vi.fn() } });
    first.restore?.();
    expect(Reflect.get(logger, key)).toBe(native);
    const second = attachLoggerIntegration({ logger, captureApi: { captureLog: vi.fn() } });
    const replacement = vi.fn();
    Reflect.set(logger, key, replacement);
    second.restore?.();
    expect(Reflect.get(logger, key)).toBe(replacement);
  });

  it("respects Pino levels, silent mode, hooks, dynamic levels, children and detach", () => {
    const output: string[] = [];
    const logger = pino({ level: "error", hooks: {
      logMethod(args, method) { if (args[0] !== "drop") method.apply(this, args); }
    } }, { write: (line: string) => output.push(line) });
    const captureLog = vi.fn<LoggerCaptureApi["captureLog"]>();
    const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog } });
    logger.warn("below level");
    logger.error("drop");
    expect(captureLog).not.toHaveBeenCalled();
    logger.error("accepted");
    logger.level = "silent";
    logger.error("silent");
    logger.level = "warn";
    const child = logger.child({ requestId: "req-1" });
    child.warn("child");
    expect(captureLog.mock.calls.map(call => call[0])).toEqual(["accepted", "child"]);
    expect(output).toHaveLength(2);
    attachment.restore?.();
    child.error("after detach");
    logger.error("after detach parent");
    expect(captureLog).toHaveBeenCalledTimes(2);
    expect(output).toHaveLength(4);
  });

  it("respects Bunyan levels without capturing enabled queries", () => {
    const records: unknown[] = [];
    const logger = bunyan.createLogger({ name: "test", level: "error", streams: [{ type: "raw", stream: { write: (record: unknown) => records.push(record) } }] });
    const captureLog = vi.fn<LoggerCaptureApi["captureLog"]>();
    const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog } });
    expect(logger.warn()).toBe(false);
    expect(logger.error()).toBe(true);
    logger.warn("suppressed");
    expect(captureLog).not.toHaveBeenCalled();
    logger.error("accepted");
    logger.level("warn");
    logger.warn("enabled later");
    expect(captureLog.mock.calls.map(call => call[0])).toEqual(["accepted", "enabled later"]);
    expect(records).toHaveLength(2);
    attachment.restore?.();
  });

  it("respects Winston levels, silent mode and format filters with one capture per emitted record", () => {
    const lines: string[] = [];
    const stream = new Writable({ write(chunk: Buffer, _encoding, done) { lines.push(chunk.toString()); done(); } });
    const logger = winston.createLogger({ level: "error", format: winston.format.combine(
      winston.format(info => info.message === "drop" ? false : info)(), winston.format.json()
    ), transports: [new winston.transports.Stream({ stream })] });
    const captureLog = vi.fn<LoggerCaptureApi["captureLog"]>();
    const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog } });
    logger.warn("suppressed");
    logger.error("drop");
    logger.silent = true;
    logger.error("silent");
    expect(captureLog).not.toHaveBeenCalled();
    logger.silent = false;
    logger.error("accepted");
    logger.log("error", "generic");
    logger.log({ level: "error", message: "object" });
    expect(captureLog.mock.calls.map(call => [call[0], call[1]])).toEqual([["accepted", "error"], ["generic", "error"], ["object", "error"]]);
    expect(lines).toHaveLength(3);
    attachment.restore?.();
    logger.close();
  });

  it("keeps native logging working when SDK capture throws or logs recursively", () => {
    const output: string[] = [];
    const logger = pino({ level: "warn" }, { write: (line: string) => output.push(line) });
    const captureLog = vi.fn(() => { logger.warn("nested"); throw new Error("SDK failed"); });
    const attachment = attachLoggerIntegration({ logger, captureApi: { captureLog } });
    expect(() => logger.warn("outer")).not.toThrow();
    expect(captureLog).toHaveBeenCalledTimes(1);
    expect(output).toHaveLength(2);
    attachment.restore?.();
  });
});
