from __future__ import annotations

import json
from typing import Any

from backend.agent.graph import build_multimodal_final_messages, page_assets_for_memory_from_answer, pdf_rag_response_from_state
from backend.agent.knowledge import (
    build_llm_knowledge_context_package,
    knowledge_items_from_state,
    knowledge_ui_color_token,
    package_contains_internal_retrieval_junk,
    pdf_page_knowledge_item,
    student_upload_knowledge_item,
)


def base_state(**overrides: Any) -> dict[str, Any]:
    state = {
        "answer_policy": {"refuseAnswerOnlyRequests": True},
        "chat_retrieval_memory": {},
        "class_id": "class-linear",
        "conversation_id": "chat-1",
        "messages": [
            {"role": "assistant", "content": "Try identifying which rank inequality applies."},
            {"role": "user", "content": "Can you show me Problem 2.14?"},
        ],
        "page_assets": [],
        "retrieval_decision": {"retrieval_reason": "student_requested_problem"},
        "retrieved_pages": [],
        "source_usage": {"citeSourcePages": True},
        "student_attachment_files": [],
        "tool_call_count": 1,
    }
    state.update(overrides)
    return state


def pdf_page(**overrides: Any) -> dict[str, Any]:
    page = {
        "chunk_id": "internal-chunk-1",
        "chunk_text": "Problem 2.14. Prove rank(KL) <= rank(L).",
        "doc_id": "pdf-rank",
        "full_pdf_data_url": "data:application/pdf;base64,JVBERi0x",
        "full_pdf_path": "classes/class-linear/materials/pdf-rank/source.pdf",
        "full_pdf_sha256": "sha256-full-pdf",
        "material_type": "assignment",
        "ocr_text": "Problem 2.14. Prove rank(KL) <= rank(L).",
        "page_asset_storage_path": "classes/class-linear/materials/pdf-rank/page-assets/page-12.pdf",
        "page_start": 12,
        "printed_page_start": 80,
        "problem_numbers": ["2.14"],
        "retrieval_reason": "student_requested_problem",
        "storage_path": "classes/class-linear/materials/pdf-rank/source.pdf",
        "title": "Rank Worksheet",
    }
    page.update(overrides)
    return page


def serialized_text_parts(messages: list[dict[str, Any]]) -> str:
    text_parts: list[str] = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, str):
            text_parts.append(content)
        elif isinstance(content, list):
            for part in content:
                if isinstance(part, dict) and part.get("type") == "text":
                    text_parts.append(str(part.get("text") or ""))
    return "\n".join(text_parts)


