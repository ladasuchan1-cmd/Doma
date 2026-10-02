'use strict';
// Zdroj Cyklobazar – parsery nad reálnými (zkrácenými, anonymizovanými) vzorky a průchod proti falešnému webu
// (podvržený prohlížeč, žádná síť). Každá stažená adresa se kontroluje proti skutečnému robots.txt webu.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Module = require('node:module');

const cb = require('../src/sources/cyklobazar');
const { loadConfig, DEFAULT_SOURCES, ALL_SOURCES } = require('../src/config');
const { openDb } = require('../src/db');

// Pipeline s jednoduchými náhradami klasifikace a nacenění (testují se zvlášť) – jako v pipeline.test.js.
const stubs = {
  [path.join(__dirname, '..', 'src', 'classify')]: {
    CLASSIFIER_VERSION: 'test-1',
    classifyListing: () => ({ isBike: true, bikeType: 'mtb_hardtail', reason: 'test', features: {} }),
  },
  [path.join(__dirname, '..', 'src', 'pricing')]: { trainModel: () => ({ summary: { stub: true } }), priceAll: () => 0 },
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent && parent.filename && parent.filename.includes(`${path.sep}src${path.sep}pipeline.js`)) {
    const resolved = path.resolve(path.dirname(parent.filename), request);
    if (stubs[resolved]) return stubs[resolved];
  }
  return origLoad.apply(this, arguments);
};
const { runPipeline } = require('../src/pipeline');
Module._load = origLoad;

const FIX = path.join(__dirname, 'fixtures', 'cyklobazar');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const BASE = 'https://www.cyklobazar.cz';
const NOW = Date.parse('2026-10-02T14:00:00Z');
const H = 3600e3;
const SENTINEL = 'JMENO-PRODEJCE'; // jména prodejců ve vzorcích (nesmí se objevit ve výstupu)

// ---------------------------------------------------------------- robots.txt (skutečný soubor webu)

const ROBOTS = read('robots.txt')
  .split('\n')
  .map((l) => /^Disallow:\s*(\S+)/i.exec(l.trim()))
  .filter(Boolean)
  .map((m) => new RegExp(`^${m[1].split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}`));

function robotsAllows(url) {
  const u = new URL(url);
  return !ROBOTS.some((rx) => rx.test(u.pathname + u.search));
}

// ---------------------------------------------------------------- falešný web

