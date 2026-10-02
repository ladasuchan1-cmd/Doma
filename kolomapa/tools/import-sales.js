'use strict';
// Import vlastních prodejů kol z POHODY (XLSX export „pohyby skladu“ – prodejky + vydané faktury) jako trénovací data.
//
//   node tools/import-sales.js export.xlsx [další.xlsx …]   načte soubory, anonymizuje, uloží do DB i do training/
//   node tools/import-sales.js --seed                       jen nahraje training/koloshop-prodeje.json do DB
//   npm run import-sales -- "C:\Users\…\export.xlsx"       totéž přes npm (cestu s mezerami dejte do uvozovek)
//
// Osobní údaje (Jméno, Firma) se nikdy neukládají. Do training/koloshop-prodeje.json se nové prodeje přidají
// (deduplikace podle kódu, data, názvu a ceny), takže soubor lze verzovat v gitu. Opakovaný import téhož
// exportu (i překrývajících se období) nic nezdvojí – ani v souboru, ani v DB.
// Nacenění čte prodeje z tabulky sales, a když je prázdná, z training/koloshop-prodeje.json (seedSales se
// automaticky nevolá – po stažení nového training/ z gitu spusťte --seed).

const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../src/config');
const { openDb, tx } = require('../src/db');
const { readXlsx } = require('../src/formats/xlsx');
const { salesFromRows, salesStats } = require('../src/sales');

const TRAINING_FILE = path.join(__dirname, '..', 'training', 'koloshop-prodeje.json');
const USAGE = [
  'Použití: npm run import-sales -- cesta\\k\\exportu.xlsx [další.xlsx …]',
  '         npm run import-sales -- --seed      (jen nahraje training/koloshop-prodeje.json do databáze)',
  '',
  'Export z POHODY: Sklady → Pohyby skladu (prodejky + vydané faktury), uložit jako Sešit Excelu (.xlsx).',
  'Jména a firmy zákazníků se neukládají; opakovaný import téhož souboru nic nezdvojí.',
].join('\n');

function saleKey(s) {
  return [s.code || '', s.date || '', s.title, s.priceCzk].join('|');
}

/**
 * Nahraje prodeje do DB. Duplicity (stejný kód, datum, název a cena) přeskočí – i když kód nebo datum chybí
 * (UNIQUE v SQLite bere NULL jako pokaždé jinou hodnotu, proto se kontroluje přes IS). Vrací počet nových řádků.
 */
function storeSales(db, sales) {
  const exists = db.prepare('SELECT 1 FROM sales WHERE code IS ? AND date IS ? AND title = ? AND price_czk = ? LIMIT 1');
  const ins = db.prepare(
    'INSERT OR IGNORE INTO sales (code, date, kind, title, size, brand, branch, price_czk, cost_czk) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  let n = 0;
  tx(db, () => {
    for (const s of sales) {
      const code = s.code || null;
      const date = s.date || null;
      if (exists.get(code, date, s.title, s.priceCzk)) continue;
      const info = ins.run(code, date, s.kind, s.title, s.size || null, s.brand || null, s.branch || null, s.priceCzk, s.costCzk ?? null);
      n += Number(info.changes);
    }
  });
  return n;
}

/** Přečte export; srozumitelné chyby pro běžné omyly (chybí soubor, starý .xls, CSV, soubor otevřený v Excelu). */
function readExport(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`Soubor „${file}“ neexistuje – zkontrolujte cestu (s mezerami ji dejte do uvozovek).`);
    if (e.code === 'EISDIR') throw new Error(`„${file}“ je složka, ne soubor s exportem.`);
    if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') throw new Error(`Soubor „${file}“ nejde přečíst (${e.code}) – není otevřený v Excelu? Zavřete ho a zkuste to znovu.`);
    throw e;
  }
  if (buf.length >= 4 && buf.readUInt32BE(0) === 0xd0cf11e0) {
    throw new Error(`„${path.basename(file)}“ je starý formát Excelu (.xls) – otevřete ho v Excelu a uložte jako „Sešit Excelu (*.xlsx)“.`);
  }
  if (/\.(csv|txt)$/i.test(file)) throw new Error(`„${path.basename(file)}“ není sešit Excelu – exportujte z POHODY do .xlsx (nebo CSV v Excelu uložte jako .xlsx).`);
  try {
    return readXlsx(buf);
  } catch (e) {
    throw new Error(`„${path.basename(file)}“ nejde přečíst jako sešit Excelu (.xlsx): ${e.message}`);
  }
}

