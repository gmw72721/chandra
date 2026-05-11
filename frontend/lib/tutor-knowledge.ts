export const tutorKnowledgeKinds = [
  "Assignment",
  "Practice Problems",
  "Practice Solutions",
  "Notes",
  "Reading",
  "Example",
  "Rubric"
] as const;

export type TutorKnowledgeKind = (typeof tutorKnowledgeKinds)[number];

export type TutorKnowledgeSourceMode = "file" | "pasted" | "file-and-pasted";

export const supportedTutorKnowledgeExtensions = [".pdf", ".txt", ".md", ".csv"] as const;

export const geminiEmbedding2PdfPageLimit = 6;
const targetChunkTokens = 1000;
const minChunkTokens = 800;
const maxChunkTokens = 1200;
const overlapTokens = 160;

export type TutorKnowledgeChunkImage = {
  data: Uint8Array | string;
  mimeType: string;
};

export type TutorKnowledgeChunkFile = {
  data: Uint8Array | string;
  mimeType: string;
};

export type TutorKnowledgeChunk = {
  content: string;
  label: string;
  order: number;
  chunkText?: string;
  docId?: string;
  pageAssetPrefix?: string;
  pageAssetStorageBucket?: string;
  page_asset_prefix?: string;
  page_asset_storage_bucket?: string;
  pageEnd?: number;
  pageImage?: TutorKnowledgeChunkImage;
  pdfPart?: TutorKnowledgeChunkFile;
  pageStart?: number;
  section?: string;
  sourceType?: "text" | "page-image" | "mixed" | "pasted";
};

export type TutorKnowledgePageClassification = "text-heavy" | "visual-scanned" | "mixed";

export type TutorKnowledgePageMetrics = {
  imageCoverageRatio?: number;
  embeddedImageCount?: number;
  lineCount?: number;
  pageArea?: number;
  textDensity?: number;
};

export type TutorKnowledgePage = {
  classification?: TutorKnowledgePageClassification;
  isVisual?: boolean;
  metrics?: TutorKnowledgePageMetrics;
  pageNumber: number;
  text: string;
  image?: TutorKnowledgeChunkImage;
};

export function chunkTutorKnowledgeText(
  text: string,
  metadata: {
    docId?: string;
    labelPrefix?: string;
    sourceType?: TutorKnowledgeChunk["sourceType"];
    title?: string;
  } = {}
): TutorKnowledgeChunk[] {
  const normalizedText = normalizeChunkText(text);

  if (!normalizedText) {
    return [];
  }

  const chunks: TutorKnowledgeChunk[] = [];
  const words = tokenize(normalizedText);
  const step = targetChunkTokens - overlapTokens;

  for (let start = 0; start < words.length; start += step) {
    const chunkWords = words.slice(start, start + targetChunkTokens);
    const order = chunks.length;
    const content = chunkWords.join(" ");

    chunks.push({
      chunkText: content,
      content,
      docId: metadata.docId,
      label: `${metadata.labelPrefix ?? "Knowledge chunk"} ${order + 1}`,
      order,
      section: extractLikelySection(content),
      sourceType: metadata.sourceType ?? "text"
    });
  }

  return chunks;
}

export function chunkTutorKnowledgePages({
  docId,
  pages,
  title
}: {
  docId: string;
  pages: TutorKnowledgePage[];
  title: string;
}) {
  const pageLevelChunks: TutorKnowledgeChunk[] = [];
  const textBlocks: TextBlock[] = [];

  for (const page of pages) {
    if (page.pageNumber <= 0) {
      continue;
    }

    const normalizedPage = {
      ...page,
      text: page.text.trim()
    };
    const classification = classifyTutorKnowledgePage(normalizedPage);

    if (classification === "text-heavy") {
      textBlocks.push(...pageTextBlocks(normalizedPage));
    } else {
      const chunkText = normalizeChunkText(normalizedPage.text);
      const content = chunkText || `Visual PDF page ${page.pageNumber} from ${title}`;

      pageLevelChunks.push({
        chunkText,
        content,
        docId,
        label: `Page ${page.pageNumber}`,
        order: pageLevelChunks.length,
        pageEnd: page.pageNumber,
        pageImage: page.image,
        pageStart: page.pageNumber,
        section: extractLikelySection(chunkText),
        sourceType: classification === "mixed" ? "mixed" : "page-image"
      });
    }
  }

  const textChunks = chunkTextBlocks({
    blocks: textBlocks,
    docId,
    orderOffset: pageLevelChunks.length
  });

  return [...textChunks, ...pageLevelChunks]
    .sort((first, second) => (first.pageStart ?? 0) - (second.pageStart ?? 0) || first.order - second.order)
    .map((chunk, order) => ({
      ...chunk,
      order
    }));
}

