# Chandra

Chandra is a teacher-guided AI tutoring platform for classrooms. Teachers create class-specific AI tutors, define how they should help, ground responses in uploaded course materials, and review student conversations to understand where learners need support. The platform is designed to keep students doing the thinking while giving teachers control over tutor behavior, source usage, and follow-up interventions.

## Features

- Student tutor chat with class, assignment, and model context.
- Teacher dashboard for class settings, hidden tutor instructions, source materials, roster activity, and conversation review.
- Teacher-reviewed student learning profiles with support notes and evidence from recent conversations.
- Firebase Authentication, Firestore, and Storage integration.
- PDF/source-grounded retrieval with embeddings, material visibility controls, and Firestore Vector Search.
- LangGraph FastAPI backend for controlled PDF RAG chat through OpenRouter models.

## Stack

- Next.js 16, React 19, TypeScript
- Firebase Auth, Firestore, Firebase Storage
- FastAPI, LangGraph
- OpenRouter for model calls
- Gemini/Vertex embeddings for retrieval

## Requirements

- Node.js 20+
- Python 3.11+
- Firebase project with Email/Password auth, Firestore, and Storage enabled
- OpenRouter API key for live tutor chat
- Gemini API key or Google Cloud credentials for embeddings

## Setup

```bash
npm install
python3 -m venv .venv
source .venv/bin/activate
pip install -r backend/requirements.txt
cp config/env.example .env.local
```

Fill in `.env.local` with the values for your Firebase project and model providers. The frontend code lives in `frontend/`; root npm scripts still run the frontend commands.

## Environment

Minimum local web app configuration:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

Server-side Firebase access can use either `FIREBASE_SERVICE_ACCOUNT_KEY` or:

```bash
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIREBASE_STORAGE_BUCKET=
```

Live chat and retrieval:

```bash
OPENROUTER_API_KEY=
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
DEFAULT_MODEL=openai/gpt-5.4-mini

BACKEND_API_BASE_URL=http://127.0.0.1:8000
BACKEND_SHARED_SECRET=
BACKEND_CORS_ORIGINS=http://localhost:3000,http://127.0.0.1:3000
LEARNING_PROFILE_UPDATE_SECRET=

GEMINI_API_KEY=
GOOGLE_CLOUD_PROJECT=
GOOGLE_CLOUD_LOCATION=us
VERTEX_EMBEDDING_MODEL=gemini-embedding-2
VERTEX_EMBEDDING_DIMENSIONS=1536
```

See `config/env.example` for the full set of supported variables and `docs/DEPLOYMENT.md` for production values.

## Development

Run the full local stack from the repository root:

```bash
npm run dev:all
```

That command loads `.env.local`, clears ports 3000 and 8000, starts the Next.js frontend, and starts the FastAPI backend without auto-reload so long streaming tutor responses are not interrupted.

Or run the Next.js app by itself:

```bash
npm run dev
```

Run the FastAPI backend in a second terminal:

```bash
npm run dev:api
```

Open `http://localhost:3000`.

Browser code calls the Next.js `/api/*` routes on the same origin. The Next.js server uses `BACKEND_API_BASE_URL` to reach the FastAPI LangGraph service, so do not set a public frontend API base URL for local FastAPI.

Scheduled learning profile updates call `/api/student-learning-profiles/weekly` with `Authorization: Bearer $LEARNING_PROFILE_UPDATE_SECRET`.

## Quality Checks

```bash
npm run lint
npm run typecheck
npm test
pytest
```

## Project Layout

- `config/`: local environment template and tool config files.
- `frontend/`: Next.js app, React components, and frontend/server TypeScript libraries.
- `backend/`: FastAPI entrypoint, backend requirements, and container config.
- `backend/agent/` and `backend/retrieval/`: LangGraph and retrieval modules imported by the backend.
- `firebase/`: Firebase CLI config and security rules.
- `deployment/`: Cloud and hosting deployment configuration.

## Firebase Deployment

Deploy security rules before using a real Firebase project:

```bash
firebase deploy --config firebase/firebase.json --project chandra-f6e13 --only firestore:rules,storage
```

For vector retrieval, create a Firestore vector index on the `chunks` collection group with `classId` ascending and `embedding` using the same dimension as `VERTEX_EMBEDDING_DIMENSIONS`.
