# Tutor Knowledge and Understanding Update Cases

This file documents every runtime case I found where the AI tutor updates conversation knowledge, active problem context, or student understanding. It is based on the current code, mainly:

- `backend/agent/graph.py`
- `backend/agent/knowledge.py`
- `frontend/lib/student-conversations-server.ts`
- `frontend/lib/chat-context-memory.ts`
- `frontend/lib/student-learning-profiles-server.ts`
- `frontend/lib/understanding-state.ts`

## Main Storage Locations

The tutor stores runtime memory in several places:

| Area | Stored data | Main writer |
| --- | --- | --- |
| Firestore conversation `knowledgeMemory` / `retrievalMemory` | Active PDF/problem/page memory, knowledge items, failed searches, retrieval history, per-problem understanding states | `save_chat_retrieval_memory()` in `backend/agent/graph.py` |
| Firestore conversation `activeKnowledgeContext` / `activeProblemContext` | Current active problem text and source metadata | `save_active_problem_context()` in `backend/agent/graph.py` |
| Assistant message `langGraphTrace` | Per-message trace copy of `knowledgeItems` and `problemUnderstandingState` | `pdf_rag_response_from_state()` in `backend/agent/graph.py`, persisted by `saveAssistantMessage()` |
| Postgres conversation metadata `currentContext` | Frontend summary of current problem, PDF, sources, failed searches | `saveConversationCurrentContext()` in `frontend/lib/student-conversations-server.ts` |
| Student learning profile | Longer-term teacher-reviewed learning profile and strategy notes | `updateOneStudentLearningProfile()` in `frontend/lib/student-learning-profiles-server.ts` |

## Conversation Knowledge Updates

Knowledge items are rebuilt from the final tutor state by `knowledge_items_from_state()` and saved into conversation memory. Previous knowledge items are merged and deduped, with the final list capped at 12 items.

### 1. Active Problem From LLM-Verified Problem Context

The tutor now treats the LLM's explicit problem decision as the authority for pasted or uploaded problem text. The primary tutor call is expected to emit:

```json
{
  "activeProblemDecision": {
    "isActualProblem": true,
    "problemText": "Problem 2.14. ...",
    "problemSource": "pasted_text | student_upload | retrieved_pdf | existing_context | none",
    "relationToPreviousProblem": "same_problem | same_problem_new_part | same_problem_student_moved_ahead | new_problem | not_a_problem | unclear",
    "confidence": "low | medium | high",
    "reason": "Why the model believes this is or is not an actual academic problem.",
    "visibleParts": ["a", "b", "c"],
    "currentPart": "b",
    "completedParts": ["a"]
  }
}
```

The backend validates the shape, length, and allowed enum values, but it no longer uses `looks_like_pasted_problem()` or upload OCR heuristics to prove that pasted/uploaded text is a real problem.

The tutor creates or refreshes an `active_problem` knowledge item when it has verified active problem text from:

- `activeProblemDecision.problemText`.
- `structuredOutput.sections.problem` in the final tutor response.
- Parsed problem context from the generated answer.
- Existing `active_problem_context.problem_text`.

The item is `kind: "problem"` and `usedAs: "active_problem"`.

### 2. Student-Pasted Problem

A pasted message becomes active problem knowledge only when the LLM returns `activeProblemDecision.isActualProblem: true` with the exact task text in `problemText`, or when a later structured response returns a valid `Problem` section.

This keeps notes, partial work, casual text, and non-problem screenshots from becoming the active problem just because they contain problem-like words.

### 3. Student-Uploaded Problem or Source

An upload can still become a `student_upload` knowledge item when it has extracted text, OCR text, summary, file name, file type, or MIME type. That item does not by itself prove the upload is the active problem.

Upload `usedAs` is chosen as follows:

- Explicit `usedAs` / `used_as` wins if present and valid.
- `student_attempt` if the upload or latest message contains attempt language, or the message mode says "Show my work".
- `supporting_context` otherwise.

If the upload contains a real problem, the LLM must verify that through `activeProblemDecision` and copy the visible task text into `problemText`.

### 4. Retrieved PDF Page

Every used page asset with OCR/chunk text becomes a `kind: "pdf_page"` knowledge item.

