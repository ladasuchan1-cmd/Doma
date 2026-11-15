// Sledované zdroje pro Investiční školu: weby, kanály a stránky na sociálních sítích, které chce uživatel mít po ruce.
//
// U webu se server pokusí najít kanál novinek (RSS/Atom) a ukazuje z něj poslední titulky.
// Sociální sítě (Facebook, Instagram, X…) čtení bez přihlášení nedovolují – u nich zůstává jen odkaz.
// Server stahuje adresy, které zadal přihlášený uživatel; i tak nesmí jít do vnitřní sítě (kontrola adres níže).
'use strict';
const dns = require('dns').promises;
const net = require('net');

const SOCIALNI = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|x\.com|twitter\.com|tiktok\.com|linkedin\.com|threads\.net)$/i;
const MAX_BAJTU = 1500000;

function typZdroje(host) {
  if (/(^|\.)(facebook\.com|fb\.com|fb\.me)$/i.test(host)) return 'facebook';
  return SOCIALNI.test(host) ? 'socialni' : 'web';
}

function soukroma(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const s = ip.toLowerCase();
  if (s.startsWith('::ffff:')) return soukroma(s.slice(7));
  return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
}

function chyba(kod, zprava) { return Object.assign(new Error(zprava || kod), { kod }); }

function platnaAdresa(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  if (u.port && u.port !== '443') return null;
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) return null; // adresa musí být doména, ne číslo
  return u;
}

const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function cistyText(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 32))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITY[n.toLowerCase()] || m)
    .replace(/\s+/g, ' ').trim();
}

// Poslední položky z RSS nebo Atomu. Bez knihovny: stačí titulek, odkaz a datum.
function ctiFeed(xml, zaklad) {
  const polozky = [];
  const bloky = String(xml || '').match(/<(item|entry)[\s>][\s\S]*?<\/\1>/gi) || [];
  for (const b of bloky.slice(0, 30)) {
    const tag = (n) => { const m = new RegExp('<' + n + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + n + '>', 'i').exec(b); return m ? m[1] : ''; };
    const titul = cistyText(tag('title')).slice(0, 200);
    let odkaz = cistyText(tag('link'));
    if (!odkaz) { const m = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i.exec(b); if (m) odkaz = cistyText(m[1]); }
    let adresa = null;
    try { if (!odkaz) throw new Error('bez odkazu'); const u = new URL(odkaz, zaklad); if (u.protocol === 'https:' || u.protocol === 'http:') adresa = u.href; } catch (e) { /* položka bez platného odkazu se vynechá */ }
    const t = Date.parse(cistyText(tag('pubDate') || tag('published') || tag('updated') || tag('dc:date')));
    if (titul && adresa) polozky.push({ titul, odkaz: adresa, kdy: isFinite(t) ? Math.floor(t / 1000) : null });
  }
  return polozky.sort((a, b) => (b.kdy || 0) - (a.kdy || 0)).slice(0, 5);
}

function najdiFeed(html, zaklad) {
  for (const m of String(html || '').slice(0, 300000).matchAll(/<link\b[^>]*>/gi)) {
    const t = m[0];
    if (!/rel=["']?alternate/i.test(t) || !/type=["']?application\/(rss|atom)\+xml/i.test(t)) continue;
    const h = /href=["']([^"']+)["']/i.exec(t);
    if (!h) continue;
    try { const u = platnaAdresa(new URL(cistyText(h[1]), zaklad).href); if (u) return u.href; } catch (e) { /* další */ }
  }
  return null;
}
const jeFeed = (text) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<(rss|feed|rdf:RDF)\b/i.test(String(text || '').slice(0, 2000));

function zdroje(opts = {}) {
  const stahniSit = opts.fetch || fetch;
  const hledejDns = opts.lookup || ((h) => dns.lookup(h, { all: true }));
  const ted = opts.ted || (() => Date.now());
  const cache = new Map();

  async function over(u) {
    if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) throw chyba('zakazana_adresa', 'Adresa musí být doména, ne číslo.');
    let adresy;
    try { adresy = await hledejDns(u.hostname); } catch (e) { throw chyba('nedostupne', 'Doména neexistuje.'); }
    if (!adresy.length || adresy.some((a) => soukroma(a.address))) throw chyba('zakazana_adresa', 'Adresa vede do vnitřní sítě.');
  }

  async function stahni(adresa) {
    let u = platnaAdresa(adresa);
    if (!u) throw chyba('neplatna_adresa', 'Adresa musí začínat https://.');
    for (let skok = 0; skok < 4; skok++) {
      await over(u);
      let r;
      try { r = await stahniSit(u.href, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; investicni-skola)', Accept: 'text/html,application/rss+xml,application/atom+xml,application/xml;q=0.9,*/*;q=0.5' }, signal: AbortSignal.timeout(10000) }); }
      catch (e) { throw chyba('nedostupne', 'Web neodpověděl.'); }
      if (r.status >= 300 && r.status < 400) {
        const dal = platnaAdresa(new URL(r.headers.get('location') || '', u).href);
        if (!dal) throw chyba('nedostupne', 'Web přesměrovává na nepodporovanou adresu.');
        u = dal; continue;
      }
      if (!r.ok) throw chyba('nedostupne', 'Web vrátil chybu ' + r.status + '.');
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_BAJTU) throw chyba('nedostupne', 'Stránka je příliš velká.');
      return { text: buf.toString('utf8'), adresa: u.href };
    }
    throw chyba('nedostupne', 'Příliš mnoho přesměrování.');
  }

  // Co se s adresou dá dělat: sociální síť = jen odkaz; web = zkusit najít kanál novinek.
  async function prozkoumej(adresa) {
    const u = platnaAdresa(adresa);
    if (!u) throw chyba('neplatna_adresa', 'Adresa musí začínat https://.');
    const typ = typZdroje(u.hostname);
    if (typ !== 'web') return { typ, feed: null };
    try {
      const s = await stahni(u.href);
      if (jeFeed(s.text)) return { typ, feed: s.adresa };
      return { typ, feed: najdiFeed(s.text, s.adresa) };
    } catch (e) {
      if (e.kod === 'zakazana_adresa') throw e;
      return { typ, feed: null }; // web, který teď neodpovídá, jde přidat jako odkaz
    }
  }

  async function novinky(feed) {
    const z = cache.get(feed), t = ted();
    if (z && t - z.kdy < 15 * 60 * 1000) return z.data;
    try {
      const s = await stahni(feed);
      const data = ctiFeed(s.text, s.adresa);
      cache.set(feed, { kdy: t, data });
      if (cache.size > 100) cache.delete(cache.keys().next().value);
      return data;
    } catch (e) {
      if (z) return z.data; // při výpadku poslední známé titulky
      throw e;
    }
  }

  return { prozkoumej, novinky };
}

module.exports = { zdroje, platnaAdresa, typZdroje, soukroma, ctiFeed, najdiFeed, jeFeed, cistyText };
