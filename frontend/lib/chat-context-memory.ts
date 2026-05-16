import type { ChatContextMemory, ChatMessage } from "./types";

export function buildChatContextMemory(messages: ChatMessage[]): ChatContextMemory {
  const assistantMessages = [...messages].reverse().filter((message) => message.role === "assistant");
  const latestStructuredMessage = assistantMessages.find(
    (message) =>
      message.sources?.length ||
      message.langGraphTrace?.knowledgeItems?.length ||
      message.langGraphTrace?.readySupportBundle ||
      message.langGraphTrace?.searchQueries?.length ||
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
  const primarySource = primaryProblemSource(latestStructuredMessage) ?? latestStructuredMessage.sources?.[0];
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
  const unconfirmedSources = unconfirmedContextSources(
    dedupeContextSources(assistantMessages.flatMap(contextSourcesFromReadySupportBundle)),
    sourcesUsed
  );
  const failedSearches = [
    ...(trace?.failedSearchesSkipped ?? []).map((query) => ({
      query,
      reason: "Previous search failed"
    }))
  ];
  const searchResults = dedupeSearchResults(assistantMessages.flatMap(contextSearchResultsFromMessage));
  const rawSourceIds = Array.from(
    new Set(
      [
        activePdfId,
        ...sourcesUsed.map((source) => source.id),
        ...unconfirmedSources.map((source) => source.id),
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
    searchResults,
    sourcesUsed,
    unconfirmedSources
  });
}

export function mergeChatContextMemory(
  primary: ChatContextMemory | null | undefined,
  secondary: ChatContextMemory | null | undefined
): ChatContextMemory {
  const primaryContext = primary ?? {};
  const secondaryContext = secondary ?? {};
  const sourcesUsed = dedupeContextSources([
    ...(primaryContext.sourcesUsed ?? []),
    ...(secondaryContext.sourcesUsed ?? [])
  ]);
  const unconfirmedSources = unconfirmedContextSources(
    dedupeContextSources([...(primaryContext.unconfirmedSources ?? []), ...(secondaryContext.unconfirmedSources ?? [])]),
    sourcesUsed
  );
  const rawSourceIds = Array.from(
    new Set([...(primaryContext.rawSourceIds ?? []), ...(secondaryContext.rawSourceIds ?? [])].filter(Boolean))
  );
  const savedProblems = dedupeContextProblems([
    ...(primaryContext.savedProblems ?? []),
    ...(secondaryContext.savedProblems ?? []),
    ...(primaryContext.currentProblem ? [primaryContext.currentProblem] : []),
    ...(secondaryContext.currentProblem ? [secondaryContext.currentProblem] : [])
  ]);

  return compactContextMemory({
    activePdfId: primaryContext.activePdfId || secondaryContext.activePdfId,
    activePdfName: primaryContext.activePdfName || secondaryContext.activePdfName,
    activeProblemId: primaryContext.activeProblemId || secondaryContext.activeProblemId,
    activePageNumber: primaryContext.activePageNumber ?? secondaryContext.activePageNumber,
    currentProblem: primaryContext.currentProblem ?? secondaryContext.currentProblem,
    failedSearches: [
      ...(primaryContext.failedSearches ?? []),
      ...(secondaryContext.failedSearches ?? [])
    ],
    rawSourceIds,
    retrievalReason: primaryContext.retrievalReason || secondaryContext.retrievalReason,
    savedProblems,
    searchResults: dedupeSearchResults([...(primaryContext.searchResults ?? []), ...(secondaryContext.searchResults ?? [])]),
    sourcesUsed,
    unconfirmedSources
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
      contextMemory?.unconfirmedSources?.length ||
      contextMemory?.searchResults?.length ||
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
    searchResults: normalizeSearchResults(value.searchResults),
    sourcesUsed: normalizeContextSources(value.sourcesUsed),
    unconfirmedSources: normalizeContextSources(value.unconfirmedSources)
  });
}

function contextProblemFromMessage(message: ChatMessage) {
  const trace = message.langGraphTrace;
  const retrievalDecision = isRecord(trace?.retrievalDecision) ? trace.retrievalDecision : {};
  const metadataRecords = trace?.selectedMetadataRecords?.filter(isRecord) ?? [];
  const primaryMetadata = metadataRecords[0];
  const primarySource = primaryProblemSource(message) ?? message.sources?.[0];
  const primaryPage = trace?.selectedPages?.[0];
  const activeKnowledgeProblem = activeProblemKnowledgeItem(trace?.knowledgeItems);
  const activeProblemNumbers = trace?.activeProblemNumbers ?? stringArrayFromRecord(retrievalDecision.active_problem_numbers);
  const structuredProblemText = normalizeContextProblemText(stringFromRecord(message.structuredOutput?.sections?.problem));
  const structuredProblemNumber = extractLeadingProblemNumberFromContextText(structuredProblemText);
  const rawActiveProblemNumber =
    structuredProblemNumber ||
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
  const metadataProblemText =
    normalizeContextProblemText(stringFromRecord(primaryMetadata?.problem_text)) ||
    normalizeContextProblemText(stringFromRecord(primaryMetadata?.problemText));
  const knowledgeProblemText = normalizeContextProblemText(activeKnowledgeProblem?.problemText);
  const activeProblemNumber =
    rawActiveProblemNumber ||
    extractLeadingProblemNumberFromContextText(structuredProblemText) ||
    extractLeadingProblemNumberFromContextText(metadataProblemText) ||
    extractLeadingProblemNumberFromContextText(knowledgeProblemText);
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
    ...(source.sourceItemLabel ? { sourceItemLabel: source.sourceItemLabel } : {}),
    problemNumber: source.problemNumber,
    label: formatContextSource({
      sourceName: source.title,
      pageNumber: source.printedPageStart ?? source.printedPageNumber ?? source.pageNumber,
      sourceItemLabel: source.sourceItemLabel,
      problemNumber: source.problemNumber
    })
  }));
}

