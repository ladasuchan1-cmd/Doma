#!/usr/bin/env node
'use strict';
// Obohacení míst z jejich webů: stáhne úvodní stránku (+ až 2 kontaktní podstránky), vytáhne e-maily, telefony,
// IČO, provozovatele a zmínky o půjčovně kol/lyží; podle IČO dohledá název firmy v ARES. Výsledek zapisuje do
// data/enrich.js (window.CSM_DATA.enrich = { <id místa>: {...} }). Běh je obnovitelný – hotová místa přeskakuje.
//
//   node tools/enrich-web.js                 # všechna místa s webem, která ještě nejsou zpracovaná
//   node tools/enrich-web.js --limit 200     # jen prvních 200 nezpracovaných
//   node tools/enrich-web.js --force         # znovu i už zpracovaná
//   node tools/enrich-web.js --ids n123,w456 # jen vybraná místa
//   node tools/enrich-web.js --skupina pujcovna   # jen půjčovny/obchody (ubytovani | pujcovna | infocentrum)
//
// Bez závislostí (Node 22+). Slušnost: max. 1 požadavek najednou na doménu, celkem CSM_CONCURRENCY (výchozí 8).

const fs = require('node:fs');
const path = require('node:path');
const contacts = require('../lib/contacts.js');
const { readDataset, writeDataset } = require('./lib/data-io.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const args = parseArgs(process.argv.slice(2));
const CONCURRENCY = Number(process.env.CSM_CONCURRENCY || args.concurrency || 8);
const TIMEOUT_MS = Number(process.env.CSM_TIMEOUT_MS || 20000);
const MAX_BYTES = 1.5 * 1024 * 1024;
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36 cyklo-ski-mapa/0.1 (+https://github.com/ladasuchan1-cmd/Doma)';
const ARES_URL = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--force') out.force = true;
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--ids') out.ids = new Set(argv[++i].split(','));
    else if (a === '--skupina') out.skupina = argv[++i];
    else if (a === '--concurrency') out.concurrency = Number(argv[++i]);
    else if (a === '--help' || a === '-h') {
      console.log('node tools/enrich-web.js [--limit N] [--force] [--ids a,b] [--skupina ubytovani|pujcovna|infocentrum] [--concurrency N]');
      process.exit(0);
    }
  }
  return out;
}

function log(...a) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

// ------------------------------------------------------------ stahování
async function fetchPage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', 'Accept-Language': 'cs,sk;q=0.9,en;q=0.7' }, redirect: 'follow', signal: ctrl.signal });
    const type = res.headers.get('content-type') || '';
    if (!res.ok) return { ok: false, status: res.status, url: res.url, html: '' };
    if (!/html|xml|text\/plain/i.test(type)) return { ok: false, status: res.status, url: res.url, html: '', chyba: 'není HTML (' + type.split(';')[0] + ')' };
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
      if (total > MAX_BYTES) {
        ctrl.abort();
        break;
      }
    }
    const buf = Buffer.concat(chunks);
    return { ok: true, status: res.status, url: res.url, html: decodeHtml(buf, type) };
  } finally {
    clearTimeout(timer);
  }
}

function decodeHtml(buf, contentType) {
  let charset = (/charset=([\w-]+)/i.exec(contentType) || [])[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(head) || [])[1];
  }
  charset = (charset || 'utf-8').toLowerCase();
  if (charset === 'windows-1250' || charset === 'cp1250' || charset === 'iso-8859-2' || charset === 'latin2') {
    try {
      return new TextDecoder(charset === 'cp1250' ? 'windows-1250' : charset).decode(buf);
    } catch (_e) {
      return buf.toString('utf8');
    }
  }
  return buf.toString('utf8');
}

