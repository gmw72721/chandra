import {
  structuredPdfEmbeddingDim,
  structuredPdfEmbeddingSource,
  structuredPdfIngestionVersion
} from "./pdf-ingestion-config.ts";
import type { StructuredPageBlock, StructuredPageJson, StructuredLearningObject } from "./structured-page-validator.ts";

export type StructuredEmbeddingRecord = {
  blockId?: string | null;
  blockType?: string | null;
  canonicalItemId?: string | null;
  documentId: string;
  embedding?: number[];
  embeddingCreatedAt?: string;
  embeddingDim: number;
  embeddingLevel: "block" | "learning_object" | "page" | "section";
  embeddingModel?: string;
  embeddingProvider?: string;
  embeddingSource: string;
  embeddingTaskType?: string;
  embeddingText: string;
  ingestionVersion: string;
  itemKind?: string | null;
  itemLabel?: string | null;
  itemNumber?: string | null;
  objectId?: string | null;
  objectType?: string | null;
  pageId?: number | null;
  pageNumber: number;
  readingOrder?: number | null;
  relatedBlockIds?: string[];
  section?: string | null;
  sourceId: string;
  sourceType: "block" | "learning_object" | "page" | "section";
  title?: string | null;
  label?: string | null;
};

export function buildStructuredEmbeddingRecords({
  documentId,
  page,
  pageId,
  pageNumber,
  title
}: {
  documentId: string;
  page: StructuredPageJson;
  pageId?: number | null;
  pageNumber: number;
  title: string;
}) {
  const records: StructuredEmbeddingRecord[] = [];
  const pageMetadata = page.page;
  const blocksById = new Map(page.blocks.map((block) => [block.block_id, block]));
  const embeddingDim = structuredPdfEmbeddingDim();

  for (const learningObject of page.detected_learning_objects) {
    const relatedBlocks = learningObject.related_block_ids.flatMap((blockId) => {
      const block = blocksById.get(blockId);
      return block ? [block] : [];
    });
    const text = buildLearningObjectEmbeddingText({ learningObject, page, relatedBlocks, title });

    if (!text.trim()) {
      continue;
    }

    records.push({
      documentId,
      embeddingDim,
      embeddingLevel: "learning_object",
      embeddingSource: structuredPdfEmbeddingSource,
      embeddingText: text,
      ingestionVersion: structuredPdfIngestionVersion,
      objectId: learningObject.object_id,
      objectType: learningObject.object_type,
      pageId: pageId ?? null,
      pageNumber,
      relatedBlockIds: learningObject.related_block_ids,
      section: pageMetadata.section,
      sourceId: learningObject.object_id,
      sourceType: "learning_object",
      title: learningObject.title,
      label: learningObject.label
    });
  }

  const pageText = buildPageEmbeddingText({ page, title });

  if (pageText.trim()) {
    records.push({
      documentId,
      embeddingDim,
      embeddingLevel: "page",
      embeddingSource: structuredPdfEmbeddingSource,
      embeddingText: pageText,
      ingestionVersion: structuredPdfIngestionVersion,
      pageId: pageId ?? null,
      pageNumber,
      section: pageMetadata.section,
      sourceId: String(pageId ?? pageNumber),
      sourceType: "page"
    });
  }

  return records;
}

export function buildBlockEmbeddingText({
  block,
  page,
  title
}: {
  block: StructuredPageBlock;
  page: StructuredPageJson;
  title: string;
}) {
  if (!isUsefulBlock(block)) {
    return "";
  }

  const pageMetadata = page.page;
  const exactText = block.exact_text.trim() && block.exact_text.trim() !== block.corrected_text.trim()
    ? block.exact_text
    : "";

  return cleanTextLines([
    labeledLine("Document", pageMetadata.document_title ?? title),
    labeledLine("Chapter", pageMetadata.chapter),
    labeledLine("Section", joinPresent([pageMetadata.section, pageMetadata.section_title], " ")),
    labeledLine("Page", pageMetadata.page_number ?? pageMetadata.detected_page_label),
    labeledLine("Block", block.block_id),
    labeledLine("Reading order", block.reading_order),
    labeledLine("Block type", block.type),
    labeledLine("Item kind", block.item_metadata.item_kind),
    labeledLine("Item", block.item_metadata.item_label),
    labeledLine("Item number", block.item_metadata.item_number),
    labeledLine("Canonical item ID", block.item_metadata.canonical_item_id),
    labeledLine("Text", block.corrected_text),
    labeledLine("Visible text", exactText),
    labeledLine("Math", block.math.normalized_ascii.join("; ")),
    labeledLine("Keywords", block.searchable_keywords.join(", ")),
    labeledLine("Summary", block.semantic_summary)
  ]);
}

