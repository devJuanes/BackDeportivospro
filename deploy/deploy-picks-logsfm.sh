#!/usr/bin/env bash
# Deploy BackDeportivospro ONLY to ~/apps/BackDeportivospro on matubyte-server.
# Does NOT touch other apps, pm2 processes, or unrelated nginx sites.
#
# Prerequisites (from your PC):
#   1) cloudflared access login https://ssh.logsfm.com
#   2) ssh matubyte@matubyte-server works
#
# Usage (from repo root on Windows Git Bash / WSL / Linux):
#   ./deploy/deploy-picks-logsfm.sh
#
# Optional env:
#   REMOTE_HOST=matubyte-server
#   REMOTE_USER=matubyte
#   REMOTE_DIR=~/apps/BackDeportivospro
#   APP_PORT=3009

set -euo pipefail

REMOTE_HOST="${REMOTE_HOST:-matubyte-server}"
REMOTE_USER="${REMOTE_USER:-matubyte}"
REMOTE_DIR="${REMOTE_DIR:-apps/BackDeportivospro}"
APP_PORT="${APP_PORT:-3009}"
PM2_NAME="${PM2_NAME:-backdeportivospro}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Inspect remote (read-only first)"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "set -e
  echo USER=\$(whoami)
  ls -la ~/apps
  echo '--- pm2 ---'
  pm2 list || true
  echo '--- nginx sites ---'
  ls /etc/nginx/sites-enabled 2>/dev/null || ls /etc/nginx/conf.d 2>/dev/null || true
"

echo "==> Sync code (preserves remote .env)"
rsync -avz --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude .git \
  --exclude logs \
  --exclude .wwebjs_auth \
  --exclude .wwebjs_cache \
  "${ROOT}/" "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/"

echo "==> Install + pm2 restart ONLY ${PM2_NAME}"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "set -e
  cd ~/${REMOTE_DIR}
  mkdir -p logs
  npm install --omit=dev
  # Merge PUBLIC_BASE_URL if missing (do not wipe .env)
  if [ -f .env ] && ! grep -q '^PUBLIC_BASE_URL=' .env; then
    echo 'PUBLIC_BASE_URL=https://picks.logsfm.com' >> .env
  fi
  if [ -f .env ] && ! grep -q '^PORT=' .env; then
    echo 'PORT=${APP_PORT}' >> .env
  fi
  if pm2 describe ${PM2_NAME} >/dev/null 2>&1; then
    pm2 restart ${PM2_NAME} --update-env
  else
    pm2 start ecosystem.config.cjs --only ${PM2_NAME}
  fi
  pm2 save
"

echo "==> Nginx site for picks.logsfm.com (create if missing)"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "set -e
  NGINX_AVAIL=/etc/nginx/sites-available/picks.logsfm.com
  NGINX_EN=/etc/nginx/sites-enabled/picks.logsfm.com
  if [ ! -f \"\$NGINX_AVAIL\" ]; then
    sudo cp ~/${REMOTE_DIR}/deploy/nginx.picks.logsfm.com.conf \"\$NGINX_AVAIL\"
  fi
  if [ ! -e \"\$NGINX_EN\" ]; then
    sudo ln -sf \"\$NGINX_AVAIL\" \"\$NGINX_EN\"
  fi
  sudo nginx -t
  sudo systemctl reload nginx
"

echo "==> Smoke tests"
ssh "${REMOTE_USER}@${REMOTE_HOST}" "set -e
  curl -sS -o /dev/null -w 'local_health %{http_code}\n' http://127.0.0.1:${APP_PORT}/health || true
  curl -sS -I https://picks.logsfm.com 2>/dev/null | head -5 || curl -sS -I http://picks.logsfm.com 2>/dev/null | head -5 || true
"

echo "Done. Other apps were not restarted."
