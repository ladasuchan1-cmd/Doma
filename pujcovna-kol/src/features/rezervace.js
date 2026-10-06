'use strict';
// Feature „rezervace“ (SPEC kap. 8 a 9): rezervační tok v pěti krocích se stavem v session (draft), finální zápis do DB
// v kroku 4 (domain/reservations.create v transakci), správa rezervace přes podepsaný token, ICS, JSON API dostupnosti,
// joby (expirace, no-show, připomínky).
//   GET/POST /rezervace                 krok 1 – termín (od/do + čas vyzvednutí/vrácení v otevírací době, 30-min sloty)
//   GET/POST /rezervace/kola            krok 2 – typy, velikosti, dostupnost, cena, počty, příslušenství
//   GET/POST /rezervace/udaje           krok 3 – jméno, e-mail, telefon + POVINNÉ souhlasy (OP + § 1837 j) OZ, doklad
//                                       totožnosti) – ověřuje se i na serveru; volitelně obchodní sdělení
//   GET/POST /rezervace/poplatek        krok 4 – souhrn, poplatek, metoda: karta / převod-QR (přes src/payments/provider,
//                                       pokud existuje – jinak notice „Online platba se připravuje“), na místě (jen
//                                       settings.allowPayOnSite), v PK_DEMO=1 „Simulovat zaplacení poplatku (demo)“
//   GET /rezervace/hotovo/:token        krok 5 – potvrzení, rekapitulace, co vzít s sebou, ICS, odkaz na správu
//   GET /rezervace/:token               správa: stav, položky, platby, ledger, doklady (/doklady/:number), storno s výpočtem
//   POST /rezervace/:token/storno       zrušení zákazníkem (cancel_by_customer) po potvrzení
//   POST /rezervace/:token/zaplatit     platba poplatku ze správy (karta / převod / demo)
//   GET /rezervace/:token/kalendar.ics  ICS událost
//   GET /api/v1/dostupnost?od&do&typ&velikost → { available: { [typeId]: { [size]: n } }, blockedDates: [...] }
// Session draft: { fromAt, toAt, od, do, odCas, doCas, days, typ, items, accessories, customer (šifrované), consents,
//                  reservation: { id } }. Osobní údaje se v session drží jen šifrované (fieldCrypto).
// Log nikdy neobsahuje jméno, e-mail, telefon ani token – jen id/číslo rezervace.

const { nowIso, parseJson } = require('../db');
const { publicBaseUrl } = require('../tenants');
const { HttpError } = require('../http/errors');
const format = require('../render/format');
const pricing = require('../domain/pricing');
const availability = require('../domain/availability');
const reservations = require('../domain/reservations');
const cancellation = require('../domain/cancellation');
const page = require('../render/pages/rezervace');

const DRAFT_KEY = 'draft';
const MAX_BIKES = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9 ()-]{6,40}$/;

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function getDraft(ctx) {
  const d = ctx.session.get(DRAFT_KEY);
  return d && typeof d === 'object' ? d : {};
}

function setDraft(ctx, draft) {
  ctx.session.set(DRAFT_KEY, draft);
}

function clearDraft(ctx) {
  ctx.session.set(DRAFT_KEY, undefined);
}

function baseUrlOf(ctx) {
  return publicBaseUrl(ctx.tenant, { host: ctx.req.headers.host, secure: ctx.secure });
}

/** Volitelný modul plateb (vznikne v dalším kole) – bez něj notice „Online platba se připravuje“. */
function loadProvider() {
  try {
    // eslint-disable-next-line global-require
    const mod = require('../payments/provider');
    return mod && typeof mod.createPayment === 'function' ? mod : null;
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND' && /payments[\\/]provider/.test(String(e.message))) return null;
    throw e;
  }
}

/** Volitelný generátor QR z modulu plateb (SPAYD → SVG). */
function qrFor(spayd) {
  if (!spayd) return null;
  try {
    // eslint-disable-next-line global-require
    const bt = require('../payments/bank-transfer');
    if (bt && typeof bt.qrSvg === 'function') return bt.qrSvg(spayd);
  } catch {
    /* modul zatím není */
  }
  return null;
}

function mailDeps(ctx) {
  return { fieldCrypto: ctx.app.fieldCrypto, tenant: ctx.tenant, settings: ctx.settings, baseUrl: baseUrlOf(ctx), secret: ctx.app.secret };
}

function listTypes(db) {
  return db
    .prepare(`SELECT t.*, (SELECT MIN(p.price_minor) FROM price_rules p WHERE p.bike_type_id = t.id AND p.unit = 'day' AND p.season_id IS NULL) AS from_price_minor FROM bike_types t WHERE t.active = 1 ORDER BY t.sort, t.name`)
    .all()
    .map((r) => ({ ...r, sizes: parseJson(r.sizes, []), photos: parseJson(r.photos, []), specs: parseJson(r.specs, {}) }));
}

function findTypeBySlug(db, slug) {
  const row = db.prepare('SELECT * FROM bike_types WHERE slug = ? AND active = 1').get(String(slug || ''));
  return row ? { ...row, sizes: parseJson(row.sizes, []), photos: parseJson(row.photos, []) } : null;
}

