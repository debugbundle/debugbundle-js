import { sanitizeTelemetry } from "@debugbundle/redaction";

/** Explicit, bounded flow observations. This client never navigates or supplies consent UI. */
export interface AnalyticsFlowClientOptions {
  endpoint: string;
  projectId: string;
  projectToken: string;
  flowKey: string;
  enabled?: boolean;
  consentRequired?: boolean;
  requestTimeoutMs?: number;
}
export interface AnalyticsFlowClient {
  setConsent(granted: boolean): void;
  start(stepKey: string, attribution?: { source?: string; campaign?: string }): Promise<boolean>;
  step(stepKey: string): Promise<boolean>;
  handoff(stepKey: string, destination: string): Promise<string | null>;
  arrive(): Promise<boolean>;
  withdraw(): Promise<void>;
}
type State = { context: string; expires: number; pendingToken?: string; pendingStep?: string };
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const stepPattern = /^[a-z][a-z0-9_.-]{0,63}$/;
const labelPattern = /^[a-zA-Z0-9][a-zA-Z0-9._~+-]{0,99}$/;
function readAttribution(input: {
  source?: string;
  campaign?: string;
}): { source?: string; campaign?: string } | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  for (const key in input) {
    if (key !== "source" && key !== "campaign") return null;
  }
  const output: { source?: string; campaign?: string } = {};
  for (const key of ["source", "campaign"] as const) {
    const field = Object.getOwnPropertyDescriptor(input, key);
    if (field && !("value" in field)) return null;
    const value: unknown = field?.value;
    if (value === undefined) continue;
    if (typeof value !== "string" || !labelPattern.test(value)) return null;
    const checked = sanitizeTelemetry(value);
    if (!checked.ok || checked.value !== value) return null;
    output[key] = value;
  }
  return output;
}
function secret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
function validOrigin(url: URL): boolean {
  return (
    !url.username &&
    !url.password &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}
async function readResponse(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return null;
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    const data: unknown = JSON.parse(text + decoder.decode());
    return data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  } finally {
    reader.releaseLock();
  }
}
export function createAnalyticsFlowClient(
  options: AnalyticsFlowClientOptions
): AnalyticsFlowClient {
  try {
    return createFlowClient(options);
  } catch {
    // JavaScript callers can supply malformed config despite the TypeScript contract.
    return {
      setConsent() {},
      start: () => Promise.resolve(false),
      step: () => Promise.resolve(false),
      handoff: () => Promise.resolve(null),
      arrive: () => Promise.resolve(false),
      withdraw: () => Promise.resolve()
    };
  }
}
function createFlowClient(options: AnalyticsFlowClientOptions): AnalyticsFlowClient {
  let consent = false;
  let denied = false;
  let generation = 0;
  let pending = 0;
  let queue = Promise.resolve();
  const controllers = new Set<AbortController>();
  const key = `debugbundle:flow:${options.projectId}:${options.flowKey}`;
  const allowed = (): boolean =>
    options.enabled === true && !denied && (options.consentRequired === false || consent);
  const load = (): State | null => {
    try {
      const raw: unknown = JSON.parse(window.sessionStorage.getItem(key) ?? "null");
      if (
        !raw ||
        typeof raw !== "object" ||
        !("context" in raw) ||
        typeof raw.context !== "string" ||
        !secretPattern.test(raw.context) ||
        !("expires" in raw) ||
        typeof raw.expires !== "number" ||
        raw.expires <= Date.now() ||
        raw.expires > Date.now() + 86400_000
      ) {
        window.sessionStorage.removeItem(key);
        return null;
      }
      if (
        "pendingToken" in raw &&
        (typeof raw.pendingToken !== "string" || !secretPattern.test(raw.pendingToken))
      )
        return null;
      if (
        "pendingStep" in raw &&
        (typeof raw.pendingStep !== "string" || !stepPattern.test(raw.pendingStep))
      )
        return null;
      return raw as State;
    } catch {
      return null;
    }
  };
  const save = (state: State): void => {
    window.sessionStorage.setItem(key, JSON.stringify(state));
  };
  const clear = (): void => {
    try {
      window.sessionStorage.removeItem(key);
    } catch {
      /* unavailable storage */
    }
  };
  async function request(
    operation: string,
    body: Record<string, unknown>,
    epoch: number,
    withdrawal = false
  ): Promise<Record<string, unknown> | null> {
    if (!withdrawal && (!allowed() || epoch !== generation)) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const base = new URL(options.endpoint);
      if (
        !validOrigin(base) ||
        base.search ||
        base.hash ||
        !stepPattern.test(options.flowKey) ||
        !/^[0-9a-f-]{36}$/i.test(options.projectId) ||
        !options.projectToken.startsWith("dbundle_proj_")
      )
        return null;
      controllers.add(controller);
      const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort();
            resolve(null);
          },
          Math.min(5000, Math.max(100, options.requestTimeoutMs ?? 2000))
        );
      });
      const transport = async (): Promise<Record<string, unknown> | null> => {
        const response = await fetch(
          `${base.toString().replace(/\/$/, "")}/v1/analytics/flows/${options.projectId}/${options.flowKey}/${operation}`,
          {
            method: "POST",
            credentials: "omit",
            redirect: "error",
            referrerPolicy: "no-referrer",
            signal: controller.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${options.projectToken}`
            },
            body: JSON.stringify({ ...body, consent })
          }
        );
        return readResponse(response);
      };
      const result = await Promise.race([transport(), timeout]);
      if (!withdrawal && epoch !== generation) {
        // An aborted request may already have committed. Delete that context again.
        void request("withdraw", { context: body["context"] }, generation, true);
        return null;
      }
      return result;
    } catch {
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  function schedule<T>(fallback: T, work: (epoch: number) => Promise<T>): Promise<T> {
    if (pending >= 32) return Promise.resolve(fallback);
    const epoch = generation;
    pending++;
    const result = queue.then(async () => {
      try {
        return epoch === generation ? await work(epoch) : fallback;
      } catch {
        return fallback;
      }
    });
    queue = result.then(() => {
      pending--;
    });
    return result;
  }
  function accept(result: Record<string, unknown> | null, state: State, epoch: number): boolean {
    const expires =
      typeof result?.["expires_at"] === "string" ? Date.parse(result["expires_at"]) : NaN;
    if (
      epoch !== generation ||
      !allowed() ||
      !Number.isFinite(expires) ||
      expires <= Date.now() ||
      expires > Date.now() + 86400_000
    )
      return false;
    save({ context: state.context, expires });
    return true;
  }
  async function withdraw(): Promise<void> {
    const state = load();
    denied = true;
    consent = false;
    generation++;
    for (const controller of controllers) controller.abort();
    clear();
    if (state) await request("withdraw", { context: state.context }, generation, true);
  }
  return {
    setConsent(granted) {
      if (granted) {
        consent = true;
        denied = false;
      } else {
        void withdraw();
      }
    },
    withdraw,
    start(stepKey, attribution = {}) {
      return schedule(false, async (epoch) => {
        const fields = readAttribution(attribution);
        if (!allowed() || !stepPattern.test(stepKey) || fields === null) return false;
        let state = load();
        if (state && !state.pendingStep && !state.pendingToken) return true;
        if (state?.pendingToken || (state?.pendingStep && state.pendingStep !== stepKey))
          return false;
        state ??= { context: secret(), expires: Date.now() + 600_000, pendingStep: stepKey };
        save(state); // Fail closed before sending if tab storage is blocked.
        return accept(
          await request(
            "start",
            {
              context: state.context,
              step_key: stepKey,
              ...fields
            },
            epoch
          ),
          state,
          epoch
        );
      });
    },
    step(stepKey) {
      return schedule(false, async (epoch) => {
        const state = load();
        if (!state || state.pendingStep || state.pendingToken || !stepPattern.test(stepKey))
          return false;
        return (
          (await request("step", { context: state.context, step_key: stepKey }, epoch))?.[
            "recorded"
          ] === true
        );
      });
    },
    handoff(stepKey, destination) {
      return schedule<string | null>(null, async (epoch) => {
        const state = load();
        const url = new URL(destination);
        if (
          !state ||
          state.pendingStep ||
          state.pendingToken ||
          !stepPattern.test(stepKey) ||
          !validOrigin(url)
        )
          return null;
        const token = secret();
        const result = await request(
          "handoff",
          { context: state.context, step_key: stepKey, token },
          epoch
        );
        if (result?.["origin"] !== url.origin) return null;
        const fragments = url.hash
          .slice(1)
          .split("&")
          .filter((part) => part && !part.startsWith("dbflow="));
        fragments.push(`dbflow=${token}`);
        url.hash = fragments.join("&");
        return url.toString();
      });
    },
    arrive() {
      // Scrub before consent checks and before any network request; do not touch OAuth query/state.
      let token: string | undefined;
      try {
        const url = new URL(window.location.href);
        const parts = url.hash.slice(1).split("&");
        const tokens = parts.filter((part) => part.startsWith("dbflow="));
        if (tokens.length) {
          token = tokens.length === 1 ? tokens[0]!.slice(7) : undefined;
          url.hash = parts.filter((part) => !part.startsWith("dbflow=")).join("&");
          window.history.replaceState(window.history.state, "", url.toString());
        }
      } catch {
        return Promise.resolve(false);
      }
      return schedule(false, async (epoch) => {
        if (!allowed()) return false;
        let state = load();
        if (token !== undefined) {
          if (!secretPattern.test(token)) return false;
          if (state?.pendingToken !== token)
            state = { context: secret(), expires: Date.now() + 600_000, pendingToken: token };
        }
        if (!state?.pendingToken) return false;
        save(state);
        return accept(
          await request("arrive", { context: state.context, token: state.pendingToken }, epoch),
          state,
          epoch
        );
      });
    }
  };
}
