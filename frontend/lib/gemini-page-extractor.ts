import { GoogleAuth, type JWTInput } from "google-auth-library";
import { geminiPageExtractionModel } from "./pdf-ingestion-config.ts";
import {
  getGcsPdfAssetsBucket,
  getGcsPdfAssetsBucketName,
  saveGcsPdfAsset
} from "./gcs-pdf-page-assets.ts";

const cloudPlatformScope = "https://www.googleapis.com/auth/cloud-platform";
const defaultGeminiPageExtractionTimeoutMs = 120000;
const defaultGeminiPageBatchPollIntervalMs = 5000;
const defaultGeminiPageBatchTimeoutMs = 24 * 60 * 60 * 1000;
const defaultGeminiPageBatchMaxBytes = 18 * 1024 * 1024;
const defaultVertexGeminiLocation = "global";
const cachedGoogleAccessTokenTtlMs = 50 * 60 * 1000;
let cachedGoogleAccessToken: { expiresAt: number; token: string } | null = null;
let pendingGoogleAccessToken: Promise<string> | null = null;

export type GeminiStructuredPageExtractionResult = {
  model: string;
  rawText: string;
};

export type GeminiStructuredPageBatchInput = {
  mimeType: string;
  pageBuffer?: Buffer;
  pageAssetUri?: string;
  pageNumber: number;
};

export type GeminiStructuredPageBatchProgress = {
  batchIndex: number;
  batchName: string;
  elapsedMs: number;
  failedPageCount: number;
  incompletePageCount: number | null;
  outputPageCount: number;
  pageCount: number;
  processedPageCount: number;
  state: string;
  successfulPageCount: number;
  totalBatches: number;
};

export type GeminiStructuredPageBatchPageResult = {
  pageNumber: number;
  result: GeminiStructuredPageExtractionResult;
};

export async function extractStructuredPageWithGemini({
  mimeType,
  pageAssetUri,
  pageBuffer,
  pageNumber,
  title
}: {
  mimeType: string;
  pageAssetUri?: string;
  pageBuffer?: Buffer;
  pageNumber: number;
  title: string;
}): Promise<GeminiStructuredPageExtractionResult> {
  const model = geminiPageExtractionModel();
  const accessToken = await getGoogleAccessToken();
  const config = getVertexPageExtractionConfig(model);
  const response = await fetchGeminiGenerateContent({
    accessToken,
    body: JSON.stringify(buildStructuredPageGenerateContentRequest({ mimeType, pageAssetUri, pageBuffer, pageNumber, title })),
    config
  });

  const payload = await response.json() as GeminiGenerateContentResponse;
  const rawText = readGenerateContentText(payload);

  if (!rawText) {
    throw new Error(`Gemini page extraction returned no JSON for page ${pageNumber}.`);
  }

  return { model, rawText };
}

export async function extractStructuredPagesWithGeminiBatch({
  onPageResult,
  onProgress,
  pages,
  title
}: {
  onPageResult?: (pageResult: GeminiStructuredPageBatchPageResult) => Promise<void> | void;
  onProgress?: (progress: GeminiStructuredPageBatchProgress) => Promise<void> | void;
  pages: GeminiStructuredPageBatchInput[];
  title: string;
}): Promise<{
  model: string;
  results: Map<number, GeminiStructuredPageExtractionResult>;
  warnings: string[];
}> {
  const model = geminiPageExtractionModel();
  const accessToken = await getGoogleAccessToken();
  const config = getVertexPageExtractionConfig(model);
  const results = new Map<number, GeminiStructuredPageExtractionResult>();
  const warnings: string[] = [];
  const batchRequestGroups = buildGeminiPageBatchRequestGroups({ model, pages, title });

  for (const [batchIndex, batchRequests] of batchRequestGroups.entries()) {
    const batch = await createVertexPageBatch({
      accessToken,
      config,
      requests: batchRequests,
      title
    });
    const collector: VertexBatchOutputCollector = {
      failedPages: new Set(),
      results,
      warnings
    };
    await waitForVertexPageBatch({
      accessToken,
      batchIndex: batchIndex + 1,
      batchName: batch.name,
      collector,
      config,
      model,
      onPageResult,
      onProgress,
      outputBucket: batch.outputBucket,
      outputPrefix: batch.outputPrefix,
      pageCount: batchRequests.length,
      requests: batchRequests,
      totalBatches: batchRequestGroups.length
    });
    await collectVertexBatchPredictionOutputs({
      bucketName: batch.outputBucket,
      collector,
      model,
      onPageResult,
      prefix: batch.outputPrefix,
      requests: batchRequests
    });

    for (const request of batchRequests) {
      if (!results.has(request.pageNumber) && !collector.failedPages.has(request.pageNumber)) {
        collector.failedPages.add(request.pageNumber);
        warnings.push(`page ${request.pageNumber}: missing Vertex batch response`);
      }
    }
  }

  return { model, results, warnings };
}

