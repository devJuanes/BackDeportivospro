#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
BRANCH="${1:-main}"
PM2_APP="${PM2_APP:-backdeportivospro}"
ENV_BAK="/tmp/BackDeportivospro.env.$$"
if [[ -f .env ]]; then cp .env "$ENV_BAK"; fi
git pull origin "$BRANCH"
if [[ -f "$ENV_BAK" ]]; then mv "$ENV_BAK" .env; fi
npm ci --omit=dev
pm2 restart "$PM2_APP" --update-env || pm2 start src/server.js --name "$PM2_APP"
echo "Backend desplegado (PM2: $PM2_APP)."