const aresCache = new Map();
async function aresLookup(ico) {
  if (aresCache.has(ico)) return aresCache.get(ico);
  let out = null;
  try {
    const res = await fetch(ARES_URL + ico, { headers: { Accept: 'application/json', 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const j = await res.json();
      out = { ico, nazev: j.obchodniJmeno || null, forma: j.pravniForma || null, sidlo: j.sidlo && j.sidlo.textovaAdresa ? j.sidlo.textovaAdresa : null };
    }
  } catch (_e) {
    out = null;
  }
  aresCache.set(ico, out);
  await sleep(250);
  return out;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------- jedno místo/web
async function enrichSite(url) {
  const result = { web: url, stav: 'ok', chyba: null, kdy: new Date().toISOString(), emaily: [], telefony: [], ico: [], provozovatel: null, ares: null, pujcovna: null, stranky: 0 };
  const texts = [];
  const htmls = [];
  const first = await fetchPage(url).catch((e) => ({ ok: false, chyba: e.name === 'AbortError' ? 'vypršel čas' : e.message }));
  if (!first.ok) {
    result.stav = 'chyba';
    result.chyba = first.chyba || (first.status ? 'HTTP ' + first.status : 'nedostupné');
    return result;
  }
  result.web = first.url || url;
  result.stranky = 1;
  htmls.push(first.html);
  texts.push(contacts.stripHtml(first.html));
  const links = contacts.findContactLinks(first.html, result.web).slice(0, 2);
  for (const l of links) {
    const page = await fetchPage(l).catch(() => ({ ok: false }));
    if (page.ok) {
      result.stranky++;
      htmls.push(page.html);
      texts.push(contacts.stripHtml(page.html));
    }
  }
  const allHtml = htmls.join('\n');
  const allText = texts.join('\n');
  result.emaily = contacts.extractEmails(allHtml).slice(0, 6);
  result.telefony = contacts.extractPhones(allHtml).slice(0, 6);
  result.ico = contacts.extractIco(allText).slice(0, 3);
  result.provozovatel = contacts.extractOperator(allText);
  const rent = contacts.detectRental(allText);
  result.pujcovna = { kola: rent.kola, lyze: rent.lyze, obecne: rent.obecne, ukazky: rent.ukazky.slice(0, 3) };
  if (result.ico.length) result.ares = await aresLookup(result.ico[0]);
  return result;
}

// ------------------------------------------------------------------ main
async function main() {
  const mista = readDataset(DATA, 'mista');
  if (!mista) throw new Error('Chybí data/mista.js – spusťte nejdřív npm run build-data');
  const enrich = (!args.force && readDataset(DATA, 'enrich')) || {};
  let todo = mista.filter((m) => m.web && m.web.length && (args.force || !enrich[m.id]));
  if (args.ids) todo = todo.filter((m) => args.ids.has(m.id));
  if (args.skupina) todo = todo.filter((m) => m.skupina === args.skupina);
  // půjčovny a obchody mají pro obchod přednost, pak ubytování, pak infocentra
  const prio = { pujcovna: 0, ubytovani: 1, infocentrum: 2 };
  todo.sort((a, b) => prio[a.skupina] - prio[b.skupina] || a.nazev.localeCompare(b.nazev, 'cs'));
  if (args.limit) todo = todo.slice(0, args.limit);
  log(`míst s webem: ${mista.filter((m) => m.web && m.web.length).length}, hotovo: ${Object.keys(enrich).length}, ke zpracování: ${todo.length}, souběžnost ${CONCURRENCY}`);

  const byUrl = new Map(); // stejný web u více míst → stáhnout jen jednou
  const hostBusy = new Map();
  let done = 0;
  let errors = 0;
  let dirty = 0;
  const started = Date.now();

  const save = () => {
    if (!dirty) return;
    writeDataset(DATA, 'enrich', enrich);
    dirty = 0;
  };
  const saveTimer = setInterval(save, 15000);

  const queue = todo.slice();
  async function worker() {
    while (queue.length) {
      const m = queue.shift();
      const url = m.web.find((w) => !contacts.isSocialUrl(w)) || m.web[0];
      const host = contacts.hostOf(url) || url;
      if (hostBusy.get(host)) {
        queue.push(m); // doména právě běží → zařadit na konec
        await sleep(200);
        continue;
      }
      hostBusy.set(host, true);
      try {
        let res = byUrl.get(url);
        if (!res) {
          res = await enrichSite(url).catch((e) => ({ web: url, stav: 'chyba', chyba: e.message, kdy: new Date().toISOString() }));
          byUrl.set(url, res);
        }
        enrich[m.id] = res;
        dirty++;
        done++;
        if (res.stav !== 'ok') errors++;
        if (done % 25 === 0) {
          const rate = done / ((Date.now() - started) / 1000);
          log(`${done}/${todo.length} (chyb ${errors}, ${rate.toFixed(1)}/s, zbývá ~${Math.round((todo.length - done) / Math.max(rate, 0.01) / 60)} min)`);
        }
      } finally {
        hostBusy.set(host, false);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  clearInterval(saveTimer);
  save();
  const okCount = Object.values(enrich).filter((e) => e.stav === 'ok').length;
  const withEmail = Object.values(enrich).filter((e) => e.emaily && e.emaily.length).length;
  const withRental = Object.values(enrich).filter((e) => e.pujcovna && (e.pujcovna.kola || e.pujcovna.lyze)).length;
  log(`hotovo: ${done} zpracováno (${errors} chyb); celkem v enrich.js ${Object.keys(enrich).length}, úspěšných ${okCount}, s e-mailem ${withEmail}, se zmínkou o půjčovně ${withRental}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
