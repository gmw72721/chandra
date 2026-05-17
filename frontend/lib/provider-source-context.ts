import type { ChatMessage } from "./types";

export function assistantContentWithSources(message: ChatMessage) {
  const choiceContext = previousChoiceContext(message);
  const selectedPageContext = selectedPagesContext(message);
  const sourceContext = sourcesContext(message);

  if (!choiceContext && !sourceContext && !selectedPageContext) {
    return message.content;
  }

  return [
    message.content,
    choiceContext,
    sourceContext ? `Previously cited source context: ${sourceContext}` : "",
    selectedPageContext ? `Previously selected PDF pages: ${selectedPageContext}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
}

function previousChoiceContext(message: ChatMessage) {
  const choices = message.structuredOutput?.confusionChoices ?? [];

  if (!choices.length) {
    return "";
  }

  const choiceDisplay = message.structuredOutput?.metadata.choiceDisplay;
  const choiceKind = choiceDisplay === "problem_selection" ? "problem-selection" : "support-path";
  const compactChoices = choices
    .slice(0, 8)
    .map((choice) => `${choice.label}: ${choice.message}`)
    .join("; ");

  return [
    `Previously offered ${choiceKind} choices: ${compactChoices}`,
    "If the next student message matches or edits one of these choices, treat it as the selected direction and do not ask another support-path choice; answer or request the single missing input needed for that direction."
  ].join("\n");
}

function sourcesContext(message: ChatMessage) {
  if (!message.sources?.length) {
    return "";
  }

  return message.sources
    .map((source) =>
      [
        source.title,
        source.problemNumber ? `problem ${source.problemNumber}` : "",
        source.pageNumber ? `page ${source.pageNumber}` : "",
        source.materialType ? `material type ${source.materialType}` : ""
      ]
        .filter(Boolean)
        .join(", ")
    )
    .join("; ");
}

function selectedPagesContext(message: ChatMessage) {
  const selectedPages = message.langGraphTrace?.selectedPages ?? [];

  if (!selectedPages.length) {
    return "";
  }

  return selectedPages
    .map((page) =>
      [
        page.title,
        page.printedPageStart ? `printed page ${page.printedPageStart}` : "",
        page.pageStart ? `internal page ${page.pageStart}` : "",
        page.materialType ? `material type ${page.materialType}` : "",
        page.citationLabel ? `citation ${page.citationLabel}` : ""
      ]
        .filter(Boolean)
        .join(", ")
    )
    .join("; ");
}
