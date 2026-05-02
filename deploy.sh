#!/usr/bin/env bash
set -euo pipefail

# Deploy unificado (Hostinger / VPS):
# - Backend: /root/apps/BackDeportivospro
# - Frontend: /var/www/prediction-factory
#
# Uso:
#   bash deploy.sh
#   bash deploy.sh main
#
# Variables opcionales:
#   BACKEND_DIR=/ruta/backend FRONTEND_DIR=/ruta/front PM2_APP=backdeportivospro bash deploy.sh
#
# VPS pequeño (KVM1): en el .env del backend deja WHATSAPP_ENABLED=false, CRON_FACTORY_EXPRESSION=*/15 * * * *,
# FACTORY_CYCLE_INCLUDES_LIVE=false y FACTORY_AI_MATCH_LIMIT bajo (ej. 6). Evita Chromium salvo que lo necesites.

BRANCH="${1:-main}"
BACKEND_DIR="${BACKEND_DIR:-/root/apps/BackDeportivospro}"
FRONTEND_DIR="${FRONTEND_DIR:-/var/www/prediction-factory}"
PM2_APP="${PM2_APP:-backdeportivospro}"

timestamp() { date +"%Y-%m-%d %H:%M:%S"; }
log() { printf "\n[%s] %s\n" "$(timestamp)" "$*"; }

if ! command -v git >/dev/null 2>&1; then
  echo "ERROR: git no está instalado."
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm no está instalado."
  exit 1
fi
if ! command -v pm2 >/dev/null 2>&1; then
  echo "ERROR: pm2 no está instalado."
  exit 1
fi
if ! command -v sudo >/dev/null 2>&1; then
  echo "ERROR: sudo no está disponible."
  exit 1
fi

if [ ! -d "$BACKEND_DIR" ]; then
  echo "ERROR: no existe BACKEND_DIR: $BACKEND_DIR"
  exit 1
fi
if [ ! -d "$FRONTEND_DIR" ]; then
  echo "ERROR: no existe FRONTEND_DIR: $FRONTEND_DIR"
  exit 1
fi

BACKEND_ENV_BAK="/tmp/backdeportivospro.env.$(date +%s).bak"
FRONTEND_ENV_BAK="/tmp/prediction-factory.env.$(date +%s).bak"

cleanup() {
  rm -f "$BACKEND_ENV_BAK" "$FRONTEND_ENV_BAK" 2>/dev/null || true
}
trap cleanup EXIT

log "Deploy backend ($BACKEND_DIR) rama: $BRANCH"
cd "$BACKEND_DIR"
if [ -f .env ]; then
  cp .env "$BACKEND_ENV_BAK"
fi
git pull origin "$BRANCH"
if [ -f "$BACKEND_ENV_BAK" ]; then
  cp "$BACKEND_ENV_BAK" .env
fi
npm ci --omit=dev
pm2 restart "$PM2_APP" --update-env

log "Deploy frontend ($FRONTEND_DIR) rama: $BRANCH"
cd "$FRONTEND_DIR"
if [ -f .env ]; then
  cp .env "$FRONTEND_ENV_BAK"
fi
git pull origin "$BRANCH"
if [ -f "$FRONTEND_ENV_BAK" ]; then
  cp "$FRONTEND_ENV_BAK" .env
fi
npm ci
npm run build
sudo systemctl reload nginx

log "Validación rápida"
curl -fsS https://api.matupicks.app/api/payments/wompi/status >/dev/null && echo "OK backend API"
curl -fsSI https://matupicks.app/sitemap.xml >/dev/null && echo "OK frontend sitemap"

log "Deploy completado con éxito."
