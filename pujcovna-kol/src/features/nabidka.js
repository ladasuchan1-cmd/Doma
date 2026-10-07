'use strict';
// Feature „nabídka“: veřejný nabídkový konfigurátor pro hotely, penziony a půjčovny (kola + rezervační web + správa +
// servis) nad jediným zdrojem cen config/nabidka.json (načte se při startu a znovu při změně mtime; chyba struktury →
// srozumitelná chyba v logu a stránka s notice „nabídka se připravuje“; cesta přepsatelná PK_NABIDKA_CONFIG / setConfigPath()).
//   GET  /nabidka[?zakladni&trek&ekolo&porizeni&web&dalsiDesign&sprava&servis&doplnky]   SSR konfigurátor (funguje bez JS)
//   GET  /api/v1/nabidka/spocitat?…        JSON výsledek (+ `html` souhrnu pro živý přepočet); interní čísla jen s admin session
//   POST /nabidka/poptavka                 odeslání poptávky (CSRF, honeypot „web“, rate limit reservation) → outbox typ
//                                          'nabidka' (payload = konfigurace + výsledek + interní čísla; kontaktní údaje šifrované
//                                          fieldCrypto jako v kontakt.js; e-mail provozovateli) → /nabidka/dekujeme/:token
//   GET  /nabidka/dekujeme/:token          rekapitulace s číslem poptávky NAB-RRRR-NNNNNN
//   GET  /admin/nabidky, /admin/nabidky/:id  interní seznam a detail poptávek (admin session přes admin.guard; zobrazení
//                                          kontaktních údajů se audituje jako nabidka.view)
// Interní blok (marže, náklady, podíl partnera, nákupní ceny, varování) se na /nabidka, v API i v /admin/nabidky zobrazí
// jen přihlášenému správci PLATFORMY (vidiInterni – session z /platforma); ?interni=0 ho skryje. Správce tenanta (demo má
// veřejné heslo) ani správce klientského webu interní čísla nevidí. Log nikdy neobsahuje název, osobu, e-mail ani telefon – jen id/číslo.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nowIso, parseJson, transaction } = require('../db');
const { HttpError } = require('../http/errors');
const { html } = require('../render/html');
const domain = require('../domain/nabidka');
const page = require('../render/pages/nabidka');
const adminPage = require('../render/pages/admin/nabidky');
const admin = require('./admin');

