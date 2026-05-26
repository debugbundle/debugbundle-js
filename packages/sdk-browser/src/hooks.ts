import {
  captureCallerTrace,
  createBrowserTraceId,
  deriveSdkConfigEndpoint,
  detectDeviceType,
  getConsoleSource,
  getFetchSource,
  getMatchMedia,
  getNavigatorSource,
  getScreenSource,
  getWindowSource,
  getXmlHttpRequestConstructor,
  parseBrowserIdentity,
  parseOsIdentity,
  shouldInjectTraceHeader,
  stringifyConsoleArgs
} from "./runtime.js";
import type {
  ActiveConfig,
  BrowserBreadcrumb,
  BrowserDeviceInfo,
  BrowserFetch,
  BrowserFetchInit,
  BrowserFetchResponse,
  BrowserRequestMetadata,
  BrowserXmlHttpRequestConstructor
} from "./types.js";
import { MAX_BODY_CAPTURE_BYTES } from "./types.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const INTERESTING_RESPONSE_HEADERS = [
  "content-type",
  "x-debugbundle-trace-id",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
  "www-authenticate",
  "location"
] as const;

function truncateBody(body: string): string {
  if (body.length <= MAX_BODY_CAPTURE_BYTES) return body;
  return body.slice(0, MAX_BODY_CAPTURE_BYTES) + "...[truncated]";
}

function tryParseJsonBody(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractResponseHeaders(response: BrowserFetchResponse): Record<string, string> | undefined {
  if (!response.headers || typeof response.headers.get !== "function") return undefined;

  const extracted: Record<string, string> = {};
  for (const name of INTERESTING_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) {
      extracted[name] = value;
    }
  }

  return Object.keys(extracted).length > 0 ? extracted : undefined;
}

async function captureResponseBody(response: BrowserFetchResponse): Promise<string | undefined> {
  if (response.status >= 200 && response.status < 300) return undefined;
  if (typeof response.clone !== "function" || typeof response.text !== "function") return undefined;

  try {
    const cloned = response.clone();
    if (typeof cloned.text !== "function") return undefined;
    const text = await cloned.text();
    if (text.length === 0) return undefined;
    return truncateBody(text);
  } catch {
    return undefined;
  }
}

function captureRequestBody(init: BrowserFetchInit & Record<string, unknown>): unknown {
  const method = (typeof init.method === "string" ? init.method : "GET").toUpperCase();
  if (!MUTATING_METHODS.has(method)) return undefined;
  if (typeof init.body !== "string" || init.body.length === 0) return undefined;
  return tryParseJsonBody(truncateBody(init.body));
}

function buildNetworkBreadcrumbData(
  url: string,
  method: string,
  statusCode: number,
  durationMs: number,
  callerTrace: string[],
  extras: {
    requestMetadata: BrowserRequestMetadata | undefined;
    responseBody: string | undefined;
    requestBody: unknown;
    responseHeaders: Record<string, string> | undefined;
    responseContentLength: number | undefined;
    failureKind?: string;
    failureReason?: string;
  }
): Record<string, unknown> {
  const data: Record<string, unknown> = {
    url,
    method,
    status_code: statusCode,
    duration_ms: durationMs
  };

  if (callerTrace.length > 0) data["caller_trace"] = callerTrace;

  if (extras.responseBody !== undefined) {
    data["response_body"] = tryParseJsonBody(extras.responseBody);
  }
  if (extras.requestBody !== undefined) {
    data["request_body"] = extras.requestBody;
  }
  if (extras.responseHeaders !== undefined) {
    data["response_headers"] = extras.responseHeaders;
  }
  if (extras.responseContentLength !== undefined) {
    data["response_content_length"] = extras.responseContentLength;
  }
  if (extras.failureKind !== undefined) {
    data["failure_kind"] = extras.failureKind;
  }
  if (extras.failureReason !== undefined) {
    data["failure_reason"] = extras.failureReason;
  }

  const meta = extras.requestMetadata;
  if (meta?.operation !== undefined) data["operation"] = meta.operation;
  if (meta?.initiator !== undefined) data["initiator"] = meta.initiator;
  if (meta?.feature !== undefined) data["feature"] = meta.feature;

  return data;
}

function normalizeNetworkFailureReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return truncateBody(error.message.trim());
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return truncateBody(error.trim());
  }

  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>)["message"];
    if (typeof message === "string" && message.trim().length > 0) {
      return truncateBody(message.trim());
    }
  }

  return "network failure";
}

interface ConsoleHookInstallResult {
  originalConsoleError: ((...args: unknown[]) => void) | null;
  originalConsoleWarn: ((...args: unknown[]) => void) | null;
}

interface NetworkHookInstallResult {
  originalFetch: BrowserFetch | null;
  originalXmlHttpRequest: BrowserXmlHttpRequestConstructor | null;
}

