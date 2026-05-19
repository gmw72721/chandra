export const structuredPdfIngestionVersion = "gemini_structured_page_v1";
export const structuredPdfEmbeddingSource = "structured_page_json";
export const defaultStructuredPdfEmbeddingDim = 1536;
export const defaultGeminiPageExtractionModel = "gemini-3-flash-preview";
export const defaultStructuredPageExtractionConcurrency = 4;

export function structuredPdfEmbeddingDim() {
  const configuredDimension = readPositiveInteger(process.env.PDF_INGESTION_EMBEDDING_DIM);

  if (configuredDimension && configuredDimension !== defaultStructuredPdfEmbeddingDim) {
    throw new Error(
      `Structured PDF embeddings must be ${defaultStructuredPdfEmbeddingDim}-dimensional; got PDF_INGESTION_EMBEDDING_DIM=${configuredDimension}.`
    );
  }

  return defaultStructuredPdfEmbeddingDim;
}

export function geminiPageExtractionModel() {
  return process.env.GEMINI_PAGE_EXTRACTION_MODEL?.trim()
    || process.env.PDF_INGESTION_EXTRACTION_MODEL?.trim()
    || defaultGeminiPageExtractionModel;
}

export function structuredPageExtractionConcurrency() {
  const configured = readPositiveInteger(process.env.PDF_STRUCTURED_PAGE_EXTRACTION_CONCURRENCY)
    ?? readPositiveInteger(process.env.GEMINI_PAGE_EXTRACTION_CONCURRENCY)
    ?? defaultStructuredPageExtractionConcurrency;

  return Math.min(Math.max(configured, 1), 8);
}

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