const PRAGUE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
function pragueText(ms) {
  const p = Object.fromEntries(PRAGUE.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${Number(p.day)}. ${Number(p.month)}. ${p.year}, ${p.hour}:${p.minute}`;
}
const fmtCzk = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

function agoText(hours) {
  if (hours < 1) return `před ${Math.max(2, Math.round(hours * 60))} minutami`;
  if (hours < 1.5) return 'před hodinou';
  if (hours < 24) return `před ${Math.round(hours)} hodinami`;
  if (hours < 48) return 'včera';
  return `před ${Math.round(hours / 24)} dny`;
}

/** Položka výpisu ve stejné podobě jako na webu (podle vzorku list_horska-kola_p1.html). */
function renderItem(x) {
  const cls = x.pinned ? 'cb-offer cb-offer--is-pinned' : 'cb-offer';
  return `<li class="cb-offer-list__item"> <a href="/inzerat/${x.id}/kolo-${x.id.toLowerCase()}" class="${cls}" > <figure> <div class="cb-offer__photo"> <picture> <img src="/uploads/items/2026/9/30/1081647/250_foto-${x.id.toLowerCase()}_abc123.jpg" alt="${x.title}" loading="lazy" onerror="this.classList.add('img--error')"> </picture> </div> <div class="cb-offer__content"> <div class="cb-offer__header"> <h4> ${x.title} </h4> <small class="cb-time-ago" title="Vytvořeno ${pragueText(x.created)}"> <svg class="shape"> <use href="/dist/images/shapes.svg#time"></use> </svg> ${x.ago ?? agoText(x.ageH)} </small> </div> <div class="cb-offer__desc"> Popis inzerátu ${x.id}… </div> <div class="cb-offer__footer"> <strong class="cb-offer__price"> ${fmtCzk(x.price)}&nbsp;<small>Kč</small> </strong> <div class="text-right"> <span class="cb-tag cb-tag--small hidden"> ${x.sub || 'Pevná horská kola'} </span> <span class="cb-tag cb-tag--small cb-tag cb-tag--small cb-offer__tag-location"> ${x.city || 'Brno'} </span> ${x.brand ? `<span class="cb-tag cb-tag--small cb-offer__tag-brand"> ${x.brand} </span>` : ''} <span class="cb-tag cb-tag--small cb-tag cb-tag--small cb-offer__tag-user${x.profi ? ' cb-offer__tag-user--profi' : ''}"> ${SENTINEL} </span> </div> </div> </div> </figure> </a> </li>`;
}

const CAROUSEL = `<horizontal-products arrows="overlay"> <ul> <li> <a href="/inzerat/TopKarusel01/top-kolo" class="cb-offer cb-offer--compact cb-offer--vertical cb-offer--is-pinned" > <figure> <div class="cb-offer__content"> <h4> TOP kolo z karuselu </h4> <strong class="cb-offer__price"> 9 999&nbsp;<small>Kč</small> </strong> </div> </figure> </a> </li> </ul> </horizontal-products>`;

function renderList(catPath, page, lastPage, items) {
  const link = (p) => `${catPath}?vp-page=${p}`;
  const nums = [...new Set([1, page - 1, page, page + 1, lastPage].filter((p) => p >= 1 && p <= lastPage))].sort((a, b) => a - b);
  const pag = nums.map((p) => (p === page ? `<li class="paginator__item"> <span class="cb-btn cb-btn--current">${p}</span> </li>` : `<li class="paginator__item"> <a href="${p === 1 ? catPath : link(p)}" class="cb-btn">${p}</a> </li>`)).join(' ');
  const next = page < lastPage ? `<li class="paginator__item paginator__item--next"> <a href="${link(page + 1)}" class="cb-btn cb-btn--dark"> <span>Další</span> </a> </li>` : '<li class="paginator__item paginator__item--next"> </li>';
  return `<!DOCTYPE html> <html lang="cs-CZ"> <head> <meta charset="utf-8"> <title>Kola | Cyklobazar.cz</title> </head> <body> <div class="condition-filter"><div class="condition-filter__section"> Nalezeno inzerátů: ${fmtCzk(lastPage * 20)} </div></div> ${CAROUSEL} <ul class="cb-offer-list"> ${items.map(renderItem).join(' ')} </ul> <div id="snippet-vp-paginator"> ${page < lastPage ? `<link href="${link(page + 1)}" rel="next">` : ''} <ul class="paginator "> ${pag} ${next} </ul> </div> </body></html>`;
}

/** Stránka výpisu: n položek, stáří posunu od ageFrom (h) po krocích step (h). */
function pageItems(prefix, n, { ageFrom, step = 0.5, now = NOW, createdAgo = null, price = 15000, pinned = [] } = {}) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ageH = ageFrom + i * step;
    out.push({
      id: `${prefix}i${String(i).padStart(2, '0')}xyz`,
      title: `Kolo ${prefix} ${i}`,
      price: price + i,
      ageH,
      created: now - (createdAgo != null ? createdAgo : ageH) * H,
      pinned: pinned.includes(i),
      brand: i % 2 ? 'Scott' : null,
      profi: i % 3 === 0,
    });
  }
  return out;
}

function renderSitemap(entries) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries
    .map((e) => `    <url>\n        <loc>${BASE}/inzerat/${e.id}/kolo-${e.id.toLowerCase()}</loc>\n        <lastmod>${new Date(e.lastmod ?? NOW - 5 * H).toISOString().replace('.000Z', '+00:00')}</lastmod>\n        <changefreq>weekly</changefreq>\n        <priority>1</priority>\n    </url>`)
    .join('\n')}\n</urlset>\n`;
}

const fillers = (n) => Array.from({ length: n }, (_, i) => ({ id: `Fill${String(i).padStart(6, '0')}` }));

/** Falešný prohlížeč: odpovědi podle adresy (objekt nebo funkce), zaznamená každý požadavek. */
function fakeSite(routes) {
  const requests = [];
  const browser = {
    async fetchHtml(url, o = {}) {
      requests.push({ url, ...o });
      const r = typeof routes === 'function' ? routes(url) : routes[url];
      if (!r) return { status: 404, html: '<html><title>Stránka nenalezena</title></html>', challenged: false, url };
      if (typeof r === 'string') return { status: 200, html: r, challenged: false, url };
      return { status: 200, challenged: false, url, ...r };
    },
  };
  return { browser, requests, urls: () => requests.map((r) => r.url) };
}

function makeCtx({ site, mode = 'full', db = new Map(), cache = new Map(), now = () => NOW, config = {}, maxPages = 400, minPrice = 200, getBrowser } = {}) {
  const emitted = [];
  const seen = [];
  const logs = [];
  const log = {
    info: (m, x) => logs.push(['info', m, x]),
    warn: (m, x) => logs.push(['warn', m, x]),
    debug: (m, x) => logs.push(['debug', m, x]),
  };
  return {
    mode,
    maxPages,
    minPrice,
    log,
    now,
    config: { cyklobazarDelayMs: 20000, cyklobazarMaxListPages: 60, ...config },
    getBrowser: getBrowser || (async () => site.browser),
    cache: {
      get: (k) => (cache.has(k) ? JSON.parse(cache.get(k)) : undefined),
      set: (k, v) => cache.set(k, JSON.stringify(v ?? null)),
      delete: (k) => cache.delete(k),
    },
    isKnown: (id) => db.get(String(id)) || null,
    markSeen: (id, o = {}) => {
      if (!db.has(String(id))) return false;
      seen.push([String(id), !!o.refreshDetail]);
      return true;
    },
    emit: async (item) => {
      const isNew = !db.has(item.sourceId);
      if (isNew) db.set(item.sourceId, { id: db.size + 1, price_czk: item.priceCzk ?? null, title: item.title, detail_at: null, gone_at: null });
      emitted.push(item);
      return { isNew, changed: isNew };
    },
    _emitted: emitted,
    _seen: seen,
    _logs: logs,
    _cache: cache,
    _db: db,
  };
}

/** Společné kontroly šetrnosti: robots.txt, pauza, nic osobního. */
function assertPolite(site) {
  for (const r of site.requests) {
    assert.ok(robotsAllows(r.url), `robots.txt zakazuje ${r.url}`);
    assert.ok(r.url.startsWith(`${BASE}/`), `mimo web: ${r.url}`);
    assert.ok(!/\/u\/|[?&]do=/.test(r.url), `osobní údaje / akce: ${r.url}`);
    assert.ok(r.minIntervalMs >= 10000, `pauza ${r.minIntervalMs} ms`);
  }
}

// ---------------------------------------------------------------- metadata, konfigurace, robots

test('zdroj: metadata, na vyžádání (ne ve výchozích zdrojích), konfigurace pauzy a limitu', () => {
  assert.equal(cb.key, 'cyklobazar');
  assert.equal(cb.label, 'Cyklobazar');
  assert.equal(cb.homepage, 'https://www.cyklobazar.cz');
  assert.equal(cb.requiresBrowser, true);
  assert.equal(cb.defaultMaxDetails, 120);
  assert.equal(typeof cb.confirmGone, 'function');
  assert.ok(ALL_SOURCES.includes('cyklobazar'));
  assert.ok(!DEFAULT_SOURCES.includes('cyklobazar'));
  const c = loadConfig({});
  assert.equal(c.cyklobazarDelayMs, 20000);
  assert.equal(c.cyklobazarMaxListPages, 60);
  assert.equal(loadConfig({ KOLOMAPA_CYKLOBAZAR_DELAY_MS: '3000' }).cyklobazarDelayMs, 10000);
  assert.equal(loadConfig({ KOLOMAPA_CYKLOBAZAR_DELAY_MS: '45000' }).cyklobazarDelayMs, 45000);
  assert.equal(loadConfig({ KOLOMAPA_CYKLOBAZAR_MAX_LIST_PAGES: '0' }).cyklobazarMaxListPages, 0);
  assert.equal(loadConfig({ KOLOMAPA_CYKLOBAZAR_MAX_LIST_PAGES: 'x' }).cyklobazarMaxListPages, 60);
});

test('assertAllowed: jen cyklobazar.cz a nic, co zakazuje robots.txt (ani profily prodejců)', () => {
  for (const u of [`${BASE}/kola`, `${BASE}/kola?vp-page=12`, `${BASE}/elektrokola?vp-page=2`, cb.SITEMAP_URL, `${BASE}/inzerat/84OemEXXQ4paM/merida-matts-j-champion-26`]) {
    assert.equal(cb.assertAllowed(u), u);
    assert.ok(robotsAllows(u));
  }
  const bad = [
    `${BASE}/kola?sort=price`,
    `${BASE}/inzerat/84OemEXXQ4paM/merida?do=phoneNumber`,
    `${BASE}/inzerat/84OemEXXQ4paM/merida?x=1&do=aiDescription-generate`,
    `${BASE}/kola?condition=new`,
    `${BASE}/kola?type=buy`,
    `${BASE}/kola?type=sell`,
    `${BASE}/inzerat/84OemEXXQ4paM/merida/tisk`,
    `${BASE}/cdn-cgi/l/email-protection`,
    `${BASE}/sign/in`,
    `${BASE}/muj-ucet/`,
    `${BASE}/create/`,
    `${BASE}/lost-password/`,
    `${BASE}/u/MgoVglxK5Be5Y/prodejce`,
    'https://cyklobazar.cz/kola',
    'https://example.org/kola',
  ];
  for (const u of bad) assert.throws(() => cb.assertAllowed(u), /robots|mimo/, u);
  // každé pravidlo robots.txt zakazuje i assertAllowed
  for (const u of bad.slice(0, 12)) assert.equal(robotsAllows(u) && !/\?x=1&do=/.test(u), false, u);
});

// ---------------------------------------------------------------- parsery: výpis

test('výpis (horská kola): 20 položek, TOP karusel přeskočen, normalizovaná položka bez jména prodejce', () => {
  const html = read('list_horska-kola_p1.html');
  const p = cb.parseListPage(html, cb.CATEGORIES[0]);
  assert.equal(p.ok, true);
  assert.equal(p.items.length, 20);
  assert.equal(p.items.filter((x) => x.pinned).length, 0);
  assert.equal(p.total, 3253);
  assert.equal(p.page, 1);
  assert.equal(p.lastPage, 163);
  assert.equal(p.hasNext, true);
  const ids = p.items.map((x) => x.item.sourceId);
  assert.ok(!ids.includes('G3DRGEeey324X')); // jen v TOP karuselu
  assert.equal(new Set(ids).size, 20);
  assert.deepEqual(p.items[0].item, {
    sourceId: 'XwxG7pjj6wMj3',
    url: `${BASE}/inzerat/XwxG7pjj6wMj3/novy-whyte-sythe-27-ember-detske-juniorske-celoodpruzene-enduro-kolo-pro-vysku-137-155cm`,
    title: '!!!NOVÝ!!! Whyte Sythe 27 Ember - Dětské/juniorské celoodpružené enduro kolo, pro výšku 137 - 155cm',
    priceCzk: 54999,
    priceNote: null,
    categorySrc: 'Jízdní kola › Enduro kola',
    locationText: 'Šumperk',
    sellerType: 'company',
    detailComplete: false,
    postedAt: '2026-10-01T11:46:00.000Z', // „Vytvořeno 1. 10. 2026, 13:46“ (CEST)
    description: p.items[0].item.description,
    params: { Výrobce: 'Whyte' },
    photoUrl: `${BASE}/uploads/items/2026/10/1/1081969/800_img-20260930-143855_c9840ab05.jpg`,
  });
  assert.match(p.items[0].item.description, /^Nové kolo s plnou zárukou .*…$/);
  assert.equal(p.items[0].ageText, 'před 3 minutami');
  // soukromý prodejce: jen příznak, jméno se nečte
  const priv = p.items.find((x) => x.item.sourceId === '84OemEXXQ4paM').item;
  assert.equal(priv.sellerType, 'private');
  assert.equal(priv.priceCzk, 12500);
  assert.equal(priv.locationText, 'Březí');
  assert.equal(priv.postedAt, '2026-10-02T13:31:00.000Z');
  assert.ok(html.includes(SENTINEL));
  assert.ok(!JSON.stringify(p.items).includes(SENTINEL));
  for (const x of p.items) {
    if (x.item.sourceId === 'jO8xDlzz6OMx6') assert.equal(x.item.photoCount, 0); // inzerát bez fotky
    else assert.match(x.item.photoUrl, /^https:\/\/www\.cyklobazar\.cz\/uploads\/items\/\d{4}\/\d+\/\d+\/\d+\/800_[^/]+\.jpg$/);
    assert.ok(x.age && x.age.low >= 0 && x.age.high <= 7 && x.age.low < x.age.high, x.ageText);
  }
});

test('výpis (dětská kola, elektrokola): topované položky v toku výpisu, štítky kategorií', () => {
  const d = cb.parseListPage(read('list_detska-kola_p1.html'), cb.CATEGORIES[0]);
  assert.equal(d.items.length, 20);
  assert.equal(d.items.filter((x) => x.pinned).length, 3);
  assert.equal(d.lastPage, 45);
  const kid = d.items.find((x) => x.item.sourceId === '0L8mxERR7LBo0').item;
  assert.equal(kid.categorySrc, 'Jízdní kola › Dětská kola 115-130 cm / 6-9 let');
  assert.equal(kid.locationText, 'Praha 9');
  assert.deepEqual(kid.params, { Výrobce: 'Rockrider' });
  const e = cb.parseListPage(read('list_elektrokola_p1.html'), cb.CATEGORIES[1]);
  assert.equal(e.items.length, 20);
  assert.equal(e.items.filter((x) => x.pinned).length, 2);
  assert.equal(e.items[0].item.categorySrc, 'Elektrokola › Celoodpružená/Enduro elektrokola');
  assert.equal(e.items[0].item.params, undefined); // bez výrobce ve výpisu
  assert.ok(!JSON.stringify([d.items, e.items]).includes(SENTINEL));
});

test('relativní čas posunu → dolní odhad stáří (h), cena, pražský čas → UTC, fotka 800 px', () => {
  assert.deepEqual(cb.ageRange('před chvílí'), { low: 0, high: 0.1 });
  assert.deepEqual(cb.ageRange('před minutou'), { low: 0, high: 0.1 });
  assert.deepEqual(cb.ageRange('před 31 minutami'), { low: 0.5, high: 32 / 60 });
  assert.deepEqual(cb.ageRange('před hodinou'), { low: 0.5, high: 1.6 });
  assert.deepEqual(cb.ageRange(' před  5 hodinami '), { low: 4, high: 6 });
  assert.deepEqual(cb.ageRange('včera'), { low: 23, high: 49 });
  assert.deepEqual(cb.ageRange('před 2 dny'), { low: 47, high: 61 });
  assert.deepEqual(cb.ageRange('před 3 dny'), { low: 59, high: 85 });
  assert.equal(cb.ageLowHours('před 2 měsíci'), 59 * 24);
  assert.equal(cb.ageLowHours('před rokem'), 364 * 24);
  assert.equal(cb.ageRange(''), null);
  assert.equal(cb.ageRange('1. 10. 2026'), null);

  assert.deepEqual(cb.parsePrice('54 999&nbsp;<small>Kč</small>'), { priceCzk: 54999, priceNote: null });
  assert.deepEqual(cb.parsePrice('1 200 €'), { priceCzk: null, priceNote: 'Cena v EUR: 1 200 €' });
  assert.deepEqual(cb.parsePrice('', 'EUR', 1200), { priceCzk: null, priceNote: 'Cena v EUR: 1 200 EUR' });
  assert.deepEqual(cb.parsePrice('12 500 Kč', 'CZK', 12500), { priceCzk: 12500, priceNote: null });
  assert.deepEqual(cb.parsePrice('Dohodou'), { priceCzk: null, priceNote: 'Dohodou' });
  assert.deepEqual(cb.parsePrice('0 Kč'), { priceCzk: null, priceNote: 'Cena neuvedena' });

  assert.equal(cb.pragueToIso('Vytvořeno 1. 1. 2026, 12:00'), '2026-01-01T11:00:00.000Z');
  assert.equal(cb.pragueToIso('1.7.2026, 12:00'), '2026-07-01T10:00:00.000Z');
  assert.equal(cb.pragueToIso('29. 3. 2026, 03:30'), '2026-03-29T01:30:00.000Z'); // první hodina letního času
  assert.equal(cb.pragueToIso('25. 10. 2026, 12:00'), '2026-10-25T11:00:00.000Z'); // po návratu zimního času
  assert.equal(cb.pragueToIso('2. 10. 2026'), '2026-10-01T22:00:00.000Z');
  assert.equal(cb.pragueToIso('nic'), null);

  assert.equal(cb.photo800('/uploads/items/2026/10/2/1082237/250_1000039155_5c3baec6a.jpg'), `${BASE}/uploads/items/2026/10/2/1082237/800_1000039155_5c3baec6a.jpg`);
  assert.equal(cb.photo800('https://www.cyklobazar.cz//uploads/items/2026/9/23/1079979/1680_x_1.webp'), `${BASE}/uploads/items/2026/9/23/1079979/800_x_1.webp`);
  assert.equal(cb.photo800('/dist/images/bankid/shield.svg'), null);
});

// ---------------------------------------------------------------- parsery: detail, sitemapa

test('detail (soukromý, hardtail): JSON-LD, parametry s přesnými popisky, stav, Vloženo/Editováno, obec + okres', () => {
  const html = read('detail_mtb_hardtail_private.html');
  const d = cb.parseDetail(html);
  assert.equal(d.ok, true);
  assert.equal(d.sourceId, '84OemEXXQ4paM');
  const it = d.item;
  assert.equal(it.url, `${BASE}/inzerat/84OemEXXQ4paM/merida-matts-j-champion-26`);
  assert.equal(it.title, 'Merida Matts J. Champion 26"');
  assert.match(it.description, /^Prodám kolo Merida Matts J\.Champion\.\nZakázkový lak Hasiči\./);
  assert.ok(!/AI|Souhrn|Charakteristika kola/.test(it.description)); // AI souhrn webu se nebere
  assert.equal(it.priceCzk, 12500);
  assert.equal(it.priceNote, null);
  assert.equal(it.postedAt, '2026-10-02T13:31:00.000Z');
  assert.equal(it.categorySrc, 'Jízdní kola › Horská kola (MTB) › Pevná horská kola - hardtail');
  assert.equal(it.locationText, 'Březí');
  assert.equal(it.okres, 'Břeclav');
  assert.equal(it.photoUrl, `${BASE}/uploads/items/2026/10/2/1082237/800_1000039155_5c3baec6a.jpg`);
  assert.equal(it.photoCount, 10);
  assert.equal(it.sellerType, 'private');
  assert.equal(it.detailComplete, true);
  assert.deepEqual(it.params, {
    Kategorie: 'Pevná horská kola - hardtail',
    Výrobce: 'Merida',
    Barva: 'Červená',
    Materiál: 'Alu - hliník',
    Velikost: 'S / 15-16" / do 44 cm / do 165 cm',
    'Průměr kol': '26"',
    'Rok výroby - model': '2021',
    Stav: 'Použité',
    Upraveno: '2.10.2026, 15:32',
  });
  assert.ok(html.includes(SENTINEL) && html.includes('/u/'));
  const out = JSON.stringify(d);
  assert.ok(!out.includes(SENTINEL));
  assert.ok(!out.includes('/u/'));
  assert.ok(!/phoneNumber|Tel\./.test(out));
});

test('detail (firma, vykreslené DOM s <tbody>), e-kolo bez výrobce, dětské kolo v Praze', () => {
  const c = cb.parseDetail(read('detail_mtb_trail_company.rendered.html')).item;
  assert.equal(c.sellerType, 'company');
  assert.equal(c.priceCzk, 49990);
  assert.equal(c.postedAt, '2026-09-23T12:05:00.000Z');
  assert.equal(c.params.Upraveno, '28.9.2026, 13:14');
  assert.equal(c.params.Zdvih, '130 - 150mm');
  assert.equal(c.params['Průměr kol'], '29"');
  assert.equal(c.params.Materiál, 'Karbon');
  assert.equal(c.params['Aktualice pozice'], undefined);
  assert.equal(c.photoCount, 20);
  assert.equal(c.categorySrc, 'Jízdní kola › Horská kola (MTB) › Celoodpružená kola › Trailová (allmoutain) kola');
  assert.equal(c.locationText, 'Uherské Hradiště');
  assert.equal(c.okres, 'Uherské Hradiště');
  assert.ok(!JSON.stringify(c).includes(SENTINEL));

  const e = cb.parseDetail(read('detail_ebike_fatbike.html')).item;
  assert.equal(e.categorySrc, 'Elektrokola › Fatbike elektrokola');
  assert.equal(e.params.Výrobce, undefined);
  assert.equal(e.params['Mimo kategorii kol'], undefined);
  assert.equal(e.priceCzk, 26000);
  assert.equal(e.photoCount, 4);
  assert.equal(e.okres, 'Litoměřice');

  const k = cb.parseDetail(read('detail_kids_20.html')).item;
  assert.equal(k.locationText, 'Praha 9');
  assert.equal(k.okres, 'Hlavní město Praha');
  assert.equal(k.params['Rok výroby'], '2025');
  assert.equal(k.params.Výrobce, 'Rockrider');
  assert.equal(k.categorySrc, 'Jízdní kola › Dětská kola › Dětská kola 20" / 115-130 cm / 6-9 let');
});

test('detail: mimo kategorie kol → „Mimo kategorii kol“ (ne null), cena v EUR, záloha bez JSON-LD, smazaný inzerát', () => {
  const base = read('detail_mtb_hardtail_private.html');
  const moved = base.replace('"name": "Jízdní kola"', '"name": "Komponenty"').replace(`"@id": "${BASE}/kola"`, `"@id": "${BASE}/komponenty"`);
  const m = cb.parseDetail(moved);
  assert.equal(m.ok, true);
  assert.equal(m.item.params['Mimo kategorii kol'], 'ano');
  assert.match(m.item.categorySrc, /^Komponenty › /);

  const eur = base.replace('"priceCurrency": "CZK"', '"priceCurrency": "EUR"').replace('"price": 12500', '"price": 520').replace('12 500&nbsp;<small>Kč</small>', '520&nbsp;<small>€</small>');
  const pe = cb.parseDetail(eur).item;
  assert.equal(pe.priceCzk, null);
  assert.equal(pe.priceNote, 'Cena v EUR: 520 €');

  const noLd = base.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  const n = cb.parseDetail(noLd);
  assert.equal(n.ok, true);
  assert.equal(n.item.title, 'Merida Matts J. Champion 26"');
  assert.equal(n.item.priceCzk, 12500);
  assert.match(n.item.description, /^Prodám kolo Merida Matts J\.Champion\.\nZakázkový lak/);
  assert.equal(n.item.categorySrc, undefined);

  const gone = cb.parseDetail('<html><head><title>Cyklobazar.cz</title></head><body><h1>Inzerát byl smazán</h1></body></html>');
  assert.deepEqual({ ok: gone.ok, gone: gone.gone }, { ok: false, gone: true });
  assert.equal(cb.parseDetail('<html><body>Něco jiného</body></html>').gone, false);
});

test('sitemapa: id, adresa a lastmod', () => {
  const sm = cb.parseSitemap(read('sitemap-ads.sample.xml'));
  assert.equal(sm.ok, true);
  assert.equal(sm.urls, 24);
  assert.equal(sm.entries.size, 24);
  assert.deepEqual(sm.entries.get('v1lx8kGGM1kzk'), { url: `${BASE}/inzerat/v1lx8kGGM1kzk/elite-nero`, lastmodMs: Date.parse('2026-10-02T14:58:47+02:00') });
  assert.equal(cb.parseSitemap('<html>nic</html>').ok, false);
});

// ---------------------------------------------------------------- průchod

/** Web s výpisem /kola (kolaPages stránek) a /elektrokola (1 stránka) a sitemapou. */
function siteWith({ kola, elektro, sitemapExtra = [], fill = 6000, challengeAt = null, status = {} }) {
  const routes = {};
  routes[cb.SITEMAP_URL] = renderSitemap([...fillers(fill), ...sitemapExtra, ...kola.flat(), ...elektro.flat()]);
  kola.forEach((items, i) => (routes[cb.listUrl(cb.CATEGORIES[0], i + 1)] = renderList('/kola', i + 1, kola.length, items)));
  elektro.forEach((items, i) => (routes[cb.listUrl(cb.CATEGORIES[1], i + 1)] = renderList('/elektrokola', i + 1, elektro.length, items)));
  return fakeSite((url) => {
    if (challengeAt && url === challengeAt) return { status: 403, html: '', challenged: true };
    if (status[url]) return { status: status[url], html: '' };
    return routes[url];
  });
}

test('první běh (full): sitemapa, pak výpis od začátku postupným průchodem; complete při zdravé sitemapě', async () => {
  const kola = [pageItems('Ka', 20, { ageFrom: 0.1 }), pageItems('Kb', 20, { ageFrom: 12 }), pageItems('Kc', 20, { ageFrom: 30, pinned: [2] })];
  const elektro = [pageItems('Ea', 15, { ageFrom: 1 })];
  const site = siteWith({ kola, elektro });
  const ctx = makeCtx({ site });
  const res = await cb.scan(ctx);
  assert.deepEqual(res, { complete: true });
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL, `${BASE}/kola`, `${BASE}/kola?vp-page=2`, `${BASE}/kola?vp-page=3`, `${BASE}/elektrokola`]);
  assertPolite(site);
  assert.ok(site.requests.every((r) => r.minIntervalMs === 20000));
  assert.equal(ctx._emitted.length, 75);
  assert.ok(!ctx._emitted.some((x) => x.sourceId === 'TopKarusel01'));
  assert.ok(!JSON.stringify(ctx._emitted).includes(SENTINEL));
  const e0 = ctx._emitted.find((x) => x.sourceId === 'Eai00xyz');
  assert.equal(e0.categorySrc, 'Elektrokola › Pevná horská kola');
  assert.equal(e0.detailComplete, false);
  assert.equal(ctx._cache.has('newHorizonAt'), true);
  assert.equal(JSON.parse(ctx._cache.get('newHorizonAt')), new Date(NOW).toISOString());
  assert.deepEqual(JSON.parse(ctx._cache.get('sweep')), { cat: 0, page: 1 }); // celý výpis prošel → znovu od začátku
  assert.ok(ctx._cache.has('sweepDoneAt'));
  assert.equal(JSON.parse(ctx._cache.get('sitemapCount')), 6075);
  assert.equal(JSON.parse(ctx._cache.get('newestPostedAt')), new Date(Math.floor((NOW - 0.1 * H) / 60000) * 60000).toISOString());
  // incremental mód nikdy complete nevrací
  const site2 = siteWith({ kola, elektro });
  assert.deepEqual(await cb.scan(makeCtx({ site: site2, mode: 'incremental' })), { complete: false });
});

