'use strict';
// Import vlastních prodejů kol z POHODY (XLSX export „pohyby skladu“ – prodejky + vydané faktury) jako trénovací data.
//
//   node tools/import-sales.js export.xlsx [další.xlsx …]   načte soubory, anonymizuje, uloží do DB i do training/
//   node tools/import-sales.js --seed                       jen nahraje training/koloshop-prodeje.json do DB
//
// Osobní údaje (Jméno, Firma) se nikdy neukládají. Do training/koloshop-prodeje.json se nové prodeje přidají
// (deduplikace podle kódu, data, názvu a ceny), takže soubor lze verzovat v gitu.

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDb, tx } = require('../src/db');
const { readXlsx } = require('../src/formats/xlsx');
const { salesFromRows, salesStats } = require('../src/sales');

const TRAINING_FILE = path.join(__dirname, '..', 'training', 'koloshop-prodeje.json');

function saleKey(s) {
  return [s.code || '', s.date || '', s.title, s.priceCzk].join('|');
}

/** Nahraje prodeje do DB (INSERT OR IGNORE podle UNIQUE). Vrací počet nových řádků. */
function storeSales(db, sales) {
  const ins = db.prepare(
    'INSERT OR IGNORE INTO sales (code, date, kind, title, size, brand, branch, price_czk, cost_czk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let n = 0;
  tx(db, () => {
    for (const s of sales) {
      const info = ins.run(s.code || null, s.date || null, s.kind, s.title, s.size || null, s.brand || null, s.branch || null, s.priceCzk, s.costCzk ?? null);
      n += Number(info.changes);
    }
  });
  return n;
}

function readTraining() {
  try {
    return JSON.parse(fs.readFileSync(TRAINING_FILE, 'utf8'));
  } catch {
    return { sales: [] };
  }
}

/** Zajistí, že DB obsahuje prodeje z training/ (volá se i při startu serveru / běhu). */
function seedSales(db) {
  const t = readTraining();
  return storeSales(db, t.sales || []);
}

function main(argv) {
  const files = argv.filter((a) => !a.startsWith('--'));
  const config = loadConfig();
  const db = openDb(config.dbFile);
  if (argv.includes('--seed') || !files.length) {
    const n = seedSales(db);
    console.log(`Do databáze nahráno ${n} nových prodejů z ${path.relative(process.cwd(), TRAINING_FILE)}.`);
    if (!files.length) return 0;
  }
  const training = readTraining();
  const known = new Set((training.sales || []).map(saleKey));
  let added = 0;
  for (const f of files) {
    const { rows } = readXlsx(fs.readFileSync(f));
    const { sales, skipped } = salesFromRows(rows);
    const fresh = sales.filter((s) => !known.has(saleKey(s)));
    for (const s of fresh) known.add(saleKey(s));
    training.sales = [...(training.sales || []), ...fresh];
    added += fresh.length;
    const n = storeSales(db, sales);
    console.log(
      `${path.basename(f)}: ${sales.length} prodejů kol (nových v training/: ${fresh.length}, v DB: ${n}); ` +
        `vyřazeno ${skipped.nonBike} nekol, ${skipped.returned} vratek, ${skipped.other} ostatních.`
    );
  }
  training.sales.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  fs.writeFileSync(TRAINING_FILE, JSON.stringify(training, null, 1) + '\n');
  const st = salesStats(training.sales);
  console.log(
    `Celkem ${st.count} prodejů (BAZAR ${st.bazarCount}, PROVĚŘENO ${st.proverenoCount}); ` +
      `výkup typicky za ${Math.round((st.buyRatioMedian || 0) * 100)} % prodejní ceny. Přidáno ${added}.`
  );
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error(`Import selhal: ${e.message}`);
    process.exitCode = 1;
  }
}

module.exports = { storeSales, seedSales, TRAINING_FILE };
