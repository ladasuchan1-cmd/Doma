'use strict';
// Testy modulu plateb (SPEC kap. 9 a 10): IBAN, SPAYD, QR SVG, ledger, provider (karta mock → notifikace → rezervace
// confirmed + ledger + doklad + e-mail; podvržené notifikace nic nemění), preautorizace kauce (capture / cancelHold /
// auto-uvolnění), fio mock (přesně / přeplatek / nedoplatek / nespárováno / manualMatch), vratky, údržba a doklady
// (číselné řady, pravidlo 10 000 Kč, neplátce, konečný doklad, opravný doklad, smlouva a protokoly).
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const demo = require('../tools/demo-data');
const bank = require('../src/payments/bank-transfer');
const ledger = require('../src/payments/ledger');
const provider = require('../src/payments/provider');
const mock = require('../src/payments/mock-gateway');
const fio = require('../src/payments/fio-mock');
const documents = require('../src/domain/documents');
const reservations = require('../src/domain/reservations');
const availability = require('../src/domain/availability');
const { getSettings } = require('../src/tenants');

const nb = (s) => String(s).replace(/\u00a0/g, ' ');
const silent = { info() {}, warn() {}, error() {}, debug() {} };

let srv;
let db;
let tenant;
let settings;
let deps;
test.before(async () => {
  srv = await startServer();
  await demo.seed({ db: srv.db, tenant: srv.tenant, config: srv.instance.config, fieldCrypto: srv.app.fieldCrypto, log: silent });
  db = srv.db;
  tenant = srv.tenant;
  settings = getSettings(db, tenant);
  deps = { tenant, settings, fieldCrypto: srv.app.fieldCrypto, secret: srv.app.secret, baseUrl: srv.url, log: silent };
});
test.after(async () => {
  if (srv) await srv.stop();
});

const CUSTOMER = { name: 'Testovací Zákazník', email: 'platby.test@example.com', phone: '+420 777 999 000' };
let seq = 60;
/** Založí novou rezervaci awaiting_fee (1× trek M) na volný termín v budoucnu. */
function newReservation({ slug = 'trek-fx-2', size = 'M', qty = 1, email = CUSTOMER.email } = {}) {
  const today = availability.utcToLocal(new Date()).date;
  seq += 2;
  const from = availability.localToUtc(availability.addDays(today, seq), '09:00');
  const to = availability.localToUtc(availability.addDays(today, seq + 1), '17:00');
  const typeId = db.prepare('SELECT id FROM bike_types WHERE slug = ?').get(slug).id;
  return reservations.create({ db, tenant, settings, fieldCrypto: srv.app.fieldCrypto, secret: srv.app.secret, baseUrl: srv.url, ipHash: 'test', draft: { fromAt: from, toAt: to, items: [{ typeId, size, qty }], customer: { ...CUSTOMER, email }, consents: { termsVersion: '1.0' } } }).reservation;
}

function gwSecret() {
  return mock.gatewaySecret(srv.app.secret, tenant.slug);
}

// ---------------------------------------------------------------------------------------------------------
// Demo data (před testy údržby, které preautorizace uvolňují)

test('demo data: platby, doklady a notifikace brány jsou naplněny a sedí k rezervacím', () => {
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE provider = 'mock' AND status = 'paid' AND purpose = 'fee'").get().n >= 5, 'poplatky kartou');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE method = 'bank_transfer' AND status = 'paid'").get().n >= 2, 'převodem zaplaceno');
  const pending = db.prepare("SELECT p.* FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.method = 'bank_transfer' AND p.status = 'pending' AND r.status = 'awaiting_fee' AND p.idempotency_key LIKE 'demo:%'").get();
  assert.ok(pending, 'čekající převod');
  assert.match(pending.spayd, /^SPD\*1\.0\*ACC:CZ6508000000192000145399\*AM:\d+\.\d\d\*CC:CZK\*X-VS:\d{10}\*MSG:REZERVACE \d{10}\*DT:\d{8}$/);
  assert.ok(db.prepare("SELECT 1 FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.purpose = 'deposit_hold' AND p.status = 'authorized' AND p.provider = 'mock' AND r.status = 'checked_out'").get(), 'preautorizace u vydané');
  assert.ok(db.prepare("SELECT 1 FROM payments WHERE purpose = 'refund' AND status = 'refunded'").get(), 'vratka');
  assert.ok(db.prepare("SELECT 1 FROM documents WHERE type = 'credit_note'").get(), 'opravný doklad k vratce');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE type = 'final_doc'").get().n >= 2, 'konečné doklady uzavřených');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE type = 'contract'").get().n >= 3);
  // výdej = smlouva (SML-) + předávací protokol (PP-), vrácení = protokol o vrácení (VP-) – SPEC kap. 9
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE type = 'handover'").get().n, db.prepare("SELECT COUNT(*) AS n FROM documents WHERE type = 'contract'").get().n, 'ke každé smlouvě PP-');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE type = 'return_protocol'").get().n, db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status IN ('returned','closed')").get().n);
  // demo smlouvy a protokoly jsou vyplněné: doklad nájemce, výrobní čísla kol, žádné „…………“ ani {{…}}
  const legalDocs = db.prepare("SELECT number, type, html FROM documents WHERE type IN ('contract','handover','return_protocol')").all();
  assert.ok(legalDocs.length >= 11);
  for (const d of legalDocs) {
    assert.ok(!d.html.includes('…………'), `${d.number}: „…………“`);
    assert.ok(!d.html.includes('{{'), `${d.number}: nerozvinutý placeholder`);
    assert.ok(!/neuvedeno/.test(d.html), `${d.number}: „neuvedeno“ v demu`);
    if (d.type !== 'return_protocol') assert.match(d.html, /WTU[A-Z]{3}\d{3}DEMO/, `${d.number}: výrobní číslo rámu z bikes.frame_no_enc`);
    if (d.type === 'contract') assert.match(nb(d.html), /Předložený doklad totožnosti: (občanský průkaz|cestovní pas|řidičský průkaz) č\. •••••\d{3}/, `${d.number}: doklad nájemce`);
  }
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM customers c WHERE c.id_doc_type IS NOT NULL AND c.id_doc_number_enc IS NOT NULL AND EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id = c.id AND r.status IN ('checked_out','returned','closed'))").get().n >= 5, 'doklady totožnosti zákazníků vydaných rezervací');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE provider = 'mock'").get().n >= 5);
  // každá zaplacená platba poplatku s ledger záznamem má doklad
  for (const p of db.prepare("SELECT p.* FROM payments p WHERE p.purpose = 'fee' AND p.status IN ('paid','refunded') AND p.idempotency_key LIKE 'demo:%'").all()) {
    assert.ok(db.prepare("SELECT 1 FROM documents WHERE json_extract(data, '$.paymentId') = ? AND type IN ('simplified_tax_doc','tax_doc','receipt')").get(p.id), `doklad k platbě ${p.id}`);
  }
});

