'use strict';
// Pomocníci pro testy serveru (test/server-*.test.js). Sám o sobě není testem.

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../src/util/log');

/** Logger, který nic nevypisuje, ale ukládá záznamy (pro kontrolu v testech). */
function memoryLogger() {
  const records = [];
  const push = (level) => (msg, meta) => records.push({ level, msg: String(msg), meta });
  return {
    records,
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    setLevel() {},
    getLevel: () => 'debug',
    isEnabled: () => true,
  };
}

const silentLog = createLogger({ level: 'silent' });

/**
 * Surový HTTP požadavek (bez normalizace cesty, s plnou kontrolou nad hlavičkami a tělem).
 * @returns {Promise<{status: number, headers: object, body: Buffer, text: string, json: () => any}>}
 */
function request(port, { method = 'GET', path: p = '/', headers = {}, body, chunks } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(parts);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: buf,
          text: buf.toString('utf8'),
          json: () => JSON.parse(buf.toString('utf8')),
        });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (chunks) {
      (async () => {
        for (const c of chunks) {
          if (!req.write(c)) await new Promise((r) => req.once('drain', r));
        }
        req.end();
      })().catch(reject);
    } else {
      if (body !== undefined) req.write(body);
      req.end();
    }
  });
}

/** Spustí http server nad handlerem na náhodném portu. */
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function tmpDir(prefix = 'cenotvorba-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

module.exports = { memoryLogger, silentLog, request, listen, tmpDir };
