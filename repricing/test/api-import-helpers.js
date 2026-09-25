'use strict';
// Pomocníci pro integrační testy importního API (test/api-import*.test.js). Sám o sobě není testem.
// Spouští skutečný server (server.js start) nad :memory: databází bez plánovače.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { request, silentLog } = require('./server-helpers');

const ROOT = path.join(__dirname, '..');
const EXAMPLES = path.join(ROOT, 'examples');
const PASSWORD = 'import-test-heslo-123';

function example(name) {
  return fs.readFileSync(path.join(EXAMPLES, name));
}

/**
 * Spustí server a vrátí klienta.
 * @param {object} [overrides] přepisy konfigurace (např. maxBodyMb)
 */
async function startServer(overrides = {}) {
  const { start } = require('../server.js');
  const app = await start({
    env: {},
    dbFile: ':memory:',
    port: 0,
    host: '127.0.0.1',
    quiet: true,
    schedulerEnabled: false,
    password: PASSWORD,
    log: silentLog,
    ...overrides,
  });
  const port = app.port;

  const login = await request(port, {
    method: 'POST',
    path: '/api/v1/auth/login',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (login.status !== 200) throw new Error(`přihlášení selhalo: ${login.status} ${login.text}`);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0];

  /**
   * Požadavek na API.
   * @param {string} method
   * @param {string} p cesta (s /api/v1)
   * @param {{as?: 'session'|'session-nocsrf'|'none'|string, json?: any, body?: Buffer|string, type?: string, headers?: object}} [o]
   *   as: 'session' (výchozí, s CSRF hlavičkou), 'session-nocsrf', 'none' (bez ověření) nebo API token
   */
  async function call(method, p, o = {}) {
    const headers = { ...(o.headers || {}) };
    const as = o.as || 'session';
    if (as === 'session' || as === 'session-nocsrf') {
      headers.cookie = cookie;
      if (as === 'session') headers['x-requested-with'] = 'cenotvorba';
    } else if (as !== 'none') headers.authorization = `Bearer ${as}`;
    let body = o.body;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers['content-type'] = 'application/json';
    }
    if (o.type) headers['content-type'] = o.type;
    const res = await request(port, { method, path: p, headers, body });
    let data = null;
    try {
      data = res.text ? JSON.parse(res.text) : null;
    } catch {
      data = res.text;
    }
    return { status: res.status, headers: res.headers, data, text: res.text };
  }

  async function token(scopes, name = 'test') {
    const r = await call('POST', '/api/v1/tokens', { json: { name: `${name}-${scopes.join('-')}`, scopes } });
    if (r.status !== 200 && r.status !== 201) throw new Error(`token: ${r.status} ${r.text}`);
    return r.data.token;
  }

  return { app, db: app.db, port, cookie, call, token, stop: () => app.stop() };
}

/** Lokální HTTP server (bez sítě) – handler(req, res). */
async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** Chyby importu bez varování. */
function hardErrors(stats) {
  return (stats && Array.isArray(stats.errors) ? stats.errors : []).filter((e) => !e.warning);
}

module.exports = { startServer, localServer, example, hardErrors, PASSWORD, EXAMPLES };
