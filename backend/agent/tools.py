from __future__ import annotations

import json
from typing import Any

from backend.retrieval.pdf_retriever import GeminiPdfRetriever, PdfPageResult, PdfRetriever


SEARCH_PDF_PAGES_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "search_pdf_pages",
        "description": (
            "Search indexed class PDF page windows: homework/problem sets, worksheets, assignments, textbook readings, notes, and examples. "
            "Use this when class PDFs could help solve, explain, or locate the student's question. "
            "When the student asks about a textbook section or chapter, search the generic textbook/reading section marker first "
            "with the exact section or chapter number and topic words; the retriever will return the most related page windows from any indexed textbook. "
            "For find/identify/locate requests, prefer the problem PDF first: homework/problem sets, worksheets, assignments, and practice-problem PDFs; "
            "search textbook/readings only if no problem-set match is found or the student asks for solving help. "
            "When it genuinely helps, call this tool 2 or 3 times in the same turn with distinct complementary queries: "
            "one for the exact problem/page/source, one for the relevant textbook method or formula, and one for a nearby textbook or worked example. "
            "Use only one call when one focused query is enough. "
            "Use concise, focused queries with the likely topic/method, exact worksheet titles, problem/page numbers, "
            "figure/table labels, named equations, and the student's wording. For exact problem/page searches, include "
            "a locator verb such as find, where, locate, identify, or which. If previous selected pages are insufficient "
            "or mismatched, search again with a narrower or alternate query. If retrieval diagnostics are present, "
            "search for the missing piece they name: method support, exact problem page, worked example, or corrected section/title."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "Focused semantic search query for the PDF corpus. For locating a problem, start with a locator verb "
                        "such as find, where, locate, identify, or which, then include problem PDF, homework, problem set, "
                        "worksheet, assignment, or practice-problems terms before textbook terms. Include the likely topic or "
                        "method, exact titles, page numbers, problem numbers, section names, figure/table labels, and the "
                        "student's wording when available. Expand math notation with words when useful, such as sqrt/square root, "
                        "int/integral, derivative/differentiate, and lim/limit. Keep filler source-type words out of textbook/method searches."
                        " For textbook section requests, include textbook or reading plus the exact section/chapter marker and topic words, "
                        "without assuming any particular textbook title."
                    ),
                },
                "top_k": {
                    "type": "integer",
                    "description": (
                        "Ignored. The tool usually returns the top 5 ranked page windows; textbook section/chapter "
                        "queries may return more related windows."
                    ),
                    "default": 5,
                },
                "student_reason": {
                    "type": "string",
                    "description": (
                        "Exactly five words explaining to the student why this search helps. "
                        "Example: Checking exact problem and page"
                    ),
                },
            },
            "required": ["query", "student_reason"],
        },
    },
}


def parse_search_pdf_pages_arguments(raw_arguments: str | dict[str, Any] | None) -> tuple[str, int]:
    """Parse OpenRouter tool-call arguments for the search_pdf_pages tool."""

    if raw_arguments is None:
        raise ValueError("search_pdf_pages requires a query argument.")

    parsed = raw_arguments if isinstance(raw_arguments, dict) else json.loads(raw_arguments or "{}")
    query = str(parsed.get("query") or "").strip()

    if not query:
        raise ValueError("search_pdf_pages requires a non-empty query.")

    return query, 5


async def search_pdf_pages(
    query: str,
    top_k: int = 5,
    *,
    retriever: PdfRetriever | None = None,
    class_id: str | None = None,
    professor_id: str | None = None,
) -> list[dict[str, Any]]:
    """Search indexed PDF page windows and return page metadata, not whole PDFs."""

    backend = retriever or GeminiPdfRetriever()
    pages = await backend.search(query=query, top_k=top_k, class_id=class_id, professor_id=professor_id)
    return [normalize_pdf_page_result(page) for page in pages]


def normalize_pdf_page_result(page: PdfPageResult | dict[str, Any]) -> dict[str, Any]:
    """Normalize retriever output into the required tool result shape."""

    source = page if isinstance(page, dict) else page.to_dict()
    page_start = int(source.get("page_start") or source.get("pageStart") or source.get("pageNumber") or 1)
    page_end = int(source.get("page_end") or source.get("pageEnd") or page_start)

    return {
        "doc_id": str(source.get("doc_id") or source.get("docId") or source.get("materialId") or ""),
        "title": str(source.get("title") or "Untitled PDF"),
        "page_start": max(1, min(page_start, page_end)),
        "page_end": max(page_start, page_end),
        "section": str(source.get("section") or source.get("sectionHeading") or ""),
        "score": float(source.get("score") or 0.0),
        "chunk_text": str(source.get("chunk_text") or source.get("chunkText") or source.get("content") or ""),
        "source_pdf_path": str(
            source.get("source_pdf_path")
            or source.get("sourcePdfPath")
            or source.get("fileUrl")
            or source.get("filePath")
            or ""
        ),
        "material_type": str(source.get("material_type") or source.get("materialType") or source.get("kind") or ""),
    }
