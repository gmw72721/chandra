import type { ModelOption } from "./types";

export const customModelStorageKey = "chandra.customOpenRouterModels";

export const defaultOpenRouterModelId = "openai/gpt-5.4-mini";

export const defaultModelOptions: ModelOption[] = [
  {
    id: "demo-guided",
    label: "Chandra Demo Tutor",
    provider: "demo",
    description: "Local guided response for development and classroom previews."
  },
  {
    id: defaultOpenRouterModelId,
    label: "OpenAI GPT-5.4 Mini",
    provider: "openrouter",
    description: "Strong, efficient tutor model routed through OpenRouter."
  },
  {
    id: "anthropic/claude-3.5-sonnet",
    label: "Claude 3.5 Sonnet",
    provider: "openrouter",
    description: "Strong conversational reasoning model routed through OpenRouter."
  },
  {
    id: "google/gemini-2.0-flash-001",
    label: "Gemini 2.0 Flash",
    provider: "openrouter",
    description: "Fast multimodal-capable model routed through OpenRouter."
  }
];

export function openRouterModelLabel(modelId: string) {
  return modelId
    .split("/")
    .map((part) =>
      part
        .split("-")
        .filter(Boolean)
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
    )
    .join(" / ");
}

export function createOpenRouterModelOption(modelId: string): ModelOption {
  return {
    id: modelId,
    label: openRouterModelLabel(modelId),
    provider: "openrouter",
    description: "Custom OpenRouter model configured by the teacher."
  };
}