/** Termín z draftu → objekt s Date. */
function termOf(draft) {
  if (!draft || !draft.fromAt || !draft.toAt) return null;
  const fromAt = new Date(draft.fromAt);
  const toAt = new Date(draft.toAt);
  if (Number.isNaN(fromAt.getTime()) || Number.isNaN(toAt.getTime()) || !(toAt > fromAt)) return null;
  return { fromAt, toAt, od: draft.od, do: draft.do, odCas: draft.odCas, doCas: draft.doCas, days: pricing.lengthOf(fromAt, toAt).days };
}

/** Souhrn draftu pro krok 3/4 (přepočítá ceny i dostupnost). */
function buildSummary(ctx, draft, term) {
  const items = [];
  const map = availability.availabilityMap({ db: ctx.db, fromAt: term.fromAt, toAt: term.toAt, settings: ctx.settings });
  let totalMinor = 0;
  let feeMinor = 0;
  let depositMinor = 0;
  let shortage = null;
  for (const it of draft.items || []) {
    const type = ctx.db.prepare('SELECT id, slug, name, fee_minor, deposit_minor FROM bike_types WHERE id = ? AND active = 1').get(Number(it.typeId));
    if (!type) continue;
    const q = pricing.quote({ db: ctx.db, typeId: type.id, fromAt: term.fromAt, toAt: term.toAt, qty: it.qty });
    totalMinor += q.bikesMinor;
    feeMinor += q.feeMinor;
    depositMinor += q.depositMinor;
    const avail = map[type.id] ? map[type.id][it.size] || 0 : 0;
    if (avail < it.qty && !shortage) shortage = { typeName: type.name, size: it.size, requested: it.qty, available: avail };
    items.push({ typeId: type.id, typeName: type.name, typeSlug: type.slug, size: it.size, qty: it.qty, unitPriceMinor: Math.round(q.bikesMinor / it.qty), amountMinor: q.bikesMinor });
  }
  const acc = pricing.accessoriesQuote({ db: ctx.db, accessories: draft.accessories || [], days: term.days });
  totalMinor += acc.amountMinor;
  return { term, items, accessories: acc.lines.map((l) => ({ slug: l.slug, label: l.label, qty: l.qty, amountMinor: l.amountMinor })), totalMinor, feeMinor, depositMinor, shortage, transferExpiryHours: ctx.settings.transferExpiryHours };
}

function decryptCustomer(ctx, draft) {
  const fc = ctx.app.fieldCrypto;
  const c = draft.customer || {};
  const dec = (v) => {
    try {
      return v ? fc.dec(v) : '';
    } catch {
      return '';
    }
  };
  return { name: dec(c.name_enc), email: dec(c.email_enc), phone: dec(c.phone_enc) };
}

// ---------------------------------------------------------------------------------------------------------
// Krok 1 – termín

function terminValues(ctx, draft) {
  const q = ctx.query;
  return {
    od: str(q.od) || draft.od || '',
    od_cas: str(q.od_cas) || draft.odCas || '09:00',
    do: str(q.do) || draft.do || '',
    do_cas: str(q.do_cas) || draft.doCas || '17:00',
  };
}

function renderTermin(ctx, { values, errors = {}, status = 200, preselect = null }) {
  const today = new Date();
  const minDate = format.isoDate(today);
  const maxDate = availability.addDays(minDate, 365);
  ctx.render(
    page.termin,
    {
      csrf: ctx.csrfToken(),
      values,
      errors,
      slots: availability.allTimeSlots(ctx.tenant),
      blocked: availability.blockedDates({ db: ctx.db, tenant: ctx.tenant, from: minDate, to: maxDate, now: today }),
      minDate,
      maxDate,
      tenant: ctx.tenant,
      preselect,
    },
    { feature: 'rezervace', status, canonicalPath: '/rezervace', description: 'Online rezervace kol v Třeboni: vyberte termín, kola a zaplaťte rezervační poplatek. Potvrzení ihned e-mailem.' }
  );
}

async function terminGet(ctx) {
  const draft = getDraft(ctx);
  const typSlug = str(ctx.query.typ) || draft.typ || '';
  const preselect = typSlug ? findTypeBySlug(ctx.db, typSlug) : null;
  if (ctx.query.typ && preselect) setDraft(ctx, { ...draft, typ: preselect.slug });
  renderTermin(ctx, { values: terminValues(ctx, draft), preselect });
}