function primaryProblemSource(message: ChatMessage) {
  return (
    message.sources?.find((source) => source.usedAs === "problem_source") ??
    message.sources?.find((source) => source.problemNumber && source.usedAs !== "supporting_context")
  );
}

function contextSourcesFromKnowledgeItems(message: ChatMessage): NonNullable<ChatContextMemory["sourcesUsed"]> {
  return (message.langGraphTrace?.knowledgeItems ?? [])
    .filter((item) => item.kind === "pdf_page" || item.kind === "student_upload" || isStudentProvidedProblemSource(item))
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

function contextSourcesFromReadySupportBundle(message: ChatMessage): NonNullable<ChatContextMemory["sourcesUsed"]> {
  const bundle = message.langGraphTrace?.readySupportBundle;
  if (!isRecord(bundle) || !Array.isArray(bundle.pages)) {
    return [];
  }

  return bundle.pages
    .filter(isRecord)
    .map((page, index) => {
      const problemNumbers = Array.isArray(page.problem_numbers)
        ? page.problem_numbers.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
        : [];
      const pageNumber = numberFromRecord(page.printed_page_start) ?? numberFromRecord(page.page_start);
      const sourceName = stringFromRecord(page.title);
      const problemNumber = problemNumbers[0];

      return {
        id: [
          stringFromRecord(bundle.active_problem_id),
          sourceName,
          pageNumber ? `p${pageNumber}` : "",
          problemNumber ? `problem${problemNumber}` : "",
          index
        ]
          .filter(Boolean)
          .join(":"),
        sourceName,
        sourceType: "class_material" as const,
        pageNumber,
        problemNumber,
        ...(readableSupportType(stringFromRecord(page.retrieval_reason))
          ? { supportType: readableSupportType(stringFromRecord(page.retrieval_reason)) }
          : {}),
        label: formatContextSource({
          sourceName,
          sourceType: "class_material" as const,
          pageNumber,
          problemNumber
        })
      };
    });
}

function contextSearchResultsFromMessage(message: ChatMessage): NonNullable<ChatContextMemory["searchResults"]> {
  const trace = message.langGraphTrace;
  if (!trace) {
    return [];
  }

  const results = new Map<string, NonNullable<ChatContextMemory["searchResults"]>[number]>();
  const addPage = (query: string, page: NonNullable<ChatContextMemory["searchResults"]>[number]["pages"][number], retrievalReason?: string) => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return;
    }

    const key = normalizeQueryKey(trimmedQuery);
    const existing = results.get(key);
    const nextPage = compactSearchResultPage(page);
    const nextPages = dedupeSearchResultPages([...(existing?.pages ?? []), nextPage]);
    results.set(key, {
      query: existing?.query || trimmedQuery,
      retrievalReason: existing?.retrievalReason || retrievalReason,
      resultCount: Math.max(existing?.resultCount ?? 0, nextPages.length),
      pages: nextPages
    });
  };

  const fallbackQuery = trace.searchQueries?.length === 1 ? trace.searchQueries[0] : "";
  for (const page of trace.selectedPages ?? []) {
    const query = stringFromRecord(page.searchQuery) || fallbackQuery;
    addPage(
      query,
      {
        citationLabel: page.citationLabel,
        materialType: page.materialType,
        pageEnd: page.printedPageEnd ?? page.pageEnd,
        pageNumber: page.printedPageStart ?? page.pageStart,
        problemNumbers: page.problemNumbers,
        sourceName: page.title
      },
      page.retrievalReason
    );
  }

  for (const record of trace.selectedMetadataRecords?.filter(isRecord) ?? []) {
    const query = stringFromRecord(record.search_query) || stringFromRecord(record.searchQuery) || fallbackQuery;
    addPage(
      query,
      {
        materialType: stringFromRecord(record.material_type) || stringFromRecord(record.materialType),
        pageEnd: numberFromRecord(record.printed_page_end) ?? numberFromRecord(record.page_end),
        pageNumber: numberFromRecord(record.printed_page_start) ?? numberFromRecord(record.page_start),
        problemNumbers: stringArrayFromRecord(record.problem_numbers) ?? stringArrayFromRecord(record.problemNumbers),
        sourceName: stringFromRecord(record.title)
      },
      stringFromRecord(record.retrieval_reason) || stringFromRecord(record.retrievalReason)
    );
  }

  for (const query of trace.searchQueries ?? []) {
    const key = normalizeQueryKey(query);
    if (!key || results.has(key)) {
      continue;
    }
    results.set(key, {
      query,
      resultCount: 0,
      pages: []
    });
  }

  for (const result of contextSearchResultsFromReadySupportBundle(trace.readySupportBundle)) {
    const key = normalizeQueryKey(result.query);
    const existing = results.get(key);
    results.set(key, {
      ...result,
      pages: dedupeSearchResultPages([...(existing?.pages ?? []), ...result.pages]),
      resultCount: Math.max(existing?.resultCount ?? 0, result.resultCount ?? result.pages.length)
    });
  }

  applyBackgroundSupportSearchLabels(results, backgroundSupportSearchResultsFromMessage(message), message);

  return Array.from(results.values()).slice(0, 8);
}

