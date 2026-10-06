'use strict';
// Feature „home“ – domovská stránka (SPEC kap. 8): hero, 3 USP, karty typů kol z bike_types (prázdná tabulka → notice),
// „Jak to funguje“ 1-2-3, teaser mapy a výletů (statický text + odkazy /mapa a /okoli), kontakt + otevírací doba,
// JSON-LD LocalBusiness. Cena „od … Kč/den“ = nejnižší price_rules.unit='day' mimo sezónu (season_id IS NULL).
// Vstup: ctx. Výstup: vyrenderovaná stránka. Fotky: hero použije /img/demo/<tema>/hero.jpg, pokud soubor existuje.

const fs = require('node:fs');
const path = require('node:path');
const { parseJson } = require('../db');
const { publicBaseUrl } = require('../tenants');
const { localBusinessJsonLd } = require('../render/layout');
const page = require('../render/pages/home');

const heroImageCache = new Map();

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
  ctx.render(
    page.home,
    { tenant: ctx.tenant, types, settings: ctx.settings, heroImage: heroImage(ctx.config.publicDir, ctx.theme), theme: ctx.theme },
    {
      title: '',
      description: ctx.tenant.texts.heroText,
      jsonLd: localBusinessJsonLd(ctx.tenant, baseUrl),
      canonicalPath: '/',
      feature: 'home',
      bodyClass: 'page-home',
    }
  );
}

module.exports = {
  name: 'home',
  routes: [['GET', '/', homeHandler, { rateLimit: 'public' }]],
  nav: [],
  css: ['/css/home.css'],
  js: [],
  listBikeTypes,
  heroImage,
};