test('novinky: projde stránky jen po obzor minulého průchodu (podle času posunu, topované nerozhodují)', async () => {
  const run1 = NOW - 24 * H;
  const kola = [
    pageItems('Ka', 20, { ageFrom: 0.1, step: 0.5 }), // 0–10 h
    pageItems('Kb', 20, { ageFrom: 11, step: 0.6 }), // 11–22 h
    pageItems('Kc', 20, { ageFrom: 23, step: 0.3, pinned: [19] }), // 23–28.7 h → přes obzor (24 h + 2 h rezerva) ještě ne celá
    pageItems('Kd', 20, { ageFrom: 30, step: 1 }), // celá za obzorem
    pageItems('Ke', 20, { ageFrom: 50, step: 1 }),
    pageItems('Kf', 20, { ageFrom: 70, step: 1 }),
  ];
  kola[3][0] = { ...kola[3][0], pinned: true, ageH: 0.2 }; // topovaná čerstvá položka stránku nezdrží
  const elektro = [pageItems('Ea', 20, { ageFrom: 40, step: 1 }), pageItems('Eb', 20, { ageFrom: 70, step: 1 })];
  // minulý běh viděl vše, co bylo posunuté před ním (stránky 3+ a elektrokola)
  const known = () => {
    const db = new Map();
    for (const p of [...kola.slice(2), ...elektro]) for (const x of p) db.set(x.id, { id: 1, price_czk: x.price, title: x.title, detail_at: null, gone_at: null });
    return db;
  };
  const horizon = () =>
    new Map([
      ['newHorizonAt', JSON.stringify(new Date(run1).toISOString())],
      ['sweep', JSON.stringify({ cat: 0, page: 40 })],
    ]);
  let site = siteWith({ kola, elektro });
  const cache = horizon();
  const ctx = makeCtx({ site, cache, db: known(), mode: 'incremental' });
  await cb.scan(ctx);
  // kola 3: „před 23 hodinami“ = možná po startu minulého běhu → dál; kola 4: „včera“ a známé → konec;
  // elektrokola 1: „včera“ / „před 2 dny“ a známé → konec
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL, `${BASE}/kola`, `${BASE}/kola?vp-page=2`, `${BASE}/kola?vp-page=3`, `${BASE}/kola?vp-page=4`, `${BASE}/elektrokola`]);
  assertPolite(site);
  assert.equal(JSON.parse(cache.get('newHorizonAt')), new Date(NOW).toISOString());
  assert.deepEqual(JSON.parse(cache.get('sweep')), { cat: 0, page: 40 }); // incremental průchod neposouvá
  // neznámý inzerát s nejistým časem („včera“) na stránce 4 → pokračovat (mohl přibýt těsně po startu minulého běhu)
  const db = known();
  db.delete('Kdi05xyz');
  site = siteWith({ kola, elektro });
  await cb.scan(makeCtx({ site, cache: horizon(), db, mode: 'incremental' }));
  assert.deepEqual(site.urls().slice(1, 7), [`${BASE}/kola`, `${BASE}/kola?vp-page=2`, `${BASE}/kola?vp-page=3`, `${BASE}/kola?vp-page=4`, `${BASE}/kola?vp-page=5`, `${BASE}/elektrokola`]);
  // stránky „před N dny“ jsou za obzorem i bez znalosti
  site = siteWith({ kola, elektro });
  await cb.scan(makeCtx({ site, cache: horizon(), mode: 'incremental' }));
  assert.deepEqual(site.urls().slice(1), [`${BASE}/kola`, `${BASE}/kola?vp-page=2`, `${BASE}/kola?vp-page=3`, `${BASE}/kola?vp-page=4`, `${BASE}/kola?vp-page=5`, `${BASE}/elektrokola`, `${BASE}/elektrokola?vp-page=2`]);
});

