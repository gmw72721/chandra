# Deployment

Chandra is split into a root-managed Next.js frontend in `frontend/` and a FastAPI/LangGraph backend in `backend/`. Deploy them as separate services. Do not expose the backend directly to browser code; the browser calls the Next.js `/api/*` routes, and the Next.js server calls FastAPI through `BACKEND_API_BASE_URL`.

## Frontend

Build from the repository root:

```bash
npm ci
npm run build
npm run start
```

The root scripts point Next.js at `frontend/`. In a hosting platform, set the frontend service root to the repo root unless you also copy the root `package.json` scripts into a separate frontend package.

Required frontend/server environment variables:

```bash
BACKEND_API_BASE_URL=https://<backend-internal-or-private-url>
BACKEND_SHARED_SECRET=<same-random-secret-as-backend>

NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=

FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_SERVICE_ACCOUNT_KEY=
# or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
DEFAULT_MODEL=openai/gpt-5.4-mini
OPENROUTER_HTTP_REFERER=https://<frontend-domain>
OPENROUTER_APP_TITLE=Chandra

GEMINI_API_KEY=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=us
VERTEX_EMBEDDING_MODEL=gemini-embedding-2
VERTEX_EMBEDDING_DIMENSIONS=768

LEARNING_PROFILE_UPDATE_SECRET=
CONVERSATION_RETENTION_SECRET=

BETTER_STACK_SOURCE_TOKEN=
BETTER_STACK_INGESTING_HOST=
BETTER_STACK_UPTIME_API_TOKEN=
BETTER_STACK_RETENTION_HEARTBEAT_URL=
BETTER_STACK_LEARNING_PROFILE_HEARTBEAT_URL=
BETTER_STACK_ENV=production
```

Every secret referenced by `apphosting.yaml` must exist in Secret Manager and be granted to the App Hosting backend before a rollout starts.

## Backend

Build the backend image from the repository root:

```bash
docker build -f backend/Dockerfile -t chandra-backend .
docker run --rm -p 8000:8000 --env-file .env.production chandra-backend
```

Deploy the backend to Cloud Run:

```bash
bash scripts/deploy-backend-cloudrun.sh
```

The Cloud Run deploy script defaults to the routine fast path: it uploads only backend build inputs and reuses the previous `:latest` image as the Docker layer cache. For a first deploy, or after changing backend secrets or service permissions, run:

```bash
PROVISION_INFRA=1 SYNC_SECRETS=1 bash scripts/deploy-backend-cloudrun.sh
```

Required backend environment variables:

```bash
CHANDRA_ENV=production
BACKEND_SHARED_SECRET=<same-random-secret-as-frontend>
BACKEND_CORS_ORIGINS=https://<frontend-domain>
FRONTEND_ORIGIN=https://<frontend-domain>
NEXT_INTERNAL_BASE_URL=https://<frontend-domain>

FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
FIREBASE_SERVICE_ACCOUNT_KEY=
# or FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY

OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
DEFAULT_MODEL=openai/gpt-5.4-mini
OPENROUTER_HTTP_REFERER=https://<frontend-domain>
OPENROUTER_APP_TITLE=Chandra

GEMINI_API_KEY=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=us
VERTEX_EMBEDDING_MODEL=gemini-embedding-2
VERTEX_EMBEDDING_DIMENSIONS=768

BETTER_STACK_SOURCE_TOKEN=
BETTER_STACK_INGESTING_HOST=
BETTER_STACK_UPTIME_API_TOKEN=
BETTER_STACK_ENV=production
```

`BACKEND_SHARED_SECRET` is required. The backend returns `503` for internal LangGraph chat requests if it is missing and `403` if the request secret does not match.

`NEXT_INTERNAL_BASE_URL` or `FRONTEND_ORIGIN` is also required on the backend in production. FastAPI uses it to call the Next.js internal retrieval endpoints for PDF page search and selected-page PDF assets. If it is missing, class-material retrieval can return no pages even when Firestore has indexed chunks.

## Preflight Checks

Run these before deploying:

```bash
npm run typecheck
npm run build
python3 -m pytest tests
```

Also deploy Firebase rules before production traffic:

```bash
firebase deploy --config firebase/firebase.json --project chandra-f6e13 --only firestore:rules,storage
```

Create the Firestore vector index on the `chunks` collection group with `classId` ascending and `embedding` using the same dimension as `VERTEX_EMBEDDING_DIMENSIONS`.

## Better Stack Observability

Create a Better Stack Logs source for Chandra in Better Stack Telemetry, choose HTTP ingest, and copy its source token plus ingesting host into the runtime env. Chandra sends a single JSON event to `https://$BETTER_STACK_INGESTING_HOST` with `Authorization: Bearer $BETTER_STACK_SOURCE_TOKEN` and `Content-Type: application/json`, which matches Better Stack's HTTP ingest contract: https://betterstack.com/docs/logs/ingesting-data/http/logs/. The app also writes the same structured JSON to stdout/stderr so local development and Cloud Logging still work when Better Stack is not configured.

Required Better Stack env vars:

```bash
BETTER_STACK_SOURCE_TOKEN=<logs-source-token>
BETTER_STACK_INGESTING_HOST=<source-ingesting-host>
BETTER_STACK_UPTIME_API_TOKEN=<uptime-api-token-used-for-dashboard-setup>
BETTER_STACK_RETENTION_HEARTBEAT_URL=https://uptime.betterstack.com/api/v1/heartbeat/<retention-heartbeat-id>
BETTER_STACK_LEARNING_PROFILE_HEARTBEAT_URL=https://uptime.betterstack.com/api/v1/heartbeat/<learning-profile-heartbeat-id>
BETTER_STACK_ENV=production
```

The source token, uptime token, and heartbeat URLs are secrets. Do not expose them as `NEXT_PUBLIC_*`.

Both services log `event`, `route`, `method`, `status`, `latencyMs`, `requestId`, and `userId` only after auth has safely identified a user. Provider failures include provider name, error class, status code, request id, and class/user identifiers where safe. The logger redacts fields whose names indicate auth tokens, secrets, message content, provider prompts, uploaded file contents, or private learning profile data. Better Stack submission is best-effort and never blocks or fails request handling.

Health endpoints:

```text
GET /api/health      # Next.js runtime config, backend reachability, Firebase, OpenRouter, embeddings, Better Stack config
GET /health          # FastAPI liveness
GET /health/deep     # FastAPI Firebase Admin, Firestore, OpenRouter, Gemini embeddings, Better Stack config
```

Recommended Better Stack uptime monitors:

- Frontend HTTP monitor: `https://<frontend-domain>/api/health`, alert on non-2xx or JSON `status != "ok"`.
- Backend HTTP monitor: `https://<backend-domain>/health`, alert on non-2xx.
- Backend deep HTTP monitor: `https://<backend-domain>/health/deep`, run less frequently, for example every 5 minutes, and alert when any dependency is `down` or `missing_config`.
- Firebase/Firestore: use `/health/deep` `firebaseAdmin` and `firestore` dependency statuses plus Google Cloud/Firebase service alerts for Firestore errors and quota.
- OpenRouter: use `/health/deep` `openrouter` status and OpenRouter dashboard/API-key quota alerts.
- Embeddings: use `/health/deep` `embeddings` status and Google/Gemini API quota/error alerts.

Create two Better Stack heartbeat monitors in Better Stack Uptime. You can create them in the dashboard, or with the Heartbeats API (`POST https://uptime.betterstack.com/api/v2/heartbeats`) using the uptime API token documented by Better Stack: https://betterstack.com/docs/uptime/api/create-a-hearbeat/.

- `Chandra conversation retention`, period matching the retention scheduler, with URL saved as `BETTER_STACK_RETENTION_HEARTBEAT_URL`.
- `Chandra weekly learning profiles`, period matching the weekly learning-profile scheduler, with URL saved as `BETTER_STACK_LEARNING_PROFILE_HEARTBEAT_URL`.

The retention route pings the retention heartbeat only after `enforceConversationRetention()` and its audit log succeed. The weekly learning-profile route pings its heartbeat only after `updateWeeklyStudentLearningProfiles()` succeeds. Heartbeat pings are best-effort; Better Stack downtime does not fail the scheduled job.
