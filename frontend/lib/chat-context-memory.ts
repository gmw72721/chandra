import type { ChatContextMemory, ChatMessage } from "./types";

export function buildChatContextMemory(messages: ChatMessage[]): ChatContextMemory {
  const assistantMessages = [...messages].reverse().filter((message) => message.role === "assistant");
  const latestStructuredMessage = assistantMessages.find(
    (message) =>
      message.sources?.length ||
      message.langGraphTrace?.knowledgeItems?.length ||
      message.langGraphTrace?.selectedPages?.length ||
      message.langGraphTrace?.selectedMetadataRecords?.length
  );

  if (!latestStructuredMessage) {
    return {};
  }

  const trace = latestStructuredMessage.langGraphTrace;
  const retrievalDecision = isRecord(trace?.retrievalDecision) ? trace.retrievalDecision : {};
  const metadataRecords = trace?.selectedMetadataRecords?.filter(isRecord) ?? [];
  const primaryMetadata = metadataRecords[0];
  const primarySource = latestStructuredMessage.sources?.[0];
  const primaryPage = trace?.selectedPages?.[0];
  const latestContext = contextProblemFromMessage(latestStructuredMessage);
  const activeProblemNumber = latestContext.activeProblemNumber;
  const activePageNumber = latestContext.activePageNumber;
  const activePdfId =
    stringFromRecord(trace?.activeMaterialId) ||
    stringFromRecord(retrievalDecision.active_material_id) ||
    stringFromRecord(primaryMetadata?.doc_id) ||
    stringFromRecord(primaryMetadata?.material_id) ||
    primaryPage?.docId;
  const activePdfName = primarySource?.title || stringFromRecord(primaryMetadata?.title) || primaryPage?.title;
  const currentProblem = latestContext.problem;
  const savedProblems = dedupeContextProblems(
    assistantMessages
      .map((message) => contextProblemFromMessage(message).problem)
      .filter((problem): problem is NonNullable<ChatContextMemory["currentProblem"]> => Boolean(problem))
  );
  const sourcesUsed = dedupeContextSources(
    [
      ...contextSourcesFromTutorSources(latestStructuredMessage),
      ...contextSourcesFromKnowledgeItems(latestStructuredMessage)
    ]
  );
  const failedSearches = [
    ...(trace?.failedSearchesSkipped ?? []).map((query) => ({
      query,
      reason: "Previous search failed"
    }))
  ];
  const rawSourceIds = Array.from(
    new Set(
      [
        activePdfId,
        ...sourcesUsed.map((source) => source.id),
        ...metadataRecords.map((record) => stringFromRecord(record.doc_id) || stringFromRecord(record.material_id))
      ].filter((value): value is string => Boolean(value))
    )
  );

  return compactContextMemory({
    activePdfId,
    activePdfName,
    activeProblemId: activeProblemNumber,
    activePageNumber,
    currentProblem,
    failedSearches,
    rawSourceIds,
    retrievalReason:
      trace?.retrievalReason ||
      stringFromRecord(retrievalDecision.retrieval_reason) ||
      stringFromRecord(primaryMetadata?.retrievalReason),
    savedProblems,
    sourcesUsed
  });
}

export function hasChatContextMemory(contextMemory: ChatContextMemory | null | undefined) {
  return Boolean(
    contextMemory?.activePdfId ||
      contextMemory?.activePdfName ||
      contextMemory?.activeProblemId ||
      contextMemory?.activePageNumber ||
      contextMemory?.currentProblem ||
      contextMemory?.savedProblems?.length ||
      contextMemory?.sourcesUsed?.length ||
      contextMemory?.failedSearches?.length ||
      contextMemory?.retrievalReason
  );
}

export function normalizeChatContextMemory(value: unknown): ChatContextMemory {
  if (!isRecord(value)) {
    return {};
  }

  return compactContextMemory({
    activePdfId: stringFromRecord(value.activePdfId),
    activePdfName: stringFromRecord(value.activePdfName),
    activeProblemId: stringFromRecord(value.activeProblemId),
    activePageNumber: numberFromRecord(value.activePageNumber),
    currentProblem: normalizeContextProblem(value.currentProblem),
    failedSearches: normalizeFailedSearches(value.failedSearches),
    rawSourceIds: stringArrayFromRecord(value.rawSourceIds),
    retrievalReason: stringFromRecord(value.retrievalReason),
    savedProblems: Array.isArray(value.savedProblems)
      ? value.savedProblems
          .map(normalizeContextProblem)
          .filter((problem): problem is NonNullable<ChatContextMemory["currentProblem"]> => Boolean(problem))
      : undefined,
    sourcesUsed: normalizeContextSources(value.sourcesUsed)
  });
}