test('záloha bez čitelného času posunu: konec, když jsou všechny položky známé a starší než nejnovější vložení − 1 den', async () => {
  const mk = (prefix, createdAgoH) => pageItems(prefix, 20, { ageFrom: 1, createdAgo: createdAgoH }).map((x) => ({ ...x, ago: 'nedávno' }));
  const kola = [mk('Ka', 1), mk('Kb', 30), mk('Kc', 60), mk('Kd', 90)];
  const elektro = [mk('Ea', 50)];
  const db = new Map();
  for (const p of [...kola.slice(1), ...elektro]) for (const x of p) db.set(x.id, { id: 1, price_czk: x.price, title: x.title, detail_at: null, gone_at: null });
  const site = siteWith({ kola, elektro });
  const cache = new Map([['newestPostedAt', JSON.stringify(new Date(NOW - 2 * H).toISOString())]]);
  const ctx = makeCtx({ site, cache, db, mode: 'incremental' });
  await cb.scan(ctx);
  // stránka 2: známé, vložené před 30 h = víc než den před nejnovějším (před 2 h) → konec
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL, `${BASE}/kola`, `${BASE}/kola?vp-page=2`, `${BASE}/elektrokola`]);
});

test('limit stránek za běh: novinky, pak postupný průchod od uložené pozice (bez stránek, které už prošly novinky)', async () => {
  const kola = Array.from({ length: 12 }, (_, i) => pageItems(`K${String.fromCharCode(97 + i)}`, 20, { ageFrom: 50 + i * 20, step: 1 }));
  kola[0] = pageItems('Ka', 20, { ageFrom: 0.1, step: 0.5 }); // čerstvá 1. stránka
  const elektro = [pageItems('Ea', 20, { ageFrom: 50, step: 1 }), pageItems('Eb', 20, { ageFrom: 70, step: 1 })];
  const horizon = JSON.stringify(new Date(NOW - 24 * H).toISOString());
  // limit 2: jen novinky (kola 1 → čerstvá, kola 2 → za obzorem), na elektrokola už nezbude
  let site = siteWith({ kola, elektro });
  let cache = new Map([['newHorizonAt', horizon], ['sweep', JSON.stringify({ cat: 0, page: 2 })]]);
  await cb.scan(makeCtx({ site, cache, config: { cyklobazarMaxListPages: 2 } }));
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL, `${BASE}/kola`, `${BASE}/kola?vp-page=2`]);
  assert.ok(cache.has('newHorizonAt')); // obzor se posune i tak – zbytek dožene průchod
  // limit 6: novinky (kola 1–2, elektrokola 1), průchod od stránky 3 (2 už prošly novinky): 3, 4, 5
  site = siteWith({ kola, elektro });
  cache = new Map([['newHorizonAt', horizon], ['sweep', JSON.stringify({ cat: 0, page: 2 })]]);
  await cb.scan(makeCtx({ site, cache, config: { cyklobazarMaxListPages: 6 } }));
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL, `${BASE}/kola`, `${BASE}/kola?vp-page=2`, `${BASE}/elektrokola`, `${BASE}/kola?vp-page=3`, `${BASE}/kola?vp-page=4`, `${BASE}/kola?vp-page=5`]);
  assert.deepEqual(JSON.parse(cache.get('sweep')), { cat: 0, page: 6 });
  // limit 0 = jen sitemapa
  site = siteWith({ kola, elektro });
  await cb.scan(makeCtx({ site, cache: new Map([['newHorizonAt', horizon]]), config: { cyklobazarMaxListPages: 0 } }));
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL]);
  // ctx.maxPages omezí stránky na kategorii
  site = siteWith({ kola, elektro });
  await cb.scan(makeCtx({ site, cache: new Map(), maxPages: 1 }));
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL, `${BASE}/kola`]);
});

