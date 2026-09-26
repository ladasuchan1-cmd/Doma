'use strict';
// Cenotvorba – vstupní bod serveru.
//   node server.js                    spustí server (konfigurace viz src/config.js)
//   node server.js --reset-password   vygeneruje nové heslo, vypíše ho a skončí
//
// Průběh: loadConfig → openDb → initAuth (při prvním startu vypíše vygenerované heslo) → createApp → listen
//         → startScheduler (není-li vypnut) → řádné ukončení na SIGINT/SIGTERM.

const http = require('node:http');
const { loadConfig } = require('./src/config');
const { openDb } = require('./src/db');
const defaultLog = require('./src/util/log');
const { initAuth, resetPassword } = require('./src/server/auth');
const { createApp } = require('./src/server/http');
const { startScheduler } = require('./src/server/scheduler');
const { publicDirStatus } = require('./src/server/static');

function printPasswordBanner(password, title) {
  const line = '='.repeat(64);
  console.log(
    [
      '',
      line,
      `  ${title}`,
      '',
      `  Heslo pro přihlášení:   ${password}`,
      '',
      '  Heslo si hned uložte – znovu se už nezobrazí.',
      '  Změníte ho v aplikaci: Nastavení → Heslo.',
      '  Nové heslo vygeneruje: node server.js --reset-password',
      line,
      '',
    ].join('\n')
  );
}

function displayUrl(host, port) {
  const h = !host || host === '0.0.0.0' || host === '::' ? 'localhost' : host.includes(':') ? `[${host}]` : host;
  return `http://${h}:${port}`;
}

/**
 * Po startu procesu nemůže nic „běžet“: import i přecenění jsou synchronní v jednom procesu. Řádky ve stavu
 * „running“ zůstaly po pádu (např. nedostatek paměti při importu) – označí se jako přerušené, aby je UI neukazovalo
 * hodiny jako běžící (ops-2).
 * @returns {{imports: number, runs: number, sources: number}}
 */
function recoverInterrupted(db, now = new Date()) {
  const at = now.toISOString();
  const imports = Number(
    db.prepare("UPDATE imports SET status = 'error', finished_at = ?, error = 'Import byl přerušen (restart serveru).' WHERE status = 'running'").run(at).changes
  );
  const runs = Number(db.prepare("UPDATE runs SET status = 'error', finished_at = ?, error = 'Přecenění bylo přerušeno (restart serveru).' WHERE status = 'running'").run(at).changes);
  const sources = Number(
    db.prepare("UPDATE sources SET last_status = 'error', last_message = 'Stahování bylo přerušeno (restart serveru).' WHERE last_status = 'running'").run().changes
  );
  return { imports, runs, sources };
}

/**
 * Spustí server.
 * @param {object} [options] přepisy konfigurace (port, host, dbFile, password, secret, maxBodyMb, publicDir,
 *   trustProxy, schedulerEnabled) a navíc:
 *   - env: proměnné prostředí pro loadConfig (výchozí process.env)
 *   - db: už otevřená databáze (pak ji stop() nezavírá)
 *   - log: logger
 *   - quiet: true → nevypisovat banner s heslem (heslo je v návratové hodnotě generatedPassword)
 *   - scheduler: volby pro startScheduler (deps, intervalMs, initialDelayMs)
 * @returns {Promise<{server: http.Server, db, config, app, scheduler, url: string, port: number,
 *   generatedPassword: string|null, stop: () => Promise<void>}>}
 */
