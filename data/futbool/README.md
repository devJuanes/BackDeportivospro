# Futbool logo assets (copied)

Copied **read-only** from `APIS/futbool` into BackDeportivospro. The source project was not modified.

## Layout

```
data/futbool/
├── ligas/                 # 58 league JSON catalogs (teams + logo relative paths)
├── logos/<league>/<team>.png   # ~952 team badges (~88 MB)
├── placeholder.svg
└── README.md
```

## Public URLs

Mounted in Express as static files:

- Pattern: `GET /assets/leagues/:leagueSlug/:teamSlug.png`
- Local example: `http://localhost:3009/assets/leagues/premier-league/arsenal.png`
- Production: set `PUBLIC_BASE_URL` (e.g. `https://api.example.com`) so lookup returns absolute URLs.

## Lookup

`src/services/futboolLogoService.js` resolves team names (optional league hint) → absolute logo URL. Used when publishing to `abet` / `abetvip` and when mapping API prediction JSON.

## Refresh from source

```powershell
robocopy "C:\Users\juanl\OneDrive\Documentos\APIS\futbool\data\ligas" "data\futbool\ligas" "*.json" /R:1 /W:1
robocopy "C:\Users\juanl\OneDrive\Documentos\APIS\futbool\public\logos" "data\futbool\logos" /E /R:1 /W:1
```

Do **not** move or delete files in the futbool project.
