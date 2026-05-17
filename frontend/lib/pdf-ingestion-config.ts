export const structuredPdfIngestionVersion = "gemini_structured_page_v1";
export const structuredPdfEmbeddingSource = "structured_page_json";
export const defaultStructuredPdfEmbeddingDim = 1536;
export const defaultGeminiPageExtractionModel = "gemini-3-flash-preview";
export const defaultStructuredPageExtractionConcurrency = 4;
export const defaultStructuredPageDirectExtractionConcurrency = 32;
export const defaultStructuredPageBatchMinPages = 200;
export const defaultPdfPageAssetSaveConcurrency = 10;

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

export function structuredPageDirectExtractionConcurrency() {
  const configured = readPositiveInteger(process.env.PDF_STRUCTURED_PAGE_DIRECT_EXTRACTION_CONCURRENCY)
    ?? readPositiveInteger(process.env.PDF_STRUCTURED_PAGE_USE_NOW_CONCURRENCY)
    ?? defaultStructuredPageDirectExtractionConcurrency;

  return Math.min(Math.max(configured, 1), 50);
}

export function structuredPageBatchMinPages() {
  const configured = readPositiveInteger(process.env.PDF_STRUCTURED_PAGE_BATCH_MIN_PAGES)
    ?? readPositiveInteger(process.env.GEMINI_PAGE_BATCH_MIN_PAGES)
    ?? defaultStructuredPageBatchMinPages;

  return Math.max(configured, 1);
}

export function pdfPageAssetSaveConcurrency() {
  const configured = readPositiveInteger(process.env.PDF_PAGE_ASSET_SAVE_CONCURRENCY)
    ?? readPositiveInteger(process.env.PDF_STRUCTURED_PAGE_ASSET_SAVE_CONCURRENCY)
    ?? defaultPdfPageAssetSaveConcurrency;

  return Math.min(Math.max(configured, 1), 20);
}

function readPositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