async function start(options = {}) {
  const { env, db: givenDb, log: givenLog, quiet = false, scheduler: schedulerOpts = {}, ...overrides } = options;
  const log = givenLog || defaultLog;
  const config = { ...loadConfig(env || process.env) };
  for (const [k, v] of Object.entries(overrides)) if (v !== undefined) config[k] = v;
  // výchozí logger čte LOG_LEVEL z process.env sám; při vlastním env / přepisu logLevel ho nastavíme
  if (!givenLog && (env || overrides.logLevel) && typeof log.setLevel === 'function') log.setLevel(config.logLevel);

  const db = givenDb || openDb(config.dbFile);
  const ownsDb = !givenDb;
  let server = null;
  let scheduler = null;
  try {
    const rec = recoverInterrupted(db);
    if (rec.imports || rec.runs || rec.sources) log.warn('Po restartu označeny přerušené úlohy', rec);
    const { generatedPassword, passwordSource } = initAuth(db, config);
    if (generatedPassword && !quiet) printPasswordBanner(generatedPassword, 'Cenotvorba – první spuštění: bylo vygenerováno heslo');
    if (passwordSource === 'env') log.info('Heslo je nastaveno proměnnou prostředí CENOTVORBA_PASSWORD.');
    if (!config.secret) log.debug('Tajemství pro session je uložené v databázi (CENOTVORBA_SECRET není nastaveno).');

    const app = createApp({ db, config, log });
    if (app.apiModules && app.apiModules.missing.length) {
      log.debug('Chybějící API moduly (zatím neimplementované)', { missing: app.apiModules.missing });
    }
    if (!publicDirStatus(config.publicDir)) log.warn(`Uživatelské rozhraní nenalezeno (${config.publicDir}/index.html) – běží jen API.`);

    server = http.createServer(app);
    // velké importy (stovky MB) po pomalé lince – výchozích 5 minut nestačí
    server.requestTimeout = 30 * 60 * 1000;
    server.headersTimeout = 60 * 1000;
    server.keepAliveTimeout = 5 * 1000;
    server.on('clientError', (err, socket) => {
      // poškozený HTTP požadavek / přerušené spojení – nikdy nesmí shodit proces
      try {
        if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
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
    log.info(`Cenotvorba běží na ${url}`, { db: config.dbFile, scheduler: !!config.schedulerEnabled });

    if (config.schedulerEnabled) scheduler = startScheduler({ db, config, log, ...schedulerOpts });
    else log.info('Plánovač je vypnutý (CENOTVORBA_SCHEDULER=0).');

    let stopping = null;
    const stop = () => {
      if (stopping) return stopping;
      stopping = (async () => {
        if (scheduler) {
          try {
            await scheduler.stop();
          } catch (e) {
            log.warn('Plánovač se nepodařilo zastavit', { error: e.message });
          }
        }
        await new Promise((resolve) => {
          server.close(() => resolve());
          // nečinná keep-alive spojení zavřít hned, běžící požadavky nechat 10 s doběhnout
          server.closeIdleConnections?.();
          const t = setTimeout(() => {
            server.closeAllConnections?.();
            resolve();
          }, 10000);
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

    return { server, db, config, app, scheduler, url, port, generatedPassword, stop };
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
  if (argv.includes('--reset-password')) {
    const config = loadConfig(process.env);
    const db = openDb(config.dbFile);
    try {
      if (config.password) console.log('Pozor: proměnná CENOTVORBA_PASSWORD je nastavená a má přednost před heslem v databázi.');
      printPasswordBanner(resetPassword(db), 'Cenotvorba – nové heslo');
    } finally {
      db.close();
    }
    return;
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Použití: node server.js [--reset-password]\nKonfigurace přes proměnné prostředí – viz src/config.js.');
    return;
  }

  process.on('unhandledRejection', (reason) => {
    log.error('Neošetřené odmítnutí promise', reason instanceof Error ? reason : { reason: String(reason) });
  });

  let instance;
  try {
    instance = await start();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') log.error(`Port je obsazený (${e.port ?? ''}). Nastavte jiný přes PORT nebo CENOTVORBA_PORT.`);
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
    // stav procesu je po nezachycené výjimce nejistý → zalogovat a řádně skončit (správce služby restartuje)
    log.error('Nezachycená výjimka – server se ukončuje', err);
    if (!shuttingDown) shutdown('uncaughtException', 1);
    else process.exit(1);
  });
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = { start, main, recoverInterrupted };
