#!/usr/bin/env bash
# Run the Step CLI straight from source, for manual/tmux testing of the TUI.
#   ./step-test.sh                  # run from source
#   ./step-test.sh --no-env         # ...with provider credentials stripped
#
# Any other arguments are forwarded to the CLI unchanged.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NO_ENV=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Provider credentials discovered from the environment; see the provider
  # env-key resolution in packages/providers.
  unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY GEMINI_API_KEY \
    GROQ_API_KEY CEREBRAS_API_KEY XAI_API_KEY OPENROUTER_API_KEY ZAI_API_KEY \
    MISTRAL_API_KEY MINIMAX_API_KEY MINIMAX_CN_API_KEY AI_GATEWAY_API_KEY \
    OPENCODE_API_KEY COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN HF_TOKEN \
    STEP_API_KEY STEPFUN_API_KEY \
    GOOGLE_APPLICATION_CREDENTIALS GOOGLE_CLOUD_PROJECT GCLOUD_PROJECT \
    GOOGLE_CLOUD_LOCATION AWS_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
    AWS_SESSION_TOKEN AWS_REGION AWS_DEFAULT_REGION AWS_BEARER_TOKEN_BEDROCK \
    AWS_CONTAINER_CREDENTIALS_RELATIVE_URI AWS_CONTAINER_CREDENTIALS_FULL_URI \
    AWS_WEB_IDENTITY_TOKEN_FILE AZURE_OPENAI_API_KEY AZURE_OPENAI_BASE_URL \
    AZURE_OPENAI_RESOURCE_NAME || true
  echo "Running without API keys..."
fi

exec "$SCRIPT_DIR/node_modules/.bin/tsx" \
  --tsconfig "$SCRIPT_DIR/tsconfig.json" \
  "$SCRIPT_DIR/apps/cli/src/main.ts" ${ARGS[@]+"${ARGS[@]}"}
