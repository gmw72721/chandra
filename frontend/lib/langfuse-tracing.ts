import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";

let otelSdk: NodeSDK | null | undefined;

const sensitiveKeyParts = ["authorization", "cookie", "dataurl", "file_data", "key", "password", "private", "secret", "token"];

export function hasLangfuseTracingConfig() {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_HOST);
}

function tracingDisabled() {
  return ["0", "false", "off", "no"].includes(String(process.env.LANGFUSE_TRACING_ENABLED ?? "").trim().toLowerCase());
}

export function ensureLangfuseTracing() {
  if (!hasLangfuseTracingConfig() || tracingDisabled()) {
    return null;
  }

  if (otelSdk !== undefined) {
    return otelSdk;
  }

  otelSdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        baseUrl: process.env.LANGFUSE_HOST,
        environment: process.env.LANGFUSE_ENVIRONMENT || process.env.VERCEL_ENV || process.env.NODE_ENV,
        exportMode: "immediate",
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        mask: ({ data }) => sanitizeForLangfuse(data)
      })
    ]
  });
  otelSdk.start();
  return otelSdk;
}

export async function shutdownLangfuseTracing() {
  if (!otelSdk) {
    return;
  }

  const sdk = otelSdk;
  otelSdk = undefined;
  await sdk.shutdown();
}

export async function traceLangfuseGeneration<T>({
  input,
  metadata,
  model,
  name,
  prompt,
  run,
  sessionId,
  tags,
  userId
}: {
  input?: unknown;
  metadata?: Record<string, unknown>;
  model: string;
  name: string;
  prompt?: { name: string; version: number; isFallback: boolean };
  run: (generation: { update: (value: Record<string, unknown>) => unknown }) => Promise<T>;
  sessionId?: string;
  tags?: string[];
  userId?: string;
}) {
  if (!ensureLangfuseTracing()) {
    return run({ update: () => undefined });
  }

  return propagateAttributes(
    {
      sessionId,
      tags,
      userId
    },
    () =>
      startActiveObservation(
        name,
        async (generation) => {
          generation.update({
            input: sanitizeForLangfuse(input),
            metadata: sanitizeForLangfuse(metadata ?? {}) as Record<string, unknown>,
            model,
            ...(prompt ? { prompt } : {})
          });

          try {
            return await run(generation);
          } catch (error) {
            generation.update({
              level: "ERROR",
              metadata: sanitizeForLangfuse({
                ...(metadata ?? {}),
                errorClass: error instanceof Error ? error.name : "Error",
                errorMessage: error instanceof Error ? error.message : String(error)
              }) as Record<string, unknown>
            });
            throw error;
          }
        },
        { asType: "generation" }
      )
  );
}

export function sanitizeForLangfuse(value: unknown): unknown {
  if (value == null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 8).map((item) => sanitizeForLangfuse(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => {
        const normalized = key.replace(/[-_]/g, "").toLowerCase();
        if (sensitiveKeyParts.some((part) => normalized.includes(part))) {
          return [key, "[redacted]"];
        }
        return [key, sanitizeForLangfuse(item)];
      })
    );
  }

  return String(value);
}

export function langfuseTraceTags({ feature, route, workflow }: { feature: string; route: string; workflow?: string }) {
  return [
    `feature:${feature}`,
    `route:${route}`,
    ...(workflow ? [`workflow:${workflow}`] : []),
    ...(process.env.LANGFUSE_ENVIRONMENT || process.env.VERCEL_ENV || process.env.NODE_ENV
      ? [`environment:${process.env.LANGFUSE_ENVIRONMENT || process.env.VERCEL_ENV || process.env.NODE_ENV}`]
      : [])
  ];
}
