# Chandra Project Sites

This is the quick reference for the websites, dashboards, API origins, and local URLs used by the Chandra project.

Do not put API keys, service account JSON, private keys, or shared secrets in this file. Use `.env.local`, Firebase App Hosting secrets, Cloud Run secrets, and Google Secret Manager for secret values.

## Production App

| Area | Site / URL | Notes |
| --- | --- | --- |
| Frontend app | https://chandra-frontend--chandra-f6e13.us-central1.hosted.app | Main production Next.js app hosted by Firebase App Hosting. Teachers and students use this site. |
| Backend service | https://chandra-backend-whjsen4ula-uc.a.run.app | Private Google Cloud Run FastAPI/LangGraph service. Browser code should not call this directly. |
| Google Cloud project | `chandra-f6e13` | Main cloud project. |
| Region | `us-central1` | Main frontend/backend deployment region. |

## Local Development

| Area | URL | Command |
| --- | --- | --- |
| Full local stack | http://localhost:3000 | `npm run dev:all` |
| Frontend only | http://localhost:3000 | `npm run dev` |
| Frontend loopback | http://127.0.0.1:3000 | Started by `scripts/start-dev.mjs`. |
| Backend API | http://127.0.0.1:8000 | `npm run dev:api` |
| Backend health check | http://127.0.0.1:8000/health | Local FastAPI health route. |

## Main Dashboards

| Service | Site | What It Is Used For |
| --- | --- | --- |
| Firebase Console | https://console.firebase.google.com/project/chandra-f6e13/overview | Main Firebase project dashboard. |
| Firebase App Hosting | https://console.firebase.google.com/project/chandra-f6e13/apphosting | Frontend hosting backend `chandra-frontend`. |
| Firebase Authentication | https://console.firebase.google.com/project/chandra-f6e13/authentication/users | Email/password user accounts. |
| Firestore Database | https://console.firebase.google.com/project/chandra-f6e13/firestore | Classes, users, conversations, materials, and vector chunks. |
| Firebase Storage | https://console.firebase.google.com/project/chandra-f6e13/storage | Uploaded course materials and tutor knowledge files. |
| Google Cloud Console | https://console.cloud.google.com/home/dashboard?project=chandra-f6e13 | Main Google Cloud dashboard for the project. |
| Cloud Run | https://console.cloud.google.com/run/detail/us-central1/chandra-backend?project=chandra-f6e13 | Backend service `chandra-backend`. |
| Cloud Build | https://console.cloud.google.com/cloud-build/triggers?project=chandra-f6e13 | Backend build/deploy trigger, including `deploy-chandra-backend-main`. |
| Artifact Registry | https://console.cloud.google.com/artifacts/docker/chandra-f6e13/us-central1/chandra?project=chandra-f6e13 | Backend Docker image repository `chandra`. |
| Secret Manager | https://console.cloud.google.com/security/secret-manager?project=chandra-f6e13 | Runtime secrets for App Hosting and Cloud Run. |
| IAM | https://console.cloud.google.com/iam-admin/iam?project=chandra-f6e13 | Service account permissions, including Cloud Run invoker access. |
| Logs Explorer | https://console.cloud.google.com/logs/query?project=chandra-f6e13 | Frontend/backend runtime logs. |
| Firestore Indexes | https://console.cloud.google.com/firestore/indexes?project=chandra-f6e13 | Firestore indexes, including vector index setup for retrieval. |

## External API Providers

| Provider | Site / API | Used For | Related Environment Variables |
| --- | --- | --- | --- |
| OpenRouter | https://openrouter.ai | Tutor model provider dashboard and API key management. | `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, `DEFAULT_MODEL`, `OPENROUTER_HTTP_REFERER`, `OPENROUTER_APP_TITLE` |
| OpenRouter API | https://openrouter.ai/api/v1 | Chat completions endpoint base URL. Code calls `/chat/completions`. | `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1` |
| Google AI Studio / Gemini API | https://aistudio.google.com | Gemini API key management for embeddings when using Gemini API keys. | `GEMINI_API_KEY`, `GOOGLE_API_KEY` |
| Gemini API | https://generativelanguage.googleapis.com/v1beta | Embedding API used for `gemini-embedding-2`. | `GEMINI_API_KEY`, `VERTEX_EMBEDDING_MODEL`, `VERTEX_EMBEDDING_DIMENSIONS` |
| Vertex AI | https://console.cloud.google.com/vertex-ai?project=chandra-f6e13 | Google-hosted model/embedding service. | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `VERTEX_EMBEDDING_MODEL`, `VERTEX_EMBEDDING_DIMENSIONS` |
| Vertex AI API | `https://<location>-aiplatform.googleapis.com/v1` | Prediction API fallback for non-Gemini embedding models. | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` |
| Firestore REST API | `https://firestore.googleapis.com/v1/projects/chandra-f6e13/databases/(default)` | Backend retrieval and document operations. | Firebase/Google service account credentials |
| Google Cloud Storage | https://storage.googleapis.com | Material file object access by bucket/path. | `FIREBASE_STORAGE_BUCKET` |

