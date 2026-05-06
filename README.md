# Chandra

Chandra is a teacher-guided AI learning platform. Teachers define how an AI tutor should behave for a course or assignment, upload source material, and review student conversations to understand where students are getting stuck.

The first version in this repository is a working product scaffold:

- Student chat experience with course, model, and assignment context.
- Teacher dashboard for behavior controls, hidden instructions, documents, and conversation review.
- Prompt assembly that separates visible classroom guidance from hidden teacher policy.
- Firestore-backed tutor knowledge retrieval with Vertex AI embeddings and Firestore Vector Search.
- Chat API that runs in demo mode without credentials and can call any OpenRouter model when configured.

## Getting Started

```bash
npm install
npm run dev
```

Open `http://localhost:3000`.

## Firebase Accounts

Chandra uses Firebase Authentication for student and teacher accounts, with Firestore storing the role profile at `users/{uid}`.

1. Create a Firebase project.
2. Add a Web app in Firebase project settings.
3. Enable Authentication -> Sign-in method -> Email/Password.
4. Create a Firestore database.
5. Copy `.env.example` to `.env.local` and fill in the Firebase web app values:

```bash
NEXT_PUBLIC_FIREBASE_API_KEY=
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=
NEXT_PUBLIC_FIREBASE_PROJECT_ID=
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=
NEXT_PUBLIC_FIREBASE_APP_ID=
```

Restart `npm run dev` after changing `.env.local`.

Suggested starter Firestore rules for local development are included in `firestore.rules`:

```txt
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId} {
      allow create: if request.auth != null && request.auth.uid == userId;
      allow read, update: if request.auth != null && request.auth.uid == userId;
    }

    match /classes/{classId} {
      allow create: if request.auth != null
        && request.resource.data.teacherId == request.auth.uid;
      allow read, update, delete: if request.auth != null
        && resource.data.teacherId == request.auth.uid;
    }
  }
}
```

Publish the full rules from `firestore.rules` in the Firebase console under Firestore Database -> Rules,
or deploy them with the Firebase CLI:

```bash
firebase deploy --only firestore:rules
```

These rules are intentionally narrow. Teacher access to student conversations should use a course membership model before production.

## Server Firebase Admin + Storage

Tutor knowledge uploads are processed by server routes that verify the teacher's Firebase ID token,
write Firestore metadata/chunks, store the original uploaded file in Firebase Storage, and optionally
generate Vertex AI embeddings for Firestore Vector Search. In addition to the public Firebase web app
values above, configure server credentials with either:

```bash
FIREBASE_SERVICE_ACCOUNT_KEY='{"project_id":"...","client_email":"...","private_key":"..."}'
```

or:

```bash
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=
FIREBASE_STORAGE_BUCKET=
```

`FIREBASE_STORAGE_BUCKET` can match `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET`. Deploy both
`firestore.rules` and `storage.rules` before testing uploads against a real Firebase project:

```bash
firebase deploy --only firestore:rules,storage
```

## Gemini Embeddings + Firestore Vector Search

Tutor knowledge originals stay in Firebase Storage. Extracted text is chunked and saved under
`classes/{classId}/materials/{materialId}/chunks/{chunkId}` with the chunk text, class/material metadata,
and, when configured, an `embedding` Firestore vector field created by Gemini embeddings.

Configure Gemini embeddings:

```bash
GEMINI_API_KEY=your_gemini_api_key
VERTEX_EMBEDDING_MODEL=gemini-embedding-2
VERTEX_EMBEDDING_DIMENSIONS=768
```

`gemini-embedding-2` uses the Gemini API `:embedContent` endpoint. Chandra passes text plus PDF page slices
as inline parts so diagrams and math notation can be embedded with the extracted text.

For older Vertex text embedding models like `gemini-embedding-001`, credentials can come from Application
Default Credentials, `GOOGLE_APPLICATION_CREDENTIALS`, a JSON value in `GOOGLE_APPLICATION_CREDENTIALS_JSON`,
or the Firebase service account env vars above if that service account has Vertex AI permissions.

Create the Firestore vector index for Chandra's nested `chunks` subcollections:

```bash
gcloud firestore indexes composite create \
  --database="(default)" \
  --collection-group=chunks \
  --query-scope=collection-group \
  --field-config=field-path=classId,order=ASCENDING \
  --field-config=field-path=embedding,vector-config='{"dimension":"768","flat":"{}"}'
```

Use the same dimension as `VERTEX_EMBEDDING_DIMENSIONS`. The app logs and falls back to keyword retrieval
if the vector index is missing; if Firestore prints a generated missing-index command for your project,
prefer that exact command.

## Model Provider

Copy `.env.example` to `.env.local` to enable live model calls:

```bash
OPENROUTER_API_KEY=your_key_here
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
DEFAULT_MODEL=openai/gpt-5.4-mini
```

Without `OPENROUTER_API_KEY`, the API returns a guided demo response so the UI remains usable. Teachers can add any OpenRouter model ID from the dashboard, such as `openai/gpt-5.4-mini`, `anthropic/claude-3.5-sonnet`, or `meta-llama/llama-3.1-70b-instruct`.

## LangGraph PDF RAG Student Chat

Student chat now routes through a controlled LangGraph PDF RAG flow:

```txt
User -> OpenRouter agent -> optional search_pdf_pages tool -> Gemini Embedding retrieval -> selected PDF pages rendered -> OpenRouter multimodal answer
```

OpenRouter is always called first. It decides whether the question needs PDF context by returning a
`search_pdf_pages` tool call. LangGraph then executes retrieval against indexed page-window metadata,
renders or extracts only the selected PDF pages, and calls OpenRouter again with those selected page
assets as multimodal context. If the selected pages are insufficient or mismatched, OpenRouter can call
`search_pdf_pages` again with a sharper query; the graph allows up to 8 total searches. The final answer
is instructed to use only the provided selected pages and to say when the answer is not present there.

Each backend response includes a `langGraphTrace` object with the node stages, search queries, selected
pages, and tool-call count so you can inspect where a request went after it completes. Live per-stage UI
progress would use a streaming LangGraph events endpoint.

The Next `/api/chat` route keeps Chandra's existing student/teacher-preview authentication and response
shape, then delegates the model runtime to the FastAPI endpoint at `/api/langgraph/chat`. Configure the
backend URL for the Next server with:

```bash
BACKEND_API_BASE_URL=http://127.0.0.1:8000
```

If the FastAPI backend is exposed outside local development, set the same `BACKEND_SHARED_SECRET` in both
the Next and FastAPI environments.

## Product Direction

Chandra is built around four core objects:

- `Course`: a classroom context with selected model options and teacher-owned policies.
- `TutorPolicy`: behavioral instructions such as "do not give final answers" and whether instructions are hidden from students.
- `SourceDocument`: teacher-uploaded PDFs, notes, examples, and other reference material.
- `Conversation`: recorded student interactions that teachers can review and summarize.

## Near-Term Roadmap

- Authentication and roles for teachers and students.
- Persistent storage for courses, policies, documents, and conversations.
- PDF upload, parsing, chunking, embeddings, and source-grounded retrieval.
- Teacher-generated summaries of common struggles across a class.
- LMS integrations and classroom roster import.
