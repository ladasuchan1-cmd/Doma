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
//   --process-only  bez stahování: jen klasifikace, poloha a nacenění už uložených inzerátů – např. po běhu
//                   přerušeném před závěrečným zpracováním (mapa prázdná, přestože inzeráty v databázi jsou)
//   --db            jiný soubor databáze (výchozí KOLOMAPA_DB / data/kolomapa.db)
// Návratový kód: 0 = ok / částečně, 1 = chyba, žádný web se nepodařilo stáhnout, nebo už běží jiné stahování
// (Plánovač úloh Windows pak u úlohy ukáže „Výsledek posledního spuštění: 0x1“).
// Ve Windows ho spouští stahnout.cmd (výstup připisuje do data\stahovani.log) – viz README.md.

const path = require('node:path');
const { loadConfig, ALL_SOURCES } = require('../src/config');
const { openDb } = require('../src/db');
const defaultLog = require('../src/util/log');
const { runOnce } = require('../src/server/scheduler');
const { LABELS } = require('../src/sources');

const STATUS_TEXT = { ok: 'v pořádku', partial: 'částečně (některý zdroj selhal)', error: 'CHYBA', busy: 'neproběhlo – už běží jiné stahování' };

/** Časté chyby → česká rada, co s tím (pro majitele obchodu, ne pro programátora). */
const HINTS = [
  [/ENOTFOUND|EAI_AGAIN|getaddrinfo/i, 'Nefunguje internet nebo překlad adres (DNS) – zkontrolujte připojení počítače k internetu.'],
  [/certificate|CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|unable to get local issuer/i, 'Šifrované spojení (HTTPS) přerušil antivir nebo firewall – povolte v něm výjimku pro node.exe.'],
  [/HTTP 40[13]\b|HTTP 429\b|captch|nejste robot|jste člověk|Cloudflare|\bověřen|zablokov|blokac|příliš mnoho|too many/i, 'Web stahování dočasně blokuje (ochrana proti robotům) – další běh to zkusí znovu. Opakuje-li se to denně, nastavte delší pauzu (KOLOMAPA_DELAY_MS=3000 v nastaveni.txt).'],
  [/HTTP 5\d\d\b/, 'Web má potíže na své straně – při dalším běhu se to zkusí znovu.'],
  [/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR|Vypršel čas|socket hang up|fetch failed/i, 'Web neodpovídá nebo spojení blokuje firewall / antivir – zkuste to později.'],
  [/změna webu|změnilo se API|nemá očekávanou podobu|neočekávan|neznámý formát|neplatný JSON|nevrátil JSON|neobsahuje data/i, 'Web nejspíš změnil podobu stránek – stahování z něj je potřeba upravit v programu (src/sources). Ostatní weby běží dál.'],
  [/database is locked|SQLITE_BUSY|database table is locked/i, 'Databázi právě používá jiný program – neběží Kolomapa dvakrát? Neleží složka v OneDrive / Dropboxu?'],
  [/SQLITE_CORRUPT|malformed|not a database/i, 'Databáze je poškozená – zavřete Kolomapu a soubor kolomapa.db ve složce data přejmenujte (inzeráty se stáhnou znovu).'],
  [/ENOSPC|disk is full|database or disk is full/i, 'Na disku došlo místo.'],
  [/EACCES|EPERM|readonly|read-only|zapisovateln/i, 'Do složky s databází nejde zapisovat – nedávejte Kolomapu do „Program Files“ ani do složky jen pro čtení.'],
  [/playwright|prohlížeč/i, 'Cyklobazar potřebuje prohlížeč: ve složce kolomapa spusťte npm install a npx playwright install chromium (nebo Cyklobazar vypněte).'],
  [/@anthropic-ai\/sdk/i, 'AI nacenění potřebuje balíček: ve složce kolomapa spusťte npm install.'],
  [/Už běží jiné stahování/i, 'Pokud jistě nic jiného nestahuje (např. po pádu počítače), smažte soubor kolomapa.db.run-lock ve složce data a zkuste to znovu.'],
];

/** Rada k chybové hlášce, nebo null. */
function errorHint(message) {
  const m = String(message || '');
  for (const [re, hint] of HINTS) if (re.test(m)) return hint;
  return null;
}

