import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { geminiPageExtractionModel } from "./pdf-ingestion-config.ts";

const geminiApiBaseUrl = "https://generativelanguage.googleapis.com/v1beta";
const defaultGeminiPageExtractionTimeoutMs = 120000;
const defaultGeminiPageBatchPollIntervalMs = 5000;
const defaultGeminiPageBatchTimeoutMs = 15 * 60 * 1000;
const defaultGeminiPageBatchMaxBytes = 18 * 1024 * 1024;

export type GeminiStructuredPageExtractionResult = {
  model: string;
  rawText: string;
};

export type GeminiStructuredPageBatchInput = {
  mimeType: string;
  pageBuffer: Buffer;
  pageNumber: number;
};

export async function extractStructuredPageWithGemini({
  mimeType,
  pageBuffer,
  pageNumber,
  title
}: {
  mimeType: string;
  pageBuffer: Buffer;
  pageNumber: number;
  title: string;
}): Promise<GeminiStructuredPageExtractionResult> {
  const model = geminiPageExtractionModel();
  const response = await fetchGeminiGenerateContent({
    body: JSON.stringify(buildStructuredPageGenerateContentRequest({ mimeType, pageBuffer, pageNumber, title })),
    model
  });

  const payload = await response.json() as GeminiGenerateContentResponse;
  const rawText = readGenerateContentText(payload);

  if (!rawText) {
    throw new Error(`Gemini page extraction returned no JSON for page ${pageNumber}.`);
  }

  return { model, rawText };
}

export async function extractStructuredPagesWithGeminiBatch({
  onProgress,
  pages,
  title
}: {
  onProgress?: (progress: {
    batchIndex: number;
    batchName: string;
    elapsedMs: number;
    pageCount: number;
    state: string;
    totalBatches: number;
  }) => Promise<void> | void;
  pages: GeminiStructuredPageBatchInput[];
  title: string;
}): Promise<{
  model: string;
  results: Map<number, GeminiStructuredPageExtractionResult>;
  warnings: string[];
}> {
  const model = geminiPageExtractionModel();
  const apiKey = getGeminiApiKey();
  const results = new Map<number, GeminiStructuredPageExtractionResult>();
  const warnings: string[] = [];
  const batchRequestGroups = buildGeminiPageBatchRequestGroups({ model, pages, title });

  for (const [batchIndex, batchRequests] of batchRequestGroups.entries()) {
    const batch = await createGeminiPageBatch({
      apiKey,
      model,
      requests: batchRequests
    });
    const completedBatch = await waitForGeminiPageBatch({
      apiKey,
      batchIndex: batchIndex + 1,
      batchName: batch.name,
      onProgress,
      pageCount: batchRequests.length,
      totalBatches: batchRequestGroups.length
    });
    const inlinedResponses = readGeminiBatchInlinedResponses(completedBatch);

    batchRequests.forEach((request, index) => {
      const responseItem = inlinedResponses[index];
      const pageNumber = request.pageNumber;
      const itemError = responseItem ? readGeminiBatchInlineError(responseItem) : "missing inline batch response";

      if (itemError) {
        warnings.push(`page ${pageNumber}: Gemini batch extraction item failed: ${itemError}`);
        return;
      }

      const response = readGeminiBatchInlineGenerateContentResponse(responseItem);
      const rawText = response ? readGenerateContentText(response) : "";

      if (!rawText) {
        warnings.push(`page ${pageNumber}: Gemini batch extraction returned no JSON.`);
        return;
      }

      results.set(pageNumber, { model, rawText });
    });
  }

  return { model, results, warnings };
}

