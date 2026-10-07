// Kontakty – vytažení e-mailů, telefonů, IČO, provozovatele a zmínek o půjčovně z textu webu;
// normalizace telefonů a URL. UMD: v prohlížeči `MP.contacts`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.contacts = factory(); }
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
  const EMAIL_JUNK = /(example\.|sentry|wixpress|bytedance|spider|crawler|googlebot|@godaddy|@domena\.|@vasedomena|@firma\.cz$|@mojedomena|^(?:info|kontakt)@(?:email|domena|firma)\.|\.png$|\.jpe?g$|\.gif$|\.svg$|\.webp$|@2x|@3x|^[a-f0-9]{16,}@|domain\.|email\.cz$|^info@email|@mail\.(ru)$|^noreply|^no-reply|schema\.org|w3\.org|^[^@]*@[^@]*\.(js|css|html?)$|^user@|^name@|^jmeno@|^vas@|^vasemail@|^email@|^test@|^mail@mail)/i;

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

  // Zástupná čísla ze šablon webů („123 456 789“, „777 777 777“) nejsou kontakt.
  function zastupneCislo(n9) {
    return /^(\d)\1{8}$/.test(n9) || /^(123456789|987654321|111222333|123123123|600000000|700000000|777123456)$/.test(n9);
  }

  // Telefon → „+420 123 456 789“ (CZ) / „+421 …“ (SK); jinak null. Bere 9místná čísla CZ/SK i mezinárodní tvar.
  function normalizePhone(raw) {
    if (!raw) return null;
    let s = String(raw).replace(/^tel:/i, '').replace(/[^\d+]/g, '');
    if (!s) return null;
    if (s.startsWith('00')) s = '+' + s.slice(2);
    if (/^\+?42[01]\d{9}$/.test(s) && zastupneCislo(s.slice(-9))) return null;
    if (/^\d{9}$/.test(s) && zastupneCislo(s)) return null;
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

  // --- Služby prodejen kol podle textu webu (mapa prodejen) ---------------------------------------------------
  const SERVIS_RE = /(cykloservis\w*|servis\w*\s+(?:jízdních\s+|jizdnich\s+|elektro)?(?:kol|bike|elektrokol)\w*|(?:oprav\w*|seřízení|serizeni|údržb\w*|udrzb\w*|montáž\w*|montaz\w*)\s+(?:jízdních\s+|jizdnich\s+|vašeho\s+|vaseho\s+)?(?:kol|bike|elektrokol)\w*|(?:kol|bike|elektrokol)\w*\s+servis\w*|bike\s?service|fahrradwerkstatt|werkstatt|servisní\s+prohlídk\w*|servisni\s+prohlidk\w*|záruční\s+prohlídk\w*|zarucni\s+prohlidk\w*|centrování|centrovani|výplet\w*|vyplet\w*)/i;
  const EKOLA_RE = /(elektrokol\w*|e-?bike\w*|e-?kol[ao]\b|ebik\w*|pedelec\w*|elektro\s?kol\w*|bosch\s+(?:ebike|performance|cx|active)|shimano\s+steps)/i;
  const BAZAR_RE = /(bazar\w*\s+kol|cyklobazar|použit\w*\s+kol|pouzit\w*\s+kol|second\s?hand|výkup\w*\s+kol|vykup\w*\s+kol|protiúčt\w*|protiuct\w*)/i;
  const ESHOP_RE = /(do\s+košíku|do\s+kosiku|vložit\s+do\s+košíku|přidat\s+do\s+košíku|nákupní\s+košík|nakupni\s+kosik|add\s+to\s+cart|e-?shop\b|internetový\s+obchod)/i;
  const PRODEJ_RE = /(prodej\w*\s+(?:jízdních\s+|jizdnich\s+|elektro)?(?:kol|bike|elektrokol)\w*|prodejn\w*\s+(?:jízdních\s+)?kol\w*|nová\s+kola|nova\s+kola|kola\s+skladem|horská\s+kola|horska\s+kola|silniční\s+kola|silnicni\s+kola|dětská\s+kola|detska\s+kola|trekingová\s+kola|gravel)/i;

  function ukazka(s, re) {
    const m = re.exec(s);
    if (!m) return null;
    const start = Math.max(0, m.index - 50);
    const end = Math.min(s.length, m.index + m[0].length + 60);
    return s.slice(start, end).replace(/\s+/g, ' ').trim();
  }

  // Co web prodejny nabízí: { servis, ekola, pujcovna, bazar, eshop, prodej, ukazky: { servis: '…', … } }.
  function detectSluzby(text, html) {
    const s = String(text || '');
    const res = {
      prodej: PRODEJ_RE.test(s),
      servis: SERVIS_RE.test(s),
      ekola: EKOLA_RE.test(s),
      pujcovna: RENTAL_KOLA.test(s),
      bazar: BAZAR_RE.test(s),
      eshop: ESHOP_RE.test(s) || /class=["'][^"']*(add-to-cart|addtocart|basket|kosik)/i.test(String(html || '')),
      ukazky: {},
    };
    for (const [k, re] of [['servis', SERVIS_RE], ['ekola', EKOLA_RE], ['pujcovna', RENTAL_KOLA], ['bazar', BAZAR_RE]]) {
      if (res[k]) res.ukazky[k] = ukazka(s, re);
    }
    return res;
  }

  // Značky kol a pohonů. Názvy, které jsou i běžnými slovy (Trek, Giant, Cube, Focus…), se hledají jen s velkým
  // písmenem / verzálkami a jako samostatné slovo, aby „trek“ v „trekingová“ nebo „focus“ v textu nebyla značka.
  const ZNACKY = [
    ['Specialized', /\bSpecialized\b|\bSPECIALIZED\b/], ['Trek', /\bTrek\b(?![- ]?(?:ing|king))|\bTREK\b/], ['Giant', /\bGiant\b|\bGIANT\b/], ['Liv', /\bLiv\s+(?:Cycling|bikes?)\b/i],
    ['Scott', /\bScott\b|\bSCOTT\b/], ['Cube', /\bCube\b|\bCUBE\b/], ['KTM', /\bKTM\b/], ['Merida', /\bMerida\b|\bMERIDA\b/],
    ['Author', /\bAuthor\b|\bAUTHOR\b/], ['Kellys', /\bKellys\b|\bKELLYS\b/], ['Superior', /\bSuperior\b|\bSUPERIOR\b/], ['Rock Machine', /\bRock\s?Machine\b|\bROCK\s?MACHINE\b/],
    ['Cannondale', /\bCannondale\b|\bCANNONDALE\b/], ['Santa Cruz', /\bSanta\s+Cruz\b|\bSANTA\s+CRUZ\b/], ['Focus', /\bFocus\s+(?:bikes?|kola|Jam|Thron|Sam|Izalco|Raven|Atlas)\b|\bFOCUS\b/], ['Cervélo', /\bCerv[ée]lo\b/i],
    ['Orbea', /\bOrbea\b|\bORBEA\b/], ['BMC', /\bBMC\b/], ['Bianchi', /\bBianchi\b|\bBIANCHI\b/], ['Pinarello', /\bPinarello\b/i], ['Wilier', /\bWilier\b/i],
    ['Lapierre', /\bLapierre\b/i], ['Ghost', /\bGhost\b|\bGHOST\b/], ['Haibike', /\bHaibike\b/i], ['Mondraker', /\bMondraker\b/i], ['Canyon', /\bCanyon\b|\bCANYON\b/],
    ['Kona', /\bKona\b|\bKONA\b/], ['Marin', /\bMarin\s+(?:bikes?|kola)\b|\bMARIN\b/], ['GT', /\bGT\s+(?:bicycles|bikes?|kola)\b/i], ['Norco', /\bNorco\b/i], ['Rocky Mountain', /\bRocky\s+Mountain\b/i],
    ['Yeti', /\bYeti\s+Cycles\b/i], ['Pivot', /\bPivot\s+Cycles\b/i], ['Commencal', /\bCommencal\b/i], ['Nukeproof', /\bNukeproof\b/i], ['Polygon', /\bPolygon\s+(?:bikes?|kola)\b/i],
    ['Dema', /\bDema\b|\bDEMA\b/], ['Leader Fox', /\bLeader\s?Fox\b/i], ['Apache', /\bApache\s+(?:kola|bikes?)\b/i], ['Kross', /\bKross\b|\bKROSS\b/], ['Romet', /\bRomet\b/i],
    ['CTM', /\bCTM\b/], ['4Ever', /\b4\s?Ever\b|\b4EVER\b/], ['Amulet', /\bAmulet\b|\bAMULET\b/], ['Crussis', /\bCrussis\b/i], ['Agogs', /\bAgogs\b/i],
    ['Bulls', /\bBulls\s+(?:bikes?|kola|e-?bike)\b|\bBULLS\b/], ['Stevens', /\bStevens\b|\bSTEVENS\b/], ['Kalkhoff', /\bKalkhoff\b/i], ['Winora', /\bWinora\b/i], ['Riese & Müller', /\bRiese\s*(?:&|und)\s*M[üu]ller\b/i],
    ['Gazelle', /\bGazelle\b/], ['Batavus', /\bBatavus\b/i], ['Woom', /\bwoom\b/i], ['Early Rider', /\bEarly\s?Rider\b/i], ['Academy', /\bAcademy\s+(?:Grade|kola|bikes?)\b/i],
    ['Kubikes', /\bKubikes\b/i], ['Felt', /\bFelt\s+(?:bicycles|bikes?|kola)\b/i], ['Ridley', /\bRidley\b/i], ['Look', /\bLOOK\s+(?:Cycle|bikes?)\b/i], ['Colnago', /\bColnago\b/i],
    ['Moustache', /\bMoustache\s+(?:bikes?|Samedi|Friday|Dimanche|Lundi)\b/i], ['Lectric', /\bLectric\b/i], ['Head', /\bHEAD\s+(?:bikes?|kola)\b/i], ['Sinus', /\bSinus\s+(?:elektrokola|e-?bike|kola)\b/i], ['Lovelec', /\bLovelec\b/i],
    ['Bosch eBike', /\bBosch\s+(?:e-?Bike|Performance|Active\s+Line|CX)\b/i], ['Shimano STEPS', /\bShimano\s+(?:STEPS|EP\d)/i], ['Brose', /\bBrose\b/i], ['Bafang', /\bBafang\b/i], ['Yamaha', /\bYamaha\s+(?:PW|e-?bike|pohon)/i],
  ];

  function detectZnacky(text) {
    const s = String(text || '');
    const out = [];
    for (const [name, re] of ZNACKY) if (re.test(s)) out.push(name);
    return out;
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

  // Podstránky webu prodejny, které stojí za přečtení: kontakt (IČO, e-mail), servis, o nás / značky.
  // Vrací nejvýše `max` odkazů v pořadí kontakt → servis → o nás (stejná doména).
  function findInfoLinks(html, baseUrl, max) {
    let base;
    try {
      base = new URL(baseUrl);
    } catch (_e) {
      return [];
    }
    const kat = { kontakt: null, servis: null, onas: null };
    const RE = {
      kontakt: /kontakt|contact|impressum|provozovatel|obchodni-podminky|obchodní podmínky|vop\b/i,
      servis: /servis|service|opravy|dilna|dílna|werkstatt/i,
      onas: /o-nas|o_nas|onas|o nás|about|o-firme|o firmě|znacky|značky|brands|prodejna|kamenna|kamenná/i,
    };
    for (const m of String(html || '').matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)[^"']*["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
      const href = m[1].trim();
      const label = stripHtml(m[2]).toLowerCase();
      let u;
      try {
        u = new URL(href, base);
      } catch (_e) {
        continue;
      }
      if (!/^https?:$/.test(u.protocol) || u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      if (/\.(pdf|jpe?g|png|gif|zip|docx?|xlsx?)$/i.test(u.pathname)) continue;
      u.hash = '';
      const key = u.toString();
      if (key === base.toString()) continue;
      for (const k of Object.keys(kat)) {
        if (!kat[k] && RE[k].test(href + ' ' + label)) {
          kat[k] = key;
          break;
        }
      }
    }
    return [...new Set(Object.values(kat).filter(Boolean))].slice(0, max || 3);
  }

  return {
    findInfoLinks,
    stripHtml,
    decodeEntities,
    extractEmails,
    extractPhones,
    normalizePhone,
    extractIco,
    validIco,
    extractOperator,
    detectRental,
    detectSluzby,
    detectZnacky,
    ZNACKY: ZNACKY.map((z) => z[0]),
    normalizeWebsite,
    isSocialUrl,
    hostOf,
    findContactLinks,
  };
});