function contextProblemFromMessage(message: ChatMessage) {
  const trace = message.langGraphTrace;
  const retrievalDecision = isRecord(trace?.retrievalDecision) ? trace.retrievalDecision : {};
  const metadataRecords = trace?.selectedMetadataRecords?.filter(isRecord) ?? [];
  const primaryMetadata = metadataRecords[0];
  const primarySource = message.sources?.[0];
  const primaryPage = trace?.selectedPages?.[0];
  const activeProblemNumbers = trace?.activeProblemNumbers ?? stringArrayFromRecord(retrievalDecision.active_problem_numbers);
  const rawActiveProblemNumber =
    stringFromRecord(retrievalDecision.active_problem_id) ||
    stringFromRecord(primaryMetadata?.problem_number) ||
    stringFromRecord(primaryMetadata?.problemNumber) ||
    primarySource?.problemNumber ||
    activeProblemNumbers[0];
  const activePageNumber =
    numberFromRecord(trace?.activePage) ??
    numberFromRecord(retrievalDecision.active_page) ??
    primarySource?.pageNumber ??
    numberFromRecord(primaryMetadata?.page_start) ??
    numberFromRecord(primaryMetadata?.pageStart) ??
    numberFromRecord(primaryPage?.printedPageStart) ??
    numberFromRecord(primaryPage?.pageStart);
  const sourceName = primarySource?.title || stringFromRecord(primaryMetadata?.title) || primaryPage?.title;
  const pageOcrText = stringFromRecord(primaryMetadata?.ocr_text) || stringFromRecord(primaryMetadata?.ocrText);
  const structuredProblemText = normalizeContextProblemText(stringFromRecord(message.structuredOutput?.sections?.problem));
  const metadataProblemText =
    normalizeContextProblemText(stringFromRecord(primaryMetadata?.problem_text)) ||
    normalizeContextProblemText(stringFromRecord(primaryMetadata?.problemText));
  const activeProblemNumber =
    rawActiveProblemNumber ||
    extractProblemNumberFromContextText(structuredProblemText) ||
    extractProblemNumberFromContextText(metadataProblemText);
  const problemText =
    structuredProblemText ||
    metadataProblemText ||
    extractProblemTextFromPageOcr(pageOcrText, activeProblemNumber);
  const problem: NonNullable<ChatContextMemory["currentProblem"]> | undefined = activeProblemNumber || problemText
    ? {
        label: activeProblemNumber ? `Problem ${activeProblemNumber}` : sourceName,
        problemNumber: activeProblemNumber,
        sourceName,
        pageNumber: activePageNumber,
        sectionTitle:
          stringFromRecord(primaryMetadata?.section_title) ||
          stringFromRecord(primaryMetadata?.sectionHeading) ||
          stringFromRecord(primaryMetadata?.section),
        ocrConfidence: numberFromRecord(primaryMetadata?.ocr_confidence),
        problemText
      }
    : undefined;

  return {
    activePageNumber,
    activeProblemNumber,
    problem
  };
}

function contextSourcesFromTutorSources(message: ChatMessage): NonNullable<ChatContextMemory["sourcesUsed"]> {
  return (message.sources ?? []).map((source) => ({
    id: source.id,
    sourceName: source.title,
    pageNumber: source.pageNumber,
    problemNumber: source.problemNumber,
    label: formatContextSource({
      sourceName: source.title,
      pageNumber: source.pageNumber,
      problemNumber: source.problemNumber
    })
  }));
}