/**
 * Načte trénovací soubor. Chybí-li, vrátí prázdný; je-li poškozený (např. konflikt po git pull), vyhodí chybu –
 * jinak by ho import přepsal jen novými prodeji a dosavadní by se ztratily.
 */
function readTraining(file = TRAINING_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { sales: [] };
    throw e;
  }
  let data;
  try {
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`${path.basename(file)} je poškozený (${e.message}) – obnovte ho z gitu (git checkout -- training/), nic jsem nepřepsal.`);
  }
  if (!data || typeof data !== 'object' || (data.sales != null && !Array.isArray(data.sales))) {
    throw new Error(`${path.basename(file)} nemá očekávaný tvar ({"sales": [...]}) – nic jsem nepřepsal.`);
  }
  if (!data.sales) data.sales = [];
  return data;
}

/** Nahraje do DB prodeje z training/koloshop-prodeje.json (npm run import-sales bez souboru / --seed). */
function seedSales(db, file = TRAINING_FILE) {
  const t = readTraining(file);
  return storeSales(db, t.sales || []);
}

/**
 * @param {string[]} argv
 * @param {{trainingFile?: string, dbFile?: string}} [opts] jiný soubor trénovacích dat / databáze (testy)
 * @returns {number} návratový kód
 */
function main(argv, opts = {}) {
  const trainingFile = opts.trainingFile || TRAINING_FILE;
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }
  const unknown = argv.filter((a) => a.startsWith('--') && a !== '--seed');
  if (unknown.length) {
    console.error(`Neznámý přepínač: ${unknown.join(' ')}\n\n${USAGE}`);
    return 1;
  }
  const files = argv.filter((a) => !a.startsWith('--'));
  const config = loadConfig();
  // Soubory přečíst dřív, než se cokoli zapíše – chyba v jednom souboru nezanechá import napůl.
  const parsed = files.map((f) => ({ f, ...salesFromRows(readExport(f).rows) }));
  const db = openDb(opts.dbFile || config.dbFile);
  try {
    if (argv.includes('--seed') || !files.length) {
      const n = seedSales(db, trainingFile);
      console.log(`Do databáze nahráno ${n} nových prodejů z ${path.relative(process.cwd(), trainingFile)}.`);
      if (!files.length) return 0;
    }
    const training = readTraining(trainingFile);
    const known = new Set((training.sales || []).map(saleKey));
    let added = 0;
    for (const { f, sales, skipped } of parsed) {
      const fresh = sales.filter((s) => !known.has(saleKey(s)));
      for (const s of fresh) known.add(saleKey(s));
      training.sales = [...(training.sales || []), ...fresh];
      added += fresh.length;
      const n = storeSales(db, sales);
      console.log(
        `${path.basename(f)}: ${sales.length} prodejů kol (nových v training/: ${fresh.length}, v DB: ${n}); ` +
          `vyřazeno ${skipped.nonBike} nekol, ${skipped.returned} vratek, ${skipped.other} ostatních.`
      );
      if (!sales.length) {
        console.warn(
          `  Pozor: v „${path.basename(f)}“ není žádný prodej kola s označením BAZAR nebo PROVĚŘENO – je to export „Pohyby skladu“ ` +
            '(prodejky + vydané faktury) se sloupci Název, Množství, Částka, Vážená?'
        );
      }
    }
    if (added || !fs.existsSync(trainingFile)) {
      training.sales.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      fs.writeFileSync(trainingFile, JSON.stringify(training, null, 1) + '\n');
    } else console.log(`Nic nového – ${path.basename(trainingFile)} se nemění.`);
    const st = salesStats(training.sales);
    console.log(
      `Celkem ${st.count} prodejů (BAZAR ${st.bazarCount}, PROVĚŘENO ${st.proverenoCount}); ` +
        `výkup typicky za ${Math.round((st.buyRatioMedian || 0) * 100)} % prodejní ceny. Přidáno ${added}.`
    );
    return 0;
  } finally {
    try {
      db.close();
    } catch {
      /* už zavřená */
    }
  }
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    const msg = String(e.message).split('\n')[0];
    const locked = /database is locked|SQLITE_BUSY/i.test(msg);
    console.error(`Import selhal: ${msg}${locked ? '\n  → Databázi právě používá stahování – zkuste import za pár minut znovu.' : ''}`);
    process.exitCode = 1;
  }
}

module.exports = { storeSales, seedSales, readExport, main, TRAINING_FILE, USAGE };