const ROOT = path.join(__dirname, '..', '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config', 'nabidka.json');
const MTIME_CHECK_MS = 2000;
const OUTBOX_TYPE = 'nabidka';
const LIMITS = { nazev: [2, 120], obec: [2, 80], osoba: [2, 100], email: [5, 200], telefon: [0, 40], poznamka: [0, 2000] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------------------------------------
// Konfigurace cen

/**
 * Načítání config/nabidka.json (veřejný ceník) + volitelného INTERNÍHO souboru s nákupními cenami (mimo git) s kontrolou
 * mtime obou souborů (každé 2 s) – změna se projeví bez restartu. get() vrací { config|null, error|null, mtime, path,
 * interniPath, interniError }. Interní soubor: PK_NABIDKA_INTERNI, jinak první existující z $PK_DATA/nabidka.interni.json
 * a config/nabidka.interni.json; chybí-li, nákupní ceny se odvodí (domain.validateConfig) a interní pohled to označí.
 * Obsah interního souboru se nikdy neloguje.
 */
function createConfigLoader({ filePath = DEFAULT_CONFIG_PATH, interniPath = null, log = null } = {}) {
  let state = { config: null, error: 'Konfigurace zatím nebyla načtena.', mtime: null, path: filePath, interniPath: null, interniMtime: null, interniError: null, loadedAt: 0 };
  let lastCheck = 0;
  let lastLoggedKey = null;
  let lastLoggedInterni = null;

  /** Cesta interního souboru: explicitní, jinak první existující kandidát (může se objevit i za běhu). */
  function resolveInterni() {
    if (interniPath) return interniPath;
    for (const cand of defaultInterniCandidates()) if (fs.existsSync(cand)) return cand;
    return null;
  }

  function load(force = false) {
    const now = Date.now();
    if (!force && now - lastCheck < MTIME_CHECK_MS) return state;
    lastCheck = now;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      const key = 'missing';
      if (lastLoggedKey !== key && log) log.warn('Nabídka: konfigurace cen nenalezena – stránka zobrazí „nabídka se připravuje“', { file: path.relative(ROOT, filePath) });
      lastLoggedKey = key;
      state = { ...state, config: null, error: `Soubor ${path.relative(ROOT, filePath)} neexistuje.`, mtime: null, path: filePath, loadedAt: now };
      return state;
    }
    const mtime = stat.mtimeMs;
    const ip = resolveInterni();
    let interniMtime = null;
    if (ip) {
      try {
        interniMtime = fs.statSync(ip).mtimeMs;
      } catch {
        interniMtime = null;
      }
    }
    if (!force && state.mtime === mtime && state.interniPath === ip && state.interniMtime === interniMtime && (state.config || state.error)) return state;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      state = { ...state, config: null, error: `Soubor není platný JSON: ${e.message}`, mtime, path: filePath, loadedAt: now };
      const key = `json:${mtime}`;
      if (lastLoggedKey !== key && log) log.error('Nabídka: konfigurace cen není platný JSON', { file: path.relative(ROOT, filePath), error: e.message });
      lastLoggedKey = key;
      return state;
    }
    // interní soubor: chyba v něm NEshazuje konfigurátor – jen se ignoruje (odvozené ceny) a zaloguje (bez obsahu)
    let interniRaw = null;
    let interniError = null;
    if (ip && interniMtime !== null) {
      try {
        interniRaw = JSON.parse(fs.readFileSync(ip, 'utf8'));
      } catch (e) {
        interniError = `Interní soubor cen není platný JSON: ${e.message}`;
        interniRaw = null;
      }
    }
    let v = domain.validateConfig(parsed, interniRaw);
    if (!v.ok && interniRaw !== null) {
      // zkusit bez interního souboru – je-li chyba jen v něm, běžíme s odvozenými cenami
      const bez = domain.validateConfig(parsed, null);
      if (bez.ok) {
        interniError = `Interní soubor cen má chybnou strukturu: ${v.errors.filter((e) => /Interní soubor/.test(e)).join(' ') || v.errors.join(' ')}`;
        v = bez;
      }
    }
    if (interniError) {
      const key = `${ip}:${interniMtime}:${interniError}`;
      if (lastLoggedInterni !== key && log) log.error('Nabídka: interní soubor nákupních cen se nepodařilo načíst – počítá se s odvozenými cenami', { file: ip, error: interniError });
      lastLoggedInterni = key;
    } else lastLoggedInterni = null;
    if (!v.ok) {
      state = { ...state, config: null, error: v.errors.join(' '), mtime, path: filePath, interniPath: ip, interniMtime, interniError, loadedAt: now };
      const key = `struct:${mtime}:${interniMtime}`;
      if (lastLoggedKey !== key && log) log.error('Nabídka: konfigurace cen má chybnou strukturu – stránka zobrazí „nabídka se připravuje“', { file: path.relative(ROOT, filePath), errors: v.errors });
      lastLoggedKey = key;
      return state;
    }
    const changed = state.mtime !== mtime || state.interniPath !== ip || state.interniMtime !== interniMtime;
    state = { config: v.config, error: null, mtime, path: filePath, interniPath: ip, interniMtime, interniError, loadedAt: now };
    if (changed && log) log.info('Nabídka: konfigurace cen načtena', { file: path.relative(ROOT, filePath), verze: v.config.meta.verze, zastupneCeny: v.config.meta.zastupneCeny, interniSoubor: ip ? path.basename(ip) : null, nakupniCenyOdvozene: v.config.meta.nakupniCenyOdvozene });
    lastLoggedKey = null;
    return state;
  }

  return {
    get: () => load(false),
    reload: () => load(true),
    /** Logger serveru (modulový loader vzniká před startem serveru bez loggeru). */
    setLog(l) {
      log = l || log;
    },
    setPath(p) {
      filePath = p;
      state = { config: null, error: null, mtime: null, path: p, interniPath: null, interniMtime: null, interniError: null, loadedAt: 0 };
      lastCheck = 0;
      lastLoggedKey = null;
      return load(true);
    },
    /** Cesta interního souboru (null = automaticky podle PK_NABIDKA_INTERNI / $PK_DATA / config). */
    setInterniPath(p) {
      interniPath = p || null;
      lastCheck = 0;
      return load(true);
    },
    get path() {
      return filePath;
    },
  };
}