function contextSourcesFromKnowledgeItems(message: ChatMessage): NonNullable<ChatContextMemory["sourcesUsed"]> {
  return (message.langGraphTrace?.knowledgeItems ?? [])
    .filter((item) => item.kind === "pdf_page")
    .map((item) => ({
      id: item.sourceId || item.pdfId || item.id,
      sourceName: item.sourceName,
      pageNumber: item.page,
      problemNumber: item.usedAs === "problem_source" ? item.problemId : undefined,
      label: formatContextSource({
        sourceName: item.sourceName,
        pageNumber: item.page,
        problemNumber: item.usedAs === "problem_source" ? item.problemId : undefined
      })
    }));
}

function compactContextMemory(contextMemory: ChatContextMemory): ChatContextMemory {
  const compacted: ChatContextMemory = {};

  if (contextMemory.activePdfId) {
    compacted.activePdfId = contextMemory.activePdfId;
  }
  if (contextMemory.activePdfName) {
    compacted.activePdfName = contextMemory.activePdfName;
  }
  if (contextMemory.activeProblemId) {
    compacted.activeProblemId = contextMemory.activeProblemId;
  }
  if (contextMemory.activePageNumber) {
    compacted.activePageNumber = contextMemory.activePageNumber;
  }
  if (contextMemory.currentProblem) {
    compacted.currentProblem = contextMemory.currentProblem;
  }
  if (contextMemory.savedProblems?.length) {
    compacted.savedProblems = dedupeContextProblems(contextMemory.savedProblems);
  }
  if (contextMemory.sourcesUsed?.length) {
    compacted.sourcesUsed = dedupeContextSources(contextMemory.sourcesUsed);
  }
  if (contextMemory.failedSearches?.length) {
    compacted.failedSearches = contextMemory.failedSearches.slice(0, 8);
  }
  if (contextMemory.retrievalReason) {
    compacted.retrievalReason = contextMemory.retrievalReason;
  }
  if (contextMemory.rawSourceIds?.length) {
    compacted.rawSourceIds = Array.from(new Set(contextMemory.rawSourceIds.filter(Boolean))).slice(0, 12);
  }

  return compacted;
}

function normalizeContextProblem(value: unknown): NonNullable<ChatContextMemory["currentProblem"]> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const problem = {
    label: stringFromRecord(value.label),
    problemNumber: stringFromRecord(value.problemNumber),
    title: stringFromRecord(value.title),
    sourceName: stringFromRecord(value.sourceName),
    pageNumber: numberFromRecord(value.pageNumber),
    sectionTitle: stringFromRecord(value.sectionTitle),
    ocrConfidence: numberFromRecord(value.ocrConfidence),
    problemText: normalizeContextProblemText(stringFromRecord(value.problemText))
  };

  return Object.values(problem).some(Boolean) ? problem : undefined;
}

function normalizeContextSources(value: unknown): NonNullable<ChatContextMemory["sourcesUsed"]> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return dedupeContextSources(
    value
      .filter(isRecord)
      .map((source) => ({
        id: stringFromRecord(source.id),
        sourceName: stringFromRecord(source.sourceName),
        pageNumber: numberFromRecord(source.pageNumber),
        problemNumber: stringFromRecord(source.problemNumber),
        label: stringFromRecord(source.label)
      }))
  );
}

function normalizeFailedSearches(value: unknown): ChatContextMemory["failedSearches"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .filter(isRecord)
    .map((search) => ({
      query: stringFromRecord(search.query) ?? "",
      reason: stringFromRecord(search.reason),
      timestamp: stringFromRecord(search.timestamp)
    }))
    .filter((search) => search.query)
    .slice(0, 8);
}

