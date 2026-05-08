# Voice Tutor Backend

The existing typed chat path stays unchanged:

`typed chat -> /api/chat -> existing LangGraph PDF RAG backend`

Realtime voice mode uses a separate path:

`voice mode -> OpenAI Realtime WebRTC -> ask_voice_tutor tool -> VoiceTutorGraph -> retrieval/source helpers -> compact spoken reply + structured UI sections`

## Official Realtime References

This design follows the current OpenAI Realtime docs:

- [Realtime API models](https://platform.openai.com/docs/guides/realtime-models)
- [Realtime WebRTC connection flow](https://platform.openai.com/docs/guides/realtime-webrtc)
- [Realtime client secrets](https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets)
- [Realtime function calls and `function_call_output`](https://developers.openai.com/api/docs/guides/realtime-conversations)
- [Realtime cost, truncation, and retention ratio guidance](https://platform.openai.com/docs/guides/realtime-costs)

## Endpoints

`POST /api/realtime/session`

- Runs in the Next.js server.
- Authorizes with the same Firebase tutor-chat helper as `/api/chat`.
- Creates an OpenAI Realtime short-lived client secret server-side.
- Defaults to `gpt-realtime-2`, configurable with `OPENAI_REALTIME_MODEL`.
- Defaults Realtime reasoning to `low`; `medium` is only allowed through explicit server config for ambiguous routing cases.
- Returns only the ephemeral client secret and safe session metadata. It never returns `OPENAI_API_KEY`.

`POST /api/realtime/tutor-tool`

- Runs in the Next.js server.
- Authorizes with the same tutor-chat helper.
- Accepts Realtime `ask_voice_tutor` arguments, prepares voice conversation persistence where possible, and calls FastAPI internally.
- Returns a full UI payload plus `realtimeToolOutput`. The browser should send only `realtimeToolOutput` back to Realtime as the `function_call_output`.

`POST /api/voice-tutor/tool`

- Runs in FastAPI behind `BACKEND_SHARED_SECRET`.
- Calls `backend.voice_tutor.graph.VoiceTutorGraph`.
- Does not route through the existing typed-chat LangGraph.

## Tool Contract

Realtime is configured with one function tool named `ask_voice_tutor`.

The tool receives the current student transcript, class id, optional conversation id, an intent, preferred UI sections, retrieval mode, response budget, and compact known context. `preferredSections` are suggestions only. `VoiceTutorGraph` decides the final targeted section set.

## UI Sections

Voice mode reuses the old section names so future UI rendering can stay compatible:

`answer`, `hint`, `explanation`, `formula`, `example`, `checkWork`, `sourceNote`, `nextStep`

Voice mode usually returns fewer sections than typed chat. For example:

- Hint: `hint + nextStep`
- Formula: `formula + nextStep`, sometimes `explanation`
- Source lookup: `sourceNote + sources`
- Step explanation: `explanation + nextStep`
- Check work: `checkWork + nextStep`

Skipped preferred sections include a short reason when useful.

## Output Separation

Full app payload:

- `uiResponse`: display message, structured sections, safe sources, retrieval confidence, compact context, and a small trace.
- `progressEvents`: `reading_question`, `planning_tutor_move`, `searching_sources`, `opening_sources`, `reading_sources`, `writing_support`, `final`.
- `sectionsShown` and `skippedSections`.

Compact Realtime payload:

- `voiceReply`
- `currentStep`
- `nextStep`
- `sectionsShown`
- `searched`
- `sourceLabels`
- `uiMessageId`

Do not send full UI payloads, markdown, graph traces, source objects, PDF chunks, or chat history back into Realtime.

Future frontend flow:

- Open WebRTC with the ephemeral `clientSecret.value` from `/api/realtime/session`.
- Listen for Realtime function-call argument completion events such as `response.function_call_arguments.done`.
- POST those arguments to `/api/realtime/tutor-tool`.
- Render the returned `uiResponse` and `progressEvents`.
- Send only `realtimeToolOutput` back to Realtime as a `conversation.item.create` item with `type: "function_call_output"` and the matching `call_id`, then request the next model response.

## Reasoning And Retrieval Policy

Realtime reasoning is for live routing and tool-call decisions, not deep academic solving. Default effort is `low`. `medium` should only be used by future frontend/session logic when the voice turn is ambiguous, references several prior steps, or must choose between source reuse and search.

Retrieval policy:

- `none`: do not search; answer from compact context or ask for clarification.
- `reuse_sources`: prefer known reliable source labels.
- `search_if_uncertain`: search only when compact context and source context are weak.
- `force_search`: search unless reliable source context already satisfies the request.
- `auto`: choose from intent, compact context, and whether the student asks for class material/source location.

## Compact Context

`backend.voice_tutor.compact_context` builds a small follow-up context:

- `problemSummary`
- `currentStep`
- `knownFormula`
- `knownSourceLabels`
- `lastSectionsShown`
- `lastAssistantNextStep`
- `hasReliableSourceContext`
- `lastVoiceGraphMessageId`

It must never include full PDF text, source chunks, raw traces, full chat history, hidden prompts, or model reasoning.