test('sitemapa: známé inzeráty → markSeen (refreshDetail podle lastmod), confirmGone jen podle sitemapy', async () => {
  const db = new Map([
    ['KnownA0001', { id: 1, detail_at: new Date(NOW - 48 * H).toISOString(), gone_at: null, first_seen_at: null }],
    ['KnownB0001', { id: 2, detail_at: new Date(NOW - 1 * H).toISOString(), gone_at: null }],
    ['KnownC0001', { id: 3, detail_at: null, gone_at: null }],
    ['KnownD0001', { id: 4, detail_at: new Date(NOW - 48 * H).toISOString(), gone_at: new Date(NOW - 3 * H).toISOString() }],
    ['KnownE0001', { id: 5, detail_at: new Date(NOW - 48 * H).toISOString(), gone_at: new Date(NOW - 3 * H).toISOString() }],
    ['KnownF0001', { id: 6, detail_at: null, gone_at: null }],
  ]);
  const sitemapExtra = [
    { id: 'KnownA0001', lastmod: NOW - 1 * H },
    { id: 'KnownB0001', lastmod: NOW - 5 * H },
    { id: 'KnownC0001', lastmod: NOW - 1 * H },
    { id: 'KnownD0001', lastmod: NOW - 10 * H },
    { id: 'KnownE0001', lastmod: NOW - 1 * H },
  ];
  const site = siteWith({ kola: [pageItems('Ka', 5, { ageFrom: 0.1 })], elektro: [pageItems('Ea', 5, { ageFrom: 1 })], sitemapExtra });
  const ctx = makeCtx({ site, db, config: { cyklobazarMaxListPages: 0 } });
  const res = await cb.scan(ctx);
  assert.deepEqual(res, { complete: true });
  assert.deepEqual(ctx._seen.sort(), [
    ['KnownA0001', true],
    ['KnownB0001', false],
    ['KnownC0001', false],
    ['KnownE0001', true], // zmizelý, ale upravený po označení → zase aktivní a nový detail
  ]);
  assert.equal(await cb.confirmGone(ctx, { source_id: 'KnownA0001', first_seen_at: new Date(NOW - 100 * H).toISOString() }), false);
  assert.equal(await cb.confirmGone(ctx, { source_id: 'KnownF0001', first_seen_at: new Date(NOW - 3 * H).toISOString() }), true);
  assert.equal(await cb.confirmGone(ctx, { source_id: 'KnownF0001', first_seen_at: new Date(NOW - 1 * H).toISOString() }), null);
  assert.equal(await cb.confirmGone(ctx, { url: `${BASE}/inzerat/KnownG0001/kolo`, first_seen_at: new Date(NOW - 30 * H).toISOString() }), true);
  assert.equal(await cb.confirmGone(ctx, { source_id: 'KnownF0001' }), null);
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL]); // confirmGone nic nestahuje
  // bez sitemapy v tomto běhu → nevím
  assert.equal(await cb.confirmGone(makeCtx({ site }), { source_id: 'KnownF0001', first_seen_at: new Date(NOW - 30 * H).toISOString() }), null);
});

