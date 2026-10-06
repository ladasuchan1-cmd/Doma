'use strict';
// Feature „klienti“ (od 7. 10. 2026): správa platformy a průvodce, kterým si nová půjčovna sama založí web.
//
//   GET  /platforma                           přihlášení heslem PK_PLATFORMA_HESLO, po přihlášení přehled pozvánek a klientů
//                                             (?poptavka=<id> předvyplní pozvánku z poptávky konfigurátoru /nabidka)
//   POST /platforma/prihlaseni | /odhlaseni
//   POST /platforma/pozvanky                  nová pozvánka → stránka s odkazem (jednou) + e-mail do fronty
//   POST /platforma/pozvanky/:id/zrusit
//   POST /platforma/klienti/:slug/stav        náhled / ostrý provoz / pozastaveno
//   GET  /zalozeni/:token                     úvod průvodce
//   GET|POST /zalozeni/:token/:krok           provozovna, adresa, vzhled (multipart s logem), kola, provoz, ucet, kontrola
//   GET  /zalozeni/:token/zpracovatelska-smlouva   náhled zpracovatelské smlouvy s údaji z průvodce
//   GET  /zalozeni/:token/hotovo              výsledek
//
// Platforma i průvodce běží jen na hostech platformy (tenanti z repa), nikdy na webu klienta. /platforma je bez
// PK_PLATFORMA_HESLO vypnutá (404) – demo heslo administrace je veřejné, proto má platforma vlastní přihlášení
// (session „platform“, cookie __Host-pk_plat, SameSite=Strict, idle 30 min). Rozpracovaný průvodce je v platformní DB
// šifrovaně (fieldCrypto), heslo správce jen jako scrypt otisk. Log nikdy neobsahuje e-mail, jméno, IČO ani token.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError } = require('../http/errors');
const { hashPassword } = require('../crypto/passwords');
const { ibanFromCzAccount } = require('../payments/bank-transfer');
const { enqueue } = require('../mail/outbox');
const { parseJson } = require('../db');
const { isTheme } = require('../themes');
const k = require('../klienti');
const page = require('../render/pages/klienti');

const ROOT = path.join(__dirname, '..', '..');
const MODELY_PATH = path.join(ROOT, 'config', 'kola-modely.json');
const LOGO_MAX_BYTES = 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const KROKY = page.KROKY;
const KROK_IDS = KROKY.map((x) => x.id);

function str(v, max = 500) {
  const s = typeof v === 'string' ? v : Array.isArray(v) ? v[0] : '';
  return String(s || '').trim().slice(0, max);
}

function modely() {
  try {
    const j = JSON.parse(fs.readFileSync(MODELY_PATH, 'utf8'));
    return (Array.isArray(j.modely) ? j.modely : []).filter((m) => m && typeof m.slug === 'string');
  } catch {
    return [];
  }
}

/** Platforma a průvodce jen na hostech platformy, ne na webech klientů. */
function requirePlatformHost(ctx) {
  if (ctx.klient) throw new HttpError(404);
}

// ---------------------------------------------------------------------------------------------------------
// Správa platformy

function platformEnabled(ctx) {
  return !!ctx.config.platformaHeslo;
}

function isPlatformAdmin(ctx) {
  try {
    return ctx.platformSession.get('ok') === true;
  } catch {
    return false;
  }
}

function checkPassword(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b) && !!expected;
}

function requirePlatform(ctx) {
  requirePlatformHost(ctx);
  if (!platformEnabled(ctx)) throw new HttpError(404);
  if (!isPlatformAdmin(ctx)) throw new HttpError(403, 'Přihlaste se prosím do správy platformy.');
}

function renderPlatform(ctx, pageFn, data, title = 'Správa platformy', status = 200) {
  ctx.render(pageFn, data, { title, feature: 'klienti', noindex: true, status });
}

function platformBase(ctx) {
  const host = ctx.req.headers.host || ctx.tenant.hosts[0];
  return `${ctx.secure || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host) ? 'https' : 'http'}://${host}`;
}

