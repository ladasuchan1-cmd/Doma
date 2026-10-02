#!/usr/bin/env node
'use strict';
// Ruční zkouška jednoho zdroje proti živému webu (NENÍ součástí npm test): projde pár stránek výpisu, stáhne pár
// detailů a vypíše normalizované položky. Nic neukládá do databáze – jen pauzu Cyklobazaru po ověření Cloudflare
// (cache:cyklobazar:cooldownUntil), aby platila i pro další zkoušky a denní běh. Požadavky jdou přes sdílený šetrný
// HTTP klient (Cyklobazar přes sdílený prohlížeč, src/sources/browser.js).
//
//   node tools/try-source.js <zdroj> [--pages=1] [--details=3] [--mode=incremental|full] [--show=5] [--json]
//
//   <zdroj>     bazos | sbazar | aukro | cyklobazar
//   --pages     max. stránek výpisu na kategorii (ctx.maxPages, výchozí 1)
//   --details   kolik detailů stáhnout (výchozí 3; 0 = žádný)
//   --mode      incremental (výchozí) | full – režim průchodu výpisu, jak ho dostane zdroj
//   --show      kolik položek z výpisu vypsat (výchozí 5)
//   --json      vypsat vše jako JSON (položky z výpisu i detaily)
//   --delay     pauza mezi požadavky na jeden web v ms (výchozí KOLOMAPA_DELAY_MS, jinak 1200; nejméně 1000)
// Návratový kód: 0 = výpis i detaily bez chyby, 1 = chyba.

const { loadConfig, ALL_SOURCES } = require('../src/config');
const { loadSources } = require('../src/sources');
const { createHttp } = require('../src/util/http');
const log = require('../src/util/log');

const USAGE = `Použití: node tools/try-source.js <${ALL_SOURCES.join('|')}> [--pages=1] [--details=3] [--mode=incremental|full] [--show=5] [--json] [--delay=MS]`;

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] ?? true;
    else out._.push(a);
  }
  return out;
}