test('neúplná sitemapa (málo inzerátů nebo výrazně méně než minule) → mizení se nevyhodnocuje', async () => {
  const small = siteWith({ kola: [pageItems('Ka', 5, { ageFrom: 0.1 })], elektro: [pageItems('Ea', 5, { ageFrom: 1 })], fill: 100 });
  const db = new Map([['Kai00xyz', { id: 1, detail_at: null, gone_at: null }]]);
  const ctx = makeCtx({ site: small, db });
  assert.deepEqual(await cb.scan(ctx), { complete: false });
  assert.ok(ctx._logs.some(([l, m]) => l === 'warn' && /sitemapa vypadá neúplně/.test(m)));
  assert.deepEqual(ctx._seen, []);
  assert.equal(await cb.confirmGone(ctx, { source_id: 'Kai00xyz', first_seen_at: new Date(NOW - 30 * H).toISOString() }), null);
  const drop = siteWith({ kola: [pageItems('Ka', 5, { ageFrom: 0.1 })], elektro: [pageItems('Ea', 5, { ageFrom: 1 })], fill: 6000 });
  const ctx2 = makeCtx({ site: drop, cache: new Map([['sitemapCount', '15800']]) });
  assert.deepEqual(await cb.scan(ctx2), { complete: false });
  // chyba sitemapy (HTTP 500) → výpis projde, ale běh skončí chybou
  const err = siteWith({ kola: [pageItems('Ka', 5, { ageFrom: 0.1 })], elektro: [pageItems('Ea', 5, { ageFrom: 1 })], status: { [cb.SITEMAP_URL]: 500 } });
  const ctx3 = makeCtx({ site: err });
  await assert.rejects(() => cb.scan(ctx3), /sitemapa: Cyklobazar: sitemapa vrátila HTTP 500/);
  assert.equal(ctx3._emitted.length, 10);
});

