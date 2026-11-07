/**
 * expandTeamsCatalog — amplía el catálogo de data/futbool con ligas nuevas.
 *
 * Fuentes:
 *   - Wikipedia (principal): página de la temporada -> tabla de equipos con
 *     ciudad, estadio y aforo + escudo de cada club (summary API).
 *   - TheSportsDB (complemento): abreviatura, fundación, web, colores y badge.
 *     Su API gratuita limita a 10 equipos por liga, por eso no es la fuente
 *     principal del roster.
 *
 * Escribe data/futbool/ligas/<slug>.json con el mismo formato que las ligas
 * existentes y guarda los escudos en data/futbool/logos/<slug>/.
 *
 * Es robusto y reanudable:
 *   - cache en disco de las respuestas (API + Wikipedia)
 *   - reintentos con backoff ante 429
 *   - manifest: si se corta, se reanuda donde lo dejó
 *
 * Uso:
 *   node src/scripts/expandTeamsCatalog.js --list
 *   node src/scripts/expandTeamsCatalog.js --preset=latam
 *   node src/scripts/expandTeamsCatalog.js --league=copa-del-rey
 *   node src/scripts/expandTeamsCatalog.js --preset=all --dry-run
 */

const fs = require("node:fs");
const path = require("node:path");
const cheerio = require("cheerio");
const { GRUPOS, LIGAS, NOMBRES_EQUIPO } = require("./teamsCatalog");

const ROOT = path.join(__dirname, "..", "..");
const DATA_DIR = path.join(ROOT, "data", "futbool");
const LIGAS_DIR = path.join(DATA_DIR, "ligas");
const LOGOS_DIR = path.join(DATA_DIR, "logos");
const CACHE_DIR = path.join(DATA_DIR, ".cache");
const TSDB_CACHE = path.join(CACHE_DIR, "tsdb");
const WIKI_CACHE = path.join(CACHE_DIR, "wiki");
const MANIFEST = path.join(CACHE_DIR, "expand-manifest.json");

const API_KEY = String(process.env.THESPORTSDB_KEY || "123").trim() || "123";
const API_BASE = `https://www.thesportsdb.com/api/v1/json/${API_KEY}`;
const WIKI_API = "https://en.wikipedia.org/api/rest_v1";
const WIKI_SEARCH = "https://en.wikipedia.org/w/api.php";

const TSDB_DELAY_MS = Number.parseInt(String(process.env.TSDB_DELAY_MS || "9000"), 10) || 9000;
const TSDB_RETRY_MS = Number.parseInt(String(process.env.TSDB_RETRY_MS || "90000"), 10) || 90000;
const WIKI_DELAY_MS = Number.parseInt(String(process.env.WIKI_DELAY_MS || "350"), 10) || 350;
const DOWNLOAD_CONCURRENCY = Number.parseInt(String(process.env.DOWNLOAD_CONCURRENCY || "6"), 10) || 6;

const UA = "deportivospro-catalog/1.0 (equipos y ligas)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...args) => console.log(`[expand] ${args.join(" ")}`);

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clave(nombre) {
  return String(nombre || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/* ------------------------------- cache -------------------------------- */

function cacheFile(dir, key) {
  return path.join(dir, `${slugify(key)}.${dir === TSDB_CACHE ? "json" : "html"}`);
}

function readCache(dir, key) {
  const file = cacheFile(dir, key);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, "utf8");
    return dir === TSDB_CACHE ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function writeCache(dir, key, data) {
  ensureDir(dir);
  const raw = dir === TSDB_CACHE ? JSON.stringify(data) : data;
  fs.writeFileSync(cacheFile(dir, key), raw, "utf8");
}

/* ----------------------------- Wikipedia ------------------------------ */

let lastWikiAt = 0;

async function wikiFetch(url, cacheKey) {
  const cached = readCache(WIKI_CACHE, cacheKey);
  if (cached) return cached;
  const wait = Math.max(0, lastWikiAt + WIKI_DELAY_MS - Date.now());
  if (wait) await sleep(wait);
  lastWikiAt = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      writeCache(WIKI_CACHE, cacheKey, text);
      return text;
    } catch (err) {
      if (attempt === 2) return null;
      await sleep(800 * (attempt + 1));
    }
  }
  return null;
}

