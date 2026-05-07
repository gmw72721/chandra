import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { GoogleAuth, type JWTInput } from "google-auth-library";

export type VertexEmbeddingTaskType =
  | "RETRIEVAL_DOCUMENT"
  | "RETRIEVAL_QUERY"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION"
  | "CODE_RETRIEVAL_QUERY";

export type VertexEmbeddingResult = {
  dimensions: number;
  model: string;
  provider: "vertex-ai";
  taskType: VertexEmbeddingTaskType;
  values: number[];
};

export type VertexEmbeddingPart = {
  data: Uint8Array | string;
  mimeType: string;
};

export type VertexEmbeddingInput = {
  file?: VertexEmbeddingPart;
  taskType: VertexEmbeddingTaskType;
  text: string;
  title?: string;
};

type VertexEmbeddingConfig = {
  dimensions?: number;
  location: string;
  model: string;
  projectId: string;
};

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const geminiApiBaseUrl = "https://generativelanguage.googleapis.com/v1beta";
const defaultGeminiEmbeddingBatchSize = 6;
const defaultGeminiEmbeddingBatchMaxBytes = 8 * 1024 * 1024;
let warnedAboutMissingVertexConfig = false;

export class VertexEmbeddingError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VertexEmbeddingError";
  }
}

export function getVertexEmbeddingConfig(): VertexEmbeddingConfig | null {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "";
  const model = process.env.VERTEX_EMBEDDING_MODEL ?? "gemini-embedding-2";
  const location = process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1";
  const dimensions = readOptionalPositiveInteger(process.env.VERTEX_EMBEDDING_DIMENSIONS) ?? 768;

  if (!projectId || !location || !model) {
    return null;
  }

  return { dimensions, location, model, projectId };
}

export function isVertexEmbeddingConfigured() {
  return Boolean(getVertexEmbeddingConfig());
}

export async function createVertexEmbedding({
  file,
  taskType,
  text,
  title
}: VertexEmbeddingInput): Promise<VertexEmbeddingResult | undefined> {
  const embeddings = await createVertexEmbeddings([{ file, taskType, text, title }]);
  return embeddings[0];
}

export async function createVertexEmbeddings(
  inputs: VertexEmbeddingInput[],
  options: {
    onProgress?: (progress: { completed: number; total: number }) => Promise<void> | void;
  } = {}
): Promise<Array<VertexEmbeddingResult | undefined>> {
  const results = new Array<VertexEmbeddingResult | undefined>(inputs.length);
  const indexedInputs = inputs
    .map((input, index) => ({
      ...input,
      content: input.text.trim(),
      index
    }))
    .filter((input) => input.content || input.file);

  if (!indexedInputs.length) {
    return results;
  }

  const config = getVertexEmbeddingConfig();

  if (!config) {
    warnAboutMissingVertexConfig();
    return results;
  }

  try {
    if (isGeminiApiEmbeddingModel(config.model)) {
      const geminiApiKey = getGeminiApiKey();
      let completed = 0;

      for (const batch of buildGeminiEmbeddingBatches({ config, inputs: indexedInputs })) {
        const payload = await fetchGeminiEmbeddingBatch({ batch, config, geminiApiKey });

        batch.forEach((input, batchIndex) => {
          const values = readEmbeddingValues({ embedding: payload.embeddings?.[batchIndex] });

          if (!values.length) {
            throw new Error("Gemini API did not return an embedding vector.");
          }

          results[input.index] = {
            dimensions: values.length,
            model: config.model,
            provider: "vertex-ai",
            taskType: input.taskType,
            values
          };
        });

        completed += batch.length;
        await options.onProgress?.({ completed, total: indexedInputs.length });
      }

      return results;
    }

    const accessToken = await getGoogleAccessToken();

    await Promise.all(
      indexedInputs.map(async (input, completedIndex) => {
        const response = await fetch(buildVertexPredictUrl(config), {
          body: JSON.stringify({
            instances: [
              {
                content: input.content.slice(0, 30000),
                ...(input.taskType ? { task_type: input.taskType } : {}),
                ...(input.title && input.taskType === "RETRIEVAL_DOCUMENT" ? { title: input.title } : {})
              }
            ],
            ...(config.dimensions ? { parameters: { outputDimensionality: config.dimensions } } : {})
          }),
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json"
          },
          method: "POST"
        });

        if (!response.ok) {
          const detail = await response.text();
          throw new Error(`Vertex AI responded with ${response.status}: ${detail.slice(0, 400)}`);
        }

        const payload = (await response.json()) as VertexEmbeddingPredictResponse;
        const values = readEmbeddingValues(payload);

        if (!values.length) {
          throw new Error("Vertex AI did not return an embedding vector.");
        }

        results[input.index] = {
          dimensions: values.length,
          model: config.model,
          provider: "vertex-ai",
          taskType: input.taskType,
          values
        };

        await options.onProgress?.({ completed: completedIndex + 1, total: indexedInputs.length });
      })
    );

    return results;
  } catch (caughtError) {
    throw new VertexEmbeddingError("Vertex AI embedding generation failed.", {
      cause: caughtError instanceof Error ? caughtError : undefined
    });
  }
}

