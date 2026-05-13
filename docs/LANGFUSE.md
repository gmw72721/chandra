# Langfuse Observability and Evals

## Environment

Set these in `.env.local`, Cloud Run, and any server-side Next.js runtime that should send traces:

```bash
LANGFUSE_PUBLIC_KEY=
LANGFUSE_SECRET_KEY=
LANGFUSE_HOST=
LANGFUSE_TRACING_ENABLED=1
LANGFUSE_ENVIRONMENT=local
```

Optional eval settings:

```bash
CHANDRA_EVAL_DATASET_NAME=chandra/tutor-core
CHANDRA_EVAL_USE_LLM_JUDGE=0
CHANDRA_EVAL_JUDGE_MODEL=openai/gpt-5.4-mini
```

Never put Langfuse keys in source control. The app only checks whether the keys are present.

## Tracing

The backend uses Langfuse SDK context-manager instrumentation because production model calls go through raw OpenRouter HTTP clients, not an OpenAI SDK, Vercel AI SDK, or LangChain model wrapper. Tracing is disabled automatically when Langfuse env vars are absent or `LANGFUSE_TRACING_ENABLED=0`.

Instrumented workflows:

- `fastapi.langgraph-chat` and `fastapi.langgraph-chat-stream`
- `langgraph.primary-tutor-turn`
- `langgraph.context-grounded-answer`
- `fastapi.legacy-chat`
- `fastapi.legacy-openrouter-chat`
- `next.student-learning-profile-update`

Trace input/output is explicitly summarized. The instrumentation records message counts, latest student-message preview, model, usage, finish reason, route/workflow tags, `session_id` from conversation IDs, and `user_id` from student/teacher IDs when available. It redacts sensitive keys and avoids raw file payloads, auth headers, OCR dumps, and full conversation payloads.

Serverless and short-lived flows call `flush()` or use immediate OpenTelemetry export where practical.

## Prompt Links

When a prompt is fetched from Langfuse with the `production` label and the SDK returns a real prompt object, the generation observation receives that prompt object so Langfuse can link the trace to the prompt version. If Langfuse is unavailable or a prompt falls back to local text, no fake prompt link is attached.

Seed or update prompt versions:

```bash
node --env-file=.env.local scripts/seed-langfuse-prompts.mjs
```

The seed script refuses to create remote prompts whose whole body is only a single variable.

## Evals

The core local dataset is:

```bash
evals/chandra-tutor-core.json
```

Run deterministic local evals without sending anything to Langfuse:

```bash
node scripts/run-langfuse-evals.mjs --local-only
```

Run a Langfuse experiment on the local dataset:

```bash
npm run eval:langfuse
```

Seed the dataset into Langfuse:

```bash
node --env-file=.env.local scripts/run-langfuse-evals.mjs --seed-dataset
```

Run against the hosted Langfuse dataset:

```bash
node --env-file=.env.local scripts/run-langfuse-evals.mjs --langfuse-dataset --dataset chandra/tutor-core
```

Enable the optional isolated LLM judge:

```bash
CHANDRA_EVAL_USE_LLM_JUDGE=1 node --env-file=.env.local scripts/run-langfuse-evals.mjs
```

The deterministic evaluators cover task success, groundedness/faithfulness, safety/refusal behavior, output format validity, and latency metadata. The LLM judge is off by default and uses only sanitized eval fixtures, not production user data.

## Langfuse UI

Use:

- **Tracing** to inspect request traces and nested generation observations.
- **Sessions** to inspect multi-turn conversations grouped by `session_id`.
- **Prompts > Metrics** to compare linked generations by prompt version.
- **Datasets** to review the seeded eval cases.
- **Experiments** to compare eval runs.
- **Scores** to filter deterministic and judge scores.