async function wikiHtml(titulo) {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(String(titulo).replace(/ /g, "_"))}`;
  return wikiFetch(url, `page-${titulo}`);
}

async function wikiSearch(consulta) {
  const url = `${WIKI_SEARCH}?action=query&list=search&format=json&srlimit=8&srsearch=${encodeURIComponent(consulta)}`;
  const cached = readCache(TSDB_CACHE, `search-${consulta}`);
  if (cached) return cached.search || [];
  const wait = Math.max(0, lastWikiAt + WIKI_DELAY_MS - Date.now());
  if (wait) await sleep(wait);
  lastWikiAt = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const json = await res.json();
    writeCache(TSDB_CACHE, `search-${consulta}`, json);
    return json.query?.search || [];
  } catch {
    return [];
  }
}

/** Escudo de una página de Wikipedia (summary). */
async function wikiCrest(titulo) {
  const url = `${WIKI_API}/page/summary/${encodeURIComponent(String(titulo).replace(/ /g, "_"))}`;
  const cached = readCache(TSDB_CACHE, `summary-${titulo}`);
  if (cached) return cached;
  const wait = Math.max(0, lastWikiAt + WIKI_DELAY_MS - Date.now());
  if (wait) await sleep(wait);
  lastWikiAt = Date.now();
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) return null;
    const json = await res.json();
    writeCache(TSDB_CACHE, `summary-${titulo}`, json);
    return json;
  } catch {
    return null;
  }
}

/**
 * Imagen principal de una página (mejor que summary: usa pageimages y, si no
 * hay, busca el escudo en el infobox del HTML).
 */
async function wikiImagen(titulo) {
  const cached = readCache(TSDB_CACHE, `imagen-${titulo}`);
  if (cached) return cached || null;

  const apiUrl = `${WIKI_SEARCH}?action=query&format=json&prop=pageimages&piprop=original%7Cthumbnail&pithumbsize=320&redirects=1&titles=${encodeURIComponent(titulo)}`;
  const wait = Math.max(0, lastWikiAt + WIKI_DELAY_MS - Date.now());
  if (wait) await sleep(wait);
  lastWikiAt = Date.now();
  try {
    const res = await fetch(apiUrl, { headers: { "User-Agent": UA } });
    if (res.ok) {
      const json = await res.json();
      const pages = json?.query?.pages || {};
      const page = Object.values(pages)[0] || null;
      const src = page?.thumbnail?.source || page?.original?.source || null;
      if (src) {
        writeCache(TSDB_CACHE, `imagen-${titulo}`, src);
        return src;
      }
    }
  } catch {
    /* seguimos con el infobox */
  }

  // Fallback: infobox del HTML de la página del club.
  const html = await wikiHtml(titulo);
  if (html) {
    const $ = cheerio.load(html);
    const img = $("table.infobox img").first();
    const src = img.attr("src");
    if (src) {
      const url = src.startsWith("//") ? `https:${src}` : src;
      writeCache(TSDB_CACHE, `imagen-${titulo}`, url);
      return url;
    }
  }
  writeCache(TSDB_CACHE, `imagen-${titulo}`, "");
  return null;
}

/* --------------------------- tabla de equipos -------------------------- */

/**
 * Extrae los clubes de la tabla de equipos de la página de la temporada.
 * Soporta tablas con columna "Pos" delante de "Team".
 */
function parseClubes(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  let mejores = [];

  $("table.wikitable").each((_, table) => {
    const filas = $(table).find("tr");
    if (!filas.length) return;
    const cabeceras = $(filas[0]).find("th,td").map((_, e) => $(e).text().trim().replace(/\s+/g, " ")).get();
    const idxTeam = cabeceras.findIndex((h) => /^team$/i.test(h) || /club/i.test(h));
    if (idxTeam === -1) return;

    const idxLocation = cabeceras.findIndex((h) => /location|city|town/i.test(h));
    const idxStadium = cabeceras.findIndex((h) => /stadium|ground/i.test(h));
    const idxCapacity = cabeceras.findIndex((h) => /capacity/i.test(h));

    const equipos = [];
    for (let i = 1; i < filas.length; i += 1) {
      const celdas = $(filas[i]).find("th,td");
      if (celdas.length <= idxTeam) continue;
      const celda = $(celdas[idxTeam]);
      const link = celda.find("a").first();
      const nombre = celda.text().trim().replace(/\s+/g, " ");
      if (!nombre || nombre.length > 60) continue;
      if (/^(res|notes?|source|updated|legend|td)/i.test(nombre)) continue;
      const titulo = link.length ? decodeURIComponent(String(link.attr("href") || "").replace("/wiki/", "")) : "";
      if (!titulo && !/^\d+$/.test(nombre)) continue;

      const leer = (idx) => (idx >= 0 && idx < celdas.length ? $(celdas[idx]).text().trim().replace(/\s+/g, " ") : "");
      equipos.push({
        nombre,
        wiki: titulo,
        ciudad: leer(idxLocation),
        estadio: leer(idxStadium),
        capacidad: Number.parseInt(leer(idxCapacity).replace(/[^0-9]/g, ""), 10) || null,
      });
    }
    if (equipos.length > mejores.length) mejores = equipos;
  });

  return mejores;
}

/** Página de la temporada con tabla de equipos. */
async function paginaTemporada(liga) {
  const candidatos = [
    liga.wiki,
    `2025–26 ${liga.match}`,
    `2024–25 ${liga.match}`,
    `2025-26 ${liga.match}`,
    liga.match,
  ].filter(Boolean);
  for (const titulo of candidatos) {
    const html = await wikiHtml(titulo);
    if (!html) continue;
    const clubes = parseClubes(html);
    if (clubes.length >= 8) return { titulo, clubes, html };
  }
  const resultados = await wikiSearch(`${liga.match} 2025-26`);
  for (const hit of resultados) {
    const html = await wikiHtml(hit.title);
    if (!html) continue;
    const clubes = parseClubes(html);
    if (clubes.length >= 8) return { titulo: hit.title, clubes, html };
  }
  return null;
}

/* ----------------------------- TheSportsDB ---------------------------- */

let lastTsdbAt = 0;

async function tsdb(endpoint) {
  const cached = readCache(TSDB_CACHE, `api-${endpoint}`);
  if (cached) return cached;
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    const wait = Math.max(0, lastTsdbAt + TSDB_DELAY_MS - Date.now());
    if (wait) await sleep(wait);
    lastTsdbAt = Date.now();
    try {
      const res = await fetch(`${API_BASE}/${endpoint}`, { headers: { "User-Agent": UA } });
      if (res.status === 429) {
        log(`429 en ${endpoint}; espero ${Math.round(TSDB_RETRY_MS / 1000)}s`);
        await sleep(TSDB_RETRY_MS);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (!text.trim().startsWith("{")) throw new Error("respuesta no JSON");
      const json = JSON.parse(text);
      writeCache(TSDB_CACHE, `api-${endpoint}`, json);
      return json;
    } catch (err) {
      if (attempt === 4) return null;
      await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

/* ------------------------------- logos -------------------------------- */

async function descargar(url, destino) {
  if (!url) return false;
  if (fs.existsSync(destino) && fs.statSync(destino).size > 0) return true;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      if (!buffer.length) throw new Error("vacío");
      ensureDir(path.dirname(destino));
      fs.writeFileSync(destino, buffer);
      return true;
    } catch (err) {
      if (attempt === 2) return false;
      await sleep(700 * (attempt + 1));
    }
  }
  return false;
}

async function enParalelo(items, worker, concurrency) {
  const queue = [...items];
  const runners = [];
  for (let i = 0; i < Math.max(1, concurrency); i += 1) {
    runners.push(
      (async () => {
        while (queue.length) {
          const item = queue.shift();
          await worker(item);
        }
      })(),
    );
  }
  await Promise.all(runners);
}

/* ---------------------------- normalización --------------------------- */

function nombreBonito(tsdbName) {
  const raw = String(tsdbName || "").trim();
  return NOMBRES_EQUIPO[raw.toLowerCase()] || raw;
}

function apodoDe(team) {
  const keywords = String(team.strKeywords || "").trim();
  if (keywords && keywords.length <= 40) return keywords;
  const alternates = String(team.strTeamAlternate || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const principal = String(team.strTeam || "").toLowerCase();
  return alternates.find((a) => a.toLowerCase() !== principal && a.length <= 28) || "";
}

/* ------------------------------ proceso ------------------------------- */

function manifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  } catch {
    return {};
  }
}

function guardarManifest(data) {
  ensureDir(path.dirname(MANIFEST));
  fs.writeFileSync(MANIFEST, JSON.stringify(data, null, 2), "utf8");
}

async function procesarLiga(liga, opciones) {
  const done = manifest();
  if (done[liga.slug] && !opciones.force) {
    log(`= ${liga.slug} ya estaba (usa --force para rehacerla)`);
    return { slug: liga.slug, skipped: true };
  }

  const pagina = await paginaTemporada(liga);
  if (!pagina || !pagina.clubes.length) {
    log(`! ${liga.slug}: sin tabla de equipos en Wikipedia`);
    return { slug: liga.slug, error: "sin tabla en wikipedia" };
  }

  // Metadatos de TheSportsDB (hasta 10 equipos) para completar los datos.
  const tsdbJson = await tsdb(`search_all_teams.php?l=${encodeURIComponent(liga.match)}`);
  const porNombre = new Map();
  for (const t of tsdbJson?.teams || []) {
    if (!t.strTeam) continue;
    porNombre.set(clave(t.strTeam), t);
    porNombre.set(clave(String(t.strTeamAlternate || "").split(",")[0]), t);
  }

  const logosDir = path.join(LOGOS_DIR, liga.slug);
  ensureDir(logosDir);

  const usados = new Set();
  const equipos = pagina.clubes.map((club, i) => {
    let slug = slugify(club.nombre);
    if (!slug) slug = `equipo-${i + 1}`;
    if (usados.has(slug)) slug = `${slug}-${i + 1}`;
    usados.add(slug);
    const t = porNombre.get(clave(club.nombre)) || null;
    return {
      id: i + 1,
      slug,
      nombre: nombreBonito(t ? t.strTeam : club.nombre),
      nombreOficial: club.nombre,
      apodo: t ? apodoDe(t) : "",
      abreviatura: t?.strTeamShort || "",
      fundacion: t?.intFormedYear ? Number(t.intFormedYear) : null,
      ciudad: club.ciudad || (t ? String(t.strLocation || "").split(",")[0].trim() : ""),
      estadio: club.estadio || t?.strStadium || "",
      capacidad: club.capacidad || (t?.intStadiumCapacity ? Number(t.intStadiumCapacity) : null),
      colores: t ? [t.strColour1, t.strColour2, t.strColour3].filter(Boolean) : [],
      sitioWeb: t?.strWebsite ? `https://${String(t.strWebsite).replace(/^https?:\/\//, "")}` : "",
      logo: "",
      logoRemoto: t?.strBadge || "",
      _wiki: club.wiki,
      _badge: t?.strBadge || "",
    };
  });

  // Fase 1: resolver la URL del escudo (API de Wikipedia, con ritmo suave).
  for (const equipo of equipos) {
    if (!equipo._wiki) continue;
    equipo._crest = await wikiImagen(equipo._wiki);
  }

  // Fase 2: descargar escudos (CDN, en paralelo).
  await enParalelo(
    equipos,
    async (equipo) => {
      const destino = path.join(logosDir, `${equipo.slug}.png`);
      if (equipo._badge && (await descargar(equipo._badge, destino))) {
        equipo.logo = `logos/${liga.slug}/${equipo.slug}.png`;
        return;
      }
      if (equipo._crest && (await descargar(equipo._crest, destino))) {
        equipo.logo = `logos/${liga.slug}/${equipo.slug}.png`;
      }
    },
    DOWNLOAD_CONCURRENCY,
  );

  // Fase 3: reintento de los que quedaron sin escudo (con mas calma).
  const sinLogo = equipos.filter((e) => !e.logo && e._crest);
  if (sinLogo.length) {
    log(`  reintento de ${sinLogo.length} escudos`);
    for (const equipo of sinLogo) {
      const destino = path.join(logosDir, `${equipo.slug}.png`);
      if (await descargar(equipo._crest, destino)) {
        equipo.logo = `logos/${liga.slug}/${equipo.slug}.png`;
      }
      await sleep(250);
    }
  }

  // Escudo de la liga.
  const ligaBadge = await wikiImagen(pagina.titulo);
  if (ligaBadge) await descargar(ligaBadge, path.join(logosDir, "league.png"));

  for (const equipo of equipos) {
    delete equipo._wiki;
    delete equipo._badge;
    delete equipo._crest;
  }

  const salida = {
    slug: liga.slug,
    nombre: liga.nombre,
    pais: liga.pais,
    temporada: liga.temporada,
    total: equipos.length,
    fuente: "Wikipedia + TheSportsDB",
    actualizado: new Date().toISOString(),
    equipos,
  };

  if (!opciones.dryRun) {
    ensureDir(LIGAS_DIR);
    fs.writeFileSync(
      path.join(LIGAS_DIR, `${liga.slug}.json`),
      `${JSON.stringify(salida, null, 2)}\n`,
      "utf8",
    );
    done[liga.slug] = {
      equipos: equipos.length,
      conLogo: equipos.filter((e) => e.logo).length,
      wiki: pagina.titulo,
      cuando: new Date().toISOString(),
    };
    guardarManifest(done);
  }

  const conLogo = equipos.filter((e) => e.logo).length;
  log(`+ ${liga.slug} (${liga.nombre}): ${equipos.length} equipos, ${conLogo} con escudo [${pagina.titulo}]`);
  return { slug: liga.slug, equipos: equipos.length, conLogo };
}