type IndexedVertexEmbeddingInput = VertexEmbeddingInput & {
  content: string;
  index: number;
};

function buildGeminiEmbeddingBatches({
  config,
  inputs
}: {
  config: VertexEmbeddingConfig;
  inputs: IndexedVertexEmbeddingInput[];
}) {
  const maxBatchItems =
    readOptionalPositiveInteger(process.env.GEMINI_EMBEDDING_BATCH_SIZE) ?? defaultGeminiEmbeddingBatchSize;
  const maxBatchBytes =
    readOptionalPositiveInteger(process.env.GEMINI_EMBEDDING_BATCH_MAX_BYTES) ?? defaultGeminiEmbeddingBatchMaxBytes;
  const batches: IndexedVertexEmbeddingInput[][] = [];
  let currentBatch: IndexedVertexEmbeddingInput[] = [];
  let currentBytes = 0;

  for (const input of inputs) {
    const requestBytes = estimateGeminiEmbedRequestBytes({ config, input });

    if (
      currentBatch.length &&
      (currentBatch.length >= maxBatchItems || currentBytes + requestBytes > maxBatchBytes)
    ) {
      batches.push(currentBatch);
      currentBatch = [];
      currentBytes = 0;
    }

    currentBatch.push(input);
    currentBytes += requestBytes;
  }

  if (currentBatch.length) {
    batches.push(currentBatch);
  }

  return batches;
}

async function fetchGeminiEmbeddingBatch({
  batch,
  config,
  geminiApiKey
}: {
  batch: IndexedVertexEmbeddingInput[];
  config: VertexEmbeddingConfig;
  geminiApiKey: string;
}) {
  const requestBody = JSON.stringify({
    requests: batch.map((input) => buildGeminiEmbedContentRequest({ config, input }))
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(buildGeminiBatchEmbedContentUrl(config.model), {
      body: requestBody,
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiApiKey
      },
      method: "POST"
    });

    if (response.ok) {
      return (await response.json()) as VertexEmbeddingPredictResponse;
    }

    const detail = await response.text();

    if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 3) {
      const keyFingerprint = geminiApiKey ? ` key fingerprint ${fingerprintSecret(geminiApiKey)}` : "";
      throw new Error(`Gemini API responded with ${response.status}${keyFingerprint}: ${detail.slice(0, 400)}`);
    }

    await sleep(readRetryDelayMs(response.headers.get("retry-after")) ?? 1000 * 2 ** attempt);
  }

  throw new Error("Gemini API embedding batch failed.");
}

function buildGeminiEmbedContentRequest({
  config,
  input
}: {
  config: VertexEmbeddingConfig;
  input: IndexedVertexEmbeddingInput;
}) {
  return {
    model: `models/${config.model}`,
    content: {
      parts: buildGeminiEmbeddingParts({
        content: input.content.slice(0, 30000),
        file: input.file
      })
    },
    ...(config.dimensions ? { outputDimensionality: config.dimensions } : {}),
    ...(input.taskType ? { taskType: input.taskType } : {}),
    ...(input.title && input.taskType === "RETRIEVAL_DOCUMENT" ? { title: input.title } : {})
  };
}

function estimateGeminiEmbedRequestBytes({
  config,
  input
}: {
  config: VertexEmbeddingConfig;
  input: IndexedVertexEmbeddingInput;
}) {
  return Buffer.byteLength(JSON.stringify(buildGeminiEmbedContentRequest({ config, input })), "utf8");
}

