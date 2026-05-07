import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { EventEnvelope } from "@debugbundle/shared-types";
import {
  createFileTransport,
} from "../../../packages/sdk-node/src/file-transport.js";

function makeEnvelope(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    schema_version: "2026-03-01",
    event_id: "00000000-0000-0000-0000-000000000001",
    event_type: "backend_exception",
    project_token: "tok_test",
    sdk_name: "@debugbundle/sdk-node",
    sdk_version: "0.1.0",
    service: {
      name: "test-service",
      runtime: "node",
      framework: null,
      environment: "development",
    },
    occurred_at: "2026-03-20T12:00:00.000Z",
    correlation: {
      request_id: null,
      trace_id: null,
      session_id: null,
      user_id_hash: null,
    },
    payload: {
      message: "test error",
      type: "Error",
      stack_trace: "Error: test\n    at test.ts:1",
      handled: false,
      context: {},
    },
    ...overrides,
  } as EventEnvelope;
}

describe("createFileTransport", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "debugbundle-file-transport-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a JSON file containing events to the output directory", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });
    const events = [makeEnvelope()];

    const result = await transport({
      endpoint: "unused",
      headers: {},
      events,
      timeout_ms: 5000,
    });

    expect(result.status).toBe(202);

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".events.json"));
    expect(files).toHaveLength(1);

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]!), "utf-8")) as EventEnvelope[];
    expect(content).toHaveLength(1);
    expect(content[0]!.event_id).toBe("00000000-0000-0000-0000-000000000001");
  });

  it("writes local event files with owner-only permissions", async () => {
    if (process.platform === "win32") {
      return;
    }

    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    const result = await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    expect(result.status).toBe(202);
    const fileStats = fs.statSync(result.writtenFilePath!);
    expect(fileStats.mode & 0o777).toBe(0o600);
  });

  it("uses atomic write (no partial files visible)", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    // If atomic write works: no .tmp files remain, and the final file is valid JSON
    const allFiles = fs.readdirSync(tmpDir);
    const tmpFiles = allFiles.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);

    const jsonFiles = allFiles.filter((f) => f.endsWith(".events.json"));
    expect(jsonFiles).toHaveLength(1);

    // The file must parse as valid JSON (not truncated/partial)
    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, jsonFiles[0]!), "utf-8")) as EventEnvelope[];
    expect(content).toHaveLength(1);
  });

  it("names files with timestamp, sequence, and service for deterministic ordering", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope({ event_id: "00000000-0000-0000-0000-000000000002" })],
      timeout_ms: 5000,
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".events.json")).sort();
    expect(files).toHaveLength(2);

    // Format: <timestamp>-<sequence>-<service>.events.json
    for (const file of files) {
      expect(file).toMatch(/^\d+-\d+-test-service\.events\.json$/);
    }

    // Second file sorts after first (deterministic ordering)
    expect(files[0]! < files[1]!).toBe(true);
  });

  it("creates the events directory if it does not exist", async () => {
    const nestedDir = path.join(tmpDir, "nested", "events");
    const transport = createFileTransport({ eventsDir: nestedDir, serviceName: "test-service" });

    await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    const files = fs.readdirSync(nestedDir).filter((f) => f.endsWith(".events.json"));
    expect(files).toHaveLength(1);
  });

  it("handles multiple events in a single batch", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });
    const events = [
      makeEnvelope({ event_id: "00000000-0000-0000-0000-000000000001" }),
      makeEnvelope({ event_id: "00000000-0000-0000-0000-000000000002" }),
      makeEnvelope({ event_id: "00000000-0000-0000-0000-000000000003" }),
    ];

    await transport({
      endpoint: "unused",
      headers: {},
      events,
      timeout_ms: 5000,
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".events.json"));
    expect(files).toHaveLength(1);

    const content = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]!), "utf-8")) as EventEnvelope[];
    expect(content).toHaveLength(3);
  });

  it("returns status 202 on successful write", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    const result = await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    expect(result).toEqual({
      status: 202,
      writtenFilePath: expect.stringMatching(/\.events\.json$/)
    });
  });

  it("returns status 500 on write failure and does not throw", async () => {
    // Point at a file (not directory) to cause ENOTDIR
    const filePath = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(filePath, "block");
    const transport = createFileTransport({ eventsDir: path.join(filePath, "events"), serviceName: "test-service" });

    const result = await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    expect(result.status).toBe(500);
  });

  it("does not leave temp files on successful write", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    const allFiles = fs.readdirSync(tmpDir);
    const tmpFiles = allFiles.filter((f) => f.includes(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("uses a randomized temp-file suffix before the final atomic rename", async () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../../packages/sdk-node/src/file-transport.ts"),
      "utf8"
    );

    expect(source).toContain("randomBytes(TEMP_FILE_RANDOM_BYTES)");
    expect(source).toContain(".tmp-${randomBytes(TEMP_FILE_RANDOM_BYTES).toString(\"hex\")}");
  });

  it("rejects non-canonical eventsDir paths", async () => {
    const nonCanonicalDir = `${tmpDir}/../escape-events`;
    expect(() => createFileTransport({ eventsDir: nonCanonicalDir, serviceName: "test-service" })).toThrow(
      "events_dir_must_be_canonical_absolute_path"
    );
    expect(fs.existsSync(path.resolve(nonCanonicalDir))).toBe(false);
  });

  it("rejects writes when the predicted final path is a symlink", async () => {
    if (process.platform === "win32") {
      return;
    }

    const timestamp = 1_763_000_000_000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(timestamp);
    const finalPath = path.join(tmpDir, `${timestamp}-1-test-service.events.json`);
    const targetPath = path.join(tmpDir, "symlink-target.txt");
    fs.writeFileSync(targetPath, "do-not-overwrite", "utf8");
    fs.symlinkSync(targetPath, finalPath);

    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    try {
      const result = await transport({
        endpoint: "unused",
        headers: {},
        events: [makeEnvelope()],
        timeout_ms: 5000,
      });

      expect(result.status).toBe(500);
      expect(fs.readFileSync(targetPath, "utf8")).toBe("do-not-overwrite");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("increments sequence counter across calls", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    for (let i = 0; i < 3; i++) {
      await transport({
        endpoint: "unused",
        headers: {},
        events: [makeEnvelope()],
        timeout_ms: 5000,
      });
    }

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".events.json")).sort();
    expect(files).toHaveLength(3);

    // Extract sequences and verify they are monotonically increasing
    const sequences = files.map((f) => {
      const match = f.match(/^\d+-(\d+)-test-service\.events\.json$/);
      return parseInt(match![1]!, 10);
    });
    expect(sequences[0]!).toBeLessThan(sequences[1]!);
    expect(sequences[1]!).toBeLessThan(sequences[2]!);
  });

  it("skips writing when events array is empty", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "test-service" });

    const result = await transport({
      endpoint: "unused",
      headers: {},
      events: [],
      timeout_ms: 5000,
    });

    expect(result.status).toBe(202);
    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".events.json"));
    expect(files).toHaveLength(0);
  });

  it("sanitizes the service name when building filenames", async () => {
    const transport = createFileTransport({ eventsDir: tmpDir, serviceName: "api/worker service" });

    await transport({
      endpoint: "unused",
      headers: {},
      events: [makeEnvelope()],
      timeout_ms: 5000,
    });

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith(".events.json"));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d+-\d+-api-worker-service\.events\.json$/);
  });
});
