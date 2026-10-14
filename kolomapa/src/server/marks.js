'use strict';
// Stav výkupu u inzerátu – sdílený pro celý obchod, ať se lidé netočí na stejném kole: kdo prodávajícího oslovil,
// domluvil prohlídku, kolo koupil, nebo ho nechce řešit. Ke stavu patří krátká poznámka („odmítl 26 tis.“),
// kdo a kdy ho nastavil; každá změna se zapíše do historie (listing_mark_log).
//
// Souběh: klient posílá `expect` = čas stavu, který viděl (null = žádný). Když mezitím stav změnil někdo jiný,
// zápis se neprovede a vrátí se conflict s aktuálním stavem – kolegovo „koupeno“ tak nepřepíše starší okno s „osloveno“.

const { tx, nowIso, parseJson } = require('../db');

/** Stavy v pořadí, jak jdou po sobě; popisky pro UI a hlášky. */
const STATUSES = {
  contacted: 'Osloveno',
  scheduled: 'Domluveno',
  bought: 'Koupeno',
  rejected: 'Nechceme',
};
const NOTE_MAX = 500;
const USER_MAX = 120;
const LOG_LIMIT = 30;
/** Stavy zmizelých inzerátů se do mapy posílají ještě tolik dní (prodávající mohl kolo vložit znovu). */
const GONE_DAYS = 60;

class MarkError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'MarkError';
    this.status = status;
  }
}

/** Kód stavu, null (= zrušit stav), jinak chyba. */
function normalizeStatus(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'string' && Object.hasOwn(STATUSES, v)) return v;
  throw new MarkError(400, `Neznámý stav „${String(v).slice(0, 30)}“ – povolené jsou ${Object.keys(STATUSES).join(', ')}.`);
}

/** Poznámka: text bez řídicích znaků, nejvýš 2 prázdné řádky za sebou, ořezaná; prázdná → null. */
function cleanNote(v) {
  if (v == null) return null;
  if (typeof v !== 'string') throw new MarkError(400, 'Poznámka musí být text.');
  const s = v
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!s) return null;
  if (s.length > NOTE_MAX) throw new MarkError(400, `Poznámka je moc dlouhá (${s.length} znaků, nejvýš ${NOTE_MAX}).`);
  return s;
}

function cleanUser(v) {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  return s ? s.slice(0, USER_MAX) : null;
}

/** Řádek → stav pro API (krátké klíče jako u inzerátů v mapě). */
function markOut(r) {
  if (!r) return null;
  const o = { s: r.status, at: r.at };
  if (r.note) o.n = r.note;
  if (r.by_user) o.by = r.by_user;
  return o;
}

function logOut(r) {
  const o = { s: r.status || null, at: r.at };
  if (r.note) o.n = r.note;
  if (r.by_user) o.by = r.by_user;
  return o;
}

/**
 * Stav a historie jednoho inzerátu.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {{mark: object|null, log: object[]}}
 */
function getMark(db, id) {
  const cur = db.prepare('SELECT status, note, by_user, at FROM listing_marks WHERE listing_id = ?').get(Number(id));
  const log = db
    .prepare('SELECT status, note, by_user, at FROM listing_mark_log WHERE listing_id = ? ORDER BY id DESC LIMIT ?')
    .all(Number(id), LOG_LIMIT)
    .map(logOut);
  return { mark: markOut(cur), log };
}

/**
 * Stavy všech inzerátů, které jsou na mapě (aktivní a zmizelé za posledních GONE_DAYS dní). K inzerátu i titulek,
 * značka, model, cena, kraj, místo a poloha – UI podle nich pozná, že prodávající stejné kolo vložil znovu pod novým
 * inzerátem.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{now?: Date}} [o]
 * @returns {{statuses: object, marks: object[]}}
 */
function listMarks(db, { now = new Date() } = {}) {
  const since = new Date(now.getTime() - GONE_DAYS * 86400000).toISOString();
  const rows = db
    .prepare(
      `SELECT m.listing_id, m.status, m.note, m.by_user, m.at, l.title, l.price_czk, l.kraj, l.location_text, l.lat, l.lon, l.gone_at, l.features
         FROM listing_marks m JOIN listings l ON l.id = m.listing_id
        WHERE l.gone_at IS NULL OR l.gone_at >= ?
        ORDER BY m.listing_id`
    )
    .all(since);
  const marks = rows.map((r) => {
    const o = { id: r.listing_id, ...markOut(r) };
    if (r.title) o.t = r.title;
    const f = parseJson(r.features, {}) || {};
    if (typeof f.brand === 'string' && f.brand.trim()) o.b = f.brand.trim();
    if (typeof f.model === 'string' && f.model.trim()) o.m = f.model.trim();
    if (r.price_czk > 0) o.p = Math.round(r.price_czk);
    if (r.kraj) o.k = r.kraj;
    if (r.location_text) o.c = r.location_text;
    if (r.lat != null && r.lon != null) {
      o.la = Math.round(r.lat * 1e5) / 1e5;
      o.lo = Math.round(r.lon * 1e5) / 1e5;
    }
    if (r.gone_at) o.gone = true;
    return o;
  });
  return { statuses: STATUSES, marks };
}

/**
 * Nastaví (status) nebo zruší (status null/'') stav inzerátu.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {{status?: string|null, note?: string|null, expect?: string|null}} body expect = čas stavu, který klient
 *   viděl (null = viděl inzerát bez stavu); undefined = bez kontroly souběhu
 * @param {{user?: string|null, now?: Date}} [o]
 * @returns {{changed: boolean, conflict?: boolean, mark: object|null, log: object[]}}
 */
function setMark(db, id, body, { user = null, now = new Date() } = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new MarkError(400, 'Čekám JSON objekt {status, note}.');
  const status = normalizeStatus(body.status);
  const note = cleanNote(body.note);
  if (!status && note) throw new MarkError(400, 'Poznámku jde uložit jen se stavem – vyberte stav.');
  const expect = body.expect === undefined ? undefined : body.expect === null ? null : String(body.expect);
  const by = cleanUser(user);
  return tx(db, () => {
    if (!db.prepare('SELECT 1 FROM listings WHERE id = ?').get(Number(id))) throw new MarkError(404, 'Inzerát nenalezen.');
    const cur = db.prepare('SELECT status, note, by_user, at FROM listing_marks WHERE listing_id = ?').get(Number(id)) || null;
    if (expect !== undefined && (cur ? cur.at : null) !== expect) return { changed: false, conflict: true, ...getMark(db, id) };
    if (cur ? cur.status === status && (cur.note || null) === note : !status) return { changed: false, ...getMark(db, id) };
    let at = nowIso(now);
    if (cur && at <= cur.at) at = new Date(Date.parse(cur.at) + 1).toISOString(); // čas stavu musí být jedinečný (expect)
    if (status) {
      db.prepare(
        `INSERT INTO listing_marks (listing_id, status, note, by_user, at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(listing_id) DO UPDATE SET status = excluded.status, note = excluded.note, by_user = excluded.by_user, at = excluded.at`
      ).run(Number(id), status, note, by, at);
    } else {
      db.prepare('DELETE FROM listing_marks WHERE listing_id = ?').run(Number(id));
    }
    db.prepare('INSERT INTO listing_mark_log (listing_id, status, note, by_user, at) VALUES (?, ?, ?, ?, ?)').run(Number(id), status, note, by, at);
    return { changed: true, ...getMark(db, id) };
  });
}

module.exports = { STATUSES, NOTE_MAX, LOG_LIMIT, GONE_DAYS, MarkError, normalizeStatus, cleanNote, getMark, listMarks, setMark };
