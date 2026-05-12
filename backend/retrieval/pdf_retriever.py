from __future__ import annotations

import re
from dataclasses import dataclass
from functools import lru_cache
from typing import Any, Protocol

SECTION_RELATED_TOP_K = 8
NORMALIZE_TEXT_SYMBOLS_RE = re.compile(r"[^a-z0-9#\s.-]")
NORMALIZE_TEXT_WHITESPACE_RE = re.compile(r"\s+")
PROBLEM_NUMBER_PATTERNS = (
    re.compile(r"\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3})\s+(\d{1,3}[a-z]?)\b"),
    re.compile(r"\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\b"),
    re.compile(r"\b(?:problem|question|exercise|exercises|ex\.?|number|no\.?)\s*#?\s*(\d{1,3}(?:\.\d{1,3})?[a-z]?)(?!\s+\d)\b"),
    re.compile(r"(?:^|[\s(\[{])#\s*(\d{1,3}[a-z]?)\b"),
    re.compile(r"\bq\s*(\d{1,3}[a-z]?)\b"),
    re.compile(r"(?:^|[\s(\[{])(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\s*[\).]"),
)
BARE_DOTTED_PROBLEM_LOCATOR_RE = re.compile(
    r"^\s*(?:problem|question|exercise|ex\.?)?\s*(\d{1,3})\s*\.\s*(\d{1,3}[a-z]?)\s*[?.!]?\s*$"
)
PAGE_NUMBER_PATTERNS = (
    re.compile(r"\b(?:page|pg\.?|p\.?)\s*#?\s*(\d{1,4})\b"),
    re.compile(r"\bprinted\s+page\s+(\d{1,4})\b"),
)
SECTION_MARKER_PATTERNS = (
    ("section", re.compile(r"\b(?:section|sec\.?|sect\.?|§)\s*#?\s*(\d{1,3}(?:\.\d{1,3}){0,3}[a-z]?)\b")),
    ("chapter", re.compile(r"\b(?:chapter|ch\.?)\s*#?\s*(\d{1,3}(?:\.\d{1,3}){0,2}[a-z]?)\b")),
)
TEXTBOOK_SECTION_SIGNAL_RE = re.compile(r"\b(?:textbook|reading|readings|chapter|section|sec|sect)\b")
ASSIGNMENT_SIGNAL_RE = re.compile(r"\b(?:homework|problem set|problem-set|worksheet|assignment|practice problems|practice-problems|quiz|exam)\b")
LOCATOR_WORD_RE = re.compile(r"\b(?:find|where|locate|identify|which|what)\b")
PROBLEM_SIGNAL_RE = re.compile(r"\b(?:problem|question|exercise|homework|worksheet|assignment|practice)\b")
MATH_EXPRESSION_SIGNAL_RE = re.compile(r"(?:[<>=≤≥]|\\(?:int|lim|sum|sqrt|frac)|\b(?:rank|dim|nullity|kernel|image)\s*\()", re.I)
EXACT_PHRASE_RE = re.compile(r"['\"]([^'\"]{20,})['\"]|“([^”]{20,})”")
TEXTBOOK_SOURCE_RE = re.compile(r"\b(?:reading|readings|textbook|chapter|section)\b")
ASSIGNMENT_SOURCE_RE = re.compile(r"\b(?:homework|problem set|problem-set|worksheet|assignment|practice problems|practice-problems|quiz|exam)\b")
PROBLEM_LOCATOR_SOURCE_RE = re.compile(r"\b(?:homework|problem set|problem-set|worksheet|assignment|practice problems|practice-problems)\b")
TEXTBOOK_PREFERENCE_SOURCE_RE = re.compile(r"\b(?:textbook|reading|readings|chapter)\b")
DIGITS_1_TO_3_RE = re.compile(r"\d{1,3}")
PROBLEM_SUFFIX_RE = re.compile(r"\d{1,3}[a-z]?")
SECTION_CONTEXT_RE = re.compile(r"\b(?:section|sec|sect|chapter|textbook|reading|readings)\b")
EQUATION_TOKEN_RE = re.compile(r"[a-z]?\d+(?:\.\d+)?|[a-z]\^\d+|[a-z]\d+|[=+\-*/^√∫]|\\(?:int|lim|sum|sqrt|frac)|∞|infinity")