async function fetchGeminiGenerateContent({
  accessToken,
  body,
  config
}: {
  accessToken: string;
  body: string;
  config: VertexPageExtractionConfig;
}) {
  const url = buildVertexGenerateContentUrl(config);
  const timeoutMs = readPositiveInteger(process.env.GEMINI_PAGE_EXTRACTION_TIMEOUT_MS)
    ?? defaultGeminiPageExtractionTimeoutMs;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        body,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json"
        },
        method: "POST",
        signal: controller.signal
      });

      if (response.ok) {
        return response;
      }

      const detail = await response.text();

      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) {
        throw new Error(
          `Vertex Gemini page extraction failed with ${response.status} using ${config.model}: ${detail.slice(0, 500)}`
        );
      }

      await sleep(1000 * 2 ** attempt);
    } catch (caughtError) {
      if (caughtError instanceof Error && caughtError.name === "AbortError") {
        if (attempt === 2) {
          throw new Error(`Gemini page extraction timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
        }
      } else if (attempt === 2) {
        throw caughtError;
      }

      await sleep(1000 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error("Gemini page extraction failed.");
}

type GeminiPageBatchRequest = {
  bodyBytes: number;
  pageNumber: number;
  request: GeminiGenerateContentRequest;
};

function buildGeminiPageBatchRequestGroups({
  model,
  pages,
  title
}: {
  model: string;
  pages: GeminiStructuredPageBatchInput[];
  title: string;
}) {
  const maxBatchBytes = readPositiveInteger(process.env.GEMINI_PAGE_BATCH_MAX_BYTES)
    ?? defaultGeminiPageBatchMaxBytes;
  const groups: GeminiPageBatchRequest[][] = [];
  let currentGroup: GeminiPageBatchRequest[] = [];
  let currentBytes = 0;

  for (const page of pages) {
    const request = buildStructuredPageGenerateContentRequest({
      mimeType: page.mimeType,
      pageAssetUri: page.pageAssetUri,
      pageBuffer: page.pageBuffer,
      pageNumber: page.pageNumber,
      title
    });
    const batchRequest: GeminiPageBatchRequest = {
      bodyBytes: Buffer.byteLength(JSON.stringify(request), "utf8"),
      pageNumber: page.pageNumber,
      request
    };

    if (currentGroup.length && currentBytes + batchRequest.bodyBytes > maxBatchBytes) {
      groups.push(currentGroup);
      currentGroup = [];
      currentBytes = 0;
    }

    currentGroup.push(batchRequest);
    currentBytes += batchRequest.bodyBytes;
  }

  if (currentGroup.length) {
    groups.push(currentGroup);
  }

  if (!groups.length && pages.length) {
    throw new Error(`Gemini batch extraction could not build requests for ${model}.`);
  }

  return groups;
}

type VertexPageBatch = {
  name: string;
  outputBucket: string;
  outputPrefix: string;
};

async function createVertexPageBatch({
  accessToken,
  config,
  requests,
  title
}: {
  accessToken: string;
  config: VertexPageExtractionConfig;
  requests: GeminiPageBatchRequest[];
  title: string;
}): Promise<VertexPageBatch> {
  const bucketName = getGcsPdfAssetsBucketName();
  const safeTitle = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48) || "material";
  const jobId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const inputPath = `vertex-batch/structured-page-extraction/${safeTitle}/${jobId}/input.jsonl`;
  const outputPrefix = `vertex-batch/structured-page-extraction/${safeTitle}/${jobId}/output`;
  const inputJsonl = requests.map((request) => JSON.stringify({
    key: String(request.pageNumber),
    request: request.request
  })).join("\n");
  const inputAsset = await saveGcsPdfAsset({
    bucketName,
    buffer: Buffer.from(`${inputJsonl}\n`, "utf8"),
    contentType: "application/jsonl",
    path: inputPath
  });
  const url = buildVertexBatchPredictionJobsUrl(config);
  const response = await fetch(url, {
    body: JSON.stringify({
      displayName: `structured-page-extraction-${jobId}`,
      inputConfig: {
        instancesFormat: "jsonl",
        gcsSource: {
          uris: [inputAsset.uri]
        }
      },
      model: `publishers/google/models/${config.model}`,
      outputConfig: {
        gcsDestination: {
          outputUriPrefix: `gs://${bucketName}/${outputPrefix}`
        },
        predictionsFormat: "jsonl"
      }
    }),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json"
    },
    method: "POST"
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Vertex batch extraction failed to create job with ${response.status} using ${config.model}: ${detail.slice(0, 500)}`
    );
  }

  const payload = await response.json() as VertexBatchPredictionJobResponse;
  const name = typeof payload.name === "string" ? payload.name : "";

  if (!name) {
    throw new Error("Vertex batch extraction did not return a batch job name.");
  }

  return { name, outputBucket: bucketName, outputPrefix };
}

async function waitForVertexPageBatch({
  accessToken,
  batchIndex,
  batchName,
  collector,
  config,
  model,
  onPageResult,
  onProgress,
  outputBucket,
  outputPrefix,
  pageCount,
  requests,
  totalBatches
}: {
  accessToken: string;
  batchIndex: number;
  batchName: string;
  collector: VertexBatchOutputCollector;
  config: VertexPageExtractionConfig;
  model: string;
  onPageResult?: (pageResult: GeminiStructuredPageBatchPageResult) => Promise<void> | void;
  onProgress?: (progress: GeminiStructuredPageBatchProgress) => Promise<void> | void;
  outputBucket: string;
  outputPrefix: string;
  pageCount: number;
  requests: GeminiPageBatchRequest[];
  totalBatches: number;
}) {
  const startedAt = Date.now();
  const timeoutMs = readPositiveInteger(process.env.GEMINI_PAGE_BATCH_TIMEOUT_MS)
    ?? defaultGeminiPageBatchTimeoutMs;
  const pollIntervalMs = readPositiveInteger(process.env.GEMINI_PAGE_BATCH_POLL_INTERVAL_MS)
    ?? defaultGeminiPageBatchPollIntervalMs;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(buildVertexBatchJobUrl(config, batchName), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      method: "GET"
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Vertex batch extraction status failed with ${response.status}: ${detail.slice(0, 500)}`);
    }

    const payload = await response.json() as VertexBatchPredictionJobResponse;
    const state = readVertexBatchState(payload);
    const elapsedMs = Date.now() - startedAt;
    const outputStats = await collectVertexBatchPredictionOutputs({
      bucketName: outputBucket,
      collector,
      model,
      onPageResult,
      prefix: outputPrefix,
      requests
    });
    const completionStats = readVertexBatchCompletionStats(payload);
    const successfulPageCount = completionStats.successfulCount ?? outputStats.successfulOutputPageCount;
    const failedPageCount = completionStats.failedCount ?? outputStats.failedOutputPageCount;
    const processedPageCount = Math.max(
      outputStats.outputPageCount,
      successfulPageCount + failedPageCount
    );

    await onProgress?.({
      batchIndex,
      batchName,
      elapsedMs,
      failedPageCount,
      incompletePageCount: completionStats.incompleteCount,
      outputPageCount: outputStats.outputPageCount,
      pageCount,
      processedPageCount,
      state: state || (payload.done ? "done" : "pending"),
      successfulPageCount,
      totalBatches
    });

    if (payload.done || state === "JOB_STATE_SUCCEEDED") {
      if (state && state !== "JOB_STATE_SUCCEEDED") {
        throw new Error(`Vertex batch extraction finished with state ${state}.`);
      }

      return payload;
    }

    if (["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED", "JOB_STATE_CANCELLING"].includes(state)) {
      throw new Error(`Vertex batch extraction finished with state ${state}.`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Vertex batch extraction timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

function buildStructuredPageGenerateContentRequest({
  mimeType,
  pageAssetUri,
  pageBuffer,
  pageNumber,
  title
}: {
  mimeType: string;
  pageAssetUri?: string;
  pageBuffer?: Buffer;
  pageNumber: number;
  title: string;
}): GeminiGenerateContentRequest {
  const pageMimeType = mimeType || "application/pdf";
  const pagePart = pageAssetUri
    ? {
        fileData: {
          fileUri: pageAssetUri,
          mimeType: pageMimeType
        }
      }
    : pageBuffer
      ? {
          inlineData: {
            data: pageBuffer.toString("base64"),
            mimeType: pageMimeType
          }
        }
      : null;

  if (!pagePart) {
    throw new Error(`Gemini page extraction requires a page asset URI or page buffer for page ${pageNumber}.`);
  }

  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: buildStructuredPageExtractionPrompt({ pageNumber, title })
          },
          pagePart
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: buildStructuredPageThinkingConfig(geminiPageExtractionModel()),
      temperature: 0
    }
  };
}

