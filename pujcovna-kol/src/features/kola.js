'use strict';
// Feature „kola“ (SPEC kap. 8): katalog typů kol, detail typu, ceník a JSON API ceny.
//   GET /kola                 filtry (kategorie, velikost, termín od–do – GET formulář, funguje bez JS), karty s cenou
//                             „od … Kč/den“ a dostupností pro zadaný termín (domain/availability)
//   GET /kola/:slug           galerie, specifikace, velikosti s dostupností, ceník typu (pásma × sezóna), poplatek,
//                             kauce, tlačítko Rezervovat (předvyplní typ a termín), JSON-LD Product/Offer
//   GET /cenik                ceník všech typů, sezóny, příslušenství, poplatek, kauce, storno pravidla (ze settings)
//   GET /api/v1/cena?typ&od&do&pocet  JSON cena (domain/pricing.quote); typ = slug nebo id; od/do ISO datum-čas,
//                             nebo datum (pak otevírací doba) + volitelné od_cas/do_cas HH:MM
// Vstup: ctx. Výstup: stránky / JSON. Bez zápisu do DB.

const { parseJson } = require('../db');
const { publicBaseUrl } = require('../tenants');
const { CATEGORY_LABELS } = require('../render/components');
const format = require('../render/format');
const { HttpError } = require('../http/errors');
const pricing = require('../domain/pricing');
const availability = require('../domain/availability');
const cancellation = require('../domain/cancellation');
const page = require('../render/pages/kola');

const MAX_QTY = 20;

function parseType(row) {
  return { ...row, sizes: parseJson(row.sizes, []), photos: parseJson(row.photos, []), specs: parseJson(row.specs, {}) };
}

/** Aktivní typy kol s cenou „od“ (nejnižší denní sazba mimo sezónu). */
function listTypes(db, { category = null } = {}) {
  const rows = db
    .prepare(
      `SELECT t.*, (SELECT MIN(p.price_minor) FROM price_rules p WHERE p.bike_type_id = t.id AND p.unit = 'day' AND p.season_id IS NULL) AS from_price_minor
       FROM bike_types t WHERE t.active = 1 ${category ? 'AND t.category = ?' : ''} ORDER BY t.sort, t.name`
    )
    .all(...(category ? [category] : []));
  return rows.map(parseType);
}

function findType(db, slugOrId) {
  const s = String(slugOrId || '');
  const row = /^\d+$/.test(s)
    ? db.prepare('SELECT * FROM bike_types WHERE id = ? AND active = 1').get(Number(s))
    : db.prepare('SELECT * FROM bike_types WHERE slug = ? AND active = 1').get(s);
  if (!row) return null;
  const t = parseType(row);
  t.from_price_minor = pricing.fromPrice(db, t.id);
  return t;
}

/** Celkové počty kusů per velikost (status available). */
function totalsBySize(db, typeId) {
  const out = {};
  for (const r of db.prepare("SELECT size, COUNT(*) AS n FROM bikes WHERE bike_type_id = ? AND status = 'available' GROUP BY size").all(Number(typeId))) out[r.size] = Number(r.n);
  return out;
}

/** Termín z query (od, do, od_cas, do_cas) – null, pokud není zadán; { error } při neplatném vstupu. */
function termFromQuery(ctx) {
  const q = ctx.query;
  if (!q.od && !q.do) return { term: null, error: null };
  const term = availability.termFromDates({ tenant: ctx.tenant, settings: ctx.settings, od: q.od, do: q.do, odCas: q.od_cas, doCas: q.do_cas });
  if (!term) return { term: null, error: 'Zadejte prosím platný termín: datum vrácení musí být stejné nebo pozdější než datum vyzvednutí.' };
  const days = pricing.lengthOf(term.fromAt, term.toAt).days;
  if (days > availability.DEFAULT_MAX_RENTAL_DAYS) return { term: null, error: `Online lze rezervovat nejvýše ${availability.DEFAULT_MAX_RENTAL_DAYS} dní. Pro delší pronájem nás kontaktujte.` };
  return { term: { ...term, days }, error: null };
}

function sanitizeSize(v) {
  const s = String(v || '').trim();
  return s && s.length <= 10 ? s : '';
}

async function listHandler(ctx) {
  const kategorie = Object.hasOwn(CATEGORY_LABELS, ctx.query.kategorie) ? ctx.query.kategorie : '';
  const velikost = sanitizeSize(ctx.query.velikost);
  const { term, error } = termFromQuery(ctx);
  const all = listTypes(ctx.db);
  const categories = [...new Set(all.map((t) => t.category))];
  const sizes = [...new Set(all.flatMap((t) => t.sizes))];
  let types = all.filter((t) => (!kategorie || t.category === kategorie) && (!velikost || t.sizes.includes(velikost)));
  if (term) {
    const map = availability.availabilityMap({ db: ctx.db, fromAt: term.fromAt, toAt: term.toAt, settings: ctx.settings });
    types = types.map((t) => {
      let price = t.from_price_minor;
      try {
        price = pricing.quote({ db: ctx.db, typeId: t.id, fromAt: term.fromAt, toAt: term.toAt, qty: 1 }).unitPriceMinor;
      } catch {
        /* bez ceníku → cena od */
      }
      const bySize = map[t.id] || {};
      const available = velikost ? bySize[velikost] || 0 : Object.values(bySize).reduce((a, b) => a + b, 0);
      return { ...t, price_minor: price, available };
    });
  } else {
    types = types.map((t) => ({ ...t, price_minor: t.from_price_minor, available: undefined }));
  }
  ctx.render(page.list, { types, filters: { kategorie, velikost, od: ctx.query.od || '', do: ctx.query.do || '', minDate: format.isoDate(new Date()) }, categories, sizes, categoryLabels: CATEGORY_LABELS, term, termError: error }, { feature: 'kola', canonicalPath: '/kola' });
}