@dataclass(frozen=True)
class PdfPageResult:
    """Metadata for a retrieved PDF page window."""

    doc_id: str
    title: str
    page_start: int
    page_end: int
    section: str
    score: float
    chunk_text: str
    source_pdf_path: str
    material_type: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "doc_id": self.doc_id,
            "title": self.title,
            "page_start": self.page_start,
            "page_end": self.page_end,
            "section": self.section,
            "score": self.score,
            "chunk_text": self.chunk_text,
            "source_pdf_path": self.source_pdf_path,
            "material_type": self.material_type,
        }


class PdfRetriever(Protocol):
    """Mockable retrieval interface for indexed PDF page windows."""

    async def search(
        self,
        *,
        query: str,
        top_k: int = 5,
        class_id: str | None = None,
        professor_id: str | None = None,
    ) -> list[PdfPageResult]:
        ...


def build_query_features(query: Any) -> dict[str, Any]:
    query = ensure_text(query)
    terms = tokenize(query)
    problem_numbers = problem_numbers_from_text(query)
    page_numbers = page_numbers_from_text(query)
    section_markers = section_markers_from_text(query)
    problem_locator_intent = is_problem_locator_query(query)
    exact_phrases = exact_phrases_from_text(query)
    equation_tokens = equation_tokens_from_text(query)
    textbook_section_intent = is_textbook_section_query(query, section_markers)

    return {
        "equation_tokens": equation_tokens,
        "exact_lookup_intent": bool(
            problem_numbers
            or page_numbers
            or section_markers
            or exact_phrases
            or problem_locator_intent
        ),
        "exact_phrases": exact_phrases,
        "numbered_item_lookup_intent": bool(
            problem_numbers
            or re.search(
                r"\b(?:exercise|exercises|ex\.?|problem|problems|question|questions|number|no\.?|practice|worksheet|assignment)\b",
                query,
                re.I,
            )
        ),
        "page_numbers": page_numbers,
        "problem_locator_intent": problem_locator_intent,
        "problem_numbers": problem_numbers,
        "section_markers": section_markers,
        "textbook_section_intent": textbook_section_intent,
        "terms": terms,
    }


def hybrid_page_score(
    query_features: dict[str, Any],
    *,
    material_type: str = "",
    page_start: int,
    page_end: int,
    searchable_text: str,
    vector_score: float,
) -> float:
    normalized_text = normalize_text(searchable_text)
    section_markers = most_specific_section_markers(query_features.get("section_markers") or [])
    semantic_weight = 3 if query_features["exact_lookup_intent"] else 5
    title_and_text_score = term_overlap_score(normalized_text, query_features["terms"]) * 2
    exact_phrase_score = sum(1 for phrase in query_features["exact_phrases"] if phrase and phrase in normalized_text) * 8
    equation_score = equation_overlap_score(normalized_text, query_features["equation_tokens"]) * 6
    section_score = section_marker_score(normalized_text, section_markers) * 12
    numbered_item_context_score = (
        4
        if query_features.get("numbered_item_lookup_intent")
        and has_numbered_item_context(normalized_text, material_type)
        else 0
    )
    page_score = (
        12
        if any(page_start <= page_number <= page_end for page_number in query_features["page_numbers"])
        else 0
    )
    requested_problem_numbers = exact_search_problem_numbers(query_features)
    has_requested_problem_match = content_has_requested_problem_number(searchable_text, requested_problem_numbers)
    has_section_and_problem_locator = bool(query_features["problem_numbers"] and query_features["section_markers"])
    problem_score = (
        (40 if has_section_and_problem_locator else 14)
        if has_requested_problem_match
        else 0
    )
    problem_miss_penalty = -18 if has_section_and_problem_locator and not has_requested_problem_match else 0
    exact_item_context_score = (
        10
        if has_section_and_problem_locator
        and has_requested_problem_match
        and has_numbered_item_context(normalized_text, material_type)
        else 0
    )

    return (
        vector_score * semantic_weight
        + title_and_text_score
        + exact_phrase_score
        + equation_score
        + section_score
        + numbered_item_context_score
        + exact_item_context_score
        + page_score
        + problem_score
        + problem_miss_penalty
        + material_preference_score(query_features, searchable_text=searchable_text, material_type=material_type)
    )


