type LogLevel = "debug" | "info" | "warn" | "error";

type LogValue = string | number | boolean | null | undefined | LogValue[] | { [key: string]: LogValue };
type LogFields = Record<string, LogValue>;

type CaptureExceptionContext = {
  event?: string;
  requestId?: string;
  route?: string;
  method?: string;
  userId?: string;
  provider?: string;
  providerErrorClass?: string;
  providerStatus?: number;
};

const serviceName = "chandra-frontend";
let browserMonitoringInitialized = false;
const sensitiveKeyPattern =
  /(authorization|token|secret|password|privatekey|private_key|apikey|api_key|content|messagecontent|messages|prompt|profile|learningprofile|filecontents|uploadedfile|extractedtext)/i;

export function requestIdFromRequest(request: Request): string {
  const headerValue =
    request.headers.get("x-request-id") ||
    request.headers.get("x-cloud-trace-context")?.split("/")?.[0] ||
    "";

  return safeRequestId(headerValue) || createRequestId();
}

export function createRequestId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}

export function withRequestIdHeader<T extends Response>(response: T, requestId: string): T {
  response.headers.set("X-Request-Id", requestId);
  return response;
}

export function logApiRequest(fields: {
  route: string;
  method: string;
  status: number;
  latencyMs: number;
  requestId: string;
  userId?: string;
}) {
  logEvent("api.request", "info", {
    latencyMs: Math.round(fields.latencyMs),
    method: fields.method,
    requestId: fields.requestId,
    route: fields.route,
    status: fields.status,
    userId: fields.userId
  });
}

export function logProviderFailure(fields: {
  provider: string;
  providerErrorClass: string;
  providerStatus?: number;
  requestId?: string;
  route?: string;
}) {
  logEvent("provider.failure", "error", fields);
}

export function logEvent(event: string, level: LogLevel, fields: LogFields = {}) {
  const payload = redactLogFields(compactLogFields({
    dt: new Date().toISOString(),
    environment: betterStackEnvironment(),
    event,
    level,
    message: event,
    service: serviceName,
    ...fields
  }));
  const serialized = JSON.stringify(payload);

  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }

  sendBetterStackLog(payload);
}

export async function captureException(error: unknown, context: CaptureExceptionContext = {}) {
  const errorClass = error instanceof Error ? error.name : "NonError";

  logEvent(context.event ?? "error.captured", "error", {
    errorClass,
    method: context.method,
    provider: context.provider,
    providerErrorClass: context.providerErrorClass,
    providerStatus: context.providerStatus,
    requestId: context.requestId,
    route: context.route,
    userId: context.userId
  });
}

export function initBrowserErrorMonitoring() {
  if (browserMonitoringInitialized || typeof window === "undefined") {
    return;
  }

  browserMonitoringInitialized = true;

  window.addEventListener("error", (event) => {
    void captureException(event.error ?? event.message, {
      event: "browser.error",
      route: window.location.pathname
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    void captureException(event.reason, {
      event: "browser.unhandled_rejection",
      route: window.location.pathname
    });
  });
}

export function redactLogFields(fields: LogFields): Record<string, LogValue> {
  return redactValue(fields) as Record<string, LogValue>;
}

export function betterStackLoggingStatus() {
  const sourceToken = process.env.BETTER_STACK_SOURCE_TOKEN?.trim() ?? "";
  const ingestingHost = process.env.BETTER_STACK_INGESTING_HOST?.trim() ?? "";

  return {
    environment: betterStackEnvironment(),
    ingestingHostConfigured: Boolean(ingestingHost),
    sourceTokenConfigured: Boolean(sourceToken),
    status: sourceToken && ingestingHost ? "ok" as const : "missing_config" as const
  };
}

export function pingBetterStackHeartbeat(url: string | undefined, event: string) {
  const heartbeatUrl = url?.trim();

  if (!heartbeatUrl) {
    logEvent("better_stack.heartbeat.missing_config", "warn", { eventType: event });
    return;
  }

  try {
    void fetch(heartbeatUrl, {
      cache: "no-store",
      method: "GET",
      signal: AbortSignal.timeout(1500)
    }).catch((caughtError: unknown) => {
      logEvent("better_stack.heartbeat.failed", "warn", {
        errorClass: caughtError instanceof Error ? caughtError.name : "NonError",
        eventType: event
      });
    });
  } catch (caughtError) {
    logEvent("better_stack.heartbeat.failed", "warn", {
      errorClass: caughtError instanceof Error ? caughtError.name : "NonError",
      eventType: event
    });
  }
}

function compactLogFields(fields: LogFields): LogFields {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined && value !== "")
  ) as LogFields;
}

function safeRequestId(value: string) {
  const trimmed = value.trim();

  if (!trimmed || trimmed.length > 128 || !/^[a-zA-Z0-9_.:/-]+$/.test(trimmed)) {
    return "";
  }

  return trimmed;
}

function sendBetterStackLog(payload: Record<string, LogValue>) {
  const endpoint = betterStackIngestEndpoint();
  const sourceToken = process.env.BETTER_STACK_SOURCE_TOKEN?.trim();

  if (!endpoint || !sourceToken) {
    return;
  }

  try {
    void fetch(endpoint, {
      body: JSON.stringify(payload),
      headers: {
        Authorization: `Bearer ${sourceToken}`,
        "Content-Type": "application/json"
      },
      method: "POST"
    }).catch(() => {
      // Logging must never break request handling.
    });
  } catch {
    // Logging must never break request handling.
  }
}

function betterStackIngestEndpoint() {
  const host = process.env.BETTER_STACK_INGESTING_HOST?.trim();

  if (!host) {
    return "";
  }

  try {
    return new URL(host.startsWith("http") ? host : `https://${host}`).toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

function betterStackEnvironment() {
  const value = process.env.BETTER_STACK_ENV?.trim().toLowerCase();
  return value === "production" ? "production" : "development";
}

function redactValue(value: LogValue): LogValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      sensitiveKeyPattern.test(key) ? "[REDACTED]" : redactValue(nestedValue)
    ])
  ) as Record<string, LogValue>;
}
