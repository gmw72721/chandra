# Realtime Voice Tutor Backend

This backend support lets a future student UI start an optional voice session without exposing `OPENAI_API_KEY` to the browser. Realtime is the voice/controller layer; LangGraph remains the tutoring brain for teacher policy, learning profile, PDF retrieval, sources, structured sections, and saved conversations.

## Endpoints

`POST /api/realtime/session`

- Authenticates with the same bearer Firebase token as `/api/chat`.
- Authorizes class access with `authorizeTutorChatRequest`.
- Calls OpenAI server-side to create a short-lived Realtime client secret.
- Returns only ephemeral client credentials, public session config, the `ask_chandra_tutor` tool schema, and compact known context.
- Defaults `OPENAI_REALTIME_MODEL` to `gpt-realtime-2`.
- Enforces a small JSON body limit before parsing request JSON.
- Keeps Realtime instructions and tool descriptions compact because they are part of Realtime input tokens.
- Defaults `OPENAI_REALTIME_POST_INSTRUCTIONS_TOKEN_LIMIT` to `1200` to limit Realtime rolling conversation input; this does not change LangGraph context.

`POST /api/realtime/tutor-tool`

- Accepts the `ask_chandra_tutor` tool args from the future frontend.
- Calls the protected LangGraph stream endpoint with voice-only fields.
- Returns full UI output separately from compact Realtime output.
- Supports `stream: true` NDJSON for future UI progress.
- Enforces a strict tool-argument schema and request size limit before parsing request JSON.

## Realtime Tool Flow

Realtime decides the conversational intent and calls `ask_chandra_tutor` with compact args:

- `voiceIntent`
- `preferredSections`
- `retrievalMode`
- `responseBudget`
- `knownContext`

`preferredSections` are preferences only. LangGraph decides which sections are useful, whether sources are needed, and whether PDF retrieval should run.

The future frontend should send only `realtimeFunctionOutput` back to Realtime as `function_call_output`, then request the spoken response. It should not send `uiResponse`, source objects, PDF chunks, full markdown, or trace data back into Realtime.

## Output Split

The tutor tool response has:

- `uiResponse`: full app/UI result with message, structured output, sources, LangGraph trace, and retrieval confidence.
- `progressEvents`: detailed UI progress.
- `voiceProgressEvents`: short voice-specific progress lines with `{ stage, voiceLine, speak, dedupeKey }`.
- `sectionsShown` and `skippedSections`.
- `realtimeFunctionOutput`: compact speech payload with `voiceReply`, `currentStep`, `nextStep`, `sectionsShown`, `searched`, `sourceLabels`, and optional `uiMessageId`.

## Reasoning Policy

Realtime session default is low reasoning. Realtime reasoning is for routing, intent selection, section preferences, repeats, clarifications, and deciding whether to call the tutor tool. LangGraph does academic work.

Response-level medium reasoning can be added later by the frontend for genuinely ambiguous turns. High reasoning is not the default.

## Cost Controls

- The Realtime session does not enable separate input transcription by default.
- The Realtime tool schema intentionally uses short descriptions. Keep detailed tutoring policy in LangGraph, not in Realtime.
- The Realtime `post_instructions` token limit is intentionally lower than the model maximum. Increase `OPENAI_REALTIME_POST_INSTRUCTIONS_TOKEN_LIMIT` only if Realtime needs more controller-side turn history.
- Keep Realtime instructions and tool definitions stable during a session to preserve prompt-cache opportunities.
- Realtime uses semantic VAD with `create_response: false` and `interrupt_response: false`; the frontend explicitly requests a response after each completed utterance and tells the model to stay silent unless the speech is addressed to Chandra or is a clear tutoring follow-up.

## Retrieval Policy

Voice fields are optional and inert for typed chat.

- `none`: no PDF search.
- `reuse_sources`: prefer known reliable source context; search only when impossible.
- `search_if_uncertain`: search only when compact context is weak.
- `force_search`: search unless reliable source context already satisfies the request.
- `auto`: choose from intent and context.

Intent defaults:

- `hint`: usually `hint + nextStep`.
- `show_formula`: formula and maybe explanation; examples are not automatic.
- `find_source`: source location or source-backed answer.
- `explain_step`: explanation and next step.
- `walkthrough`: smallest useful section set.
- `check_work`: checkWork and next step.
- `clarify` and `repeat`: usually no retrieval.

## Voice Progress Policy

UI progress remains detailed and stays in the normal Chandra progress bubble. Voice dialogue shows only the student's spoken turn, Chandra's compact spoken reply, and generic voice status such as listening or speaking. Realtime should not speak LangGraph progress events.

## Frontend Expectations

The future UI should:

- Start with `/api/realtime/session`.
- Connect to Realtime over WebRTC using the returned ephemeral secret.
- On `ask_chandra_tutor`, call `/api/realtime/tutor-tool`.
- Show `progressEvents` and `uiResponse`.
- Speak only the compact `realtimeFunctionOutput`; do not turn LangGraph progress into separate Realtime speech.
- Build the next turn's `knownContext` from `buildRealtimeKnownContext` output or equivalent compact state.
- Treat speech start/stop as detection only. Do not let raw VAD automatically interrupt Chandra or answer side conversations.