async function detailHandler(ctx) {
  const type = findType(ctx.db, ctx.params.slug);
  if (!type) return ctx.notFound('Tento typ kola v nabídce nemáme.');
  const { term, error } = termFromQuery(ctx);
  let availabilityBySize = null;
  let quote = null;
  if (term) {
    availabilityBySize = availability.availabilityMap({ db: ctx.db, fromAt: term.fromAt, toAt: term.toAt, settings: ctx.settings, typeId: type.id })[type.id] || {};
    try {
      quote = pricing.quote({ db: ctx.db, typeId: type.id, fromAt: term.fromAt, toAt: term.toAt, qty: 1 });
    } catch {
      quote = null;
    }
  }
  const priceRows = pricing.mergeSeasonRows(pricing.priceTable(ctx.db, type.id));
  const baseUrl = publicBaseUrl(ctx.tenant, { host: ctx.req.headers.host, secure: ctx.secure });
  ctx.render(
    page.detail,
    { type, priceRows, availabilityBySize, totalsBySize: totalsBySize(ctx.db, type.id), term, quote, settings: ctx.settings, baseUrl, freeHours: cancellation.freeHours(ctx.settings), categoryLabels: CATEGORY_LABELS, termError: error },
    { feature: 'kola', canonicalPath: `/kola/${type.slug}` }
  );
}

async function cenikHandler(ctx) {
  const types = listTypes(ctx.db).map((t) => ({ ...t, priceRows: pricing.mergeSeasonRows(pricing.priceTable(ctx.db, t.id)) }));
  const seasons = ctx.db.prepare('SELECT * FROM seasons ORDER BY date_from').all();
  const accessories = ctx.db.prepare('SELECT * FROM accessories WHERE active = 1 ORDER BY price_minor DESC, name').all();
  ctx.render(
    page.cenik,
    { types, seasons, accessories, settings: ctx.settings, categoryLabels: CATEGORY_LABELS, freeHours: cancellation.freeHours(ctx.settings), bufferMinutes: Number(ctx.settings.bufferMinutes) || availability.DEFAULT_BUFFER_MINUTES },
    { feature: 'kola', canonicalPath: '/cenik' }
  );
}

/** Rozparsuje od/do z API: ISO datum-čas, nebo datum (+ od_cas/do_cas). */
function apiTerm(ctx) {
  const q = ctx.query;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  if (isDate(q.od) && isDate(q.do)) {
    const t = availability.termFromDates({ tenant: ctx.tenant, settings: ctx.settings, od: q.od, do: q.do, odCas: q.od_cas, doCas: q.do_cas });
    if (!t) throw new HttpError(400, 'Neplatný termín.');
    return t;
  }
  const fromAt = new Date(String(q.od || ''));
  const toAt = new Date(String(q.do || ''));
  if (Number.isNaN(fromAt.getTime()) || Number.isNaN(toAt.getTime())) throw new HttpError(400, 'Parametry od a do musí být datum (YYYY-MM-DD) nebo datum a čas (ISO 8601).');
  if (!(toAt > fromAt)) throw new HttpError(400, 'Konec termínu musí být po začátku.');
  return { fromAt, toAt, od: availability.utcToLocal(fromAt).date, do: availability.utcToLocal(toAt).date, odCas: availability.utcToLocal(fromAt).time, doCas: availability.utcToLocal(toAt).time };
}

async function priceApi(ctx) {
  const type = findType(ctx.db, ctx.query.typ);
  if (!type) throw new HttpError(404, 'Typ kola nebyl nalezen.');
  const term = apiTerm(ctx);
  const qty = Math.min(MAX_QTY, Math.max(1, Math.floor(Number(ctx.query.pocet) || 1)));
  let accessories = [];
  if (ctx.query.prislusenstvi) {
    accessories = String(ctx.query.prislusenstvi)
      .split(',')
      .map((p) => {
        const [slug, n] = p.split(':');
        return { slug: String(slug || '').trim(), qty: Math.max(0, Math.floor(Number(n) || 1)) };
      })
      .filter((a) => a.slug && a.qty > 0);
  }
  try {
    const q = pricing.quote({ db: ctx.db, typeId: type.id, fromAt: term.fromAt, toAt: term.toAt, qty, accessories });
    ctx.json({
      ok: true,
      typ: type.slug,
      od: term.fromAt.toISOString(),
      do: term.toAt.toISOString(),
      pocet: qty,
      ...q,
      formatted: { total: format.money(q.totalMinor), bikes: format.money(q.bikesMinor), fee: format.money(q.feeMinor), deposit: format.money(q.depositMinor), unitPrice: format.money(q.unitPriceMinor) },
    });
  } catch (e) {
    if (e instanceof pricing.PricingError) throw new HttpError(400, e.message);
    throw e;
  }
}

module.exports = {
  name: 'kola',
  routes: [
    ['GET', '/kola', listHandler, { rateLimit: 'public' }],
    ['GET', '/kola/:slug', detailHandler, { rateLimit: 'public' }],
    ['GET', '/cenik', cenikHandler, { rateLimit: 'public' }],
    ['GET', '/api/v1/cena', priceApi, { rateLimit: 'api' }],
  ],
  nav: [
    { label: 'Kola', href: '/kola', order: 10 },
    { label: 'Ceník', href: '/cenik', order: 20 },
  ],
  css: ['/css/kola.css'],
  js: ['/js/kola.js'],
  listTypes,
  findType,
  totalsBySize,
  termFromQuery,
  apiTerm,
  parseType,
};
