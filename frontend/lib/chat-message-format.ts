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
const defaultSectionOrder: TutorStructuredSectionKey[] = [
  "studentResponse",
  "problem",
  "hint",
  "keyIdea",
  "rule",
  "method",
  "example",
  "sourceContext",
  "checkWork"
];

export function assistantMessageAnswerContent(message: ChatMessage) {
  return message.structuredOutput
    ? message.structuredOutput.sections.studentResponse ||
        message.structuredOutput.sections.mainChat ||
        message.structuredOutput.sections.answer ||
        ""
    : message.content;
}

export function assistantMessageBlocks(message: ChatMessage): AssistantMessageBlock[] {
  if (!message.structuredOutput) {
    return message.content ? [{ content: message.content, kind: "answer" }] : [];
  }

  const sections = {
    ...message.structuredOutput.sections,
    studentResponse:
      message.structuredOutput.sections.studentResponse ||
      message.structuredOutput.sections.mainChat ||
      message.structuredOutput.sections.answer
  };
  const sectionMap: Record<TutorStructuredSectionKey, AssistantMessageBlock | undefined> = {
    studentResponse: sections.studentResponse ? { content: sections.studentResponse, kind: "answer" } : undefined,
    problem: sections.problem ? { content: sections.problem, kind: "problem", label: "Problem" } : undefined,
    hint: sections.hint ? { content: sections.hint, kind: "hint", label: "Hint" } : undefined,
    keyIdea: sections.keyIdea ? { content: sections.keyIdea, kind: "key-idea", label: "Key idea" } : undefined,
    rule: sections.rule ? { content: sections.rule, kind: "rule", label: "Rule" } : undefined,
    method: sections.method ? { content: sections.method, kind: "method", label: "Method" } : undefined,
    example: sections.example ? { content: sections.example, kind: "example", label: "Similar example" } : undefined,
    sourceContext: sections.sourceContext ? { content: sections.sourceContext, kind: "source-context", label: "Source context" } : undefined,
    checkWork: sections.checkWork ? { content: sections.checkWork, kind: "check-work", label: "Check your work" } : undefined
  };
  const effectiveOrder = orderedTutorSectionKeys(message);
  const seen = new Set<TutorStructuredSectionKey>();
  const orderedKeys = [...effectiveOrder, ...defaultSectionOrder].filter((key) => {
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

function orderedTutorSectionKeys(message: ChatMessage): TutorStructuredSectionKey[] {
  const sections = message.structuredOutput?.sections;
  if (!sections) {
    return defaultSectionOrder;
  }

  const requestedOrder = message.structuredOutput?.sectionOrder?.length
    ? message.structuredOutput.sectionOrder
    : defaultSectionOrder;
  const presentKeys = new Set(defaultSectionOrder.filter((key) => Boolean(sections[key])));
  const orderedKeys = requestedOrder.filter((key) => presentKeys.has(key));
  const remainingKeys = defaultSectionOrder.filter((key) => presentKeys.has(key) && !orderedKeys.includes(key));
  return [...orderedKeys, ...remainingKeys];
}

export function condensedSourceLabels(sources: NonNullable<ChatMessage["sources"]>) {
  const groupedSources = new Map<string, { pages: Set<number>; source: MessageSource }>();

  for (const source of sources) {
    const key = [
      source.title,
      source.materialType,
      source.problemNumber ?? "",
      source.printedPageStart ?? source.printedPageNumber ?? "",
      source.pageStart ?? ""
    ].join("|");
    const existing = groupedSources.get(key) ?? { pages: new Set<number>(), source };

    const groupingPage = source.printedPageStart ?? source.printedPageNumber ?? source.pageNumber;
    if (groupingPage) {
      existing.pages.add(groupingPage);
    }

    groupedSources.set(key, existing);
  }

  const labels = Array.from(groupedSources.values()).map(
    ({ pages, source }) =>
      formatSourceLabel({
        ...source,
        pageEnd: undefined,
        pageNumber: undefined,
        pageStart: undefined,
        printedPageEnd: undefined,
        printedPageNumber: undefined,
        printedPageStart: undefined
      }) + formatPageRange(Array.from(pages), source)
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

  if (kind === "rule") {
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
    return `$$\n${stripOuterMathDelimiters(splitFormula.formula)}\n$$`;
  }

  return formulas.map((formula) => `$$\n${stripOuterMathDelimiters(formula)}\n$$`).join("\n\n");
}

function stripOuterMathDelimiters(content: string) {
  const trimmed = content.trim();
  const inlineDelimited = trimmed.match(/^\$(?!\$)([\s\S]*?)(?<!\$)\$$/);

  if (inlineDelimited) {
    return inlineDelimited[1].trim();
  }

  const parenDelimited = trimmed.match(/^\\\(([\s\S]*?)\\\)$/);

  if (parenDelimited) {
    return parenDelimited[1].trim();
  }

  return trimmed;
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
    .replace(/([A-Za-z])__([A-Za-z0-9{])/g, "$1_$2")
    .replace(/\r\n/g, "\n")
    .replace(/^\*\*(PROBLEM|EXERCISE|QUESTION|THEOREM|DEFINITION|EXAMPLE)\*\*\s+/i, "$1\n\n")
    .replace(/^(PROBLEM|EXERCISE|QUESTION|THEOREM|DEFINITION|EXAMPLE)\s+(?=\d|[A-Z]|\$|\\\()/i, "$1\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  formatted = repairMissingBmatrixMarkdown(formatted);

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

function repairMissingBmatrixMarkdown(content: string) {
  let repaired = content;
  let searchStart = 0;
  const endToken = "\\end{bmatrix}";

  while (searchStart < repaired.length) {
    const endIndex = repaired.indexOf(endToken, searchStart);

    if (endIndex === -1) {
      break;
    }

    const previousBeginIndex = repaired.lastIndexOf("\\begin{bmatrix}", endIndex);
    const previousEndIndex = repaired.lastIndexOf(endToken, endIndex - 1);

    if (previousBeginIndex > previousEndIndex) {
      searchStart = endIndex + endToken.length;
      continue;
    }

    const ampersandIndex = repaired.lastIndexOf("&", endIndex);

    if (ampersandIndex === -1) {
      searchStart = endIndex + endToken.length;
      continue;
    }

    const definedIndex = repaired.lastIndexOf("defined to be", ampersandIndex);
    const lineStartIndex = Math.max(repaired.lastIndexOf("\n", ampersandIndex), repaired.lastIndexOf(".", ampersandIndex));
    const matrixStart = definedIndex !== -1
      ? definedIndex + "defined to be".length
      : lineStartIndex === -1
        ? 0
        : lineStartIndex + 1;
    const matrixBody = repaired
      .slice(matrixStart, endIndex)
      .replace(/\$\$/g, "")
      .replace(/\\begin\{bmatrix\}/g, "")
      .trim();
    const endMatch = repaired.slice(endIndex + endToken.length).match(/^\s*,?\s*\$\$/);
    const afterEndIndex = endIndex + endToken.length + (endMatch?.[0].length ?? 0);
    const prefix = repaired.slice(0, matrixStart).replace(/[ \t]+$/g, "");
    const suffix = repaired.slice(afterEndIndex);
    const matrix = `\n\n$$\n\\begin{bmatrix}\n${matrixBody}\n\\end{bmatrix}\n$$`;

    repaired = `${prefix}${matrix}${suffix}`;
    searchStart = prefix.length + matrix.length;
  }

  return repaired;
}

export function normalizeMarkdownMath(content: string) {
  return content
    .replace(/\\\[/g, "$$")
    .replace(/\\\]/g, "$$")
    .replace(/\\\(/g, "$")
    .replace(/\\\)/g, "$")
    .replace(/^\[\s*(\\(?:int|frac|sqrt|sum|lim|prod)[\s\S]*?)\s*\]$/gm, "$$$$\n$1\n$$$$");
}

function formatSourceLabel(source: MessageSource) {
  return [
    source.title,
    source.problemNumber ? `problem ${source.problemNumber}` : "",
    formatSourcePageLabel(source)
  ].filter(Boolean).join(" · ");
}

function formatSourcePageLabel(source: MessageSource) {
  const printedPage = source.printedPageStart ?? source.printedPageNumber;
  const printedEnd = source.printedPageEnd ?? printedPage;
  const pdfPage = source.pageStart ?? source.pageNumber;

  if (printedPage) {
    const printedLabel = printedPage === printedEnd ? `printed p. ${printedPage}` : `printed pp. ${printedPage}-${printedEnd}`;
    return pdfPage && pdfPage !== printedPage ? `${printedLabel} / PDF p. ${pdfPage}` : printedLabel;
  }

  return pdfPage ? `p. ${pdfPage}` : "";
}

function formatPageRange(pages: number[], source?: MessageSource) {
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

  const isPrinted = Boolean(source?.printedPageStart ?? source?.printedPageNumber);
  const prefix = ranges.length === 1 && !ranges[0].includes("-") ? "p." : "pp.";
  return ` · ${isPrinted ? "printed " : ""}${prefix} ${ranges.join(", ")}`;
}