The `usedAs` value is inferred from explicit page metadata first, otherwise from retrieval reason, material type, title, and OCR text:

- `example_reference` for example or worked-example pages.
- `theorem_reference` for theorem, lemma, proposition, or corollary pages.
- `definition_reference` for definition or terminology pages.
- `problem_source` for pages with problem numbers, exact-problem lookup, requested-problem retrieval, or problem-number text.
- `supporting_context` otherwise.

Student UI implication: source chips use this `usedAs` label to describe how the page was used, for example `Problem source`, `Example reference`, `Theorem reference`, `Definition reference`, or `Supporting context`. Teacher/debug views can still inspect the raw `knowledgeItems`.

### 5. Failed Search Memory

If a search runs and no pages are retrieved, `build_next_chat_retrieval_memory()` appends a failed-search record with:

- query
- retrieval reason
- timestamp

This lets later turns avoid repeating the same failed OCR search.

### 6. Retrieval Reason History

Every tutor turn appends retrieval decision metadata into `reason_history`, including:

- decision source
- whether memory was used
- retrieval reason
- timestamp

This is not shown directly as a knowledge item, but it changes future routing and memory behavior.

### 7. Selected Metadata and Active PDF/Page Memory

This is source continuity memory: the tutor remembers which class source, page, and problem are currently in play so follow-ups can be resolved without starting from scratch.

Example:

- Student asks for problem 2.14.
- Retrieval finds printed page 17 of `Homework 2.pdf`.
- Memory stores that PDF/page/problem as active.
- If the student then asks "what about part b?", the tutor can keep using problem 2.14 and move to part b instead of asking which problem they mean.

When page assets are used, `build_next_chat_retrieval_memory()` refreshes:

- `active_metadata`
- `active_pdf_material`
- `active_problem`
- `active_page`
- `active_page_asset`
- `retrieved_metadata`

The first selected metadata record becomes the active record unless there is no new record, in which case prior active metadata is retained.

For multi-part problems, finishing part a does not complete the problem if parts b/c/etc remain. Part progress is tracked separately through `visibleParts`, `currentPart`, and `completedParts`.

### 8. Frontend Conversation Current Context

After an assistant message is saved, `saveConversationCurrentContext()` rebuilds Postgres conversation metadata from saved messages.

It updates `currentContext` only when there is meaningful context, such as:

- active PDF id/name
- active problem id/number/text
- active page number
- saved problems
- sources used
- failed searches
- retrieval reason

This is a frontend-facing summary, separate from backend `knowledgeMemory`.

## Active Problem Context Updates

`update_active_problem_context()` writes `activeKnowledgeContext` / `activeProblemContext` when `next_active_problem_context()` decides there is a current problem worth storing.

### 1. Same Problem Confirmed

If parsed context says `relation: "same_problem"` and an existing context exists:

- The existing context is refreshed.
- `problem_text` is filled only if it was missing.
- `last_confirmed_message_id` and `updated_at` are updated.

### 2. Different Problem With Medium or High Confidence

If the LLM says `relationToPreviousProblem: "new_problem"` and provides problem text with medium/high confidence, the backend treats this as a different problem:

- A new active problem context is created.
- The problem id is a stable hash of the problem text.
- Source type, source document id, source page, source chunk id, expected answer, and message ids are recorded when available.

### 3. First Problem With No Existing Context

If there is no existing active context and parsed problem text exists:

- A new active problem context is created even if relation/confidence are weaker.

### 4. Same Problem, New Part or Student Moved Ahead

If the LLM says `same_problem_new_part` or `same_problem_student_moved_ahead`:

- The problem id stays the same.
- `current_part`, `visible_parts`, and `completed_parts` are refreshed.
- The tutor can advance the current step only when the student's work or selected part shows they actually moved ahead.

### 5. No Update

No active problem context is written when:

- There is no problem text.
- The parsed context is not same-problem refreshable.
- It is a different problem without medium/high confidence.
- The next context equals the existing context.

## Understanding State Updates

The tutor stores understanding per active problem in `knowledgeMemory.problem_understanding_states`. The current turn also returns `langGraphTrace.problemUnderstandingState`.

The primary tutor model owns the proposed update through `tutorPlan.stateUpdates`. The backend normalizes and protects it with `state_after_tutor_plan()`.

