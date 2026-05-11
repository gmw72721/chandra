import type { ChatMessage } from "./types";

export function assistantContentWithSources(message: ChatMessage) {
  const selectedPageContext = selectedPagesContext(message);
  const sourceContext = sourcesContext(message);

  if (!sourceContext && !selectedPageContext) {
    return message.content;
  }

  return [
    message.content,
    sourceContext ? `Previously cited source context: ${sourceContext}` : "",
    selectedPageContext ? `Previously selected PDF pages: ${selectedPageContext}` : ""
  ]
    .filter(Boolean)
    .join("\n\n");
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
        page.section ? `section ${page.section}` : "",
        page.citationLabel ? `citation ${page.citationLabel}` : ""
      ]
        .filter(Boolean)
        .join(", ")
    )
    .join("; ");
}