/** Předvyplnění pozvánky z poptávky konfigurátoru (/admin/nabidky/:id) – dešifruje název a e-mail z outboxu. */
function prefillFromInquiry(ctx, id) {
  const row = Number.isInteger(id) ? ctx.db.prepare("SELECT payload FROM outbox WHERE id = ? AND type = 'nabidka'").get(id) : null;
  if (!row) return {};
  const p = parseJson(row.payload, {}) || {};
  const dec = (x) => {
    try {
      return x ? ctx.app.fieldCrypto.dec(x) : '';
    } catch {
      return '';
    }
  };
  return { nazev: dec(p.nazev_enc), email: dec(p.reply_to_enc), poznamka: p.number ? `Poptávka ${p.number}${p.obec ? `, ${p.obec}` : ''}` : '' };
}

async function platformaGet(ctx) {
  requirePlatformHost(ctx);
  if (!platformEnabled(ctx)) throw new HttpError(404);
  if (!isPlatformAdmin(ctx)) return renderPlatform(ctx, page.platformLogin, { csrf: ctx.csrfToken(), error: null });
  const pdb = ctx.app.platformDb;
  const flashKey = ctx.platformSession.get('flash');
  if (flashKey) ctx.platformSession.delete('flash');
  const prefill = ctx.query.poptavka ? prefillFromInquiry(ctx, Number(ctx.query.poptavka)) : {};
  return renderPlatform(ctx, page.platformDashboard, {
    csrf: ctx.platformCsrfToken(),
    invites: k.listInvites(pdb, ctx.app.fieldCrypto),
    clients: k.listClients(pdb, ctx.app.fieldCrypto),
    prefill,
    flash: flashKey || null,
    domena: ctx.config.klientiDomena,
  });
}

async function prihlaseniPost(ctx) {
  requirePlatformHost(ctx);
  if (!platformEnabled(ctx)) throw new HttpError(404);
  if (!checkPassword(str(ctx.body.heslo, 200), ctx.config.platformaHeslo)) {
    k.audit(ctx.app.platformDb, 'platforma.prihlaseni.neuspech', {}, ctx.ipHash);
    ctx.log.warn('Správa platformy: neúspěšné přihlášení');
    return renderPlatform(ctx, page.platformLogin, { csrf: ctx.csrfToken(), error: 'Heslo nesouhlasí.' }, 'Správa platformy', 401);
  }
  ctx.platformSession.regenerate();
  ctx.platformSession.set('ok', true);
  if (ctx.app.rateLimiter) ctx.app.rateLimiter.reset(ctx.ip, 'login');
  k.audit(ctx.app.platformDb, 'platforma.prihlaseni', {}, ctx.ipHash);
  return ctx.redirect('/platforma');
}

async function odhlaseniPost(ctx) {
  requirePlatformHost(ctx);
  ctx.platformSession.destroy();
  return ctx.redirect('/platforma');
}

function inviteMail({ link, nazev, expiresAt }) {
  const subject = 'Pozvánka: založte si web půjčovny kol';
  const text = [
    'Dobrý den,',
    '',
    `posíláme odkaz na průvodce, ve kterém si${nazev ? ` pro ${nazev}` : ''} za zhruba 10 minut založíte vlastní web půjčovny kol s online rezervacemi:`,
    '',
    link,
    '',
    `Odkaz platí do ${new Date(expiresAt).toLocaleDateString('cs-CZ')} a jde použít jednou; rozpracovaný průvodce se ukládá.`,
    'Web se spustí v náhledovém provozu (platby jsou zatím zkušební); ostrý provoz zapneme po podpisu smlouvy.',
    '',
    'S pozdravem',
  ].join('\n');
  return { subject, text };
}

