import { NextResponse } from "next/server";
import { adminApp, adminAuth, adminDb, adminStorage } from "@/lib/firebase-admin";
import { isPostgresConfigured, queryPostgres } from "@/lib/data/postgres";
import { firebaseConfig, isFirebaseConfigured } from "@/lib/firebase-config";
import {
  betterStackLoggingStatus,
  captureException,
  logApiRequest,
  requestIdFromRequest,
  withRequestIdHeader
} from "@/lib/observability";

type DependencyStatus = {
  status: "ok" | "degraded" | "down" | "missing_config";
  detail?: string;
  statusCode?: number;
};

export async function GET(request: Request) {
  const requestId = requestIdFromRequest(request);
  const startedAt = performance.now();
  const dependencies = {
	    backend: await checkBackend(),
	    betterStackLogging: checkBetterStackLogging(),
	    embeddings: await checkEmbeddings(),
	    firebaseAdmin: await checkFirebaseAdmin(),
	    firebaseStorage: await checkFirebaseStorage(),
	    frontendRuntimeConfig: checkFrontendRuntimeConfig(),
	    firebaseWebConfig: checkFirebaseWebConfig(),
	    openrouter: await checkOpenRouter(),
	    pdfOcrSearchTables: await checkPdfOcrSearchTables(),
	    postgres: await checkPostgres()
	  };
  const status = overallStatus(Object.values(dependencies));
  const responseStatus = status === "ok" ? 200 : 503;
  const response = NextResponse.json(
    {
      dependencies,
      requestId,
      service: "chandra-frontend",
      status
    },
    { status: responseStatus }
  );

  logApiRequest({
    latencyMs: performance.now() - startedAt,
    method: "GET",
    requestId,
    route: "/api/health",
    status: responseStatus
  });

  return withRequestIdHeader(response, requestId);
}

async function checkBackend(): Promise<DependencyStatus> {
  const baseUrl = process.env.BACKEND_API_BASE_URL?.trim();

  if (!baseUrl) {
    return {
      detail: process.env.NODE_ENV === "production" ? "BACKEND_API_BASE_URL is required." : "Using local backend fallback.",
      status: process.env.NODE_ENV === "production" ? "missing_config" : "degraded"
    };
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(1500)
    });

    return {
      detail: response.ok ? undefined : "Backend health check returned a non-2xx response.",
      status: response.ok ? "ok" : "down",
      statusCode: response.status
    };
  } catch (caughtError) {
    await captureException(caughtError, {
      event: "health.backend_failed",
      provider: "fastapi-backend",
      route: "/api/health"
    });

    return {
      detail: "Backend health check failed or timed out.",
      status: "down"
    };
  }
}

async function checkFirebaseAdmin(): Promise<DependencyStatus> {
  if (!adminApp || !adminAuth || !adminDb) {
    return {
      detail: "Firebase Admin is not initialized.",
      status: "missing_config"
    };
  }

  try {
    await adminAuth.listUsers(1);
    return { status: "ok" };
  } catch {
    return {
      detail: "Firebase Auth/Admin connectivity check failed.",
      status: "down"
    };
  }
}

async function checkFirebaseStorage(): Promise<DependencyStatus> {
  if (!adminStorage) {
    return {
      detail: "Firebase Storage is not initialized.",
      status: "missing_config"
    };
  }

  try {
    const [metadata] = await adminStorage.bucket().getMetadata();
    return {
      detail: String(metadata.name ?? ""),
      status: "ok"
    };
  } catch {
    return {
      detail: "Firebase Storage connectivity check failed.",
      status: "down"
    };
  }
}

async function checkPostgres(): Promise<DependencyStatus> {
  if (!isPostgresConfigured()) {
    return {
      detail: "DATABASE_URL, CLOUD_SQL_POSTGRES_URL, or CHANDRA_CLOUD_SQL_POSTGRES_URL is not configured.",
      status: "missing_config"
    };
  }

  try {
    await queryPostgres("SELECT 1");
    return { status: "ok" };
  } catch {
    return {
      detail: "Postgres connectivity check failed.",
      status: "down"
    };
  }
}