function buildStructuredPageThinkingConfig(model: string): GeminiGenerateContentRequest["generationConfig"]["thinkingConfig"] {
  if (isGemini3Model(model)) {
    return {
      thinkingLevel: "MINIMAL"
    };
  }

  return {
    thinkingBudget: 0
  };
}

function buildStructuredPageExtractionPrompt({
  pageNumber,
  title
}: {
  pageNumber: number;
  title: string;
}) {
  return `
You are a textbook page extraction engine.

Your job is to convert the provided textbook page image/PDF page into a universal structured representation for search, retrieval, tutoring, and citation.

Document title hint: ${title}
Physical page number hint: ${pageNumber}

Do not assume the page is an exercise page.
Do not assume the page type.
Do not summarize instead of extracting.
Do not discard small text, labels, captions, marginal notes, footnotes, page numbers, headers, answer keys, or partially visible content.

Identify every meaningful block in reading order, including headings, subheadings, paragraphs, definitions, theorems, lemmas, corollaries, proofs, examples, exercises, equations, inline math, figures, diagrams, tables, captions, footnotes, margin notes, answer keys, page headers, page footers, page numbers, and unknown blocks.

If unsure, classify the block as "unknown_block".

Return only valid JSON matching this schema:
{
  "schema_version": "universal_textbook_page_v1",
  "page": {
    "page_number": null,
    "detected_page_label": null,
    "document_title": null,
    "chapter": null,
    "section": null,
    "section_title": null,
    "page_type": "unknown",
    "language": "en",
    "overall_confidence": 0.0
  },
  "blocks": [
    {
      "block_id": "block_001",
      "type": "paragraph",
      "reading_order": 1,
      "exact_text": "",
      "corrected_text": "",
      "math": {
        "latex": [],
        "normalized_ascii": []
      },
      "item_metadata": {
        "item_kind": null,
        "item_number": null,
        "item_label": null,
        "canonical_item_id": null
      },
      "searchable_keywords": [],
      "semantic_summary": "",
      "relationships": [
        {
          "relation_type": "continues_from | continues_to | caption_for | figure_for | table_for | proof_of | example_of | exercise_under | equation_in | references | nearby",
          "target_block_id": "",
          "confidence": 0.0
        }
      ],
      "confidence": 0.0
    }
  ],
  "page_level_search_text": "",
  "page_level_summary": "",
  "detected_learning_objects": [
    {
      "object_id": "object_001",
      "object_type": "definition | theorem | example | exercise | proof | figure | table | concept | unknown",
      "title": null,
      "label": null,
      "related_block_ids": [],
      "searchable_keywords": [],
      "semantic_summary": "",
      "confidence": 0.0
    }
  ],
  "extraction_warnings": []
}

Extraction rules:
1. Use natural human reading order. Preserve multi-column order correctly. Place sidebars, margin notes, captions, and footnotes near the block they belong to. Do not merge unrelated blocks. Do not split a coherent paragraph unless there is a clear visual or semantic break.
2. exact_text must preserve visible text as closely as possible. corrected_text may fix OCR errors, spacing, hyphenation, broken line wraps, and obvious formatting issues. Do not invent text that is not visible. If text is partially cut off, include the visible part and add a warning. Preserve numbering, labels, section numbers, example numbers, theorem numbers, exercise numbers, and equation numbers.
3. Extract all equations and meaningful inline math. Include LaTeX in math.latex and a plain ASCII normalized version in math.normalized_ascii. Preserve equation numbers if visible. If unsure about a symbol, include the best guess and add a warning. Do not simplify or solve equations unless the page itself does so.
4. Use the most specific block type available: heading, subheading, paragraph, definition, theorem, lemma, corollary, proof, example, exercise, equation, figure, diagram, table, caption, footnote, margin_note, answer_key, page_header, page_footer, page_number, unknown_block. Split mixed blocks when useful for search.
5. For exercises, examples, theorems, definitions, equations, and numbered items, fill item_metadata when possible. Examples: "Example 3.2" becomes item_kind "example", item_number "3.2", item_label "Example 3.2", canonical_item_id "example_3.2". "7." under Section 4.1 becomes item_kind "exercise", item_number "7", item_label "7", canonical_item_id "section_4.1_exercise_7". If the section is unknown, create the best canonical_item_id possible.
6. For figures and diagrams, describe what is visually shown. Include visible labels, axes, legends, points, curves, annotations, and captions. Captions should be separate caption blocks linked with relationships. Include math or labels in exact_text/corrected_text when visible.
7. For tables, preserve structure clearly in corrected_text, preferably markdown-style plain text. Include column headers, row labels, and cell values. Captions should be separate caption blocks linked with relationships.
8. Add relationships only when useful: caption_for, figure_for, table_for, proof_of, example_of, exercise_under, equation_in, references, continues_from, continues_to, nearby. Do not force relationships.
9. searchable_keywords should include exact textbook terms, concept names, labels, math topics, equation names, likely student query terms, and alternate phrasing students may use. semantic_summary should be concise and useful for retrieval, not generic.
10. page_level_search_text must concatenate important corrected text, math ASCII, labels, headings, keywords, and useful figure/table descriptions so the page can be found by problem number, example number, theorem name, concept, equation, figure/table content, or student paraphrase.
11. detected_learning_objects should group related blocks into higher-level textbook objects such as a theorem plus proof, an example plus equations, an exercise set, a figure plus caption, or a definition plus explanation. Include related_block_ids.
12. Every block must have a confidence score from 0 to 1. overall_confidence should reflect full-page quality. Add extraction_warnings for blurry, cut-off, ambiguous, dense, or math-heavy content.
13. Return JSON only. Do not include markdown, commentary, or explanations outside the JSON. Do not omit schema fields. Use null when unknown and empty arrays when there are no values.

Do not include bounding boxes anywhere in the schema or output.
`.trim();
}