function normalizeContextProblemText(value?: string) {
  return (value ?? "")
    .replace(/^\s*problem\s*:\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function extractProblemNumberFromContextText(text?: string) {
  const normalizedText = (text ?? "").replace(/\s+/g, " ").trim();
  const numberMatch = normalizedText.match(
    /(?:^|\b)(?:Problem|Exercise|Question)?\s*(\d+(?:\.\d+)+(?:[a-z])?)\s*(?:\.\s*)?\*?(?=\s|\.|:|$)/i
  );

  return numberMatch?.[1];
}

function extractProblemTextFromPageOcr(text: string | undefined, problemNumber?: string) {
  const normalizedText = (text ?? "").replace(/\r\n?/g, "\n").trim();

  if (!normalizedText || !problemNumber) {
    return "";
  }

  const escapedProblemNumber = escapeRegExp(problemNumber);
  const startPattern = new RegExp(
    `(?:^|\\n|\\s)((?:Problem|Exercise|Question)?\\s*${escapedProblemNumber}\\s*(?:\\.\\s*)?\\*?\\s*[\\s\\S]*)`,
    "i"
  );
  const startMatch = normalizedText.match(startPattern);
  const afterStart = startMatch?.[1]?.trim() ?? "";

  if (!afterStart) {
    return "";
  }

  const nextProblemPattern = /\n\s*(?=(?:Problem|Exercise|Question)?\s*\d+(?:\.\d+)+\s*(?:\.\s*)?\*?\s+[A-Z])/i;
  const [problemText] = afterStart.split(nextProblemPattern);

  return normalizeContextProblemText(problemText).slice(0, 1200);
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function dedupeContextProblems(problems: NonNullable<ChatContextMemory["savedProblems"]>) {
  const seen = new Set<string>();
  const deduped: NonNullable<ChatContextMemory["savedProblems"]> = [];

  for (const problem of problems) {
    const normalizedProblemText = normalizeComparableProblemText(problem.problemText);
    const key = [
      problem.sourceName?.toLowerCase() ?? "",
      problem.problemNumber?.toLowerCase() ?? "",
      problem.pageNumber ?? "",
      normalizedProblemText || problem.label?.toLowerCase() || ""
    ].join("|");

    if (seen.has(key) || (!problem.sourceName && !problem.pageNumber && !problem.problemNumber && !problem.label)) {
      continue;
    }

    seen.add(key);
    deduped.push(problem);
  }

  return deduped.slice(0, 8);
}

function normalizeComparableProblemText(text?: string) {
  return (text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .slice(0, 240);
}

function dedupeContextSources(sources: NonNullable<ChatContextMemory["sourcesUsed"]>) {
  const deduped: NonNullable<ChatContextMemory["sourcesUsed"]> = [];

  for (const source of sources) {
    const sourceIdentity = source.sourceName?.toLowerCase() || source.id || "";
    const pageOrProblem = source.pageNumber ?? (source.problemNumber ? `problem:${source.problemNumber.toLowerCase()}` : "");
    const key = [sourceIdentity, pageOrProblem].join("|");
    const existingIndex = deduped.findIndex((dedupedSource) => {
      const dedupedIdentity = dedupedSource.sourceName?.toLowerCase() || dedupedSource.id || "";
      const dedupedPageOrProblem =
        dedupedSource.pageNumber ??
        (dedupedSource.problemNumber ? `problem:${dedupedSource.problemNumber.toLowerCase()}` : "");

      return [dedupedIdentity, dedupedPageOrProblem].join("|") === key;
    });

    if (!source.sourceName && !source.pageNumber && !source.problemNumber) {
      continue;
    }

    if (existingIndex >= 0) {
      const existing = deduped[existingIndex];
      deduped[existingIndex] = {
        id: existing.id || source.id,
        sourceName: existing.sourceName || source.sourceName,
        pageNumber: existing.pageNumber ?? source.pageNumber,
        problemNumber: existing.problemNumber || source.problemNumber,
        label: formatContextSource({
          sourceName: existing.sourceName || source.sourceName,
          pageNumber: existing.pageNumber ?? source.pageNumber,
          problemNumber: existing.problemNumber || source.problemNumber
        })
      };
      continue;
    }

    deduped.push(source);
  }

  return deduped.slice(0, 6);
}

function formatContextSource(source: NonNullable<ChatContextMemory["sourcesUsed"]>[number]) {
  return [
    source.sourceName,
    formatPageNumber(source.pageNumber),
    source.problemNumber ? `Problem ${source.problemNumber}` : undefined
  ]
    .filter(Boolean)
    .join(" · ");
}

function formatPageNumber(pageNumber?: number) {
  return typeof pageNumber === "number" && Number.isFinite(pageNumber) && pageNumber > 0 ? `p. ${pageNumber}` : undefined;
}

function stringFromRecord(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFromRecord(value: unknown) {
  const numberValue = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : undefined;
}

function stringArrayFromRecord(value: unknown) {
  return Array.isArray(value) ? value.map(stringFromRecord).filter((item): item is string => Boolean(item)) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
