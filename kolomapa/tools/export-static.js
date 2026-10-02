#!/usr/bin/env node
'use strict';
// Statická verze mapy (bez serveru) – např. pro GitHub Pages, Netlify nebo sdílený disk.
//
//   node tools/export-static.js [--out=DIR] [--db=SOUBOR]
//
// Zapíše do config.staticDir (výchozí dist/, KOLOMAPA_STATIC_DIR):
//   index.html, app.js, styles.css, vendor/ …   kopie public/
//   data/summary.json                           přehled (mode: 'static' → UI skryje „Stáhnout teď“)
//   data/kraj/<KOD>.json                        inzeráty všech 14 krajů
//   data/kraje.geojson                          hranice krajů
// UI používá jen relativní adresy (data/summary.json), takže funguje i v podadresáři (https://user.github.io/repo/).
// Cílový adresář se přepisuje jen tehdy, když je prázdný nebo obsahuje značku .kolomapa-export z dřívějšího exportu;
// .git a CNAME (pracovní kopie větve gh-pages, vlastní doména GitHub Pages) se nikdy nemažou.
// Z public/ se kopírují jen běžné soubory a adresáře; symbolické odkazy jen tehdy, když vedou dovnitř public/ (stejně
// jako je obsluhuje server) – zkopíruje se jejich obsah, ne odkaz. Skryté soubory (.*) se vynechají.

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDb } = require('../src/db');
const defaultLog = require('../src/util/log');
const { buildSummary, buildKraj, KRAJ_CODES } = require('../src/server/data');
const { GEOJSON_FILE } = require('../src/server/http');

const MARKER = '.kolomapa-export';
/** Položky cílového adresáře, které export nemaže a které nevadí ani v „prázdném“ adresáři. */
const PRESERVE = new Set(['.git', 'CNAME']);

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Skutečná cesta (symlinky rozbalené); u neexistující cesty rozbalí nejbližšího existujícího předka. */
function realish(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realish(parent), path.basename(abs));
  }
}

/** Ověří, že cílový adresář je bezpečné přepsat; vyhodí chybu s vysvětlením, když ne. */
function checkOutDir(outDir, config) {
  const out = path.resolve(outDir);
  const forbidden = [path.parse(out).root, config.projectDir, config.publicDir, path.join(config.projectDir, 'src'), require('node:os').homedir()].filter(Boolean);
  // porovnat zadanou i skutečnou cestu (dist může být symlink např. na domovský adresář)
  for (const o of new Set([out, realish(out)])) {
    for (const f of forbidden) {
      if (o === path.resolve(f) || o === realish(f)) throw new Error(`Do adresáře ${out} statickou verzi nezapíšu (je to kořen, domovský adresář, projekt nebo public/). Zvolte jiný přes --out nebo KOLOMAPA_STATIC_DIR.`);
    }
    const pub = [path.resolve(config.publicDir), realish(config.publicDir)];
    if (pub.some((p) => isInside(o, p) || isInside(p, o))) {
      throw new Error(`Do adresáře ${out} statickou verzi nezapíšu (je to kořen, domovský adresář, projekt nebo public/). Zvolte jiný přes --out nebo KOLOMAPA_STATIC_DIR.`);
    }
  }
  if (!fs.existsSync(out)) return out;
  const st = fs.statSync(out);
  if (!st.isDirectory()) throw new Error(`${out} není adresář.`);
  const entries = fs.readdirSync(out).filter((e) => !PRESERVE.has(e));
  if (entries.length && !entries.includes(MARKER)) {
    throw new Error(`Adresář ${out} není prázdný a nevypadá jako dřívější export Kolomapy (chybí ${MARKER}) – nic nepřepisuji.`);
  }
  return out;
}

/**
 * Zkopíruje UI z public/ do cíle: běžné soubory a adresáře, symlinky jen dovnitř public/ (zkopíruje se obsah),
 * bez skrytých souborů a bez cyklů.
 * @returns {{files: number, bytes: number, skipped: string[]}}
 */