## Project Services

| Service | Production Value | Purpose |
| --- | --- | --- |
| Firebase project ID | `chandra-f6e13` | Auth, Firestore, Storage, App Hosting, and Google Cloud project identity. |
| Firebase auth domain | `chandra-f6e13.firebaseapp.com` | Firebase web authentication domain. |
| Firebase web storage bucket | `chandra-f6e13.firebasestorage.app` | Public Firebase web app storage config. |
| Firebase admin storage bucket | `chandra-f6e13-tutor-knowledge` | Server-side tutor knowledge/material storage bucket. |
| Frontend hosting backend ID | `chandra-frontend` | Firebase App Hosting backend ID in `firebase.json`. |
| Backend Cloud Run service | `chandra-backend` | Private FastAPI/LangGraph backend. |
| Backend service account | `chandra-backend@chandra-f6e13.iam.gserviceaccount.com` | Cloud Run runtime identity. |
| Artifact Registry repository | `chandra` | Docker images for the backend. |
| Backend image | `us-central1-docker.pkg.dev/chandra-f6e13/chandra/chandra-backend` | Cloud Run container image path. |

## Internal Frontend API Routes

Browser requests go to the Next.js frontend origin first. In production that means:

`https://chandra-frontend--chandra-f6e13.us-central1.hosted.app/api/...`

In local development that means:

`http://localhost:3000/api/...`

| Route | Purpose |
| --- | --- |
| `/api/chat` | Student tutor chat entrypoint. The Next.js server forwards LangGraph chat to the private backend when needed. |
| `/api/classes` | Create/list class data. |
| `/api/classes/join` | Student joins a class. |
| `/api/classes/resolve` | Resolve class information. |
| `/api/classes/[classId]/overview` | Teacher class overview. |
| `/api/classes/[classId]/roster/sync` | Roster sync. |
| `/api/classes/[classId]/roster/activity` | Roster activity data. |
| `/api/classes/[classId]/materials/retrieval-test` | Test class material retrieval. |
| `/api/classes/[classId]/conversations` | Teacher conversation list. |
| `/api/classes/[classId]/conversations/[conversationId]/messages` | Teacher view of conversation messages. |
| `/api/classes/[classId]/conversations/[conversationId]/review` | Teacher conversation review. |
| `/api/classes/[classId]/students/[studentId]/conversations` | Student-specific conversations for teacher views. |
| `/api/classes/[classId]/students/[studentId]/learning-profile` | Student learning profile. |
| `/api/classes/[classId]/students/[studentId]/support` | Teacher support notes/interventions. |
| `/api/materials` | Create/list uploaded or pasted class materials. |
| `/api/materials/preview` | Preview material text/content. |
| `/api/materials/extract` | Extract text from uploaded materials. |
| `/api/materials/[materialId]` | Read/update/delete a material. |
| `/api/materials/[materialId]/reprocess` | Re-run material processing/retrieval chunking. |
| `/api/student/conversations` | Student conversation list/create route. |
| `/api/student/conversations/[conversationId]/messages` | Student conversation messages. |
| `/api/student-learning-profiles/weekly` | Scheduled weekly learning profile update. Requires `LEARNING_PROFILE_UPDATE_SECRET`. |

## Private Backend API Routes

The private backend is the FastAPI service on Cloud Run. Production frontend server calls it through:

`BACKEND_API_BASE_URL=https://chandra-backend-whjsen4ula-uc.a.run.app`

| Route | Purpose | Access |
| --- | --- | --- |
| `/health` | Backend health check. | Local only without Cloud Run auth. |
| `/api/langgraph/chat` | Non-streaming LangGraph tutor response. | Requires Cloud Run auth and `X-Chandra-Internal-Secret`. |
| `/api/langgraph/chat/stream` | Streaming LangGraph tutor response. | Requires Cloud Run auth and `X-Chandra-Internal-Secret`. |
| `/api/materials/extract` | Backend material extraction route. | Requires Firebase user auth and teacher authorization. |

## Deployment Sites And Commands

