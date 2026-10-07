'use strict';
// Odesílání e-mailů provozovateli přes SMTP (src/mail/smtp.js, src/mail/sender.js): sestavení zprávy (UTF-8 hlavičky,
// base64 tělo, ochrana proti vložení hlaviček), rozhovor s falešným SMTP serverem (AUTH LOGIN, dot-stuffing), job
// odesílá jen poptávky a dotazy z kontaktu (ne e-maily zákazníkům), ne staré řádky, chyba → další pokus později; bez
// PK_SMTP_HOST se nic neodesílá.

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { startServer } = require('./helpers');
const smtp = require('../src/mail/smtp');
const sender = require('../src/mail/sender');
const { loadConfig } = require('../src/config');

/** Falešný SMTP server bez TLS: zaznamená příkazy a zprávy. failRcpt → RCPT odmítne. */
function fakeSmtp({ failRcpt = false } = {}) {
  const mails = [];
  const commands = [];
  const server = net.createServer((socket) => {
    let buf = '';
    let inData = false;
    let data = '';
    let authStep = 0;
    let mail = {};
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            mail.data = data;
            mails.push(mail);
            mail = {};
            data = '';
            socket.write('250 2.0.0 Ok: queued\r\n');
          } else data += `${line}\r\n`;
          continue;
        }
        commands.push(line);
        if (authStep === 1) {
          authStep = 2;
          mail.user = Buffer.from(line, 'base64').toString();
          socket.write('334 UGFzc3dvcmQ6\r\n');
        } else if (authStep === 2) {
          authStep = 0;
          mail.pass = Buffer.from(line, 'base64').toString();
          socket.write('235 2.7.0 Authentication successful\r\n');
        } else if (/^EHLO/.test(line)) socket.write('250-fake\r\n250-AUTH LOGIN\r\n250 8BITMIME\r\n');
        else if (line === 'AUTH LOGIN') {
          authStep = 1;
          socket.write('334 VXNlcm5hbWU6\r\n');
        } else if (/^MAIL FROM:/.test(line)) {
          mail.from = line.slice(10).replace(/[<>]/g, '');
          socket.write('250 Ok\r\n');
        } else if (/^RCPT TO:/.test(line)) {
          mail.to = line.slice(8).replace(/[<>]/g, '');
          socket.write(failRcpt ? '550 5.1.1 Mailbox unavailable\r\n' : '250 Ok\r\n');
        } else if (line === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 Bye\r\n');
        } else socket.write('502 Unknown\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, mails, commands, close: () => new Promise((r) => server.close(r)) })));
}

const decodeBody = (data) => Buffer.from(data.split('\r\n\r\n').slice(1).join('').replace(/\r\n/g, ''), 'base64').toString('utf8');

test('buildMessage: UTF-8 předmět a jméno přes RFC 2047, tělo base64, Reply-To; adresa s CR/LF se odmítne', () => {
  const m = smtp.buildMessage({ from: 'info@ksprehledy.cz', fromName: 'Půjčovna kol U Tří dubů', to: 'info@ksprehledy.cz', replyTo: 'jana@example.com', subject: 'Poptávka NAB-2026-000001: 5 kol', text: 'Dobrý den,\nřádek dvě', domain: 'ksprehledy.cz', date: new Date('2026-10-07T08:00:00Z') });
  assert.match(m, /^From: =\?UTF-8\?B\?/m);
  assert.match(m, /^To: <info@ksprehledy\.cz>$/m);
  assert.match(m, /^Reply-To: <jana@example\.com>$/m);
  assert.match(m, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(m, /^Date: Wed, 07 Oct 2026 08:00:00 \+0000$/m);
  assert.match(m, /^Message-ID: <[0-9a-f]{24}@ksprehledy\.cz>$/m);
  assert.match(m, /Content-Transfer-Encoding: base64/);
  assert.equal(decodeBody(m), 'Dobrý den,\r\nřádek dvě\r\n'.replace(/\r\n$/, ''));
  const subj = /^Subject: (.*(?:\r\n .*)*)$/m.exec(m)[1].split('\r\n ').map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)[1], 'base64').toString()).join('');
  assert.equal(subj, 'Poptávka NAB-2026-000001: 5 kol');
  assert.throws(() => smtp.buildMessage({ from: 'a@b.cz', to: 'x@y.cz\r\nBcc: z@z.cz', subject: 's', text: 't' }), /Neplatná/);
  assert.throws(() => smtp.cleanAddress('bez-zavinace'), /Neplatná/);
});

