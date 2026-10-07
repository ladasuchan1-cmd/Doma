'use strict';
// Kolomapa – vstupní bod serveru.
//   node server.js        spustí web s mapou (výchozí http://127.0.0.1:8090) a denní plánovač stahování
//   node server.js --help
//
// Průběh: loadConfig → openDb → označit přerušené běhy → createRunner + createApp → listen → startScheduler
//         → řádné ukončení na SIGINT/SIGTERM (běžící stahování se přeruší přes AbortController).
// Konfigurace přes proměnné prostředí – viz src/config.js.

const http = require('node:http');
const { loadConfig } = require('./src/config');
const { openDb } = require('./src/db');
const defaultLog = require('./src/util/log');
const { createApp, publicDirStatus } = require('./src/server/http');
const { createRunner, startScheduler, lockHolder, releaseStaleLock } = require('./src/server/scheduler');

/** „kolomapa.firma.cz, dilna:8090“ → ['kolomapa.firma.cz', 'dilna'] (malými písmeny, bez portu). */
function parseHostList(v) {
  return String(v || '')
    .split(/[\s,;]+/)
    .map((h) => h.trim().toLowerCase().replace(/^\[|\](:\d+)?$/g, '').replace(/^([^:]+):\d+$/, '$1'))
    .filter(Boolean);
}

/** Stavový kód pro chybu parseru HTTP (clientError). */
function clientErrorStatus(err) {
  const code = err && err.code;
  if (code === 'HPE_HEADER_OVERFLOW') return '431 Request Header Fields Too Large';
  if (code === 'ERR_HTTP_REQUEST_TIMEOUT') return '408 Request Timeout';
  return '400 Bad Request';
}

