'use strict';
// Layout stránky (SPEC kap. 6): <!doctype html><html lang="cs" data-theme data-hero data-nav data-cards>, <head>
// (title „Stránka · Název půjčovny“, description, viewport, styly base + fonty + téma + feature, preload fontů, favicon,
// canonical, JSON-LD), <body>: skip-link, <header class="site-header"> (logo, <nav class="site-nav"> z nav všech
// features, CTA „Rezervovat“), <main id="obsah">, <footer class="site-footer"> (kontakt, otevírací doba, odkazy,
// attribution map, verze), v demo režimu <aside class="design-switch">.
// Vstup: ctx + { title, description, body, feature, jsonLd, canonicalPath, noindex, bodyClass }. Výstup: string HTML.

const fs = require('node:fs');
const path = require('node:path');
const { html, raw, attr, joinHtml } = require('./html');
const { contactCard } = require('./components');
const { THEMES, getTheme } = require('../themes');
const { publicBaseUrl } = require('../tenants');
const { assetUrl } = require('../http/static');

const FONT_SLUGS = {
  Fraunces: 'fraunces',
  Inter: 'inter',
  Caveat: 'caveat',
  'Barlow Condensed': 'barlow-condensed',
  'Space Grotesk': 'space-grotesk',
  Nunito: 'nunito',
  'Bricolage Grotesque': 'bricolage-grotesque',
};

const FOOTER_LINKS = [
  { label: 'Podmínky', href: '/podminky' },
  { label: 'Ochrana osobních údajů', href: '/soukromi' },
  { label: 'Reklamace', href: '/reklamace' },
  { label: 'Kontakt', href: '/kontakt' },
];

const preloadCache = new Map();
/** Soubory k preloadu pro téma: normální řez display a body fontu, latin podmnožina (existují-li). */
function fontPreloads(publicDir, themeName) {
  if (preloadCache.has(themeName)) return preloadCache.get(themeName);
  const theme = getTheme(themeName);
  const out = [];
  for (const family of [theme.fonts.display, theme.fonts.body]) {
    const slug = FONT_SLUGS[family];
    if (!slug) continue;
    try {
      const files = fs.readdirSync(path.join(publicDir, 'fonts', slug));
      const f = files.find((x) => x.includes('-normal-') && x.endsWith('-latin.woff2'));
      if (f) out.push(`/fonts/${slug}/${f}`);
    } catch {
      /* fonty nestaženy → bez preloadu */
    }
  }
  preloadCache.set(themeName, out);
  return out;
}

function navItems(ctx) {
  const items = (ctx.app && ctx.app.nav) || [];
  const current = ctx.url.pathname;
  return items.map((it) => ({ ...it, active: it.href === '/' ? current === '/' : current === it.href || current.startsWith(it.href + '/') }));
}

/** Přepínač designů (jen demo). */
function designSwitch(ctx) {
  const back = ctx.url.pathname + (ctx.url.search || '');
  return html`<aside class="design-switch" aria-label="Přepínač designů (demo)">
  <p class="design-switch__label">Design:</p>
  <ul class="design-switch__list">${Object.entries(THEMES).map(
    ([name, t]) =>
      html`<li><a class="${name === ctx.theme ? 'design-switch__link is-active' : 'design-switch__link'}" href="/design/nastavit?design=${name}&amp;zpet=${encodeURIComponent(back)}"${attr({ 'aria-current': name === ctx.theme ? 'true' : null, title: t.hint })}>${t.label}</a></li>`
  )}</ul>
  <a class="design-switch__more" href="/design">O designech</a>
</aside>`;
}

/**
 * Vyrenderuje celou stránku.
 * @param {object} ctx
 * @param {{title?: string, description?: string, body: any, feature?: string, jsonLd?: object|null, canonicalPath?: string, noindex?: boolean, bodyClass?: string}} page
 */
