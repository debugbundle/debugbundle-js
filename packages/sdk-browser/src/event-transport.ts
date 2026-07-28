import { buildBrowserTransportRequestBody, getNavigatorSource } from "./runtime.js";
import { decideBrowserAcknowledgement } from "./ingestion-acknowledgement.js";
import type {
  ActiveConfig,
  BrowserAnalyticsEventEnvelope,
  DebugBundleBrowserTransportEvent
} from "./types.js";

export type BrowserTransportLaneName = "debug" | "analytics";

interface BrowserTransportLane {
  events: DebugBundleBrowserTransportEvent[];
  flushPromise: Promise<void> | null;
  timer: ReturnType<typeof setTimeout> | null;
  nextRetryAt: number | null;
  consecutiveFailures: number;
  rejected: boolean;
  lastEventAt: number | null;
}

interface BrowserEventTransportCallbacks {
  onDebugResponse(payload: unknown): void;
  onUnauthorized(
    lane: BrowserTransportLaneName,
    statusCode: 401 | 403,
    endpoint: string,
    body: unknown
  ): void;
  onAcknowledgementDiagnostic(
    lane: BrowserTransportLaneName,
    code: "invalid" | "terminal_rejection",
    detail: string
  ): void;
}

function createLane(): BrowserTransportLane {
  return {
    events: [],
    flushPromise: null,
    timer: null,
    nextRetryAt: null,
    consecutiveFailures: 0,
    rejected: false,
    lastEventAt: null
  };
}

export class BrowserEventTransport {
  private config: ActiveConfig | null = null;
  private debug = createLane();
  private analytics = createLane();

  public constructor(private readonly callbacks: BrowserEventTransportCallbacks) {}

  public configure(config: ActiveConfig): void {
    this.reset();
    this.config = config;
  }

  public get debugRejected(): boolean {
    return this.debug.rejected;
  }

  public get status(): "healthy" | "degraded" | "disconnected" {
    if (this.config === null || this.debug.rejected || this.debug.consecutiveFailures >= 3) {
      return "disconnected";
    }
    return this.debug.nextRetryAt === null ? "healthy" : "degraded";
  }

  public get lastEventAt(): number | null {
    const values = [this.debug.lastEventAt, this.analytics.lastEventAt].filter(
      (value): value is number => value !== null
    );
    return values.length === 0 ? null : Math.max(...values);
  }

  public enqueueDebug(event: DebugBundleBrowserTransportEvent): void {
    this.enqueue("debug", event);
  }

  public enqueueAnalytics(event: BrowserAnalyticsEventEnvelope): void {
    this.enqueue("analytics", event);
  }

  public async flush(): Promise<void> {
    await Promise.all([
      this.flushLane("debug"),
      this.flushLane("analytics")
    ]);
  }

  public scheduleDebug(delayMs?: number): void {
    this.schedule("debug", delayMs);
  }

  public flushViaBeacon(): void {
    this.flushLaneViaBeacon("debug");
    this.flushLaneViaBeacon("analytics");
  }

  public reset(): void {
    this.clearLaneTimer(this.debug);
    this.clearLaneTimer(this.analytics);
    this.debug = createLane();
    this.analytics = createLane();
    this.config = null;
  }

  private enqueue(laneName: BrowserTransportLaneName, event: DebugBundleBrowserTransportEvent): void {
    const config = this.config;
    const lane = this.getLane(laneName);
    if (config === null || lane.rejected) {
      return;
    }

    lane.events.push(event);
    if (lane.events.length >= config.batchSize) {
      queueMicrotask(() => {
        void this.flushLane(laneName);
      });
      return;
    }
    this.schedule(laneName);
  }

  private async flushLane(laneName: BrowserTransportLaneName): Promise<void> {
    const config = this.config;
    const lane = this.getLane(laneName);
    if (config === null || lane.events.length === 0 || lane.rejected) {
      return;
    }
    if (lane.flushPromise !== null) {
      return lane.flushPromise;
    }
    if (lane.nextRetryAt !== null && Date.now() < lane.nextRetryAt) {
      return;
    }

    this.clearLaneTimer(lane);
    const events = [...lane.events];
    lane.flushPromise = (async () => {
      try {
        const response = await config.transport({
          endpoint: config.endpoint,
          headers: getTransportHeaders(config),
          events,
          transportMode: config.transportMode,
          timeout_ms: config.requestTimeoutMs
        });

        if (response.status >= 200 && response.status < 300) {
          this.reconcileSuccessfulResponse(
            laneName,
            lane,
            events,
            response.body,
            response.retry_after_ms
          );
          return;
        }

        lane.consecutiveFailures += 1;
        if (response.status === 401 || response.status === 403) {
          lane.rejected = true;
          lane.nextRetryAt = null;
          lane.events = [];
          this.callbacks.onUnauthorized(laneName, response.status, config.endpoint, response.body);
          return;
        }
        if (response.status === 429) {
          lane.nextRetryAt = Date.now() + (response.retry_after_ms ?? 1_000);
        }
      } catch {
        lane.consecutiveFailures += 1;
      } finally {
        lane.flushPromise = null;
        if (lane.events.length > 0 && !lane.rejected) {
          const retryDelay = lane.nextRetryAt === null
            ? undefined
            : Math.max(0, lane.nextRetryAt - Date.now());
          this.schedule(laneName, retryDelay);
        }
      }
    })();

    return lane.flushPromise;
  }