function displayUrl(host, port) {
  const h = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * Běhy ve stavu „running“ po restartu serveru (pád, vypnutí počítače) označí jako přerušené – pokud zrovna
 * nestahuje jiný proces (tools/run.js), který drží zámek.
 * @returns {number} počet opravených řádků
 */
function recoverInterrupted(db, config, now = new Date()) {
  if (lockHolder(config.dbFile)) return 0;
  return Number(
    db.prepare("UPDATE runs SET status = 'error', finished_at = ?, error = 'Běh byl přerušen (restart nebo pád serveru).' WHERE status = 'running'").run(now.toISOString())
      .changes
  );
}

/**
 * Spustí server.
 * @param {object} [options] přepisy konfigurace (port, host, dbFile, publicDir, password, schedule, runOnStart …) a navíc:
 *   - env: proměnné prostředí pro loadConfig (výchozí process.env)
 *   - db: už otevřená databáze (stop() ji pak nezavírá)
 *   - log: logger
 *   - runFn: vlastní funkce běhu pro createRunner (testy)
 *   - scheduler: false = nespouštět plánovač; objekt = volby pro startScheduler (tickMs, initialDelayMs, now)
 * @returns {Promise<{server: http.Server, db, config, runner, scheduler, url: string, port: number, stop: () => Promise<void>}>}
 */
async function start(options = {}) {
  const { env, db: givenDb, log: givenLog, runFn, scheduler: schedulerOpts = {}, ...overrides } = options;
  const log = givenLog || defaultLog;
  const config = { ...loadConfig(env || process.env) };
  // Další jména serveru povolená bez hesla (ochrana proti DNS rebinding, viz src/server/http.js), čárkou.
  if (config.allowedHosts == null) config.allowedHosts = parseHostList((env || process.env).KOLOMAPA_ALLOWED_HOSTS);
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) config[k] = v;
  if (!givenLog && env && typeof log.setLevel === 'function') log.setLevel(config.logLevel);

  const db = givenDb || openDb(config.dbFile);
  const ownsDb = !givenDb;
  let server = null;
  let scheduler = null;
  const runner = createRunner({ db, config, log, ...(runFn ? { runFn } : {}) });
  try {
    if (releaseStaleLock(config.dbFile)) log.warn('Smazán zámek běhu po předchozím procesu (pád nebo výměna kontejneru).');
    const fixed = recoverInterrupted(db, config);
    if (fixed) log.warn('Po restartu označeny přerušené běhy', { count: fixed });
    if (!publicDirStatus(config.publicDir)) log.warn(`Uživatelské rozhraní nenalezeno (${config.publicDir}/index.html) – běží jen data a API.`);

    const app = createApp({ db, config, log, runner });
    server = http.createServer(app);
    server.requestTimeout = 60 * 1000;
    server.headersTimeout = 30 * 1000;
    server.keepAliveTimeout = 5 * 1000;
    server.on('clientError', (err, socket) => {
      try {
        if (socket.writable && !socket.destroyed) socket.end(`HTTP/1.1 ${clientErrorStatus(err)}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
        else socket.destroy();
      } catch {
        /* nic */
      }
    });

    await new Promise((resolve, reject) => {
      const onError = (e) => reject(e);
      server.once('error', onError);
      server.listen(config.port, config.host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    server.on('error', (e) => log.error('Chyba HTTP serveru', e));

    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : config.port;
    const url = displayUrl(config.host, port);
    const users = config.users instanceof Map ? config.users.size : 0;
    const cf = config.cfAccess;
    const authOn = !!(cf || config.password || users || config.usersFile);
    if (cf && !cf.error) {
      log.info(`Kolomapa běží na ${url} – přihlášení jen přes Cloudflare Access`, { db: config.dbFile, tym: cf.team, emaily: cf.emails || '(politika v Cloudflare)' });
      // klíče týmu stáhnout hned – chyba (síť, překlep v týmu) je pak vidět v logu, ne až u prvního návštěvníka
      app.accessVerifier?.refresh().then(
        (n) => log.info(`Cloudflare Access: klíče týmu načteny (${n})`),
        (e) => log.warn(`Cloudflare Access: klíče týmu ${cf.team} nejde stáhnout – ${e.message}`)
      );
    } else if (cf && cf.error) {
      log.error(cf.error);
    } else {
      log.info(`Kolomapa běží na ${url}`, { db: config.dbFile, heslo: !!config.password, uzivatele: users, souborUzivatelu: config.usersFile || null });
    }
    if (!authOn && config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
      log.warn('Server naslouchá v síti bez hesla – nastavte KOLOMAPA_PASSWORD nebo KOLOMAPA_USERS.');
    }

    if (schedulerOpts !== false) scheduler = startScheduler({ db, config, log, runner, ...(schedulerOpts || {}) });

    let stopping = null;
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (scheduler) await scheduler.stop().catch(() => {});
        if (runner.active()) {
          log.info('Přerušuji běžící stahování…');
          runner.abort('Server se ukončuje.');
          await runner.wait(15000);
        }
        await new Promise((resolve) => {
          server.close(() => resolve());
          server.closeIdleConnections?.();
          const t = setTimeout(() => {
            server.closeAllConnections?.();
            resolve();
          }, 5000);
          t.unref();
        });
        if (ownsDb) {
          try {
            db.close();
          } catch (e) {
            log.warn('Databázi se nepodařilo zavřít', { error: e.message });
          }
        }
      })();
      return stopping;
    };

    return { server, db, config, runner, scheduler, url, port, stop };
  } catch (e) {
    if (scheduler) await scheduler.stop().catch(() => {});
    if (server && server.listening) await new Promise((r) => server.close(() => r()));
    if (ownsDb) {
      try {
        db.close();
      } catch {
        /* nic */
      }
    }
    throw e;
  }
}

async function main(argv) {
  const log = defaultLog;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(
      [
        'Použití: node server.js',
        '',
        'Web s mapou inzerátů kol + denní stahování. Nejdůležitější proměnné prostředí (všechny viz src/config.js):',
        '  PORT / KOLOMAPA_PORT     port (výchozí 8090)',
        '  KOLOMAPA_HOST            adresa (výchozí 127.0.0.1; 0.0.0.0 = celá síť – pak nastavte heslo)',
        '  KOLOMAPA_PASSWORD        heslo pro přístup (HTTP Basic)',
        '  KOLOMAPA_ALLOWED_HOSTS   bez hesla: další jména serveru (veřejná doména za proxy), čárkou; jinak jen IP,',
        '                           localhost, jméno počítače a .local/.lan … (ochrana proti DNS rebinding)',
        '  KOLOMAPA_TRUST_PROXY     1 = za reverzní proxy na stejném serveru (adresa návštěvníka z X-Forwarded-For)',
        '  KOLOMAPA_SCHEDULE        čas denního běhu HH:MM nebo off (výchozí 05:30)',
        '  KOLOMAPA_RUN_ON_START    1/0 – stáhnout po startu, pokud dnes ještě neproběhlo (výchozí 1)',
      ].join('\n')
    );
    return;
  }

  process.on('unhandledRejection', (reason) => {
    log.error('Neošetřené odmítnutí promise', reason instanceof Error ? reason : { reason: String(reason) });
  });

  let instance;
  try {
    instance = await start();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') log.error(`Port je obsazený (${e.port ?? ''}). Nastavte jiný přes PORT nebo KOLOMAPA_PORT.`);
    else log.error('Server se nepodařilo spustit', e);
    process.exitCode = 1;
    return;
  }

  let shuttingDown = false;
  const shutdown = async (signal, exitCode = 0) => {
    if (shuttingDown) {
      log.warn('Vynucené ukončení.');
      process.exit(1);
    }
    shuttingDown = true;
    log.info(`Přijat ${signal}, ukončuji server…`);
    try {
      await instance.stop();
      log.info('Server ukončen.');
      process.exit(exitCode);
    } catch (e) {
      log.error('Chyba při ukončování', e);
      process.exit(1);
    }
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('uncaughtException', (err) => {
    log.error('Nezachycená výjimka – server se ukončuje', err);
    if (!shuttingDown) shutdown('uncaughtException', 1);
    else process.exit(1);
  });
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { start, main, recoverInterrupted, displayUrl, parseHostList, clientErrorStatus };
