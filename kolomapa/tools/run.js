#!/usr/bin/env node
'use strict';
// Jednorázové stažení a nacenění inzerátů – pro cron, Plánovač úloh Windows nebo GitHub Actions.
//
//   node tools/run.js [--sources=bazos,sbazar] [--max-details=N] [--max-pages=N] [--full] [--export] [--db=SOUBOR]
//
//   --sources       jen vybrané zdroje (výchozí KOLOMAPA_SOURCES / všechny)
//   --max-details   max. detailů inzerátů na zdroj (výchozí KOLOMAPA_MAX_DETAILS)
//   --max-pages     max. stránek výpisu na kategorii (výchozí KOLOMAPA_MAX_PAGES)
//   --full          projít výpisy celé (odhalí prodané/smazané inzeráty) bez ohledu na KOLOMAPA_FULL_SCAN_DAYS
//   --export        po běhu zapsat statickou verzi mapy (jako npm run export)
//   --db            jiný soubor databáze (výchozí KOLOMAPA_DB / data/kolomapa.db)
// Návratový kód: 0 = ok / částečně, 1 = chyba (nebo už běží jiné stahování).

const path = require('node:path');
const { loadConfig, ALL_SOURCES } = require('../src/config');
const { openDb } = require('../src/db');
const defaultLog = require('../src/util/log');
const { runOnce } = require('../src/server/scheduler');
const { LABELS } = require('../src/sources');

const STATUS_TEXT = { ok: 'v pořádku', partial: 'částečně (některý zdroj selhal)', error: 'CHYBA', busy: 'neproběhlo – už běží jiné stahování' };

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (!m) throw new Error(`Neznámý argument: ${a}`);
    out[m[1]] = m[2] ?? true;
  }
  return out;
}

function intArg(v, name) {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} musí být celé číslo ≥ 0`);
  return n;
}

const nf = new Intl.NumberFormat('cs-CZ');
const n = (v) => nf.format(Number(v) || 0);

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Čitelné shrnutí běhu (česky). */
function formatSummary(res, ms) {
  const lines = [];
  lines.push('');
  lines.push(`Kolomapa – stahování: ${STATUS_TEXT[res.status] || res.status} (${duration(ms)})`);
  if (res.error) lines.push(`  Chyba: ${res.error}`);
  const st = res.stats || {};
  for (const [key, s] of Object.entries(st.sources || {})) {
    const label = LABELS[key] || key;
    const parts = [
      `${n(s.scanned)} prošlo`,
      `${n(s.new)} nových`,
      `${n(s.changed)} změněných`,
      `${n(s.details)} detailů`,
      s.gone ? `${n(s.gone)} zmizelo` : null,
      s.detailErrors ? `${n(s.detailErrors)} chyb detailu` : null,
      s.mode === 'full' ? (s.complete ? 'celý výpis' : 'celý výpis NEDOKONČEN') : 'jen novinky',
    ].filter(Boolean);
    lines.push(`  ${label.padEnd(11)} ${parts.join(' · ')}${s.error ? `\n              ! ${s.error}` : ''}`);
  }
  if (st.classified != null || st.priced != null) {
    lines.push(
      `  Zpracování  ${n(st.classified)} klasifikováno · ${n(st.geocoded)} s nově určenou polohou · ${n(st.priced)} naceněno` +
        `${st.ai ? ` · ${n(typeof st.ai === 'object' ? st.ai.done ?? st.ai.count ?? 0 : st.ai)} AI` : ''}` +
        `${st.pruned ? ` · ${n(st.pruned)} starých smazáno` : ''}`
    );
  }
  if (st.aiError) lines.push(`  AI nacenění selhalo: ${st.aiError}`);
  if (res.exported) lines.push(`  Statická verze: ${res.exported.outDir} (${n(res.exported.files)} souborů)`);
  if (res.exportError) lines.push(`  Statický export selhal: ${res.exportError}`);
  lines.push('');
  return lines.join('\n');
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  if (args.help || args.h) {
    console.log(
      'Použití: node tools/run.js [--sources=bazos,sbazar,aukro,cyklobazar] [--max-details=N] [--max-pages=N] [--full] [--export] [--db=SOUBOR]'
    );
    return 0;
  }
  const config = loadConfig(process.env);
  const log = defaultLog;
  if (typeof args.db === 'string') config.dbFile = path.resolve(args.db);
  let sources;
  let maxDetails;
  let maxPages;
  try {
    if (args.sources !== undefined) {
      sources = String(args.sources)
        .split(/[\s,;]+/)
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);
      const unknown = sources.filter((s) => !ALL_SOURCES.includes(s));
      if (unknown.length || !sources.length) throw new Error(`Neznámý zdroj: ${unknown.join(', ') || '(prázdné)'} – povolené: ${ALL_SOURCES.join(', ')}`);
    }
    maxDetails = intArg(args['max-details'], 'max-details');
    maxPages = intArg(args['max-pages'], 'max-pages');
  } catch (e) {
    console.error(e.message);
    return 1;
  }

  const db = openDb(config.dbFile);
  const controller = new AbortController();
  const onSignal = (sig) => {
    if (controller.signal.aborted) process.exit(1);
    log.warn(`Přijat ${sig} – přerušuji stahování (další ${sig} ukončí hned)…`);
    controller.abort(new Error(`Přerušeno (${sig})`));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  const t0 = Date.now();
  let res;
  try {
    res = await runOnce({
      db,
      config,
      log,
      signal: controller.signal,
      trigger: 'cli',
      sources,
      maxDetails,
      maxPages,
      full: !!args.full,
      exportAfter: args.export ? true : undefined,
      onProgress: () => {}, // průběh už loguje pipeline
    });
  } catch (e) {
    res = { status: 'error', error: e.message };
  } finally {
    try {
      db.close();
    } catch {
      /* nic */
    }
  }
  console.log(formatSummary(res, Date.now() - t0));
  return res.status === 'ok' || res.status === 'partial' ? 0 : 1;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(e);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, parseArgs, formatSummary };