function applyBackgroundSupportSearchLabels(
  results: Map<string, NonNullable<ChatContextMemory["searchResults"]>[number]>,
  supportResults: NonNullable<ChatContextMemory["searchResults"]>,
  message: ChatMessage
) {
  if (!supportResults.length) {
    return;
  }

  const activeProblemNumber = contextProblemFromMessage(message).activeProblemNumber;
  if (supportResults.length === 1 && activeProblemNumber && results.size === 1) {
    const [existingKey, existing] = Array.from(results.entries())[0] ?? [];
    const activeProblemKey = normalizeQueryKey(`Problem ${activeProblemNumber}`);
    const supportKey = normalizeQueryKey(supportResults[0].query);

    if (existingKey && activeProblemKey && existingKey.includes(activeProblemKey) && supportKey && supportKey !== existingKey) {
      results.delete(existingKey);
      results.set(supportKey, {
        ...existing,
        query: supportResults[0].query,
        retrievalReason: supportResults[0].retrievalReason || existing.retrievalReason
      });
      return;
    }
  }

  for (const result of supportResults) {
    const key = normalizeQueryKey(result.query);
    if (!key || results.has(key)) {
      continue;
    }
    results.set(key, result);
  }
}

function backgroundSupportSearchResultsFromMessage(message: ChatMessage): NonNullable<ChatContextMemory["searchResults"]> {
  const trace = message.langGraphTrace;
  const retrievalDecision = isRecord(trace?.retrievalDecision) ? trace.retrievalDecision : {};
  const responsePayload = parseJsonObjectFromText(trace?.contextGroundedResponse);
  const searches = [
    ...searchResultRecordsFromValue(retrievalDecision.background_support_searches),
    ...searchResultRecordsFromValue(responsePayload?.background_support_searches),
    ...searchResultRecordsFromValue(responsePayload?.backgroundSupportSearches)
  ];

  return searches.flatMap((search) => {
    const query = stringFromRecord(search.query) || stringFromRecord(search.search_query);
    if (!query) {
      return [];
    }

    return [{
      query,
      retrievalReason: stringFromRecord(search.retrieval_reason) || stringFromRecord(search.retrievalReason),
      resultCount: 0,
      pages: []
    }];
  });
}

