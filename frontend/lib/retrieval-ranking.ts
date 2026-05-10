import type { RetrievalConfidence, RetrievalHit, SourceChunk, SourceDocument, TutorSource } from "./types";

export type RetrievalRankingResult = {
  confidence: RetrievalConfidence;
  hits: RetrievalHit[];
};

export type RetrievalSourceHint = Pick<TutorSource, "pageNumber" | "problemNumber" | "title">;

export type RankableChunk = {
  chunk: SourceChunk;
  document: SourceDocument;
};

type ScoredChunk = RankableChunk & {
  matchedProblemNumber?: string;
  score: number;
};

type CandidateFeatures = RankableChunk & {
  chunkTitle: string;
  contentText: string;
  documentTitle: string;
  equationTokens: Set<string>;
  headingProblemNumbers: string[];
  headingProblemNumberSet: Set<string>;
  materialType: string;
  normalizedContentText: string;
  problemNumbers: string[];
  problemNumberSet: Set<string>;
  searchableTerms: string[];
  searchableText: string;
  termCounts: Map<string, number>;
};

type NormalizedExactPhrase = {
  normalized: string;
  originalLength: number;
};

type CorpusStats = {
  averageDocumentLength: number;
  documentCount: number;
  documentFrequencies: Map<string, number>;
};

const assignmentKinds = new Set(["assignment", "worksheet", "homework", "practice", "quiz"]);
const explicitProblemLookupTightScoreWindow = 2;
const stopwords = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "before",
  "could",
  "does",
  "from",
  "have",
  "help",
  "into",
  "just",
  "like",
  "need",
  "problem",
  "question",
  "show",
  "step",
  "that",
  "their",
  "there",
  "this",
  "what",
  "when",
  "with",
  "work",
  "working",
  "would"
]);

export function rankMaterialChunks({
  candidates,
  limit = 5,
  query,
  queryVector,
  sourceHints = []
}: {
  candidates: RankableChunk[];
  limit?: number;
  query: string;
  queryVector?: number[];
  sourceHints?: RetrievalSourceHint[];
}): RetrievalRankingResult {
  const queryFeatures = getQueryFeatures(query, queryVector, sourceHints);

  if ((!queryFeatures.terms.length && !queryFeatures.problemNumbers.length) || !candidates.length) {
    return { confidence: "low", hits: [] };
  }

  const scored = scoreTopCandidates({
    candidates,
    limit: maxRequestedHits(limit, queryFeatures),
    queryFeatures
  });
  const hits = scored
    .slice(0, selectedHitLimit(scored, limit, queryFeatures))
    .map(({ chunk, document, matchedProblemNumber, score }) => ({
      chunk,
      document,
      matchedProblemNumber,
      score
    }));

  return {
    confidence: hits.length ? "high" : "low",
    hits
  };
}

function scoreTopCandidates({
  candidates,
  limit,
  queryFeatures
}: {
  candidates: RankableChunk[];
  limit: number;
  queryFeatures: ReturnType<typeof getQueryFeatures>;
}) {
  const topScored: ScoredChunk[] = [];
  const candidateFeatures = candidates.map(prepareCandidateFeatures);
  const corpusStats = buildCorpusStats(candidateFeatures, queryFeatures.terms);

  for (const candidate of candidateFeatures) {
    const scoredCandidate = scoreCandidate(candidate, queryFeatures, corpusStats);

    if (scoredCandidate.score <= 0) {
      continue;
    }

    const insertIndex = topScored.findIndex((existingCandidate) => scoredCandidate.score > existingCandidate.score);

    if (insertIndex === -1) {
      if (topScored.length < limit) {
        topScored.push(scoredCandidate);
      }

      continue;
    }

    topScored.splice(insertIndex, 0, scoredCandidate);

    if (topScored.length > limit) {
      topScored.pop();
    }
  }

  return topScored;
}