  private schedule(laneName: BrowserTransportLaneName, delayMs?: number): void {
    const config = this.config;
    const lane = this.getLane(laneName);
    if (config === null || lane.rejected) {
      return;
    }
    this.clearLaneTimer(lane);
    lane.timer = setTimeout(() => {
      lane.timer = null;
      void this.flushLane(laneName);
    }, delayMs ?? config.flushInterval);
  }

  private flushLaneViaBeacon(laneName: BrowserTransportLaneName): void {
    const config = this.config;
    const lane = this.getLane(laneName);
    const navigatorSource = getNavigatorSource();
    if (config === null || lane.events.length === 0 || lane.rejected || navigatorSource === null) {
      return;
    }

    const pendingEvents = [...lane.events];
    const body = buildBrowserTransportRequestBody(config.transportMode, pendingEvents);
    const flushViaKeepalive = (): void => {
      if (config.fetchImpl === null) {
        void this.flushLane(laneName);
        return;
      }
      void config.fetchImpl(config.endpoint, {
        method: "POST",
        headers: getTransportHeaders(config),
        body,
        keepalive: true
      }).then((response) => {
        if (response.status >= 200 && response.status < 300) {
          void readResponseBody(response).then((responseBody) => {
            this.reconcileSuccessfulResponse(
              laneName,
              lane,
              pendingEvents,
              responseBody,
              undefined
            );
            this.clearLaneTimer(lane);
          });
        }
      }).catch(() => undefined);
    };

    // Unload delivery preserves the established beacon-first path; a declined or
    // unavailable beacon falls back to keepalive fetch so acknowledgements can
    // still be reconciled when the browser permits a response.
    if (typeof navigatorSource.sendBeacon !== "function") {
      flushViaKeepalive();
      return;
    }

    const beaconBody = typeof Blob === "function"
      ? new Blob([body], { type: "application/json" })
      : body;
    if (navigatorSource.sendBeacon(config.endpoint, beaconBody)) {
      lane.events = [];
      lane.nextRetryAt = null;
      this.clearLaneTimer(lane);
      return;
    }
    flushViaKeepalive();
  }

  private getLane(name: BrowserTransportLaneName): BrowserTransportLane {
    return name === "debug" ? this.debug : this.analytics;
  }

  private reconcileSuccessfulResponse(
    laneName: BrowserTransportLaneName,
    lane: BrowserTransportLane,
    events: DebugBundleBrowserTransportEvent[],
    body: unknown,
    retryAfterMs: number | undefined
  ): void {
    const acknowledgement = decideBrowserAcknowledgement(body, events.length);
    if (acknowledgement.kind === "protocol_failure") {
      lane.consecutiveFailures += 1;
      lane.nextRetryAt = Date.now() + (retryAfterMs ?? 1_000);
      this.callbacks.onAcknowledgementDiagnostic(laneName, "invalid", acknowledgement.reason);
      return;
    }
    if (laneName === "debug") {
      this.callbacks.onDebugResponse(body);
    }
    if (acknowledgement.kind === "legacy") {
      reconcileLeadingEvents(lane, events, []);
      lane.nextRetryAt = null;
      lane.lastEventAt = Date.now();
      lane.consecutiveFailures = 0;
      return;
    }

    const retryableEvents = acknowledgement.retryableIndices
      .map((index) => events[index])
      .filter((event): event is DebugBundleBrowserTransportEvent => event !== undefined);
    reconcileLeadingEvents(lane, events, retryableEvents);
    if (acknowledgement.terminalErrors.length > 0) {
      const reasons = [...new Set(acknowledgement.terminalErrors.map((error) => error.reason))].join(",");
      this.callbacks.onAcknowledgementDiagnostic(laneName, "terminal_rejection", reasons);
    }
    if (acknowledgement.accepted > 0) {
      lane.lastEventAt = Date.now();
    }
    if (retryableEvents.length > 0) {
      lane.consecutiveFailures += 1;
      lane.nextRetryAt = Date.now() + (retryAfterMs ?? 1_000);
      return;
    }
    lane.nextRetryAt = null;
    lane.consecutiveFailures = acknowledgement.accepted > 0 ? 0 : 3;
  }

  private clearLaneTimer(lane: BrowserTransportLane): void {
    if (lane.timer !== null) {
      clearTimeout(lane.timer);
      lane.timer = null;
    }
  }
}

function reconcileLeadingEvents(
  lane: BrowserTransportLane,
  events: DebugBundleBrowserTransportEvent[],
  retainedEvents: DebugBundleBrowserTransportEvent[]
): void {
  if (
    lane.events.length >= events.length &&
    events.every((event, index) => lane.events[index]?.event_id === event.event_id)
  ) {
    lane.events.splice(0, events.length, ...retainedEvents);
  }
}

async function readResponseBody(response: { json?: () => Promise<unknown> }): Promise<unknown> {
  if (typeof response.json !== "function") {
    return undefined;
  }
  return response.json().catch(() => undefined);
}

function getTransportHeaders(config: ActiveConfig): Record<string, string> {
  return config.projectToken === null
    ? { "content-type": "application/json" }
    : {
        "content-type": "application/json",
        authorization: `Bearer ${config.projectToken}`
      };
}