async function terminPost(ctx) {
  const b = ctx.body;
  const draft = getDraft(ctx);
  const values = { od: str(b.od), od_cas: str(b.od_cas), do: str(b.do), do_cas: str(b.do_cas) };
  const preselect = str(b.typ) ? findTypeBySlug(ctx.db, str(b.typ)) : draft.typ ? findTypeBySlug(ctx.db, draft.typ) : null;
  const errors = {};
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.od)) errors.od = 'Vyberte prosím datum vyzvednutí.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(values.do)) errors.do = 'Vyberte prosím datum vrácení.';
  if (!/^\d{2}:\d{2}$/.test(values.od_cas)) errors.od = errors.od || 'Vyberte prosím čas vyzvednutí.';
  if (!/^\d{2}:\d{2}$/.test(values.do_cas)) errors.do = errors.do || 'Vyberte prosím čas vrácení.';
  if (Object.keys(errors).length) return renderTermin(ctx, { values, errors, status: 422, preselect });
  let fromAt;
  let toAt;
  try {
    fromAt = availability.localToUtc(values.od, values.od_cas);
    toAt = availability.localToUtc(values.do, values.do_cas);
  } catch {
    return renderTermin(ctx, { values, errors: { obecne: 'Neplatné datum nebo čas.' }, status: 422, preselect });
  }
  const v = availability.validateRange({ db: ctx.db, tenant: ctx.tenant, settings: ctx.settings, fromAt, toAt });
  if (!v.ok) return renderTermin(ctx, { values, errors: v.errors, status: 422, preselect });
  const sameTerm = draft.fromAt === fromAt.toISOString() && draft.toAt === toAt.toISOString();
  setDraft(ctx, {
    ...draft,
    fromAt: fromAt.toISOString(),
    toAt: toAt.toISOString(),
    od: values.od,
    do: values.do,
    odCas: values.od_cas,
    doCas: values.do_cas,
    typ: preselect ? preselect.slug : draft.typ || null,
    items: sameTerm ? draft.items || [] : [],
    accessories: sameTerm ? draft.accessories || [] : [],
    reservation: sameTerm ? draft.reservation : undefined,
  });
  return ctx.redirect('/rezervace/kola');
}

// ---------------------------------------------------------------------------------------------------------
// Krok 2 – kola

function renderKola(ctx, draft, term, { errors = {}, notice = null, status = 200, selected = null, accSelected = null } = {}) {
  const types = listTypes(ctx.db);
  const map = availability.availabilityMap({ db: ctx.db, fromAt: term.fromAt, toAt: term.toAt, settings: ctx.settings });
  const sel = selected || Object.fromEntries((draft.items || []).map((it) => [`${it.typeId}|${it.size}`, it.qty]));
  const list = types.map((t) => {
    let quote = null;
    try {
      quote = pricing.quote({ db: ctx.db, typeId: t.id, fromAt: term.fromAt, toAt: term.toAt, qty: 1 });
    } catch {
      quote = null;
    }
    const av = map[t.id] || {};
    const selectedBySize = {};
    for (const s of t.sizes) selectedBySize[s] = sel[`${t.id}|${s}`] || 0;
    return { ...t, availability: av, totalAvailable: Object.values(av).reduce((a, b) => a + b, 0), quote, selected: selectedBySize };
  });
  // předvybraný typ nahoru
  if (draft.typ) list.sort((a, b) => (a.slug === draft.typ ? -1 : b.slug === draft.typ ? 1 : 0));
  const accSel = accSelected || Object.fromEntries((draft.accessories || []).map((a) => [a.slug, a.qty]));
  const accessories = ctx.db
    .prepare('SELECT * FROM accessories WHERE active = 1 ORDER BY price_minor DESC, name')
    .all()
    .map((a) => ({ ...a, qty: accSel[a.slug] || 0 }));
  ctx.render(page.kola, { csrf: ctx.csrfToken(), term, types: list, accessories, errors, notice }, { feature: 'rezervace', status, noindex: true });
}

async function kolaGet(ctx) {
  const draft = getDraft(ctx);
  const term = termOf(draft);
  if (!term) return ctx.redirect('/rezervace');
  return renderKola(ctx, draft, term);
}

async function kolaPost(ctx) {
  const draft = getDraft(ctx);
  const term = termOf(draft);
  if (!term) return ctx.redirect('/rezervace');
  const types = listTypes(ctx.db);
  const byId = new Map(types.map((t) => [t.id, t]));
  const items = [];
  const selected = {};
  let total = 0;
  for (const [key, raw] of Object.entries(ctx.body || {})) {
    const m = /^qty_(\d+)_(\d+)$/.exec(key);
    if (!m) continue;
    const type = byId.get(Number(m[1]));
    const size = type ? type.sizes[Number(m[2])] : undefined;
    const qty = Math.floor(Number(Array.isArray(raw) ? raw[0] : raw));
    if (!type || size === undefined || !Number.isFinite(qty) || qty <= 0) continue;
    items.push({ typeId: type.id, size, qty });
    selected[`${type.id}|${size}`] = qty;
    total += qty;
  }
  const accessories = [];
  const accSelected = {};
  for (const a of ctx.db.prepare('SELECT slug, name, stock FROM accessories WHERE active = 1').all()) {
    const raw = ctx.body[`acc_${a.slug}`];
    const qty = Math.floor(Number(Array.isArray(raw) ? raw[0] : raw));
    if (!Number.isFinite(qty) || qty <= 0) continue;
    accSelected[a.slug] = qty;
    if (qty > Number(a.stock)) return renderKola(ctx, draft, term, { status: 422, selected, accSelected, notice: `Příslušenství „${a.name}“ máme skladem jen ${format.plural(a.stock, 'kus', 'kusy', 'kusů')}.` });
    accessories.push({ slug: a.slug, qty });
  }
  if (!items.length) return renderKola(ctx, draft, term, { status: 422, selected, accSelected, errors: { obecne: 'Vyberte prosím alespoň jedno kolo – zadejte počet u některé velikosti.' } });
  if (total > MAX_BIKES) return renderKola(ctx, draft, term, { status: 422, selected, accSelected, errors: { obecne: `Online lze rezervovat nejvýše ${MAX_BIKES} kol. Pro skupiny nás prosím kontaktujte.` } });
  try {
    availability.assertAvailable({ db: ctx.db, items, fromAt: term.fromAt, toAt: term.toAt, settings: ctx.settings });
  } catch (e) {
    if (e instanceof availability.AvailabilityError) {
      const d = e.details || {};
      const t = d.typeId ? byId.get(d.typeId) : null;
      return renderKola(ctx, draft, term, { status: 422, selected, accSelected, notice: t ? `${t.name} (velikost ${d.size}): v tomto termínu je volných jen ${format.plural(d.available, 'kus', 'kusy', 'kusů')}, požadujete ${d.requested}.` : e.message });
    }
    throw e;
  }
  setDraft(ctx, { ...draft, items, accessories, reservation: undefined });
  return ctx.redirect('/rezervace/udaje');
}