def has_numbered_item_context(normalized_text: str, material_type: str) -> bool:
    normalized_material_type = normalize_text(material_type)

    return bool(
        normalized_material_type in {"assignment", "practice-problems", "practice problems"}
        or re.search(
            r"\b(?:exercise|exercises|ex|problem|problems|question|questions|practice|worksheet|assignment|homework)\b",
            normalized_text,
        )
    )


def has_exact_lookup_match(query_features: dict[str, Any], result: PdfPageResult) -> bool:
    searchable_text = " ".join([result.title, result.section, result.chunk_text])
    normalized_text = normalize_text(searchable_text)
    requested_problem_numbers = exact_search_problem_numbers(query_features)
    has_problem_match = content_has_requested_problem_number(searchable_text, requested_problem_numbers)
    section_score = section_marker_score(
        normalized_text,
        most_specific_section_markers(query_features.get("section_markers") or []),
    )
    has_section_and_problem_locator = bool(query_features["problem_numbers"] and query_features["section_markers"])

    if has_section_and_problem_locator:
        return (
            any(result.page_start <= page_number <= result.page_end for page_number in query_features["page_numbers"])
            or has_problem_match
            or any(phrase and phrase in normalized_text for phrase in query_features["exact_phrases"])
        )

    return (
        any(result.page_start <= page_number <= result.page_end for page_number in query_features["page_numbers"])
        or has_problem_match
        or section_score > 0
        or any(phrase and phrase in normalized_text for phrase in query_features["exact_phrases"])
        or equation_overlap_score(normalized_text, query_features["equation_tokens"]) >= 0.75
    )


def section_related_top_k(query_features: dict[str, Any], requested_top_k: int) -> int:
    if query_features.get("textbook_section_intent"):
        return max(requested_top_k, SECTION_RELATED_TOP_K)

    return requested_top_k


def is_problem_locator_query(query: Any) -> bool:
    normalized = normalize_text(query)
    has_locator_word = bool(LOCATOR_WORD_RE.search(normalized))
    has_problem_signal = bool(PROBLEM_SIGNAL_RE.search(normalized))
    has_equation_signal = len(equation_tokens_from_text(normalized)) >= 2 or has_math_expression_signal(query)

    return has_locator_word and (has_problem_signal or has_equation_signal)


def has_math_expression_signal(query: Any) -> bool:
    text = ensure_text(query)
    return bool(MATH_EXPRESSION_SIGNAL_RE.search(text))


def exact_phrases_from_text(query: Any) -> list[str]:
    text = ensure_text(query)
    quoted_phrases = [
        phrase
        for match in EXACT_PHRASE_RE.finditer(text)
        for phrase in match.groups()
        if phrase
    ]

    return [normalize_text(phrase) for phrase in quoted_phrases if normalize_text(phrase)]


def material_preference_score(
    query_features: dict[str, Any],
    *,
    searchable_text: str,
    material_type: str,
) -> float:
    source_text = normalize_text(f"{material_type} {searchable_text}")

    if query_features.get("textbook_section_intent"):
        if TEXTBOOK_SOURCE_RE.search(source_text):
            return 8.0

        if ASSIGNMENT_SOURCE_RE.search(source_text):
            return -6.0

        return 0.0

    if not query_features.get("problem_locator_intent"):
        return 0.0

    if PROBLEM_LOCATOR_SOURCE_RE.search(source_text):
        return 8.0

    if TEXTBOOK_PREFERENCE_SOURCE_RE.search(source_text):
        return -4.0

    return 0.0


def ensure_text(value: Any) -> str:
    if value is None:
        return ""

    if isinstance(value, str):
        return value

    return str(value)


def normalize_text(text: Any) -> str:
    text = ensure_text(text)
    return NORMALIZE_TEXT_WHITESPACE_RE.sub(" ", NORMALIZE_TEXT_SYMBOLS_RE.sub(" ", text.lower())).strip()


def tokenize(text: Any) -> list[str]:
    stopwords = {
        "about",
        "from",
        "help",
        "need",
        "problem",
        "question",
        "show",
        "that",
        "this",
        "what",
        "with",
        "work",
    }
    return [term for term in normalize_text(text).split() if len(term) > 2 and term not in stopwords]


def term_overlap_score(text: str, terms: list[str]) -> float:
    if not terms:
        return 0.0

    return sum(1 for term in terms if term in text) / len(terms)