### Understanding Fields

The normalized state can contain:

- `activeProblemId`
- `understandingLevel` from 0 to 4
- `attemptsCount`
- `hintsGiven`
- `lastHelpDepth`
- `conceptsUnderstood`
- `knownConfusions`
- `repeatedStuckSignals`
- `answerSeekingRisk`
- `currentStep`
- `currentStepStatus`
- `completedSteps`
- `visibleParts`
- `currentPart`
- `completedParts`
- `problemStatus`
- `lastHintSummary`
- `lastStudentAttemptSummary`
- `updatedAt`

### Level 0: Problem Loaded, No Work Observed

Level 0 is allowed for source lookup or a freshly loaded problem before tutoring starts.

Source-lookup-only means:

- `needsRetrieval` is true.
- `retrievalReason` is `student_requested_problem` or `student_changed_problem`.
- `studentIntent` is not a help/work intent such as vague help, showed work, next-step request, solution request, explanation request, or verification.

In source-lookup-only turns:

- The level can stay 0.
- `hintsGiven` is not automatically incremented.
- Existing progress for the same problem is preserved instead of reset.

Understanding is stored per problem id in `problem_understanding_states`, so working on problem 2.14 and then problem 3.9 creates separate progress records. Returning to problem 2.14 restores that problem's prior state.

### Level 1: Help Started With Little or No Useful Work

If the student asks for help, explanation, next step, solution, verification, or shows/attempts work on an active problem, a model-proposed level 0 is promoted to at least level 1 unless the turn is source-lookup-only.

Examples from tests:

- "help me" on an active problem becomes level 1.
- "can you explain this?" with an active problem becomes level 1.
- answer-seeking such as "just give me the answer" can remain low-depth with `answerSeekingRisk: "high"`.

### Levels 2, 3, and 4: Evidence-Based Progress

The tutor may increase understanding above the current level only when the latest student turn provides evidence. Accepted evidence is:

- `studentIntent` is `showed_work` or `verification`.
- And at least one of these is present:
  - `lastStudentAttemptSummary`
  - `conceptsUnderstood`
  - `knownConfusions`
  - `completedSteps`
  - `currentStepStatus: "completed"`

Levels mean:

- 2: Student understands setup but is missing the core idea.
- 3: Student understands the core idea but needs execution help.
- 4: Student is solution-ready and mostly needs verification or cleanup.

The level may jump by more than one step in a single update, including 0 to 2, 0 to 3, 0 to 4, 1 to 3, or 1 to 4.

### Unsupported Increase Is Blocked

The backend refuses to increase understanding when the evidence requirement is not met.

Examples:

- Repeated stuck messages do not raise understanding.
- Another hint from Chandra does not raise understanding.
- More retrieval context does not raise understanding.
- A clearer tutor explanation does not raise understanding.

### Same-Problem Decrease Is Blocked

For the same active problem, if current level is above 0:

- A lower proposed level is ignored.
- A proposed reset to 0 is ignored.
- Ordinary confusion does not lower the stored level.

The prompt says a true decrease should require explicit retraction or contradictory new work, but the backend protection currently preserves the old level for same-problem decreases.

### Attempts Count

`attemptsCount` updates in two ways:

- The model can set it directly in `stateUpdates`.
- If not set, the backend increments it automatically when `studentIntent` is `showed_work`.

### Hints Given

`hintsGiven` now increments from rendered output, not just planned intent.

It increments only when the final student-visible response actually contains tutoring help such as:

- a `Hint` section
- an example reference
- check-work scaffold
- a worked micro-step
- a guided-step or small-hint response

It does not increment for source lookup, problem text display, search-status messages, pure clarification, or answer-leak refusal without a real hint.

The backend also avoids counting a hint when `lastHintSummary` substantially repeats the previous hint summary for the same problem. The prompt tells the LLM to take a step back and provide a narrower or different support move when the student is still stuck.

### Repeated Stuck Signals

`repeatedStuckSignals` updates in two ways:

- The model can set it directly in `stateUpdates`.
- If not set, the backend increments it automatically when:
  - `studentIntent` is `vague_help`, `asks_for_next_step`, or `unclear_attempt`.
  - The current state already has at least one hint.

### Current Step