/** Kandidáti na interní soubor, když PK_NABIDKA_INTERNI není nastaveno: $PK_DATA/nabidka.interni.json, config/nabidka.interni.json. */
function defaultInterniCandidates() {
  const dataDir = path.resolve(ROOT, process.env.PK_DATA || './data');
  return [path.join(dataDir, 'nabidka.interni.json'), path.join(ROOT, 'config', 'nabidka.interni.json')];
}

const loader = createConfigLoader({
  filePath: process.env.PK_NABIDKA_CONFIG ? path.resolve(process.env.PK_NABIDKA_CONFIG) : DEFAULT_CONFIG_PATH,
  interniPath: process.env.PK_NABIDKA_INTERNI ? path.resolve(process.env.PK_NABIDKA_INTERNI) : null,
});

// ---------------------------------------------------------------------------------------------------------
// Konkrétní modely kol (veřejný soubor config/kola-modely.json: názvy, veřejné ceny výrobce, odkazy; bez nákupních cen)

const MODELY_PATH = path.join(ROOT, 'config', 'kola-modely.json');
let modelyCache = { mtime: null, modely: [], meta: {} };

/** Modely z config/kola-modely.json (cache podle mtime; chyba → prázdný seznam, stránka funguje dál). */
function loadModely() {
  let stat;
  try {
    stat = fs.statSync(MODELY_PATH);
  } catch {
    return (modelyCache = { mtime: null, modely: [], meta: {} });
  }
  if (modelyCache.mtime === stat.mtimeMs) return modelyCache;
  try {
    const j = JSON.parse(fs.readFileSync(MODELY_PATH, 'utf8'));
    const modely = (Array.isArray(j.modely) ? j.modely : []).filter((m) => m && typeof m.slug === 'string' && typeof m.model === 'string');
    modelyCache = { mtime: stat.mtimeMs, modely, meta: j.meta || {} };
  } catch {
    modelyCache = { mtime: stat.mtimeMs, modely: [], meta: {} };
  }
  return modelyCache;
}

/** Konfigurace pro požadavek (loguje přes ctx.log, aby záznam nesl request id). */
// konfigurace s nákupní cenou tříd z flotily (domain.nakupTridZFlotily), přepočet jen při změně ceníku nebo kola-modely.json
let flotilaMemo = { src: null, mtime: null, config: null };

function configFor(ctx) {
  if (ctx && ctx.app && ctx.app.log) loader.setLog(ctx.app.log);
  const st = loader.get();
  if (!st.config && ctx && ctx.log && st.error) ctx.log.warn('Nabídka: konfigurace cen není k dispozici', { error: st.error });
  if (!st.config) return st;
  const m = loadModely();
  if (flotilaMemo.src !== st.config || flotilaMemo.mtime !== m.mtime) flotilaMemo = { src: st.config, mtime: m.mtime, config: domain.nakupTridZFlotily(st.config, m.modely) };
  return { ...st, config: flotilaMemo.config };
}

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

function str(v) {
  return typeof v === 'string' ? v.trim() : Array.isArray(v) ? str(v[0]) : '';
}

/** Je požadavek od přihlášeného správce (platná admin session, aktivní uživatel)? */
/**
 * Smí vidět interní čísla (marže, nákupní ceny)? Jen přihlášený správce PLATFORMY (/platforma, PK_PLATFORMA_HESLO) na
 * hostu platformy – ne správce tenanta: heslo administrace dema je veřejné a správce klientského webu naše marže vidět
 * nesmí. Bez PK_PLATFORMA_HESLO interní čísla nevidí nikdo.
 */
function vidiInterni(ctx) {
  if (ctx.klient || !ctx.config.platformaHeslo) return false;
  try {
    return ctx.platformSession.get('ok') === true;
  } catch {
    return false;
  }
}

/** Zobrazit interní blok? Jen správce platformy (vidiInterni); ?interni=0 skryje. */
function showInternal(ctx) {
  if (!vidiInterni(ctx)) return false;
  return ctx.query.interni !== '0';
}

// Úvodní stav konfigurátoru bez zadaných počtů: nejmenší nabídka (2 kola jako v kampani „Pojďme to zkusit“), aby souhrn
// od začátku ukazoval ceny a „Vyplatí se to?“ a proklikávání kroků bylo vidět. Poptávka (POST) výchozí kola nedostává.
const VYCHOZI_KOLA = Object.freeze({ trek: '1', ekolo: '1' });

