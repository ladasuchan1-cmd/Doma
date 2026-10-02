#!/usr/bin/env node
'use strict';
// Spuštění pro majitele obchodu (start.cmd ve Windows, jinde `node tools/start.js`): spustí server s mapou
// a denním stahováním a po startu otevře mapu ve výchozím prohlížeči.
//
//   node tools/start.js [--no-browser]
//
// Když už Kolomapa na nastaveném portu běží (druhý dvojklik na start.cmd), jen otevře prohlížeč a skončí.
// Když port drží jiný program, poradí, jak nastavit jiný. Ostatní jako `npm start` (server.js).
// Návratový kód: 0 = běží / už běželo, 1 = server se nespustil (důvod je vypsaný).

const http = require('node:http');
const { spawn } = require('node:child_process');
const { loadConfig } = require('../src/config'); // kontrola verze Node.js + nastaveni.txt

/**
 * Co poslouchá na portu? 'kolomapa' | 'other' | 'free'
 * 'other' jen při HTTP odpovědi, která není Kolomapa. Chyba spojení i vypršení času = 'free' – server pak zkusí port
 * sám a obsazený port ohlásí (ve Windows trvá odmítnuté spojení na localhost i ~2 s, nesmí to zablokovat start).
 * @param {number} port
 * @param {{host?: string, timeoutMs?: number}} [o]
 * @returns {Promise<'kolomapa'|'other'|'free'>}
 */
function probe(port, { host = '127.0.0.1', timeoutMs = 3000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    const req = http.get({ host, port, path: '/api/run', agent: false, timeout: timeoutMs, headers: { Accept: 'application/json' } }, (res) => {
      const auth = String(res.headers['www-authenticate'] || '');
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 4096) body += c;
      });
      res.on('end', () => {
        if (/realm="?Kolomapa/i.test(auth)) return finish('kolomapa');
        try {
          const j = JSON.parse(body);
          if (j && typeof j === 'object' && 'running' in j && 'lastRun' in j) return finish('kolomapa');
        } catch {
          /* není JSON */
        }
        finish(/kolomapa/i.test(body) ? 'kolomapa' : 'other');
      });
      res.on('error', () => finish('other'));
    });
    req.on('timeout', () => {
      req.destroy();
      finish('free');
    });
    req.on('error', () => finish('free'));
  });
}

/** Adresa, na které se server zkouší (0.0.0.0 / :: → tento počítač). */
function probeHost(host) {
  if (!host || host === '0.0.0.0' || host === 'localhost') return '127.0.0.1';
  if (host === '::') return '::1';
  return host;
}

/** Adresa pro prohlížeč. */
function browserUrl(host, port) {
  const h = !host || host === '0.0.0.0' || host === '::' || host === '127.0.0.1' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}/`;
}

/**
 * Otevře adresu ve výchozím prohlížeči (Windows: rundll32 – bez potíží s uvozovkami v cmd). Chyba se jen zaloguje.
 * @param {string} url
 * @param {{platform?: string, spawnFn?: Function}} [o]
 * @returns {{cmd: string, args: string[]}} co se spouští (pro testy)
 */
function openBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const [cmd, args] =
    platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawnFn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on?.('error', () => console.log(`Otevřete v prohlížeči: ${url}`));
    child.unref?.();
  } catch {
    console.log(`Otevřete v prohlížeči: ${url}`);
  }
  return { cmd, args };
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Použití: node tools/start.js [--no-browser]   (spustí Kolomapu a otevře mapu v prohlížeči)');
    return 0;
  }
  const noBrowser = argv.includes('--no-browser');
  const config = loadConfig(process.env);
  const url = browserUrl(config.host, config.port);
  if (config.port > 0) {
    const state = await probe(config.port, { host: probeHost(config.host) });
    if (state === 'kolomapa') {
      console.log(`Kolomapa už běží (${url}) – otevírám ji v prohlížeči.`);
      if (!noBrowser) openBrowser(url);
      return 0;
    }
    if (state === 'other') {
      console.error(
        `Port ${config.port} už používá jiný program. Otevřete soubor nastaveni.txt (ve složce kolomapa) ` +
          `a nastavte jiný port, např. řádek KOLOMAPA_PORT=${config.port === 8091 ? 8092 : 8091}. Pak spusťte Kolomapu znovu.`
      );
      return 1;
    }
  }
  const server = require('../server');
  await server.main([]);
  if (process.exitCode) return process.exitCode; // server.main už vypsal důvod (obsazený port, databáze …)
  console.log(
    [
      '',
      config.port > 0 ? `  Kolomapa běží: ${url}` : '  Kolomapa běží (adresa je v řádku výše).',
      '  Toto okno nechte otevřené – zavřením se Kolomapa ukončí. Nastavení: soubor nastaveni.txt.',
      '',
    ].join('\n')
  );
  if (!noBrowser && config.port > 0) openBrowser(url);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => {
      if (code) process.exitCode = code;
    },
    (e) => {
      console.error(e);
      process.exitCode = 1;
    }
  );
}

module.exports = { main, probe, probeHost, browserUrl, openBrowser };
