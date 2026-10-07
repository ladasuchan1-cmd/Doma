'use strict';
// Minimální SMTP klient bez závislostí (node:net + node:tls) pro odesílání e-mailů z outboxu.
//   buildMessage({ from, fromName, to, replyTo, subject, text, domain, date, messageId }) → string (RFC 5322, UTF-8)
//   send(smtp, message, { log }) → Promise<{ ok, response }>
// smtp = { host, port, secure: 'tls' | 'starttls' | 'none', user, pass, from, fromName, helo }
//   tls       implicitní TLS (port 465, např. smtp.cesky-hosting.cz)
//   starttls  prostý spoj + STARTTLS (port 587); bez nabídky STARTTLS se neodesílá
//   none      bez šifrování – jen pro localhost (testy); jinde se odmítne
// AUTH PLAIN (s TLS), jinak AUTH LOGIN. Časový limit 20 s na celý rozhovor. Nikdy nelogovat adresy, heslo ani tělo zprávy –
// chyba nese jen kód a text odpovědi serveru (bez parametrů příkazu).

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const TIMEOUT_MS = 20000;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function b64(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

/** RFC 2047 – hlavička s diakritikou jako =?UTF-8?B?…?= (po kouscích, aby žádné „slovo“ nepřesáhlo 75 znaků). */
function encodeHeader(value) {
  const s = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(s)) return s;
  const words = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 42) {
      words.push(`=?UTF-8?B?${b64(chunk)}?=`);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(`=?UTF-8?B?${b64(chunk)}?=`);
  return words.join('\r\n ');
}

/** Bezpečná adresa do hlavičky / příkazu: bez CR/LF a úhlových závorek (ochrana proti vložení hlaviček). */
function cleanAddress(a) {
  const s = String(a || '').trim();
  if (!/^[^\s<>()@,;:"\\]+@[^\s<>()@,;:"\\]+\.[^\s<>()@,;:"\\]+$/.test(s)) throw new Error('Neplatná e-mailová adresa.');
  return s;
}

function wrap76(s) {
  return s.replace(/(.{76})/g, '$1\r\n');
}

/** Sestaví zprávu (text/plain UTF-8, tělo base64). */
function buildMessage({ from, fromName = '', to, replyTo = null, subject, text, domain = 'localhost', date = new Date(), messageId = null }) {
  const f = cleanAddress(from);
  const t = cleanAddress(to);
  const r = replyTo ? cleanAddress(replyTo) : null;
  const id = messageId || `${crypto.randomBytes(12).toString('hex')}@${domain}`;
  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} ` : ''}<${f}>`,
    `To: <${t}>`,
    r ? `Reply-To: <${r}>` : null,
    `Subject: ${encodeHeader(String(subject || '').replace(/[\r\n]+/g, ' '))}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ].filter(Boolean);
  return `${headers.join('\r\n')}\r\n\r\n${wrap76(b64(String(text || '').replace(/\r?\n/g, '\r\n')))}\r\n`;
}

/** Čtečka SMTP odpovědí nad socketem: next() → Promise<{ code, lines }> (víceřádková odpověď „250-…“ až „250 …“). */
function responseReader(socket) {
  let buffer = '';
  let lines = [];
  const queue = [];
  const waiting = [];
  let failure = null;
  function push(resp) {
    if (waiting.length) waiting.shift().resolve(resp);
    else queue.push(resp);
  }
  function onData(chunk) {
    buffer += chunk.toString('utf8');
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).replace(/\r$/, '');
      buffer = buffer.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        push({ code: Number(line.slice(0, 3)), lines });
        lines = [];
      }
    }
  }
  function fail(err) {
    failure = err;
    while (waiting.length) waiting.shift().reject(err);
  }
  return {
    attach(s) {
      s.on('data', onData);
      s.on('error', fail);
      s.on('close', () => fail(new Error('SMTP: spojení uzavřeno.')));
    },
    detach(s) {
      s.removeListener('data', onData);
    },
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => waiting.push({ resolve, reject }));
    },
  };
}

/**
 * Odešle zprávu přes SMTP. Hází Error s textem odpovědi serveru při chybě (bez adres a hesla).
 * @param {object} smtp konfigurace (viz hlavička)
 * @param {{ from: string, to: string, data: string }} env obálka a zpráva z buildMessage
 */
async function send(smtp, { from, to, data }) {
  const secure = smtp.secure || (Number(smtp.port) === 465 ? 'tls' : 'starttls');
  if (secure === 'none' && !LOCAL_HOSTS.has(smtp.host)) throw new Error('SMTP bez šifrování je povolené jen pro localhost.');
  const helo = smtp.helo || 'localhost';
  const opts = { host: smtp.host, port: Number(smtp.port), servername: smtp.host };
  let socket = secure === 'tls' ? tls.connect(opts) : net.connect(opts);
  const reader = responseReader(socket);
  reader.attach(socket);
  const timer = setTimeout(() => socket.destroy(new Error('SMTP: vypršel časový limit.')), TIMEOUT_MS);
  const write = (line) => socket.write(`${line}\r\n`);
  const expect = async (codes, step) => {
    const r = await reader.next();
    if (!codes.includes(r.code)) throw new Error(`SMTP ${step}: ${r.code} ${(r.lines[r.lines.length - 1] || '').slice(4, 200)}`);
    return r;
  };
  try {
    await expect([220], 'pozdrav');
    write(`EHLO ${helo}`);
    let ehlo = await expect([250], 'EHLO');
    let tlsOn = secure === 'tls';
    if (secure === 'starttls') {
      if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) throw new Error('SMTP: server nenabízí STARTTLS.');
      write('STARTTLS');
      await expect([220], 'STARTTLS');
      reader.detach(socket);
      socket = await new Promise((resolve, reject) => {
        const s = tls.connect({ socket, servername: smtp.host }, () => resolve(s));
        s.once('error', reject);
      });
      reader.attach(socket);
      tlsOn = true;
      write(`EHLO ${helo}`);
      ehlo = await expect([250], 'EHLO po STARTTLS');
    }
    if (smtp.user) {
      const auth = ehlo.lines.join(' ');
      if (/AUTH[ =][^\n]*PLAIN/i.test(auth) && tlsOn) {
        write(`AUTH PLAIN ${b64(`\u0000${smtp.user}\u0000${smtp.pass || ''}`)}`);
        await expect([235], 'přihlášení');
      } else {
        write('AUTH LOGIN');
        await expect([334], 'přihlášení');
        write(b64(smtp.user));
        await expect([334], 'přihlášení');
        write(b64(smtp.pass || ''));
        await expect([235], 'přihlášení');
      }
    }
    write(`MAIL FROM:<${cleanAddress(from)}>`);
    await expect([250], 'MAIL FROM');
    write(`RCPT TO:<${cleanAddress(to)}>`);
    await expect([250, 251], 'RCPT TO');
    write('DATA');
    await expect([354], 'DATA');
    // dot-stuffing: řádek začínající tečkou se zdvojí
    socket.write(`${String(data).replace(/(^|\r\n)\./g, '$1..')}\r\n.\r\n`);
    const done = await expect([250], 'odeslání');
    write('QUIT');
    return { ok: true, response: (done.lines[done.lines.length - 1] || '').slice(4, 200) };
  } finally {
    clearTimeout(timer);
    setTimeout(() => socket.destroy(), 200).unref();
  }
}

module.exports = { buildMessage, send, encodeHeader, cleanAddress };
