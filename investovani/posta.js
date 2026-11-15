// Odesílání e-mailů pro Investiční školu (upozornění a týdenní záloha). Chodí jen na jednu adresu – majiteli.
//
// Proměnné prostředí: MAIL_USER a MAIL_PASSWORD (přihlášení k SMTP; u Gmailu heslo aplikace), MAIL_TO (kam posílat,
// výchozí MAIL_USER), SMTP_HOST (výchozí smtp.gmail.com) a SMTP_PORT (výchozí 587; 465 = šifrované spojení od začátku).
// Bez MAIL_USER a MAIL_PASSWORD je pošta vypnutá a server běží dál bez upozornění.
'use strict';

function chyba(kod, zprava) { return Object.assign(new Error(zprava || kod), { kod }); }

function maskuj(adresa) {
  const m = /^([^@\s])[^@\s]*@([^@\s]+)$/.exec(String(adresa || ''));
  return m ? m[1] + '…@' + m[2] : '';
}

function posta(opts = {}) {
  const env = opts.env || process.env;
  const uzivatel = (env.MAIL_USER || '').trim();
  const heslo = env.MAIL_PASSWORD || '';
  const komu = (env.MAIL_TO || uzivatel).trim();
  const host = (env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(env.SMTP_PORT) || 587;
  let transport = opts.transport || null;
  const zapnuto = () => !!(transport || (uzivatel && heslo && komu));

  async function posli({ predmet, text, prilohy }) {
    if (!zapnuto()) throw chyba('bez_posty', 'Pošta není nastavená.');
    if (!transport) {
      const nodemailer = require('nodemailer');
      transport = nodemailer.createTransport({
        host, port, secure: port === 465, auth: { user: uzivatel, pass: heslo },
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
      });
    }
    try {
      await transport.sendMail({
        from: { name: 'Investiční škola', address: uzivatel || komu }, to: komu,
        subject: String(predmet).replace(/[\r\n]+/g, ' ').slice(0, 200), text: String(text),
        attachments: (prilohy || []).map((p) => ({ filename: p.nazev, content: p.obsah, contentType: p.typ || 'application/json' })),
      });
    } catch (e) {
      const prihlaseni = e && (e.code === 'EAUTH' || e.responseCode === 535);
      throw chyba(prihlaseni ? 'posta_prihlaseni' : 'posta_selhala', e && e.message);
    }
  }

  return { zapnuto, posli, adresat: () => maskuj(komu) };
}

module.exports = { posta, maskuj };