export function installConsoleHook(
  config: ActiveConfig | null,
  addBreadcrumb: (breadcrumb: BrowserBreadcrumb) => void
): ConsoleHookInstallResult {
  const consoleSource = getConsoleSource();
  if (config === null || consoleSource === null || config.captureConsole !== true) {
    return {
      originalConsoleError: null,
      originalConsoleWarn: null
    };
  }

  let originalConsoleError: ((...args: unknown[]) => void) | null = null;
  let originalConsoleWarn: ((...args: unknown[]) => void) | null = null;

  if (typeof consoleSource.error === "function") {
    originalConsoleError = consoleSource.error.bind(consoleSource);
    consoleSource.error = (...args: unknown[]): void => {
      originalConsoleError?.(...args);
      addBreadcrumb({
        ts: new Date().toISOString(),
        breadcrumb_type: "console_log",
        data: {
          level: "error",
          message: stringifyConsoleArgs(args)
        }
      });
    };
  }

  if (typeof consoleSource.warn === "function") {
    originalConsoleWarn = consoleSource.warn.bind(consoleSource);
    consoleSource.warn = (...args: unknown[]): void => {
      originalConsoleWarn?.(...args);
      addBreadcrumb({
        ts: new Date().toISOString(),
        breadcrumb_type: "console_log",
        data: {
          level: "warning",
          message: stringifyConsoleArgs(args)
        }
      });
    };
  }

  return {
    originalConsoleError,
    originalConsoleWarn
  };
}

export function installNetworkHook(
  config: ActiveConfig | null,
  addBreadcrumb: (breadcrumb: BrowserBreadcrumb) => void,
  captureRequestFailure: (breadcrumb: BrowserBreadcrumb) => void,
  shouldCaptureNetworkRequest: (url: string, statusCode: number, durationMs: number) => boolean,
  shouldCaptureNetworkFailure: (url: string, durationMs: number) => boolean,
  getCurrentRoute: () => string | null
): NetworkHookInstallResult {
  const fetchSource = getFetchSource();
  const xmlHttpRequestConstructor = getXmlHttpRequestConstructor();
  if (config === null || (fetchSource === null && xmlHttpRequestConstructor === null)) {
    return {
      originalFetch: null,
      originalXmlHttpRequest: null
    };
  }

  const configEndpoint = deriveSdkConfigEndpoint(config.endpoint);

  if (fetchSource !== null) {
    (globalThis as Record<string, unknown>)["fetch"] = async (
      input: string,
      init?: BrowserFetchInit
    ): Promise<BrowserFetchResponse> => {
      const inputInit = (init ?? {}) as BrowserFetchInit & Record<string, unknown>;
      const { debugbundle: requestMetadata, headers: requestHeaders, ...forwardedInit } = inputInit;
      const callerTrace = captureCallerTrace(1, 5);
      const injectTraceHeader = shouldInjectTraceHeader(input, config.tracePropagationTargets);
      const traceId = injectTraceHeader ? createBrowserTraceId() : null;
      const startedAt = Date.now();
      try {
        const response = await fetchSource(input, {
          ...forwardedInit,
          headers: {
            ...(requestHeaders ?? {}),
            ...(traceId === null ? {} : { "X-DebugBundle-Trace-Id": traceId })
          }
        });
        const durationMs = Date.now() - startedAt;

        const shouldCaptureNetworkBreadcrumb =
          config.captureNetwork === true &&
          input !== config.endpoint &&
          input !== configEndpoint &&
          shouldCaptureNetworkRequest(input, response.status, durationMs);

        const requestBody = captureRequestBody(inputInit);
        if (shouldCaptureNetworkBreadcrumb || (injectTraceHeader && response.status >= 400)) {
          const responseBody = await captureResponseBody(response);
          const responseHeaders = extractResponseHeaders(response);
          const contentLengthHeader = response.headers?.get("content-length");
          const responseContentLength = contentLengthHeader !== null && contentLengthHeader !== undefined
            ? parseInt(contentLengthHeader, 10)
            : undefined;

          const breadcrumb = {
            ts: new Date().toISOString(),
            breadcrumb_type: "network_request",
            route: getCurrentRoute(),
            data: buildNetworkBreadcrumbData(
              input,
              typeof inputInit.method === "string" ? inputInit.method : "GET",
              response.status,
              durationMs,
              callerTrace,
              {
                requestMetadata,
                responseBody,
                requestBody,
                responseHeaders,
                responseContentLength: Number.isFinite(responseContentLength) ? responseContentLength : undefined
              }
            )
          } satisfies BrowserBreadcrumb;

          if (shouldCaptureNetworkBreadcrumb) {
            addBreadcrumb(breadcrumb);
          }
          if (injectTraceHeader && response.status >= 400) {
            captureRequestFailure(breadcrumb);
          }
        }

        return response;
      } catch (error) {
        const durationMs = Date.now() - startedAt;
        const shouldCaptureFailedNetworkBreadcrumb =
          config.captureNetwork === true &&
          input !== config.endpoint &&
          input !== configEndpoint &&
          shouldCaptureNetworkFailure(input, durationMs);

        if (shouldCaptureFailedNetworkBreadcrumb) {
          addBreadcrumb({
            ts: new Date().toISOString(),
            breadcrumb_type: "network_request",
            route: getCurrentRoute(),
            data: buildNetworkBreadcrumbData(
              input,
              typeof inputInit.method === "string" ? inputInit.method : "GET",
              0,
              durationMs,
              callerTrace,
              {
                requestMetadata,
                responseBody: undefined,
                requestBody: captureRequestBody(inputInit),
                responseHeaders: undefined,
                responseContentLength: undefined,
                failureKind: "network_error",
                failureReason: normalizeNetworkFailureReason(error)
              }
            )
          });
        }

        throw error;
      }
    };
  }

  if (xmlHttpRequestConstructor !== null) {
    const activeConfig = config;
    const activeXmlHttpRequestConstructor = xmlHttpRequestConstructor;
    const captureXmlHttpRequest = (url: string, method: string, statusCode: number, durationMs: number): void => {
      const isFirstParty = shouldInjectTraceHeader(url, activeConfig.tracePropagationTargets);
      const shouldCaptureNetworkBreadcrumb =
        activeConfig.captureNetwork === true &&
        url !== activeConfig.endpoint &&
        url !== configEndpoint &&
        shouldCaptureNetworkRequest(url, statusCode, durationMs);

      if (shouldCaptureNetworkBreadcrumb || (isFirstParty && statusCode >= 400)) {
        const breadcrumb = {
          ts: new Date().toISOString(),
          breadcrumb_type: "network_request",
          route: getCurrentRoute(),
          data: {
            url,
            method,
            status_code: statusCode,
            duration_ms: durationMs
          }
        } satisfies BrowserBreadcrumb;

        if (shouldCaptureNetworkBreadcrumb) {
          addBreadcrumb(breadcrumb);
        }
        if (isFirstParty && statusCode >= 400) {
          captureRequestFailure(breadcrumb);
        }
      }
    };

    (globalThis as Record<string, unknown>)["XMLHttpRequest"] = class WrappedXmlHttpRequest {
      public constructor() {
        const request = new activeXmlHttpRequestConstructor();
        let method = "GET";
        let url = "";
        let startedAt = 0;

        const originalOpen = request.open.bind(request);
        request.open = (nextMethod: string, nextUrl: string, async?: boolean): void => {
          method = nextMethod;
          url = nextUrl;
          originalOpen(nextMethod, nextUrl, async);
          if (shouldInjectTraceHeader(nextUrl, activeConfig.tracePropagationTargets)) {
            request.setRequestHeader("X-DebugBundle-Trace-Id", createBrowserTraceId());
          }
        };

        const originalSend = request.send.bind(request);
        request.send = (body?: unknown): void => {
          startedAt = Date.now();
          const onLoadEnd = (): void => {
            request.removeEventListener("loadend", onLoadEnd);
            const statusCode = typeof request.status === "number" ? request.status : 0;
            const durationMs = Date.now() - startedAt;
            captureXmlHttpRequest(url, method, statusCode, durationMs);
          };

          request.addEventListener("loadend", onLoadEnd);
          originalSend(body);
        };

        return request;
      }
    } as BrowserXmlHttpRequestConstructor;
  }

  return {
    originalFetch: fetchSource,
    originalXmlHttpRequest: xmlHttpRequestConstructor
  };
}