function contextSearchResultsFromReadySupportBundle(value: unknown): NonNullable<ChatContextMemory["searchResults"]> {
  if (!isRecord(value) || !Array.isArray(value.queries)) {
    return [];
  }

  const pages = Array.isArray(value.pages) ? value.pages.filter(isRecord) : [];
  return value.queries
    .filter(isRecord)
    .flatMap((queryRecord) => {
      const query = stringFromRecord(queryRecord.query);
      if (!query) {
        return [];
      }

      const queryPages = pages.map((page) =>
        compactSearchResultPage({
          materialType: stringFromRecord(page.material_type) || stringFromRecord(page.materialType),
          pageEnd: numberFromRecord(page.printed_page_end) ?? numberFromRecord(page.page_end),
          pageNumber: numberFromRecord(page.printed_page_start) ?? numberFromRecord(page.page_start),
          problemNumbers: stringArrayFromRecord(page.problem_numbers).length
            ? stringArrayFromRecord(page.problem_numbers)
            : stringArrayFromRecord(page.problemNumbers),
          sourceName: stringFromRecord(page.title)
        })
      );

      return [{
        query,
        retrievalReason: stringFromRecord(queryRecord.retrieval_reason) || stringFromRecord(queryRecord.retrievalReason),
        resultCount: queryPages.length,
        pages: dedupeSearchResultPages(queryPages)
      }];
    });
}

function isStudentProvidedProblemSource(item: NonNullable<NonNullable<ChatMessage["langGraphTrace"]>["knowledgeItems"]>[number]) {
  return item.kind === "problem" && item.usedAs === "active_problem" && item.sourceName === "Pasted problem";
}

function knowledgeItemContextSourceType(item: NonNullable<NonNullable<ChatMessage["langGraphTrace"]>["knowledgeItems"]>[number]) {
  if (item.kind === "student_upload") {
    return "student_upload" as const;
  }

  if (isStudentProvidedProblemSource(item)) {
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
    problemNumber: extractLeadingProblemNumberFromContextText(item.content) || (looksLikeHumanProblemId(item.problemId) ? item.problemId : undefined),
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
  if (contextMemory.unconfirmedSources?.length) {
    compacted.unconfirmedSources = dedupeContextSources(contextMemory.unconfirmedSources);
  }
  if (contextMemory.failedSearches?.length) {
    compacted.failedSearches = contextMemory.failedSearches.slice(0, 8);
  }
  if (contextMemory.searchResults?.length) {
    compacted.searchResults = dedupeSearchResults(contextMemory.searchResults).slice(0, 8);
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
        label: stringFromRecord(source.label),
        ...(stringFromRecord(source.sourceItemLabel) ? { sourceItemLabel: stringFromRecord(source.sourceItemLabel) } : {}),
        ...(stringFromRecord(source.supportType) ? { supportType: stringFromRecord(source.supportType) } : {})
      }))
  );
}

