#!/usr/bin/env bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-chandra-f6e13}"
REGION="${REGION:-us-central1}"
SERVICE="${SERVICE:-chandra-backend}"
ENV_FILE="${ENV_FILE:-.env.local}"
REPOSITORY="${REPOSITORY:-chandra}"
SERVICE_ACCOUNT_NAME="${SERVICE_ACCOUNT_NAME:-chandra-backend}"
SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
IMAGE_TAG="${IMAGE_TAG:-$(date +%Y%m%d%H%M%S)}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:${IMAGE_TAG}"
CACHE_IMAGE="${CACHE_IMAGE:-${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPOSITORY}/${SERVICE}:latest}"
BUILD_IGNORE_FILE="${BUILD_IGNORE_FILE:-.gcloudignore.backend}"
PROVISION_INFRA="${PROVISION_INFRA:-0}"
SYNC_SECRETS="${SYNC_SECRETS:-0}"

secret_env_names=(
  OPENROUTER_API_KEY
  BACKEND_SHARED_SECRET
  NEXT_PUBLIC_FIREBASE_API_KEY
  GEMINI_API_KEY
)

plain_env_names=(
  CHANDRA_ENV
  FRONTEND_ORIGIN
  NEXT_INTERNAL_BASE_URL
  BACKEND_CORS_ORIGINS
  OPENROUTER_BASE_URL
  OPENROUTER_HTTP_REFERER
  OPENROUTER_APP_TITLE
  DEFAULT_MODEL
  FIREBASE_PROJECT_ID
  FIREBASE_STORAGE_BUCKET
  NEXT_PUBLIC_FIREBASE_PROJECT_ID
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET
  GOOGLE_CLOUD_PROJECT
  GOOGLE_CLOUD_LOCATION
  VERTEX_EMBEDDING_MODEL
  VERTEX_EMBEDDING_DIMENSIONS
)

secret_id_for_env_name() {
  printf 'chandra-backend-%s' "$(printf '%s' "$1" | tr '[:upper:]_' '[:lower:]-')"
}

env_value() {
  local name="$1"
  awk -v key="$name" '
    BEGIN { prefix = key "=" }
    index($0, prefix) == 1 {
      value = substr($0, length(prefix) + 1)
      sub(/^[[:space:]]+/, "", value)
      sub(/[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "'"'"'" && substr(value, length(value), 1) == "'"'"'")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$ENV_FILE"
}

require_env_value() {
  local name="$1"
  local value
  value="$(env_value "$name")"
  if [[ -z "$value" ]]; then
    printf 'Missing required %s in %s\n' "$name" "$ENV_FILE" >&2
    exit 1
  fi
  printf '%s' "$value"
}

ensure_secret() {
  local env_name="$1"
  local secret_id
  local value
  secret_id="$(secret_id_for_env_name "$env_name")"
  value="$(require_env_value "$env_name")"

  if ! gcloud secrets describe "$secret_id" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud secrets create "$secret_id" --project "$PROJECT_ID" --replication-policy automatic >/dev/null
  fi

  printf '%s' "$value" | gcloud secrets versions add "$secret_id" --project "$PROJECT_ID" --data-file=- >/dev/null
  gcloud secrets add-iam-policy-binding "$secret_id" \
    --project "$PROJECT_ID" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/secretmanager.secretAccessor \
    --quiet >/dev/null
}

join_by_comma() {
  local IFS=,
  printf '%s' "$*"
}

if [[ ! -f "$ENV_FILE" ]]; then
  printf 'Missing env file: %s\n' "$ENV_FILE" >&2
  exit 1
fi

if [[ -n "$BUILD_IGNORE_FILE" && ! -f "$BUILD_IGNORE_FILE" ]]; then
  printf 'Missing build ignore file: %s\n' "$BUILD_IGNORE_FILE" >&2
  exit 1
fi

if [[ "$PROVISION_INFRA" == "1" ]]; then
  gcloud config set project "$PROJECT_ID" >/dev/null
  gcloud services enable \
    artifactregistry.googleapis.com \
    cloudbuild.googleapis.com \
    iam.googleapis.com \
    run.googleapis.com \
    secretmanager.googleapis.com \
    --project "$PROJECT_ID" >/dev/null

  if ! gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
      --project "$PROJECT_ID" \
      --display-name "Chandra backend Cloud Run" >/dev/null
  fi

  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/datastore.user \
    --quiet >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/storage.objectViewer \
    --quiet >/dev/null
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member "serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \
    --role roles/aiplatform.user \
    --quiet >/dev/null

  if ! gcloud artifacts repositories describe "$REPOSITORY" --location "$REGION" --project "$PROJECT_ID" >/dev/null 2>&1; then
    gcloud artifacts repositories create "$REPOSITORY" \
      --repository-format docker \
      --location "$REGION" \
      --project "$PROJECT_ID" \
      --description "Chandra containers" >/dev/null
  fi
fi

if [[ "$SYNC_SECRETS" == "1" ]]; then
  for env_name in "${secret_env_names[@]}"; do
    ensure_secret "$env_name"
  done
fi

plain_env_pairs=("CHANDRA_ENV=production")
for env_name in "${plain_env_names[@]}"; do
  if [[ "$env_name" == "CHANDRA_ENV" ]]; then
    continue
  fi
  plain_env_pairs+=("${env_name}=$(require_env_value "$env_name")")
done

secret_env_pairs=()
for env_name in "${secret_env_names[@]}"; do
  secret_env_pairs+=("${env_name}=$(secret_id_for_env_name "$env_name"):latest")
done

build_ignore_args=()
if [[ -n "$BUILD_IGNORE_FILE" ]]; then
  build_ignore_args=(--ignore-file "$BUILD_IGNORE_FILE")
fi

gcloud builds submit \
  "${build_ignore_args[@]}" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --config deployment/cloudbuild.backend.yaml \
  --substitutions "_IMAGE=${IMAGE},_CACHE_IMAGE=${CACHE_IMAGE}" \
  .

gcloud run deploy "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --platform managed \
  --image "$IMAGE" \
  --service-account "$SERVICE_ACCOUNT_EMAIL" \
  --port 8000 \
  --no-allow-unauthenticated \
  --ingress all \
  --timeout 900s \
  --concurrency 10 \
  --cpu 1 \
  --memory 2Gi \
  --min-instances 0 \
  --max-instances 5 \
  --set-env-vars "$(join_by_comma "${plain_env_pairs[@]}")" \
  --set-secrets "$(join_by_comma "${secret_env_pairs[@]}")"

gcloud run services describe "$SERVICE" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format 'value(status.url)'