// ---------------------------------------------------------------------------------------------------------
// Krok 3 – údaje a souhlasy

function validateCustomer(body) {
  const values = {
    jmeno: str(body.jmeno),
    email: str(body.email),
    telefon: str(body.telefon),
    souhlas_op: body.souhlas_op === '1' || body.souhlas_op === 'on',
    souhlas_doklad: body.souhlas_doklad === '1' || body.souhlas_doklad === 'on',
    marketing: body.marketing === '1' || body.marketing === 'on',
  };
  const errors = {};
  if (values.jmeno.length < 3 || values.jmeno.length > 100 || !/\s/.test(values.jmeno)) errors.jmeno = 'Zadejte prosím jméno a příjmení (3–100 znaků).';
  if (!EMAIL_RE.test(values.email) || values.email.length > 200) errors.email = 'Zadejte prosím platný e-mail – pošleme na něj potvrzení a odkaz na správu rezervace.';
  if (!PHONE_RE.test(values.telefon)) errors.telefon = 'Zadejte prosím telefon (např. +420 777 123 456).';
  if (!values.souhlas_op) errors.souhlas_op = 'Bez souhlasu s obchodními podmínkami a potvrzení poučení o storno pravidlech nelze rezervaci dokončit.';
  if (!values.souhlas_doklad) errors.souhlas_doklad = 'Bez potvrzení, že při převzetí předložíte doklad totožnosti a souhlasíte se zápisem jeho typu a čísla, nelze rezervaci dokončit – kolo bychom nemohli vydat.';
  return { values, errors };
}

function renderUdaje(ctx, draft, term, { values, errors = {}, status = 200 }) {
  let summary = null;
  try {
    summary = buildSummary(ctx, draft, term);
  } catch {
    summary = null;
  }
  ctx.render(page.udaje, { csrf: ctx.csrfToken(), term, values, errors, legalVersion: (ctx.tenant.legal && ctx.tenant.legal.version) || '1.0', settings: ctx.settings, summary }, { feature: 'rezervace', status, noindex: true });
}

async function udajeGet(ctx) {
  const draft = getDraft(ctx);
  const term = termOf(draft);
  if (!term) return ctx.redirect('/rezervace');
  if (!draft.items || !draft.items.length) return ctx.redirect('/rezervace/kola');
  const cust = decryptCustomer(ctx, draft);
  const consents = draft.consents || {};
  return renderUdaje(ctx, draft, term, { values: { jmeno: cust.name, email: cust.email, telefon: cust.phone, souhlas_op: !!consents.terms, souhlas_doklad: !!consents.idDoc, marketing: !!consents.marketing } });
}

async function udajePost(ctx) {
  const draft = getDraft(ctx);
  const term = termOf(draft);
  if (!term) return ctx.redirect('/rezervace');
  if (!draft.items || !draft.items.length) return ctx.redirect('/rezervace/kola');
  const { values, errors } = validateCustomer(ctx.body || {});
  if (Object.keys(errors).length) return renderUdaje(ctx, draft, term, { values, errors, status: 422 });
  const fc = ctx.app.fieldCrypto;
  setDraft(ctx, {
    ...draft,
    customer: { name_enc: fc.enc(values.jmeno), email_enc: fc.enc(values.email), phone_enc: fc.enc(values.telefon) },
    consents: { terms: true, idDoc: true, marketing: values.marketing, termsVersion: (ctx.tenant.legal && ctx.tenant.legal.version) || '1.0', at: nowIso() },
    reservation: undefined,
  });
  return ctx.redirect('/rezervace/poplatek');
}

// ---------------------------------------------------------------------------------------------------------
// Krok 4 – poplatek

function renderPoplatek(ctx, draft, term, { notice = null, noticeTone = 'warning', status = 200, reservation = null } = {}) {
  const summary = buildSummary(ctx, draft, term);
  let n = notice;
  let tone = noticeTone;
  if (!n && summary.shortage) {
    n = `${summary.shortage.typeName} (velikost ${summary.shortage.size}) už není v požadovaném počtu volné (zbývá ${summary.shortage.available}). Upravte prosím výběr kol.`;
    tone = 'danger';
  }
  ctx.render(
    page.poplatek,
    { csrf: ctx.csrfToken(), term, summary, demo: !!ctx.config.demo, providerAvailable: !!loadProvider(), allowPayOnSite: !!ctx.settings.allowPayOnSite, notice: n, noticeTone: tone, reservation },
    { feature: 'rezervace', status, noindex: true }
  );
}

