'use strict';
// Feature „kontakt“ (SPEC kap. 8): stránka s adresou, odkazem na mapu, otevírací dobou a formulářem dotazu.
// POST /kontakt (CSRF, rate limit 'reservation') → validace → zpráva do tabulky outbox (type 'contact_inquiry',
// adresát = e-mail půjčovny; kontaktní údaje tazatele v payload šifrované, otisk e-mailu v to_hmac není – jde o
// příchozí dotaz) → redirect /kontakt?odeslano=1. Honeypot pole „web“ (skryté CSS) – vyplněné → tiché zahození.
// Texty: `contactNote` ze settings.texts (admin → Obsah) se zobrazí pod kontaktní kartou (layout.siteTexts).
// Vstup: ctx (body: jmeno, email, telefon, zprava, souhlas, web). Výstup: stránka / redirect.

const { nowIso } = require('../db');
const { siteTexts } = require('../render/layout');
const page = require('../render/pages/kontakt');

const LIMITS = { name: [2, 100], email: [5, 200], phone: [0, 40], message: [10, 2000] };
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Validace formuláře. Vrací { values, errors }. */
function validate(body) {
  const values = { name: str(body.jmeno), email: str(body.email), phone: str(body.telefon), message: str(body.zprava), consent: body.souhlas === '1' || body.souhlas === 'on' };
  const errors = {};
  if (values.name.length < LIMITS.name[0] || values.name.length > LIMITS.name[1]) errors.name = 'Zadejte prosím jméno (2–100 znaků).';
  if (!EMAIL_RE.test(values.email) || values.email.length > LIMITS.email[1]) errors.email = 'Zadejte prosím platný e-mail, abychom mohli odpovědět.';
  if (values.phone.length > LIMITS.phone[1]) errors.phone = 'Telefon je příliš dlouhý.';
  if (values.message.length < LIMITS.message[0]) errors.message = 'Napište prosím zprávu (alespoň 10 znaků).';
  if (values.message.length > LIMITS.message[1]) errors.message = 'Zpráva je příliš dlouhá (max. 2000 znaků).';
  if (!values.consent) errors.consent = 'Bez potvrzení nemůžeme dotaz zpracovat.';
  return { values, errors };
}

/** Uloží dotaz do outboxu (e-mail půjčovně). Vrací id řádku. */
function enqueueInquiry(db, { tenant, fieldCrypto, values, ipHash }) {
  const business = tenant.business || {};
  const now = nowIso();
  const subject = `Dotaz z webu: ${values.name}`;
  const bodyText = [
    `Nový dotaz z kontaktního formuláře (${tenant.name}).`,
    '',
    `Jméno: ${values.name}`,
    `E-mail: ${values.email}`,
    values.phone ? `Telefon: ${values.phone}` : null,
    '',
    'Zpráva:',
    values.message,
    '',
    `Odesláno: ${now}`,
  ]
    .filter((l) => l !== null)
    .join('\n');
  const payload = {
    kind: 'contact_inquiry',
    to: business.email || null,
    reply_to_enc: fieldCrypto.enc(values.email),
    name_enc: fieldCrypto.enc(values.name),
    phone_enc: values.phone ? fieldCrypto.enc(values.phone) : null,
    ip_hash: ipHash,
  };
  const r = db
    .prepare('INSERT INTO outbox(type, to_hmac, subject, body_text, body_html, payload, run_at, created_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?)')
    .run('contact_inquiry', business.email ? fieldCrypto.hmacEmail(business.email) : null, subject, bodyText, JSON.stringify(payload), now, now);
  return Number(r.lastInsertRowid);
}

function renderPage(ctx, { values = {}, errors = {}, sent = false } = {}) {
  ctx.render(
    page.kontakt,
    { tenant: ctx.tenant, texts: siteTexts(ctx), csrf: ctx.csrfToken(), values, errors, sent },
    { title: 'Kontakt', description: `Kontakt a otevírací doba – ${ctx.tenant.name}. Napište nám dotaz k půjčení kola.`, feature: 'kontakt', status: Object.keys(errors).length ? 422 : 200 }
  );
}

async function getHandler(ctx) {
  renderPage(ctx, { sent: ctx.query.odeslano === '1' });
}

async function postHandler(ctx) {
  // honeypot – roboti ho vyplní, lidé ho nevidí
  if (str(ctx.body.web)) {
    ctx.log.info('Kontaktní formulář: honeypot – zahozeno');
    return ctx.redirect('/kontakt?odeslano=1');
  }
  const { values, errors } = validate(ctx.body);
  if (Object.keys(errors).length) return renderPage(ctx, { values, errors });
  const id = enqueueInquiry(ctx.db, { tenant: ctx.tenant, fieldCrypto: ctx.app.fieldCrypto, values, ipHash: ctx.ipHash });
  ctx.log.info('Kontaktní dotaz uložen do outboxu', { outboxId: id });
  return ctx.redirect('/kontakt?odeslano=1');
}

module.exports = {
  name: 'kontakt',
  routes: [
    ['GET', '/kontakt', getHandler, { rateLimit: 'public' }],
    ['POST', '/kontakt', postHandler, { csrf: true, rateLimit: 'reservation' }],
  ],
  nav: [{ label: 'Kontakt', href: '/kontakt', order: 90 }],
  css: ['/css/kontakt.css'],
  js: [],
  validate,
  enqueueInquiry,
  LIMITS,
};