function normalizeSearchResults(value: unknown): ChatContextMemory["searchResults"] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return dedupeSearchResults(
    value
      .filter(isRecord)
      .flatMap((result) => {
        const query = stringFromRecord(result.query);
        if (!query) {
          return [];
        }

        return [{
          query,
          retrievalReason: stringFromRecord(result.retrievalReason),
          resultCount: numberFromRecord(result.resultCount),
          pages: Array.isArray(result.pages)
            ? result.pages.filter(isRecord).map((page) =>
                compactSearchResultPage({
                  citationLabel: stringFromRecord(page.citationLabel),
                  materialType: stringFromRecord(page.materialType),
                  pageEnd: numberFromRecord(page.pageEnd),
                  pageNumber: numberFromRecord(page.pageNumber),
                  problemNumbers: stringArrayFromRecord(page.problemNumbers),
                  sourceName: stringFromRecord(page.sourceName)
                })
              )
            : []
        }];
      })
  );
}

function dedupeSearchResults(results: NonNullable<ChatContextMemory["searchResults"]>) {
  const byQuery = new Map<string, NonNullable<ChatContextMemory["searchResults"]>[number]>();
  for (const result of results) {
    const key = normalizeQueryKey(result.query);
    if (!key) {
      continue;
    }

    const existing = byQuery.get(key);
    const pages = dedupeSearchResultPages([...(existing?.pages ?? []), ...(result.pages ?? [])]);
    byQuery.set(key, {
      query: existing?.query || result.query,
      retrievalReason: existing?.retrievalReason || result.retrievalReason,
      resultCount: Math.max(existing?.resultCount ?? 0, result.resultCount ?? 0, pages.length),
      pages
    });
  }

  return Array.from(byQuery.values()).slice(0, 8);
}

function compactSearchResultPage(page: NonNullable<ChatContextMemory["searchResults"]>[number]["pages"][number]) {
  return {
    ...(page.citationLabel ? { citationLabel: page.citationLabel } : {}),
    ...(page.materialType ? { materialType: page.materialType } : {}),
    ...(page.pageEnd ? { pageEnd: page.pageEnd } : {}),
    ...(page.pageNumber ? { pageNumber: page.pageNumber } : {}),
    ...(page.problemNumbers?.length ? { problemNumbers: page.problemNumbers.filter(Boolean).slice(0, 4) } : {}),
    ...(page.sourceName ? { sourceName: page.sourceName } : {})
  };
}

function dedupeSearchResultPages(pages: NonNullable<ChatContextMemory["searchResults"]>[number]["pages"]) {
  const seen = new Set<string>();
  const deduped: NonNullable<ChatContextMemory["searchResults"]>[number]["pages"] = [];

  for (const page of pages) {
    const key = [
      page.sourceName ?? "",
      page.pageNumber ?? "",
      page.pageEnd ?? "",
      page.problemNumbers?.join(",") ?? "",
      page.citationLabel ?? ""
    ].join("|");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(page);
  }

  return deduped.slice(0, 6);
}

function normalizeQueryKey(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function searchResultRecordsFromValue(value: unknown) {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function parseJsonObjectFromText(value: unknown) {
  const text = stringFromRecord(value);
  if (!text) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      return undefined;
    }

    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
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
  const normalized = (value ?? "")
    .replace(/^\s*problem\s*:\s*/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return stripLeakedSupportPayloadFromProblemText(normalized);
}

function stripLeakedSupportPayloadFromProblemText(value: string) {
  const payloadStart = leakedSupportPayloadStart(value);
  if (payloadStart < 0) {
    return value;
  }

  const candidate = value.slice(0, payloadStart).replace(/[}\]\s]+$/g, "").trim();
  if (!candidate || !looksLikeProblemStatement(candidate)) {
    return "";
  }

  return candidate;
}

function leakedSupportPayloadStart(value: string) {
  const patterns = [
    /[}\]]?\s*\{\s*["'](?:type|topic|method|priority|why|query|retrieval_reason|top_k|confidence|support_intents|background_support_searches|ready_support_bundle_action|support_bundle_action)["']\s*:/i,
    /\b(?:support_intents|background_support_searches|ready_support_bundle_action|support_bundle_action)\b\s*[:=]/i
  ];
  const indexes = patterns
    .map((pattern) => value.search(pattern))
    .filter((index) => index >= 0);

  return indexes.length ? Math.min(...indexes) : -1;
}

