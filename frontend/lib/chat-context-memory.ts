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
    assistantMessages.flatMap((message) => [
      ...contextSourcesFromTutorSources(message),
      ...contextSourcesFromKnowledgeItems(message)
    ])
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
  const activeKnowledgeProblem = activeProblemKnowledgeItem(trace?.knowledgeItems);
  const activeProblemNumbers = trace?.activeProblemNumbers ?? stringArrayFromRecord(retrievalDecision.active_problem_numbers);
  const rawActiveProblemNumber =
    stringFromRecord(retrievalDecision.active_problem_id) ||
    stringFromRecord(primaryMetadata?.problem_number) ||
    stringFromRecord(primaryMetadata?.problemNumber) ||
    primarySource?.problemNumber ||
    activeKnowledgeProblem?.problemNumber ||
    activeProblemNumbers[0];
  const activePageNumber =
    numberFromRecord(trace?.activePage) ??
    numberFromRecord(retrievalDecision.active_page) ??
    primarySource?.pageNumber ??
    numberFromRecord(primaryMetadata?.page_start) ??
    numberFromRecord(primaryMetadata?.pageStart) ??
    numberFromRecord(primaryPage?.printedPageStart) ??
    numberFromRecord(primaryPage?.pageStart);
  const sourceName = primarySource?.title || stringFromRecord(primaryMetadata?.title) || primaryPage?.title || activeKnowledgeProblem?.sourceName;
  const pageOcrText = stringFromRecord(primaryMetadata?.ocr_text) || stringFromRecord(primaryMetadata?.ocrText);
  const structuredProblemText = normalizeContextProblemText(stringFromRecord(message.structuredOutput?.sections?.problem));
  const metadataProblemText =
    normalizeContextProblemText(stringFromRecord(primaryMetadata?.problem_text)) ||
    normalizeContextProblemText(stringFromRecord(primaryMetadata?.problemText));
  const knowledgeProblemText = normalizeContextProblemText(activeKnowledgeProblem?.problemText);
  const activeProblemNumber =
    rawActiveProblemNumber ||
    extractProblemNumberFromContextText(structuredProblemText) ||
    extractProblemNumberFromContextText(metadataProblemText) ||
    extractProblemNumberFromContextText(knowledgeProblemText);
  const problemText =
    structuredProblemText ||
    metadataProblemText ||
    knowledgeProblemText ||
    extractProblemTextFromPageOcr(pageOcrText, activeProblemNumber);
  const problem: NonNullable<ChatContextMemory["currentProblem"]> | undefined = activeProblemNumber || problemText
    ? {
        label: activeProblemNumber ? `Problem ${activeProblemNumber}` : sourceName,
        problemNumber: activeProblemNumber,
        sourceName,
        sourceType: activeKnowledgeProblem?.sourceType,
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
    sourceType: "class_material",
    pageNumber: source.printedPageStart ?? source.printedPageNumber ?? source.pageNumber,
    problemNumber: source.problemNumber,
    label: formatContextSource({
      sourceName: source.title,
      pageNumber: source.printedPageStart ?? source.printedPageNumber ?? source.pageNumber,
      problemNumber: source.problemNumber
    })
  }));
}

function contextSourcesFromKnowledgeItems(message: ChatMessage): NonNullable<ChatContextMemory["sourcesUsed"]> {
  return (message.langGraphTrace?.knowledgeItems ?? [])
    .filter((item) => item.kind === "pdf_page" || item.kind === "student_upload" || item.kind === "problem")
    .map((item) => ({
      id: item.sourceId || item.pdfId || item.id,
      sourceName: item.sourceName,
      sourceType: knowledgeItemContextSourceType(item),
      ...(knowledgeItemFileType(item) ? { fileType: knowledgeItemFileType(item) } : {}),
      pageNumber: item.page,
      problemNumber: item.usedAs === "problem_source" ? item.problemId : undefined,
      label: formatContextSource({
        sourceName: item.sourceName,
        sourceType: knowledgeItemContextSourceType(item),
        pageNumber: item.page,
        problemNumber: item.usedAs === "problem_source" ? item.problemId : undefined
      })
    }));
}

function knowledgeItemContextSourceType(item: NonNullable<NonNullable<ChatMessage["langGraphTrace"]>["knowledgeItems"]>[number]) {
  if (item.kind === "student_upload") {
    return "student_upload" as const;
  }

  if (item.kind === "problem" && item.usedAs === "active_problem" && item.sourceName === "Pasted problem") {
    return "pasted_problem" as const;
  }

  return "class_material" as const;
}