async function pozvankaPost(ctx) {
  requirePlatform(ctx);
  const nazev = str(ctx.body.nazev, 120);
  const email = str(ctx.body.email, 200).toLowerCase();
  const poznamka = str(ctx.body.poznamka, 500);
  if (nazev.length < 2 || !EMAIL_RE.test(email)) {
    ctx.platformSession.set('flash', { text: 'Vyplňte prosím název a platný e-mail klienta.', tone: 'warning' });
    return ctx.redirect('/platforma#nova-pozvanka');
  }
  const pdb = ctx.app.platformDb;
  const inv = k.createInvite(pdb, { email, nazev, poznamka, fieldCrypto: ctx.app.fieldCrypto });
  const link = `${platformBase(ctx)}/zalozeni/${inv.token}`;
  const mail = inviteMail({ link, nazev, expiresAt: inv.expiresAt });
  enqueue(ctx.db, { type: 'pozvanka', to: email, subject: mail.subject, text: mail.text, payload: { pozvanka: inv.id }, fieldCrypto: ctx.app.fieldCrypto });
  k.audit(pdb, 'pozvanka.vytvorena', { id: inv.id }, ctx.ipHash);
  ctx.log.info('Pozvánka do průvodce vytvořena', { id: inv.id });
  const mailto = `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(mail.subject)}&body=${encodeURIComponent(mail.text)}`;
  return renderPlatform(ctx, page.inviteCreated, { link, email, nazev, expiresAt: inv.expiresAt, mailto }, 'Pozvánka je připravená');
}

async function zrusitPost(ctx) {
  requirePlatform(ctx);
  const ok = k.revokeInvite(ctx.app.platformDb, Number(ctx.params.id));
  if (ok) k.audit(ctx.app.platformDb, 'pozvanka.zrusena', { id: Number(ctx.params.id) }, ctx.ipHash);
  ctx.platformSession.set('flash', ok ? { text: 'Pozvánka zrušena.', tone: 'success' } : { text: 'Pozvánku nejde zrušit (už je použitá nebo zrušená).', tone: 'warning' });
  return ctx.redirect('/platforma#pozvanky');
}

async function stavPost(ctx) {
  requirePlatform(ctx);
  const stav = str(ctx.body.stav, 20);
  if (!k.STAVY.includes(stav)) throw new HttpError(400, 'Neznámý stav.');
  const ok = k.setClientState(ctx.app, ctx.params.slug, stav, ctx.ipHash);
  if (!ok) throw new HttpError(404, 'Klient nenalezen.');
  ctx.log.info('Stav webu klienta změněn', { slug: ctx.params.slug, stav });
  ctx.platformSession.set('flash', { text: `Stav webu ${ctx.params.slug}: ${k.STAV_LABELS[stav]}.`, tone: 'success' });
  return ctx.redirect(`/platforma#klient-${ctx.params.slug}`);
}

// ---------------------------------------------------------------------------------------------------------
// Průvodce

/** Pozvánka z odkazu; neplatná / použitá / prošlá → odpovídající stránka (vrací null, odpověď je odeslaná). */
function loadInvite(ctx) {
  requirePlatformHost(ctx);
  const pdb = ctx.app.platformDb;
  const row = k.findInvite(pdb, ctx.params.token);
  const stav = k.inviteStatus(row);
  if (!row) {
    ctx.render(page.wizardBlocked, { title: 'Odkaz neplatí', text: 'Tento odkaz do průvodce neznáme. Zkontrolujte, že jste ho zkopírovali celý, nebo nám napište o nový.' }, { title: 'Odkaz neplatí', feature: 'klienti', noindex: true, status: 404 });
    return null;
  }
  if (stav === 'pouzita') {
    const kl = pdb.prepare('SELECT host FROM klienti WHERE slug = ?').get(row.tenant_slug);
    ctx.render(page.wizardBlocked, { title: 'Web už je založený', text: 'Tento odkaz už byl použit. Web běží na adrese níže; do administrace se přihlásíte e-mailem a heslem z průvodce.', link: kl ? { label: `Otevřít ${kl.host}`, href: `https://${kl.host}` } : null }, { title: 'Web už je založený', feature: 'klienti', noindex: true, status: 410 });
    return null;
  }
  if (stav !== 'platna') {
    ctx.render(page.wizardBlocked, { title: stav === 'vyprsela' ? 'Platnost odkazu vypršela' : 'Odkaz byl zrušen', text: 'Napište nám prosím a pošleme nový odkaz. Rozpracované údaje se nepřenášejí.' }, { title: 'Odkaz neplatí', feature: 'klienti', noindex: true, status: 410 });
    return null;
  }
  return row;
}

function doneMap(draft) {
  return draft.hotovo && typeof draft.hotovo === 'object' ? draft.hotovo : {};
}