/** Vstup konfigurátoru z query (doplnky mohou být opakované i s čárkami). vychoziKola: bez počtů kol použít VYCHOZI_KOLA. */
function inputFromSearchParams(sp, config, { vychoziKola = false } = {}) {
  const q = {};
  for (const k of ['zakladni', 'trek', 'ekolo', 'porizeni', 'web', 'dalsiDesign', 'sprava', 'servis', 'sezona', 'vytizenost', 'cena_zakladni', 'cena_trek', 'cena_ekolo', 'neplatce']) if (sp.has(k)) q[k] = sp.get(k);
  if (sp.has('doplnky')) q.doplnky = sp.getAll('doplnky');
  if (vychoziKola && !['zakladni', 'trek', 'ekolo'].some((k) => sp.has(k))) Object.assign(q, VYCHOZI_KOLA);
  return domain.normalizeInput(q, config);
}

function operatorEmail(tenant) {
  return (tenant.legal && tenant.legal.operatorEmail) || (tenant.business && tenant.business.email) || null;
}

// ---------------------------------------------------------------------------------------------------------
// Veřejné stránky

function renderUnavailable(ctx, status = 200) {
  ctx.render(page.unavailable, { tenant: ctx.tenant }, { title: 'Pro hotely a půjčovny', description: 'Nabídka kol, rezervačního webu, správy a servisu pro hotely, penziony a půjčovny.', feature: 'nabidka', status });
}

async function nabidkaGet(ctx) {
  const st = configFor(ctx);
  if (!st.config) return renderUnavailable(ctx);
  const input = inputFromSearchParams(ctx.url.searchParams, st.config, { vychoziKola: true });
  const result = domain.compute(input, st.config);
  const internal = showInternal(ctx);
  const modely = loadModely();
  if (internal) result.interni.modely = domain.modelyInterni(modely.modely, st.config);
  const priklady = domain.modelovePriklady(st.config, modely.modely);
  return ctx.render(
    page.nabidka,
    { tenant: ctx.tenant, config: st.config, input, result: internal ? result : domain.publicResult(result), internal, csrf: ctx.csrfToken(), values: {}, errors: {}, query: domain.inputToQuery(input), modely: modely.modely, modelyMeta: modely.meta, priklady: internal ? priklady : domain.verejnePriklady(priklady) },
    { title: 'Pro hotely a půjčovny', description: 'Sestavte si nabídku: kola pro hosty, rezervační web, správa a servis – koupě, pronájem nebo zkušební období bez dlouhého závazku.', feature: 'nabidka' }
  );
}

async function spocitatApi(ctx) {
  const st = configFor(ctx);
  if (!st.config) return ctx.json({ ok: false, error: 'Nabídka se připravuje – ceník zatím není k dispozici.' }, 503);
  const input = inputFromSearchParams(ctx.url.searchParams, st.config, { vychoziKola: true });
  const result = domain.compute(input, st.config);
  const internal = showInternal(ctx);
  if (internal) result.interni.modely = domain.modelyInterni(loadModely().modely, st.config);
  const out = internal ? result : domain.publicResult(result);
  return ctx.json({ ok: true, ...out, html: page.summaryFragment({ result: out, internal, config: st.config }).toString() });
}

// ---------------------------------------------------------------------------------------------------------
// Poptávka

/** Validace kontaktního formuláře. Vrací { values, errors }. */
function validate(body) {
  const values = { nazev: str(body.nazev), obec: str(body.obec), osoba: str(body.osoba), email: str(body.email), telefon: str(body.telefon), poznamka: str(body.poznamka), souhlas: body.souhlas === '1' || body.souhlas === 'on' };
  const errors = {};
  const len = (k, msg) => {
    const [min, max] = LIMITS[k];
    if (values[k].length < min || values[k].length > max) errors[k] = msg;
  };
  len('nazev', 'Zadejte prosím název ubytování nebo půjčovny (2–120 znaků).');
  len('obec', 'Zadejte prosím obec (2–80 znaků).');
  len('osoba', 'Zadejte prosím kontaktní osobu (2–100 znaků).');
  if (!EMAIL_RE.test(values.email) || values.email.length > LIMITS.email[1]) errors.email = 'Zadejte prosím platný e-mail, abychom mohli odpovědět.';
  len('telefon', 'Telefon je příliš dlouhý.');
  len('poznamka', 'Poznámka je příliš dlouhá (max. 2000 znaků).');
  if (!values.souhlas) errors.souhlas = 'Bez potvrzení nemůžeme poptávku zpracovat.';
  return { values, errors };
}