function copyPublic(publicDir, dest) {
  const realRoot = fs.realpathSync(publicDir);
  const out = { files: 0, bytes: 0, skipped: [] };
  const walk = (src, dst, ancestors) => {
    fs.mkdirSync(dst, { recursive: true });
    for (const e of fs.readdirSync(src, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const s = path.join(src, e.name);
      const rel = path.relative(publicDir, s).split(path.sep).join('/');
      let real;
      try {
        real = fs.realpathSync(s);
      } catch {
        out.skipped.push(`${rel} (neplatný odkaz)`);
        continue;
      }
      if (!isInside(realRoot, real)) {
        out.skipped.push(`${rel} (odkaz mimo public/)`);
        continue;
      }
      const st = fs.statSync(real);
      if (st.isDirectory()) {
        if (ancestors.has(real)) {
          out.skipped.push(`${rel} (cyklický odkaz)`);
          continue;
        }
        walk(s, path.join(dst, e.name), new Set([...ancestors, real]));
      } else if (st.isFile()) {
        fs.copyFileSync(real, path.join(dst, e.name));
        out.files++;
        out.bytes += st.size;
      }
    }
  };
  walk(publicDir, dest, new Set([realRoot]));
  return out;
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(obj);
  fs.writeFileSync(file, body);
  return Buffer.byteLength(body);
}

/**
 * Zapíše statickou verzi mapy.
 * @param {{db, config, log?, outDir?: string, now?: Date}} o
 * @returns {Promise<{outDir: string, files: number, bytes: number, listings: number}>}
 */
async function exportStatic({ db, config, log = defaultLog, outDir, now = new Date() }) {
  const out = checkOutDir(outDir || config.staticDir, config);
  if (!fs.existsSync(path.join(config.publicDir, 'index.html'))) throw new Error(`Chybí UI (${config.publicDir}/index.html).`);
  // Starý export smazat (je označený značkou) a zapsat celý znovu – neplatné soubory nezůstanou. Symlinky se mažou
  // jako odkazy (rmSync nejde do cíle odkazu); .git a CNAME zůstávají.
  if (fs.existsSync(out)) for (const e of fs.readdirSync(out)) if (!PRESERVE.has(e)) fs.rmSync(path.join(out, e), { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, MARKER), `Statická verze Kolomapy, vytvořeno ${now.toISOString()}.\nObsah adresáře se při dalším exportu přepíše (kromě .git a CNAME).\n`);
  fs.writeFileSync(path.join(out, '.nojekyll'), ''); // GitHub Pages: neprohánět Jekyllem

  const copied = copyPublic(config.publicDir, out);
  if (copied.skipped.length) log.warn('Některé položky public/ se do statické verze nekopírují', { skipped: copied.skipped });
  let files = copied.files + 2; // + značka a .nojekyll
  let bytes = copied.bytes;

  const dataDir = path.join(out, 'data');
  const summary = buildSummary(db, { mode: 'static', now });
  bytes += writeJson(path.join(dataDir, 'summary.json'), summary);
  files++;
  let listings = 0;
  for (const code of KRAJ_CODES) {
    const k = buildKraj(db, code, { now });
    listings += k.listings.length;
    bytes += writeJson(path.join(dataDir, 'kraj', `${code}.json`), k);
    files++;
  }
  fs.copyFileSync(GEOJSON_FILE, path.join(dataDir, 'kraje.geojson'));
  files++;
  bytes += fs.statSync(path.join(dataDir, 'kraje.geojson')).size;
  log.info(`Statická verze zapsána do ${out}`, { files, MB: Math.round((bytes / 1048576) * 10) / 10, listings });
  return { outDir: out, files, bytes, listings };
}

async function main(argv) {
  const args = Object.fromEntries(
    argv.map((a) => {
      const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
      return m ? [m[1], m[2] ?? true] : [a, true];
    })
  );
  if (args.help || args.h) {
    console.log('Použití: node tools/export-static.js [--out=DIR] [--db=SOUBOR]\nZapíše statickou verzi mapy (výchozí dist/, KOLOMAPA_STATIC_DIR).');
    return;
  }
  const config = loadConfig(process.env);
  if (typeof args.db === 'string') config.dbFile = path.resolve(args.db);
  if (typeof args.out === 'string') config.staticDir = path.resolve(args.out);
  if (config.dbFile !== ':memory:' && !fs.existsSync(config.dbFile)) {
    console.error(`Databáze ${config.dbFile} neexistuje – nejdřív spusťte stahování (npm run run) nebo demo data (npm run demo).`);
    process.exitCode = 1;
    return;
  }
  const db = openDb(config.dbFile);
  try {
    const r = await exportStatic({ db, config });
    console.log(`Hotovo: ${r.files} souborů, ${(r.bytes / 1048576).toFixed(1)} MB, ${r.listings} inzerátů → ${r.outDir}`);
    console.log('Nahrajte obsah adresáře na libovolný statický hosting (GitHub Pages, Netlify …) nebo ho otevřete přes lokální server.');
  } catch (e) {
    console.error(`Export selhal: ${e.message}`);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { exportStatic, checkOutDir, copyPublic, MARKER, PRESERVE };
