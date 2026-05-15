# Chandra Teacher Assistant ADK Setup

The teacher assistant is designed so Chandra remains the security and product gateway. The ADK agent can request tools, but Chandra validates auth, class access, tool schemas, confirmations, writes, and audit logs.

Official references used for this integration:

- Google Cloud REST `projects.locations.reasoningEngines.streamQuery`: `POST https://aiplatform.googleapis.com/v1/{name}:streamQuery`, resource format `projects/{project}/locations/{location}/reasoningEngines/{reasoningEngine}`, and `classMethod`/`input` request fields.
- ADK Agent Runtime standard deployment: deploy with `adk deploy agent_engine`, then use the regional Agent Runtime URL shape `https://$(LOCATION_ID)-aiplatform.googleapis.com/v1/projects/$(PROJECT_ID)/locations/$(LOCATION_ID)/reasoningEngines/$(RESOURCE_ID):query`.
- ADK Agent Runtime test guide: create a session with `class_method: async_create_session`, then send turns to `:streamQuery?alt=sse` with `class_method: async_stream_query`, authenticated with a Google Cloud bearer token.

## Local Development

Use the deterministic local provider:

```env
TEACHER_ASSISTANT_PROVIDER=local-fallback
```

The local provider supports tab navigation, dashboard summary, review queue, and the confirmation-gated notification settings write pattern.

When `TEACHER_ASSISTANT_PROVIDER` is unset or any value other than `agent-runtime-adk`, Chandra uses this local fallback and does not call Google Agent Runtime.

## Agent Runtime

Required environment:

```env
TEACHER_ASSISTANT_PROVIDER=agent-runtime-adk
GEMINI_AGENT_RUNTIME_RESOURCE=projects/PROJECT_ID/locations/LOCATION/reasoningEngines/RESOURCE_ID
GEMINI_AGENT_LOCATION=global
TEACHER_ASSISTANT_MODEL=gemini-3-flash-preview
CHANDRA_ASSISTANT_TOOL_BASE_URL=https://your-chandra-origin.example
CHANDRA_ASSISTANT_TOOL_SHARED_SECRET=...
```

The Next.js server authenticates to Agent Runtime with Google Application Default Credentials via `google-auth-library` and the `https://www.googleapis.com/auth/cloud-platform` scope. In production, configure ADC with the service account running Chandra, or provide service account credentials using the existing Google credential env pattern (`GOOGLE_APPLICATION_CREDENTIALS_JSON`, `GOOGLE_CLIENT_EMAIL`/`GOOGLE_PRIVATE_KEY`/`GOOGLE_CLOUD_PROJECT`, or Firebase equivalents).

`gemini-3-flash-preview` is the current Gemini 3 Flash model ID in Google Cloud docs. It is a public preview model and uses the `global` endpoint. The Agent Runtime resource itself still deploys in a supported regional Agent Engine location such as `us-central1`; set the deployed ADK runtime's `GOOGLE_CLOUD_LOCATION=global` so its model client calls the global Gemini endpoint. Use `gemini-2.5-flash` or `gemini-2.5-pro` instead if preview terms or global-only model routing are not acceptable.

## Runtime Flow

1. The browser calls `/api/teacher-assistant` with the teacher's Firebase auth token, `classId`, `sessionId`, and message.
2. Chandra verifies the teacher with `authorizeClassAccess`.
3. Chandra mints a short-lived `assistantContextId` and stores only server-side context: `actorUid`, `actorEmail`, `classId`, allowed tool names, `createdAt`, `expiresAt`, and Chandra `sessionId`.
4. Chandra calls Agent Runtime from the server:
   - `:query` with `class_method: async_create_session`
   - `:streamQuery?alt=sse` with `class_method: async_stream_query`
5. The ADK agent receives only `assistantContextId` and sanitized context: current class id, allowed tool names, expiry, and Chandra session id.
6. The ADK agent calls Chandra tools at `/api/internal/teacher-assistant/tools` using `CHANDRA_ASSISTANT_TOOL_SHARED_SECRET`.
7. Chandra resolves `assistantContextId`, rejects expired contexts, rejects tools not allowed for the turn, rechecks the stored actor's current class permissions, validates tool args, and runs the existing registry.

## Deploy ADK Agent From Dockerfile

From `agents/teacher_dashboard_agent`:

```bash
python3 -m pip install -r requirements.txt
GOOGLE_CLOUD_PROJECT=... \
GEMINI_AGENT_LOCATION=global \
CHANDRA_ASSISTANT_TOOL_BASE_URL=https://your-chandra-origin.example \
CHANDRA_ASSISTANT_TOOL_SHARED_SECRET=... \
python3 deploy.py
```

The deploy script follows Google Cloud's Dockerfile deployment flow for Agent Runtime: it sends `agent.py`, `main.py`, `requirements.txt`, and `Dockerfile` as `source_packages` and sets `"image_spec": {}` so Agent Runtime builds the image from the Dockerfile.

Save the printed `projects/.../locations/.../reasoningEngines/...` resource name as `GEMINI_AGENT_RUNTIME_RESOURCE`.

Google Cloud setup:

- Enable Vertex AI / Agent Platform APIs and billing.
- Configure Application Default Credentials or a service account for deployment.
- Grant the Chandra server runtime service account permission to invoke/query the deployed Agent Runtime resource.
- Give the deployed runtime only the access needed to call Chandra's tool callback endpoint.
- Register the deployed ADK agent in Gemini Enterprise if it should appear in Gemini Enterprise, separate from the embedded Chandra widget.

## Security Model

- The model never owns Chandra database credentials.
- The model never receives Firebase tokens, Google credentials, database credentials, or broad class/user records.
- The model receives only a short-lived `assistantContextId` and sanitized current-turn context.
- The model must call Chandra tools for routes and data.
- Chandra validates the authenticated teacher on assistant entry and rechecks stored actor/class permissions on every internal tool callback.
- The internal callback requires `CHANDRA_ASSISTANT_TOOL_SHARED_SECRET`.
- Chandra rejects model-supplied `classId`, `studentEmail`, and `conversationId` unless server-side validation confirms they belong to the authorized class.
- Chandra requires explicit confirmation before every write.
- Chandra audit logs every assistant-triggered write.
- Student conversation text and materials are treated as untrusted data and cannot override system/tool rules.

## Verify Live Agent Runtime

- Set `TEACHER_ASSISTANT_PROVIDER=agent-runtime-adk` and restart the Chandra server.
- Confirm `GEMINI_AGENT_RUNTIME_RESOURCE` is the deployed resource printed by `agents/teacher_dashboard_agent/deploy.py`.
- Ask the widget to navigate to a teacher tab. In Chandra logs, verify a server-side Agent Runtime `async_create_session` call followed by `async_stream_query`.
- In Google Cloud logs, verify the deployed ADK agent called `/api/internal/teacher-assistant/tools`.
- If configuration is incomplete, Chandra should fail the turn with an actionable missing-resource or missing-credentials error. Set `TEACHER_ASSISTANT_PROVIDER=local-fallback` to return to deterministic local behavior.