async function fetchGeminiGenerateContent({
  body,
  model
}: {
  body: string;
  model: string;
}) {
  const apiKey = getGeminiApiKey();
  const url = `${geminiApiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`;
  const timeoutMs = readPositiveInteger(process.env.GEMINI_PAGE_EXTRACTION_TIMEOUT_MS)
    ?? defaultGeminiPageExtractionTimeoutMs;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        body,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
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
          `Gemini page extraction failed with ${response.status} using ${model} key fingerprint ${fingerprintSecret(apiKey)}: ${detail.slice(0, 500)}`
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

async function createGeminiPageBatch({
  apiKey,
  model,
  requests
}: {
  apiKey: string;
  model: string;
  requests: GeminiPageBatchRequest[];
}) {
  const url = `${geminiApiBaseUrl}/models/${encodeURIComponent(model)}:batchGenerateContent`;
  const response = await fetch(url, {
    body: JSON.stringify({
      batch: {
        display_name: `structured-page-extraction-${Date.now()}`,
        input_config: {
          requests: {
            requests: requests.map((request) => ({
              metadata: {
                key: String(request.pageNumber)
              },
              request: request.request
            }))
          }
        }
      }
    }),
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey
    },
    method: "POST"
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(
      `Gemini batch extraction failed to create job with ${response.status} using ${model} key fingerprint ${fingerprintSecret(apiKey)}: ${detail.slice(0, 500)}`
    );
  }

  const payload = await response.json() as GeminiBatchJobResponse;
  const name = typeof payload.name === "string" ? payload.name : "";

  if (!name) {
    throw new Error("Gemini batch extraction did not return a batch job name.");
  }

  return { name };
}

async function waitForGeminiPageBatch({
  apiKey,
  batchIndex,
  batchName,
  onProgress,
  pageCount,
  totalBatches
}: {
  apiKey: string;
  batchIndex: number;
  batchName: string;
  onProgress?: (progress: {
    batchIndex: number;
    batchName: string;
    elapsedMs: number;
    pageCount: number;
    state: string;
    totalBatches: number;
  }) => Promise<void> | void;
  pageCount: number;
  totalBatches: number;
}) {
  const startedAt = Date.now();
  const timeoutMs = readPositiveInteger(process.env.GEMINI_PAGE_BATCH_TIMEOUT_MS)
    ?? defaultGeminiPageBatchTimeoutMs;
  const pollIntervalMs = readPositiveInteger(process.env.GEMINI_PAGE_BATCH_POLL_INTERVAL_MS)
    ?? defaultGeminiPageBatchPollIntervalMs;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${geminiApiBaseUrl}/${batchName}`, {
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey
      },
      method: "GET"
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini batch extraction status failed with ${response.status}: ${detail.slice(0, 500)}`);
    }

    const payload = await response.json() as GeminiBatchJobResponse;
    const state = readGeminiBatchState(payload);
    const elapsedMs = Date.now() - startedAt;

    await onProgress?.({
      batchIndex,
      batchName,
      elapsedMs,
      pageCount,
      state: state || (payload.done ? "done" : "pending"),
      totalBatches
    });

    if (payload.done || state === "JOB_STATE_SUCCEEDED") {
      if (state && state !== "JOB_STATE_SUCCEEDED") {
        throw new Error(`Gemini batch extraction finished with state ${state}.`);
      }

      return payload;
    }

    if (["JOB_STATE_FAILED", "JOB_STATE_CANCELLED", "JOB_STATE_EXPIRED"].includes(state)) {
      throw new Error(`Gemini batch extraction finished with state ${state}.`);
    }

    await sleep(pollIntervalMs);
  }

  throw new Error(`Gemini batch extraction timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
}

function buildStructuredPageGenerateContentRequest({
  mimeType,
  pageBuffer,
  pageNumber,
  title
}: {
  mimeType: string;
  pageBuffer: Buffer;
  pageNumber: number;
  title: string;
}): GeminiGenerateContentRequest {
  return {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: buildStructuredPageExtractionPrompt({ pageNumber, title })
          },
          {
            inline_data: {
              data: pageBuffer.toString("base64"),
              mime_type: mimeType || "application/pdf"
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json",
      thinkingConfig: {
        thinkingBudget: 0
      },
      temperature: 0
    }
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

function getGeminiApiKey() {
  const apiKey =
    readLocalGeminiApiKey() || process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("Gemini page extraction requires GEMINI_API_KEY or GOOGLE_API_KEY.");
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
      inline_data?: {
        data: string;
        mime_type: string;
      };
      text?: string;
    }>;
    role: string;
  }>;
  generationConfig: {
    responseMimeType: string;
    temperature: number;
    thinkingConfig: {
      thinkingBudget: number;
    };
  };
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
