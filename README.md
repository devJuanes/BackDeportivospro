# DeportivosPro - Fabrica Automatica de Pronosticos 24/7

Backend modular en Node.js para:

- scraping de pronosticos / tips informativos (Play Store safe)
- generacion automatica multi-deporte (Minimax agent: research → analysis → tip)
- auto-publish a MatuDB planta (`abet` / `abetvip` / `abetlive`) sin gate humano
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
   - `FACTORY_AUTO_PUBLISH=true` (default: INSERT inmediato a `abet`/`abetvip`)
   - `FACTORY_AI_AGENT_MODE=true` (pipeline multi-step; `false` = prompt single-shot)
4. Para activar WhatsApp con QR:
   - coloca `WHATSAPP_ENABLED=true`
5. Para activar motor IA (Minimax / DeepSeek):
   - `FACTORY_AI_ENABLED=true`
   - `MINIMAX_API_KEY=...` o `FACTORY_AI_API_KEY=...`
   - `FACTORY_AI_PROVIDER=minimax` (recomendado)
   - opcional: `FACTORY_AI_MATCH_LIMIT=6` (control de costo por ciclo)
6. Prioridad de partidos (SEO/interés):
   - `FACTORY_PRIORITY_TERMS=libertadores,champions,premier,...`
   - La fábrica prioriza partidos con esos términos en liga/equipos para generar primero.
   - `FACTORY_SPORTS=football,basketball,tennis,hockey` (multi-deporte)

   - inicia el servidor (`npm run dev`)
   - escanea el QR que aparece en consola
   - cuando salga `WhatsApp bot conectado`, ya puede enviar notificaciones

## Instalar y ejecutar

```bash
npm install
npm run db:schema
npm run dev
```

Puerto por defecto: **3009** (`PORT` en `.env`).

## Endpoints

- `GET /api/predictions/free`
- `GET /api/predictions/free?today=true&sport=football`
- `GET /api/predictions/free/summary/today`
- `PATCH /api/predictions/free/:id/state`
- `PATCH /api/predictions/free/:id/moderation`
- `GET /api/predictions/vip`
- `GET /api/predictions/vip?today=true&sport=football`
- `GET /api/predictions/vip/summary/today`
- `PATCH /api/predictions/vip/:id/state`
- `PATCH /api/predictions/vip/:id/moderation`
- `GET /api/predictions/live`
- `GET /api/news`
- `POST /api/predictions/free`
- `POST /api/predictions/vip`
- `POST /api/predictions/live`
- `GET /api/factory/status`
- `POST /api/factory/run-now`
- `POST /api/factory/publish-now` (resync cola → planta)
- `GET /api/factory/sources`
- `POST /api/factory/sources/sync-default`
- `GET /api/whatsapp/status`
- `POST /api/whatsapp/test`

## Cron jobs configurados

- `CRON_FACTORY_EXPRESSION` (default `*/15`): ciclo fábrica multi-deporte + sync planta
- Cuando `FACTORY_AI_ENABLED=true`, la fábrica usa agente Minimax (o single-shot) sobre fixtures de **todos** los deportes en `FACTORY_SPORTS`, con fallback a reglas/scrapers.
- `CRON_LIVE_EXPRESSION` (default `*/5`): monitor en vivo → `abetlive` + settle/cleanup (solo día `America/Bogota`)
- `CRON_TRACKING_EXPRESSION` (default `*/2`): jobs `dp_tracking_jobs` (predicciones seguidas + tips live)
- `CRON_SETTLE_EXPRESSION` (default `*/12`): liquidación won/lost de `dp_predictions`
- `CRON_NEWS_EXPRESSION` (default `*/45`): noticias/contexto

### Ciclo de vida live (`abetlive`)

1. Al crear un tip live → `state=live`, `match_date=hoy`, job en `dp_tracking_jobs` (`abetlive_id`).
2. Cada ~5 min el live monitor refresca marcador (ESPN; si falla DNS, usa `fixtures_cache`).
3. Partido terminado → `outcome` won/lost/pending, `state=ended`, `live_ended=true` (sale del feed “en vivo”).
4. Tips `state=live` de días anteriores → cleanup automático (no quedan “en vivo hace 2 días”).

Ver también: `src/docs/matudb.md` (auto-publish + MatuDB).

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