test('ověření Cloudflare ve výpisu: zdroj hned končí, uloží 12h pauzu a během ní na web nesáhne', async () => {
  const kola = [pageItems('Ka', 20, { ageFrom: 0.1 }), pageItems('Kb', 20, { ageFrom: 12 }), pageItems('Kc', 20, { ageFrom: 30 })];
  const elektro = [pageItems('Ea', 15, { ageFrom: 1 })];
  const site = siteWith({ kola, elektro, challengeAt: `${BASE}/kola?vp-page=2` });
  const cache = new Map();
  const ctx = makeCtx({ site, cache });
  await assert.rejects(
    () => cb.scan(ctx),
    (e) => e instanceof cb.CyklobazarChallengeError && /Cloudflare žádá ověření/.test(e.message) && /ověření neobcházíme/.test(e.message) && /pauzu do/.test(e.message)
  );
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL, `${BASE}/kola`, `${BASE}/kola?vp-page=2`]);
  assert.equal(JSON.parse(cache.get('cooldownUntil')), new Date(NOW + 12 * H).toISOString());
  assert.equal(cb.cooldownUntil(ctx), NOW + 12 * H);
  // detail ve stejném běhu: bez požadavku
  await assert.rejects(() => cb.detail(ctx, { source_id: 'Kai00xyz', url: `${BASE}/inzerat/Kai00xyz/kolo-kai00xyz` }), /pauza po ověření Cloudflare do/);
  // další běh během pauzy: nic nestáhne, jen zaloguje
  const site2 = siteWith({ kola, elektro });
  const ctx2 = makeCtx({ site: site2, cache, now: () => NOW + 6 * H });
  assert.deepEqual(await cb.scan(ctx2), { complete: false });
  assert.deepEqual(site2.requests, []);
  assert.ok(ctx2._logs.some(([l, m]) => l === 'info' && /^Cyklobazar: pauza po ověření Cloudflare do /.test(m)));
  await assert.rejects(() => cb.detail(ctx2, { source_id: 'Kai00xyz', url: `${BASE}/inzerat/Kai00xyz/kolo-kai00xyz` }), /pauza po ověření Cloudflare/);
  assert.deepEqual(site2.requests, []);
  // po pauze zase normálně
  const site3 = siteWith({ kola, elektro });
  await cb.scan(makeCtx({ site: site3, cache, now: () => NOW + 13 * H }));
  assert.ok(site3.requests.length > 0);
});

test('HTTP 403 / 429 bez hlavičky Cloudflare = taky stop a pauza (sitemapa)', async () => {
  for (const status of [403, 429]) {
    const site = siteWith({ kola: [pageItems('Ka', 5, { ageFrom: 0.1 })], elektro: [], status: { [cb.SITEMAP_URL]: status } });
    const cache = new Map();
    await assert.rejects(() => cb.scan(makeCtx({ site, cache })), status === 429 ? /příliš mnoho požadavků/ : /Cloudflare žádá ověření/);
    assert.deepEqual(site.urls(), [cb.SITEMAP_URL]);
    assert.ok(cache.has('cooldownUntil'));
  }
});

test('detail přes prohlížeč: položka, 404 → null, ověření → stop + pauza, zakázané adresy se nestahují', async () => {
  const url = `${BASE}/inzerat/84OemEXXQ4paM/merida-matts-j-champion-26`;
  const html = read('detail_mtb_hardtail_private.html');
  const site = fakeSite({ [url]: html });
  const ctx = makeCtx({ site });
  const d = await cb.detail(ctx, { source_id: '84OemEXXQ4paM', url, params: {} });
  assert.equal(d.priceCzk, 12500);
  assert.equal(d.detailComplete, true);
  assert.equal(d.params.Stav, 'Použité');
  assert.equal(await cb.detail(ctx, { source_id: 'Neni000001', url: `${BASE}/inzerat/Neni000001/smazano` }), null);
  // jiný inzerát pod adresou → chyba (ne cizí data)
  await assert.rejects(() => cb.detail(makeCtx({ site: fakeSite({ [`${BASE}/inzerat/Jiny000001/x`]: html }) }), { source_id: 'Jiny000001', url: `${BASE}/inzerat/Jiny000001/x` }), /jiný inzerát/);
  // stránka bez inzerátu s textem o smazání → null
  assert.equal(await cb.detail(makeCtx({ site: fakeSite({ [`${BASE}/inzerat/Smaz000001/x`]: '<html><body>Inzerát byl smazán.</body></html>' }) }), { source_id: 'Smaz000001', url: `${BASE}/inzerat/Smaz000001/x` }), null);
  // zakázaná adresa (robots) → chyba bez požadavku
  const s2 = fakeSite({});
  await assert.rejects(() => cb.detail(makeCtx({ site: s2 }), { source_id: 'Tisk000001', url: `${BASE}/inzerat/Tisk000001/tiskarna` }), /robots/);
  await assert.rejects(() => cb.detail(makeCtx({ site: s2 }), { source_id: 'Bez0000001', url: `${BASE}/inzerat/Bez0000001` }), /úplná adresa/);
  assert.deepEqual(s2.requests, []);
  // ověření v detailu
  const s3 = fakeSite(() => ({ status: 403, html: '', challenged: true }));
  const cache = new Map();
  const c3 = makeCtx({ site: s3, cache });
  await assert.rejects(() => cb.detail(c3, { source_id: '84OemEXXQ4paM', url }), cb.CyklobazarChallengeError);
  assert.ok(cache.has('cooldownUntil'));
  await assert.rejects(() => cb.detail(c3, { source_id: '84OemEXXQ4paM', url }), /pauza po ověření/);
  assert.equal(s3.requests.length, 1);
  assertPolite(site);
});

test('bez prohlížeče (chybí playwright): srozumitelná chyba, sken skončí hned', async () => {
  const site = fakeSite({});
  const msg = 'Cyklobazar potřebuje prohlížeč: v adresáři kolomapa spusťte npm install a npx playwright install chromium';
  const ctx = makeCtx({
    site,
    getBrowser: async () => {
      throw new Error(msg);
    },
  });
  await assert.rejects(() => cb.scan(ctx), /npm install a npx playwright install chromium/);
  await assert.rejects(() => cb.detail(ctx, { source_id: '84OemEXXQ4paM', url: `${BASE}/inzerat/84OemEXXQ4paM/x` }), /npm install/);
  const ctx2 = makeCtx({ site });
  delete ctx2.getBrowser;
  await assert.rejects(() => cb.scan(ctx2), /potřebuje prohlížeč/);
});

test('nové inzeráty pod minimální cenou se přeskočí, známé ne; u známých s detailem výpis nepřepíše popis a kategorii', async () => {
  const kola = [pageItems('Ka', 4, { ageFrom: 0.1, price: 100 })];
  const db = new Map([['Kai01xyz', { id: 9, price_czk: 150, title: 'x', detail_at: new Date(NOW - 5 * H).toISOString(), gone_at: null }]]);
  const site = siteWith({ kola, elektro: [pageItems('Ea', 1, { ageFrom: 1 })] });
  const ctx = makeCtx({ site, db });
  await cb.scan(ctx);
  const ids = ctx._emitted.map((x) => x.sourceId);
  assert.ok(ids.includes('Kai01xyz'));
  assert.ok(!ids.includes('Kai00xyz'));
  const known = ctx._emitted.find((x) => x.sourceId === 'Kai01xyz');
  assert.equal(known.description, undefined);
  assert.equal(known.categorySrc, undefined);
  assert.equal(known.priceCzk, 101);
});

// ---------------------------------------------------------------- celý běh pipeline (skutečná DB, falešný web)