`currentStep` and `currentStepStatus` come from `stateUpdates` when present. Otherwise, the backend copies them from the top-level `tutorPlan`.

`currentStep` is a guideline, not a rigid cage:

- If the student only asks "what's the next step?", the tutor should not advance automatically.
- If the student shows work from a later step, selects a later part, or otherwise proves they moved ahead, the tutor should update `currentStep`.
- If the student is stuck, the tutor should stay on the same current step but make the next hint narrower or more diagnostic.

### Completed Steps

`completedSteps` is only updated when the model includes it in `stateUpdates`. This allows the tutor to record that one step is complete while moving the current step to the next part.

### Answer-Seeking Risk

`answerSeekingRisk` is normalized to `low`, `medium`, or `high`.

It is taken from `tutorPlan.answerSeekingRisk` first, falling back to the existing state. The model can also include it in `stateUpdates`.

High risk does not mean "refuse and stop." It means the LLM should pause and choose a safer teaching move:

- avoid final-answer leakage
- ask for the student's attempt
- give one conceptual nudge
- offer a non-identical example
- explain what kind of reasoning is needed

Risk can go back down when the student shows genuine work.

### Suppressed Understanding State

For source-lookup-only turns, the response can suppress understanding state if there is no visible problem text or parsed problem context.

When suppressed:

- `problem_understanding_state` becomes `{}` for the response.
- The state is not written into `problem_understanding_states`.

If the response includes visible problem text, source lookup can keep a level-0 understanding state for the loaded problem.

### Syncing to Active Problem Context

When a new active problem context is found:

- Source-lookup-only turns try to reuse any previous state for that active problem id.
- Non-source-lookup tutor turns keep the current help-plan state but replace `activeProblemId` with the active problem context id.
- A newly loaded source problem with no prior state initializes at level 0.

### Frontend Understanding Display

`frontend/lib/understanding-state.ts` does not write understanding state. It derives a safe display state from messages.

It displays understanding only when:

- The latest message has `langGraphTrace.problemUnderstandingState`.
- `activeProblemId` is real, not `unknown`, `none`, `null`, `n/a`, or blank.
- A problem was detected in structured output or the message content.
- Source-lookup-only state is not shown unless a problem was actually detected.

Displayed reasons are sanitized to avoid words such as correct, incorrect, answer, final solution, or solved.

## Student Learning Profile Updates

This is longer-term memory, not the per-turn `problem_understanding_state`.

### 1. Manual Single-Student Update

`updateOneStudentLearningProfile()` is called by the teacher-facing learning-profile route.

Every attempt writes metadata such as:

- last update attempt time
- pending conversation count
- pending student message count
- minimum update thresholds
- student identity

If thresholds are not met and `force` is false, no draft profile is created.

### 2. Forced Update With No Recent Data

If `force` is true but there are no pending conversations or student messages:

- Metadata is written.
- No draft profile is created.
- The result reason is `no_recent_data`.

### 3. Threshold-Based Draft Update

A draft profile is generated when either threshold is met:

- At least 3 pending conversations by default.
- At least 8 pending student messages by default.

The updater loads recent conversations, sends them plus the prior profile to the model, normalizes the result, writes `draftProfile`, sets `teacherReviewed: false`, resets pending counts, and adds a revision.

### 4. Weekly Roster Update

`updateWeeklyStudentLearningProfiles()` loops over class roster students and calls `updateOneStudentLearningProfile()` for each student.

If model generation fails, the student result is recorded as `model_unavailable`.

### 5. Teacher Approval

`approveStudentLearningProfile()` turns a draft or supplied profile into `activeProfile`, clears `draftProfile`, marks it active and teacher-reviewed, and writes an approved revision.

Only active, teacher-reviewed profiles are injected into future tutor chat context.

### 6. Teacher Draft Save, Disable, and Clear

Teacher actions can also:

- Save a draft profile.
- Disable the profile.
- Clear only the draft.
- Clear both active and draft profile content.

## Not Runtime Tutor Memory

Teacher material uploads, URL ingestion, OCR extraction, embeddings, and material settings update the class knowledge base, but they are not cases where the tutor bot updates its conversation knowledge or understanding during chat.

Those paths live mainly in `frontend/lib/tutor-knowledge-server.ts` and material API routes.