async function checkPdfOcrSearchTables(): Promise<DependencyStatus> {
  if (!isPostgresConfigured()) {
    return {
      detail: "Postgres is not configured for PDF OCR/search metadata.",
      status: "missing_config"
    };
  }

  try {
    const result = await queryPostgres<{ pdf_materials: string | null; pdf_pages: string | null }>(
      "SELECT to_regclass('pdf_materials')::text AS pdf_materials, to_regclass('pdf_pages')::text AS pdf_pages"
    );
    const row = result.rows[0];

    if (!row?.pdf_materials || !row?.pdf_pages) {
      return {
        detail: "PDF OCR/search tables are missing.",
        status: "down"
      };
    }

    return { status: "ok" };
  } catch {
    return {
      detail: "PDF OCR/search table connectivity check failed.",
      status: "down"
    };
  }
}

function checkFirebaseWebConfig(): DependencyStatus {
  if (!isFirebaseConfigured) {
    return {
      detail: "NEXT_PUBLIC_FIREBASE_* web config is incomplete.",
      status: "missing_config"
    };
  }

  return {
    detail: firebaseConfig.projectId,
    status: "ok"
  };
}

function checkFrontendRuntimeConfig(): DependencyStatus {
  const missing = [
    process.env.BACKEND_API_BASE_URL?.trim() ? "" : "BACKEND_API_BASE_URL",
    process.env.BACKEND_SHARED_SECRET?.trim() ? "" : "BACKEND_SHARED_SECRET"
  ].filter(Boolean);

  if (missing.length) {
    return {
      detail: `${missing.join(", ")} not configured.`,
      status: process.env.NODE_ENV === "production" ? "missing_config" : "degraded"
    };
  }

  return { status: "ok" };
}

function checkBetterStackLogging(): DependencyStatus {
  const status = betterStackLoggingStatus();

  if (status.status !== "ok") {
    return {
      detail: "BETTER_STACK_SOURCE_TOKEN or BETTER_STACK_INGESTING_HOST is not configured.",
      status: process.env.NODE_ENV === "production" ? "missing_config" : "degraded"
    };
  }

  return {
    detail: status.environment,
    status: "ok"
  };
}

async function checkOpenRouter(): Promise<DependencyStatus> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  const baseUrl = (process.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");

  if (!apiKey) {
    return {
      detail: "OPENROUTER_API_KEY is not configured.",
      status: "missing_config"
    };
  }

  try {
    const response = await fetch(`${baseUrl}/models`, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.OPENROUTER_HTTP_REFERER || process.env.FRONTEND_ORIGIN || "http://localhost:3000",
        "X-Title": process.env.OPENROUTER_APP_TITLE || "Chandra"
      },
      signal: AbortSignal.timeout(1500)
    });

    return {
      detail: response.ok ? undefined : "OpenRouter connectivity check returned a non-2xx response.",
      status: response.ok ? "ok" : "down",
      statusCode: response.status
    };
  } catch {
    return {
      detail: "OpenRouter connectivity check failed or timed out.",
      status: "down"
    };
  }
}

async function checkEmbeddings(): Promise<DependencyStatus> {
  const apiKey = (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "").trim();
  const model = process.env.VERTEX_EMBEDDING_MODEL || "gemini-embedding-2";
  const dimensions = Number(process.env.VERTEX_EMBEDDING_DIMENSIONS || "1536");

  if (!apiKey) {
    return {
      detail: "GEMINI_API_KEY is not configured.",
      status: "missing_config"
    };
  }

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent`, {
      body: JSON.stringify({
        content: { parts: [{ text: "health check" }] },
        outputDimensionality: Number.isFinite(dimensions) ? dimensions : 1536,
        taskType: "RETRIEVAL_QUERY"
      }),
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      method: "POST",
      signal: AbortSignal.timeout(1500)
    });

    return {
      detail: response.ok ? undefined : "Embedding connectivity check returned a non-2xx response.",
      status: response.ok ? "ok" : "down",
      statusCode: response.status
    };
  } catch {
    return {
      detail: "Embedding connectivity check failed or timed out.",
      status: "down"
    };
  }
}

function overallStatus(dependencies: DependencyStatus[]) {
  if (dependencies.some((dependency) => dependency.status === "down" || dependency.status === "missing_config")) {
    return "down";
  }

  if (dependencies.some((dependency) => dependency.status === "degraded")) {
    return "degraded";
  }

  return "ok";
}
