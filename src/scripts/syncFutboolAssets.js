/**
 * Sincroniza catálogo + logos desde APIS/futbool → data/futbool
 *
 * Uso:
 *   node src/scripts/syncFutboolAssets.js
 *   node src/scripts/syncFutboolAssets.js --src="C:\Users\juanl\OneDrive\Documentos\APIS\futbool"
 *
 * Luego reinicia el backend (o llama reloadLogoCache) para recargar el índice.
 */
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_SRC = path.join(
  "C:",
  "Users",
  "juanl",
  "OneDrive",
  "Documentos",
  "APIS",
  "futbool"
);
const DEST = path.join(__dirname, "..", "..", "data", "futbool");

function parseArgs() {
  let src = process.env.FUTBOOL_SRC || DEFAULT_SRC;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--src=")) src = arg.slice(6).trim();
  }
  return { src };
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function robocopy(from, to, extraArgs = []) {
  ensureDir(to);
  const args = [from, to, ...extraArgs, "/R:1", "/W:1", "/NFL", "/NDL", "/NJH", "/NJS"];
  const r = spawnSync("robocopy", args, { encoding: "utf8", shell: true });
  // robocopy exit codes 0–7 = success-ish
  const code = r.status ?? 0;
  if (code >= 8) {
    throw new Error(`robocopy falló (${code}): ${from} → ${to}\n${r.stderr || r.stdout}`);
  }
  return code;
}

function countPng(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.png$/i.test(ent.name)) n += 1;
    }
  };
  walk(dir);
  return n;
}

function main() {
  const { src } = parseArgs();
  const ligasSrc = path.join(src, "data", "ligas");
  const logosSrc = path.join(src, "public", "logos");
  const placeholderSrc = path.join(src, "public", "assets", "placeholder.svg");

  if (!fs.existsSync(ligasSrc)) {
    console.error(`No existe ${ligasSrc}. Pasa --src=ruta/al/futbool`);
    process.exit(1);
  }
  if (!fs.existsSync(logosSrc)) {
    console.error(`No existe ${logosSrc}`);
    process.exit(1);
  }

  ensureDir(DEST);
  console.log(`[futbool-sync] src=${src}`);
  console.log(`[futbool-sync] dest=${DEST}`);

  robocopy(ligasSrc, path.join(DEST, "ligas"), ["*.json", "/MIR"]);
  robocopy(logosSrc, path.join(DEST, "logos"), ["/E", "/XO"]);

  if (fs.existsSync(placeholderSrc)) {
    fs.copyFileSync(placeholderSrc, path.join(DEST, "placeholder.svg"));
  }

  const ligas = fs.readdirSync(path.join(DEST, "ligas")).filter((f) => f.endsWith(".json")).length;
  const pngs = countPng(path.join(DEST, "logos"));
  console.log(JSON.stringify({ ok: true, ligas, pngs, dest: DEST }, null, 2));
  console.log("Listo. Reinicia el API o usa reloadLogoCache para indexar.");
}

main();