export function buildLearningObjectEmbeddingText({
  learningObject,
  page,
  relatedBlocks,
  title
}: {
  learningObject: StructuredLearningObject;
  page: StructuredPageJson;
  relatedBlocks: StructuredPageBlock[];
  title: string;
}) {
  const pageMetadata = page.page;
  const blockKeywords = uniqueStrings(relatedBlocks.flatMap((block) => block.searchable_keywords));
  const objectKeywords = uniqueStrings([...learningObject.searchable_keywords, ...blockKeywords]);
  const text = relatedBlocks.map((block) => block.corrected_text || block.exact_text).filter(Boolean).join("\n");
  const math = uniqueStrings(relatedBlocks.flatMap((block) => block.math.normalized_ascii)).join("; ");
  const blockSummaries = uniqueStrings(relatedBlocks.map((block) => block.semantic_summary)).join(" ");

  return cleanTextLines([
    labeledLine("Document", pageMetadata.document_title ?? title),
    labeledLine("Chapter", pageMetadata.chapter),
    labeledLine("Section", joinPresent([pageMetadata.section, pageMetadata.section_title], " ")),
    labeledLine("Page", pageMetadata.page_number ?? pageMetadata.detected_page_label),
    labeledLine("Learning object", learningObject.object_id),
    labeledLine("Object type", learningObject.object_type),
    labeledLine("Title", learningObject.title),
    labeledLine("Label", learningObject.label),
    labeledLine("Related blocks", learningObject.related_block_ids.join(", ")),
    labeledLine("Related block types", uniqueStrings(relatedBlocks.map((block) => block.type)).join(", ")),
    labeledLine("Text", text),
    labeledLine("Math", math),
    labeledLine("Keywords", objectKeywords.join(", ")),
    labeledLine("Summary", joinPresent([learningObject.semantic_summary, blockSummaries], " "))
  ]);
}

export function buildPageEmbeddingText({
  page,
  title
}: {
  page: StructuredPageJson;
  title: string;
}) {
  const pageMetadata = page.page;
  const importantLabels = uniqueStrings(
    page.blocks.flatMap((block) => [
      block.item_metadata.item_label,
      block.item_metadata.canonical_item_id
    ].filter((value): value is string => Boolean(value)))
  );
  const importantMath = uniqueStrings(page.blocks.flatMap((block) => block.math.normalized_ascii));
  const keywords = uniqueStrings([
    ...page.blocks.flatMap((block) => block.searchable_keywords),
    ...page.detected_learning_objects.flatMap((object) => object.searchable_keywords)
  ]);

  return cleanTextLines([
    labeledLine("Document", pageMetadata.document_title ?? title),
    labeledLine("Chapter", pageMetadata.chapter),
    labeledLine("Section", joinPresent([pageMetadata.section, pageMetadata.section_title], " ")),
    labeledLine("Page", pageMetadata.page_number ?? pageMetadata.detected_page_label),
    labeledLine("Page type", pageMetadata.page_type),
    labeledLine("Search text", page.page_level_search_text),
    labeledLine("Summary", page.page_level_summary),
    labeledLine("Important labels", importantLabels.join(", ")),
    labeledLine("Important math", importantMath.join("; ")),
    labeledLine("Keywords", keywords.join(", "))
  ]);
}

export function isUsefulBlock(block: StructuredPageBlock) {
  return Boolean(
    block.corrected_text.trim()
      || block.exact_text.trim()
      || block.math.normalized_ascii.length
      || block.math.latex.length
      || block.searchable_keywords.length
      || block.semantic_summary.trim()
  );
}

function labeledLine(label: string, value: unknown) {
  if (value === null || value === undefined) {
    return "";
  }

  const text = Array.isArray(value) ? value.join(", ") : String(value).trim();
  return text ? `${label}: ${text}` : "";
}

function cleanTextLines(lines: string[]) {
  return lines.filter((line) => line.trim()).join("\n").trim();
}

function joinPresent(values: Array<string | number | null | undefined>, separator: string) {
  return values
    .map((value) => value === null || value === undefined ? "" : String(value).trim())
    .filter(Boolean)
    .join(separator);
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
