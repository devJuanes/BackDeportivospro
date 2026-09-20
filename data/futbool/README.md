# Futbool logo assets (integrados en el backend)

Fuente: `C:\Users\juanl\OneDrive\Documentos\APIS\futbool` (no se modifica ese proyecto).
Aquí viven copias usadas al publicar pronósticos a MatuDB.

## Layout

```
data/futbool/
├── ligas/                      # JSON por liga (equipos + path relativo del logo)
├── logos/<liga>/<equipo>.png   # badges (~952)
├── placeholder.svg
└── README.md
```

## URLs públicas (Express)

Montado en `app.js`:

- `GET /assets/leagues/:liga/:equipo.png`
- Ejemplo local: `http://localhost:3009/assets/leagues/la-liga/barcelona.png`
- Producción: define `PUBLIC_BASE_URL` (ej. `https://api.matupicks.app`)

Al publicar a `abet` / `abetvip` / `abetlive`, `futboolLogoService.enrichPickLogos` resuelve el nombre del equipo y guarda:

- `home_team_logo`
- `away_team_logo`

Si no hay match → string vacío (sin romper el insert).

## Sincronizar desde APIS/futbool

```bash
npm run futbool:sync
# o
node src/scripts/syncFutboolAssets.js --src="C:\Users\juanl\OneDrive\Documentos\APIS\futbool"
```

Reinicia el server después para recargar el índice en memoria.

## Añadir más ligas / equipos

1. En el proyecto futbool: crea `scripts/configs/<slug>.js` y corre `node scripts/fetch-equipos.js --liga=<slug>` (genera JSON + PNGs).
2. Aquí: `npm run futbool:sync`
3. Reinicia backend.

Opcional manual en este repo:

1. Copia `data/ligas/<slug>.json` → `data/futbool/ligas/<slug>.json`
2. Copia PNGs → `data/futbool/logos/<slug>/`
3. En el JSON, cada equipo debe tener `"logo": "logos/<slug>/<equipo>.png"`

## Backfill logos en filas ya publicadas

```bash
npm run backfill
```