type VertexPageExtractionConfig = {
  location: string;
  model: string;
  projectId: string;
};

function getVertexPageExtractionConfig(model = geminiPageExtractionModel()): VertexPageExtractionConfig {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.FIREBASE_PROJECT_ID ?? "";
  const requestedLocation = process.env.GEMINI_PAGE_EXTRACTION_LOCATION?.trim()
    || process.env.GOOGLE_CLOUD_LOCATION?.trim()
    || defaultVertexGeminiLocation;
  const location = normalizeVertexPageExtractionLocation({ location: requestedLocation, model });

  if (!projectId || !location || !model) {
    throw new Error("Vertex Gemini page extraction requires GOOGLE_CLOUD_PROJECT or FIREBASE_PROJECT_ID, a Vertex location, and a model.");
  }

  return { location, model, projectId };
}

function buildVertexGenerateContentUrl({ location, model, projectId }: VertexPageExtractionConfig) {
  return `https://${buildVertexApiHost(location)}/v1/projects/${projectId}/locations/${location}/publishers/google/models/${encodeURIComponent(model)}:generateContent`;
}

function buildVertexBatchPredictionJobsUrl({ location, projectId }: VertexPageExtractionConfig) {
  return `https://${buildVertexApiHost(location)}/v1/projects/${projectId}/locations/${location}/batchPredictionJobs`;
}

