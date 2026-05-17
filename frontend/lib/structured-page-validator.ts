export type StructuredPageBlock = {
  block_id: string;
  type: string;
  reading_order: number;
  exact_text: string;
  corrected_text: string;
  math: {
    latex: string[];
    normalized_ascii: string[];
  };
  item_metadata: {
    item_kind: string | null;
    item_number: string | null;
    item_label: string | null;
    canonical_item_id: string | null;
  };
  searchable_keywords: string[];
  semantic_summary: string;
  relationships: Array<{
    relation_type: string;
    target_block_id: string;
    confidence: number;
  }>;
  confidence: number;
};

export type StructuredLearningObject = {
  object_id: string;
  object_type: string;
  title: string | null;
  label: string | null;
  related_block_ids: string[];
  searchable_keywords: string[];
  semantic_summary: string;
  confidence: number;
};

export type StructuredPageJson = {
  schema_version: "universal_textbook_page_v1";
  page: {
    page_number: number | null;
    detected_page_label: string | null;
    document_title: string | null;
    chapter: string | null;
    section: string | null;
    section_title: string | null;
    page_type: string;
    language: string;
    overall_confidence: number;
  };
  blocks: StructuredPageBlock[];
  page_level_search_text: string;
  page_level_summary: string;
  detected_learning_objects: StructuredLearningObject[];
  extraction_warnings: string[];
};

export type StructuredPageValidationResult =
  | {
      ok: true;
      page: StructuredPageJson;
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      warnings: string[];
    };

const visibleStringFields = new Set(["exact_text", "corrected_text", "semantic_summary"]);

export function parseAndValidateStructuredPageJson(rawOutput: string): StructuredPageValidationResult {
  const warnings: string[] = [];
  const stripped = stripJsonMarkdown(rawOutput);

  if (stripped !== rawOutput.trim()) {
    warnings.push("invalid JSON repaired: stripped markdown wrapper");
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(stripped);
  } catch (caughtError) {
    return {
      ok: false,
      error: caughtError instanceof Error ? `Gemini returned invalid JSON: ${caughtError.message}` : "Gemini returned invalid JSON.",
      warnings: ["Gemini extraction failure", ...warnings]
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      error: "Gemini structured page output was not a JSON object.",
      warnings: ["Gemini extraction failure", ...warnings]
    };
  }

  const source = parsed as Record<string, unknown>;
  const missingTopLevel = [
    "schema_version",
    "page",
    "blocks",
    "page_level_search_text",
    "page_level_summary",
    "detected_learning_objects",
    "extraction_warnings"
  ].filter((field) => !(field in source));

  if (missingTopLevel.length) {
    warnings.push(`missing required fields: ${missingTopLevel.join(", ")}`);
  }

  const pageSource = recordOrEmpty(source.page);
  const blocks = normalizeBlocks(source.blocks, warnings);
  const page: StructuredPageJson = {
    schema_version: "universal_textbook_page_v1",
    page: {
      page_number: nullableNumber(pageSource.page_number),
      detected_page_label: nullableString(pageSource.detected_page_label),
      document_title: nullableString(pageSource.document_title),
      chapter: nullableString(pageSource.chapter),
      section: nullableString(pageSource.section),
      section_title: nullableString(pageSource.section_title),
      page_type: stringOrDefault(pageSource.page_type, "unknown"),
      language: stringOrDefault(pageSource.language, "en"),
      overall_confidence: normalizeConfidence(pageSource.overall_confidence, warnings, "page overall_confidence")
    },
    blocks,
    page_level_search_text: stringOrDefault(source.page_level_search_text, ""),
    page_level_summary: stringOrDefault(source.page_level_summary, ""),
    detected_learning_objects: normalizeLearningObjects(source.detected_learning_objects, warnings),
    extraction_warnings: normalizeStringArray(source.extraction_warnings)
  };

  if (!Array.isArray(source.blocks)) {
    warnings.push("missing required fields: blocks");
  }

  if (!page.blocks.length) {
    warnings.push("empty block list");
  }

  if (!page.page_level_search_text.trim()) {
    warnings.push("empty page_level_search_text");
    page.page_level_search_text = buildFallbackPageSearchText(page);
  }

  if (page.page.overall_confidence < 0.5) {
    warnings.push("low page confidence");
  }

  for (const block of page.blocks) {
    if (block.confidence < 0.5) {
      warnings.push(`low block confidence: ${block.block_id}`);
    }

    const mathWarnings = [...block.math.latex, ...block.math.normalized_ascii]
      .filter((value) => /\?|unknown|unclear|illegible/i.test(value));

    if (mathWarnings.length) {
      warnings.push(`math extraction uncertainty: ${block.block_id}`);
    }
  }

  page.extraction_warnings = uniqueStrings([...page.extraction_warnings, ...warnings]);

  return {
    ok: true,
    page,
    warnings: page.extraction_warnings
  };
}