export function collectDeviceInfo(): BrowserDeviceInfo {
  const navigatorObject = getNavigatorSource();
  const screenObject = getScreenSource();
  const windowSource = getWindowSource();
  const userAgent = navigatorObject?.userAgent ?? null;
  const browser = parseBrowserIdentity(userAgent);
  const matchMedia = getMatchMedia();
  const colorSchemePreference =
    matchMedia !== null
      ? matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : null;

  return {
    user_agent: userAgent,
    os: parseOsIdentity(userAgent),
    browser,
    device_type: detectDeviceType(userAgent),
    screen: {
      width: typeof screenObject?.width === "number" ? screenObject.width : 0,
      height: typeof screenObject?.height === "number" ? screenObject.height : 0
    },
    viewport: {
      width: typeof windowSource?.innerWidth === "number"
        ? (windowSource.innerWidth ?? 0)
        : typeof screenObject?.width === "number"
          ? screenObject.width
          : 0,
      height: typeof windowSource?.innerHeight === "number"
        ? (windowSource.innerHeight ?? 0)
        : typeof screenObject?.height === "number"
          ? screenObject.height
          : 0
    },
    device_pixel_ratio:
      typeof windowSource?.devicePixelRatio === "number"
        ? (windowSource.devicePixelRatio ?? null)
        : null,
    touch_capable: typeof navigatorObject?.maxTouchPoints === "number" ? navigatorObject.maxTouchPoints > 0 : null,
    language: navigatorObject?.language ?? null,
    connection_type:
      typeof navigatorObject?.connection === "object" && navigatorObject.connection !== null
        ? typeof navigatorObject.connection.effectiveType === "string"
          ? navigatorObject.connection.effectiveType
          : null
        : null,
    color_scheme_preference: colorSchemePreference
  };
}