function looksLikeProblemStatement(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return false;
  }

  if (/\b(?:prove|show|find|compute|solve|evaluate|determine|verify|explain|derive|write|given|let|suppose|assuming)\b/i.test(normalized)) {
    return true;
  }

  return Boolean(
    extractLeadingProblemNumberFromContextText(normalized) &&
      /(?:=|<=|>=|\\leq?|\\geq?|\\frac|\^|rank|dim|lim|integral|derivative)/i.test(normalized)
  );
}

function extractLeadingProblemNumberFromContextText(text?: string) {
  const normalizedText = (text ?? "").replace(/\s+/g, " ").trim();
  const numberMatch = normalizedText.match(
    /^(?:Problem|Exercise|Question)?\s*(\d+(?:\.\d+)+(?:[a-z])?)\s*(?:\.\s*)?\*?(?=\s|\.|:|$)/i
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
  const seenTextKeys = new Set<string>();
  const deduped: NonNullable<ChatContextMemory["savedProblems"]> = [];

  for (const problem of problems) {
    const key = contextProblemDedupeKey(problem);
    const textKey = contextProblemTextDedupeKey(problem);

    if (!key || seen.has(key) || (textKey && seenTextKeys.has(textKey))) {
      continue;
    }

    seen.add(key);
    if (textKey) {
      seenTextKeys.add(textKey);
    }
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

  if (problemNumber) {
    return ["problem-number", problemNumber].join("|");
  }

  if (sourceName && (problemNumber || pageNumber)) {
    return ["source-problem", sourceName, problemNumber, pageNumber].join("|");
  }

  return ["fallback", sourceName, problemNumber, pageNumber, text || label].join("|");
}

function contextProblemTextDedupeKey(problem: NonNullable<ChatContextMemory["savedProblems"]>[number]) {
  const text = normalizeComparableProblemText(problem.problemText);

  if (text.length < 80) {
    return "";
  }

  return [normalizeComparableProblemIdentity(problem.sourceName), problem.pageNumber ?? "", text].join("|");
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
    const key = contextSourceKey(source);
    const existingIndex = deduped.findIndex((dedupedSource) => {
      return contextSourceKey(dedupedSource) === key;
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
        pageNumber: existing.pageNumber ?? source.pageNumber,
        problemNumber: existing.problemNumber || source.problemNumber,
        ...((existing.sourceItemLabel || source.sourceItemLabel)
          ? { sourceItemLabel: existing.sourceItemLabel || source.sourceItemLabel }
          : {}),
        ...((existing.supportType || source.supportType) ? { supportType: existing.supportType || source.supportType } : {}),
        ...((existing.fileType || source.fileType) ? { fileType: existing.fileType || source.fileType } : {}),
        label: formatContextSource({
          sourceName: existing.sourceName || source.sourceName,
          sourceType: existing.sourceType || source.sourceType,
          pageNumber: existing.pageNumber ?? source.pageNumber,
          sourceItemLabel: existing.sourceItemLabel || source.sourceItemLabel,
          problemNumber: existing.problemNumber || source.problemNumber
        })
      };
      continue;
    }

    deduped.push(source);
  }

  return deduped.slice(0, 6);
}

function unconfirmedContextSources(
  unconfirmedSources: NonNullable<ChatContextMemory["sourcesUsed"]>,
  sourcesUsed: NonNullable<ChatContextMemory["sourcesUsed"]>
) {
  const confirmedKeys = new Set(sourcesUsed.map(contextSourceKey));
  return unconfirmedSources.filter((source) => !confirmedKeys.has(contextSourceKey(source))).slice(0, 3);
}

function contextSourceKey(source: NonNullable<ChatContextMemory["sourcesUsed"]>[number]) {
  const sourceIdentity = [source.sourceType ?? "", source.sourceName?.toLowerCase() || source.id || ""].join(":");
  const pageOrProblem = source.pageNumber ?? (source.problemNumber ? `problem:${source.problemNumber.toLowerCase()}` : "");
  return [sourceIdentity, pageOrProblem].join("|");
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
    source.sourceItemLabel || (source.problemNumber ? `Problem ${source.problemNumber}` : undefined)
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

function readableSupportType(value?: string) {
  const normalized = (value ?? "").replace(/_/g, " ").trim();
  return normalized ? normalized.replace(/\b\w/g, (letter) => letter.toUpperCase()) : undefined;
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
