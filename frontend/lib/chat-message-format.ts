import type { ChatMessage, TutorStructuredSectionKey } from "@/lib/types";

export type AssistantStructuredSection = {
  content: string;
  kind: string;
  label: string;
};

export type AssistantMessageBlock =
  | { content: string; kind: "answer"; label?: undefined }
  | AssistantStructuredSection;

type MessageSource = NonNullable<ChatMessage["sources"]>[number];
const fallbackSectionOrder: TutorStructuredSectionKey[] = [
  "problem",
  "answer",
  "hint",
  "explanation",
  "formula",
  "example",
  "checkWork",
  "sourceNote",
  "nextStep"
];

export function assistantMessageAnswerContent(message: ChatMessage) {
  return message.structuredOutput ? message.structuredOutput.sections.answer : message.content;
}

export function assistantMessageBlocks(message: ChatMessage): AssistantMessageBlock[] {
  if (!message.structuredOutput) {
    return message.content ? [{ content: message.content, kind: "answer" }] : [];
  }

  const sections = message.structuredOutput.sections;
  const sectionMap: Record<TutorStructuredSectionKey, AssistantMessageBlock | undefined> = {
    answer: sections.answer ? { content: sections.answer, kind: "answer" } : undefined,
    problem: sections.problem ? { content: sections.problem, kind: "problem", label: "Problem" } : undefined,
    hint: sections.hint ? { content: sections.hint, kind: "hint", label: "Hint" } : undefined,
    explanation: sections.explanation ? { content: sections.explanation, kind: "explanation", label: "Why this works" } : undefined,
    formula: sections.formula ? { content: sections.formula, kind: "formula", label: "Formula" } : undefined,
    example: sections.example ? { content: sections.example, kind: "example", label: "Similar example" } : undefined,
    checkWork: sections.checkWork ? { content: sections.checkWork, kind: "check-work", label: "Check your work" } : undefined,
    sourceNote:
      !message.sources?.length && !isGenericSourceNote(sections.sourceNote)
        ? { content: sections.sourceNote ?? "", kind: "source-note", label: "Source" }
        : undefined,
    nextStep: sections.nextStep ? { content: sections.nextStep, kind: "next-step", label: "Your next step" } : undefined
  };
  const requestedOrder = message.structuredOutput.sectionOrder?.length
    ? message.structuredOutput.sectionOrder
    : fallbackSectionOrder;
  const seen = new Set<TutorStructuredSectionKey>();
  const orderedKeys = [...requestedOrder, ...fallbackSectionOrder].filter((key) => {
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return Boolean(sectionMap[key]);
  });

  return orderedKeys.map((key) => sectionMap[key]).filter((block): block is AssistantMessageBlock => Boolean(block));
}

export function assistantStructuredSections(message: ChatMessage): AssistantStructuredSection[] {
  return assistantMessageBlocks(message).filter((block): block is AssistantStructuredSection => block.kind !== "answer");
}

export function condensedSourceLabels(sources: NonNullable<ChatMessage["sources"]>) {
  const groupedSources = new Map<string, { pages: Set<number>; source: MessageSource }>();

  for (const source of sources) {
    const key = [source.title, source.materialType, source.problemNumber ?? ""].join("|");
    const existing = groupedSources.get(key) ?? { pages: new Set<number>(), source };

    if (source.pageNumber) {
      existing.pages.add(source.pageNumber);
    }

    groupedSources.set(key, existing);
  }

  const labels = Array.from(groupedSources.values()).map(
    ({ pages, source }) => formatSourceLabel({ ...source, pageNumber: undefined }) + formatPageRange(Array.from(pages))
  );
  const visibleLabels = labels.slice(0, 3);

  return labels.length > visibleLabels.length ? [...visibleLabels, `+${labels.length - visibleLabels.length} more`] : visibleLabels;
}

export function normalizeStructuredSectionMarkdown(content: string, kind: string) {
  const cleaned = content
    .trim()
    .replace(/^\*\*\s*/, "")
    .replace(/\s*\*\*$/, "");

  if (kind === "problem") {
    return normalizeProblemSectionMarkdown(cleaned);
  }

  if (kind === "formula") {
    return normalizeFormulaSectionMarkdown(cleaned);
  }

  return cleaned;
}

