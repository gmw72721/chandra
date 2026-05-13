# Tutor Response Shape

Student-facing tutoring replies are shaped by:

- `frontend/lib/prompts.ts` for the standard tutor system prompt.
- `frontend/app/api/chat/route.ts` for the PDF retrieval tool prompt.
- `backend/agent/graph.py` for the primary tutor turn, context-grounded answer prompt, and structured output cleanup.
- `frontend/lib/tutor-response.ts` for client-side structured output normalization.

For substantive tutoring help, the target shape is:

1. Brief orientation: name the kind of task or thinking move.
2. One targeted hint: the key idea needed next, tied to the exact student task.
3. One concrete next step: a small, checkable action the student can try.
4. Optional source/context note: only when class material was actually used.

Before:

```text
This is a task where you should use the rule from the notes. Hint: Use the rule from the notes.

Next step: Use the rule from the notes.
```

After:

```text
You are matching the task to the rule that controls this kind of situation.

Hint: Focus on which condition in the prompt tells you the rule applies.

Next step: Mark the one condition you think matters most and send it back.
```

Before:

```text
Start by planning your response. Hint: Plan your response by listing your ideas.

Next step: Plan your response.
```

After:

```text
You are turning a broad prompt into a claim you can support.

Hint: Pick the idea you can back up with the clearest evidence.

Next step: Write one possible claim in a single sentence.
```
