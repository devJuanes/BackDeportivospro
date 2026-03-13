# DeportivosPro - Fabrica Automatica de Pronosticos 24/7

Backend modular en Node.js para:

- scraping de pronosticos
- generacion automatica de picks
- monitoreo live
- recoleccion de noticias
- API REST para app movil/web
- envio por WhatsApp

## Requisitos

- Node.js 20+
- MatuDB + `@devjuanes/matuclient`

## Configuracion

1. Copia `.env.example` a `.env`.
2. Configura MatuDB en `.env`:
   - `MATUDB_URL`
   - `MATUDB_PROJECT_ID`
   - `MATUDB_API_KEY`
3. Activa o desactiva servicios:
   - `ENABLE_CRON=true`
   - `WHATSAPP_ENABLED=true|false`
4. Para activar WhatsApp con QR:
   - coloca `WHATSAPP_ENABLED=true`
   - inicia el servidor (`npm run dev`)
   - escanea el QR que aparece en consola
   - cuando salga `WhatsApp bot conectado`, ya puede enviar notificaciones

## Instalar y ejecutar

```bash
npm install
npm run db:schema
npm run dev
```

## Endpoints

- `GET /api/predictions/free`
- `GET /api/predictions/free?today=true&sport=football`
- `GET /api/predictions/free/summary/today`
- `PATCH /api/predictions/free/:id/state`
- `GET /api/predictions/vip`
- `GET /api/predictions/vip?today=true&sport=football`
- `GET /api/predictions/vip/summary/today`
- `PATCH /api/predictions/vip/:id/state`
- `GET /api/predictions/live`
- `GET /api/news`
- `POST /api/predictions/free`
- `POST /api/predictions/vip`
- `POST /api/predictions/live`
- `GET /api/factory/status`
- `POST /api/factory/run-now`
- `GET /api/factory/sources`
- `POST /api/factory/sources/sync-default`
- `GET /api/whatsapp/status`
- `POST /api/whatsapp/test`

## Cron jobs configurados

- `*/5 * * * *`: ciclo de fábrica (lotes + live)
- `* * * * *`: monitor en vivo cada minuto
- `*/30 * * * *`: noticias/contexto

## Bot WhatsApp (chatbot)

Comandos desde WhatsApp:

- `menu`
- `free`
- `vip`
- `live`
- `generar`
- `estado`

## Notas de MatuDB

- Project ID: `01d7fb93-486a-445d-b5ae-e307166aeba3`
- API Key (anon): `mb_9f9664f50334565572cd76c2b4cb6d8999d276358e8649853ba282a09a10b602`

Estas credenciales se dejaron en `.env.example` para referencia y el backend ya usa `@devjuanes/matuclient` como cliente oficial de MatuDB.
