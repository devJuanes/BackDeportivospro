# Deploy PM2 + Nginx (api.matupicks.app)

## 1) Variables de producción (`.env`)

Usa un `.env` de producción con estos valores clave:

- `NODE_ENV=production`
- `PORT=3009`
- `CORS_ORIGIN=https://matupicks.app,https://www.matupicks.app,https://api.matupicks.app`
- `APP_PUBLIC_URL=https://matupicks.app`
- `WOMPI_REDIRECT_URL=https://matupicks.app/predictions/vip`
- `WOMPI_ALLOW_LOCAL_REDIRECT=false`
- `WOMPI_ENV=production`
- `WOMPI_PUBLIC_KEY=pub_prod_...`
- `WOMPI_INTEGRITY_SECRET=prod_integrity_...`

No uses `redirect-url` a `localhost` en producción porque Wompi responde `403`.

## 2) Subir código al servidor

```bash
sudo mkdir -p /var/www/backdeportivospro
cd /var/www/backdeportivospro
git clone <tu-repo> .
npm ci --omit=dev
```

## 3) PM2

El repo incluye `ecosystem.config.cjs`.

```bash
cd /var/www/backdeportivospro
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```

Verifica:

```bash
pm2 status
curl http://127.0.0.1:3009/health
```

## 4) Nginx

Copiar config:

```bash
sudo cp deploy/nginx.api.matupicks.app.conf /etc/nginx/sites-available/api.matupicks.app
sudo ln -s /etc/nginx/sites-available/api.matupicks.app /etc/nginx/sites-enabled/api.matupicks.app
sudo nginx -t
sudo systemctl reload nginx
```

## 5) SSL (Let's Encrypt)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.matupicks.app
```

## 6) DNS

En tu proveedor DNS crea:

- `A` record `api` -> IP pública del servidor

## 7) Frontend

En tu app (`prediction-factory`) configura la base URL a:

- `https://api.matupicks.app`

## 8) Flujo Wompi

Con la configuración anterior:

- checkout se crea desde `https://api.matupicks.app/api/payments/wompi/checkout`
- Wompi redirige a `https://matupicks.app/predictions/vip?id=<transaction_id>`
- frontend confirma en backend y se activa VIP al estado `APPROVED`