export function getTutorKnowledgeSourceMode({
  hasFile,
  hasPastedText
}: {
  hasFile: boolean;
  hasPastedText: boolean;
}): TutorKnowledgeSourceMode {
  if (hasFile && hasPastedText) {
    return "file-and-pasted";
  }

  return hasFile ? "file" : "pasted";
}

export function isTutorKnowledgeKind(kind: string): kind is TutorKnowledgeKind {
  return tutorKnowledgeKinds.includes(kind as TutorKnowledgeKind);
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function classifyTutorKnowledgePage(page: TutorKnowledgePage): TutorKnowledgePageClassification {
  if (page.classification) {
    return page.classification;
  }

  const usefulWords = usefulTextTokens(page.text);
  const wordCount = usefulWords.length;
  const lineCount = page.metrics?.lineCount ?? countTextLines(page.text);
  const textDensity = page.metrics?.textDensity ?? densityForPage(wordCount, page.metrics?.pageArea);
  const imageCoverageRatio = page.metrics?.imageCoverageRatio ?? 0;
  const embeddedImageCount = page.metrics?.embeddedImageCount ?? 0;
  const noisyText = looksLikeNoisyOcrText(page.text, usefulWords);
  const hasStrongVisualSignal = Boolean(page.image) || imageCoverageRatio >= 0.35 || embeddedImageCount >= 2;
  const hasAnyVisualSignal = hasStrongVisualSignal || page.isVisual === true || imageCoverageRatio >= 0.12;
  const normalLineStructure = lineCount >= 6 && !noisyText;

  if ((wordCount < 30 || noisyText) && (hasAnyVisualSignal || !page.text.trim())) {
    return "visual-scanned";
  }

  if (wordCount >= 150 && normalLineStructure && imageCoverageRatio < 0.25 && textDensity >= 0.00012) {
    return "text-heavy";
  }

  if (wordCount >= 150 && normalLineStructure && !hasStrongVisualSignal) {
    return "text-heavy";
  }

  return "mixed";
}

type TextBlock = {
  pageEnd: number;
  pageStart: number;
  section: string;
  text: string;
  tokens: string[];
};

function chunkTextBlocks({
  blocks,
  docId,
  orderOffset
}: {
  blocks: TextBlock[];
  docId: string;
  orderOffset: number;
}) {
  const chunks: TutorKnowledgeChunk[] = [];
  let currentBlocks: TextBlock[] = [];
  let currentTokenCount = 0;

  const flush = (seedOverlap = true) => {
    if (!currentBlocks.length) {
      return;
    }

    const tokens = currentBlocks.flatMap((block) => block.tokens);
    const content = tokens.join(" ").trim();
    const pageStart = Math.min(...currentBlocks.map((block) => block.pageStart));
    const pageEnd = Math.max(...currentBlocks.map((block) => block.pageEnd));
    const section = currentBlocks.find((block) => block.section)?.section || extractLikelySection(content);
    const order = orderOffset + chunks.length;

    chunks.push({
      chunkText: content,
      content,
      docId,
      label: pageStart === pageEnd ? `Page ${pageStart}` : `Pages ${pageStart}-${pageEnd}`,
      order,
      pageEnd,
      pageStart,
      section,
      sourceType: "text"
    });

    const overlap = seedOverlap
      ? trailingTokenBlock({
          blocks: currentBlocks,
          maxTokens: overlapTokens,
          section
        })
      : null;
    currentBlocks = overlap ? [overlap] : [];
    currentTokenCount = overlap?.tokens.length ?? 0;
  };

  for (const block of splitOversizedBlocks(blocks)) {
    const nextPageStart = currentBlocks[0]?.pageStart ?? block.pageStart;
    const wouldCrossPdfPageWindow = block.pageEnd - nextPageStart + 1 > geminiEmbedding2PdfPageLimit;
    const wouldExceedMax = currentTokenCount + block.tokens.length > maxChunkTokens;

    if (currentBlocks.length && (wouldCrossPdfPageWindow || (wouldExceedMax && currentTokenCount >= minChunkTokens))) {
      flush();
    }

    currentBlocks.push(block);
    currentTokenCount += block.tokens.length;

    if (currentTokenCount >= targetChunkTokens) {
      flush();
    }
  }

  if (currentBlocks.length && !(chunks.length && currentTokenCount <= overlapTokens)) {
    flush(false);
  }

  return chunks.filter((chunk) => chunk.content.trim());
}

function splitOversizedBlocks(blocks: TextBlock[]) {
  const nextBlocks: TextBlock[] = [];

  for (const block of blocks) {
    if (block.tokens.length <= maxChunkTokens) {
      nextBlocks.push(block);
      continue;
    }

    for (let start = 0; start < block.tokens.length; start += targetChunkTokens - overlapTokens) {
      const tokens = block.tokens.slice(start, start + targetChunkTokens);
      nextBlocks.push({
        ...block,
        text: tokens.join(" "),
        tokens
      });
    }
  }

  return nextBlocks;
}

function pageTextBlocks(page: TutorKnowledgePage): TextBlock[] {
  const lines = page.text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const blocks: TextBlock[] = [];
  let section = "";
  let paragraph: string[] = [];

  const pushParagraph = () => {
    const text = normalizeChunkText(paragraph.join(" "));
    paragraph = [];

    if (!text) {
      return;
    }

    blocks.push({
      pageEnd: page.pageNumber,
      pageStart: page.pageNumber,
      section,
      text,
      tokens: tokenize(text)
    });
  };

  for (const line of lines) {
    if (looksLikeHeading(line)) {
      pushParagraph();
      section = line;
      continue;
    }

    paragraph.push(line);
  }

  pushParagraph();

  if (!blocks.length && page.text.trim()) {
    const text = normalizeChunkText(page.text);
    blocks.push({
      pageEnd: page.pageNumber,
      pageStart: page.pageNumber,
      section: extractLikelySection(text),
      text,
      tokens: tokenize(text)
    });
  }

  return blocks;
}

function trailingTokenBlock({
  blocks,
  maxTokens,
  section
}: {
  blocks: TextBlock[];
  maxTokens: number;
  section: string;
}) {
  const tokens = blocks.flatMap((block) =>
    block.tokens.map((token) => ({
      page: block.pageEnd,
      token
    }))
  );
  const overlapTokensWithPage = tokens.slice(-maxTokens);

  if (!overlapTokensWithPage.length) {
    return null;
  }

  const textTokens = overlapTokensWithPage.map((item) => item.token);
  const pages = overlapTokensWithPage.map((item) => item.page);

  return {
    pageEnd: Math.max(...pages),
    pageStart: Math.min(...pages),
    section,
    text: textTokens.join(" "),
    tokens: textTokens
  };
}

function looksLikeHeading(line: string) {
  const text = line.trim();

  if (!text || text.length > 120 || text.endsWith(".") || text.endsWith(",") || text.endsWith(";")) {
    return false;
  }

  return (
    /^#{1,6}\s+\S/.test(text) ||
    /^(section|chapter|unit|lesson|part)\s+\d+/i.test(text) ||
    /^[A-Z][A-Za-z0-9\s:()/-]{2,}$/.test(text)
  );
}

function extractLikelySection(text: string) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";

  if (looksLikeHeading(firstLine)) {
    return firstLine.replace(/^#{1,6}\s+/, "");
  }

  const firstSentence = normalizeChunkText(text).split(/(?<=[.!?])\s+/)[0]?.trim() ?? "";
  return firstSentence.length <= 90 ? firstSentence : "";
}

function normalizeChunkText(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function tokenize(text: string) {
  return text.match(/\S+/g) ?? [];
}

function usefulTextTokens(text: string) {
  return tokenize(text)
    .map((token) => token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((token) => /[\p{L}\p{N}]/u.test(token) && token.length > 1);
}

function countTextLines(text: string) {
  return text.split(/\r?\n/).filter((line) => line.trim().length >= 3).length;
}

function densityForPage(wordCount: number, pageArea: number | undefined) {
  return pageArea && pageArea > 0 ? wordCount / pageArea : 0;
}

function looksLikeNoisyOcrText(text: string, usefulWords: string[]) {
  if (!text.trim()) {
    return false;
  }

  const uniqueWords = new Set(usefulWords.map((word) => word.toLowerCase()));
  const uniqueRatio = usefulWords.length ? uniqueWords.size / usefulWords.length : 0;
  const symbolCount = Array.from(text).filter((character) => /[^\p{L}\p{N}\s.,;:!?()[\]{}'"#%/+*=-]/u.test(character)).length;
  const symbolRatio = text.length ? symbolCount / text.length : 0;
  const shortTokenRatio = usefulWords.length
    ? usefulWords.filter((word) => word.length <= 2).length / usefulWords.length
    : 0;

  return (
    (usefulWords.length >= 20 && uniqueRatio < 0.35) ||
    symbolRatio > 0.18 ||
    (usefulWords.length >= 20 && shortTokenRatio > 0.55)
  );
}