// ---------------------------------------------------------------------------------------------------------
// IBAN, SPAYD, QR

test('IBAN z českého čísla účtu (mod 97) a validace', () => {
  assert.equal(bank.ibanFromCzAccount('19-2000145399/0800'), 'CZ6508000000192000145399');
  assert.equal(bank.ibanFromCzAccount('2000145399/0800'), 'CZ7908000000002000145399');
  assert.equal(bank.ibanFromCzAccount(' 19 - 2000145399 / 0800 '), 'CZ6508000000192000145399');
  assert.ok(bank.validateIban('CZ6508000000192000145399'));
  assert.ok(bank.validateIban('CZ9106000000000000000123'));
  assert.ok(bank.validateIban('cz65 0800 0000 1920 0014 5399'), 'mezery a malá písmena');
  assert.equal(bank.validateIban('CZ6508000000192000145390'), false, 'špatný kontrolní součet');
  assert.equal(bank.validateIban(''), false);
  assert.throws(() => bank.ibanFromCzAccount('123456789/0100'), /modulo 11/);
  assert.throws(() => bank.ibanFromCzAccount('abc'), /Neplatné číslo účtu/);
});

test('SPAYD podle specifikace ČBA: pořadí klíčů, částka, VS, MSG bez diakritiky max 60, DT, hvězdička → %2A', () => {
  const s = bank.spayd({ iban: 'CZ9106000000000000000123', amountMinor: 45000, vs: '2610000123', msg: 'Rezervace 123', dueDate: '2026-07-01T08:00:00.000Z' });
  assert.equal(s, 'SPD*1.0*ACC:CZ9106000000000000000123*AM:450.00*CC:CZK*X-VS:2610000123*MSG:REZERVACE 123*DT:20260701');
  const p = bank.parseSpayd(s);
  assert.equal(p.ACC, 'CZ9106000000000000000123');
  assert.equal(p.AM, '450.00');
  assert.equal(p['X-VS'], '2610000123');
  assert.equal(p.DT, '20260701');
  const long = bank.spayd({ iban: 'CZ6508000000192000145399', amountMinor: 1050, msg: `Příliš žluťoučký kůň * ${'x'.repeat(80)}` });
  const msg = bank.parseSpayd(long).MSG;
  assert.ok(!/[^\x20-\x7e]/.test(msg), 'bez diakritiky');
  assert.match(long, /MSG:PRILIS ZLUTOUCKY KUN %2A /);
  assert.ok(/MSG:([^*]*)/.exec(long)[1].length <= 60, 'MSG max 60 znaků');
  assert.match(long, /\*AM:10\.50\*/);
  assert.ok(!/DT:/.test(long), 'bez splatnosti bez DT');
  assert.throws(() => bank.spayd({ iban: 'CZ00', amountMinor: 100 }), /IBAN/);
  assert.throws(() => bank.spayd({ iban: 'CZ6508000000192000145399', amountMinor: 0 }), /částka/i);
  assert.throws(() => bank.spayd({ iban: 'CZ6508000000192000145399', amountMinor: 100, vs: '12345678901' }), /10 číslic/);
});