function buildVertexBatchJobUrl({ location }: VertexPageExtractionConfig, batchName: string) {
  return `https://${buildVertexApiHost(location)}/v1/${batchName}`;
}

function buildVertexApiHost(location: string) {
  if (location === "global") {
    return "aiplatform.googleapis.com";
  }

  if (location === "us") {
    return "aiplatform.us.rep.googleapis.com";
  }

  if (location === "eu") {
    return "aiplatform.eu.rep.googleapis.com";
  }

  return `${location}-aiplatform.googleapis.com`;
}

function normalizeVertexPageExtractionLocation({
  location,
  model
}: {
  location: string;
  model: string;
}) {
  if (isGemini3Model(model)) {
    return "global";
  }

  return location;
}

function isGemini3Model(model: string) {
  return /^gemini-3(?:[.-]|$)/.test(model);
}

async function getGoogleAccessToken() {
  if (cachedGoogleAccessToken && cachedGoogleAccessToken.expiresAt > Date.now()) {
    return cachedGoogleAccessToken.token;
  }

  if (pendingGoogleAccessToken) {
    return pendingGoogleAccessToken;
  }

  pendingGoogleAccessToken = readFreshGoogleAccessToken()
    .then((token) => {
      cachedGoogleAccessToken = {
        expiresAt: Date.now() + cachedGoogleAccessTokenTtlMs,
        token
      };
      return token;
    })
    .finally(() => {
      pendingGoogleAccessToken = null;
    });

  return pendingGoogleAccessToken;
}

