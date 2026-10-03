#!/usr/bin/env node
'use strict';
// Volitelný server: servíruje statickou aplikaci a ukládá sdílený stav oslovení do data/stav.json,
// aby ho vidělo celé obchodní oddělení. Bez něj aplikace funguje z disku (file://) s uložením v prohlížeči.
//
//   node server.js            # http://localhost:8090
//   PORT=8090 CSM_STAV=./data/stav.json CSM_TOKEN=tajne node server.js
//
// API: GET /api/stav → { app, verze, stav: { <id>: záznam } } · PUT /api/stav/<id> (JSON záznam; prázdný záznam maže)
//      PUT /api/stav (celý objekt – sloučení) · GET /api/health
// Volitelně CSM_TOKEN: pak musí každý požadavek na /api nést hlavičku Authorization: Bearer <token>
// (aplikace ho zatím neposílá – hodí se, když je API za reverzní proxy pro externí skripty).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const stavLib = require('./lib/stav.js');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8090);
const STAV_FILE = path.resolve(process.env.CSM_STAV || path.join(ROOT, 'data', 'stav.json'));
const TOKEN = process.env.CSM_TOKEN || '';
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------- stav
let stav = loadStav();
let writeTimer = null;

function loadStav() {
  try {
    if (!fs.existsSync(STAV_FILE)) return {};
    const parsed = JSON.parse(fs.readFileSync(STAV_FILE, 'utf8'));
    return stavLib.importJson(parsed).stav || {};
  } catch (e) {
    console.error('Nelze načíst ' + STAV_FILE + ': ' + e.message + ' – začínám s prázdným stavem.');
    return {};
  }
}

function scheduleWrite() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(writeStav, 300);
}

function writeStav() {
  try {
    fs.mkdirSync(path.dirname(STAV_FILE), { recursive: true });
    const tmp = STAV_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(stavLib.exportJson(stav), null, 1));
    fs.renameSync(tmp, STAV_FILE);
  } catch (e) {
    console.error('Zápis stavu selhal: ' + e.message);
  }
}

// ---------------------------------------------------------------- http
function send(res, status, body, type) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Tělo požadavku je příliš velké'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function authorized(req) {
  if (!TOKEN) return true;
  return req.headers.authorization === 'Bearer ' + TOKEN;
}

async function handleApi(req, res, url) {
  if (url.pathname === '/api/health') return send(res, 200, { ok: true, zaznamu: Object.keys(stav).length });
  if (!authorized(req)) return send(res, 401, { chyba: 'Chybí nebo neplatný token' });
  if (url.pathname === '/api/stav') {
    if (req.method === 'GET') return send(res, 200, stavLib.exportJson(stav));
    if (req.method === 'PUT' || req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const im = stavLib.importJson(body);
      if (im.chyba) return send(res, 400, { chyba: im.chyba });
      stav = stavLib.merge(stav, im.stav);
      scheduleWrite();
      return send(res, 200, { ok: true, zaznamu: Object.keys(stav).length });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }
  const m = /^\/api\/stav\/([^/]+)$/.exec(url.pathname);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (!stavLib.isValidId(id)) return send(res, 400, { chyba: 'Neplatné id' });
    if (req.method === 'GET') return send(res, 200, stav[id] || stavLib.emptyRecord());
    if (req.method === 'PUT') {
      const body = JSON.parse((await readBody(req)) || '{}');
      const rec = stavLib.normalizeRecord(body);
      if (stavLib.isEmpty(rec)) delete stav[id];
      else stav[id] = rec;
      scheduleWrite();
      return send(res, 200, { ok: true });
    }
    if (req.method === 'DELETE') {
      delete stav[id];
      scheduleWrite();
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { chyba: 'Nepodporovaná metoda' });
  }
  return send(res, 404, { chyba: 'Neznámá cesta' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + path.sep) || p.includes('/.') || /^\/(cache|test|tools|node_modules)\//.test(p) || p === '/server.js' || file === STAV_FILE) {
    return send(res, 404, 'Nenalezeno', 'text/plain; charset=utf-8');
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return send(res, 404, 'Nenalezeno', 'text/plain; charset=utf-8');
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else if (req.method === 'GET' || req.method === 'HEAD') serveStatic(req, res, url);
    else send(res, 405, { chyba: 'Nepodporovaná metoda' });
  } catch (e) {
    send(res, e instanceof SyntaxError ? 400 : 500, { chyba: e.message });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Cyklo & Ski mapa běží na http://localhost:${PORT}  (stav oslovení: ${STAV_FILE}, ${Object.keys(stav).length} záznamů)`);
  });
  const stop = () => {
    clearTimeout(writeTimer);
    writeStav();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

module.exports = { server, handleApi, loadStav, writeStav, STAV_FILE };
