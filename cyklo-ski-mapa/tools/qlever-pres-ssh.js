#!/usr/bin/env node
'use strict';
// Stáhne dotazy na QLever (OSM) přes jiný stroj. QLever odpovídá runnerům GitHub Actions chybou 403 (ověřeno
// 14. 10. 2026; ze serveru Hetzner odpovídá normálně), proto workflow obnovy dat pošle každý dotaz přes SSH
// na server, kde ho provede curl, a výsledek uloží do cache/. build-data.js ho pak vezme z cache stejně jako
// vlastní stažení (pouštět bez --fetch).
//
//   node tools/qlever-pres-ssh.js --cache DIR -- ssh -i KLÍČ -p PORT uzivatel@server
//
// Každý dotaz ze SPARQL_QUERIES → <cache>/<název>.csv, statistiky indexu (datum snímku OSM) → qlever_stats.json.
// Tělo dotazu jde vzdálenému curl stdinem, výsledek se zapisuje do dočasného souboru a přejmenuje se až po
// úspěchu. Chyba kteréhokoli dotazu = konec s chybou: neúplná data nesmí projít do sestavení. Chybějící
// statistiky jen upozorní (sestavení pak datum snímku nezná).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { QLEVER_ENDPOINT, USER_AGENT, SPARQL_QUERIES, sparqlBody, qleverStatsUrl } = require('./lib/sources.js');

function parseArgs(argv) {
  const out = { cache: null, ssh: [] };
  const konec = argv.indexOf('--');
  const vlastni = konec === -1 ? argv : argv.slice(0, konec);
  out.ssh = konec === -1 ? [] : argv.slice(konec + 1);
  for (let i = 0; i < vlastni.length; i++) {
    if (vlastni[i] === '--cache') out.cache = vlastni[++i];
    else if (vlastni[i] === '--help' || vlastni[i] === '-h') out.help = true;
  }
  return out;
}

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

// Do příkazové řádky vzdáleného shellu jde jen tahle pevná adresa a User-Agent – ověřit, že neobsahují nic,
// co by shell vykládal jinak.
function bezpecne(text) {
  if (!/^[\w.:/+()?=&%~ -]+$/.test(text)) throw new Error(`Nečekané znaky v hodnotě pro vzdálený příkaz: ${text}`);
  return `'${text}'`;
}

function curlDotaz() {
  return ['curl', '-sS', '-f', '--max-time', '900', '-X', 'POST', '-A', bezpecne(USER_AGENT), '-H', "'Accept: text/csv'",
    '-H', "'Content-Type: application/x-www-form-urlencoded'", '--data-binary', '@-', bezpecne(QLEVER_ENDPOINT)].join(' ');
}

function curlStatistiky() {
  return ['curl', '-sS', '-f', '--max-time', '60', '-A', bezpecne(USER_AGENT), bezpecne(qleverStatsUrl())].join(' ');
}

// Spustí `ssh … <příkaz>`, stdin = body, stdout do souboru (přes dočasný, přejmenuje se až po úspěchu).
function pres(ssh, prikaz, body, soubor) {
  const docasny = `${soubor}.stahuji`;
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(docasny, 'w');
    const child = spawn(ssh[0], [...ssh.slice(1), prikaz], { stdio: ['pipe', fd, 'inherit'] });
    child.on('error', (e) => {
      fs.closeSync(fd);
      fs.rmSync(docasny, { force: true });
      reject(e);
    });
    child.on('close', (kod) => {
      fs.closeSync(fd);
      const velikost = fs.existsSync(docasny) ? fs.statSync(docasny).size : 0;
      if (kod !== 0 || velikost === 0) {
        fs.rmSync(docasny, { force: true });
        reject(new Error(kod !== 0 ? `vzdálený příkaz skončil kódem ${kod}` : 'prázdná odpověď'));
        return;
      }
      fs.renameSync(docasny, soubor);
      resolve(velikost);
    });
    child.stdin.on('error', () => {}); // když ssh skončí dřív, chyba zápisu se projeví kódem výše
    child.stdin.end(body);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.cache || !args.ssh.length) {
    console.log('node tools/qlever-pres-ssh.js --cache DIR -- ssh [volby] uzivatel@server');
    process.exit(args.help ? 0 : 2);
  }
  const cache = path.resolve(args.cache);
  fs.mkdirSync(cache, { recursive: true });
  try {
    const n = await pres(args.ssh, curlStatistiky(), '', path.join(cache, 'qlever_stats.json'));
    log(`qlever_stats.json: ${n} B`);
  } catch (e) {
    log('upozornění: statistiky QLeveru přes server nejdou načíst –', e.message);
  }
  for (const [nazev, dotaz] of Object.entries(SPARQL_QUERIES)) {
    const soubor = path.join(cache, `${nazev}.csv`);
    const t0 = Date.now();
    log(`stahuji přes server ${nazev}.csv`);
    const n = await pres(args.ssh, curlDotaz(), sparqlBody(dotaz), soubor);
    log(`${nazev}.csv: ${(n / 1024 / 1024).toFixed(1)} MB za ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  log('hotovo');
}

main().catch((e) => {
  console.error('Stažení z QLeveru přes server selhalo:', e.message);
  process.exit(1);
});