async function readFreshGoogleAccessToken() {
  const credentials = getGoogleCredentials();
  const auth = new GoogleAuth({
    ...(credentials ? { credentials } : {}),
    scopes: [cloudPlatformScope]
  });
  const client = await auth.getClient();
  const accessTokenResponse = await client.getAccessToken();
  const token = typeof accessTokenResponse === "string" ? accessTokenResponse : accessTokenResponse?.token;

  if (!token) {
    throw new Error("Google auth did not return an access token for Vertex Gemini page extraction.");
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

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readGenerateContentText(payload: GeminiGenerateContentResponse) {
  return payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text ?? "")
    .join("")
    .trim() ?? "";
}

function readVertexBatchState(payload: VertexBatchPredictionJobResponse) {
  return String(payload.state ?? "");
}

function readVertexBatchCompletionStats(payload: VertexBatchPredictionJobResponse) {
  return {
    failedCount: readNonNegativeInteger(payload.completionStats?.failedCount),
    incompleteCount: readNonNegativeInteger(payload.completionStats?.incompleteCount),
    successfulCount: readNonNegativeInteger(payload.completionStats?.successfulCount)
  };
}

function readNonNegativeInteger(value: string | number | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

async function readVertexBatchPredictionResponses({
  bucketName,
  prefix
}: {
  bucketName: string;
  prefix: string;
}) {
  const bucket = getGcsPdfAssetsBucket(bucketName);
  const [files] = await bucket.getFiles({ prefix });
  const predictionFiles = files
    .filter((file) => /prediction|predictions|jsonl/i.test(file.name))
    .sort((first, second) => first.name.localeCompare(second.name));
  const rows: VertexBatchPredictionResponseRow[] = [];

  for (const file of predictionFiles) {
    const [buffer] = await file.download();
    const lines = buffer.toString("utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
      try {
        rows.push(JSON.parse(line) as VertexBatchPredictionResponseRow);
      } catch {
        rows.push({ error: { message: `Invalid Vertex batch JSONL output line from ${file.name}.` } });
      }
    }
  }

  return rows;
}

type VertexBatchOutputCollector = {
  failedPages: Set<number>;
  results: Map<number, GeminiStructuredPageExtractionResult>;
  warnings: string[];
};

async function collectVertexBatchPredictionOutputs({
  bucketName,
  collector,
  model,
  onPageResult,
  prefix,
  requests
}: {
  bucketName: string;
  collector: VertexBatchOutputCollector;
  model: string;
  onPageResult?: (pageResult: GeminiStructuredPageBatchPageResult) => Promise<void> | void;
  prefix: string;
  requests: GeminiPageBatchRequest[];
}) {
  const batchResponses = await readVertexBatchPredictionResponses({ bucketName, prefix });

  for (const [index, request] of requests.entries()) {
    const pageNumber = request.pageNumber;

    if (collector.results.has(pageNumber) || collector.failedPages.has(pageNumber)) {
      continue;
    }

    const responseItem = findVertexBatchResponseForPage(batchResponses, pageNumber, index);

    if (!responseItem) {
      continue;
    }

    const itemError = readVertexBatchPredictionError(responseItem);

    if (itemError) {
      collector.failedPages.add(pageNumber);
      collector.warnings.push(`page ${pageNumber}: Vertex batch extraction item failed: ${itemError}`);
      continue;
    }

    const response = readVertexBatchGenerateContentResponse(responseItem);
    const rawText = response ? readGenerateContentText(response) : "";

    if (!rawText) {
      collector.failedPages.add(pageNumber);
      collector.warnings.push(`page ${pageNumber}: Vertex batch extraction returned no JSON.`);
      continue;
    }

    const result = { model, rawText };
    collector.results.set(pageNumber, result);
    await onPageResult?.({ pageNumber, result });
  }

  return {
    failedOutputPageCount: collector.failedPages.size,
    outputPageCount: collector.results.size + collector.failedPages.size,
    successfulOutputPageCount: collector.results.size
  };
}

function findVertexBatchResponseForPage(
  rows: VertexBatchPredictionResponseRow[],
  pageNumber: number,
  fallbackIndex: number
) {
  return rows.find((row) => readVertexBatchResponsePageNumber(row) === pageNumber) ?? rows[fallbackIndex];
}

function readVertexBatchResponsePageNumber(row: VertexBatchPredictionResponseRow) {
  const key = row.key ?? row.instance?.key ?? row.request?.key;
  const keyNumber = Number(key);

  if (Number.isInteger(keyNumber) && keyNumber > 0) {
    return keyNumber;
  }

  const promptText = row.request?.contents?.[0]?.parts
    ?.map((part) => part.text ?? "")
    .join("\n") ?? "";
  const promptPageNumber = Number(promptText.match(/Physical page number hint:\s*(\d+)/)?.[1]);

  return Number.isInteger(promptPageNumber) && promptPageNumber > 0 ? promptPageNumber : null;
}

function readVertexBatchPredictionError(row: VertexBatchPredictionResponseRow) {
  const error = row.error ?? row.status ?? row.prediction_error;

  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error.message ?? JSON.stringify(error));
}

function readVertexBatchGenerateContentResponse(row: VertexBatchPredictionResponseRow) {
  return row.response ?? row.prediction ?? row.predictions ?? null;
}

function readGeminiBatchState(payload: GeminiBatchJobResponse) {
  return String(payload.metadata?.state ?? payload.state ?? "");
}

function readGeminiBatchInlinedResponses(payload: GeminiBatchJobResponse) {
  return payload.response?.inlinedResponses
    ?? payload.response?.inlined_responses
    ?? payload.dest?.inlinedResponses
    ?? payload.dest?.inlined_responses
    ?? [];
}

function readGeminiBatchInlineError(item: GeminiBatchInlineResponse | undefined) {
  const error = item?.error ?? item?.status;

  if (!error) {
    return "";
  }

  if (typeof error === "string") {
    return error;
  }

  return String(error.message ?? JSON.stringify(error));
}

function readGeminiBatchInlineGenerateContentResponse(item: GeminiBatchInlineResponse | undefined) {
  return item?.response ?? item?.inlineResponse ?? item?.inline_response ?? null;
}

function sleep(durationMs: number) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

type GeminiGenerateContentResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
};