async function poplatekGet(ctx) {
  const draft = getDraft(ctx);
  const term = termOf(draft);
  if (!term) return ctx.redirect('/rezervace');
  if (!draft.items || !draft.items.length) return ctx.redirect('/rezervace/kola');
  if (!draft.customer || !draft.consents || !draft.consents.terms || !draft.consents.idDoc) return ctx.redirect('/rezervace/udaje');
  const existing = draft.reservation && draft.reservation.id ? reservations.get(ctx.db, draft.reservation.id) : null;
  return renderPoplatek(ctx, draft, term, { reservation: existing && existing.status === 'awaiting_fee' ? existing : null });
}

/** Založí rezervaci z draftu (nebo vrátí už založenou, pokud stále čeká na poplatek). */
function ensureReservation(ctx, draft, term) {
  if (draft.reservation && draft.reservation.id) {
    const existing = reservations.get(ctx.db, draft.reservation.id);
    if (existing && existing.status === 'awaiting_fee') return { reservation: existing, token: reservations.tokenFor(existing, ctx.app.secret), created: false };
  }
  const cust = decryptCustomer(ctx, draft);
  const result = reservations.create({
    db: ctx.db,
    tenant: ctx.tenant,
    settings: ctx.settings,
    fieldCrypto: ctx.app.fieldCrypto,
    secret: ctx.app.secret,
    ipHash: ctx.ipHash,
    baseUrl: baseUrlOf(ctx),
    log: ctx.log,
    draft: {
      fromAt: term.fromAt,
      toAt: term.toAt,
      items: draft.items,
      accessories: draft.accessories || [],
      customer: { name: cust.name, email: cust.email, phone: cust.phone },
      consents: { termsVersion: draft.consents.termsVersion, marketing: !!draft.consents.marketing },
    },
  });
  setDraft(ctx, { ...draft, reservation: { id: result.reservation.id } });
  return { ...result, created: true };
}

/** Společné zpracování volby metody (krok 4 i správa). Vrací true, pokud byla odeslána odpověď. */
async function handlePaymentChoice(ctx, { reservation, token, metoda, backRender }) {
  const provider = loadProvider();
  const amount = Number(reservation.fee_minor);
  const manage = `/rezervace/${encodeURIComponent(token)}`;
  const common = { db: ctx.db, reservation, purpose: 'fee', amountMinor: amount, capture: 'auto', returnUrl: `${baseUrlOf(ctx)}/rezervace/hotovo/${encodeURIComponent(token)}`, tenant: ctx.tenant, settings: ctx.settings, ctx, baseUrl: baseUrlOf(ctx) };
  if (metoda === 'karta') {
    if (!provider) return backRender({ notice: 'Platba kartou zatím není k dispozici – online platba se připravuje. Zvolte převod, nebo v demu simulaci zaplacení.', noticeTone: 'warning', status: 200 });
    const result = await provider.createPayment({ ...common, method: 'card' });
    if (result && result.redirectUrl) return ctx.redirect(result.redirectUrl);
    return backRender({ notice: 'Platební bránu se nepodařilo založit. Zkuste to prosím znovu nebo zvolte převod.', noticeTone: 'danger', status: 200 });
  }
  if (metoda === 'prevod') {
    const b = ctx.tenant.business || {};
    let payment = { amountMinor: amount, iban: b.iban || null, accountNumber: b.accountNumber || null, vs: reservation.number, spayd: null, qrSvg: null, expiresAt: reservation.expires_at };
    let notice = null;
    if (provider) {
      const result = await provider.createPayment({ ...common, method: 'bank_transfer' });
      const p = result && result.payment ? result.payment : {};
      payment = { ...payment, amountMinor: p.amount_minor || amount, vs: p.vs || reservation.number, spayd: result.spayd || p.spayd || null, qrSvg: result.qrSvg || qrFor(result.spayd || p.spayd) || null, iban: result.iban || payment.iban, expiresAt: result.expiresAt || payment.expiresAt };
    } else {
      notice = 'QR kód a automatické párování platby se připravují. Údaje k převodu platí; po připsání platby obsluha rezervaci potvrdí ručně.';
    }
    ctx.render(page.prevod, { reservation, payment, token, tenant: ctx.tenant, notice }, { feature: 'rezervace', noindex: true });
    return undefined;
  }
  if (metoda === 'demo') {
    if (!ctx.config.demo) throw new HttpError(403, 'Simulace platby je dostupná jen v demo režimu.');
    const now = nowIso();
    const existing = ctx.db.prepare('SELECT * FROM payments WHERE idempotency_key = ?').get(`demo-fee:${reservation.id}`);
    const pay = existing || reservations.recordPayment(ctx.db, { reservationId: reservation.id, purpose: 'fee', method: 'card', provider: 'demo', providerRef: `DEMO-${reservation.number}`, amountMinor: amount, status: 'paid', idempotencyKey: `demo-fee:${reservation.id}`, vs: reservation.number, now });
    reservations.transition(ctx.db, reservation.id, 'fee_paid', { paymentId: pay.id, amountMinor: amount, method: 'card', ipHash: ctx.ipHash, settings: ctx.settings, mail: mailDeps(ctx), note: 'Demo: simulované zaplacení poplatku' });
    ctx.log.info('Demo: poplatek simulovaně zaplacen', { reservationId: reservation.id });
    return ctx.redirect(`/rezervace/hotovo/${encodeURIComponent(token)}`);
  }
  if (metoda === 'misto') {
    if (!ctx.settings.allowPayOnSite) throw new HttpError(403, 'Platba poplatku na místě není v této půjčovně povolena.');
    reservations.transition(ctx.db, reservation.id, 'fee_paid', { amountMinor: 0, ipHash: ctx.ipHash, settings: ctx.settings, mail: mailDeps(ctx), note: 'Platba na místě – rezervace bez garance' });
    return ctx.redirect(`/rezervace/hotovo/${encodeURIComponent(token)}`);
  }
  throw new HttpError(400, 'Neznámý způsob platby.');
}