/** Nestáhl se žádný web? (všechny zdroje skončily chybou a nepřinesly ani jeden inzerát) */
function nothingDownloaded(res) {
  const src = Object.values((res && res.stats && res.stats.sources) || {});
  return src.length > 0 && src.every((s) => s && s.error && !(Number(s.scanned) > 0) && !(Number(s.details) > 0));
}

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
const localTime = (d) => {
  try {
    return d.toLocaleString('cs-CZ', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return d.toISOString();
  }
};

function duration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * Čitelné shrnutí běhu (česky).
 * @param {object} res výsledek runOnce
 * @param {number} ms doba běhu
 * @param {Date} [endedAt] konec běhu (do nadpisu v místním čase – log píše časy v UTC)
 */
function formatSummary(res, ms, endedAt) {
  const lines = [];
  const hints = new Set();
  const hint = (msg) => {
    const h = errorHint(msg);
    if (h) hints.add(h);
  };
  const none = nothingDownloaded(res);
  const statusText = none ? 'CHYBA – žádný web se nepodařilo stáhnout' : STATUS_TEXT[res.status] || res.status;
  lines.push('');
  lines.push(`Kolomapa – stahování${endedAt ? ` ${localTime(endedAt)}` : ''}: ${statusText} (${duration(ms)})`);
  if (res.error) {
    lines.push(`  Chyba: ${res.error}`);
    hint(res.error);
  }
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
    if (s.error) hint(s.error);
  }
  if (st.classified != null || st.priced != null) {
    lines.push(
      `  Zpracování  ${n(st.classified)} klasifikováno · ${n(st.geocoded)} s nově určenou polohou · ${n(st.priced)} naceněno` +
        `${st.ai ? ` · ${n(typeof st.ai === 'object' ? st.ai.done ?? st.ai.count ?? 0 : st.ai)} AI` : ''}` +
        `${st.pruned ? ` · ${n(st.pruned)} starých smazáno` : ''}`
    );
  }
  if (st.aiError) {
    lines.push(`  AI nacenění selhalo: ${st.aiError}`);
    hint(st.aiError);
  }
  if (res.exported) lines.push(`  Statická verze: ${res.exported.outDir} (${n(res.exported.files)} souborů)`);
  if (res.exportError) {
    lines.push(`  Statický export selhal: ${res.exportError}`);
    hint(res.exportError);
  }
  for (const h of hints) lines.push(`  → ${h}`);
  lines.push('');
  return lines.join('\n');
}

/** Návratový kód procesu podle výsledku běhu. */
function exitCodeFor(res) {
  if (!res || (res.status !== 'ok' && res.status !== 'partial')) return 1;
  return nothingDownloaded(res) ? 1 : 0;
}

/**
 * --process-only: klasifikace, poloha a nacenění uložených inzerátů bez stahování (pod zámkem běhu, aby se nepotkalo
 * se stahováním). Vrací návratový kód.
 */
function processOnly(db, config, log) {
  const { acquireRunLock } = require('../src/server/scheduler');
  const { classifyPending, geocodePending } = require('../src/pipeline');
  const pricing = require('../src/pricing');
  const lock = acquireRunLock(config.dbFile);
  if (lock.busy) {
    console.error('Kolomapa – zpracování: už běží jiné stahování (zámek běhu) – zkuste to, až skončí.');
    db.close();
    return 1;
  }
  const t0 = Date.now();
  try {
    const classified = classifyPending(db);
    const geocoded = geocodePending(db);
    const model = pricing.trainModel(db, { config, log });
    const priced = pricing.priceAll(db, model, { config });
    console.log(`Kolomapa – zpracování bez stahování: klasifikováno ${n(classified)}, poloha ${n(geocoded)}, naceněno ${n(priced)} (${Math.round((Date.now() - t0) / 1000)} s)`);
    return 0;
  } catch (e) {
    console.error(`Kolomapa – zpracování: CHYBA – ${e.message}`);
    return 1;
  } finally {
    lock.release();
    try {
      db.close();
    } catch {
      /* nic */
    }
  }
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
      'Použití: node tools/run.js [--sources=bazos,sbazar,aukro,cyklobazar] [--max-details=N] [--max-pages=N] [--full] [--export] [--process-only] [--db=SOUBOR]'
    );
    return 0;
  }
  const config = loadConfig(process.env); // neplatné hodnoty nastavení ohlásí sám (varování v logu)
  const log = defaultLog;
  if (typeof log.setLevel === 'function') log.setLevel(config.logLevel);
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

  let db;
  try {
    db = openDb(config.dbFile);
  } catch (e) {
    const msg = String(e.message).split('\n')[0];
    console.error(`\nKolomapa – stahování: CHYBA – databázi nejde otevřít.\n  ${msg}`);
    const h = errorHint(msg);
    if (h) console.error(`  → ${h}`);
    console.error('');
    return 1;
  }
  if (args['process-only']) return processOnly(db, config, log);
  const controller = new AbortController();
  const onSignal = (sig) => {
    if (controller.signal.aborted) process.exit(1);
    log.warn(`Přijat ${sig} – přerušuji stahování (další ${sig} ukončí hned)…`);
    controller.abort(new Error(`Přerušeno (${sig})`));
  };
  // SIGHUP = ve Windows zavření okna konzole (Node pak proces do ~10 s ukončí), SIGBREAK = Ctrl+Break.
  // Přerušení stihne uvolnit zámek běhu, aby další spuštění nehlásilo „už běží jiné stahování“.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
    try {
      process.on(sig, onSignal);
    } catch {
      /* signál na této platformě neexistuje */
    }
  }
  log.info(`Kolomapa – stahování spuštěno ${localTime(new Date())}`, { zdroje: (sources || config.sources).join(','), db: config.dbFile });

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
  console.log(formatSummary(res, Date.now() - t0, new Date()));
  return exitCodeFor(res);
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

module.exports = { main, parseArgs, formatSummary, errorHint, exitCodeFor, nothingDownloaded };
