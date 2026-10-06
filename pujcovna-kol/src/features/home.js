'use strict';
// Feature „home“ – domovská stránka (SPEC kap. 8): hero, 3 USP, karty typů kol z bike_types (prázdná tabulka → notice),
// „Jak to funguje“ 1-2-3, teaser mapy a výletů (statický text + odkazy /mapa a /okoli), kontakt + otevírací doba,
// JSON-LD LocalBusiness. Cena „od … Kč/den“ = nejnižší price_rules.unit='day' mimo sezónu (season_id IS NULL).
// Vstup: ctx. Výstup: vyrenderovaná stránka. Fotky: hero použije /img/demo/<tema>/hero.jpg, pokud soubor existuje;
// alt text fotky je per téma (THEMES.<tema>.heroAlt v src/themes.js). Texty (heroTitle, heroText, about) = tenant.texts
// přepsané settings.texts z adminu (layout.siteTexts). Otevírací doba (karta „Kde nás najdete“ i JSON-LD) = efektivní
// doba z adminu (layout.siteOpeningHours; null = zavřeno), stejná jako v kalendáři rezervací.
// Dále GET /fotografie – stránka „Fotografie: autoři a licence“: licence CC BY vyžaduje uvedení autora a licence na
// dostupném místě, proto se tabulky z public/img/demo/*/ATTRIBUTION.md (témata, kola) parsují a vypisují s náhledy;
// odkaz je v patičce každé stránky (layout.PHOTO_CREDITS_PATH). Výsledek se cachuje podle mtime souborů.

const fs = require('node:fs');
const path = require('node:path');
const { parseJson } = require('../db');
const { publicBaseUrl } = require('../tenants');
const { getTheme, THEMES } = require('../themes');
const { localBusinessJsonLd, siteTexts, siteOpeningHours, PHOTO_CREDITS_PATH } = require('../render/layout');
const page = require('../render/pages/home');

const heroImageCache = new Map();

// ---------------------------------------------------------------------------------------------------------
// Attribution fotografií (public/img/demo/<slozka>/ATTRIBUTION.md)

const CREDITS_DIR = '/img/demo';
/** Názvy skupin podle složky; témata z THEMES, ostatní složky s velkým písmenem. */
const GROUP_LABELS = { kola: 'Fotografie kol (katalog)' };
const COLUMN_KEYS = [
  ['soubor', 'file'],
  ['puvodni', 'original'],
  ['nazev', 'title'],
  ['popis', 'title'],
  ['autor', 'author'],
  ['licence', 'license'],
  ['zdroj', 'source'],
];

function stripDiacritics(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Záhlaví tabulky → klíč záznamu (file, original, title, author, license, source) nebo null. */
function columnKey(header) {
  const h = stripDiacritics(header);
  if (h.startsWith('puvodni')) return 'original';
  for (const [needle, key] of COLUMN_KEYS) if (h.includes(needle)) return key;
  return null;
}

/** „[CC BY 2.0](https://…) (poznámka)“ → { name, url, note }. */
function parseLicense(cell) {
  const m = /\[([^\]]+)\]\(([^)\s]+)\)\s*(.*)$/.exec(String(cell || '').trim());
  if (m) return { name: m[1].trim(), url: m[2], note: m[3].replace(/^\(|\)$/g, '').trim() || null };
  const plain = String(cell || '').trim();
  return plain ? { name: plain, url: null, note: null } : null;
}

/** Prvni URL v buňce (např. „https://commons… (Flickr: https://…)“). */
function firstUrl(cell) {
  const m = /https?:\/\/[^\s<>|]+/.exec(String(cell || ''));
  return m ? m[0] : null;
}

/**
 * Rozparsuje markdown tabulky v ATTRIBUTION.md na záznamy { file, original, title, author, license: { name, url, note }, source }.
 * Řádky bez souboru nebo autora/licence se vynechají (sekce „Ilustrace (vlastní dílo)“ tabulku nemá).
 */
