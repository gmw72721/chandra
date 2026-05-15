# Tutor Bot Runtime Cases

This document maps the cases Chandra can run through in the current AI tutor code, plus the student-facing section types the UI can render.

Primary code references:

- `backend/agent/graph.py`: LangGraph tutor runtime, retrieval decisions, structured output cleanup, answer-leak gate, memory updates.
- `backend/main.py`: shared tutor system prompt construction, policy normalization, source-use rules, response-shape instructions.
- `frontend/app/api/chat/route.ts`: chat API schema, streaming shape, frontend prompt copy for structured responses.
- `frontend/lib/tutor-response.ts`: client-side normalization of structured tutor output.
- `frontend/app/student/page.tsx`: rendering of assistant message bubbles, structured sections, choices, and source chips.
- `frontend/app/styles.css`: visual treatment for the structured sections.

## Runtime Flow Cases

### 1. Load chat retrieval memory

The graph starts by loading conversation retrieval memory. This can provide an active source/page/problem record so Chandra can answer follow-ups like "what page was that?" or "give me a hint for this one" without immediately searching again.

Graph path:

```text
START -> load_chat_retrieval_memory -> primary_tutor_turn
```

### 2. Primary tutor answers immediately

The primary tutor call can answer without OCR/PDF retrieval when the request is already answerable from the latest message, chat history, active memory, or attached academic upload.

Typical cases:

- Greeting or check-in.
- Simple course-related conceptual question that does not need PDF context.
- Vague help or first stuck message where a light nudge is enough.
- Answer-shopping refusal.
- Clarification request.
- Follow-up that can use active retrieval memory.
- Class-relevant upload that the primary call can inspect directly.
- Off-topic or unrelated upload redirect.

Graph path:

```text
primary_tutor_turn -> prepare_metadata_context -> save_chat_retrieval_memory
```

When no search is needed, `structured_output_override` may become the complete student-facing reply.

### 3. Primary tutor requests class-material retrieval

The primary tutor sets `needs_search: true` when exact OCR/PDF metadata is needed.

Search is preferred for:

- Problem, exercise, question, page, section, chapter, worksheet, assignment, quiz, exam, rubric, table, diagram, passage, theorem, definition, formula, note, reading, textbook, or example references.
- Bare numbered locators such as `2.20`.
- Requests to find, read, quote, pull up, identify, locate, restate, or show source text.
- Concrete assignment/problem requests where source matching matters.
- Similar example requests when class PDFs may contain examples.
- Follow-ups to prior source-backed answers when the active metadata is not enough.

Graph path:

```text
primary_tutor_turn -> search_ocr_metadata -> prepare_metadata_context -> context_grounded_answer -> save_chat_retrieval_memory
```

While search is pending, visible output is intentionally minimal, such as "I'm checking the class materials for that problem." It should not ask the student to paste/upload the problem before available OCR metadata has been searched.

### 4. Context-grounded answer after retrieval

After retrieval, the context-grounded answer call uses selected OCR metadata, page assets, Knowledge items, and relevant upload/file parts. It must obey the `tutorPlan` chosen by the primary tutor turn instead of replanning help depth.

This call handles:

- Returning exact problem/source text.
- Giving source-grounded hints or explanations.
- Teaching from selected textbook/reading/example context.
- Responding to selected upload content.
- Explaining when selected sources are insufficient or mismatched.

The context-grounded call cannot search again. If the selected records do not contain the needed item, it should say what exact source/page/problem/text is missing.

### 5. Save chat retrieval memory

Every graph route ends by saving updated retrieval/problem memory.

Saved memory can include:

- Active PDF/material and page.
- Active problem id and problem metadata.
- Sources used.
- Failed searches.
- Retrieval reason.
- Knowledge items.
- Problem understanding state.

## Retrieval Decision Cases

### `student_requested_problem`

Used when the student asks for a specific problem, exercise, question, page, section item, passage, or source wording.

Expected behavior:

- Search exact task/source metadata first.
- If found, return the visible task text without solving it.
- For problem/exercise/prompt lookup, put only the academic task statement in `Problem`.
- Leave hints empty unless the student separately asks for solving help; put any brief offer or immediate action in the main answer instead of a separate next-step section.

### `student_changed_problem`

Used when memory has an active problem, but the latest message points to a different problem/source item.

Expected behavior:

- Search for the new exact task.
- Do not keep tutoring the previous active problem.

### `needed_supporting_page`

Used when Chandra needs method, rule, definition, theorem, textbook, notes, or reading support.

Expected behavior:

- Retrieve method/source context.
- Use source context to scaffold, not to dump a complete final answer.
- If retrieval only locates the assignment and not method support, give limited help or explain the source gap.

### `needed_example_page`

Used when the student asks for an example, worked example, similar problem, or model of the method.

Expected behavior:

- Search example-oriented class material.
- Give a similar but non-identical example.
- Do not use the exact assigned task as the worked example.

### `previous_search_failed`

Used when the same normalized query already failed in memory.

Expected behavior:

- Skip repeating the failed search.
- Answer from available memory/context or ask for the missing source detail only after the previous search is known to have failed.

## Student Intent Cases

The tutor plan classifies the latest student turn as one of these intents:

| Intent | Typical trigger | Default response shape |
| --- | --- | --- |
| `vague_help` | "help", "I'm stuck", "lost", "confused" | One light nudge or one question. Usually no labeled sections. |
| `specific_question` | A focused course question | Direct answer or guided hint, with optional supporting section. |
| `showed_work` | Student provides work, equations, reasoning, or "I tried..." | Inspect work neutrally; usually `Check your work` or targeted feedback. |
| `unclear_attempt` | Tiny/ambiguous attempt such as "2?" | Explain expected answer form/type without revealing value; ask a smaller sub-question. |
| `asks_for_next_step` | "what next?", "where do I go?" | One next small action inside the current step, not a later step. |
| `asks_for_solution` | "give me the answer", "write this", final-artifact request | Refuse/redirect; ask for attempt or offer similar example. |
| `asks_for_explanation` | "explain", "why", "walk me through" | Conceptual explanation within help-depth and policy limits. |
| `verification` | "is this right?", "check my work" | Internal evaluation, but no direct correctness verdict unless policy allows. |

## Tutor Mode Cases

Structured output metadata can expose one of these modes:

| Mode | When used | Student-facing behavior |
| --- | --- | --- |
| `guided_problem_solving` | Default mode | Progressive disclosure; one small piece at a time. |
| `socratic` | Socratic policy or short answer with a next question | Lead with a focused question before explaining. |
| `check_work` | Student asks for validation or shows work | Review the work neutrally; point to what to justify or tighten. |
| `reading_helper` | Reading, definition, example, diagram, or textbook language support | Interpret source language and help connect it to the course task. |
| `exam_review` | Exam/quiz/review language | Concise, practice-oriented, focused on problem type and traps. |
| `source_lookup` | Found or discussed source/page/problem text | Extract, locate, cite, or explain selected source context. |
| `direct_answer_refusal` | Answer-only or homework-ready artifact request | Refuse final answer and redirect to attempt, check-work, or similar example. |
| `clarification` | Needed source/problem/request detail after available context is insufficient | Ask one focused clarification question. |
| `off_topic_redirect` | Non-course topic or unrelated personal image/upload | Briefly redirect back to the class. |

Teacher policy titles also shape behavior:

- `Guided problem solving`: start from student work or ask the student to choose the next move.
- `Socratic`: lead with one focused question before explaining.
- `Check my work`: evaluate internally, then identify a step to justify or tighten without direct verdict labels.
- `Exam review`: concise, practice-oriented help.
- `Reading helper`: interpret definitions, examples, diagrams, and textbook/source language.

## Help Depth Cases

`TutorPlan.nextHelpDepth` controls how much help the current turn may give.