type GeminiGenerateContentRequest = {
  contents: Array<{
    parts: Array<{
      fileData?: {
        fileUri: string;
        mimeType: string;
      };
      inlineData?: {
        data: string;
        mimeType: string;
      };
      text?: string;
    }>;
    role: string;
  }>;
  generationConfig: {
    responseMimeType: string;
    temperature: number;
    thinkingConfig: {
      thinkingBudget?: number;
      thinkingLevel?: "MINIMAL";
    };
  };
};

type VertexBatchPredictionJobResponse = {
  completionStats?: {
    failedCount?: string | number;
    incompleteCount?: string | number;
    successfulCount?: string | number;
  };
  done?: boolean;
  name?: string;
  state?: string;
};

type VertexBatchPredictionResponseRow = {
  error?: {
    message?: string;
  } | string;
  instance?: {
    key?: string;
  };
  key?: string;
  prediction?: GeminiGenerateContentResponse;
  prediction_error?: {
    message?: string;
  } | string;
  predictions?: GeminiGenerateContentResponse;
  request?: GeminiGenerateContentRequest & {
    key?: string;
  };
  response?: GeminiGenerateContentResponse;
  status?: {
    message?: string;
  } | string;
};

type GeminiBatchInlineResponse = {
  error?: {
    message?: string;
  } | string;
  inline_response?: GeminiGenerateContentResponse;
  inlineResponse?: GeminiGenerateContentResponse;
  response?: GeminiGenerateContentResponse;
  status?: {
    message?: string;
  } | string;
};

type GeminiBatchJobResponse = {
  dest?: {
    inlined_responses?: GeminiBatchInlineResponse[];
    inlinedResponses?: GeminiBatchInlineResponse[];
  };
  done?: boolean;
  metadata?: {
    state?: string;
  };
  name?: string;
  response?: {
    inlined_responses?: GeminiBatchInlineResponse[];
    inlinedResponses?: GeminiBatchInlineResponse[];
    responsesFile?: string;
  };
  state?: string;
};