async function poplatekPost(ctx) {
  const draft = getDraft(ctx);
  const term = termOf(draft);
  if (!term) return ctx.redirect('/rezervace');
  if (!draft.items || !draft.items.length) return ctx.redirect('/rezervace/kola');
  if (!draft.customer || !draft.consents || !draft.consents.terms || !draft.consents.idDoc) return ctx.redirect('/rezervace/udaje');
  const metoda = str(ctx.body.metoda);
  if (!['karta', 'prevod', 'demo', 'misto'].includes(metoda)) throw new HttpError(400, 'Neznámý způsob platby.');
  if (metoda === 'misto' && !ctx.settings.allowPayOnSite) throw new HttpError(403, 'Platba poplatku na místě není v této půjčovně povolena.');
  if (metoda === 'demo' && !ctx.config.demo) throw new HttpError(403, 'Simulace platby je dostupná jen v demo režimu.');
  let created;
  try {
    created = ensureReservation(ctx, draft, term);
  } catch (e) {
    if (e instanceof availability.AvailabilityError) return renderPoplatek(ctx, draft, term, { notice: e.message, noticeTone: 'danger', status: 409 });
    if (e instanceof pricing.PricingError || e instanceof reservations.TransitionError) return renderPoplatek(ctx, draft, term, { notice: e.message, noticeTone: 'danger', status: 422 });
    throw e;
  }
  const freshDraft = getDraft(ctx);
  return handlePaymentChoice(ctx, {
    reservation: created.reservation,
    token: created.token,
    metoda,
    backRender: (opts) => renderPoplatek(ctx, freshDraft, term, { ...opts, reservation: created.reservation }),
  });
}

// ---------------------------------------------------------------------------------------------------------
// Krok 5 a správa

function reservationFromToken(ctx) {
  const r = reservations.verifyToken({ db: ctx.db, token: String(ctx.params.token || ''), secret: ctx.app.secret });
  if (!r) throw new HttpError(404, 'Odkaz na rezervaci je neplatný nebo už vypršel. Zkontrolujte prosím odkaz z e-mailu.');
  return r;
}

function detailOf(ctx, r) {
  const detail = reservations.loadDetail(ctx.db, r);
  detail.days = pricing.lengthOf(r.from_at, r.to_at).days;
  return detail;
}

async function hotovoGet(ctx) {
  const r = reservationFromToken(ctx);
  const draft = getDraft(ctx);
  if (draft.reservation && draft.reservation.id === r.id) clearDraft(ctx);
  ctx.render(page.hotovo, { reservation: r, detail: detailOf(ctx, r), token: ctx.params.token, tenant: ctx.tenant, settings: ctx.settings }, { feature: 'rezervace', noindex: true });
}

function pendingTransferOf(ctx, r) {
  if (r.status !== 'awaiting_fee') return null;
  const p = ctx.db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'fee' AND method = 'bank_transfer' AND status IN ('created', 'pending') ORDER BY id DESC LIMIT 1").get(r.id);
  if (!p) return null;
  const b = ctx.tenant.business || {};
  return { amountMinor: p.amount_minor, iban: b.iban || null, accountNumber: b.accountNumber || null, vs: p.vs || r.number, spayd: p.spayd || null, qrSvg: qrFor(p.spayd), expiresAt: r.expires_at };
}

function renderSprava(ctx, r, { notice = null, noticeTone = 'info', status = 200, errors = {} } = {}) {
  const detail = detailOf(ctx, r);
  const quote = ['awaiting_fee', 'confirmed'].includes(r.status) ? cancellation.quote({ reservation: r, now: new Date(), settings: ctx.settings }) : null;
  ctx.render(
    page.sprava,
    { reservation: r, detail, token: ctx.params.token, csrf: ctx.csrfToken(), quote, tenant: ctx.tenant, settings: ctx.settings, demo: !!ctx.config.demo, providerAvailable: !!loadProvider(), notice, noticeTone, pendingTransfer: pendingTransferOf(ctx, r), errors },
    { feature: 'rezervace', status, noindex: true }
  );
}