| Depth | Meaning | Allowed shape |
| --- | --- | --- |
| 1 | Light help | One conceptual nudge and one question; no full route, proof skeleton, or worked algebra. |
| 2 | Guided hint | A targeted hint and possibly one clear next action. |
| 3 | One worked step | Work exactly one step, explain why it is valid, then stop and ask the student to continue. |
| 4 | Full explanation | Only when teacher policy permits and the student explicitly asks or full-teaching mode is enabled. |

Configured understanding levels cap the maximum help:

| Understanding level | Default max help |
| --- | --- |
| 0 | `ask_for_attempt_only` |
| 1 | `light_hint` |
| 2 | `targeted_hint_next_action` |
| 3 | `one_worked_step` |
| 4 | `check_work_explain_gaps` |

Supported help-limit labels:

- `ask_for_attempt_only`
- `conceptual_orientation`
- `guiding_question`
- `light_hint`
- `targeted_hint_next_action`
- `one_worked_step`
- `check_work_explain_gaps`
- `full_explanation_allowed`

## Source and Upload Cases

### Exact source lookup

Student asks to see, read, copy, quote, recite, identify, locate, restate, or ask what a source item says.

Expected output:

- Found: return the exact visible source wording.
- For problem/exercise/prompt lookup: use `Problem` only for the task statement.
- Not found: do not fabricate; briefly say what is missing or mismatched.
- Do not solve, prove, complete, or apply the task in this lookup-only path.

### Bare numbered locator

Examples: `2.20`, `problem 4`, `page 12`.

Expected output:

- Treat as source lookup before asking for more source detail.
- Search available class OCR metadata.
- Do not ask for page photo, textbook title, full problem text, or worksheet title before searching.

### Student-uploaded academic file

Applies to homework, notes, worksheets, problems, diagrams, readings, and other class tasks.

Expected output:

- Inspect attached image/file parts directly when available.
- If one problem is visible and selected, copy the full visible task statement exactly into `Problem`.
- If multiple problems are visible and no single problem is selected, ask which one.
- If visible numbered choices exist, use `confusionChoices` with `choiceDisplay: "problem_selection"`.

### Student-uploaded unrelated personal image

Examples: pets, people, rooms, food, memes, scenery.

Expected output:

- Do not describe, rate, react to, identify, or discuss the image.
- Briefly redirect back to the course.

## Choice Flow Cases

### Problem selection choices

Used when an uploaded page has multiple visible problems/exercises/questions and Chandra cannot infer which one to tutor.

Structured output:

- `confusionPrompt`: short sentence asking which problem to start with.
- `confusionChoices`: one object per visible problem number when numbers are readable.
- `metadata.choiceDisplay: "problem_selection"`.
- Each choice `label` should usually be just the number, such as `2.14`.
- Each choice `message` should be student-sendable, such as `Help me with problem 2.14 from this upload.`

Problem selection can have up to 80 choices.

### Chandra uncertainty choices

Used when Chandra is uncertain which support path would help, not merely because the student says they are confused.

Allowed only when:

- Retrieval is not required first.
- There is a real ambiguity in support path.
- Active problem/current step/history are insufficient or conflicting.
- A normal single response would likely guess at the student's need.

Not used when:

- A clear current step/substep exists.
- The student showed inspectable work.
- The student asks a clear concept question.
- The student asks for source lookup.
- The student is answer-shopping.
- The student only greets/checks in.

Generic uncertainty choices must include 2 to 6 choices.

## Debug Override Cases

Teacher-preview debug options can force branches:

| Debug option | Effect |
| --- | --- |
| `forceRetrieval` | Force at least one retrieval query, usually `needed_supporting_page` unless another reason is clearer. |
| `forceNoRetrieval` | Do not retrieve; answer only from visible chat/context and name uncertainty if source lookup would normally be needed. |
| `forceConfusionChoices` | Force uncertainty choices unless retrieval is required first. |

## Answer Integrity Cases

### Direct answer or final artifact request

