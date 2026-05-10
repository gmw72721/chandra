import { captureException } from "./lib/observability";

export async function register() {
  const nodeProcess = globalThis.process as typeof process | undefined;

  if (nodeProcess?.env.NEXT_RUNTIME !== "nodejs" || typeof nodeProcess.on !== "function") {
    return;
  }

  nodeProcess.on("unhandledRejection", (reason) => {
    void captureException(reason, { event: "server.unhandled_rejection" });
  });

  nodeProcess.on("uncaughtException", (error) => {
    void captureException(error, { event: "server.uncaught_exception" });
  });
}

export async function onRequestError(error: unknown, request: unknown, context: unknown) {
  const requestRecord = request as {
    headers?: Headers;
    method?: string;
    path?: string;
    url?: string;
  };
  const contextRecord = context as {
    routePath?: string;
  };

  await captureException(error, {
    event: "next.request_error",
    method: requestRecord.method,
    requestId: requestRecord.headers?.get("x-request-id") ?? undefined,
    route: contextRecord.routePath ?? requestRecord.path ?? requestRecord.url
  });
}