function layout(ctx, page) {
  const { tenant, config } = ctx;
  const themeName = ctx.theme;
  const theme = getTheme(themeName);
  const feature = page.feature && ctx.app && ctx.app.features ? ctx.app.features[page.feature] : null;
  const asset = (p) => assetUrl(p, { publicDir: config.publicDir, version: config.version });
  const fullTitle = page.title ? `${page.title} · ${tenant.name}` : `${tenant.name} – ${tenant.brand.claim || 'půjčovna kol'}`;
  const description = page.description || tenant.texts.heroText || tenant.texts.about || tenant.name;
  const canonical = publicBaseUrl(tenant, { host: ctx.req.headers.host, secure: ctx.secure }) + (page.canonicalPath || ctx.url.pathname);
  const logo = (tenant.brand && tenant.brand.logo) || '/tenant/logo.svg';
  const nav = navItems(ctx);
  const cta = nav.find((n) => n.cta) || { label: 'Rezervovat', href: '/rezervace' };
  const year = new Date().getFullYear();

  return (
    '<!doctype html>\n' +
    html`<html lang="cs" data-theme="${themeName}" data-hero="${theme.hero}" data-nav="${theme.nav}" data-cards="${theme.cards}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${fullTitle}</title>
<meta name="description" content="${description}">
${page.noindex ? html`<meta name="robots" content="noindex">` : ''}
<link rel="canonical" href="${canonical}">
<link rel="icon" href="${logo}" type="image/svg+xml">
<meta name="theme-color" content="${THEME_COLORS[themeName] || '#2F5D3A'}">
${fontPreloads(config.publicDir, themeName).map((href) => html`<link rel="preload" href="${href}" as="font" type="font/woff2" crossorigin>`)}
<link rel="stylesheet" href="${asset('/fonts/fonts.css')}">
<link rel="stylesheet" href="${asset('/base.css')}">
<link rel="stylesheet" href="${asset(theme.css)}">
${feature && feature.css ? feature.css.map((href) => html`<link rel="stylesheet" href="${asset(href)}">`) : ''}
${feature && feature.js ? feature.js.map((src) => html`<script src="${asset(src)}" defer></script>`) : ''}
${page.jsonLd ? raw(`<script type="application/ld+json">${JSON.stringify(page.jsonLd).replace(/</g, '\\u003c')}</script>`) : ''}
</head>
<body${attr({ class: page.bodyClass || null })}>
<a class="skip-link" href="#obsah">Přejít k obsahu</a>
<header class="site-header">
  <div class="container site-header__inner">
    <a class="site-logo" href="/" aria-label="${tenant.name} – domů"><img class="site-logo__img" src="${logo}" alt="" width="160" height="40"><span class="site-logo__text">${tenant.name}</span></a>
    <input class="nav-toggle" type="checkbox" id="nav-toggle" aria-hidden="true">
    <label class="nav-toggle__label" for="nav-toggle"><span class="nav-toggle__bar"></span><span class="visually-hidden">Menu</span></label>
    <nav class="site-nav" aria-label="Hlavní navigace">
      <ul class="site-nav__list">${nav
        .filter((n) => !n.cta)
        .map((n) => html`<li class="site-nav__item"><a class="${n.active ? 'site-nav__link is-active' : 'site-nav__link'}" href="${n.href}"${attr({ 'aria-current': n.active ? 'page' : null })}>${n.label}</a></li>`)}</ul>
      <a class="btn btn--primary site-nav__cta" href="${cta.href}">${cta.label}</a>
    </nav>
  </div>
</header>
<main id="obsah" class="site-main" tabindex="-1">
${page.body}
</main>
<footer class="site-footer">
  <div class="container site-footer__grid">
    <div class="site-footer__col site-footer__about">
      <a class="site-logo site-logo--footer" href="/"><img class="site-logo__img" src="${logo}" alt="" width="160" height="40"><span class="site-logo__text">${tenant.name}</span></a>
      ${tenant.texts.about ? html`<p class="site-footer__about-text">${tenant.texts.about}</p>` : ''}
    </div>
    <div class="site-footer__col">${contactCard(tenant.business, tenant.openingHours, { title: 'Kontakt a otevírací doba' })}</div>
    <div class="site-footer__col">
      <h3 class="site-footer__title">Informace</h3>
      <ul class="site-footer__links">${FOOTER_LINKS.map((l) => html`<li><a href="${l.href}">${l.label}</a></li>`)}</ul>
    </div>
  </div>
  <div class="container site-footer__bottom">
    <p class="site-footer__legal">© ${year} ${tenant.business.legalName || tenant.name}. Mapové podklady © <a href="https://www.openstreetmap.org/copyright" rel="noopener">přispěvatelé OpenStreetMap</a>, <a href="https://www.cyclosm.org/" rel="noopener">CyclOSM</a>.${config.demo ? html` <span class="site-footer__demo">Demo verze – fiktivní půjčovna, žádné peníze se nepřevádějí.</span>` : ''}</p>
    <p class="site-footer__version">Verze ${config.version}</p>
  </div>
</footer>
${config.demo ? designSwitch(ctx) : ''}
</body>
</html>`.toString()
  );
}

const THEME_COLORS = { outdoor: '#2F5D3A', sport: '#0E0F12', family: '#0F766E' };

/** Veřejný pomocník: JSON-LD LocalBusiness z tenant.json (pro domovskou stránku). */
function localBusinessJsonLd(tenant, baseUrl) {
  const b = tenant.business || {};
  const days = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
  const hours = Object.entries(tenant.openingHours || {})
    .filter(([, v]) => Array.isArray(v) && v.length === 2)
    .map(([d, v]) => ({ '@type': 'OpeningHoursSpecification', dayOfWeek: days[d], opens: v[0], closes: v[1] }));
  const out = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: tenant.name,
    url: baseUrl,
    image: baseUrl + ((tenant.brand && tenant.brand.logo) || '/tenant/logo.svg'),
    telephone: b.phone || undefined,
    email: b.email || undefined,
    address: b.address ? { '@type': 'PostalAddress', streetAddress: b.address.split(',')[0].trim(), addressLocality: (b.address.split(',')[1] || '').replace(/^\s*\d{3}\s?\d{2}\s*/, '').trim(), postalCode: (/\b(\d{3}\s?\d{2})\b/.exec(b.address) || [])[1], addressCountry: 'CZ' } : undefined,
    geo: tenant.location ? { '@type': 'GeoCoordinates', latitude: tenant.location.lat, longitude: tenant.location.lon } : undefined,
    openingHoursSpecification: hours.length ? hours : undefined,
    priceRange: 'Kč',
  };
  return JSON.parse(JSON.stringify(out));
}

module.exports = { layout, localBusinessJsonLd, FOOTER_LINKS, fontPreloads, FONT_SLUGS, joinHtml };