Requests like "just give me the answer", "write the proof", "write this for my homework", "give me an example of what I can say", sentence starters, outlines, proof scaffolds, full code, full essays, or all-parts breakdowns for the exact task are treated as answer-shopping.

Expected output:

- Refuse the final answer or submission-ready artifact.
- Ask what the student tried or where they are stuck.
- Offer to check work or walk through a meaningfully different similar example.

### Attempt-first required

If a student asks for help on a graded-looking exact task and has not shown work:

- First ask what they tried or where they are stuck.
- Do not provide task-specific starting points, intermediate values, thesis claims, code, solution structure, proof structure, or exact next steps.
- Concept explanations and similar examples are allowed only when they do not complete the exact assigned task.

### Check-work / verification

When the student shows work or asks if something is right:

- Evaluate internally.
- Avoid verdict labels like `correct`, `incorrect`, `right`, `wrong`, `yes`, `no`, `that's the answer`, or `the mistake is` unless teacher policy explicitly allows answer checking.
- Use process language such as "One place to tighten is..." or "Can you justify this step?"

### Answer leak fallback

The backend runs an answer-leak gate after final structured output is built. If the answer appears to exceed policy by giving a final answer or solution chain, it rewrites or falls back to:

```text
I can't give the full answer here, but I can help you take the next step. Show me what you tried first, or tell me which part feels confusing.
```

## Student-Facing Section Types

The structured output schema supports these section keys:

| Key | Rendered label | UI kind/class | Purpose | Important constraints |
| --- | --- | --- | --- | --- |
| `mainText` | None | `answer` bubble | Unlabeled answer text, including the student's immediate action or direct request when one is needed. | Do not duplicate section text here, especially problem statements. |
| `answer` | Usually none, or `Answer` when separate from main text | `answer` or `section-answer` | Direct response when a separate answer section is useful, including any immediate action if it naturally belongs with the answer. | Do not force a visible `Answer:` label in prose. |
| `problem` | `Problem` | `problem` | Exact academic exercise/question/task statement. | Extraction only. No hints, offers, source notes, lookup status, attempt requests, or next steps. |
| `hint` | `Hint` | `hint` | One short nudge or leading question. | No citations, definitions, offers, or multiple ideas. Avoid repeating the main answer. |
| `explanation` | `Why this works` | `explanation` | Conceptual reasoning. | No offers, workflow prompts, or attempt requests. |
| `formula` | `Formula` | `formula` | One rule, theorem, identity, equation, or symbolic statement. | No explanatory prose, examples, filled-in task values, hints, source notes, or why/when commentary. |
| `example` | `Similar example` | `example` | Similar but different example. | Must not be a submittable version of the exact task. |
| `checkWork` | `Check your work` | `check-work` | Neutral feedback on shown work. | No direct verdict labels unless policy allows answer checking. |
| `sourceNote` | `Source` | `source-note` | Source/context note when source detail is the student's direct request or adds needed context. | Do not invent titles, page numbers, quotes, citations, or source facts. |

The UI also renders:

- `confusionPrompt`: optional prompt shown above choice buttons if it is not already displayed in the answer.
- `confusionChoices`: clickable student-sendable options.
- Source chips: rendered separately from section text when `sources` are present.

## Section Ordering Rules

- `sectionOrder` chooses the render order.
- Include only non-empty keys.
- Include `mainText` when the unlabeled message body is non-empty.
- If `problem` is present, put it first.
- Put the student's immediate action or direct request at the end of `mainText` or `answer` when it is needed.
- Use sections only when they add distinct value.
- A strong early/light-help reply is often just one short answer or question with no labeled sections.
- Do not repeat the same idea across `answer`, `hint`, and `explanation`.

Common useful orders:

```json
["problem", "answer"]
["problem", "answer", "sourceNote"]
["answer", "hint"]
["answer", "formula", "example"]
["checkWork", "answer"]
["answer", "explanation"]
```

## Structured Metadata Types