test('QR SVG: ECC M, čisté SVG bez inline stylů, viewBox, alfanumerický režim', () => {
  const s = bank.spayd({ iban: 'CZ6508000000192000145399', amountMinor: 30000, vs: '2610000001', msg: 'Rezervace 2610000001' });
  assert.ok(bank.isAlphanumeric(s));
  const svg = bank.qrSvg(s);
  assert.ok(svg.startsWith('<svg class="qr-svg"'));
  assert.match(svg, /viewBox="0 0 \d+ \d+"/);
  assert.match(svg, /<path d="M/);
  assert.ok(!/style=/.test(svg), 'bez inline stylů');
  assert.ok(!/<script/.test(svg));
  assert.ok(svg.endsWith('</svg>'));
  const svg2 = bank.qrSvg(s);
  assert.equal(svg, svg2, 'deterministický');
  assert.ok(bank.qrSvg('Žluťoučký kůň').includes('<path'), 'byte režim pro ne-alfanumerický text');
  assert.throws(() => bank.qrSvg(''), /prázdný/);
});

// ---------------------------------------------------------------------------------------------------------
// Ledger

test('ledger: add validuje typ a částku, balance sčítá podle typu a počítá saldo', () => {
  const r = newReservation();
  assert.throws(() => ledger.add(db, { reservationId: r.id, type: 'neznamy', amountMinor: 100 }), /neznámý typ/);
  assert.throws(() => ledger.add(db, { reservationId: r.id, type: 'fee_paid', amountMinor: 0 }), /kladné/);
  let b = ledger.balance(db, r.id);
  assert.equal(b.totalMinor, Number(r.total_minor));
  assert.equal(b.paidMinor, 0);
  assert.equal(b.dueMinor, Number(r.total_minor));
  ledger.add(db, { reservationId: r.id, type: 'fee_paid', amountMinor: 30000 });
  ledger.add(db, { reservationId: r.id, type: 'balance_paid', amountMinor: 5000 });
  ledger.add(db, { reservationId: r.id, type: 'refund', amountMinor: 1000 });
  ledger.add(db, { reservationId: r.id, type: 'deposit_held', amountMinor: 500000 });
  b = ledger.balance(db, r.id);
  assert.equal(b.feePaidMinor, 30000);
  assert.equal(b.balancePaidMinor, 5000);
  assert.equal(b.refundedMinor, 1000);
  assert.equal(b.paidMinor, 34000);
  assert.equal(b.depositHeldMinor, 500000);
  assert.equal(b.dueMinor, Number(r.total_minor) - 34000);
  assert.equal(ledger.list(db, r.id).length, 4);
});

// ---------------------------------------------------------------------------------------------------------
// Karta přes simulační bránu + notifikace

test('mock tok: createPayment (karta) → zaplatit → notifikace → confirmed + ledger + doklad + e-mail s odkazem na doklad; replay = no-op', async () => {
  const r = newReservation();
  const created = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'card', amountMinor: r.fee_minor, capture: 'auto', returnUrl: `${srv.url}/rezervace/hotovo/x`, tenant, settings, baseUrl: srv.url, secret: srv.app.secret, fieldCrypto: srv.app.fieldCrypto });
  assert.equal(created.payment.status, 'created');
  assert.equal(created.payment.provider, 'mock');
  assert.match(created.payment.idempotency_key, /^mock:\d+:fee:card:1$/);
  assert.match(created.redirectUrl, /^\/simulace-brany\/\d+\?sig=/, 'relativní odkaz pro ctx.redirect');
  // znovupoužití neuzavřené platby
  const again = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'card', amountMinor: r.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  assert.equal(again.payment.id, created.payment.id);
  assert.equal(again.reused, true);
  // podvržená notifikace „paid“ před zaplacením nic nezmění (stav se čte z brány)
  let res = provider.processMockNotification({ db, tenant, settings, body: { transId: created.payment.provider_ref, status: 'paid', amount: 1, secret: gwSecret() }, ...deps });
  assert.equal(res.ok, true);
  assert.equal(res.status, 'created');
  assert.equal(res.settled, false);
  assert.equal(reservations.get(db, r.id).status, 'awaiting_fee');
  // zákazník zaplatí na simulační stránce
  const sim = mock.simulate({ db, payment: created.payment, action: 'pay', capture: 'auto' });
  assert.equal(sim.event, 'paid');
  assert.equal(sim.payment.captured_minor, r.fee_minor);
  // špatné tajemství → 403, nic se nemění
  res = provider.processMockNotification({ db, tenant, settings, body: { transId: created.payment.provider_ref, status: 'paid', secret: 'spatne' }, ...deps });
  assert.equal(res.code, 403);
  assert.equal(reservations.get(db, r.id).status, 'awaiting_fee');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM webhook_events WHERE event_id LIKE ?").get(`mock:${created.payment.provider_ref}:%`).n, 1, 'podvržená notifikace se nezapisuje');
  // správná notifikace (částka i status v těle se ignorují)
  res = provider.processMockNotification({ db, tenant, settings, body: { transId: created.payment.provider_ref, status: 'PAID', amount: 1, secret: gwSecret() }, ...deps });
  assert.equal(res.ok, true);
  assert.equal(res.settled, true);
  const after = reservations.get(db, r.id);
  assert.equal(after.status, 'confirmed');
  assert.equal(after.paid_minor, r.fee_minor);
  assert.equal(after.expires_at, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_paid' AND payment_id = ?").get(r.id, created.payment.id).n, 1);
  const docs = documents.listFor(db, r.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0].type, 'simplified_tax_doc');
  assert.match(docs[0].number, /^ZDD-\d{4}-\d{6}$/);
  assert.equal(docs[0].data.paymentId, created.payment.id);
  const mail = db.prepare("SELECT * FROM outbox WHERE type = 'payment_received' AND json_extract(payload, '$.reservationId') = ?").get(r.id);
  assert.ok(mail, 'e-mail platba přijata');
  assert.match(mail.body_text, new RegExp(`Doklad o přijaté platbě ${docs[0].number}: ${srv.url.replace(/[.:/]/g, '\\$&')}/doklady/${docs[0].number}\\?t=`));
  assert.equal(JSON.parse(mail.payload).documentNumber, docs[0].number);
  assert.ok(!mail.body_text.includes('@example.com'), 'adresa není v těle');
  // replay téže notifikace = no-op
  res = provider.processMockNotification({ db, tenant, settings, body: { transId: created.payment.provider_ref, status: 'paid', secret: gwSecret() }, ...deps });
  assert.equal(res.duplicate, true);
  assert.equal(reservations.get(db, r.id).version, after.version);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ?").get(r.id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'payment_received' AND json_extract(payload, '$.reservationId') = ?").get(r.id).n, 1);
  // jiný tvrzený „status“ v těle, ale skutečný stav stejný → tatáž událost (event_id = skutečný stav) → no-op
  res = provider.processMockNotification({ db, tenant, settings, body: { transId: created.payment.provider_ref, status: 'authorized', secret: gwSecret() }, ...deps });
  assert.equal(res.duplicate, true);
  assert.equal(reservations.get(db, r.id).version, after.version);
  assert.deepEqual(db.prepare("SELECT event_id FROM webhook_events WHERE event_id LIKE ? ORDER BY id").all(`mock:${created.payment.provider_ref}:%`).map((e) => e.event_id), [`mock:${created.payment.provider_ref}:created`, `mock:${created.payment.provider_ref}:paid`]);
  // neznámá transakce, chybějící transId
  assert.equal(provider.processMockNotification({ db, tenant, settings, body: { transId: 'MOCK-NEEXISTUJE', status: 'paid', secret: gwSecret() }, ...deps }).code, 404);
  assert.equal(provider.processMockNotification({ db, tenant, settings, body: { status: 'paid', secret: gwSecret() }, ...deps }).code, 400);
  // opakovaná simulace na zaplacené platbě nic nemění
  assert.equal(mock.simulate({ db, payment: created.payment, action: 'decline' }).event, null);
});

test('mock: zamítnutí a zrušení → failed, rezervace zůstává awaiting_fee; další pokus založí novou platbu', async () => {
  const r = newReservation();
  const c1 = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'card', amountMinor: r.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  assert.equal(mock.simulate({ db, payment: c1.payment, action: 'decline' }).event, 'failed');
  const res = provider.processMockNotification({ db, tenant, settings, body: { transId: c1.payment.provider_ref, status: 'failed', secret: gwSecret() }, ...deps });
  assert.equal(res.settled, false);
  assert.equal(reservations.get(db, r.id).status, 'awaiting_fee');
  const c2 = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'card', amountMinor: r.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  assert.notEqual(c2.payment.id, c1.payment.id);
  assert.match(c2.payment.idempotency_key, /:card:2$/);
  assert.equal(mock.simulate({ db, payment: c2.payment, action: 'cancel' }).event, 'cancelled');
  assert.equal(provider.loadPayment(db, c2.payment.id).status, 'failed');
});

test('převod: createPayment (bank_transfer) → pending, SPAYD s VS = číslo rezervace a DT = expirace, QR, IBAN', async () => {
  const r = newReservation();
  const res = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'bank_transfer', amountMinor: r.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  assert.equal(res.payment.status, 'pending');
  assert.equal(res.payment.provider, 'fio-mock');
  assert.equal(res.payment.vs, r.number);
  assert.equal(res.iban, 'CZ6508000000192000145399');
  assert.equal(res.accountNumber, '19-2000145399/0800');
  assert.equal(res.expiresAt, r.expires_at);
  const p = bank.parseSpayd(res.spayd);
  assert.equal(p['X-VS'], r.number);
  assert.equal(p.AM, (r.fee_minor / 100).toFixed(2));
  assert.equal(p.DT, bank.spaydDate(r.expires_at));
  assert.ok(res.qrSvg.startsWith('<svg'));
  assert.equal(res.payment.spayd, res.spayd);
  const again = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'bank_transfer', amountMinor: r.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  assert.equal(again.payment.id, res.payment.id, 'znovupoužití čekajícího převodu');
});

// ---------------------------------------------------------------------------------------------------------
// Fio mock