function firstUndone(draft) {
  const done = doneMap(draft);
  return KROK_IDS.find((id) => id !== 'kontrola' && !done[id]) || 'kontrola';
}

function wizardRender(ctx, data, status = 200) {
  const krok = KROKY[data.index];
  ctx.render(page.wizardStep, data, { title: `Založení webu – ${krok.label}`, feature: 'klienti', noindex: true, status });
}

function stepData(ctx, row, draft, krok, extra = {}) {
  const index = KROK_IDS.indexOf(krok);
  const d = { ...(draft[krok] || {}) };
  if (krok === 'ucet') {
    if (!d.email && row.email_enc) d.email = (() => {
      try {
        return ctx.app.fieldCrypto.dec(row.email_enc);
      } catch {
        return '';
      }
    })();
  }
  if (krok === 'provozovna' && !d.nazev && row.nazev) d.nazev = row.nazev;
  const p = draft.provozovna || {};
  return {
    token: ctx.params.token,
    krok,
    index,
    done: doneMap(draft),
    csrf: ctx.csrfToken(),
    errors: {},
    d,
    draft,
    domena: ctx.config.klientiDomena,
    modely: modely(),
    navrh: krok === 'adresa' ? suggestFree(ctx, p) : '',
    maLogo: !!(draft.vzhled && draft.vzhled.logo),
    ...extra,
  };
}

/** Navrhne volnou subdoménu (z webu nebo názvu; obsazenou doplní číslem). */
function suggestFree(ctx, p) {
  const base = k.suggestSlug({ web: p.web, nazev: p.nazev });
  if (!base) return '';
  const free = (s) => k.isSlugFree({ slug: s, tenants: ctx.app.tenants, pdb: ctx.app.platformDb, domena: ctx.config.klientiDomena });
  if (free(base)) return base;
  for (let i = 2; i < 10; i++) if (free(`${base.slice(0, 27)}${i}`)) return `${base.slice(0, 27)}${i}`;
  return '';
}

async function introGet(ctx) {
  const row = loadInvite(ctx);
  if (!row) return undefined;
  const draft = k.loadDraft(row, ctx.app.fieldCrypto);
  return ctx.render(page.wizardIntro, { token: ctx.params.token, nazev: row.nazev, firstStep: firstUndone(draft), rozpracovano: !!row.draft_enc }, { title: 'Založení webu půjčovny', feature: 'klienti', noindex: true });
}

async function krokGet(ctx) {
  const krok = ctx.params.krok;
  if (krok === 'zpracovatelska-smlouva') return smlouvaGet(ctx);
  if (krok === 'hotovo') return hotovoGet(ctx);
  if (!KROK_IDS.includes(krok)) throw new HttpError(404);
  const row = loadInvite(ctx);
  if (!row) return undefined;
  const draft = k.loadDraft(row, ctx.app.fieldCrypto);
  // kroky jdou popořadě: nedokončený předchozí krok → přesměrovat na první nehotový
  const first = firstUndone(draft);
  if (KROK_IDS.indexOf(krok) > KROK_IDS.indexOf(first)) return ctx.redirect(`/zalozeni/${ctx.params.token}/${first}`);
  return wizardRender(ctx, stepData(ctx, row, draft, krok));
}

// --- validace kroků (vrací { values, errors }) ---

