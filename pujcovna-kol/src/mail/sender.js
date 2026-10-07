'use strict';
// Odesílání e-mailů z outboxu přes SMTP (job „mail-sender“, každou minutu). Zatím JEN oznámení provozovateli platformy:
// poptávky z konfigurátoru (/nabidka, typ 'nabidka') a dotazy z kontaktního formuláře (typ 'contact_inquiry') – a jen
// u tenantů platformy (demo), ne u webů klientů. E-maily zákazníkům (potvrzení rezervací apod.) se neposílají: demo má
// smyšlené rezervace a nesmí nikomu skutečnému nic chodit. Bez PK_SMTP_HOST job nic nedělá.
// Adresát = payload.to (e-mail půjčovny z tenant.json), Reply-To = dešifrovaný e-mail tazatele (odpověď jde rovnou jemu).
// Starší než MAX_STARI_DNI se neodesílá (po zapnutí se nerozešle stará fronta). Chyba → attempts + 1, další pokus za
// 5 × attempts minut, po 5 pokusech konec (outbox.pending). Log jen id, typ, tenant a text chyby – nikdy adresy ani obsah.

const outbox = require('./outbox');
const smtpClient = require('./smtp');
const { nowIso } = require('../db');

const TYPY = Object.freeze(['nabidka', 'contact_inquiry']);
const MAX_STARI_DNI = 7;
const DAVKA = 20;

function parse(json) {
  try {
    return JSON.parse(json || '{}') || {};
  } catch {
    return {};
  }
}

/** Řádky outboxu k odeslání pro jeden tenant (povolené typy, ne starší než MAX_STARI_DNI). */
function kOdeslani(db, now = new Date()) {
  const od = new Date(now.getTime() - MAX_STARI_DNI * 86400000).toISOString();
  return outbox.pending(db, 200, now.toISOString()).filter((r) => TYPY.includes(r.type) && r.created_at >= od).slice(0, DAVKA);
}

/**
 * Jeden běh odesílání. deps: { config, tenants, dbs, fieldCrypto, log }; isClient(tenant) → true pro weby klientů.
 * send/build lze podstrčit v testech. Vrací { sent, failed }.
 */
async function runOnce({ config, tenants, dbs, fieldCrypto, log }, { isClient = () => false, send = smtpClient.send, now = () => new Date() } = {}) {
  const smtp = config && config.smtp;
  const out = { sent: 0, failed: 0 };
  if (!smtp) return out;
  for (const tenant of tenants || []) {
    if (isClient(tenant)) continue;
    const db = dbs.get(tenant.slug);
    if (!db) continue;
    for (const row of kOdeslani(db, now())) {
      const p = parse(row.payload);
      try {
        if (!p.to) throw new Error('Chybí adresát (e-mail půjčovny v tenant.json).');
        let replyTo = null;
        try {
          replyTo = p.reply_to_enc && fieldCrypto ? fieldCrypto.dec(p.reply_to_enc) : null;
          if (replyTo) smtpClient.cleanAddress(replyTo);
        } catch {
          replyTo = null;
        }
        const data = smtpClient.buildMessage({ from: smtp.from, fromName: smtp.fromName || tenant.name || '', to: p.to, replyTo, subject: row.subject, text: row.body_text, domain: smtp.from.split('@')[1] || 'localhost' });
        await send(smtp, { from: smtp.from, to: p.to, data });
        outbox.markSent(db, row.id, nowIso());
        out.sent++;
        if (log) log.info('E-mail odeslán', { outboxId: row.id, type: row.type, tenant: tenant.slug });
      } catch (e) {
        const msg = smtpClient.popisChyby(e);
        outbox.markFailed(db, row.id, msg);
        const attempts = (row.attempts || 0) + 1;
        db.prepare('UPDATE outbox SET run_at = ? WHERE id = ?').run(new Date(now().getTime() + attempts * 5 * 60000).toISOString(), row.id);
        out.failed++;
        if (log) log.warn('E-mail se nepodařilo odeslat', { outboxId: row.id, type: row.type, tenant: tenant.slug, attempts, error: msg });
      }
    }
  }
  return out;
}

module.exports = { runOnce, kOdeslani, TYPY, MAX_STARI_DNI };