test('fio mock: přesně → paid + confirmed; přeplatek → paid + kredit v ledgeru; nedoplatek → pending + e-mail s QR; dorovnání → paid', async () => {
  // přesně
  const r1 = newReservation();
  const p1 = (await provider.createPayment({ db, reservation: r1, purpose: 'fee', method: 'bank_transfer', amountMinor: r1.fee_minor, tenant, settings, secret: srv.app.secret })).payment;
  let out = fio.simulateIncoming({ db, amountMinor: r1.fee_minor, vs: r1.number, msg: 'test', counterAccount: '123456789/0100', ...deps });
  assert.equal(out.result.outcome, 'paid');
  assert.equal(out.tx.matched_payment_id, p1.id);
  assert.match(out.tx.tx_id, /^FIO-MOCK-[0-9A-F]{12}$/);
  assert.equal(reservations.get(db, r1.id).status, 'confirmed');
  assert.equal(provider.loadPayment(db, p1.id).status, 'paid');
  assert.equal(documents.listFor(db, r1.id).length, 1);
  // tolerance: o 3 Kč méně → paid
  const r2 = newReservation();
  await provider.createPayment({ db, reservation: r2, purpose: 'fee', method: 'bank_transfer', amountMinor: r2.fee_minor, tenant, settings, secret: srv.app.secret });
  out = fio.simulateIncoming({ db, amountMinor: r2.fee_minor - 300, vs: r2.number, ...deps });
  assert.equal(out.result.outcome, 'paid');
  assert.equal(reservations.get(db, r2.id).status, 'confirmed');
  assert.equal(reservations.get(db, r2.id).paid_minor, r2.fee_minor - 300);
  // přeplatek
  const r3 = newReservation();
  await provider.createPayment({ db, reservation: r3, purpose: 'fee', method: 'bank_transfer', amountMinor: r3.fee_minor, tenant, settings, secret: srv.app.secret });
  out = fio.simulateIncoming({ db, amountMinor: r3.fee_minor + 20000, vs: r3.number, ...deps });
  assert.equal(out.result.outcome, 'overpaid');
  assert.equal(out.result.diffMinor, 20000);
  const led = db.prepare("SELECT * FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_paid'").get(r3.id);
  assert.equal(led.amount_minor, r3.fee_minor + 20000);
  assert.match(led.note, /Přeplatek 200\.00 Kč .*kredit/);
  assert.equal(reservations.get(db, r3.id).paid_minor, r3.fee_minor + 20000);
  // nedoplatek → pending, QR na zbytek, pak dorovnání
  const r4 = newReservation();
  const p4 = (await provider.createPayment({ db, reservation: r4, purpose: 'fee', method: 'bank_transfer', amountMinor: r4.fee_minor, tenant, settings, secret: srv.app.secret })).payment;
  out = fio.simulateIncoming({ db, amountMinor: r4.fee_minor - 10000, vs: r4.number, ...deps });
  assert.equal(out.result.outcome, 'partial');
  assert.equal(out.result.remainingMinor, 10000);
  let fresh = provider.loadPayment(db, p4.id);
  assert.equal(fresh.status, 'pending');
  assert.equal(fresh.captured_minor, r4.fee_minor - 10000);
  assert.equal(bank.parseSpayd(fresh.spayd).AM, '100.00', 'QR na zbytek');
  assert.equal(reservations.get(db, r4.id).status, 'awaiting_fee');
  const qrMail = db.prepare("SELECT * FROM outbox WHERE type = 'balance_qr' AND json_extract(payload, '$.reservationId') = ?").get(r4.id);
  assert.ok(qrMail);
  assert.match(nb(qrMail.body_text), /zbývá doplatit 100 Kč/);
  assert.match(qrMail.body_html, /data:image\/svg\+xml;base64,/);
  out = fio.simulateIncoming({ db, amountMinor: 10000, vs: r4.number, ...deps });
  assert.equal(out.result.outcome, 'paid');
  fresh = provider.loadPayment(db, p4.id);
  assert.equal(fresh.status, 'paid');
  assert.equal(fresh.captured_minor, r4.fee_minor);
  assert.equal(reservations.get(db, r4.id).status, 'confirmed');
  assert.equal(reservations.get(db, r4.id).paid_minor, r4.fee_minor);
});

test('fio mock: bez shody → nespárováno (matched NULL), platba po expiraci nespárována, manualMatch přiřadí ručně', async () => {
  const before = fio.listUnmatched(db).length;
  let out = fio.simulateIncoming({ db, amountMinor: 12300, vs: '9999999999', msg: 'bez rezervace', ...deps });
  assert.equal(out.result.outcome, 'unmatched');
  assert.equal(out.result.reason, 'no_pending_payment');
  assert.equal(out.tx.matched_payment_id, null);
  assert.equal(fio.listUnmatched(db).length, before + 1);
  // bez VS, ale VS v zprávě → spáruje
  const r = newReservation();
  await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'bank_transfer', amountMinor: r.fee_minor, tenant, settings, secret: srv.app.secret });
  out = fio.simulateIncoming({ db, amountMinor: r.fee_minor, vs: '', msg: `platba za rezervaci ${r.number}`, ...deps });
  assert.equal(out.result.outcome, 'paid');
  // rezervace expirovala → platba zůstane nespárovaná (VS sedí, ale rezervace nečeká)
  const r2 = newReservation();
  const p2 = (await provider.createPayment({ db, reservation: r2, purpose: 'fee', method: 'bank_transfer', amountMinor: r2.fee_minor, tenant, settings, secret: srv.app.secret })).payment;
  reservations.transition(db, r2.id, 'expire', { settings });
  out = fio.simulateIncoming({ db, amountMinor: r2.fee_minor, vs: r2.number, ...deps });
  assert.equal(out.result.outcome, 'unmatched');
  assert.equal(out.result.reason, 'reservation_expired');
  // match() znovu projde frontu – stále nespárováno
  const m = fio.match(db, deps);
  assert.ok(m.unmatched.some((u) => u.txId === out.tx.tx_id));
  // ruční přiřazení k jiné čekající platbě
  const r3 = newReservation();
  const p3 = (await provider.createPayment({ db, reservation: r3, purpose: 'fee', method: 'bank_transfer', amountMinor: r3.fee_minor, tenant, settings, secret: srv.app.secret })).payment;
  assert.throws(() => fio.manualMatch(db, out.tx.tx_id, p2.id, deps), /nečeká/);
  const res = fio.manualMatch(db, out.tx.tx_id, p3.id, { ...deps, userId: 1 });
  assert.equal(res.outcome, 'paid');
  assert.equal(reservations.get(db, r3.id).status, 'confirmed');
  assert.equal(db.prepare('SELECT matched_payment_id FROM bank_transactions WHERE tx_id = ?').get(out.tx.tx_id).matched_payment_id, p3.id);
  assert.throws(() => fio.manualMatch(db, out.tx.tx_id, p3.id, deps), /už spárovaný/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'payment.manual_match' AND entity_id = ?").get(String(r3.id)));
  // duplicitní import téhož tx_id = no-op
  assert.equal(fio.importTransaction(db, { txId: out.tx.tx_id, bookedAt: new Date(), amountMinor: 100 }), null);
});