/* -------------------------------- main -------------------------------- */

function parseArgs(argv) {
  const out = { presets: [], leagues: [], force: false, dryRun: false, list: false };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--preset=")) out.presets.push(arg.slice("--preset=".length));
    else if (arg.startsWith("--league=")) out.leagues.push(arg.slice("--league=".length));
    else if (arg === "--force") out.force = true;
    else if (arg === "--dry-run") out.dryRun = true;
    else if (arg === "--list") out.list = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const existentes = new Set(
    fs.existsSync(LIGAS_DIR)
      ? fs.readdirSync(LIGAS_DIR).filter((f) => f.endsWith(".json")).map((f) => path.basename(f, ".json"))
      : [],
  );

  if (args.list) {
    log("grupos:", Object.entries(GRUPOS).map(([k, v]) => `${k} (${v})`).join(", "));
    log(`\n${LIGAS.length} ligas candidatas:\n`);
    for (const liga of LIGAS) {
      log(`  ${(existentes.has(liga.slug) ? "[ya existe]" : "[nueva]").padEnd(13)} ${liga.slug.padEnd(30)} ${liga.nombre} (${liga.pais})`);
    }
    return;
  }

  let seleccion = LIGAS;
  if (args.presets.length) {
    seleccion = LIGAS.filter((l) => args.presets.includes(l.grupo) || args.presets.includes("all"));
  }
  if (args.leagues.length) {
    seleccion = LIGAS.filter((l) => args.leagues.includes(l.slug));
  }
  if (!seleccion.length) {
    log("no hay ligas que procesar (usa --preset= o --league=)");
    return;
  }

  log(`procesando ${seleccion.length} ligas (dry-run=${args.dryRun})`);
  const resumen = [];
  for (const liga of seleccion) {
    try {
      resumen.push(await procesarLiga(liga, args));
    } catch (err) {
      log(`! ${liga.slug}: ${err.message}`);
      resumen.push({ slug: liga.slug, error: err.message });
    }
  }

  const ok = resumen.filter((r) => r && !r.error && !r.skipped);
  log(`\nresumen: ${ok.length} ligas, ${ok.reduce((a, r) => a + (r.equipos || 0), 0)} equipos, ${ok.reduce((a, r) => a + (r.conLogo || 0), 0)} escudos`);
  log("recarga el indice con: POST /api/admin/futbool/reload");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
