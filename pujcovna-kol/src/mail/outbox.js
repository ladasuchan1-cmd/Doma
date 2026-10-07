'use strict';
// Outbox e-mailů (SPEC kap. 9): zápis do tabulky outbox + render šablon ze src/mail/templates.js.
// Odesílání: src/mail/sender.js (job mail-sender, jen oznámení provozovateli při PK_SMTP_HOST); ostatní zobrazuje admin. Adresa se nikdy neukládá v čitelné podobě:
// outbox.to_hmac = HMAC e-mailu (dedup/hledání), payload.to_enc = AES-GCM šifrovaná adresa pro sender.
// Nikdy nelogovat adresu, jméno ani tělo e-mailu – do logu patří jen id řádku a typ.
//   enqueue(db, { type, to, subject, text, html, payload, runAt, fieldCrypto })            → id
//   buildMailData({ db, reservation, tenant, settings, fieldCrypto, baseUrl, token })      → { data, to }
//   sendReservationMail(db, { type, reservation, tenant, settings, fieldCrypto, baseUrl, token, extra, runAt }) → id|null
//   hasMail(db, type, reservationId) / listForReservation(db, reservationId) / pending(db, limit) / markSent / markFailed
// Vstup: db tenanta, fieldCrypto (src/crypto/fields.js), tenant, settings, baseUrl (https://host), token správy rezervace.

const { nowIso, parseJson } = require('../db');
const templates = require('./templates');

/** Vloží e-mail do outboxu. `to` je prostá adresa (jen v paměti) → to_hmac + payload.to_enc. */
function enqueue(db, { type, to = null, subject, text, html = null, payload = {}, runAt = null, fieldCrypto, now = nowIso() }) {
  if (!type) throw new Error('Outbox: chybí typ e-mailu.');
  if (!subject || !text) throw new Error('Outbox: chybí předmět nebo text e-mailu.');
  if (to && !fieldCrypto) throw new Error('Outbox: pro adresáta je potřeba fieldCrypto.');
  const data = { ...payload };
  if (to) data.to_enc = fieldCrypto.enc(String(to).trim());
  const r = db
    .prepare('INSERT INTO outbox(type, to_hmac, subject, body_text, body_html, payload, run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(String(type), to ? fieldCrypto.hmacEmail(to) : null, String(subject), String(text), html === null || html === undefined ? null : String(html), JSON.stringify(data), runAt || now, now);
  return Number(r.lastInsertRowid);
}

/** Položky rezervace seskupené podle typu a velikosti + příslušenství (z JSON položek). */
function loadItems(db, reservationId) {
  const rows = db
    .prepare(
      `SELECT i.id, i.bike_type_id, i.size, i.bike_id, i.unit_price_minor, i.fee_minor, i.accessories, t.name AS type_name, t.slug AS type_slug, t.category
       FROM reservation_items i JOIN bike_types t ON t.id = i.bike_type_id WHERE i.reservation_id = ? ORDER BY t.sort, t.name, i.size, i.id`
    )
    .all(Number(reservationId));
  const grouped = new Map();
  const accessories = [];
  for (const row of rows) {
    const key = `${row.bike_type_id}|${row.size}`;
    if (!grouped.has(key)) grouped.set(key, { typeId: row.bike_type_id, typeName: row.type_name, typeSlug: row.type_slug, category: row.category, size: row.size, qty: 0, unitPriceMinor: Number(row.unit_price_minor), feeMinor: 0, amountMinor: 0, itemIds: [], bikeIds: [] });
    const g = grouped.get(key);
    g.qty += 1;
    g.amountMinor += Number(row.unit_price_minor);
    g.feeMinor += Number(row.fee_minor);
    g.itemIds.push(row.id);
    if (row.bike_id) g.bikeIds.push(row.bike_id);
    for (const a of parseJson(row.accessories, [])) accessories.push({ slug: a.slug, label: a.label || a.slug, qty: Number(a.qty) || 0, unitPriceMinor: Number(a.unitPriceMinor) || 0, amountMinor: Number(a.amountMinor) || 0 });
  }
  return { items: [...grouped.values()], accessories, rows };
}

/** Sestaví data pro šablony. Jméno a e-mail se dešifrují jen do paměti pro render. */
function buildMailData({ db, reservation, tenant, settings = {}, fieldCrypto, baseUrl, token }) {
  const { items, accessories } = loadItems(db, reservation.id);
  let customer = { name: '' };
  let to = null;
  if (reservation.customer_id) {
    const c = db.prepare('SELECT name_enc, email_enc, anonymized_at FROM customers WHERE id = ?').get(reservation.customer_id);
    if (c && !c.anonymized_at) {
      try {
        customer = { name: fieldCrypto.dec(c.name_enc) || '' };
        to = fieldCrypto.dec(c.email_enc);
      } catch {
        customer = { name: '' };
        to = null;
      }
    }
  }
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const manageUrl = token ? `${base}/rezervace/${encodeURIComponent(token)}` : `${base}/rezervace`;
  return {
    to,
    data: {
      tenant,
      settings,
      baseUrl: base,
      reservation,
      customer,
      items,
      accessories,
      manageUrl,
      icsUrl: token ? `${manageUrl}/kalendar.ics` : null,
    },
  };
}

/**
 * Vyrenderuje šablonu `type` pro rezervaci a uloží do outboxu. extra se přimíchá do dat šablony
 * (payment, cancellation, cancelledBy, document, …); extra.payload do payloadu řádku. Vrací id, nebo null bez adresáta.
 */
function sendReservationMail(db, { type, reservation, tenant, settings, fieldCrypto, baseUrl, token, extra = {}, runAt = null, now }) {
  const { to, data } = buildMailData({ db, reservation, tenant, settings, fieldCrypto, baseUrl, token });
  if (!to) return null;
  const { payload: extraPayload, ...rest } = extra || {};
  const rendered = templates.render(type, { ...data, ...rest });
  return enqueue(db, {
    type,
    to,
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
    payload: { kind: type, reservationId: reservation.id, number: reservation.number, ...(extraPayload || {}) },
    runAt,
    fieldCrypto,
    now,
  });
}

/** Byl už e-mail daného typu pro rezervaci zařazen? */
function hasMail(db, type, reservationId) {
  const row = db.prepare("SELECT 1 AS x FROM outbox WHERE type = ? AND json_extract(payload, '$.reservationId') = ? LIMIT 1").get(String(type), Number(reservationId));
  return !!row;
}

/** E-maily rezervace (bez těla – pro přehled). */
function listForReservation(db, reservationId) {
  return db
    .prepare("SELECT id, type, subject, run_at, sent_at, attempts, error, created_at FROM outbox WHERE json_extract(payload, '$.reservationId') = ? ORDER BY id")
    .all(Number(reservationId));
}

/** Neodeslané e-maily k odeslání (src/mail/sender.js). */
function pending(db, limit = 50, now = nowIso()) {
  return db.prepare('SELECT * FROM outbox WHERE sent_at IS NULL AND run_at <= ? AND attempts < 5 ORDER BY run_at, id LIMIT ?').all(now, Number(limit));
}

function markSent(db, id, now = nowIso()) {
  db.prepare('UPDATE outbox SET sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?').run(now, Number(id));
}

function markFailed(db, id, error) {
  db.prepare('UPDATE outbox SET attempts = attempts + 1, error = ? WHERE id = ?').run(String(error || 'chyba').slice(0, 500), Number(id));
}

module.exports = { enqueue, buildMailData, loadItems, sendReservationMail, hasMail, listForReservation, pending, markSent, markFailed };