function intArg(v, name, fallback) {
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} musí být celé číslo ≥ 0`);
  return n;
}

/** Položka zdroje → řádek ve tvaru, jaký dostane detail() z pipeline (sloupce DB + původní camelCase pole). */
function asRow(key, item) {
  return {
    ...item,
    id: 0,
    source: key,
    source_id: String(item.sourceId),
    url: item.url,
    title: item.title,
    description: item.description ?? null,
    price_czk: item.priceCzk ?? null,
    price_note: item.priceNote ?? null,
    posted_at: item.postedAt ?? null,
    category_src: item.categorySrc ?? null,
    location_text: item.locationText ?? null,
    psc: item.psc ?? null,
    okres: item.okres ?? null,
    kraj: item.kraj ?? null,
    lat: item.lat ?? null,
    lon: item.lon ?? null,
    photo_url: item.photoUrl ?? null,
    photo_count: item.photoCount ?? null,
    params: item.params && typeof item.params === 'object' ? item.params : {},
    seller_type: item.sellerType ?? null,
    views: item.views ?? null,
    detail_at: null,
    gone_at: null,
  };
}

const short = (s, n) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const price = (it) => (it.priceCzk != null ? `${new Intl.NumberFormat('cs-CZ').format(it.priceCzk)} Kč` : it.priceNote || '—');

function printItem(it, { full = false } = {}) {
  const lines = [`  [${it.sourceId}] ${short(it.title, 90)}`];
  lines.push(`      cena: ${price(it)} · vloženo: ${it.postedAt || '?'} · kategorie: ${it.categorySrc || '?'} · zobrazení: ${it.views ?? '?'}`);
  lines.push(
    `      místo: ${[it.locationText, it.psc, it.okres, it.kraj].filter(Boolean).join(', ') || '?'}` +
      (it.lat != null ? ` (${it.lat}, ${it.lon})` : '') +
      (it.sellerType ? ` · prodejce: ${it.sellerType}` : '')
  );
  lines.push(`      fotka: ${it.photoUrl || '—'}${it.photoCount != null ? ` (${it.photoCount} fotek)` : ''}`);
  lines.push(`      odkaz: ${it.url}`);
  if (it.description) lines.push(`      popis: ${short(it.description, full ? 400 : 140)}`);
  if (it.params && Object.keys(it.params).length) lines.push(`      parametry: ${short(JSON.stringify(it.params), 300)}`);
  console.log(lines.join('\n'));
}

async function main(argv) {
  let args;
  let key;
  let pages;
  let details;
  let show;
  let delayMs;
  const config = loadConfig(process.env);
  try {
    args = parseArgs(argv);
    if (args.help || args.h) {
      console.log(USAGE);
      return 0;
    }
    key = String(args._[0] || '').toLowerCase();
    if (!ALL_SOURCES.includes(key)) throw new Error(`Neznámý nebo chybějící zdroj „${key}“.\n${USAGE}`);
    pages = intArg(args.pages, 'pages', 1);
    details = intArg(args.details, 'details', 3);
    show = intArg(args.show, 'show', 5);
    // Živé weby třetích stran: nikdy rychleji než 1 požadavek za sekundu (i kdyby --delay / KOLOMAPA_DELAY_MS bylo menší).
    delayMs = Math.max(1000, intArg(args.delay, 'delay', config.delayMs));
    if (args.mode !== undefined && !['incremental', 'full'].includes(args.mode)) throw new Error('--mode musí být incremental nebo full');
  } catch (e) {
    console.error(e.message);
    return 1;
  }
  const mode = args.mode || 'incremental';
  const [src] = loadSources([key], log);
  if (!src) {
    console.error(`Zdroj ${key} nejde načíst (viz varování výše).`);
    return 1;
  }

  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(new Error('Přerušeno (SIGINT)')));
  const http = createHttp({ delayMs, userAgent: config.userAgent || undefined, log, signal: controller.signal });
  let browserMod = null;
  const getBrowser = async () => {
    browserMod ||= require('../src/sources/browser');
    return browserMod.getBrowser({ config, log });
  };
  // Zdroj za Cloudflare: pauza po ověření (cooldownUntil) se čte a ukládá v databázi jako v denním běhu – jinak by
  // další zkouška šla na web hned znovu. Ostatní stav (obzor, pozice průchodu) zůstává jen v paměti, aby zkouška
  // neovlivnila denní běh.
  const PERSIST_KEYS = new Set(['cooldownUntil']);
  let db = null;
  let persistent = null;
  if (src.requiresBrowser) {
    try {
      db = require('../src/db').openDb(config.dbFile);
      persistent = require('../src/pipeline').makeCache(db, key);
    } catch (e) {
      log.warn(`Pauzu po ověření Cloudflare nejde uložit do databáze (${String(e.message).split('\n')[0]}) – po ověření zkoušku 12 h nespouštějte`);
    }
  }
  const useDb = (k) => persistent && PERSIST_KEYS.has(k);
  const items = new Map();
  const ctx = {
    http,
    getBrowser,
    log,
    // zkušební běh: jen pár překladů lokalit Sbazaru (jinak až 400 dotazů s prázdnou cache)
    config: { ...config, sbazarMaxResolve: Math.min(config.sbazarMaxResolve ?? 3, 3) },
    signal: controller.signal,
    mode,
    maxPages: pages,
    minPrice: config.minPrice,
    cache: (() => {
      const m = new Map();
      return {
        get: (k) => (useDb(k) ? persistent.get(k) : m.get(k)),
        set: (k, v) => (useDb(k) ? persistent.set(k, v) : m.set(k, v)),
        delete: (k) => (useDb(k) ? persistent.delete(k) : m.delete(k)),
      };
    })(),
    isKnown: (id) => (items.has(String(id)) ? { id: 0, price_czk: items.get(String(id)).priceCzk ?? null, title: items.get(String(id)).title, detail_at: null, gone_at: null } : null),
    emit: async (item) => {
      const id = String(item.sourceId);
      const isNew = !items.has(id);
      items.set(id, { ...(items.get(id) || {}), ...item });
      return { isNew, changed: isNew };
    },
  };

  const t0 = Date.now();
  let failed = false;
  let scanRes = null;
  const list = [];
  const detailed = [];
  console.log(`${src.label}: výpis (${mode === 'full' ? 'celý' : 'jen novinky'}, max. ${pages} stránek na kategorii)…`);
  try {
    try {
      scanRes = (await src.scan(ctx)) || {};
    } catch (e) {
      failed = true;
      console.error(`Výpis selhal: ${e.message}`);
    }
    list.push(...items.values());
    for (const it of list.slice(0, details)) {
      if (controller.signal.aborted) break;
      try {
        const d = await src.detail(ctx, asRow(key, it));
        detailed.push(d === null ? { sourceId: it.sourceId, url: it.url, title: it.title, gone: true } : { ...it, ...d });
      } catch (e) {
        failed = true;
        detailed.push({ sourceId: it.sourceId, url: it.url, title: it.title, error: e.message });
      }
    }
  } finally {
    // prohlížeč zavřít vždy (jinak běžící Chromium nedovolí procesu skončit)
    if (browserMod) {
      for (const fn of ['closeBrowser', 'close']) {
        if (typeof browserMod[fn] === 'function') {
          await browserMod[fn]().catch(() => {});
          break;
        }
      }
    }
    try {
      db?.close?.();
    } catch {
      /* už zavřená */
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (args.json) {
    console.log(JSON.stringify({ source: key, mode, complete: !!scanRes?.complete, requests: http.requests, seconds: Number(secs), items: list, details: detailed }, null, 2));
    return failed ? 1 : 0;
  }
  console.log(`\nVýpis: ${list.length} inzerátů · complete=${!!scanRes?.complete} · ${http.requests} požadavků · ${secs} s`);
  const withPrice = list.filter((x) => x.priceCzk != null).length;
  const withDate = list.filter((x) => x.postedAt).length;
  const withPhoto = list.filter((x) => x.photoUrl).length;
  console.log(`  s cenou ${withPrice} · s datem ${withDate} · s fotkou ${withPhoto} · kategorie: ${[...new Set(list.map((x) => x.categorySrc))].join(', ')}`);
  console.log(`\nPrvních ${Math.min(show, list.length)} položek z výpisu:`);
  for (const it of list.slice(0, show)) printItem(it);
  if (detailed.length) {
    console.log(`\nDetaily (${detailed.length}):`);
    for (const d of detailed) {
      if (d.gone) console.log(`  [${d.sourceId}] ${short(d.title, 90)} → inzerát už neexistuje`);
      else if (d.error) console.log(`  [${d.sourceId}] ${short(d.title, 90)} → CHYBA: ${d.error}`);
      else printItem(d, { full: true });
    }
  }
  return failed ? 1 : 0;
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

module.exports = { main, parseArgs, asRow };
