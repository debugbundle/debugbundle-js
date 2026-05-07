import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  DebugBundleDiagnostic,
  DebugBundleProjectMode,
  DebugBundleTransport,
  DebugBundleTransportRequest,
  DebugBundleTransportResponse,
} from "./types.js";
import { createFetchTransport } from "./utils.js";

export interface FileTransportOptions {
  /** Absolute path to the events directory (e.g. `.debugbundle/local/events/`). */
  eventsDir: string;
  /** Service name used to make per-service event files unique in monorepos. */
  serviceName: string;
}

export interface DefaultNodeTransportOptions {
  environment: string;
  projectMode: DebugBundleProjectMode;
  projectToken: string;
  endpoint: string;
  fetchImpl: typeof fetch;
  localEventsDir?: string;
  serviceName: string;
}

export interface DefaultNodeTransportSelection {
  transport: DebugBundleTransport;
  shouldRefreshRemoteConfig: boolean;
  diagnostic?: DebugBundleDiagnostic;
}

const LOCAL_ENVIRONMENTS = new Set(["local", "development"]);
const REMOTE_ENVIRONMENTS = new Set(["staging", "production"]);
const LOCAL_EVENTS_DIRECTORY_MODE = 0o700;
const LOCAL_EVENT_FILE_MODE = 0o600;
const TEMP_FILE_RANDOM_BYTES = 8;
const OPTIONAL_NOFOLLOW_FLAG = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;

function normalizeEnvironment(environment: string): string {
  return environment.trim().toLowerCase();
}

function sanitizeServiceName(serviceName: string): string {
  const normalized = serviceName
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return normalized.length > 0 ? normalized : "service";
}

function stripTrailingSeparators(value: string): string {
  const root = path.parse(value).root;
  return value.length > root.length ? value.replace(/[\\/]+$/g, "") : value;
}

function resolveValidatedEventsDir(eventsDir: string): string {
  const original = stripTrailingSeparators(eventsDir);
  const normalized = stripTrailingSeparators(path.normalize(eventsDir));
  const resolved = stripTrailingSeparators(path.resolve(eventsDir));

  if (!path.isAbsolute(original) || original !== normalized || original !== resolved) {
    throw new Error("events_dir_must_be_canonical_absolute_path");
  }

  return resolved;
}

function assertNotSymlink(targetPath: string): void {
  try {
    if (fs.lstatSync(targetPath).isSymbolicLink()) {
      throw new Error("symlink_path_rejected");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}

function writeSecureTempFile(tmpPath: string, payload: string): void {
  const fileDescriptor = fs.openSync(
    tmpPath,
    fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | OPTIONAL_NOFOLLOW_FLAG,
    LOCAL_EVENT_FILE_MODE
  );

  try {
    fs.writeFileSync(fileDescriptor, payload, { encoding: "utf-8" });
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

export function resolveDefaultLocalEventsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".debugbundle", "local", "events");
}

function createNoopTransport(): DebugBundleTransport {
  return (): Promise<DebugBundleTransportResponse> => Promise.resolve({ status: 202 });
}

export function resolveDefaultNodeTransport(options: DefaultNodeTransportOptions): DefaultNodeTransportSelection {
  const normalizedEnvironment = normalizeEnvironment(options.environment);

  if (LOCAL_ENVIRONMENTS.has(normalizedEnvironment)) {
    return {
      transport: createFileTransport({
        eventsDir: options.localEventsDir ?? resolveDefaultLocalEventsDir(),
        serviceName: options.serviceName,
      }),
      shouldRefreshRemoteConfig: false,
    };
  }

  if (options.projectMode === "local-only" && REMOTE_ENVIRONMENTS.has(normalizedEnvironment)) {
    return {
      transport: createNoopTransport(),
      shouldRefreshRemoteConfig: false,
      diagnostic: {
        code: "remote_capture_disabled",
        message:
          "DebugBundle: staging/production environment detected but project is local-only. Events will not be captured remotely. Run `debugbundle connect` to enable cloud delivery for this environment.",
        metadata: {
          environment: options.environment,
          project_mode: options.projectMode as string,
        },
      },
    };
  }

  return {
    transport: createFetchTransport(options.fetchImpl, options.projectToken),
    shouldRefreshRemoteConfig: true,
  };
}

/**
 * Creates a file-based transport that writes event batches as JSON files.
 *
 * Each flush produces one file: `<timestamp>-<sequence>-<service>.events.json`.
 * Writes are atomic (temp file + rename) to prevent partial reads by the CLI processor.
 * The transport never throws — write failures return status 500 instead.
 * Successful writes include the final written file path in the response.
 */
export function createFileTransport(options: FileTransportOptions): DebugBundleTransport {
  const validatedEventsDir = resolveValidatedEventsDir(options.eventsDir);
  const { serviceName } = options;
  let sequence = 0;
  let dirEnsured = false;
  const safeServiceName = sanitizeServiceName(serviceName);

  return (
    request: DebugBundleTransportRequest
  ): Promise<DebugBundleTransportResponse> => {
    if (request.events.length === 0) {
      return Promise.resolve({ status: 202 });
    }

    try {
      if (!dirEnsured) {
        fs.mkdirSync(validatedEventsDir, { recursive: true, mode: LOCAL_EVENTS_DIRECTORY_MODE });
        dirEnsured = true;
      }

      const timestamp = Date.now();
      const seq = ++sequence;
      const filename = `${timestamp}-${seq}-${safeServiceName}.events.json`;
      const finalPath = path.join(validatedEventsDir, filename);
      const tmpPath = `${finalPath}.tmp-${randomBytes(TEMP_FILE_RANDOM_BYTES).toString("hex")}`;

      const payload = JSON.stringify(request.events);

      assertNotSymlink(finalPath);
      writeSecureTempFile(tmpPath, payload);
      fs.renameSync(tmpPath, finalPath);

      return Promise.resolve({ status: 202, writtenFilePath: finalPath });
    } catch {
      try {
        const candidateTempFiles = fs.readdirSync(validatedEventsDir).filter((entry) => entry.includes(".tmp-"));
        for (const candidate of candidateTempFiles) {
          fs.rmSync(path.join(validatedEventsDir, candidate), { force: true });
        }
      } catch {
        // Best-effort temp cleanup only.
      }

      // SDK safety: never throw into user code (contracts/sdk-interface.md §7)
      return Promise.resolve({ status: 500 });
    }
  };
}