function buildGeminiEmbeddingParts({
  content,
  file
}: {
  content: string;
  file?: VertexEmbeddingPart;
}) {
  const parts: Array<{ inline_data?: { data: string; mime_type: string }; text?: string }> = [];

  if (content) {
    parts.push({
      text: content
    });
  }

  if (file) {
    parts.push({
      inline_data: {
        data: filePartToBase64(file.data),
        mime_type: file.mimeType
      }
    });
  }

  return parts;
}

function filePartToBase64(data: Uint8Array | string) {
  if (typeof data !== "string") {
    return Buffer.from(data).toString("base64");
  }

  const dataUrlMatch = data.match(/^data:[^;]+;base64,(?<base64>.+)$/);

  if (dataUrlMatch?.groups?.base64) {
    return dataUrlMatch.groups.base64;
  }

  return Buffer.from(data).toString("base64");
}

function buildGeminiEmbedContentUrl(model: string) {
  const encodedModel = encodeURIComponent(model);
  return `${geminiApiBaseUrl}/models/${encodedModel}:embedContent`;
}

function buildGeminiBatchEmbedContentUrl(model: string) {
  const encodedModel = encodeURIComponent(model);
  return `${geminiApiBaseUrl}/models/${encodedModel}:batchEmbedContents`;
}

function buildVertexPredictUrl({ location, model, projectId }: VertexEmbeddingConfig) {
  const encodedModel = encodeURIComponent(model);
  return `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${encodedModel}:predict`;
}

async function getGoogleAccessToken() {
  const credentials = getGoogleCredentials();
  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    scopes: [cloudPlatformScope]
  });
  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;

  if (!token) {
    throw new Error("Google auth did not return an access token.");
  }

  return token;
}

function getGoogleCredentials(): JWTInput | undefined {
  const serviceAccountJson = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON ?? process.env.FIREBASE_SERVICE_ACCOUNT_KEY;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson) as JWTInput & {
      clientEmail?: string;
      privateKey?: string;
      projectId?: string;
    };

    return {
      client_email: serviceAccount.client_email ?? serviceAccount.clientEmail,
      private_key: (serviceAccount.private_key ?? serviceAccount.privateKey)?.replace(/\\n/g, "\n"),
      project_id: serviceAccount.project_id ?? serviceAccount.projectId
    };
  }

  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL ?? process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.GOOGLE_PRIVATE_KEY ?? process.env.FIREBASE_PRIVATE_KEY;
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID;

  if (!clientEmail || !privateKey || !projectId) {
    return undefined;
  }

  return {
    client_email: clientEmail,
    private_key: privateKey.replace(/\\n/g, "\n"),
    project_id: projectId
  };
}

function getGeminiApiKey() {
  const apiKey =
    readLocalGeminiApiKey() || process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Gemini embeddings require GEMINI_API_KEY. Create an AI Studio/Gemini API key for this project and restart the dev server.");
  }

  return apiKey;
}

function readLocalGeminiApiKey() {
  if (process.env.NODE_ENV === "production") {
    return "";
  }

  try {
    const envLocal = readFileSync(join(process.cwd(), ".env.local"), "utf8");
    return envLocal.match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function fingerprintSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

function isGeminiApiEmbeddingModel(model: string) {
  return model.startsWith("gemini-embedding-2");
}

function warnAboutMissingVertexConfig() {
  if (warnedAboutMissingVertexConfig) {
    return;
  }

  warnedAboutMissingVertexConfig = true;
  console.warn(
    "Vertex AI embeddings are not configured. Chandra will save and retrieve tutor knowledge with keyword fallback only."
  );
}

function readEmbeddingValues(payload: VertexEmbeddingPredictResponse) {
  const prediction = payload.predictions?.[0];
  const values =
    payload.embedding?.values ??
    payload.embeddings?.[0]?.values ??
    prediction?.embeddings?.values ??
    prediction?.embedding ??
    [];

  return values.map(Number).filter((value) => Number.isFinite(value));
}

function readOptionalPositiveInteger(value: string | undefined) {
  const numberValue = Number(value);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function readRetryDelayMs(retryAfter: string | null) {
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const retryDate = Date.parse(retryAfter);

  if (Number.isFinite(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }

  return undefined;
}

function sleep(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

type VertexEmbeddingPredictResponse = {
  embedding?: {
    values?: number[];
  };
  embeddings?: Array<{
    values?: number[];
  }>;
  predictions?: Array<{
    embedding?: number[];
    embeddings?: {
      values?: number[];
    };
  }>;
};