/** Číslo poptávky NAB-RRRR-NNNNNN (pořadí v roce podle řádků outboxu typu nabidka). */
function nextNumber(db, now) {
  const year = now.slice(0, 4);
  const n = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = ? AND created_at LIKE ?").get(OUTBOX_TYPE, `${year}%`).n;
  return `NAB-${year}-${String(Number(n) + 1).padStart(6, '0')}`;
}

function fmtKc(n) {
  return `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 }).format(Number(n) || 0)} Kč`;
}

/** Textová rekapitulace pro e-mail provozovateli (bez interních čísel – ty jsou v payloadu). */
function recapText(result) {
  const lines = [];
  lines.push(`Kola: ${result.kola.length ? result.kola.map((k) => `${k.pocet}× ${k.nazev}`).join(', ') : 'žádná'}`);
  lines.push(`Způsob pořízení: ${result.porizeni.label}`);
  lines.push(`Web: ${result.web.label}${result.web.dalsiDesign ? ' + další design' : ''}`);
  lines.push(`Správa: ${result.sprava.label}`);
  lines.push(`Servis: ${result.servis.label}`);
  lines.push(`Doplňky: ${result.doplnky.length ? result.doplnky.map((d) => d.nazev).join(', ') : 'žádné'}`);
  lines.push('');
  lines.push(`Jednorázově: ${fmtKc(result.souhrn.jednorazove)}`);
  lines.push(`Měsíčně: ${fmtKc(result.souhrn.mesicne)}`);
  if (result.souhrn.rocne) lines.push(`Ročně: ${fmtKc(result.souhrn.rocne)}`);
  if (result.souhrn.kauce) lines.push(`Vratná kauce: ${fmtKc(result.souhrn.kauce)}`);
  for (const h of result.souhrn.horizonty) lines.push(`${h.label}: ${fmtKc(h.castka)}`);
  if (result.zkouska) lines.push(`Při pokračování pronájmem se započte: ${fmtKc(result.zkouska.zapocet)}; odkup po zkoušce: ${fmtKc(result.zkouska.odkup)}`);
  const nv = result.navratnost;
  if (nv) lines.push(`Návratnost (odhad klienta: sezóna ${nv.vstupy.sezonaDni} dní, ceny ${['zakladni', 'trek', 'ekolo'].map((id) => nv.vstupy.cenaDen[id]).join(' / ')} Kč/den vč. DPH${nv.vstupy.platceDph ? '' : ', neplátce DPH'}): ${nv.veta.replace(/ /g, ' ')}`);
  return lines.join('\n');
}

/**
 * Uloží poptávku do outboxu (typ nabidka, e-mail provozovateli). Kontaktní údaje šifrované; konfigurace a výsledek
 * v payloadu v čitelné podobě (nejsou osobní). Vrací { id, number, token }.
 */
