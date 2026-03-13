#!/usr/bin/env bash
set -Eeuo pipefail

# Deploy script para BackDeportivospro
# Uso:
#   bash deploy.sh                # despliega rama actual
#   bash deploy.sh main           # despliega rama específica
#
# Variables opcionales:
#   APP_NAME=backdeportivospro
#   APP_START_CMD="npm start"
#   USE_PM2=true|false            # por defecto true si pm2 está instalado

APP_NAME="${APP_NAME:-backdeportivospro}"
APP_START_CMD="${APP_START_CMD:-npm start}"
TARGET_BRANCH="${1:-}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_DIR="$ROOT_DIR/logs"
LOCK_FILE="$ROOT_DIR/.deploy.lock"
TIMESTAMP="$(date +"%Y%m%d-%H%M%S")"
DEPLOY_LOG="$LOG_DIR/deploy-$TIMESTAMP.log"
LATEST_LOG="$LOG_DIR/deploy-latest.log"
PID_FILE="$ROOT_DIR/.app.pid"

mkdir -p "$LOG_DIR"
exec > >(tee -a "$DEPLOY_LOG") 2>&1
ln -sfn "$DEPLOY_LOG" "$LATEST_LOG"

echo "=================================================="
echo "[$(date -Is)] Iniciando deploy: $APP_NAME"
echo "ROOT_DIR=$ROOT_DIR"
echo "=================================================="

# Lock para evitar deploys paralelos
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK_FILE"
  flock -n 9 || {
    echo "[$(date -Is)] Otro deploy está en ejecución. Abortando."
    exit 1
  }
fi

cd "$ROOT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "[$(date -Is)] ERROR: git no está instalado."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[$(date -Is)] ERROR: npm no está instalado."
  exit 1
fi

if [ ! -d ".git" ]; then
  echo "[$(date -Is)] ERROR: este directorio no es un repositorio git."
  exit 1
fi

CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if [ "$CURRENT_BRANCH" = "HEAD" ] && [ -z "$TARGET_BRANCH" ]; then
  echo "[$(date -Is)] ERROR: HEAD detached. Pasa la rama: bash deploy.sh <rama>"
  exit 1
fi

if [ -z "$TARGET_BRANCH" ]; then
  TARGET_BRANCH="$CURRENT_BRANCH"
fi

echo "[$(date -Is)] Rama objetivo: $TARGET_BRANCH"
echo "[$(date -Is)] Commit antes: $(git rev-parse --short HEAD)"

echo "[$(date -Is)] Fetch remoto..."
git fetch --all --prune

echo "[$(date -Is)] Checkout rama..."
git checkout "$TARGET_BRANCH"

echo "[$(date -Is)] Pull cambios..."
git pull --ff-only origin "$TARGET_BRANCH"

echo "[$(date -Is)] Commit después: $(git rev-parse --short HEAD)"

echo "[$(date -Is)] Instalando dependencias..."
if [ -f "package-lock.json" ]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

echo "[$(date -Is)] Build (si aplica)..."
npm run build --if-present

echo "[$(date -Is)] Migraciones/schema (si aplica)..."
npm run db:schema --if-present

# Decide gestor de proceso
if [ -z "${USE_PM2:-}" ]; then
  if command -v pm2 >/dev/null 2>&1; then
    USE_PM2="true"
  else
    USE_PM2="false"
  fi
fi

if [ "$USE_PM2" = "true" ]; then
  echo "[$(date -Is)] Reiniciando con PM2..."
  if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
    pm2 restart "$APP_NAME" --update-env
  else
    pm2 start $APP_START_CMD --name "$APP_NAME"
  fi
  pm2 save
  echo "[$(date -Is)] PM2 status:"
  pm2 status "$APP_NAME" || true
else
  echo "[$(date -Is)] PM2 no disponible. Usando nohup."
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" >/dev/null 2>&1; then
    kill "$(cat "$PID_FILE")" || true
    sleep 1
  fi
  nohup bash -lc "$APP_START_CMD" >> "$LOG_DIR/app.log" 2>&1 &
  echo $! > "$PID_FILE"
  echo "[$(date -Is)] App iniciada. PID=$(cat "$PID_FILE")"
fi

echo "=================================================="
echo "[$(date -Is)] Deploy finalizado correctamente."
echo "Log deploy: $DEPLOY_LOG"
echo "=================================================="