function vProvozovna(b) {
  const v = {
    nazev: str(b.nazev, 80),
    firma: str(b.firma, 120),
    ico: str(b.ico, 12).replace(/\s+/g, ''),
    dic: str(b.dic, 14).replace(/\s+/g, '').toUpperCase(),
    platceDph: b.platceDph === '1' || b.platceDph === 'on',
    sidlo: str(b.sidlo, 200),
    provozovna: str(b.provozovna, 200),
    email: str(b.email, 200).toLowerCase(),
    telefon: str(b.telefon, 30),
    zastupce: str(b.zastupce, 120),
    web: str(b.web, 200),
    ucet: str(b.ucet, 30).replace(/\s+/g, ''),
    banka: str(b.banka, 80),
    iban: '',
  };
  const e = {};
  if (v.nazev.length < 2) e.nazev = 'Zadejte název, pod kterým vás znají hosté.';
  if (v.firma.length < 2) e.firma = 'Zadejte obchodní firmu nebo jméno podnikatele.';
  if (!k.isValidIco(v.ico)) e.ico = 'IČO má 8 číslic a musí projít kontrolou – zkontrolujte ho prosím.';
  if (v.platceDph && !/^CZ\d{8,10}$/.test(v.dic)) e.dic = 'Plátce DPH potřebuje DIČ ve tvaru CZ a 8–10 číslic.';
  if (v.sidlo.length < 5) e.sidlo = 'Zadejte adresu sídla.';
  if (!EMAIL_RE.test(v.email)) e.email = 'Zadejte platný e-mail.';
  if ((v.telefon.match(/\d/g) || []).length < 9) e.telefon = 'Zadejte telefon (alespoň 9 číslic).';
  if (v.web && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(v.web)) e.web = 'Zadejte adresu webu, např. utridubu.cz.';
  if (v.ucet) {
    try {
      v.iban = ibanFromCzAccount(v.ucet);
    } catch {
      e.ucet = 'Číslo účtu nesouhlasí – zadejte ho ve tvaru 19-2000145399/0800.';
    }
  }
  return { values: v, errors: e };
}

function vAdresa(ctx, b) {
  const v = { slug: str(b.slug, 40).toLowerCase(), polohaText: str(b.poloha, 400), poloha: null };
  const e = {};
  if (!k.isValidSlug(v.slug)) e.slug = 'Adresa musí mít 3–30 znaků: malá písmena bez diakritiky, číslice a pomlčka (ne na začátku ani na konci). Některé adresy (www, admin, demo…) jsou rezervované.';
  else if (!k.isSlugFree({ slug: v.slug, tenants: ctx.app.tenants, pdb: ctx.app.platformDb, domena: ctx.config.klientiDomena })) e.slug = 'Tato adresa je už obsazená – zvolte prosím jinou.';
  v.poloha = k.parseLocation(v.polohaText);
  if (!v.poloha) e.poloha = 'Polohu se nepodařilo přečíst. Vložte odkaz z Mapy.cz (s parametry x a y), z Google Map (s @šířka,délka) nebo souřadnice „49.0035, 14.7708“.';
  return { values: v, errors: e };
}

function vVzhled(b, prev = {}) {
  const v = { design: str(b.design, 20), claim: str(b.claim, 80), nadpis: str(b.nadpis, 90), text: str(b.text, 300), logo: prev.logo || null };
  const e = {};
  if (!isTheme(v.design)) e.design = 'Vyberte jeden ze tří designů.';
  if (b.smazatLogo === '1' || b.smazatLogo === 'on') v.logo = null;
  const f = b.logo;
  if (f && typeof f === 'object' && f.data) {
    if (f.data.length > LOGO_MAX_BYTES) e.logo = 'Logo je větší než 1 MB – zmenšete ho prosím.';
    else {
      const ext = k.sniffImage(f.data);
      if (!ext) e.logo = 'Logo musí být obrázek PNG, JPG nebo WebP.';
      else v.logo = { ext, b64: f.data.toString('base64') };
    }
  }
  return { values: v, errors: e };
}

function vKola(b, list) {
  const volby = [];
  const e = {};
  let celkem = 0;
  for (const m of list) {
    const pocetRaw = str(b[`pocet_${m.slug}`], 6);
    const cenaRaw = str(b[`cena_${m.slug}`], 8);
    const pocet = pocetRaw === '' ? 0 : Number(pocetRaw);
    const cena = Number(cenaRaw);
    if (!Number.isInteger(pocet) || pocet < 0 || pocet > 50) e[`pocet_${m.slug}`] = 'Počet 0–50 kusů.';
    if (pocet > 0 && (!Number.isFinite(cena) || cena < 50 || cena > 5000)) e[`cena_${m.slug}`] = 'Cena 50–5 000 Kč za den.';
    const def = m.pujcovna && Array.isArray(m.pujcovna.den) ? m.pujcovna.den[0] : 500;
    volby.push({ slug: m.slug, pocet: Number.isInteger(pocet) ? pocet : 0, cenaDen: Number.isFinite(cena) && cena >= 50 && cena <= 5000 ? Math.round(cena) : def });
    if (Number.isInteger(pocet) && pocet > 0) celkem += pocet;
  }
  if (!celkem && !Object.keys(e).length) e.kola = 'Zadejte alespoň u jednoho modelu počet kusů.';
  return { values: { volby }, errors: e };
}