test('send: rozhovor s SMTP serverem (AUTH LOGIN bez TLS jen na localhostu), dot-stuffing; bez šifrování mimo localhost odmítne', async () => {
  const fake = await fakeSmtp();
  try {
    const cfg = { host: '127.0.0.1', port: fake.port, secure: 'none', user: 'info@ksprehledy.cz', pass: 'tajne-heslo', from: 'info@ksprehledy.cz', helo: 'ksprehledy.cz' };
    const data = smtp.buildMessage({ from: cfg.from, to: 'info@ksprehledy.cz', subject: 'Test', text: 'první\n.tečka na začátku', domain: 'ksprehledy.cz' });
    const r = await smtp.send(cfg, { from: cfg.from, to: 'info@ksprehledy.cz', data });
    assert.equal(r.ok, true);
    assert.equal(fake.mails.length, 1);
    assert.equal(fake.mails[0].user, 'info@ksprehledy.cz');
    assert.equal(fake.mails[0].pass, 'tajne-heslo');
    assert.equal(fake.mails[0].to, 'info@ksprehledy.cz');
    assert.ok(fake.commands.includes('EHLO ksprehledy.cz'));
    assert.match(decodeBody(fake.mails[0].data), /tečka na začátku/);
  } finally {
    await fake.close();
  }
  await assert.rejects(smtp.send({ host: 'smtp.example.com', port: 25, secure: 'none', from: 'a@b.cz' }, { from: 'a@b.cz', to: 'c@d.cz', data: 'x' }), /jen pro localhost/);
});

test('send: nespojí-li se, chyba jmenuje host:port a kód (ne prázdný text); popisChyby u AggregateError bez message', async () => {
  const free = net.createServer();
  await new Promise((r) => free.listen(0, '127.0.0.1', r));
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  await assert.rejects(
    smtp.send({ host: '127.0.0.1', port, secure: 'none', from: 'a@b.cz' }, { from: 'a@b.cz', to: 'c@d.cz', data: 'x' }),
    (e) => new RegExp(`nepodařilo se spojit s 127\\.0\\.0\\.1:${port} \\(.*ECONNREFUSED`).test(e.message),
  );
  const agg = new AggregateError([Object.assign(new Error(''), { code: 'ETIMEDOUT' }), Object.assign(new Error(''), { code: 'ENETUNREACH' })], '');
  assert.equal(smtp.popisChyby(Object.assign(agg, { code: 'ETIMEDOUT' })), 'ETIMEDOUT, ENETUNREACH');
  assert.equal(smtp.popisChyby(Object.assign(new Error('spojení odmítnuto'), { code: 'ECONNREFUSED' })), 'ECONNREFUSED: spojení odmítnuto');
  assert.equal(smtp.popisChyby(null), 'neznámá chyba');
});

test('config: PK_SMTP_* → config.smtp (465 = tls, 587 = starttls); bez hostitele null', () => {
  assert.equal(loadConfig({ PK_DATA: '/tmp/x' }).smtp, null);
  const c = loadConfig({ PK_DATA: '/tmp/x', PK_SMTP_HOST: 'smtp.cesky-hosting.cz', PK_SMTP_USER: 'info@ksprehledy.cz', PK_SMTP_PASS: 'x' }).smtp;
  assert.deepEqual([c.host, c.port, c.secure, c.from], ['smtp.cesky-hosting.cz', 465, 'tls', 'info@ksprehledy.cz']);
  assert.equal(loadConfig({ PK_DATA: '/tmp/x', PK_SMTP_HOST: 'h', PK_SMTP_PORT: '587', PK_SMTP_FROM: 'a@b.cz' }).smtp.secure, 'starttls');
});