// ---------------------------------------------------------------------------------------------------------
// Preautorizace kauce

test('preautorizace: capture manual → authorized; capture(částka) → partially_captured / captured; cancelHold → released; audit', async () => {
  const r = newReservation();
  const hold = await provider.createPayment({ db, reservation: r, purpose: 'deposit_hold', method: 'card', amountMinor: 500000, capture: 'manual', returnUrl: '/admin/rezervace/1', tenant, settings, secret: srv.app.secret, userId: 1 });
  assert.equal(hold.payment.status, 'created');
  const sim = mock.simulate({ db, payment: hold.payment, action: 'pay', capture: 'manual' });
  assert.equal(sim.event, 'authorized');
  assert.equal(sim.payment.status, 'authorized');
  assert.equal(sim.payment.captured_minor, 0);
  const n = provider.processMockNotification({ db, tenant, settings, body: { transId: hold.payment.provider_ref, status: 'authorized', secret: gwSecret() }, ...deps });
  assert.equal(n.settled, true);
  assert.equal(reservations.get(db, r.id).status, 'awaiting_fee', 'kauce nemění stav rezervace');
  assert.equal(provider.getStatus({ db, payment: hold.payment }).status, 'authorized');
  assert.throws(() => provider.capture({ db, payment: hold.payment, amountMinor: 600000 }), /0 až výše/);
  const part = provider.capture({ db, payment: hold.payment, amountMinor: 120000, userId: 1 });
  assert.equal(part.status, 'partially_captured');
  assert.equal(part.captured_minor, 120000);
  assert.throws(() => provider.capture({ db, payment: hold.payment, amountMinor: 1 }), /jen preautorizovanou/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'payment.capture' AND json_extract(meta, '$.paymentId') = ?").get(hold.payment.id));
  // druhá preautorizace: plné stržení
  const hold2 = await provider.createPayment({ db, reservation: r, purpose: 'deposit_hold', method: 'card', amountMinor: 300000, capture: 'manual', returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  mock.simulate({ db, payment: hold2.payment, action: 'pay' });
  assert.equal(provider.capture({ db, payment: hold2.payment }).status, 'captured');
  // třetí: uvolnění
  const hold3 = await provider.createPayment({ db, reservation: r, purpose: 'deposit_hold', method: 'card', amountMinor: 300000, capture: 'manual', returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  mock.simulate({ db, payment: hold3.payment, action: 'pay' });
  const rel = provider.cancelHold({ db, payment: hold3.payment, userId: 1 });
  assert.equal(rel.status, 'released');
  assert.equal(provider.cancelHold({ db, payment: hold3.payment }).status, 'released', 'idempotentní');
  // kauce hotově: provider manual, authorized, capture/release bez brány
  const cash = await provider.createPayment({ db, reservation: r, purpose: 'deposit_hold', method: 'cash', amountMinor: 200000, tenant, settings, secret: srv.app.secret });
  assert.equal(cash.payment.status, 'authorized');
  assert.equal(cash.payment.provider, 'manual');
  assert.equal(provider.capture({ db, payment: cash.payment, amountMinor: 0 }).status, 'released');
});

test('preautorizace: job upozorní (preauthWarnMinutes) a automaticky uvolní (preauthReleaseMinutes) + interní e-maily obsluze', async () => {
  const r = newReservation();
  const hold = await provider.createPayment({ db, reservation: r, purpose: 'deposit_hold', method: 'card', amountMinor: 400000, capture: 'manual', returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  mock.simulate({ db, payment: hold.payment, action: 'pay' });
  const demoSettings = { ...settings, preauthWarnMinutes: 5, preauthReleaseMinutes: 10 };
  const t0 = new Date(provider.loadPayment(db, hold.payment.id).updated_at).getTime();
  let out = provider.runMaintenance({ db, ...deps, settings: demoSettings, now: new Date(t0 + 60 * 1000) });
  assert.equal(out.preauthWarned, 0);
  out = provider.runMaintenance({ db, ...deps, settings: demoSettings, now: new Date(t0 + 6 * 60 * 1000) });
  assert.equal(out.preauthWarned, 1);
  assert.equal(provider.loadPayment(db, hold.payment.id).status, 'authorized');
  const warn = db.prepare("SELECT * FROM outbox WHERE type = 'internal_preauth_warning' AND json_extract(payload, '$.paymentId') = ?").get(hold.payment.id);
  assert.ok(warn);
  assert.match(warn.subject, /brzy vyprší/);
  assert.equal(warn.to_hmac, srv.app.fieldCrypto.hmacEmail(tenant.business.email), 'interní e-mail obsluze');
  out = provider.runMaintenance({ db, ...deps, settings: demoSettings, now: new Date(t0 + 7 * 60 * 1000) });
  assert.equal(out.preauthWarned, 0, 'upozornění jen jednou');
  out = provider.runMaintenance({ db, ...deps, settings: demoSettings, now: new Date(t0 + 11 * 60 * 1000) });
  assert.equal(out.preauthReleased >= 1, true);
  assert.equal(provider.loadPayment(db, hold.payment.id).status, 'released');
  assert.ok(db.prepare("SELECT 1 FROM outbox WHERE type = 'internal_preauth_released' AND json_extract(payload, '$.paymentId') = ?").get(hold.payment.id));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'payment.release' AND json_extract(meta, '$.paymentId') = ?").get(hold.payment.id));
  // výchozí okna: 7 dní / 5 dní
  const w = provider.preauthWindows({ preauthMaxDays: 7 });
  assert.equal(w.releaseMs, 7 * 86400000);
  assert.equal(w.warnMs, 5 * 86400000);
});

// ---------------------------------------------------------------------------------------------------------
// Vratky a údržba

test('refund: karta mock → refunded + ledger + opravný doklad; převod → pending, confirmRefund → refunded + opravný doklad', async () => {
  // karta
  const r = newReservation();
  const c = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'card', amountMinor: r.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  mock.simulate({ db, payment: c.payment, action: 'pay' });
  provider.processMockNotification({ db, tenant, settings, body: { transId: c.payment.provider_ref, status: 'paid', secret: gwSecret() }, ...deps });
  assert.throws(() => provider.refund({ db, payment: c.payment, amountMinor: r.fee_minor + 1, tenant, settings }), /překračuje/);
  const rf = provider.refund({ db, payment: c.payment, amountMinor: r.fee_minor, reason: 'zrušení půjčovnou', tenant, settings, fieldCrypto: srv.app.fieldCrypto, userId: 1 });
  assert.equal(rf.refund.purpose, 'refund');
  assert.equal(rf.refund.status, 'refunded');
  assert.equal(rf.payment.status, 'refunded');
  assert.ok(rf.document);
  assert.equal(rf.document.type, 'credit_note');
  assert.match(rf.document.number, /^OD-\d{4}-\d{6}$/);
  assert.match(nb(rf.document.html), /Opravovaný doklad<\/dt><dd>č\. ZDD-/);
  assert.match(nb(rf.document.html), /zrušení půjčovnou/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'refund'").get(r.id).n, 1);
  assert.equal(ledger.balance(db, r.id).paidMinor, 0);
  assert.throws(() => provider.refund({ db, payment: c.payment, amountMinor: 100, tenant, settings }), /Vrátit lze jen|překračuje/);
  // převod
  const r2 = newReservation();
  const p2 = (await provider.createPayment({ db, reservation: r2, purpose: 'fee', method: 'bank_transfer', amountMinor: r2.fee_minor, tenant, settings, secret: srv.app.secret })).payment;
  fio.simulateIncoming({ db, amountMinor: r2.fee_minor, vs: r2.number, ...deps });
  const rf2 = provider.refund({ db, payment: p2, amountMinor: 10000, tenant, settings, fieldCrypto: srv.app.fieldCrypto });
  assert.equal(rf2.refund.status, 'pending');
  assert.equal(rf2.refund.method, 'bank_transfer');
  assert.equal(rf2.payment.status, 'partially_refunded');
  assert.equal(rf2.document, null, 'opravný doklad až po provedení vratky');
  const conf = provider.confirmRefund({ db, payment: rf2.refund, tenant, settings, fieldCrypto: srv.app.fieldCrypto, userId: 1 });
  assert.equal(conf.refund.status, 'refunded');
  assert.equal(conf.document.type, 'credit_note');
  assert.equal(documents.listFor(db, r2.id).filter((d) => d.type === 'credit_note').length, 1);
  assert.equal(provider.confirmRefund({ db, payment: rf2.refund, tenant, settings }).document, null, 'idempotentní');
});

test('údržba: ztracená notifikace se dohoní, opuštěná platba u brány po 2 h expiruje, převod zrušené rezervace expiruje', async () => {
  const r = newReservation();
  const c = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'card', amountMinor: r.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  mock.simulate({ db, payment: c.payment, action: 'pay' }); // notifikace „se ztratila“
  let out = provider.runMaintenance({ db, ...deps, now: new Date() });
  assert.equal(out.settled, 1);
  assert.equal(reservations.get(db, r.id).status, 'confirmed');
  assert.equal(documents.listFor(db, r.id).length, 1);
  // opuštěná
  const r2 = newReservation();
  const c2 = await provider.createPayment({ db, reservation: r2, purpose: 'fee', method: 'card', amountMinor: r2.fee_minor, returnUrl: '/x', tenant, settings, secret: srv.app.secret });
  out = provider.runMaintenance({ db, ...deps, now: new Date(Date.now() + 3 * 3600 * 1000) });
  assert.ok(out.expiredCreated >= 1);
  assert.equal(provider.loadPayment(db, c2.payment.id).status, 'expired');
  // převod u zrušené rezervace
  const r3 = newReservation();
  const p3 = (await provider.createPayment({ db, reservation: r3, purpose: 'fee', method: 'bank_transfer', amountMinor: r3.fee_minor, tenant, settings, secret: srv.app.secret })).payment;
  reservations.transition(db, r3.id, 'cancel_by_customer', { settings });
  out = provider.runMaintenance({ db, ...deps, now: new Date() });
  assert.ok(out.expiredTransfers >= 1);
  assert.equal(provider.loadPayment(db, p3.id).status, 'expired');
});

test('platba na místě (hotově / terminál): poplatek ihned paid + confirmed + doklad; doplatek → ledger balance_paid + doklad', async () => {
  const r = newReservation();
  const fee = await provider.createPayment({ db, reservation: r, purpose: 'fee', method: 'cash', amountMinor: r.fee_minor, tenant, settings, fieldCrypto: srv.app.fieldCrypto, secret: srv.app.secret, baseUrl: srv.url, userId: 1 });
  assert.equal(fee.payment.status, 'paid');
  assert.equal(fee.settled.settled, true);
  assert.equal(reservations.get(db, r.id).status, 'confirmed');
  const bal = await provider.createPayment({ db, reservation: r, purpose: 'balance', method: 'terminal', amountMinor: r.total_minor - r.fee_minor, tenant, settings, secret: srv.app.secret, userId: 1 });
  assert.equal(bal.payment.status, 'paid');
  assert.equal(bal.settled.settled, true);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'balance_paid' AND payment_id = ?").get(r.id, bal.payment.id).n, 1);
  assert.equal(ledger.balance(db, r.id).dueMinor, 0);
  const docs = documents.listFor(db, r.id);
  assert.deepEqual(docs.map((d) => d.data.purpose), ['fee', 'balance']);
  // opakované settle nic nepřidá
  assert.equal(provider.settle({ db, payment: bal.payment, tenant, settings }).reason, 'already_settled');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'balance_paid'").get(r.id).n, 1);
});

// ---------------------------------------------------------------------------------------------------------
// Doklady

test('doklady: číselné řady per typ a rok, pravidlo 10 000 Kč (ZDD vs DD), neplátce (PD), DPH shora', () => {
  const year = new Date().getFullYear();
  const prefixBefore = db.prepare("SELECT number FROM documents WHERE number LIKE ? ORDER BY number DESC LIMIT 1").get(`ZDD-${year}-%`);
  const next = documents.nextNumber(db, 'simplified_tax_doc');
  assert.match(next, new RegExp(`^ZDD-${year}-\\d{6}$`));
  if (prefixBefore) assert.equal(Number(next.slice(-6)), Number(prefixBefore.number.slice(-6)) + 1);
  assert.equal(documents.nextNumber(db, 'contract', '2031-01-05T10:00:00.000Z'), 'SML-2031-000001', 'řada začíná každý rok od 1');
  assert.throws(() => documents.nextNumber(db, 'neznamy'), /Neznámý typ/);
  assert.equal(documents.paymentDocType({ tenant, amountMinor: 1000000 }), 'simplified_tax_doc', '10 000 Kč včetně → zjednodušený');
  assert.equal(documents.paymentDocType({ tenant, amountMinor: 1000001 }), 'tax_doc');
  assert.equal(documents.paymentDocType({ tenant: { business: { vatPayer: false } }, amountMinor: 100 }), 'receipt');
  assert.deepEqual(documents.vatSplit(12100, 21), { baseMinor: 10000, vatMinor: 2100, totalMinor: 12100, rate: 21 });
  assert.deepEqual(documents.vatSplit(-12100, 21), { baseMinor: -10000, vatMinor: -2100, totalMinor: -12100, rate: 21 });
  assert.equal(documents.PREFIXES.receipt, 'PD');
  assert.equal(documents.PREFIXES.credit_note, 'OD');
  assert.equal(documents.PREFIXES.handover, 'PP');
  assert.equal(documents.PREFIXES.return_protocol, 'VP');
});

test('doklady: zjednodušený daňový doklad bez identifikace zákazníka (§ 30), daňový doklad nad 10 000 Kč s odběratelem, doklad neplátce', async () => {
  const r = newReservation({ slug: 'cube-touring-hybrid', size: 'L' });
  const fee = { id: 999901, reservation_id: r.id, purpose: 'fee', method: 'card', provider: 'mock', provider_ref: 'MOCK-TEST', amount_minor: r.fee_minor, captured_minor: r.fee_minor, status: 'paid', vs: r.number, updated_at: '2026-06-01T10:00:00.000Z' };
  const zdd = documents.issue(db, 'simplified_tax_doc', r, { tenant, settings, payment: fee, fieldCrypto: srv.app.fieldCrypto, now: '2026-06-01T10:05:00.000Z' });
  const h = nb(zdd.html);
  assert.match(zdd.number, /^ZDD-2026-\d{6}$/);
  assert.match(h, /Zjednodušený daňový doklad/);
  assert.match(h, /U Tří dubů s\.r\.o\./);
  assert.match(h, /DIČ CZ00000000/);
  assert.match(h, /§ 30 zákona č\. 235\/2004 Sb\./);
  assert.ok(!h.includes('Testovací Zákazník'), 'bez identifikace zákazníka');
  assert.match(h, /Datum uskutečnění plnění \/ přijetí platby<\/dt><dd>1\. 6\. 2026/);
  assert.match(h, /Rezervační poplatek – zajištění rezervace č\./);
  assert.match(h, /21 %/);
  assert.match(h, /Přijatá platba celkem<\/span><strong>500 Kč/);
  assert.match(h, /Základ daně/);
  assert.match(h, /413,22 Kč/, 'základ 500 / 1,21');
  assert.match(h, /86,78 Kč/, 'DPH');
  assert.ok(!/ style="/.test(h), 'bez inline stylů');
  assert.ok(documents.wrapPrint(zdd.html).startsWith('<!doctype html>'));
  assert.match(documents.wrapPrint(zdd.html), /<link rel="stylesheet" href="\/css\/doklady\.css">/);
  // nad 10 000 Kč → daňový doklad s odběratelem
  const big = { ...fee, id: 999902, amount_minor: 1500000, captured_minor: 1500000 };
  const dd = documents.issueForPayment(db, { reservation: r, payment: big, tenant, settings, fieldCrypto: srv.app.fieldCrypto, now: '2026-06-02T10:00:00.000Z' });
  assert.equal(dd.type, 'tax_doc');
  assert.match(dd.number, /^DD-2026-/);
  assert.match(nb(dd.html), /Odběratel<\/p>\s*<p><strong>Testovací Zákazník/);
  assert.ok(!/§ 30 zákona/.test(dd.html));
  assert.equal(documents.issueForPayment(db, { reservation: r, payment: big, tenant, settings, now: '2026-06-02T10:00:00.000Z' }).existing, true, 'idempotentní podle platby');
  // neplátce
  const nonVat = { ...tenant, business: { ...tenant.business, vatPayer: false, dic: '' } };
  const pd = documents.issueForPayment(db, { reservation: r, payment: { ...fee, id: 999903 }, tenant: nonVat, settings, now: '2026-06-03T10:00:00.000Z' });
  assert.equal(pd.type, 'receipt');
  assert.match(pd.number, /^PD-2026-/);
  assert.match(nb(pd.html), /Nejsme plátci DPH/);
  assert.match(nb(pd.html), /není plátcem DPH/);
  assert.ok(!/DIČ/.test(pd.html));
  assert.equal(documents.get(db, pd.number).type, 'receipt');
  assert.equal(documents.get(db, 'XX-0000-000000'), null);
});

test('doklady: konečný doklad uzavřené rezervace započítá poplatek, rozepíše DPH 21 % a vyúčtuje kauci / škodu', () => {
  const closed = db.prepare("SELECT * FROM reservations WHERE status = 'closed' ORDER BY id LIMIT 1").get();
  documents.syncReservation(db, closed.id, deps);
  const fd = db.prepare("SELECT * FROM documents WHERE reservation_id = ? AND type = 'final_doc'").get(closed.id);
  assert.ok(fd);
  assert.match(fd.number, /^KD-\d{4}-\d{6}$/);
  const h = nb(fd.html);
  assert.match(h, /Konečný daňový doklad – vyúčtování/);
  assert.match(h, /Započtení rezervačního poplatku \(doklad č\. ZDD-/);
  assert.match(h, /§ 37a zákona o DPH/);
  assert.match(h, /Rekapitulace DPH/);
  assert.match(h, /Odběratel<\/p>\s*<p><strong>/);
  assert.match(h, /Uhrazeno v plné výši|Zbývá uhradit|Přeplatek k vrácení/);
  assert.match(h, /Kauce \d/);
  assert.equal(documents.issueFinal(db, { reservation: closed, tenant, settings }).existing, true);
  // syncAll nic dalšího nevystaví
  assert.equal(documents.syncAll(db, deps), 0);
});

test('doklady: smlouva (ČÁST A + B) vystaví i předávací protokol PP-, řádky per kolo s výrobním číslem, protokol o vrácení s vyúčtováním; bez „…………“', () => {
  // vydaná rezervace se 2 koly (r4: 2× horské kolo, kauce preautorizací)
  const co = db.prepare("SELECT r.* FROM reservations r WHERE r.status = 'checked_out' AND (SELECT COUNT(*) FROM reservation_items i WHERE i.reservation_id = r.id) = 2 ORDER BY r.id LIMIT 1").get();
  assert.ok(co, 'vydaná rezervace se dvěma koly');
  const before = db.prepare("SELECT COUNT(*) AS n FROM documents WHERE reservation_id = ? AND type = 'handover'").get(co.id).n;
  const sml = documents.issueContract(db, { reservation: co, kind: 'contract', tenant, settings, fieldCrypto: srv.app.fieldCrypto, operator: { id: 1, name: 'Správce D.' }, customer: { name: 'Jan Nájemce', phone: '+420 777 000 004', email: 'jan@example.com', idDocType: 'občanský průkaz', idDocNumberMasked: '•••••123' } });
  assert.match(sml.number, /^SML-\d{4}-\d{6}$/);
  const h = nb(sml.html);
  assert.match(h, /ČÁST A – Smlouva o nájmu jízdního kola č\. SML-/);
  assert.match(h, /ČÁST B – Předávací protokol č\. SML-/);
  assert.ok(!/ČÁST C/.test(h), 'protokol o vrácení (ČÁST C) se tiskne až při vrácení jako VP-');
  assert.ok(!/ČÁST D/.test(h), 'ČÁST D se nerenderuje');
  assert.ok(!/K ověření advokátem/.test(h));
  assert.ok(!/\{\{/.test(h), 'žádné nerozvinuté placeholdery');
  assert.ok(!h.includes('…………'), 'smlouva bez „…………“');
  assert.match(h, /Jan Nájemce/);
  assert.match(h, /občanský průkaz č\. •••••123/);
  assert.match(h, /Správce D\./);
  assert.match(h, new RegExp(`k rezervaci č\\. ${co.number}`));
  assert.match(h, /Horské kolo Specialized Rockhopper/);
  // cyklus {{#KOLA}}: každé kolo vlastní řádek B.1 s inventárním kódem a dešifrovaným výrobním číslem
  const rows = [...h.matchAll(/<td>(\d)<\/td><td>Horské kolo Specialized Rockhopper<\/td><td>(MTB-\d\d)<\/td><td>([A-Z"0-9]+)<\/td><td>(WTUMTB\d{3}DEMO)<\/td>/g)];
  assert.equal(rows.length, 2, 'dva řádky B.1');
  assert.deepEqual(rows.map((m) => m[1]), ['1', '2']);
  assert.notEqual(rows[0][2], rows[1][2]);
  assert.match(h, /Forma \(preautorizace kartou\)/);
  assert.match(h, /ref\. MOCK-HOLD-/);
  assert.match(h, /účet pro vratku: –/, 'u preautorizace není účet pro vratku relevantní');
  assert.deepEqual(JSON.parse(db.prepare('SELECT data FROM documents WHERE id = ?').get(sml.id).data).missing, []);
  // předávací protokol vznikl spolu se smlouvou
  assert.ok(sml.handover, 'smlouva vrací i předávací protokol');
  assert.match(sml.handover.number, /^PP-\d{4}-\d{6}$/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM documents WHERE reservation_id = ? AND type = 'handover'").get(co.id).n, before + 1);
  const ph = nb(sml.handover.html);
  assert.match(ph, /ČÁST B – Předávací protokol č\. SML-/);
  assert.match(ph, new RegExp(`ke smlouvě č\\. ${sml.number}`));
  assert.ok(!/ČÁST A/.test(ph) && !/ČÁST C/.test(ph));
  assert.ok(!ph.includes('…………'));
  assert.equal(JSON.parse(db.prepare('SELECT data FROM documents WHERE id = ?').get(sml.handover.id).data).contractNumber, sml.number);
  // samostatný protokol lze vystavit i bez smlouvy; handover: false smlouvu nedoplní
  const pp = documents.issueContract(db, { reservation: co, kind: 'handover', tenant, settings, operator: { name: 'Správce D.' } });
  assert.match(pp.number, /^PP-/);
  assert.match(pp.html, /ČÁST B/);
  assert.ok(!/ČÁST A/.test(pp.html) && !/ČÁST C/.test(pp.html));
  const alone = documents.issueContract(db, { reservation: co, kind: 'contract', tenant, settings, handover: false, operator: { name: 'Správce D.' } });
  assert.equal(alone.handover, undefined);
  // protokol o vrácení: číslo smlouvy najde sám, '…………' v extra = nevyplněno, baterie per kolo
  const vp = documents.issueContract(db, { reservation: co, kind: 'return_protocol', tenant, settings, operator: { name: 'Správce D.' }, legal: { KOLO_VRACENI_STAV: 'v pořádku', SKODA_POPIS: '…………' } });
  assert.match(vp.number, /^VP-/);
  const vh = nb(vp.html);
  assert.match(vh, /ČÁST C – Protokol o vrácení č\. VP-/);
  assert.match(vh, new RegExp(`Ke smlouvě č\\. ${alone.number}`), 'poslední smlouva rezervace');
  assert.ok(!/ČÁST A/.test(vp.html) && !/ČÁST B/.test(vp.html));
  assert.ok(!vh.includes('…………'), 'protokol o vrácení bez „…………“');
  assert.match(vh, /Náhrada škody na kolech: bez škody/);
  assert.match(vh, /Konečný daňový doklad č\. \(vystaví se při uzavření rezervace\)/);
  assert.match(vh, /Kauce složená při převzetí \(preautorizace kartou\)/);
  assert.match(vh, /uvolnění preautorizace \(ref\. MOCK-HOLD-/);
  assert.equal((vh.match(/<td>MTB-\d\d<\/td><td>v pořádku<\/td>/g) || []).length, 2, 'řádek C.2 pro každé kolo');
  assert.throws(() => documents.issueContract(db, { reservation: co, kind: 'jiny', tenant, settings }), /Neznámý druh/);
});

test('doklady: protokol o vrácení vrácené rezervace s poškozením započte škodu na kauci; smlouva s kaucí hotově má účet pro vratku', () => {
  const ret = db.prepare("SELECT * FROM reservations WHERE status = 'returned' ORDER BY id LIMIT 1").get();
  const damage = db.prepare("SELECT SUM(amount_minor) AS s FROM ledger_entries WHERE reservation_id = ? AND type = 'damage'").get(ret.id).s;
  assert.ok(damage > 0, 'demo vrácená rezervace má škodu');
  const vp = db.prepare("SELECT html FROM documents WHERE reservation_id = ? AND type = 'return_protocol' ORDER BY id DESC LIMIT 1").get(ret.id);
  const vh = nb(vp.html);
  assert.match(vh, /<td>ETR-\d\d<\/td><td>poškozeno<\/td><td>Škrábanec/);
  assert.match(vh, /Náhrada škody na kolech: Škrábanec/);
  assert.match(vh, /Započteno[^|]*<\/td><td>− 500 Kč/);
  assert.match(vh, /Vráceno \/ uvolněno ihned<\/strong><\/td><td><strong>9 500 Kč<\/strong>/);
  assert.match(vh, /Baterie \(e-kolo\)/);
  assert.match(vh, /40 %/, 'nabití baterie per kolo z demo dat');
  // smlouva s kaucí hotově (r2)
  const cash = db.prepare("SELECT d.html FROM documents d JOIN reservations r ON r.id = d.reservation_id WHERE d.type = 'contract' AND r.deposit_method = 'cash' ORDER BY d.id LIMIT 1").get();
  assert.ok(cash);
  const ch = nb(cash.html);
  assert.match(ch, /Účet pro vrácení kauce[^<]*doplní nájemce/);
  assert.match(ch, /Forma \(hotově\)/);
  assert.match(ch, /transakce č\. –/);
  // uzavřená rezervace: protokol o vrácení zná konečný doklad a vypořádání kauce z ledgeru
  const closedVp = db.prepare("SELECT d.html FROM documents d JOIN reservations r ON r.id = d.reservation_id WHERE d.type = 'return_protocol' AND r.status = 'closed' ORDER BY d.id LIMIT 1").get();
  assert.match(nb(closedVp.html), /Konečný daňový doklad č\. KD-\d{4}-\d{6}\./);
  assert.match(nb(closedVp.html), /Vráceno \/ uvolněno ihned<\/strong><\/td><td><strong>10 000 Kč<\/strong> – uvolnění preautorizace/);
});