async function spravaGet(ctx) {
  const r = reservationFromToken(ctx);
  let notice = null;
  let tone = 'info';
  if (ctx.query.storno === '1') {
    notice = 'Rezervace byla zrušena. Potvrzení jsme poslali e-mailem.';
    tone = 'success';
  } else if (ctx.query.zaplaceno === '1') {
    notice = 'Platba byla přijata, rezervace je potvrzena.';
    tone = 'success';
  }
  return renderSprava(ctx, r, { notice, noticeTone: tone });
}

async function stornoPost(ctx) {
  const r = reservationFromToken(ctx);
  if (!reservations.CANCELLABLE.includes(r.status)) return renderSprava(ctx, r, { notice: `Rezervaci ve stavu „${reservations.STATUS_LABELS[r.status] || r.status}“ už nelze zrušit online. Kontaktujte prosím půjčovnu.`, noticeTone: 'warning', status: 409 });
  if (!(ctx.body.potvrdit === '1' || ctx.body.potvrdit === 'on')) return renderSprava(ctx, r, { status: 422, errors: { potvrdit: 'Pro zrušení prosím potvrďte zaškrtnutím.' }, notice: 'Zrušení nebylo provedeno – chybí potvrzení.', noticeTone: 'danger' });
  try {
    reservations.transition(ctx.db, r.id, 'cancel_by_customer', { ipHash: ctx.ipHash, settings: ctx.settings, mail: mailDeps(ctx) });
  } catch (e) {
    if (e instanceof reservations.TransitionError) return renderSprava(ctx, reservations.get(ctx.db, r.id), { notice: e.message, noticeTone: 'danger', status: 409 });
    throw e;
  }
  ctx.log.info('Rezervace zrušena zákazníkem', { reservationId: r.id });
  return ctx.redirect(`/rezervace/${encodeURIComponent(ctx.params.token)}?storno=1`);
}

async function zaplatitPost(ctx) {
  const r = reservationFromToken(ctx);
  if (r.status !== 'awaiting_fee') return renderSprava(ctx, r, { notice: 'Rezervace už na poplatek nečeká.', noticeTone: 'info', status: 409 });
  const metoda = str(ctx.body.metoda);
  if (!['karta', 'prevod', 'demo'].includes(metoda)) throw new HttpError(400, 'Neznámý způsob platby.');
  return handlePaymentChoice(ctx, { reservation: r, token: ctx.params.token, metoda, backRender: (opts) => renderSprava(ctx, r, { notice: opts.notice, noticeTone: opts.noticeTone, status: opts.status }) });
}

// ---------------------------------------------------------------------------------------------------------
// ICS

function icsEscape(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** Skládání řádků po 75 oktetech (RFC 5545). */
function icsFold(line) {
  const out = [];
  let buf = '';
  let bytes = 0;
  for (const ch of line) {
    const len = Buffer.byteLength(ch, 'utf8');
    if (bytes + len > (out.length ? 74 : 75)) {
      out.push(buf);
      buf = ' ';
      bytes = 1;
    }
    buf += ch;
    bytes += len;
  }
  out.push(buf);
  return out.join('\r\n');
}

function buildIcs({ reservation, detail, tenant, baseUrl, token, host }) {
  const r = reservation;
  const b = tenant.business || {};
  const manage = `${baseUrl}/rezervace/${encodeURIComponent(token)}`;
  const items = detail.items.map((it) => `${it.qty}× ${it.typeName} (${it.size})`).join(', ');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:-//${icsEscape(tenant.name)}//Rezervace kol//CS`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:rezervace-${r.number}@${host}`,
    `DTSTAMP:${icsDate(r.updated_at || r.created_at)}`,
    `DTSTART:${icsDate(r.from_at)}`,
    `DTEND:${icsDate(r.to_at)}`,
    `SUMMARY:${icsEscape(`Půjčení kola – ${tenant.name} (č. ${r.number})`)}`,
    `DESCRIPTION:${icsEscape(`Rezervace č. ${r.number}: ${items}. Vezměte s sebou platný doklad totožnosti a kauci. Správa rezervace: ${manage}`)}`,
    b.address ? `LOCATION:${icsEscape(`${tenant.name}, ${b.address}`)}` : null,
    tenant.location ? `GEO:${tenant.location.lat};${tenant.location.lon}` : null,
    `URL:${manage}`,
    `STATUS:${['cancelled_by_customer', 'cancelled_by_operator', 'expired', 'no_show'].includes(r.status) ? 'CANCELLED' : r.status === 'awaiting_fee' ? 'TENTATIVE' : 'CONFIRMED'}`,
    'BEGIN:VALARM',
    'TRIGGER:-P1D',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsEscape('Zítra vyzvednutí kol – nezapomeňte doklad totožnosti')}`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean);
  return lines.map(icsFold).join('\r\n') + '\r\n';
}

async function icsGet(ctx) {
  const r = reservationFromToken(ctx);
  const host = String(ctx.req.headers.host || 'localhost').replace(/:\d+$/, '');
  const body = buildIcs({ reservation: r, detail: detailOf(ctx, r), tenant: ctx.tenant, baseUrl: baseUrlOf(ctx), token: ctx.params.token, host });
  ctx.send(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="rezervace-${r.number}.ics"`, 'Cache-Control': 'no-store' }, body);
}