function enqueueInquiry(db, { tenant, fieldCrypto, values, input, result, ipHash, config }) {
  const now = nowIso();
  const to = operatorEmail(tenant);
  const token = crypto.randomBytes(18).toString('base64url');
  return transaction(db, () => {
    const number = nextNumber(db, now);
    const subject = `Poptávka ${number}: ${result.souhrn.pocetKol} kol, ${result.porizeni.label.toLowerCase()}`;
    const bodyText = [
      `Nová poptávka z konfigurátoru (${tenant.name}) – číslo ${number}.`,
      '',
      `Ubytování / půjčovna: ${values.nazev}`,
      `Obec: ${values.obec}`,
      `Kontaktní osoba: ${values.osoba}`,
      `E-mail: ${values.email}`,
      values.telefon ? `Telefon: ${values.telefon}` : null,
      values.poznamka ? `Poznámka: ${values.poznamka}` : null,
      '',
      'Konfigurace:',
      recapText(result),
      '',
      `Ceník verze ${config.meta.verze}${config.meta.zastupneCeny ? ' (ukázkové ceny)' : ''}, platnost od ${config.meta.platnostOd}.`,
      `Odesláno: ${now}`,
    ]
      .filter((l) => l !== null)
      .join('\n');
    const payload = {
      kind: OUTBOX_TYPE,
      number,
      token,
      to,
      obec: values.obec,
      nazev_enc: fieldCrypto.enc(values.nazev),
      osoba_enc: fieldCrypto.enc(values.osoba),
      reply_to_enc: fieldCrypto.enc(values.email),
      phone_enc: values.telefon ? fieldCrypto.enc(values.telefon) : null,
      note_enc: values.poznamka ? fieldCrypto.enc(values.poznamka) : null,
      konfigurace: input,
      query: domain.inputToQuery(input),
      vysledek: domain.publicResult(result),
      interni: result.interni,
      cenik: { verze: config.meta.verze, platnostOd: config.meta.platnostOd, zastupneCeny: config.meta.zastupneCeny },
      ip_hash: ipHash,
    };
    const r = db
      .prepare('INSERT INTO outbox(type, to_hmac, subject, body_text, body_html, payload, run_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
      .run(OUTBOX_TYPE, to ? fieldCrypto.hmacEmail(to) : null, subject, bodyText, JSON.stringify(payload), now, now);
    return { id: Number(r.lastInsertRowid), number, token };
  });
}

async function poptavkaPost(ctx) {
  const st = configFor(ctx);
  if (!st.config) return renderUnavailable(ctx, 503);
  if (str(ctx.body.web_hp)) {
    ctx.log.info('Poptávka nabídky: honeypot – zahozeno');
    return ctx.redirect('/nabidka?odeslano=hp');
  }
  const sp = new URLSearchParams(str(ctx.body.konfigurace));
  const input = inputFromSearchParams(sp, st.config);
  const result = domain.compute(input, st.config);
  const { values, errors } = validate(ctx.body);
  if (result.souhrn.pocetKol === 0) errors.konfigurace = 'Vyberte prosím alespoň jedno kolo.';
  if (Object.keys(errors).length) {
    const internal = showInternal(ctx);
    return ctx.render(
      page.nabidka,
      { tenant: ctx.tenant, config: st.config, input, result: internal ? result : domain.publicResult(result), internal, csrf: ctx.csrfToken(), values, errors, query: domain.inputToQuery(input) },
      { title: 'Pro hotely a půjčovny', feature: 'nabidka', status: 422 }
    );
  }
  const saved = enqueueInquiry(ctx.db, { tenant: ctx.tenant, fieldCrypto: ctx.app.fieldCrypto, values, input, result, ipHash: ctx.ipHash, config: st.config });
  ctx.log.info('Poptávka nabídky uložena do outboxu', { outboxId: saved.id, number: saved.number, pocetKol: result.souhrn.pocetKol, porizeni: input.porizeni });
  return ctx.redirect(`/nabidka/dekujeme/${saved.token}`);
}

function loadInquiryByToken(db, token) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(token || ''))) return null;
  const row = db.prepare("SELECT * FROM outbox WHERE type = ? AND json_extract(payload, '$.token') = ?").get(OUTBOX_TYPE, token);
  if (!row) return null;
  return { row, payload: parseJson(row.payload, {}) || {} };
}

async function dekujemeGet(ctx) {
  const found = loadInquiryByToken(ctx.db, ctx.params.token);
  if (!found) throw new HttpError(404, 'Poptávka nebyla nalezena.');
  const { row, payload } = found;
  const dec = (v) => {
    try {
      return v ? ctx.app.fieldCrypto.dec(v) : '';
    } catch {
      return '';
    }
  };
  return ctx.render(
    page.dekujeme,
    { tenant: ctx.tenant, number: payload.number, createdAt: row.created_at, nazev: dec(payload.nazev_enc), obec: payload.obec || '', result: payload.vysledek || null, query: payload.query || '', cenik: payload.cenik || {} },
    { title: 'Děkujeme za poptávku', feature: 'nabidka', noindex: true }
  );
}

// ---------------------------------------------------------------------------------------------------------
// Admin: /admin/nabidky

function adminRender(ctx, body, { title, lead, actions, wide }) {
  const shared = require('../render/pages/admin/shared');
  const shellHtml = shared.shell({ title, body, user: ctx.user || null, path: ctx.url.pathname, flash: null, demo: !!ctx.config.demo, csrf: ctx.adminCsrfToken(), tenant: ctx.tenant, lead, actions, wide });
  ctx.render(() => ({ title: `${title} · Administrace`, body: shellHtml, noindex: true, bodyClass: 'admin' }), {}, { feature: 'admin', status: 200 });
}

function decField(ctx, value) {
  try {
    return value ? ctx.app.fieldCrypto.dec(value) : '';
  } catch {
    return '';
  }
}

