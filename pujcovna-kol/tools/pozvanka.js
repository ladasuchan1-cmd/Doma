'use strict';
// Pozvánka do průvodce pro nového klienta z příkazové řádky (záloha ke správě platformy /platforma).
//   node --disable-warning=ExperimentalWarning tools/pozvanka.js --email jana@hotel.cz --nazev "Hotel U Tří dubů" [--dni 14]
// Na serveru vedle Cyklo & Ski mapy:
//   docker exec pujcovna-kol node --disable-warning=ExperimentalWarning tools/pozvanka.js --email … --nazev "…"
// Vypíše odkaz https://<PK_DOMAIN>/zalozeni/<token> (token se jinde neuloží – v DB je jen otisk).

const { loadConfig, ensureSecret } = require('../src/config');
const { createFieldCrypto } = require('../src/crypto/fields');
const klienti = require('../src/klienti');

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main() {
  const email = String(arg('email') || '').trim().toLowerCase();
  const nazev = String(arg('nazev') || '').trim();
  const dni = Number(arg('dni') || klienti.POZVANKA_DNI);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || nazev.length < 2) {
    console.error('Použití: tools/pozvanka.js --email jana@hotel.cz --nazev "Hotel U Tří dubů" [--dni 14]');
    process.exitCode = 1;
    return;
  }
  const config = loadConfig(process.env);
  const fieldCrypto = createFieldCrypto(ensureSecret(config));
  const pdb = klienti.openPlatformDb(config.dataDir);
  const inv = klienti.createInvite(pdb, { email, nazev, poznamka: 'z příkazové řádky', dni, fieldCrypto });
  klienti.audit(pdb, 'pozvanka.vytvorena', { id: inv.id, zdroj: 'cli' });
  pdb.close();
  const domena = process.env.PK_DOMAIN || config.klientiDomena;
  console.log(`Odkaz do průvodce (platí do ${inv.expiresAt.slice(0, 10)}, jednorázový):\nhttps://www.${domena.replace(/^www\./, '')}/zalozeni/${inv.token}`);
}

main();