### Hint levels

- `none`
- `small_hint`
- `guided_step`
- `worked_example`
- `refusal`

### Student action needed

- `none`
- `show_attempt`
- `try_next_step`
- `answer_question`
- `review_source`
- `paste_problem`
- `ask_teacher`

### Source confidence

- `high`
- `medium`
- `low`

### Problem metadata

Structured output may include:

- `problemNumber`
- `problemSummary`
- `problemContext`
- `referencedSources`

`problemContext` supports:

- `relation`: `same_problem`, `different_problem`, `unknown`
- `source_type`: `assignment_question`, `pdf`, `uploaded_image`, `conversation_extracted`, `unknown`
- `confidence`: `low`, `medium`, `high`
- `problem`
- `expected_answer`
- `source_document_id`
- `source_page`

## Response Format Settings

Teacher/class settings can change response behavior:

| Setting | Effect |
| --- | --- |
| `oneStepAtATime` | Ask one targeted question or give one small nudge, then pause. |
| `endWithCheckQuestion` | End with a brief student action or check question when natural. |
| `simpleWording` | Use simpler wording and define specialized terms briefly. |
| `exampleFrequency` | `rarely`, `whenHelpful`, or `often`. |
| `mathNotation` | `plain`, `balanced`, or `symbolic`. |

Model settings also influence detail:

- `brief`: a few concise sentences unless more is requested.
- `standard`: focused chat-length answer.
- `detailed`: fuller explanation with clear steps.
- `veryDetailed`: multi-step explanations and relevant source passages when allowed.

## Output Cleanup and Normalization

Before the UI receives the reply, the backend and frontend normalize it:

- Unknown section keys are dropped.
- Empty sections are omitted.
- Duplicated problem text is suppressed from `mainText`.
- Misplaced problem/status text can be repaired or removed.
- Duplicate advice across sections can be suppressed.
- `Problem` sections are validated to look like academic task text.
- Legacy separate-action content is normalized away when it contains retrieval status or duplicated hint text; new responses should place immediate actions in `mainText` or `answer`.
- Choice prompts replace answer text when choice buttons are being displayed.
- Validation verdicts are neutralized in structured output when needed.

## Quick Case Matrix

| Student says/does | Runtime case | Likely mode | Likely sections |
| --- | --- | --- | --- |
| "Hi" | Direct primary answer | `guided_problem_solving` | `mainText` only |
| "I'm lost" | Direct primary answer, light help | `guided_problem_solving` or `socratic` | `mainText` or `hint` |
| "Can you pull up 2.20?" | Retrieval, exact source lookup | `source_lookup` | `problem`, maybe `answer`/`sourceNote` |
| "What page is problem 4 on?" | Retrieval or memory lookup | `source_lookup` | `mainText` or `sourceNote` |
| Uploaded page with many numbered problems | Problem selection choices | `clarification` | `answer` plus `confusionChoices` |
| "Help me with problem 2.14 from this upload" | Direct upload inspection, maybe no retrieval | `guided_problem_solving` | `problem`, then limited `answer`/`hint` if solving help is asked |
| "Just give me the answer" | Refusal | `direct_answer_refusal` | `mainText` only or `answer` |
| Student shows work | Check work | `check_work` | `checkWork`, maybe `answer` with the immediate action |
| "Show me an example" | Example retrieval | `guided_problem_solving` | `example`, maybe `answer` |
| "Explain why this works" | Direct or source-grounded explanation | `reading_helper` or `guided_problem_solving` | `answer`, `explanation`, maybe `formula` |
| Unrelated personal image | Redirect | `off_topic_redirect` | `mainText` only |
| Source mismatch/not found | Context-grounded not-found | `clarification` or `source_lookup` | `mainText` or `sourceNote` |
| Debug force retrieval | Forced retrieval branch | Depends on result | Minimal status, then normal final sections |
| Debug force choices | Forced uncertainty choices | `clarification` | `answer` plus `confusionChoices` |