function parseAttributionMd(text) {
  const out = [];
  let header = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = t
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((s) => s.trim());
    if (!header) {
      header = cells.map(columnKey);
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;
    const row = {};
    header.forEach((key, i) => {
      if (key && cells[i] !== undefined && row[key] === undefined) row[key] = cells[i];
    });
    const file = String(row.file || '').replace(/`/g, '').trim();
    if (!file || !/\.(jpe?g|png|webp|avif|svg)$/i.test(file)) continue;
    const license = parseLicense(row.license);
    if (!row.author && !license) continue;
    out.push({ file, original: row.original || '', title: row.title || row.original || file, author: String(row.author || '').trim(), license, source: firstUrl(row.source) });
  }
  return out;
}

const creditsCache = new Map();
/**
 * Skupiny fotografií pro stránku /fotografie: [{ dir, label, src (URL složky), items[] }], cache podle mtime souborů.
 * Prohledává public/img/demo/<slozka>/ATTRIBUTION.md; témata jdou první v pořadí THEMES, ostatní složky abecedně.
 */
function loadPhotoCredits(publicDir) {
  const root = path.join(publicDir, CREDITS_DIR);
  let dirs = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const themeNames = Object.keys(THEMES);
  dirs.sort((a, b) => {
    const ia = themeNames.indexOf(a);
    const ib = themeNames.indexOf(b);
    if (ia >= 0 || ib >= 0) return (ia >= 0 ? ia : 99) - (ib >= 0 ? ib : 99) || a.localeCompare(b, 'cs');
    return a.localeCompare(b, 'cs');
  });
  const groups = [];
  for (const dir of dirs) {
    const file = path.join(root, dir, 'ATTRIBUTION.md');
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const cached = creditsCache.get(file);
    let items;
    if (cached && cached.mtimeMs === stat.mtimeMs) items = cached.items;
    else {
      items = parseAttributionMd(fs.readFileSync(file, 'utf8')).filter((it) => fs.existsSync(path.join(root, dir, it.file)));
      creditsCache.set(file, { mtimeMs: stat.mtimeMs, items });
    }
    if (!items.length) continue;
    const theme = THEMES[dir];
    groups.push({ dir, label: theme ? `Design ${theme.label}` : GROUP_LABELS[dir] || dir.charAt(0).toUpperCase() + dir.slice(1), src: `${CREDITS_DIR}/${dir}`, items });
  }
  return groups;
}

async function fotografieHandler(ctx) {
  ctx.render(
    page.fotografie,
    { tenant: ctx.tenant, groups: loadPhotoCredits(ctx.config.publicDir), theme: ctx.theme },
    { title: 'Fotografie: autoři a licence', description: `Autoři a licence fotografií použitých na webu ${ctx.tenant.name} (Wikimedia Commons, CC0 / CC BY).`, feature: 'home', canonicalPath: PHOTO_CREDITS_PATH }
  );
}

/** Cesta k hero fotce tématu (jen pokud existuje v public/). */
function heroImage(publicDir, theme) {
  const key = `${publicDir}|${theme}`;
  if (heroImageCache.has(key)) return heroImageCache.get(key);
  let found = null;
  for (const ext of ['jpg', 'webp', 'avif', 'png']) {
    const rel = `/img/demo/${theme}/hero.${ext}`;
    if (fs.existsSync(path.join(publicDir, rel))) {
      found = rel;
      break;
    }
  }
  heroImageCache.set(key, found);
  return found;
}

/** Aktivní typy kol s cenou „od“ za den (haléře) nebo null. */
function listBikeTypes(db) {
  const rows = db
    .prepare(
      `SELECT t.*, (SELECT MIN(p.price_minor) FROM price_rules p WHERE p.bike_type_id = t.id AND p.unit = 'day' AND p.season_id IS NULL) AS from_price_minor
       FROM bike_types t WHERE t.active = 1 ORDER BY t.sort, t.name`
    )
    .all();
  return rows.map((r) => ({ ...r, sizes: parseJson(r.sizes, []), photos: parseJson(r.photos, []), specs: parseJson(r.specs, {}) }));
}

async function homeHandler(ctx) {
  const types = listBikeTypes(ctx.db);
  const baseUrl = publicBaseUrl(ctx.tenant, { host: ctx.req.headers.host, secure: ctx.secure });
  const texts = siteTexts(ctx);
  const openingHours = siteOpeningHours(ctx);
  ctx.render(
    page.home,
    { tenant: ctx.tenant, texts, openingHours, types, settings: ctx.settings, heroImage: heroImage(ctx.config.publicDir, ctx.theme), heroAlt: getTheme(ctx.theme).heroAlt || '', theme: ctx.theme },
    {
      title: '',
      description: texts.heroText,
      jsonLd: localBusinessJsonLd(ctx.tenant, baseUrl, openingHours),
      canonicalPath: '/',
      feature: 'home',
      bodyClass: 'page-home',
    }
  );
}

module.exports = {
  name: 'home',
  routes: [
    ['GET', '/', homeHandler, { rateLimit: 'public' }],
    ['GET', PHOTO_CREDITS_PATH, fotografieHandler, { rateLimit: 'public' }],
  ],
  nav: [],
  css: ['/css/home.css'],
  js: [],
  listBikeTypes,
  heroImage,
  parseAttributionMd,
  loadPhotoCredits,
};
