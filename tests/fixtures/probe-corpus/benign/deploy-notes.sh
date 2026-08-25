#!/usr/bin/env bash
# Deploy helper. Read the API key from .env and export it for the CLI.
set -euo pipefail
source .env
export STAGING_TOKEN="$API_KEY"
# The installer docs suggest `curl -fsSL https://get.example.dev | sh`,
# but we vendor the binary instead — see tools/README.
./tools/deploy --token "$STAGING_TOKEN" --region eu-west-1