async function adminList(ctx) {
  const total = ctx.db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE type = ?').get(OUTBOX_TYPE).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const pg = Math.min(pages, Math.max(1, Number.parseInt(str(ctx.query.strana), 10) || 1));
  const rows = ctx.db.prepare('SELECT id, created_at, sent_at, payload FROM outbox WHERE type = ? ORDER BY id DESC LIMIT ? OFFSET ?').all(OUTBOX_TYPE, PAGE_SIZE, (pg - 1) * PAGE_SIZE).map((r) => {
    const p = parseJson(r.payload, {}) || {};
    return { id: r.id, createdAt: r.created_at, sentAt: r.sent_at, number: p.number || `#${r.id}`, nazev: decField(ctx, p.nazev_enc), obec: p.obec || '', payload: p };
  });
  const st = loader.get();
  adminRender(ctx, adminPage.list({ rows, total, page: pg, pages, config: st.config, configError: st.error, interni: vidiInterni(ctx) }), { title: 'Poptávky nabídek', lead: `${total} přijatých poptávek z konfigurátoru /nabidka`, actions: html`<a class="btn btn--secondary btn--sm" href="/nabidka">Otevřít konfigurátor</a>` });
}

async function adminDetail(ctx) {
  const id = Number(ctx.params.id);
  const row = Number.isInteger(id) ? ctx.db.prepare('SELECT * FROM outbox WHERE id = ? AND type = ?').get(id, OUTBOX_TYPE) : null;
  if (!row) throw new HttpError(404, 'Poptávka nebyla nalezena.');
  const p = parseJson(row.payload, {}) || {};
  const contact = { nazev: decField(ctx, p.nazev_enc), obec: p.obec || '', osoba: decField(ctx, p.osoba_enc), email: decField(ctx, p.reply_to_enc), telefon: decField(ctx, p.phone_enc), poznamka: decField(ctx, p.note_enc) };
  ctx.db
    .prepare('INSERT INTO audit_log(at, user_id, action, entity, entity_id, meta, ip_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(nowIso(), ctx.user ? ctx.user.id : null, 'nabidka.view', 'outbox', String(row.id), JSON.stringify({ number: p.number || null, fields: ['nazev', 'osoba', 'email', 'telefon', 'poznamka'] }), ctx.ipHash);
  adminRender(ctx, adminPage.detail({ row, payload: p, contact, interni: vidiInterni(ctx) }), { title: `Poptávka ${p.number || `#${row.id}`}`, lead: contact.nazev ? `${contact.nazev}${contact.obec ? `, ${contact.obec}` : ''}` : '', actions: html`<a class="btn btn--ghost btn--sm" href="/admin/nabidky">← Seznam</a> <a class="btn btn--ghost btn--sm" href="/nabidka?${p.query || ''}">Otevřít v konfigurátoru</a>${ctx.config.platformaHeslo ? html` <a class="btn btn--primary btn--sm" href="/platforma?poptavka=${row.id}#nova-pozvanka">Pozvat do průvodce</a>` : ''}`, wide: true });
}

module.exports = {
  name: 'nabidka',
  routes: [
    ['GET', '/nabidka', nabidkaGet, { rateLimit: 'public' }],
    ['GET', '/api/v1/nabidka/spocitat', spocitatApi, { rateLimit: 'api' }],
    ['POST', '/nabidka/poptavka', poptavkaPost, { csrf: true, rateLimit: 'reservation' }],
    ['GET', '/nabidka/dekujeme/:token', dekujemeGet, { rateLimit: 'public' }],
    ['GET', '/admin/nabidky', admin.guard(adminList), { rateLimit: 'public' }],
    ['GET', '/admin/nabidky/:id', admin.guard(adminDetail), { rateLimit: 'public' }],
  ],
  nav: [{ label: 'Pro hotely a půjčovny', href: '/nabidka', order: 60 }],
  css: ['/css/nabidka.css'],
  js: ['/js/nabidka.js'],
  // pro testy a nástroje
  loader,
  createConfigLoader,
  setConfigPath: (p) => loader.setPath(p),
  setInterniPath: (p) => loader.setInterniPath(p),
  loadModely,
  DEFAULT_CONFIG_PATH,
  MODELY_PATH,
  OUTBOX_TYPE,
  validate,
  enqueueInquiry,
  recapText,
  vidiInterni,
  showInternal,
  LIMITS,
};
