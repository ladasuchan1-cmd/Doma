// Kontakty – vytažení e-mailů, telefonů, IČO, provozovatele a zmínek o půjčovně z textu webu;
// normalizace telefonů a URL. UMD: v prohlížeči `CSM.contacts`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CSM = root.CSM || {}; root.CSM.contacts = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ' };

  function decodeEntities(s) {
    return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      const key = e.toLowerCase();
      if (ENTITIES[key] != null) return ENTITIES[key];
      if (key[0] === '#') {
        const code = key[1] === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
        if (Number.isFinite(code) && code > 0 && code < 0x110000) return String.fromCodePoint(code);
      }
      return m;
    });
  }

  // HTML → prostý text (skripty a styly pryč, značky nahradí mezera, entity dekódované).
  function stripHtml(html) {
    if (!html) return '';
    let s = String(html);
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ');
    s = s.replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|td|th|section|article|header|footer)>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
    s = s.replace(/[​-‍﻿]/g, '');
    return s.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
  }

  // Textové „zamaskování“ e-mailů: name [at] domain (dot) cz, name(zavináč)domain.cz …
  function unmaskEmails(s) {
    return s
      .replace(/\s*[\[({<]\s*(at|zavináč|zavinac|@)\s*[\])}>]\s*/gi, '@')
      .replace(/\s*[\[({<]\s*(dot|tečka|tecka)\s*[\])}>]\s*/gi, '.');
  }

  const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi;
  const EMAIL_JUNK = /(example\.|sentry|wixpress|\.png$|\.jpe?g$|\.gif$|\.svg$|\.webp$|@2x|@3x|^[a-f0-9]{16,}@|domain\.|email\.cz$|^info@email|@mail\.(ru)$|^noreply|^no-reply|schema\.org|w3\.org|^[^@]*@[^@]*\.(js|css|html?)$|^user@|^name@|^jmeno@|^vas@|^vasemail@|^email@|^test@|^mail@mail)/i;

  // Vrátí unikátní e-maily (malá písmena) nalezené v textu/HTML; preferuje mailto: odkazy.
  function extractEmails(text) {
    if (!text) return [];
    const found = new Set();
    const src = unmaskEmails(String(text));
    for (const m of src.matchAll(/mailto:([^"'?\s>]+)/gi)) {
      const e = decodeURIComponent(m[1]).toLowerCase().trim();
      if (isPlausibleEmail(e)) found.add(e);
    }
    for (const m of src.matchAll(EMAIL_RE)) {
      const e = m[0].toLowerCase().replace(/\.+$/, '');
      if (isPlausibleEmail(e)) found.add(e);
    }
    return [...found];
  }

  function isPlausibleEmail(e) {
    if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/.test(e)) return false;
    if (EMAIL_JUNK.test(e)) return false;
    if (e.length > 80) return false;
    const [, dom] = e.split('@');
    if (dom.split('.').some((p) => !p.length)) return false;
    return true;
  }

  // Telefon → „+420 123 456 789“ (CZ) / „+421 …“ (SK); jinak null. Bere 9místná čísla CZ/SK i mezinárodní tvar.
  function normalizePhone(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    if (!s) return null;
    if (s.startsWith('00')) s = '+' + s.slice(2);
    if (/^\+?420\d{9}$/.test(s)) return fmt('+420', s.slice(-9));
    if (/^\+?421\d{9}$/.test(s)) return fmt('+421', s.slice(-9));
    if (/^\d{9}$/.test(s) && /^[2-79]/.test(s)) return fmt('+420', s);
    if (/^\+\d{9,14}$/.test(s)) return s;
    return null;
  }

  function fmt(prefix, n) {
    return prefix + ' ' + n.slice(0, 3) + ' ' + n.slice(3, 6) + ' ' + n.slice(6);
  }

  const PHONE_RE = /(?:\+|00)\s?42[01](?:[\s\-.()]?\d){9}|(?<![\d,.])\b[2-7]\d{2}[\s\-.]?\d{3}[\s\-.]?\d{3}\b(?!\d|[,.]\d| ?(?:kč|czk|eur|€|%|m\b|km\b|kg\b|ks\b|cm\b))/gi;

  // Vrátí unikátní normalizované telefony; preferuje tel: odkazy. Devítimístná čísla bez předvolby
  // bere jen s mezerami/pomlčkami (123 456 789) nebo za slovem tel/telefon/mobil – jinak se plete s IČO a čísly účtů.
  function extractPhones(text) {
    if (!text) return [];
    const src = String(text);
    const out = new Set();
    for (const m of src.matchAll(/tel:([+\d][\d\s\-().]{6,})/gi)) {
      const p = normalizePhone(m[1]);
      if (p) out.add(p);
    }
    for (const m of src.matchAll(PHONE_RE)) {
      const raw = m[0];
      const digits = raw.replace(/\D/g, '');
      const hasPrefix = /^(\+|00)/.test(raw.trim());
      if (!hasPrefix) {
        const before = src.slice(Math.max(0, m.index - 24), m.index).toLowerCase();
        const grouped = /[\s\-.]/.test(raw.trim());
        const context = /(tel|telefon|mobil|phone|volejte|zavolejte|kontakt|recepce|t:|m:)\s*[.:]?\s*$/.test(before);
        if (!grouped && !context) continue;
        if (digits.length !== 9) continue;
      }
      const p = normalizePhone(raw);
      if (p) out.add(p);
    }
    return [...out];
  }

  // IČO – 8 číslic s platným kontrolním součtem (mod 11); hledá se za IČ/IČO.
  function validIco(ico) {
    if (!/^\d{8}$/.test(ico)) return false;
    let sum = 0;
    for (let i = 0; i < 7; i++) sum += Number(ico[i]) * (8 - i);
    const rem = sum % 11;
    const check = rem === 0 ? 1 : rem === 1 ? 0 : 11 - rem;
    return check === Number(ico[7]);
  }

  function extractIco(text) {
    if (!text) return [];
    const out = new Set();
    for (const m of String(text).matchAll(/I[ČC]O?\.?\s*:?\s*(\d(?:\s?\d){7})(?!\s?\d)/gi)) {
      const ico = m[1].replace(/\s/g, '');
      if (validIco(ico)) out.add(ico);
    }
    return [...out];
  }

  // „Provozovatel: Horská chata s.r.o.“ → název za dvojtečkou (max 100 znaků, bez dalších položek).
  function extractOperator(text) {
    if (!text) return null;
    const m = /provozovatel(?:em|ka|kou)?\s*(?:webu|stránek|e-shopu|hotelu|penzionu|areálu|půjčovny)?\s*(?:je|:)\s*([^\n|;•]{3,100})/i.exec(String(text));
    if (!m) return null;
    let s = m[1].trim();
    s = s.replace(/\s*(,?\s*(IČO?|DIČ|se sídlem|sídlo|tel|e-?mail|www)\b.*)$/i, '').trim();
    s = s.replace(/[,;:\s]+$/, '');
    if (/[^.\s]{3,}\.$/.test(s)) s = s.slice(0, -1); // tečka za větou pryč, „s.r.o.“ / „a.s.“ zůstává
    if (s.length < 3) return null;
    return s;
  }

  const RENTAL_KOLA = /(půjčovn\w*|pujcovn\w*|zapůjč\w*|zapujc\w*|vypůjč\w*|k\s?zapůjčení|rental|verleih|rent\b|hire)\W{0,40}(kol\w*|bike\w*|e-?bik\w*|elektrokol\w*|fahrr[aä]d\w*|koloběž\w*|cycl\w*|mtb)|(kol\w*|bike\w*|e-?bik\w*|elektrokol\w*|fahrr[aä]d\w*|koloběž\w*|cycl\w*)\W{0,40}(půjčovn\w*|pujcovn\w*|zapůjč\w*|zapujc\w*|k\s?zapůjčení|rental|verleih|hire)|bikerental|bike-rental|fahrradverleih|půjčovnakol|pujcovnakol/i;
  const RENTAL_LYZE = /(půjčovn\w*|pujcovn\w*|zapůjč\w*|zapujc\w*|vypůjč\w*|k\s?zapůjčení|rental|verleih|rent\b|hire)\W{0,40}(lyž\w*|lyz\w*|ski\w*|snowboard\w*|běžk\w*|bezk\w*|sněžnic\w*|skialp\w*)|(lyž\w*|lyz\w*|ski\w*|snowboard\w*|běžk\w*|skialp\w*)\W{0,40}(půjčovn\w*|pujcovn\w*|zapůjč\w*|zapujc\w*|k\s?zapůjčení|rental|verleih|hire)|skiverleih|skirental|ski-rental|skiservis|ski\s?servis/i;
  const RENTAL_ANY = /půjčovn\w*|pujcovn\w*|zapůjč\w*|zapujc\w*|\brental\b|\bverleih\b|\bhire\b/i;

  // Zmínky o půjčovně v textu webu: { kola, lyze, obecne, ukazky: [...] }.
  function detectRental(text) {
    const s = String(text || '');
    const res = { kola: RENTAL_KOLA.test(s), lyze: RENTAL_LYZE.test(s), obecne: RENTAL_ANY.test(s), ukazky: [] };
    const seen = new Set();
    for (const m of s.matchAll(new RegExp(RENTAL_ANY.source, 'gi'))) {
      const start = Math.max(0, m.index - 50);
      const end = Math.min(s.length, m.index + m[0].length + 60);
      const snip = s.slice(start, end).replace(/\s+/g, ' ').trim();
      const key = snip.toLowerCase().slice(0, 60);
      if (seen.has(key)) continue;
      seen.add(key);
      res.ukazky.push(snip);
      if (res.ukazky.length >= 5) break;
    }
    return res;
  }

  // Normalizace URL webu: doplní https://, odstraní mezery; neplatné → null.
  function normalizeWebsite(url) {
    if (!url) return null;
    let s = String(url).trim().split(/[\s;,]+/)[0];
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s.replace(/^\/+/, '');
    try {
      const u = new URL(s);
      if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
      if (/^(facebook|www\.facebook|instagram|www\.instagram|m\.facebook)\.com$/i.test(u.hostname)) return u.toString();
      return u.toString();
    } catch (_e) {
      return null;
    }
  }

  function isSocialUrl(url) {
    return /(^|\.)(facebook|instagram|youtube|tiktok|twitter|x)\.com$/i.test(hostOf(url) || '');
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_e) {
      return null;
    }
  }

  // Odkazy z HTML, které vypadají na kontaktní stránku (stejná doména).
  function findContactLinks(html, baseUrl) {
    const out = [];
    const seen = new Set();
    let base;
    try {
      base = new URL(baseUrl);
    } catch (_e) {
      return out;
    }
    for (const m of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#?]+)[^"']*["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
      const href = m[1].trim();
      const label = stripHtml(m[2]).toLowerCase();
      if (!/kontakt|contact|o-nas|o_nas|onas|about|impressum|provozovatel|pujcovna|půjčovna|rental|sluzby|služby|services/i.test(href + ' ' + label)) continue;
      let u;
      try {
        u = new URL(href, base);
      } catch (_e) {
        continue;
      }
      if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      if (!/^https?:$/.test(u.protocol)) continue;
      u.hash = '';
      const key = u.toString();
      if (seen.has(key) || key === base.toString()) continue;
      seen.add(key);
      out.push(key);
      if (out.length >= 4) break;
    }
    return out;
  }

  return {
    stripHtml,
    decodeEntities,
    extractEmails,
    extractPhones,
    normalizePhone,
    extractIco,
    validIco,
    extractOperator,
    detectRental,
    normalizeWebsite,
    isSocialUrl,
    hostOf,
    findContactLinks,
  };
});