test('pipeline: první plnění, detaily, zmizelé podle sitemapy, změna podle lastmod, ověření → pauza bez dalších požadavků', async () => {
  const db = openDb(':memory:');
  const now = Date.now();
  const age = (h) => ({ ageFrom: h, step: 0.5, now });
  const kola = [pageItems('Ka', 10, age(0.1)), pageItems('Kb', 10, age(12))];
  const elektro = [pageItems('Ea', 5, age(1))];
  const all = [...kola.flat(), ...elektro.flat()];
  const DETAIL_TPL = read('detail_mtb_hardtail_private.html');
  const OLD_URL = `${BASE}/inzerat/84OemEXXQ4paM/merida-matts-j-champion-26`;
  // detail ze vzorku, ale se stejným názvem a cenou jako ve výpisu (jako na webu)
  const detailFor = (ad, url) =>
    DETAIL_TPL.split(OLD_URL)
      .join(url)
      .split('Merida Matts J. Champion 26\\"')
      .join(ad.title)
      .replace(/<h1>[^<]*<\/h1>/, `<h1>${ad.title}</h1>`)
      .replace('"price": 12500', `"price": ${ad.price}`)
      .replace('12 500&nbsp;<small>Kč</small>', `${fmtCzk(ad.price)}&nbsp;<small>Kč</small>`);
  let sitemapItems = all.map((x) => ({ id: x.id, lastmod: now - 5 * H }));
  let challenge = false;
  const site = fakeSite((url) => {
    if (challenge) return { status: 403, html: '', challenged: true };
    if (url === cb.SITEMAP_URL) return renderSitemap([...fillers(6000), ...sitemapItems]);
    const m = /\/(kola|elektrokola)(?:\?vp-page=(\d+))?$/.exec(url);
    if (m) {
      const pages = m[1] === 'kola' ? kola : elektro;
      const n = Number(m[2] || 1);
      return pages[n - 1] ? renderList(`/${m[1]}`, n, pages.length, pages[n - 1]) : null;
    }
    const ad = all.find((x) => url === `${BASE}/inzerat/${x.id}/kolo-${x.id.toLowerCase()}`);
    if (ad) return detailFor(ad, url);
    return null;
  });
  const config = { ...loadConfig({}), fullScanDays: 0, maxDetails: 100, ai: { enabled: false }, cyklobazarMaxListPages: 60 };
  const run = () => runPipeline({ db, config, sources: [cb], trigger: 'test', getBrowser: async () => site.browser });

  // 1. běh: sitemapa + celý výpis (postupný průchod od začátku) + detaily všech
  const r1 = await run();
  assert.equal(r1.status, 'ok', JSON.stringify(r1.stats.sources));
  const s1 = r1.stats.sources.cyklobazar;
  assert.equal(s1.new, 25);
  assert.equal(s1.details, 25);
  assert.equal(s1.complete, true);
  assertPolite(site);
  const row = db.prepare("SELECT * FROM listings WHERE source = 'cyklobazar' AND source_id = 'Kai00xyz'").get();
  assert.equal(row.url, `${BASE}/inzerat/Kai00xyz/kolo-kai00xyz`);
  assert.equal(row.price_czk, 15000);
  assert.equal(row.title, 'Kolo Ka 0');
  assert.match(row.description, /^Prodám kolo Merida Matts/); // plný popis z detailu
  assert.equal(row.okres, 'Břeclav');
  assert.equal(row.location_text, 'Březí');
  assert.equal(row.seller_type, 'private');
  assert.equal(JSON.parse(row.params)['Výrobce'], 'Merida');
  assert.ok(row.detail_at);
  const dump = JSON.stringify(db.prepare("SELECT * FROM listings WHERE source = 'cyklobazar'").all());
  assert.ok(!dump.includes(SENTINEL) && !dump.includes('/u/'), 'žádná jména ani profily prodejců v DB');

  // 2. běh: Kai01 zmizel ze sitemapy (známe ho > 2 h) → zmizelý; Kbi00 upravený po našem detailu → nový detail
  db.prepare("UPDATE listings SET first_seen_at = ? WHERE source_id = 'Kai01xyz'").run(new Date(now - 25 * H).toISOString());
  sitemapItems = sitemapItems.filter((x) => x.id !== 'Kai01xyz').map((x) => (x.id === 'Kbi00xyz' ? { ...x, lastmod: Date.now() + 60e3 } : x));
  kola[0] = kola[0].filter((x) => x.id !== 'Kai01xyz');
  site.requests.length = 0;
  const r2 = await run();
  assert.equal(r2.status, 'ok');
  assert.ok(db.prepare("SELECT gone_at FROM listings WHERE source_id = 'Kai01xyz'").get().gone_at);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE gone_at IS NOT NULL').get().n, 1);
  const detailReqs = site.urls().filter((u) => u.includes('/inzerat/'));
  assert.deepEqual(detailReqs, [`${BASE}/inzerat/Kbi00xyz/kolo-kbi00xyz`]);

  // 3. běh: Cloudflare žádá ověření hned u sitemapy → zdroj končí, pauza, detail se už nezkouší
  db.prepare("UPDATE listings SET detail_at = NULL WHERE source_id = 'Kai02xyz'").run();
  challenge = true;
  site.requests.length = 0;
  const r3 = await run();
  assert.equal(r3.status, 'partial');
  assert.match(r3.stats.sources.cyklobazar.error, /Cloudflare žádá ověření/);
  assert.deepEqual(site.urls(), [cb.SITEMAP_URL]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM listings WHERE gone_at IS NOT NULL').get().n, 1); // nic nového nezmizelo
  const cd = JSON.parse(db.prepare("SELECT value FROM settings WHERE key = 'cache:cyklobazar:cooldownUntil'").get().value);
  assert.ok(Date.parse(cd) > Date.now() + 11 * H);

  // 4. běh během pauzy: na web nejde vůbec nic
  challenge = false;
  site.requests.length = 0;
  const r4 = await run();
  assert.deepEqual(site.requests, []);
  assert.equal(r4.stats.sources.cyklobazar.complete, false);
});

test('opakované chyby webu (5xx / síť) → zdroj pro běh skončí, bez pauzy', async () => {
  const site = fakeSite((url) => (url === cb.SITEMAP_URL ? { status: 502, html: '' } : { status: 503, html: '' }));
  const ctx = makeCtx({ site, cache: new Map([['newHorizonAt', JSON.stringify(new Date(NOW - 24 * H).toISOString())]]) });
  await assert.rejects(() => cb.scan(ctx), /část průchodu selhala/);
  // sitemapa 502, kola 503 → 2 chyby; detail 503 → 3. chyba → konec, další detail už nic nestáhne
  await assert.rejects(() => cb.detail(ctx, { source_id: 'Kai00xyz', url: `${BASE}/inzerat/Kai00xyz/kolo-kai00xyz` }), /HTTP 503/);
  await assert.rejects(() => cb.detail(ctx, { source_id: 'Kai01xyz', url: `${BASE}/inzerat/Kai01xyz/kolo-kai01xyz` }), /3× po sobě neodpověděl/);
  assert.equal(site.requests.length, 3);
  assert.equal(ctx._cache.has('cooldownUntil'), false);
  // síťová chyba prohlížeče se počítá taky
  let n = 0;
  const flaky = { fetchHtml: async () => (++n, Promise.reject(new Error('Stažení selhalo: Failed to fetch'))) };
  const c2 = makeCtx({ getBrowser: async () => flaky });
  for (let i = 0; i < 3; i++) await assert.rejects(() => cb.detail(c2, { source_id: 'Kai00xyz', url: `${BASE}/inzerat/Kai00xyz/kolo-kai00xyz` }), /Failed to fetch/);
  await assert.rejects(() => cb.detail(c2, { source_id: 'Kai00xyz', url: `${BASE}/inzerat/Kai00xyz/kolo-kai00xyz` }), /po sobě neodpověděl/);
  assert.equal(n, 3);
});