function vProvoz(b) {
  const t = (x) => {
    const s = str(x, 5);
    return /^\d{2}:\d{2}$/.test(s) ? s : '';
  };
  const v = { vsedniOd: t(b.vsedniOd), vsedniDo: t(b.vsedniDo), vikendOd: t(b.vikendOd), vikendDo: t(b.vikendDo), poplatek: Number(str(b.poplatek, 6)), poplatekEkolo: Number(str(b.poplatekEkolo, 6)) };
  const e = {};
  const pair = (od, d, key) => {
    if (!od && !d) return false;
    if (!od || !d || od >= d) e[key] = 'Zadejte čas od a do (do musí být později), nebo nechte obě pole prázdná = zavřeno.';
    return true;
  };
  const otevrenoV = pair(v.vsedniOd, v.vsedniDo, 'vsedniDo');
  const otevrenoW = pair(v.vikendOd, v.vikendDo, 'vikendDo');
  if (!otevrenoV && !otevrenoW && !e.vsedniDo && !e.vikendDo) e.vsedniOd = 'Alespoň jeden den v týdnu musí být otevřeno.';
  if (!Number.isFinite(v.poplatek) || v.poplatek < 100 || v.poplatek > 1000) e.poplatek = 'Poplatek 100–1 000 Kč.';
  if (!Number.isFinite(v.poplatekEkolo) || v.poplatekEkolo < 100 || v.poplatekEkolo > 1500) e.poplatekEkolo = 'Poplatek 100–1 500 Kč.';
  return { values: v, errors: e };
}

function vUcet(b, prev = {}) {
  const v = { jmeno: str(b.jmeno, 80), email: str(b.email, 200).toLowerCase(), souhlas: b.souhlas === '1' || b.souhlas === 'on', passwordHash: prev.passwordHash || null };
  const e = {};
  const heslo = typeof b.heslo === 'string' ? b.heslo : '';
  const heslo2 = typeof b.heslo2 === 'string' ? b.heslo2 : '';
  if (v.jmeno.length < 2) e.jmeno = 'Zadejte své jméno.';
  if (!EMAIL_RE.test(v.email)) e.email = 'Zadejte platný e-mail.';
  if (heslo || !v.passwordHash) {
    if (heslo.length < 12) e.heslo = 'Heslo musí mít alespoň 12 znaků.';
    else if (heslo.length > 200) e.heslo = 'Heslo je příliš dlouhé.';
    else if (heslo !== heslo2) e.heslo2 = 'Hesla se neshodují.';
    else v.passwordHash = hashPassword(heslo);
  }
  if (!v.souhlas) e.souhlas = 'Bez souhlasu se smlouvami web založit nejde.';
  return { values: v, errors: e };
}

async function krokPost(ctx) {
  const krok = ctx.params.krok;
  if (!KROK_IDS.includes(krok)) throw new HttpError(404);
  const row = loadInvite(ctx);
  if (!row) return undefined;
  const pdb = ctx.app.platformDb;
  const fc = ctx.app.fieldCrypto;
  const draft = k.loadDraft(row, fc);
  const first = firstUndone(draft);
  if (KROK_IDS.indexOf(krok) > KROK_IDS.indexOf(first)) return ctx.redirect(`/zalozeni/${ctx.params.token}/${first}`);
  if (krok === 'kontrola') return spustit(ctx, row, draft);

  const b = ctx.body || {};
  let r;
  if (krok === 'provozovna') r = vProvozovna(b);
  else if (krok === 'adresa') r = vAdresa(ctx, b);
  else if (krok === 'vzhled') r = vVzhled(b, draft.vzhled);
  else if (krok === 'kola') r = vKola(b, modely());
  else if (krok === 'provoz') r = vProvoz(b);
  else r = vUcet(b, draft.ucet);

  if (Object.keys(r.errors).length) {
    // vrátit vyplněné hodnoty (bez hesel); nahrané logo z tohoto pokusu se zahodí
    const d = { ...r.values };
    delete d.passwordHash;
    return wizardRender(ctx, stepData(ctx, row, draft, krok, { d, errors: r.errors }), 422);
  }
  draft[krok] = r.values;
  draft.hotovo = { ...doneMap(draft), [krok]: true };
  k.saveDraft(pdb, row.id, draft, fc);
  const next = firstUndone(draft);
  return ctx.redirect(`/zalozeni/${ctx.params.token}/${KROK_IDS.indexOf(next) > KROK_IDS.indexOf(krok) ? next : KROK_IDS[KROK_IDS.indexOf(krok) + 1] || 'kontrola'}`);
}