function stripJsonMarkdown(rawOutput: string) {
  const trimmed = rawOutput.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  if (fencedMatch?.[1]) {
    return fencedMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace > 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function normalizeBlocks(value: unknown, warnings: string[]) {
  const seen = new Map<string, number>();
  const blocks = (Array.isArray(value) ? value : [])
    .map((item, index) => {
      const block = recordOrEmpty(item);
      const missingFields = [
        "block_id",
        "type",
        "reading_order",
        "exact_text",
        "corrected_text",
        "math",
        "item_metadata",
        "searchable_keywords",
        "semantic_summary",
        "relationships",
        "confidence"
      ].filter((field) => !(field in block));

      if (missingFields.length) {
        warnings.push(`missing required fields on block ${index + 1}: ${missingFields.join(", ")}`);
      }

      const readingOrder = readInteger(block.reading_order) ?? index + 1;
      const rawBlockId = stringOrDefault(block.block_id, `block_${String(index + 1).padStart(3, "0")}`);
      const duplicateCount = seen.get(rawBlockId) ?? 0;
      seen.set(rawBlockId, duplicateCount + 1);

      const blockId = duplicateCount
        ? `${rawBlockId}_${String(duplicateCount + 1).padStart(2, "0")}`
        : rawBlockId;

      if (duplicateCount) {
        warnings.push(`duplicate block_id repaired: ${rawBlockId}`);
      }

      const math = recordOrEmpty(block.math);
      const itemMetadata = recordOrEmpty(block.item_metadata);

      return {
        block_id: blockId,
        type: stringOrDefault(block.type, "unknown_block"),
        reading_order: readingOrder,
        exact_text: stringOrDefault(block.exact_text, ""),
        corrected_text: stringOrDefault(block.corrected_text, ""),
        math: {
          latex: normalizeStringArray(math.latex),
          normalized_ascii: normalizeStringArray(math.normalized_ascii)
        },
        item_metadata: {
          item_kind: nullableString(itemMetadata.item_kind),
          item_number: nullableString(itemMetadata.item_number),
          item_label: nullableString(itemMetadata.item_label),
          canonical_item_id: nullableString(itemMetadata.canonical_item_id)
        },
        searchable_keywords: normalizeStringArray(block.searchable_keywords),
        semantic_summary: stringOrDefault(block.semantic_summary, ""),
        relationships: normalizeRelationships(block.relationships),
        confidence: normalizeConfidence(block.confidence, warnings, `block ${blockId} confidence`)
      };
    })
    .sort((first, second) => first.reading_order - second.reading_order);

  return blocks.map((block, index) => ({
    ...block,
    reading_order: readInteger(block.reading_order) ?? index + 1
  }));
}

function normalizeRelationships(value: unknown) {
  return (Array.isArray(value) ? value : []).map((item) => {
    const relationship = recordOrEmpty(item);

    return {
      relation_type: stringOrDefault(relationship.relation_type, "nearby"),
      target_block_id: stringOrDefault(relationship.target_block_id, ""),
      confidence: normalizeConfidence(relationship.confidence)
    };
  });
}

function normalizeLearningObjects(value: unknown, warnings: string[]) {
  if (!Array.isArray(value)) {
    warnings.push("detected_learning_objects missing or not an array");
    return [];
  }

  return value.map((item, index) => {
    const object = recordOrEmpty(item);

    return {
      object_id: stringOrDefault(object.object_id, `object_${String(index + 1).padStart(3, "0")}`),
      object_type: stringOrDefault(object.object_type, "unknown"),
      title: nullableString(object.title),
      label: nullableString(object.label),
      related_block_ids: normalizeStringArray(object.related_block_ids),
      searchable_keywords: normalizeStringArray(object.searchable_keywords),
      semantic_summary: stringOrDefault(object.semantic_summary, ""),
      confidence: normalizeConfidence(object.confidence, warnings, `learning object ${index + 1} confidence`)
    };
  });
}

function buildFallbackPageSearchText(page: StructuredPageJson) {
  return page.blocks
    .flatMap((block) => [
      block.corrected_text,
      block.exact_text,
      ...block.math.normalized_ascii,
      ...block.searchable_keywords,
      block.semantic_summary
    ])
    .filter((value) => value.trim())
    .join("\n")
    .trim();
}

function normalizeStringArray(value: unknown) {
  return (Array.isArray(value) ? value : [])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function normalizeConfidence(value: unknown, warnings: string[] = [], label = "confidence") {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    warnings.push(`missing required fields: ${label}`);
    return 0;
  }

  if (parsed < 0 || parsed > 1) {
    warnings.push(`${label} clamped to 0-1`);
  }

  return Math.max(0, Math.min(1, parsed));
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringOrDefault(value: unknown, fallback: string) {
  if (typeof value === "string") {
    return value.trim();
  }

  if (visibleStringFields.has(String(value))) {
    return "";
  }

  if (value === null || value === undefined) {
    return fallback;
  }

  return String(value).trim() || fallback;
}

function nullableString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function nullableNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readInteger(value: unknown) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function uniqueStrings(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