def file_parts(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    for message in messages:
        content = message.get("content")
        if isinstance(content, list):
            parts.extend(part for part in content if isinstance(part, dict) and part.get("type") == "file")
    return parts


def test_saves_active_problem_and_pdf_page_problem_source() -> None:
    state = base_state(page_assets=[pdf_page()])
    items = knowledge_items_from_state(
        state,
        active_problem_text="Problem 2.14. Prove rank(KL) <= rank(L).",
    )

    active_problem = next(item for item in items if item["usedAs"] == "active_problem")
    problem_source = next(item for item in items if item["usedAs"] == "problem_source")

    assert active_problem["kind"] == "problem"
    assert active_problem["content"].startswith("Problem 2.14")
    assert active_problem["sourceName"] == "Rank Worksheet"
    assert problem_source["kind"] == "pdf_page"
    assert problem_source["pdfId"] == "pdf-rank"
    assert problem_source["page"] == 80
    assert problem_source["ocrText"].startswith("Problem 2.14")


def test_model_referenced_pages_limit_knowledge_memory() -> None:
    page_80 = pdf_page(doc_id="pdf-rank", printed_page_start=80, page_start=12)
    page_81 = pdf_page(
        doc_id="pdf-rank",
        printed_page_start=81,
        page_start=13,
        ocr_text="Problem 2.15. Prove the next rank statement.",
        chunk_text="Problem 2.15. Prove the next rank statement.",
        problem_numbers=["2.15"],
    )
    state = base_state(page_assets=[page_80, page_81])
    answer = "Use the second selected source.\n\nReferenced sources:\ndoc_id: pdf-rank; page: 81; reason: used for the problem statement"

    selected = page_assets_for_memory_from_answer(state, answer)
    items = knowledge_items_from_state({**state, "used_page_assets": selected})
    page_items = [item for item in items if item["kind"] == "pdf_page"]

    assert [item["page"] for item in page_items] == [81]
    assert page_items[0]["problemId"] == "2.15"


def test_referenced_sources_block_is_not_sent_to_student() -> None:
    state = base_state(page_assets=[pdf_page()])
    response = pdf_rag_response_from_state(
        state,
        answer=(
            "This is the requested source page.\n\n"
            "Referenced sources:\n"
            "doc_id: pdf-rank; page: 80; reason: cited source\n\n"
            "Problem context:\n"
            "relation: same_problem\n"
            "problem: Problem 2.14. Prove rank(KL) <= rank(L).\n"
            "source_type: pdf\n"
            "source_document_id: pdf-rank\n"
            "source_page: 80\n"
            "confidence: high"
        ),
    )

    assert "Referenced sources" not in response["content"]
    assert "Problem context" not in response["content"]
    assert response["sources"] == [{"title": "Rank Worksheet", "materialType": "assignment", "pageNumber": 80}]


def test_saves_theorem_definition_and_example_reference_pages() -> None:
    state = base_state()

    theorem = pdf_page_knowledge_item(
        pdf_page(
            title="Linear Algebra Notes",
            ocr_text="Theorem 3.2. Rank-nullity gives dim ker T + rank T = dim V.",
            chunk_text="Theorem 3.2. Rank-nullity gives dim ker T + rank T = dim V.",
            problem_numbers=[],
            retrieval_reason="needed_supporting_page",
        ),
        state,
    )
    definition = pdf_page_knowledge_item(
        pdf_page(
            title="Definitions",
            ocr_text="Definition. The rank of a matrix is the dimension of its column space.",
            chunk_text="Definition. The rank of a matrix is the dimension of its column space.",
            problem_numbers=[],
            retrieval_reason="needed_supporting_page",
        ),
        state,
    )
    example = pdf_page_knowledge_item(
        pdf_page(
            title="Worked Examples",
            ocr_text="Example 4. Compute the rank after multiplying two matrices.",
            chunk_text="Example 4. Compute the rank after multiplying two matrices.",
            problem_numbers=[],
            retrieval_reason="needed_example_page",
        ),
        state,
    )

    assert theorem is not None and theorem["usedAs"] == "theorem_reference"
    assert definition is not None and definition["usedAs"] == "definition_reference"
    assert example is not None and example["usedAs"] == "example_reference"


def test_saves_student_upload_as_student_attempt() -> None:
    state = base_state()
    item = student_upload_knowledge_item(
        {
            "id": "attachment-1",
            "fileName": "my-work.pdf",
            "extractedText": "I tried using rank(KL) <= rank(K), but I am stuck.",
        },
        state,
        linked_problem_id="2.14",
    )

    assert item is not None
    assert item["kind"] == "student_upload"
    assert item["usedAs"] == "student_attempt"
    assert item["linkedProblemId"] == "2.14"
    assert item["ocrText"].startswith("I tried")


def test_assembles_clean_llm_context_package_without_raw_paths_or_chunk_ids() -> None:
    state = base_state(page_assets=[pdf_page()])
    state["knowledge_items"] = knowledge_items_from_state(
        state,
        active_problem_text="Problem 2.14. Prove rank(KL) <= rank(L).",
    )

    package = build_llm_knowledge_context_package(state)
    serialized = json.dumps(package)

    assert package["latestStudentMessage"] == "Can you show me Problem 2.14?"
    assert package["activeProblemText"].startswith("Problem 2.14")
    assert any(item["usedAs"] == "problem_source" for item in package["knowledge"])
    assert not package_contains_internal_retrieval_junk(package)
    assert "storage_path" not in serialized
    assert "page_asset_storage_path" not in serialized
    assert "chunk_id" not in serialized
    assert "classes/class-linear/materials" not in serialized


def test_final_llm_messages_include_selected_pdf_files_but_not_raw_paths_in_text() -> None:
    state = base_state(page_assets=[pdf_page()])
    state["knowledge_items"] = knowledge_items_from_state(
        state,
        active_problem_text="Problem 2.14. Prove rank(KL) <= rank(L).",
    )

    messages = build_multimodal_final_messages(state)
    prompt_text = serialized_text_parts(messages)
    attached_files = file_parts(messages)

    assert attached_files
    assert attached_files[0]["file"]["file_data"].startswith("data:application/pdf")
    assert "Problem 2.14" in prompt_text
    assert "usedAs" in prompt_text
    assert "full_pdf_path" not in prompt_text
    assert "page_asset_storage_path" not in prompt_text
    assert "chunk_id" not in prompt_text
    assert "classes/class-linear/materials" not in prompt_text


def test_used_as_maps_to_ui_color_token() -> None:
    assert knowledge_ui_color_token("active_problem") == "blue"
    assert knowledge_ui_color_token("problem_source") == "blue"
    assert knowledge_ui_color_token("supporting_context") == "neutral"
    assert knowledge_ui_color_token("definition_reference") == "purple"
    assert knowledge_ui_color_token("theorem_reference") == "purple"
    assert knowledge_ui_color_token("example_reference") == "green"
    assert knowledge_ui_color_token("student_attempt") == "orange"
    assert knowledge_ui_color_token("unknown") == "neutral"