test('mail-sender: pošle poptávku i dotaz z kontaktu provozovateli s Reply-To tazatele; e-maily zákazníkům a staré řádky ne; chyba → další pokus později', async () => {
  const fake = await fakeSmtp();
  const srv = await startServer({ env: { PK_SMTP_HOST: '127.0.0.1', PK_SMTP_PORT: String(fake.port), PK_SMTP_SECURE: 'none', PK_SMTP_USER: 'info@ksprehledy.cz', PK_SMTP_PASS: 'tajne-heslo' } });
  try {
    assert.ok(srv.instance.jobs.list().some((j) => j.name === 'mail-sender'), 'job je zaregistrovaný');
    const token = await srv.csrf('/kontakt');
    const res = await srv.fetch('/kontakt', { method: 'POST', body: { _csrf: token, jmeno: 'Jana Nováková', email: 'jana.novakova@example.com', zprava: 'Máte volná dvě kola na víkend?', souhlas: '1' } });
    assert.equal(res.status, 303);
    // starý dotaz (8 dní) a e-mail zákazníkovi se neodešlou
    srv.db.prepare("INSERT INTO outbox(type, subject, body_text, payload, run_at, created_at) VALUES ('contact_inquiry', 'starý', 'x', '{\"to\":\"info@ksprehledy.cz\"}', ?, ?)").run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    const zakaznikPred = srv.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type NOT IN ('contact_inquiry', 'nabidka') AND sent_at IS NULL").get().n;
    const deps = { config: srv.instance.config, tenants: srv.instance.tenants, dbs: srv.instance.dbs, fieldCrypto: srv.instance.fieldCrypto, log: null };
    const out = await sender.runOnce(deps);
    assert.equal(out.sent, 1);
    assert.equal(out.failed, 0);
    assert.equal(fake.mails.length, 1);
    const m = fake.mails[0];
    assert.equal(m.to, 'info@ksprehledy.cz');
    assert.match(m.data, /^Reply-To: <jana\.novakova@example\.com>$/m, 'odpověď jde tazateli');
    assert.match(decodeBody(m.data), /dvě kola na víkend/);
    assert.ok(srv.db.prepare("SELECT sent_at FROM outbox WHERE type = 'contact_inquiry' AND subject LIKE 'Dotaz%'").get().sent_at);
    assert.equal(srv.db.prepare("SELECT sent_at FROM outbox WHERE subject = 'starý'").get().sent_at, null, 'starý řádek se neposílá');
    assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type NOT IN ('contact_inquiry', 'nabidka') AND sent_at IS NULL").get().n, zakaznikPred, 'e-maily zákazníkům zůstávají ve frontě');
    // druhý běh už nic
    assert.equal((await sender.runOnce(deps)).sent, 0);
  } finally {
    await srv.stop();
    await fake.close();
  }
  // odmítnutý adresát → attempts + 1, error, run_at posunutý
  const bad = await fakeSmtp({ failRcpt: true });
  const srv2 = await startServer({ env: { PK_SMTP_HOST: '127.0.0.1', PK_SMTP_PORT: String(bad.port), PK_SMTP_SECURE: 'none', PK_SMTP_FROM: 'info@ksprehledy.cz' } });
  try {
    const token = await srv2.csrf('/kontakt');
    await srv2.fetch('/kontakt', { method: 'POST', body: { _csrf: token, jmeno: 'Petr', email: 'petr@example.com', zprava: 'Dotaz na kola pro rodinu.', souhlas: '1' } });
    const deps = { config: srv2.instance.config, tenants: srv2.instance.tenants, dbs: srv2.instance.dbs, fieldCrypto: srv2.instance.fieldCrypto, log: null };
    const out = await sender.runOnce(deps);
    assert.equal(out.failed, 1);
    const row = srv2.db.prepare("SELECT * FROM outbox WHERE type = 'contact_inquiry' ORDER BY id DESC").get();
    assert.equal(row.attempts, 1);
    assert.match(row.error, /RCPT TO: 550/);
    assert.ok(!/petr@example\.com|info@ksprehledy/.test(row.error), 'chyba bez adres');
    assert.ok(row.run_at > new Date().toISOString(), 'další pokus až později');
    assert.equal((await sender.runOnce(deps)).failed, 0, 'hned znovu se nezkouší');
  } finally {
    await srv2.stop();
    await bad.close();
  }
});

test('bez PK_SMTP_HOST se nic neodesílá a job není zaregistrovaný', async () => {
  const srv = await startServer();
  try {
    assert.ok(!srv.instance.jobs.list().some((j) => j.name === 'mail-sender'));
    assert.deepEqual(await sender.runOnce({ config: srv.instance.config, tenants: srv.instance.tenants, dbs: srv.instance.dbs }), { sent: 0, failed: 0 });
  } finally {
    await srv.stop();
  }
});