| Area | Site / Command | Notes |
| --- | --- | --- |
| Frontend deploy target | Firebase App Hosting backend `chandra-frontend` | Configured in `firebase.json` and `apphosting.yaml`. |
| Backend deploy target | Cloud Run service `chandra-backend` | Configured in `cloudbuild.backend.deploy.yaml`. |
| Normal production deploy | `git push origin main` | README says production deploys are triggered from `main`. |
| Firebase rules deploy | `npx firebase deploy --only firestore:rules,storage --project chandra-f6e13` | Deploys `firestore.rules` and `storage.rules`. |
| Backend image build/deploy | `cloudbuild.backend.deploy.yaml` | Builds `backend/Dockerfile`, pushes Artifact Registry image, deploys Cloud Run. |

## Required Secret / Config Locations

| Location | Stores |
| --- | --- |
| Local `.env.local` | Local developer values only. Do not commit this file. |
| Firebase App Hosting secrets | Frontend runtime secrets like Firebase API key, OpenRouter key, Gemini key, backend shared secret, and learning profile update secret. |
| Google Secret Manager | Cloud Run backend secrets like `OPENROUTER_API_KEY`, `BACKEND_SHARED_SECRET`, Firebase API key, and `GEMINI_API_KEY`. |
| Cloud Run environment variables | Non-secret backend runtime config like model IDs, project IDs, buckets, region, and app title. |

## Key Environment Variables

| Variable | Used By | Notes |
| --- | --- | --- |
| `BACKEND_API_BASE_URL` | Frontend server | Production value is the bare Cloud Run origin. Local value is `http://127.0.0.1:8000`. |
| `BACKEND_ID_TOKEN_AUDIENCE` | Frontend server | Production value should match the bare Cloud Run origin. |
| `BACKEND_SHARED_SECRET` | Frontend and backend | Must match on both sides. Never commit it. |
| `BACKEND_CORS_ORIGINS` | Backend | Local default allows `localhost:3000`, `127.0.0.1:3000`, `localhost:3001`, and `127.0.0.1:3001`. |
| `NEXT_PUBLIC_FIREBASE_*` | Browser/frontend | Firebase web app configuration. Public values, but still managed through env/config. |
| `FIREBASE_PROJECT_ID` | Server code | Project ID for Firebase Admin. |
| `FIREBASE_STORAGE_BUCKET` | Server code | Tutor knowledge/material storage bucket. |
| `FIREBASE_SERVICE_ACCOUNT_KEY` | Server code | Optional service account JSON. Secret. |
| `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` | Server code | Optional split service account credentials. Secret. |
| `OPENROUTER_API_KEY` | Frontend server and backend | Secret for live tutor model calls. |
| `OPENROUTER_BASE_URL` | Frontend server and backend | Usually `https://openrouter.ai/api/v1`. |
| `DEFAULT_MODEL` | Frontend server and backend | Default is `openai/gpt-5.4-mini`. |
| `GEMINI_API_KEY` | Frontend server and backend | Secret used for Gemini embeddings. |
| `GOOGLE_CLOUD_PROJECT` | Embedding/retrieval code | Usually `chandra-f6e13`. |
| `GOOGLE_CLOUD_LOCATION` | Embedding/retrieval code | Configured as `us` for Gemini embeddings in production App Hosting. |
| `VERTEX_EMBEDDING_MODEL` | Embedding/retrieval code | Default/configured model is `gemini-embedding-2`. |
| `VERTEX_EMBEDDING_DIMENSIONS` | Embedding/retrieval code | Configured as `1536`. |
| `LEARNING_PROFILE_UPDATE_SECRET` | Scheduled profile route | Required bearer token for `/api/student-learning-profiles/weekly`. |

## Useful Source Files

| File | What To Check |
| --- | --- |
| `README.md` | High-level production URLs, stack, setup, deployment notes. |
| `docs/DEPLOYMENT.md` | Deployment environment variables and production guidance. |
| `firebase.json` | Firebase App Hosting backend ID and rules file locations. |
| `apphosting.yaml` | Firebase App Hosting runtime config and frontend env values. |
| `cloudbuild.backend.deploy.yaml` | Backend Cloud Build, Artifact Registry, Cloud Run, and secrets config. |
| `config/env.example` | Full local environment variable template. |
| `frontend/app/api/**/route.ts` | Frontend API route implementations. |
| `backend/main.py` | FastAPI backend routes and CORS config. |
| `frontend/lib/vertex-embeddings.ts` | Gemini/Vertex embedding API usage. |
| `backend/agent/openrouter_client.py` | OpenRouter API usage. |
