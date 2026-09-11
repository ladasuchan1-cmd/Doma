const test = require('node:test');
const assert = require('node:assert');
const A = require('../lib/local-analyzer.js');

const SAMPLE = `Obchodní podmínky služby Premium.
Předplatné Premium stojí 199 Kč měsíčně nebo 1 990 Kč ročně a automaticky se prodlužuje o další období.
Zkušební období 7 dní je zdarma, po jeho skončení bude účtována plná cena.
Předplatné můžete zrušit kdykoli v nastavení účtu, nejpozději 3 dny před koncem zúčtovacího období.
Spotřebitel má právo odstoupit od smlouvy do 14 dnů od jejího uzavření.
Vaše osobní údaje můžeme sdílet s našimi obchodními partnery pro marketingové účely, včetně předání mimo EU do USA.
Vyhrazujeme si právo kdykoli změnit tyto podmínky bez předchozího upozornění.
Poskytovatel neodpovídá za škody vzniklé užíváním služby.
Storno poplatek činí 500 Kč při zrušení objednávky po expedici.
Doprava stojí 89 Kč, při objednávce nad 1 500 Kč je zdarma.`;

test('vrací strukturu dle schématu', () => {
  const r = A.analyze(SAMPLE);
  for (const k of ['document_type', 'language', 'verdict', 'risk_score', 'is_standard', 'summary', 'findings', 'data_sharing', 'cancellation', 'prices', 'key_points']) {
    assert.ok(k in r, 'chybí ' + k);
  }
  assert.strictEqual(r.language, 'cs');
  assert.strictEqual(r._engine, 'local');
});

test('najde ceny s obdobím a typem', () => {
  const r = A.analyze(SAMPLE);
  const amounts = r.prices.map((p) => p.amount.replace(/\s/g, ''));
  assert.ok(amounts.includes('199Kč'), amounts.join(','));
  assert.ok(amounts.includes('1990Kč'));
  assert.ok(amounts.includes('89Kč'));
  const monthly = r.prices.find((p) => p.amount.startsWith('199'));
  assert.strictEqual(monthly.period, 'měsíčně');
  const shipping = r.prices.find((p) => p.amount.startsWith('89'));
  assert.strictEqual(shipping.item, 'doprava');
  const yearly = r.prices.find((p) => p.amount.replace(/\s/g, '') === '1990Kč');
  assert.strictEqual(yearly.period, 'ročně');
  assert.match(r.document_type, /obchodní podmínky/);
});

test('najde automatické prodlužování, zkušební období a způsob zrušení', () => {
  const r = A.analyze(SAMPLE);
  assert.strictEqual(r.cancellation.auto_renewal, true);
  assert.strictEqual(r.cancellation.found, true);
  assert.match(r.cancellation.how, /nastavení účtu/);
  assert.match(r.cancellation.notice_period, /3 dny před koncem/i);
  assert.match(r.cancellation.penalties, /Storno poplatek/);
  const titles = r.findings.map((f) => f.title);
  assert.ok(titles.includes('Automatické prodlužování / opakované platby'));
  assert.ok(titles.includes('Zkušební období, které přechází v placené'));
});

test('najde sdílení s třetími stranami a přenos mimo EU', () => {
  const r = A.analyze(SAMPLE);
  assert.strictEqual(r.data_sharing.shares_with_third_parties, true);
  assert.strictEqual(r.data_sharing.transfers_outside_eu, true);
  assert.ok(r.data_sharing.purposes.includes('marketing a reklama'));
  const crit = r.findings.filter((f) => f.severity === 'kriticke');
  assert.ok(crit.length >= 2);
  assert.strictEqual(r.verdict, 'nebezpecne');
  assert.ok(r.risk_score > 45);
});

test('nevinný text je standardní', () => {
  const r = A.analyze('Tyto podmínky upravují prodej zboží v našem e-shopu. Zboží dodáváme do 3 pracovních dnů. Spotřebitel může odstoupit od smlouvy do 14 dnů. Osobní údaje zpracováváme pouze pro vyřízení objednávky a předáváme je dopravci. Reklamaci uplatníte e-mailem na reklamace@eshop.cz.');
  assert.strictEqual(r.verdict, 'standardni');
  assert.strictEqual(r.cancellation.found, true);
  assert.match(r.cancellation.notice_period, /14 dní/);
});

test('anglický text: auto-renewal, arbitration, prices in USD', () => {
  const r = A.analyze(`Terms of Service. Your subscription costs $9.99 per month and will automatically renew unless you cancel at least 24 hours before the end of the current period. You can cancel in your account settings. We may share your personal information with third-party advertisers and partners. Any dispute will be resolved by binding arbitration under the laws of the State of Delaware. We reserve the right to modify these terms at any time without notice. A cancellation fee of $25 applies.`);
  assert.strictEqual(r.language, 'en');
  assert.strictEqual(r.cancellation.auto_renewal, true);
  assert.match(r.cancellation.how, /account settings/);
  const titles = r.findings.map((f) => f.title);
  assert.ok(titles.includes('Rozhodčí řízení nebo cizí právo / soud'));
  assert.ok(titles.includes('Předávání údajů třetím stranám'));
  assert.ok(r.prices.some((p) => p.amount === '$9.99' && p.period === 'měsíčně'));
  assert.ok(r.prices.some((p) => p.amount === '$25'));
});

test('splitSentences drží krátké věty pohromadě', () => {
  const s = A.splitSentences('První věta je tady. Druhá věta je zde! Třetí věta je otázka?\nČtvrtá na novém řádku.');
  assert.strictEqual(s.length, 4);
});
