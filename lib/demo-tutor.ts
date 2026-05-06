import type { RetrievalHit } from "./types";
import { summarizeLikelySource } from "./retrieval-ranking";

export function createDemoTutorResponse(question: string, hits: RetrievalHit[]) {
  const source = hits[0];

  if (!source) {
    return [
      "Let's slow the problem down into one move.",
      "",
      "What is the first thing the question is asking you to find or transform? If you paste the exact problem, I will help you choose the next step without jumping straight to the answer."
    ].join("\n");
  }

  const likelySourceLead = summarizeLikelySource(hits);

  return [
    likelySourceLead || `A helpful place to look is ${source.document.title}, especially ${source.chunk.label}.`,
    "",
    "Let's use that source as a guide without jumping straight to the final answer.",
    "",
    "What is the first operation or rule you think applies here? Write that one step, and I will check it."
  ].join("\n");
}

export function createDirectTutorResponse(question: string) {
  if (/\b(?:do\s*not|don['’]?t)\s+have\s+(?:a|an)?\s*(?:problem|question|assignment)\s+yet\b/i.test(question)) {
    return [
      "That is okay. We do not need a specific problem yet.",
      "",
      "Tell me the topic you are working on, or paste a problem when you get one, and I will help you choose a good first step."
    ].join("\n");
  }

  return [
    "I can help with that without looking up class materials first.",
    "",
    "Tell me the topic or goal, and I will guide you through the next useful step."
  ].join("\n");
}
