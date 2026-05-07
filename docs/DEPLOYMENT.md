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
```

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
```

`BACKEND_SHARED_SECRET` is required. The backend returns `503` for internal LangGraph chat requests if it is missing and `403` if the request secret does not match.

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