function normalizeFormulaSectionMarkdown(content: string) {
  if (/^\$\$[\s\S]*\$\$$/.test(content) || /^\\\[/.test(content)) {
    return content;
  }

  const splitFormula = splitFormulaCommentary(content);

  if (!isMathOnlyFormulaSection(splitFormula.formula)) {
    return content;
  }

  const formulas = splitFormula.formula
    .split(/\s*,\s*(?=(?:P|E|M|A|\\mu|μ|\$?\\?mu)\b)/)
    .map((formula) => formula.trim())
    .filter(Boolean);

  if (formulas.length <= 1) {
    return `$$\n${splitFormula.formula.replace(/^\$|\$$/g, "")}\n$$`;
  }

  return formulas.map((formula) => `$$\n${formula.replace(/^\$|\$$/g, "")}\n$$`).join("\n\n");
}

function splitFormulaCommentary(content: string) {
  const commentaryMatch = content.match(/\s+(That|This|These|It)\s+.+$/);

  if (!commentaryMatch?.index) {
    return { formula: content, commentary: "" };
  }

  return {
    formula: content.slice(0, commentaryMatch.index).trim(),
    commentary: content.slice(commentaryMatch.index).trim()
  };
}

function isMathOnlyFormulaSection(content: string) {
  const withoutMath = content
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$]+\$/g, " ")
    .replace(/\\[a-zA-Z]+/g, " ")
    .replace(/[=+\-*/^_{}()[\],.:;|<>≤≥∈∩∪]/g, " ")
    .replace(/\d+/g, " ");
  const proseWords = withoutMath.match(/[A-Za-z]{3,}/g) ?? [];

  return proseWords.length <= 1 && !/^[-*]\s/.test(content.trim());
}

function normalizeProblemSectionMarkdown(content: string) {
  let formatted = content
    .replace(/\r\n/g, "\n")
    .replace(/^\*\*(PROBLEM|EXERCISE|QUESTION|THEOREM|DEFINITION|EXAMPLE)\*\*\s+/i, "$1\n\n")
    .replace(/^(PROBLEM|EXERCISE|QUESTION|THEOREM|DEFINITION|EXAMPLE)\s+(?=\d|[A-Z]|\$|\\\()/i, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const enumeratedPartPattern = /\s(\((?:i{1,4}|iv|v|vi{0,3}|[a-h])\)\s+)/gi;
  const enumeratedParts = formatted.match(enumeratedPartPattern) ?? [];

  if (enumeratedParts.length >= 2) {
    formatted = formatted.replace(enumeratedPartPattern, "\n\n$1");
  }

  return formatted
    .replace(/^(PROBLEM|EXERCISE|QUESTION|THEOREM|DEFINITION|EXAMPLE)$/im, "**$1**")
    .replace(/(^|\n\n)(\d+(?:\.\d+)*[a-z]?\.?)\s+/i, "$1**$2** ")
    .replace(/(^|\n\n)(\((?:i{1,4}|iv|v|vi{0,3}|[a-h])\))\s+/gi, "$1**$2** ");
}

export function normalizeMarkdownMath(content: string) {
  return content
    .replace(/\\\[/g, "$$")
    .replace(/\\\]/g, "$$")
    .replace(/\\\(/g, "$")
    .replace(/\\\)/g, "$")
    .replace(/^\[\s*(\\(?:int|frac|sqrt|sum|lim|prod)[\s\S]*?)\s*\]$/gm, "$$$$\n$1\n$$$$");
}

function isGenericSourceNote(note: string | undefined) {
  return !note || /^based on the selected class material\.?$/i.test(note.trim());
}

function formatSourceLabel(source: MessageSource) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    source.pageNumber ? `p. ${source.pageNumber}` : ""
  ].filter(Boolean).join(" · ");
}

function formatPageRange(pages: number[]) {
  const sortedPages = [...new Set(pages)].sort((first, second) => first - second);

  if (!sortedPages.length) {
    return "";
  }

  const ranges: string[] = [];
  let rangeStart = sortedPages[0];
  let previousPage = sortedPages[0];

  for (const page of sortedPages.slice(1)) {
    if (page === previousPage + 1) {
      previousPage = page;
      continue;
    }

    ranges.push(rangeStart === previousPage ? `${rangeStart}` : `${rangeStart}-${previousPage}`);
    rangeStart = page;
    previousPage = page;
  }

  ranges.push(rangeStart === previousPage ? `${rangeStart}` : `${rangeStart}-${previousPage}`);

  return ` · ${ranges.length === 1 && !ranges[0].includes("-") ? "p." : "pp."} ${ranges.join(", ")}`;
}
