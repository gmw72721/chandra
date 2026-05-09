# Chandra

Teacher-guided AI tutoring for classrooms. Teachers configure class-specific tutors, upload course materials, control source usage and answer policy, and review student conversations. Students chat through the Next.js app; production tutor responses are handled by a private FastAPI/LangGraph backend.

## Production

- Frontend: Firebase App Hosting
  - `https://chandra-frontend--chandra-f6e13.us-central1.hosted.app`
- Backend: authenticated Google Cloud Run
  - `https://chandra-backend-whjsen4ula-uc.a.run.app`
- Project: `chandra-f6e13`
- Region: `us-central1`

The backend is not public API surface for browsers. Browser requests go to the Next.js app. The Next.js server calls FastAPI with `X-Chandra-Internal-Secret` and a Cloud Run identity token.

## Stack

- Next.js 16, React 19, TypeScript
- Firebase Auth, Firestore, Firebase Storage
- FastAPI, LangGraph, Uvicorn
- OpenRouter for tutor model calls
- Gemini embeddings and Firestore Vector Search for retrieval
- Firebase App Hosting, Cloud Run, Artifact Registry, Secret Manager, Cloud Build

## Repository Layout

```text
frontend/                         Next.js app, API routes, UI, Firebase server code
backend/                          FastAPI app and Python container config
agent/                            LangGraph tutor workflow
retrieval/                        PDF retrieval/rendering helpers
tests/                            TypeScript and Python tests
apphosting.yaml                   Firebase App Hosting runtime config
cloudbuild.backend.deploy.yaml    Backend build/push/deploy pipeline
```

## Local Setup

Requirements:

- Node.js 20+
- Python 3.11+
- Firebase project with Auth, Firestore, and Storage
- OpenRouter API key
- Gemini API key

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp .env.example .env.local
```

Fill `.env.local`. Do not commit env files.

Run both frontend and backend:

```bash
npm run dev:all
```

Or separately:

```bash
npm run dev
npm run dev:api
```

Open `http://localhost:3000`.

## Environment

Frontend runtime needs:

```bash
BACKEND_API_BASE_URL=
BACKEND_ID_TOKEN_AUDIENCE=
BACKEND_SHARED_SECRET=
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=
DEFAULT_MODEL=
GEMINI_API_KEY=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=
VERTEX_EMBEDDING_MODEL=
VERTEX_EMBEDDING_DIMENSIONS=
LEARNING_PROFILE_UPDATE_SECRET=
```

Backend runtime needs:

```bash
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=
OPENROUTER_HTTP_REFERER=
OPENROUTER_APP_TITLE=
DEFAULT_MODEL=
BACKEND_SHARED_SECRET=
FRONTEND_ORIGIN=
NEXT_INTERNAL_BASE_URL=
FIREBASE_PROJECT_ID=
FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
GEMINI_API_KEY=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=
VERTEX_EMBEDDING_MODEL=
VERTEX_EMBEDDING_DIMENSIONS=
```

Production stores sensitive values in Secret Manager / App Hosting secrets. Cloud Run and App Hosting use service accounts for Firebase Admin where possible, not committed private keys.

## Quality Checks

```bash
npm run lint
npm run typecheck
npm test
python3 -m pytest tests/test_provider_retries.py tests/test_pdf_rag_graph.py tests/test_backend_visibility.py
```

## Deployment

Frontend deploys through Firebase App Hosting backend `chandra-frontend`.

Backend deploys through Cloud Build trigger `deploy-chandra-backend-main` using:

```text
cloudbuild.backend.deploy.yaml
```

The backend pipeline builds `backend/Dockerfile`, pushes to Artifact Registry, and deploys Cloud Run service `chandra-backend` with:

- `uvicorn backend.main:app --host 0.0.0.0 --port $PORT`
- timeout `900s`
- concurrency `10`
- memory `2Gi`
- unauthenticated access disabled
- runtime service account `chandra-backend@chandra-f6e13.iam.gserviceaccount.com`

Normal production deploy:

```bash
git push origin main
```

Recommended backend trigger included-file filters:

```text
backend/**
agent/**
retrieval/**
cloudbuild.backend.deploy.yaml
.dockerignore
.gcloudignore
```

## Firebase Setup

Deploy rules:

```bash
npx firebase deploy --only firestore:rules,storage --project chandra-f6e13
```

Storage rules require Firebase Storage to be initialized in the Firebase console.

For retrieval, create a Firestore vector index on the `chunks` collection group:

- `classId` ascending
- `embedding` vector field
- dimensions must match `VERTEX_EMBEDDING_DIMENSIONS`

## Security Notes

- Never commit `.env`, `.env.local`, private keys, or service account JSON.
- Keep `BACKEND_SHARED_SECRET` identical in App Hosting and Cloud Run.
- Keep `BACKEND_API_BASE_URL` and `BACKEND_ID_TOKEN_AUDIENCE` set to the bare Cloud Run origin.
- Backend chat endpoints require `X-Chandra-Internal-Secret`.
- Cloud Run is private; App Hosting needs `roles/run.invoker`.