export function problemNumbersFromText(text: string) {
  const normalized = text.toLowerCase();
  const matches = new Set<string>();
  const patterns = [
    /\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3})\s+(\d{1,3}[a-z]?)\b/g,
    /\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\b/g,
    /\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3}(?:\.\d{1,3})?[a-z]?)(?!\s+\d)\b/g,
    /(?:^|[\s([{])#\s*(\d{1,3}[a-z]?)\b/g,
    /\bq\s*(\d{1,3}[a-z]?)\b/g,
    /(?:^|[\s([{])(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\s*[\).]/g
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (match[1] && match[2]) {
        matches.add(`${match[1]}.${match[2]}`.toUpperCase());
      } else if (match[1]) {
        matches.add(match[1].toUpperCase());
      }
    }
  }

  return [...matches];
}

export function hasExactLookupSignal(query: string) {
  const queryFeatures = getQueryFeatures(query);
  return queryFeatures.exactLookupIntent;
}

export function materialTypeForKind(kind: string) {
  const normalized = kind.trim().toLowerCase();

  if (assignmentKinds.has(normalized)) {
    return "assignment";
  }

  if (normalized === "practice problems" || normalized === "practice-problems") {
    return "practice-problems";
  }

  if (
    normalized === "practice solutions" ||
    normalized === "practice-solutions" ||
    normalized === "solutions" ||
    normalized === "answer-key"
  ) {
    return "practice-solutions";
  }

  if (normalized === "notes" || normalized === "lecture-notes") {
    return "notes";
  }

  if (normalized === "example" || normalized === "worked-example") {
    return "example";
  }

  if (normalized === "reading" || normalized === "textbook") {
    return "reading";
  }

  return normalized || "material";
}

export function createSourceMetadata(hits: RetrievalHit[]): TutorSource[] {
  const seen = new Set<string>();
  const sources: TutorSource[] = [];

  for (const hit of hits) {
    const materialType = materialTypeForKind(hit.chunk.materialType ?? hit.document.materialType ?? hit.document.kind);
    const pageNumber = hit.chunk.pageNumber ?? hit.chunk.pageStart;
    const problemNumber = hit.matchedProblemNumber ?? hit.chunk.problemNumbers?.[0];
    const key = [
      hit.document.id,
      pageNumber ?? "",
      problemNumber ?? "",
      hit.chunk.sectionHeading ?? hit.chunk.label
    ].join(":");

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    sources.push({
      title: hit.chunk.title ?? hit.document.title,
      materialType,
      ...(hit.document.citationsRequired ? { citationsRequired: true } : {}),
      ...(pageNumber ? { pageNumber } : {}),
      ...(problemNumber ? { problemNumber } : {})
    });
  }

  return sources;
}

export function buildLowConfidenceTutorMessage(query: string, hasIndexedMaterials: boolean) {
  if (!hasIndexedMaterials) {
    return [
      "I do not see indexed class materials for your class yet.",
      "Paste the problem text here and I can still help you work through the next step."
    ].join(" ");
  }

  const requestedProblems = problemNumbersFromText(query);
  const problemText = requestedProblems.length ? ` problem ${requestedProblems[0]}` : " that problem";

  return [
    `I am not confident I found${problemText} in the class materials yet.`,
    "Can you paste the exact problem text or its worksheet title?"
  ].join(" ");
}

export function summarizeLikelySource(hits: RetrievalHit[]) {
  const topHit = hits[0];

  if (!topHit) {
    return "";
  }

  const materialType = materialTypeForKind(topHit.chunk.materialType ?? topHit.document.materialType ?? topHit.document.kind);
  const problemNumber = topHit.matchedProblemNumber ?? topHit.chunk.problemNumbers?.[0];

  if (materialType === "assignment" && problemNumber) {
    return `I think this is from ${topHit.document.title}, problem ${problemNumber}.`;
  }

  if (materialType === "assignment") {
    return `I think this is from ${topHit.document.title}.`;
  }

  return "";
}

function scoreCandidate(
  candidate: CandidateFeatures,
  queryFeatures: ReturnType<typeof getQueryFeatures>,
  corpusStats: CorpusStats
): ScoredChunk {
  const explicitProblemLookup = queryFeatures.explicitProblemLookup;
  const contentVector =
    queryFeatures.embeddingVector?.length &&
    candidate.chunk.vector?.length === queryFeatures.embeddingVector.length
      ? candidate.chunk.vector
      : buildTextVectorFromTerms(candidate.searchableTerms);
  const queryVector =
    queryFeatures.embeddingVector?.length && contentVector.length === queryFeatures.embeddingVector.length
      ? queryFeatures.embeddingVector
      : queryFeatures.lexicalVector;
  const vectorScore = cosineSimilarity(queryVector, contentVector);
  const semanticWeight = queryFeatures.exactLookupIntent ? 3 : 5;
  const bm25Score = scoreBm25(candidate.searchableTerms, candidate.termCounts, queryFeatures.terms, corpusStats);
  const titleScore = scoreTerms(candidate.documentTitle, queryFeatures.terms);
  const chunkTextScore = scoreTerms(candidate.searchableText, queryFeatures.terms);
  const exactPhraseScore = scoreExactPhrases(candidate.normalizedContentText, queryFeatures.exactPhrases);
  const equationOverlapScore = scoreEquationOverlap(candidate.equationTokens, queryFeatures.equationTokens);
  const matchedProblemNumber = findMatchedProblemNumber(queryFeatures.problemNumbers, candidate.problemNumberSet);
  const exactProblemHeadingScore = matchedProblemNumber
    ? Number(candidate.headingProblemNumberSet.has(matchedProblemNumber.toUpperCase()))
    : 0;
  const problemNumberScore = matchedProblemNumber ? 1 : 0;
  const pageNumberScore = scorePageNumbers(candidate.chunk, queryFeatures.pageNumbers);
  const numberedItemContextScore =
    queryFeatures.numberedItemLookupIntent && hasNumberedItemContext(candidate.searchableText, candidate.materialType)
      ? 1
      : 0;
  const sectionMatchScore = scoreProblemSectionMatch(candidate, queryFeatures.problemSectionPrefixes);
  const sourceHintScore = scoreSourceHint(candidate, queryFeatures.sourceHints, candidate.documentTitle);
  const assignmentBoost =
    queryFeatures.looksLikeAssignmentProblem &&
    (candidate.materialType === "assignment" || candidate.materialType === "practice-problems")
      ? 1.8
      : 0;
  const priorityBoost = scoreSourcePriority(candidate.document.priority);

  return {
    chunk: candidate.chunk,
    document: candidate.document,
    matchedProblemNumber,
    score:
      vectorScore * semanticWeight +
      (explicitProblemLookup ? 0 : bm25Score * 2) +
      titleScore * 2.25 +
      (explicitProblemLookup ? 0 : chunkTextScore) +
      exactPhraseScore * 8 +
      (explicitProblemLookup ? 0 : equationOverlapScore * 6) +
      exactProblemHeadingScore * 18 +
      problemNumberScore * (explicitProblemLookup ? 6 : 14) +
      pageNumberScore * 12 +
      numberedItemContextScore * 4 +
      sectionMatchScore * (explicitProblemLookup ? 6 : 0) +
      sourceHintScore +
      assignmentBoost +
      priorityBoost
  };
}

function scoreSourcePriority(priority: unknown) {
  if (priority === "primary") {
    return 2;
  }

  if (priority === "low") {
    return -1.5;
  }

  return 0;
}

function prepareCandidateFeatures(candidate: RankableChunk): CandidateFeatures {
  const documentText = `${candidate.document.title} ${candidate.chunk.label} ${candidate.chunk.sectionHeading ?? ""}`;
  const contentText = candidate.chunk.content;
  const searchableText = normalizeText(`${documentText} ${contentText}`);
  const searchableTerms = tokenizeNormalized(searchableText);
  const problemNumbers =
    candidate.chunk.problemNumbers ?? problemNumbersFromText(`${candidate.chunk.label} ${candidate.chunk.content}`);
  const headingProblemNumbers = headingProblemNumbersFromText(candidate.chunk.content);

  return {
    ...candidate,
    chunkTitle: normalizeText(candidate.chunk.title ?? ""),
    contentText,
    documentTitle: normalizeText(candidate.document.title),
    equationTokens: new Set(extractEquationTokens(searchableText)),
    headingProblemNumbers,
    headingProblemNumberSet: new Set(headingProblemNumbers.map((problemNumber) => problemNumber.toUpperCase())),
    materialType: materialTypeForKind(
      candidate.chunk.materialType ?? candidate.document.materialType ?? candidate.document.kind
    ),
    normalizedContentText: normalizeText(contentText),
    problemNumbers,
    problemNumberSet: new Set(problemNumbers.map((problemNumber) => problemNumber.toUpperCase())),
    searchableTerms,
    searchableText,
    termCounts: countTerms(searchableTerms)
  };
}

function getQueryFeatures(query: string, queryVector?: number[], sourceHints: RetrievalSourceHint[] = []) {
  const terms = tokenize(query);
  const problemNumbers = problemNumbersFromText(query);
  const pageNumbers = pageNumbersFromText(query);
  const exactPhrases = getExactPhrases(query).map((phrase) => ({
    normalized: normalizeText(phrase),
    originalLength: phrase.length
  }));
  const equationTokens = extractEquationTokens(query);
  const problemLocatorIntent = isProblemLocatorQuery(query);
  const explicitProblemLookup =
    problemNumbers.length > 0 &&
    /\b(?:problem|exercise|question|questions|exercises|ex\.?)\b/i.test(query) &&
    !/\bexample\b/i.test(query);
  const exactLookupIntent = Boolean(
    problemNumbers.length ||
      pageNumbers.length ||
      exactPhrases.length ||
      problemLocatorIntent
  );
  const numberedItemLookupIntent =
    Boolean(problemNumbers.length) ||
    /\b(?:exercise|exercises|ex\.?|problem|problems|question|questions|number|no\.?|practice|worksheet|assignment)\b/i.test(
      query
    );

  return {
    equationTokens,
    exactPhrases,
    exactLookupIntent,
    explicitProblemLookup,
    looksLikeAssignmentProblem: /\b(homework|worksheet|assignment|problem|question|#\s*\d+|q\s*\d+|number\s+\d+)\b/i.test(
      query
    ),
    pageNumbers,
    problemNumbers,
    problemSectionPrefixes: problemSectionPrefixes(problemNumbers),
    terms,
    embeddingVector: queryVector,
    lexicalVector: buildTextVectorFromTerms(terms),
    numberedItemLookupIntent,
    sourceHints: normalizeSourceHints(sourceHints)
  };
}

function hasNumberedItemContext(searchableText: string, materialType: string) {
  return (
    materialType === "assignment" ||
    materialType === "practice-problems" ||
    /\b(?:exercise|exercises|ex|problem|problems|question|questions|practice|worksheet|assignment|homework)\b/.test(
      searchableText
    )
  );
}

function normalizeSourceHints(sourceHints: RetrievalSourceHint[]) {
  return sourceHints
    .map((sourceHint) => ({
      pageNumber: sourceHint.pageNumber,
      problemNumber: sourceHint.problemNumber?.toUpperCase(),
      title: normalizeText(sourceHint.title)
    }))
    .filter((sourceHint) => sourceHint.title);
}

function scoreSourceHint(
  candidate: CandidateFeatures,
  sourceHints: ReturnType<typeof normalizeSourceHints>,
  documentTitle: string
) {
  if (!sourceHints.length) {
    return 0;
  }

  return sourceHints.reduce((score, sourceHint) => {
    const titleMatches =
      documentTitle === sourceHint.title ||
      candidate.chunkTitle === sourceHint.title ||
      documentTitle.includes(sourceHint.title) ||
      sourceHint.title.includes(documentTitle);

    if (!titleMatches) {
      return score;
    }

    const pageScore = sourceHint.pageNumber && chunkCoversPage(candidate.chunk, sourceHint.pageNumber) ? 2 : 0;
    const problemScore =
      sourceHint.problemNumber && candidate.problemNumberSet.has(sourceHint.problemNumber)
        ? 2
        : 0;

    return score + 5 + pageScore + problemScore;
  }, 0);
}

function findMatchedProblemNumber(queryProblemNumbers: string[], chunkProblemNumbers: Set<string>) {
  if (!queryProblemNumbers.length || !chunkProblemNumbers.size) {
    return undefined;
  }

  return queryProblemNumbers.find((number) => chunkProblemNumbers.has(number.toUpperCase()));
}

function headingProblemNumbersFromText(text: string) {
  const normalized = text.toLowerCase();
  const matches = new Set<string>();
  const patterns = [
    /\b(?:problem|exercise|question|questions|exercises|ex\.?)\s*#?\s*(\d{1,3}(?:\.\d{1,3})?[a-z]?)\b/g,
    /(?:^|[\s;:([])(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\s*\.(?=\s)/gm
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      if (match[1] && match[2]) {
        matches.add(`${match[1]}.${match[2]}`.toUpperCase());
      } else if (match[1]) {
        matches.add(match[1].toUpperCase());
      }
    }
  }

  return [...matches];
}

function problemSectionPrefixes(problemNumbers: string[]) {
  return [...new Set(problemNumbers.map((problemNumber) => problemNumber.split(".")[0]).filter(Boolean))];
}

function scoreProblemSectionMatch(candidate: CandidateFeatures, requestedPrefixes: string[]) {
  if (!requestedPrefixes.length || !candidate.headingProblemNumbers.length) {
    return 0;
  }

  const samePrefixCount = candidate.headingProblemNumbers.filter((problemNumber) =>
    requestedPrefixes.includes(problemNumber.split(".")[0])
  ).length;

  if (!samePrefixCount) {
    return 0;
  }

  return Math.min(1, samePrefixCount / 3);
}

function maxRequestedHits(limit: number, queryFeatures: ReturnType<typeof getQueryFeatures>) {
  return queryFeatures.explicitProblemLookup ? Math.max(limit, 5) : Math.max(limit, 2);
}

function selectedHitLimit(
  scored: ScoredChunk[],
  requestedLimit: number,
  queryFeatures: ReturnType<typeof getQueryFeatures>
) {
  if (!queryFeatures.explicitProblemLookup) {
    return requestedLimit;
  }

  if (scored.length <= 3 || requestedLimit <= 3) {
    return Math.min(requestedLimit, scored.length);
  }

  const comparisonIndex = Math.min(4, scored.length - 1);
  const topScore = scored[0]?.score ?? 0;
  const comparisonScore = scored[comparisonIndex]?.score ?? 0;

  return topScore - comparisonScore <= explicitProblemLookupTightScoreWindow ? Math.min(requestedLimit, 5) : 3;
}

function scoreExactPhrases(normalizedContent: string, exactPhrases: NormalizedExactPhrase[]) {
  if (!exactPhrases.length) {
    return 0;
  }

  return exactPhrases.reduce(
    (score, phrase) => score + (phrase.originalLength >= 20 && normalizedContent.includes(phrase.normalized) ? 1 : 0),
    0
  );
}

function getExactPhrases(input: string) {
  const matches = input.matchAll(/['"]([^'"]{20,})['"]|“([^”]{20,})”/g);
  return [...matches].flatMap((match) => match.slice(1).filter(Boolean));
}

function scoreTerms(text: string, terms: string[]) {
  return terms.reduce((score, term) => score + (text.includes(term) ? 1 : 0), 0) / Math.max(terms.length, 1);
}

function scoreBm25(
  documentTerms: string[],
  termCounts: Map<string, number>,
  queryTerms: string[],
  corpusStats: CorpusStats
) {
  if (!documentTerms.length || !queryTerms.length || !corpusStats.documentCount) {
    return 0;
  }

  const uniqueQueryTerms = new Set(queryTerms);
  const k1 = 1.2;
  const b = 0.75;

  return Array.from(uniqueQueryTerms).reduce((score, term) => {
    const termFrequency = termCounts.get(term) ?? 0;
    if (!termFrequency) {
      return score;
    }

    const documentFrequency = corpusStats.documentFrequencies.get(term) ?? 0;
    const inverseDocumentFrequency = Math.log(
      1 + (corpusStats.documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5)
    );
    const normalizedLength =
      corpusStats.averageDocumentLength > 0 ? documentTerms.length / corpusStats.averageDocumentLength : 1;
    const denominator = termFrequency + k1 * (1 - b + b * normalizedLength);

    return score + (inverseDocumentFrequency * termFrequency * (k1 + 1)) / denominator;
  }, 0);
}

function buildCorpusStats(candidates: CandidateFeatures[], queryTerms: string[]): CorpusStats {
  const documentFrequencies = new Map<string, number>();
  const uniqueQueryTerms = new Set(queryTerms);
  let totalDocumentLength = 0;

  for (const candidate of candidates) {
    totalDocumentLength += candidate.searchableTerms.length;

    for (const term of uniqueQueryTerms) {
      if (candidate.termCounts.has(term)) {
        documentFrequencies.set(term, (documentFrequencies.get(term) ?? 0) + 1);
      }
    }
  }

  return {
    averageDocumentLength: candidates.length ? totalDocumentLength / candidates.length : 0,
    documentCount: candidates.length,
    documentFrequencies
  };
}

function pageNumbersFromText(text: string) {
  const normalized = text.toLowerCase();
  const matches = new Set<number>();
  const patterns = [
    /\b(?:page|pg\.?|p\.?)\s*#?\s*(\d{1,4})\b/g,
    /\bprinted\s+page\s+(\d{1,4})\b/g
  ];

  for (const pattern of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const pageNumber = Number(match[1]);
      if (Number.isInteger(pageNumber) && pageNumber > 0) {
        matches.add(pageNumber);
      }
    }
  }

  return [...matches];
}

function scorePageNumbers(chunk: SourceChunk, pageNumbers: number[]) {
  if (!pageNumbers.length) {
    return 0;
  }

  return pageNumbers.some((pageNumber) => chunkCoversPage(chunk, pageNumber)) ? 1 : 0;
}

function chunkCoversPage(chunk: SourceChunk, pageNumber: number) {
  const pageStart = chunk.pageStart ?? chunk.pageNumber;
  const pageEnd = chunk.pageEnd ?? chunk.pageNumber ?? pageStart;

  return Boolean(pageStart && pageEnd && pageNumber >= pageStart && pageNumber <= pageEnd);
}

function extractEquationTokens(input: string) {
  const tokens = input.match(/[a-z]?\d+(?:\.\d+)?|[a-z]\^\d+|[a-z]\d+|[=+\-*/^]|\\(?:int|sum|sqrt|frac)|∞|infinity/gi) ?? [];
  return [...new Set(tokens.map((token) => token.toLowerCase()))];
}

function isProblemLocatorQuery(query: string) {
  const normalized = normalizeText(query);
  const hasLocatorWord = /\b(?:find|where|locate|identify|which|what)\b/.test(normalized);
  const hasProblemSignal =
    /\b(?:problem|question|exercise|homework|worksheet|assignment|practice)\b/.test(normalized);
  const hasEquationSignal =
    extractEquationTokens(query).length >= 2 ||
    /(?:[<>=≤≥]|\\(?:int|lim|sum|sqrt|frac)|\b(?:rank|dim|nullity|kernel|image)\s*\()/i.test(query);

  return hasLocatorWord && (hasProblemSignal || hasEquationSignal);
}

function scoreEquationOverlap(contentEquationTokens: Set<string>, equationTokens: string[]) {
  if (!equationTokens.length) {
    return 0;
  }

  const matches = equationTokens.filter((token) => contentEquationTokens.has(token)).length;

  return matches / Math.max(equationTokens.length, 1);
}

function tokenize(input: string) {
  return tokenizeNormalized(normalizeText(input));
}

function buildTextVectorFromTerms(terms: string[]) {
  const vector = new Array<number>(96).fill(0);

  for (const term of terms) {
    vector[hashTerm(term) % vector.length] += 1;
  }

  return normalizeVector(vector);
}

function countTerms(terms: string[]) {
  const termCounts = new Map<string, number>();

  for (const term of terms) {
    termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
  }

  return termCounts;
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (!magnitude) {
    return vector;
  }

  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(firstVector: number[], secondVector: number[]) {
  const length = Math.min(firstVector.length, secondVector.length);
  let score = 0;

  for (let index = 0; index < length; index += 1) {
    score += firstVector[index] * secondVector[index];
  }

  return score;
}

function hashTerm(term: string) {
  let hash = 0;

  for (let index = 0; index < term.length; index += 1) {
    hash = (hash * 31 + term.charCodeAt(index)) >>> 0;
  }

  return hash;
}

function normalizeText(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9#\s.-]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenizeNormalized(input: string) {
  return input.split(/\s+/).filter((term) => term.length > 2 && !stopwords.has(term));
}