def problem_numbers_from_text(text: Any) -> set[str]:
    return set(cached_problem_numbers_from_normalized_text(ensure_text(text).lower()))


@lru_cache(maxsize=4096)
def cached_problem_numbers_from_normalized_text(normalized: str) -> tuple[str, ...]:
    numbers: set[str] = set()

    for pattern in PROBLEM_NUMBER_PATTERNS:
        for match in pattern.finditer(normalized):
            if len(match.groups()) >= 2 and match.group(2):
                numbers.add(f"{match.group(1)}.{match.group(2)}".upper())
            elif match.group(1):
                numbers.add(match.group(1).upper())

    bare_dotted_locator = BARE_DOTTED_PROBLEM_LOCATOR_RE.match(normalized)
    if bare_dotted_locator:
        numbers.add(f"{bare_dotted_locator.group(1)}.{bare_dotted_locator.group(2)}".upper())

    return tuple(sorted(numbers))


def page_numbers_from_text(text: Any) -> set[int]:
    return set(cached_page_numbers_from_normalized_text(ensure_text(text).lower()))


@lru_cache(maxsize=4096)
def cached_page_numbers_from_normalized_text(normalized: str) -> tuple[int, ...]:
    numbers = {
        int(match.group(1))
        for pattern in PAGE_NUMBER_PATTERNS
        for match in pattern.finditer(normalized)
        if int(match.group(1)) > 0
    }
    return tuple(sorted(numbers))


def section_markers_from_text(text: Any) -> tuple[dict[str, str], ...]:
    return tuple(
        {"kind": kind, "number": number}
        for kind, number in cached_section_markers_from_normalized_text(ensure_text(text).lower())
    )


@lru_cache(maxsize=4096)
def cached_section_markers_from_normalized_text(text: str) -> tuple[tuple[str, str], ...]:
    markers: list[dict[str, str]] = []
    seen: set[tuple[str, str]] = set()

    for kind, pattern in SECTION_MARKER_PATTERNS:
        for match in pattern.finditer(text):
            number = match.group(1).lower()
            key = (kind, number)

            if key in seen:
                continue

            seen.add(key)
            markers.append({"kind": kind, "number": number})

    return tuple((marker["kind"], marker["number"]) for marker in markers)


def is_textbook_section_query(query: Any, section_markers: tuple[dict[str, str], ...]) -> bool:
    if not section_markers:
        return False

    normalized = normalize_text(query)
    has_textbook_signal = bool(TEXTBOOK_SECTION_SIGNAL_RE.search(normalized))
    has_assignment_signal = bool(ASSIGNMENT_SIGNAL_RE.search(normalized))

    return has_textbook_signal and not has_assignment_signal


def section_marker_score(normalized_text: str, section_markers: tuple[dict[str, str], ...] | list[dict[str, str]]) -> float:
    if not section_markers:
        return 0.0

    score = 0.0

    for marker in section_markers:
        kind = marker.get("kind", "")
        number = marker.get("number", "")

        if not kind or not number:
            continue

        number_pattern = section_number_pattern(number)
        exact_kind_pattern = rf"\b{re.escape(kind)}\s*#?\s*{number_pattern}"

        if re.search(exact_kind_pattern, normalized_text):
            score += 1.0
            continue

        if re.search(number_pattern, normalized_text) and SECTION_CONTEXT_RE.search(normalized_text):
            score += 0.75
            continue

        if re.search(number_pattern, normalized_text):
            score += 0.35

    return min(score, 1.5)


def exact_search_problem_numbers(query_features: dict[str, Any]) -> set[str]:
    base_requested = {str(number).upper() for number in query_features.get("problem_numbers") or []}
    composite_requested: set[str] = set()

    for marker in query_features.get("section_markers") or []:
        section_number = str(marker.get("number") or "")

        if not DIGITS_1_TO_3_RE.fullmatch(section_number):
            continue

        for problem_number in query_features.get("problem_numbers") or []:
            normalized_problem_number = str(problem_number).lower()

            if PROBLEM_SUFFIX_RE.fullmatch(normalized_problem_number):
                composite_requested.add(f"{section_number}.{normalized_problem_number}".upper())

    return composite_requested or base_requested