// ---------------------------------------------------------------------------------------------------------
// API dostupnosti

async function dostupnostApi(ctx) {
  const q = ctx.query;
  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  let fromAt;
  let toAt;
  if (isDate(q.od) && isDate(q.do)) {
    const t = availability.termFromDates({ tenant: ctx.tenant, od: q.od, do: q.do, odCas: q.od_cas, doCas: q.do_cas });
    if (!t) throw new HttpError(400, 'Neplatný termín.');
    fromAt = t.fromAt;
    toAt = t.toAt;
  } else {
    fromAt = new Date(String(q.od || ''));
    toAt = new Date(String(q.do || ''));
    if (Number.isNaN(fromAt.getTime()) || Number.isNaN(toAt.getTime())) throw new HttpError(400, 'Parametry od a do musí být datum (YYYY-MM-DD) nebo datum a čas (ISO 8601).');
    if (!(toAt > fromAt)) throw new HttpError(400, 'Konec termínu musí být po začátku.');
  }
  let typeId = null;
  if (q.typ) {
    const t = /^\d+$/.test(String(q.typ)) ? ctx.db.prepare('SELECT id FROM bike_types WHERE id = ? AND active = 1').get(Number(q.typ)) : ctx.db.prepare('SELECT id FROM bike_types WHERE slug = ? AND active = 1').get(String(q.typ));
    if (!t) throw new HttpError(404, 'Typ kola nebyl nalezen.');
    typeId = t.id;
  }
  const map = availability.availabilityMap({ db: ctx.db, fromAt, toAt, settings: ctx.settings, typeId });
  const size = str(q.velikost);
  if (size) for (const id of Object.keys(map)) map[id] = { [size]: map[id][size] || 0 };
  const fromDay = availability.utcToLocal(fromAt).date;
  const minDate = format.isoDate(new Date());
  const blockedFrom = fromDay < minDate ? fromDay : minDate;
  ctx.json({
    ok: true,
    od: fromAt.toISOString(),
    do: toAt.toISOString(),
    available: map,
    total: Object.values(map).reduce((sum, sizes) => sum + Object.values(sizes).reduce((a, b) => a + b, 0), 0),
    blockedDates: availability.blockedDates({ db: ctx.db, tenant: ctx.tenant, from: blockedFrom, to: availability.addDays(blockedFrom, 365) }),
    types: ctx.db.prepare('SELECT id, slug, name FROM bike_types WHERE active = 1 ORDER BY sort, name').all(),
  });
}

// ---------------------------------------------------------------------------------------------------------
// Joby

async function maintenanceJob(deps) {
  const { tenants, dbs, fieldCrypto, secret, log, config } = deps;
  const { getSettings } = require('../tenants');
  for (const tenant of tenants || []) {
    const db = dbs.get(tenant.slug);
    if (!db) continue;
    try {
      reservations.runMaintenance({ db, tenant, settings: getSettings(db, tenant), fieldCrypto, secret, baseUrl: publicBaseUrl(tenant), now: new Date(), log });
    } catch (e) {
      if (log) log.error('Údržba rezervací selhala', { tenant: tenant.slug, error: e.message, demo: !!(config && config.demo) });
    }
  }
}

module.exports = {
  name: 'rezervace',
  routes: [
    ['GET', '/rezervace', terminGet, { rateLimit: 'public' }],
    ['POST', '/rezervace', terminPost, { csrf: true, rateLimit: 'reservation' }],
    ['GET', '/rezervace/kola', kolaGet, { rateLimit: 'public' }],
    ['POST', '/rezervace/kola', kolaPost, { csrf: true, rateLimit: 'reservation' }],
    ['GET', '/rezervace/udaje', udajeGet, { rateLimit: 'public' }],
    ['POST', '/rezervace/udaje', udajePost, { csrf: true, rateLimit: 'reservation' }],
    ['GET', '/rezervace/poplatek', poplatekGet, { rateLimit: 'public' }],
    ['POST', '/rezervace/poplatek', poplatekPost, { csrf: true, rateLimit: 'reservation' }],
    ['GET', '/rezervace/hotovo/:token', hotovoGet, { rateLimit: 'public' }],
    ['GET', '/rezervace/:token', spravaGet, { rateLimit: 'public' }],
    ['POST', '/rezervace/:token/storno', stornoPost, { csrf: true, rateLimit: 'reservation' }],
    ['POST', '/rezervace/:token/zaplatit', zaplatitPost, { csrf: true, rateLimit: 'reservation' }],
    ['GET', '/rezervace/:token/kalendar.ics', icsGet, { rateLimit: 'public' }],
    ['GET', '/api/v1/dostupnost', dostupnostApi, { rateLimit: 'api' }],
  ],
  nav: [{ label: 'Rezervace', href: '/rezervace', order: 30, cta: true }],
  css: ['/css/rezervace.css'],
  js: ['/js/rezervace.js'],
  jobs: [{ name: 'reservations-maintenance', everyMs: 60 * 1000, fn: maintenanceJob }],
  // pro testy
  validateCustomer,
  buildIcs,
  loadProvider,
  DRAFT_KEY,
  MAX_BIKES,
};