function spustit(ctx, row, draft) {
  const done = doneMap(draft);
  const missing = KROK_IDS.filter((id) => id !== 'kontrola' && !done[id]);
  if (missing.length) return ctx.redirect(`/zalozeni/${ctx.params.token}/${missing[0]}`);
  // subdoména mohla mezitím zmizet (jiný klient) → zpět na krok adresa
  if (!k.isSlugFree({ slug: draft.adresa.slug, tenants: ctx.app.tenants, pdb: ctx.app.platformDb, domena: ctx.config.klientiDomena })) {
    draft.hotovo = { ...done, adresa: false };
    k.saveDraft(ctx.app.platformDb, row.id, draft, ctx.app.fieldCrypto);
    return wizardRender(ctx, stepData(ctx, row, draft, 'adresa', { d: draft.adresa, errors: { slug: 'Tato adresa byla mezitím obsazena – zvolte prosím jinou.' } }), 409);
  }
  const logo = draft.vzhled && draft.vzhled.logo ? { ext: draft.vzhled.logo.ext, buf: Buffer.from(draft.vzhled.logo.b64, 'base64') } : null;
  let created;
  try {
    created = k.createClient({ app: ctx.app, invite: row, draft, modely: modely(), logo, ipHash: ctx.ipHash });
  } catch (e) {
    ctx.log.error('Založení webu klienta selhalo', { pozvanka: row.id, error: e.message });
    return wizardRender(ctx, stepData(ctx, row, draft, 'kontrola', { errors: { _form: 'Web se nepodařilo založit. Zkuste to prosím za chvíli znovu, případně nám napište.' } }), 500);
  }
  const { tenant, seeded } = created;
  const host = tenant.hosts[0];
  ctx.log.info('Web klienta založen průvodcem', { slug: tenant.slug, pozvanka: row.id, typy: seeded.typy, kusy: seeded.kusy });
  // e-maily do front: klientovi (DB klienta) a provozovateli platformy (DB platformy)
  try {
    const u = draft.ucet || {};
    enqueue(ctx.app.dbs.get(tenant.slug), { type: 'vitejte', to: u.email, subject: `Váš web půjčovny běží: ${host}`, text: [`Dobrý den,`, '', `web ${tenant.name} je založený a běží v náhledovém provozu:`, '', `Web pro hosty: https://${host}`, `Administrace: https://${host}/admin`, '', 'Přihlaste se e-mailem a heslem z průvodce. Ostrý provoz s platbami zapneme po podpisu smlouvy.'].join('\n'), payload: { slug: tenant.slug }, fieldCrypto: ctx.app.fieldCrypto });
    enqueue(ctx.db, { type: 'klient-zalozen', to: (ctx.tenant.legal && ctx.tenant.legal.operatorEmail) || null, subject: `Nový klient: ${tenant.name} (${host})`, text: [`Průvodcem byl založen nový web: ${tenant.name}`, `Adresa: https://${host}`, `Kola: ${seeded.typy} typů, ${seeded.kusy} kusů`, '', 'Stav: náhledový provoz. Ostrý provoz zapněte ve správě platformy (/platforma) po podpisu smlouvy.'].join('\n'), payload: { slug: tenant.slug }, fieldCrypto: ctx.app.fieldCrypto });
  } catch (e) {
    ctx.log.warn('E-maily o založení webu se nepodařilo zařadit', { slug: tenant.slug, error: e.message });
  }
  return ctx.redirect(`/zalozeni/${ctx.params.token}/hotovo`);
}