def content_has_requested_problem_number(text: Any, requested_problem_numbers: set[str]) -> bool:
    source = ensure_text(text)

    for problem_number in requested_problem_numbers:
        if problem_number_contains_dotted_parts(problem_number):
            if re.search(labeled_dotted_problem_number_pattern(problem_number), source, flags=re.IGNORECASE):
                return True

            if re.search(dotted_problem_item_pattern(problem_number), source, flags=re.IGNORECASE):
                return True

            continue

        if problem_number.upper() in problem_numbers_from_text(source):
            return True

    return False


def problem_number_contains_dotted_parts(problem_number: str) -> bool:
    return "." in problem_number


@lru_cache(maxsize=256)
def dotted_problem_number_pattern(problem_number: str) -> str:
    parts = [re.escape(part) for part in problem_number.lower().split(".") if part]
    flexible_number = r"\s*\.\s*".join(parts)
    return rf"(?<![\d.]){flexible_number}(?!\s*\.\s*\d)(?=\s*[\).:]|\s|$)"


@lru_cache(maxsize=256)
def labeled_dotted_problem_number_pattern(problem_number: str) -> str:
    parts = [re.escape(part) for part in problem_number.lower().split(".") if part]
    flexible_number = r"\s*\.\s*".join(parts)
    return (
        rf"\b(?:problem|problems|exercise|exercises|ex\.?|question|questions|number|no\.?)"
        rf"\s*#?\s*{flexible_number}(?!\s*\.\s*\d)\b"
    )


@lru_cache(maxsize=256)
def dotted_problem_item_pattern(problem_number: str) -> str:
    parts = [re.escape(part) for part in problem_number.lower().split(".") if part]
    flexible_number = r"\s*\.\s*".join(parts)
    item_start = (
        r"give|giv|prove|show|let|find|determine|compute|suppose|consider|verify|"
        r"establish|use|assume|recall|for|if|what|which|why|does"
    )
    return rf"(?<![\d.(]){flexible_number}\s*[\).:]\s*(?=(?:{item_start})\b)"


def most_specific_section_markers(
    section_markers: tuple[dict[str, str], ...] | list[dict[str, str]],
) -> tuple[dict[str, str], ...]:
    marker_keys = {
        (str(marker.get("kind") or ""), str(marker.get("number") or ""))
        for marker in section_markers
    }
    filtered: list[dict[str, str]] = []

    for marker in section_markers:
        kind = str(marker.get("kind") or "")
        number = str(marker.get("number") or "")

        if any(
            other_kind == kind and other_number.startswith(f"{number}.")
            for other_kind, other_number in marker_keys
        ):
            continue

        filtered.append(marker)

    return tuple(filtered)


@lru_cache(maxsize=256)
def section_number_pattern(number: str) -> str:
    return rf"(?<![\d.]){re.escape(number)}(?![\d.])"


def equation_tokens_from_text(text: Any) -> set[str]:
    text = ensure_text(text)
    normalized = normalize_text(text)
    alias_haystack = f"{text.lower()} {normalized}"
    tokens = {
        normalize_equation_token(token)
        for token in EQUATION_TOKEN_RE.findall(text)
    }

    for pattern, aliases in MATH_TERM_ALIASES:
        if pattern.search(alias_haystack):
            tokens.update(aliases)

    return {token for token in tokens if token}


MATH_TERM_ALIASES: tuple[tuple[re.Pattern[str], set[str]], ...] = (
    (re.compile(r"(?:\\sqrt\b|\bsqrt\b|\bsquare\s+root\b|√)"), {"sqrt", "square_root"}),
    (re.compile(r"(?:\\int\b|\bint\b|\bintegral\b|∫)"), {"int", "integral"}),
    (re.compile(r"(?:\\lim\b|\blim\b|\blimit\b)"), {"lim", "limit"}),
    (re.compile(r"\b(?:derivative|differentiate|differentiating|differentiation)\b"), {"derivative", "differentiate"}),
)


def normalize_equation_token(token: str) -> str:
    normalized = token.lower().removeprefix("\\")

    if normalized == "√":
        return "sqrt"

    if normalized == "∫":
        return "int"

    if normalized == "∞":
        return "infinity"

    return normalized


def equation_overlap_score(text: str, query_equation_tokens: set[str]) -> float:
    if not query_equation_tokens:
        return 0.0

    content_equation_tokens = equation_tokens_from_text(text)
    return len(query_equation_tokens.intersection(content_equation_tokens)) / len(query_equation_tokens)
