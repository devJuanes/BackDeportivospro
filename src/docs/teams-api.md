# API de equipos y ligas

Catalogo de equipos (escudos, estadio, ciudad, fundacion...) y ligas exposed por
`GET /api/v1/teams` y `GET /api/v1/leagues`.

- **Fuente de verdad**: `data/futbool/ligas/<slug>.json` (metadata) + `data/futbool/logos/<liga>/<equipo>.png` (escudos).
- **Sin base de datos**: todo se indexa en memoria al arrancar (o al pedir `reload`).
- **Sin I/O por request**: los endpoints solo leen el indice; los PNG se sirven como estaticos en `/assets/leagues`.

## Endpoints publicos

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/api/v1/leagues` | Lista de ligas (`?q=` busca por nombre/slug, `?limit=`, `?offset=`) |
| GET | `/api/v1/leagues/:slug` | Una liga **con sus equipos** (`?teams=false` omite el array de equipos) |
| GET | `/api/v1/teams` | Lista de equipos (`?league=`, `?q=`, `?limit=`, `?offset=`) |
| GET | `/api/v1/teams/:slug` | Un equipo por slug (`?league=` desambigua slugs repetidos entre ligas) |

### Parametros

| Param | Default | Max | Descripcion |
| --- | --- | --- | --- |
| `limit` | 50 | 500 | Cantidad de items por pagina |
| `offset` | 0 | - | Offset de la pagina |
| `q` / `search` | - | - | Busqueda difusa por nombre, nombre oficial, apodo, sigla o slug |
| `league` | - | - | Filtra por slug de liga (ej. `la-liga`) |
| `teams` | `true` | - | En `/leagues/:slug`, `false` devuelve solo el resumen de la liga |

### Respuestas

`GET /api/v1/teams`

```json
{
  "ok": true,
  "data": [
    {
      "id": 4,
      "slug": "barcelona",
      "leagueSlug": "la-liga",
      "leagueName": "LaLiga",
      "leagueLogoUrl": "",
      "nombre": "Barcelona",
      "nombreOficial": "Barcelona",
      "apodo": "El Barça",
      "abreviatura": "FCB",
      "fundacion": 1899,
      "ciudad": "Barcelona",
      "estadio": "Estadio Olímpico Lluís Companys",
      "capacidad": 99354,
      "sitioWeb": "https://www.fcbarcelona.com",
      "logoUrl": "https://api.picks.matupicks.app/assets/leagues/la-liga/barcelona.png",
      "logoRemoto": "https://r2.thesportsdb.com/images/media/team/badge/wq9sir1639406443.png"
    }
  ],
  "meta": { "total": 952, "count": 1, "limit": 50, "offset": 0, "league": "all", "q": "barca" }
}
```

`GET /api/v1/leagues`

```json
{
  "ok": true,
  "data": [
    {
      "slug": "la-liga",
      "nombre": "LaLiga",
      "pais": "España",
      "temporada": "2025-26",
      "logoUrl": "",
      "teamCount": 20,
      "actualizado": "2026-08-14T03:35:03.786Z"
    }
  ],
  "meta": { "total": 58, "count": 1, "limit": 50, "offset": 0, "q": null }
}
```

Cuando no existe: `404` con `{"ok": false, "error": "Equipo no encontrado"}`.

### `logoUrl`

Siempre es una URL publica absoluta:

1. PNG local servido por la API: `{PUBLIC_BASE_URL}/assets/leagues/<liga>/<equipo>.png`
2. `logoRemoto` (TheSportsDB) si no hay PNG local.
3. `""` si el equipo no tiene escudo.

`PUBLIC_BASE_URL` (o `LOGO_PUBLIC_BASE_URL` / `API_PUBLIC_URL`) define la base. Nunca se genera una URL con `localhost` salvo `FORCE_LOCAL_LOGO_URLS=true`.

## Cache y rendimiento

- El indice se construye una vez (~100 ms, 58 ligas / 952 equipos) y se sirve desde memoria.
- Cada respuesta trae `ETag` (debil), `Cache-Control: public, max-age=300` y `X-Index-Version`.
- Con `If-None-Match` el servidor responde `304` sin body.
- El cuerpo JSON tambien se cachea por (version del indice + query) en memoria (max. 256 entradas).
- El indice se refresca solo: cada `TEAMS_INDEX_TTL_MS` (default 30s) se compara la firma de
  `data/futbool/ligas` y `data/futbool/logos`; si cambio, se reindexa en el siguiente request.
- La resolucion de escudos (usada al publicar pronosticos) usa un indice de tokens:
  no recorre los 952 equipos por llamada (~0.005 ms por lookup).

## Admin

| Metodo | Ruta | Descripcion |
| --- | --- | --- |
| GET | `/api/admin/futbool/status` | Estado del indice (ligas, equipos, logos, version, `loadedAt`, `buildMs`) |
| POST | `/api/admin/futbool/reload` | Reindexa al instante (equipos, ligas y logos) sin reiniciar el server |

Requieren admin (`Authorization: Bearer <jwt admin>` / `ADMIN_EMAILS` / `pf_users.is_admin`).

```bash
curl -X POST https://api.picks.matupicks.app/api/admin/futbool/reload \
  -H "Authorization: Bearer $ADMIN_TOKEN"
```

## Variables de entorno

| Variable | Default | Descripcion |
| --- | --- | --- |
| `TEAMS_INDEX_TTL_MS` | `30000` | Cada cuanto se revisa si cambiaron los assets (0 = nunca) |
| `TEAMS_INDEX_AUTO_RELOAD` | `true` | `false` desactiva el refresh automatico (solo `reload` manual) |
| `TEAMS_API_CACHE_MAX_AGE` | `300` | `Cache-Control: max-age` de las respuestas (segundos) |
| `PUBLIC_BASE_URL` | `https://api.picks.matupicks.app` | Base publica para `logoUrl` |
| `LOGO_PUBLIC_BASE_URL` | - | Override especifico de logos |
| `FORCE_LOCAL_LOGO_URLS` | `false` | `true` permite URLs con `localhost` (solo debug) |

## Uso interno (Node)

```js
const {
  listTeams, getTeam, listLeagues, getLeague,
  resolveTeamLogoUrl, resolveLeagueLogoUrl, enrichPickLogos, getStats,
} = require("../services/teamsService");
```

`futboolLogoService` se mantiene como wrapper compatible (mismos exports) y ya no mantiene
su propio indice: todo pasa por `teamsService`.

Para agregar ligas o equipos:

1. En el proyecto futbool: `node scripts/fetch-equipos.js --liga=<slug>`.
2. En este repo: `npm run futbool:sync`.
3. `POST /api/admin/futbool/reload` (o esperar el TTL, o reiniciar el server).
