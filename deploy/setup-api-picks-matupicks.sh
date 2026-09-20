#!/usr/bin/env bash
# Deploy + PM2 + Nginx para api.picks.matupicks.app
# Uso en servidor:
#   bash deploy/setup-api-picks-matupicks.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/backdeportivospro}"
REPO_URL="${REPO_URL:-https://github.com/devJuanes/BackDeportivospro.git}"
BRANCH="${BRANCH:-api}"
DOMAIN="api.picks.matupicks.app"
PM2_APP="backdeportivospro"
NGINX_SRC="$APP_DIR/deploy/nginx.api.picks.matupicks.app.conf"
NGINX_AVAIL="/etc/nginx/sites-available/$DOMAIN"
NGINX_ENABLED="/etc/nginx/sites-enabled/$DOMAIN"

export DEBIAN_FRONTEND=noninteractive

echo "==> Paquetes base"
apt-get update -y
apt-get install -y nginx git curl ca-certificates

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo "==> Código en $APP_DIR"
mkdir -p "$APP_DIR"
if [[ -d "$APP_DIR/.git" ]]; then
  cd "$APP_DIR"
  git fetch origin
  git checkout "$BRANCH"
  git pull --ff-only origin "$BRANCH"
else
  git clone -b "$BRANCH" "$REPO_URL" "$APP_DIR"
  cd "$APP_DIR"
fi

if [[ ! -f "$APP_DIR/.env" ]]; then
  echo "WARN: no hay .env — copia uno de producción antes de arrancar."
fi

# Asegura URLs públicas para logos
if [[ -f "$APP_DIR/.env" ]]; then
  if grep -q '^PUBLIC_BASE_URL=' "$APP_DIR/.env"; then
    sed -i "s|^PUBLIC_BASE_URL=.*|PUBLIC_BASE_URL=https://$DOMAIN|" "$APP_DIR/.env"
  else
    echo "PUBLIC_BASE_URL=https://$DOMAIN" >> "$APP_DIR/.env"
  fi
  if grep -q '^CORS_ORIGIN=' "$APP_DIR/.env"; then
    # añade el dominio si falta
    if ! grep -q "$DOMAIN" "$APP_DIR/.env"; then
      sed -i "s|^CORS_ORIGIN=\\(.*\\)|CORS_ORIGIN=\\1,https://$DOMAIN|" "$APP_DIR/.env"
    fi
  else
    echo "CORS_ORIGIN=https://matupicks.app,https://www.matupicks.app,https://$DOMAIN,https://picks.matupicks.app" >> "$APP_DIR/.env"
  fi
fi

echo "==> npm ci"
npm ci --omit=dev

mkdir -p logs

echo "==> PM2"
pm2 delete "$PM2_APP" >/dev/null 2>&1 || true
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

echo "==> Nginx $DOMAIN"
cp "$NGINX_SRC" "$NGINX_AVAIL"
ln -sfn "$NGINX_AVAIL" "$NGINX_ENABLED"
nginx -t
systemctl reload nginx

echo "==> Health local"
sleep 2
curl -fsS "http://127.0.0.1:3009/health" || true
echo
echo "Listo. DNS A: $DOMAIN -> IP del server"
echo "SSL: certbot --nginx -d $DOMAIN"
echo "URL: https://$DOMAIN"