async function hotovoGet(ctx) {
  requirePlatformHost(ctx);
  const pdb = ctx.app.platformDb;
  const row = k.findInvite(pdb, ctx.params.token);
  if (!row || !row.used_at) return introGet(ctx);
  const kl = pdb.prepare('SELECT * FROM klienti WHERE slug = ?').get(row.tenant_slug);
  if (!kl) throw new HttpError(404);
  const db = ctx.app.dbs.get(kl.slug);
  const kusy = db ? db.prepare('SELECT COUNT(*) AS n FROM bikes').get().n : 0;
  return ctx.render(page.wizardDone, { host: kl.host, nazev: kl.nazev, kusy }, { title: 'Hotovo – web běží', feature: 'klienti', noindex: true });
}

/** Náhled zpracovatelské smlouvy s údaji z průvodce (provozovatel = platforma, správce = klient). */
async function smlouvaGet(ctx) {
  const row = loadInvite(ctx);
  if (!row) return undefined;
  const draft = k.loadDraft(row, ctx.app.fieldCrypto);
  const pravni = require('./pravni');
  const pravniPage = require('../render/pages/pravni');
  const platformTenant = ctx.tenant;
  const slug = (draft.adresa && draft.adresa.slug) || 'vasepujcovna';
  const p = draft.provozovna || {};
  const json = k.buildTenantJson({ slug, draft: { ...draft, provozovna: { nazev: p.nazev || 'Vaše půjčovna', ...p } }, platformTenant, domena: ctx.config.klientiDomena, logoFile: null, today: new Date().toISOString().slice(0, 10) });
  const tenant = { ...json, hosts: json.hosts };
  const params = pravni.legalParams(tenant, json.settings);
  const doc = pravni.renderLegal('zpracovatelska-smlouva', params);
  return ctx.render(pravniPage.legal, { title: doc.title || 'Zpracovatelská smlouva', lead: 'Náhled s údaji, které jste zatím vyplnili v průvodci. Prázdná místa se doplní z dalších kroků.', doc, version: params.VERZE, effectiveFrom: params.UCINNOST_OD, demo: false, toc: true }, { title: 'Zpracovatelská smlouva', feature: 'pravni', noindex: true });
}

const LOGO_BODY_LIMIT = LOGO_MAX_BYTES + 256 * 1024;

/** Krok „vzhled“ má vlastní routu (multipart s logem, vyšší limit těla) – bez parametru :krok. */
async function vzhledPost(ctx) {
  ctx.params.krok = 'vzhled';
  return krokPost(ctx);
}

module.exports = {
  name: 'klienti',
  routes: [
    ['GET', '/platforma', platformaGet, { rateLimit: 'public' }],
    ['POST', '/platforma/prihlaseni', prihlaseniPost, { csrf: true, rateLimit: 'login' }],
    ['POST', '/platforma/odhlaseni', odhlaseniPost, { csrf: true, csrfSession: 'platform', rateLimit: 'public' }],
    ['POST', '/platforma/pozvanky', pozvankaPost, { csrf: true, csrfSession: 'platform', rateLimit: 'reservation' }],
    ['POST', '/platforma/pozvanky/:id/zrusit', zrusitPost, { csrf: true, csrfSession: 'platform', rateLimit: 'reservation' }],
    ['POST', '/platforma/klienti/:slug/stav', stavPost, { csrf: true, csrfSession: 'platform', rateLimit: 'reservation' }],
    ['GET', '/zalozeni/:token', introGet, { rateLimit: 'public' }],
    ['GET', '/zalozeni/:token/:krok', krokGet, { rateLimit: 'public' }],
    ['POST', '/zalozeni/:token/vzhled', vzhledPost, { csrf: true, rateLimit: 'reservation', multipart: true, bodyLimitBytes: LOGO_BODY_LIMIT }],
    ['POST', '/zalozeni/:token/:krok', krokPost, { csrf: true, rateLimit: 'reservation' }],
  ],
  nav: [],
  css: ['/css/klienti.css'],
  js: [],
  // pro testy a nástroje
  checkPassword,
  vProvozovna,
  vAdresa,
  vVzhled,
  vKola,
  vProvoz,
  vUcet,
};
