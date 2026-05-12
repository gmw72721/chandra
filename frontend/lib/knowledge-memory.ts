import type { KnowledgeItemUsedAs, KnowledgeUiColorToken } from "./types";

export const knowledgeUiColorByUsedAs: Record<KnowledgeItemUsedAs, KnowledgeUiColorToken> = {
  active_problem: "blue",
  problem_source: "blue",
  supporting_context: "neutral",
  definition_reference: "purple",
  theorem_reference: "purple",
  example_reference: "green",
  student_attempt: "orange"
};

export function knowledgeUiColorToken(usedAs: string): KnowledgeUiColorToken {
  return knowledgeUiColorByUsedAs[usedAs as KnowledgeItemUsedAs] ?? "neutral";
}
