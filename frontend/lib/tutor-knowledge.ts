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

const targetChunkTokens = 1000;
const overlapTokens = 160;

export type TutorKnowledgeChunk = {
  content: string;
  label: string;
  order: number;
  chunkText?: string;
  docId?: string;
  pageEnd?: number;
  pageStart?: number;
  section?: string;
  sourceType?: "text" | "pasted";
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