function knowledgeItemFileType(item: NonNullable<NonNullable<ChatMessage["langGraphTrace"]>["knowledgeItems"]>[number]) {
  if (item.fileType === "image" || item.fileType === "pdf") {
    return item.fileType;
  }

  const sourceText = [item.sourceName, item.summary].filter(Boolean).join(" ").toLowerCase();
  if (/\.(?:png|jpe?g|webp)(?:\b|$)/.test(sourceText) || /\bstudent uploaded image\b/.test(sourceText)) {
    return "image" as const;
  }
  if (/\.pdf(?:\b|$)/.test(sourceText)) {
    return "pdf" as const;
  }

  return undefined;
}

function activeProblemKnowledgeItem(items: NonNullable<ChatMessage["langGraphTrace"]>["knowledgeItems"] | undefined) {
  if (!Array.isArray(items)) {
    return undefined;
  }

  const item = items.find((knowledgeItem) => knowledgeItem.kind === "problem" && knowledgeItem.usedAs === "active_problem");
  if (!item) {
    return undefined;
  }

  return {
    problemNumber: extractProblemNumberFromContextText(item.content) || (looksLikeHumanProblemId(item.problemId) ? item.problemId : undefined),
    problemText: item.content,
    sourceName: item.sourceName || "Pasted problem",
    sourceType: item.sourceName === "Pasted problem" ? "pasted_problem" as const : "class_material" as const
  };
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
    sourceType: normalizeContextSourceType(value.sourceType),
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
        sourceType: normalizeContextSourceType(source.sourceType),
        fileType: normalizeContextFileType(source.fileType),
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
    const key = contextProblemDedupeKey(problem);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(problem);
  }

  return deduped.slice(0, 8);
}

function contextProblemDedupeKey(problem: NonNullable<ChatContextMemory["savedProblems"]>[number]) {
  const sourceName = normalizeComparableProblemIdentity(problem.sourceName);
  const problemNumber = normalizeComparableProblemIdentity(problem.problemNumber);
  const pageNumber = problem.pageNumber ?? "";
  const label = normalizeComparableProblemIdentity(problem.label);
  const text = normalizeComparableProblemText(problem.problemText);

  if (!sourceName && !pageNumber && !problemNumber && !label && !text) {
    return "";
  }

  if (sourceName && (problemNumber || pageNumber)) {
    return ["source-problem", sourceName, problemNumber, pageNumber].join("|");
  }

  if (problemNumber && text) {
    return ["number-text", problemNumber, text].join("|");
  }

  return ["fallback", sourceName, problemNumber, pageNumber, text || label].join("|");
}

function normalizeComparableProblemIdentity(value?: string) {
  return (value ?? "").replace(/\s+/g, " ").trim().toLowerCase();
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
    const sourceIdentity = [source.sourceType ?? "", source.sourceName?.toLowerCase() || source.id || ""].join(":");
    const pageOrProblem = source.pageNumber ?? (source.problemNumber ? `problem:${source.problemNumber.toLowerCase()}` : "");
    const key = [sourceIdentity, pageOrProblem].join("|");
    const existingIndex = deduped.findIndex((dedupedSource) => {
      const dedupedIdentity = [dedupedSource.sourceType ?? "", dedupedSource.sourceName?.toLowerCase() || dedupedSource.id || ""].join(":");
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
        sourceType: existing.sourceType || source.sourceType,
        fileType: existing.fileType || source.fileType,
        pageNumber: existing.pageNumber ?? source.pageNumber,
        problemNumber: existing.problemNumber || source.problemNumber,
        label: formatContextSource({
          sourceName: existing.sourceName || source.sourceName,
          sourceType: existing.sourceType || source.sourceType,
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
  if (source.sourceType === "student_upload") {
    return source.sourceName || "Student upload";
  }

  if (source.sourceType === "pasted_problem") {
    return "Pasted problem";
  }

  return [
    formatPageNumber(source.pageNumber),
    source.problemNumber ? `Problem ${source.problemNumber}` : undefined
  ]
    .filter(Boolean)
    .join(" · ") || source.sourceName || "Class material";
}

function looksLikeHumanProblemId(value?: string) {
  return Boolean(value && /^(?:\d{1,3}(?:\.\d{1,3})?[a-z]?|[A-Z]\d{1,3})$/i.test(value));
}

function normalizeContextSourceType(value: unknown): NonNullable<NonNullable<ChatContextMemory["sourcesUsed"]>[number]["sourceType"]> | undefined {
  return value === "class_material" || value === "pasted_problem" || value === "student_upload" ? value : undefined;
}

function normalizeContextFileType(value: unknown): "image" | "pdf" | undefined {
  return value === "image" || value === "pdf" ? value : undefined;
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
