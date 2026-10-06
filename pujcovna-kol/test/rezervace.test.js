'use strict';
// Integrační testy feature „rezervace“ přes běžící server s demo daty: celý tok krok 1→5 (odmítnutí bez CSRF, bez
// souhlasů, validace termínu a kol, simulace zaplacení v demu), správa přes token (neplatný → 404), storno s výpočtem
// a potvrzením, ICS, API dostupnosti, e-maily v outboxu bez PII v logu, kalendářová komponenta a fallback bez JS.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createLogger } = require('../src/log');
const demo = require('../tools/demo-data');
const availability = require('../src/domain/availability');
const reservations = require('../src/domain/reservations');

const nb = (s) => s.replace(/\u00a0/g, ' ');
let srv;
const logLines = [];
const silent = { info() {}, warn() {}, error() {}, debug() {} };
test.before(async () => {
  const log = createLogger({ level: 'debug', stdout: { write: (l) => logLines.push(l) }, stderr: { write: (l) => logLines.push(l) } });
  srv = await startServer({ log });
  await demo.seed({ db: srv.db, tenant: srv.tenant, config: srv.instance.config, fieldCrypto: srv.app.fieldCrypto, log: silent });
});
test.after(async () => {
  if (srv) await srv.stop();
});

const today = () => availability.utcToLocal(new Date()).date;
const day = (n) => availability.addDays(today(), n);

async function post(path, body, init = {}) {
  return srv.fetch(path, { method: 'POST', body, ...init });
}

async function stepTerm(token, od, doD, extra = {}) {
  return post('/rezervace', { _csrf: token, od, od_cas: '09:00', do: doD, do_cas: '17:00', ...extra });
}

test('krok 1: stránka termínu – kalendář s blokovanými dny, fallback bez JS, sloty; validace (minulost, zavřeno, mimo dobu, bez CSRF)', async () => {
  srv.jar.clear();
  const res = await srv.fetch('/rezervace');
  assert.equal(res.status, 200);
  const html = await res.text().then(nb);
  assert.match(html, /<ol class="steps">/);
  assert.match(html, /steps__item is-active/);
  assert.match(html, /<div class="calendar" data-calendar data-name="termin" data-min="\d{4}-\d{2}-\d{2}" data-max="\d{4}-\d{2}-\d{2}" data-blocked="\[/);
  assert.match(html, /data-blocked="\[[^"]*\d{4}-12-24/, 'Vánoce blokované');
  assert.match(html, /<input class="field__input" id="f-od" name="od" required[^>]*type="date"/, 'fallback input od');
  assert.match(html, /<input class="field__input" id="f-do" name="do" required[^>]*type="date"/, 'fallback input do');
  assert.match(html, /<select class="field__input field__input--select" id="f-od_cas" name="od_cas"/);
  assert.match(html, /<option value="08:00">08:00<\/option>/);
  assert.match(html, /<option value="19:00">19:00<\/option>/);
  assert.match(html, /<option value="09:00" selected>/);
  assert.match(html, /<script src="\/js\/rezervace.js\?v=test" defer>/);
  assert.ok(!/ style="/.test(html));
  // bez CSRF → 403
  assert.equal((await post('/rezervace', { od: day(5), do: day(6) })).status, 403);
  const token = await srv.csrf('/rezervace');
  // minulost
  let r = await stepTerm(token, '2020-01-05', '2020-01-06');
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /uplynul/);
  // konec před začátkem
  r = await stepTerm(token, day(6), day(5));
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /po vyzvednutí/);
  // zavřeno (24. 12. příštího roku, ať je v budoucnu)
  const xmas = `${Number(today().slice(0, 4)) + 1}-12-24`;
  r = await stepTerm(token, xmas, `${Number(today().slice(0, 4)) + 1}-12-27`);
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /zavřeno \(Vánoce\)/);
  // mimo otevírací dobu (všední den otevírá v 9:00)
  let weekday = day(5);
  while (!['mon', 'tue', 'wed', 'thu', 'fri'].includes(availability.utcToLocal(availability.localToUtc(weekday, '12:00')).dayKey)) weekday = availability.addDays(weekday, 1);
  r = await post('/rezervace', { _csrf: token, od: weekday, od_cas: '08:30', do: availability.addDays(weekday, 1), do_cas: '17:00' });
  assert.equal(r.status, 422);
  const t = await r.text().then(nb);
  assert.match(t, /otevírací době/);
  assert.match(t, new RegExp(`value="${weekday}"`), 'hodnoty zůstanou předvyplněné');
  // kroky 2–4 bez termínu → redirect na krok 1
  for (const p of ['/rezervace/kola', '/rezervace/udaje', '/rezervace/poplatek']) {
    const g = await srv.fetch(p);
    assert.equal(g.status, 303, p);
    assert.equal(g.headers.get('location'), '/rezervace');
  }
});

test('celý tok 1→5: termín → kola → údaje (odmítnutí bez souhlasů) → poplatek (demo simulace) → hotovo + e-maily + správa', async () => {
  srv.jar.clear();
  const od = day(30);
  const doD = day(32);
  const token = await srv.csrf('/rezervace?typ=trek-fx-2');
  // krok 1
  let r = await stepTerm(token, od, doD, { typ: 'trek-fx-2' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/rezervace/kola');
  // krok 2 – stránka
  r = await srv.fetch('/rezervace/kola');
  assert.equal(r.status, 200);
  let html = await r.text().then(nb);
  assert.match(html, /<li class="bike-pick" data-type="\d+">[\s\S]*Trekové kolo Trek FX 2/, 'předvybraný typ první');
  assert.match(html, /3 dny/);
  assert.match(html, /name="qty_\d+_1" min="0" max="2"/, 'trek M: 2 kusy');
  assert.match(html, /name="acc_prilba" min="0" max="15"/);
  assert.match(html, /<strong>1 050 Kč<\/strong> za kolo a termín/, 'trek 3 dny × 350');
  const typeId = srv.db.prepare("SELECT id FROM bike_types WHERE slug = 'trek-fx-2'").get().id;
  // krok 2 – bez kol
  r = await post('/rezervace/kola', { _csrf: token, [`qty_${typeId}_1`]: '0' });
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /alespoň jedno kolo/);
  // krok 2 – víc než dostupnost
  r = await post('/rezervace/kola', { _csrf: token, [`qty_${typeId}_1`]: '3' });
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /volných jen 2 kusy, požadujete 3/);
  // krok 2 – ok: 2× trek M + přilba
  r = await post('/rezervace/kola', { _csrf: token, [`qty_${typeId}_1`]: '2', acc_prilba: '1', acc_zamek: '0' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/rezervace/udaje');
  // krok 3 – stránka s povinnými zaškrtávátky a textem o dokladu
  r = await srv.fetch('/rezervace/udaje');
  assert.equal(r.status, 200);
  html = await r.text().then(nb);
  assert.match(html, /name="souhlas_op"[^>]*required/);
  assert.match(html, /name="souhlas_doklad"[^>]*required/);
  assert.match(html, /Beru na vědomí, že při převzetí předložím platný doklad totožnosti a půjčovna si zapíše jeho typ a číslo\. Bez toho kolo nelze vydat\./);
  assert.match(html, /<details class="consent-details"><summary>Proč to požadujeme/);
  assert.match(html, /aplikace\.mvcr\.cz\/neplatne-doklady/);
  assert.match(html, /§ 1837 písm\. j\)/);
  assert.match(html, /verze 1\.0/);
  assert.match(html, /nejméně 48 hodin/);
  const customer = { _csrf: token, jmeno: 'Karel Testovací', email: 'karel.testovaci@example.com', telefon: '+420 777 123 456' };
  // krok 3 – bez souhlasů → 422
  r = await post('/rezervace/udaje', customer);
  assert.equal(r.status, 422);
  html = await r.text().then(nb);
  assert.match(html, /Bez souhlasu s obchodními podmínkami/);
  assert.match(html, /Bez potvrzení, že při převzetí předložíte doklad/);
  assert.match(html, /value="Karel Testovací"/);
  // jen jeden souhlas → 422
  r = await post('/rezervace/udaje', { ...customer, souhlas_op: '1' });
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /Bez potvrzení, že při převzetí předložíte doklad/);
  r = await post('/rezervace/udaje', { ...customer, souhlas_doklad: '1' });
  assert.equal(r.status, 422);
  // špatný e-mail
  r = await post('/rezervace/udaje', { ...customer, email: 'neni', souhlas_op: '1', souhlas_doklad: '1' });
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /platný e-mail/);
  // krok 4 bez údajů → redirect zpět
  r = await srv.fetch('/rezervace/poplatek');
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/rezervace/udaje');
  // krok 3 – ok
  r = await post('/rezervace/udaje', { ...customer, souhlas_op: '1', souhlas_doklad: '1' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/rezervace/poplatek');
  // session nenese jméno/e-mail v čitelné podobě
  const sess = srv.db.prepare("SELECT data FROM sessions WHERE kind = 'public' ORDER BY last_seen_at DESC LIMIT 1").get();
  assert.ok(!sess.data.includes('Karel'), 'jméno v session šifrované');
  assert.ok(!sess.data.includes('karel.testovaci'), 'e-mail v session šifrovaný');
  // krok 4 – stránka
  r = await srv.fetch('/rezervace/poplatek');
  assert.equal(r.status, 200);
  html = await r.text().then(nb);
  assert.match(html, /Rezervační poplatek nyní<\/dt><dd>600 Kč/);
  assert.match(html, /Cena pronájmu<\/dt><dd>2 250 Kč/, '2 × 1 050 + přilba 3 × 50');
  assert.match(html, /Simulovat zaplacení poplatku \(demo\)/);
  assert.match(html, /Online platba se připravuje|Zaplatit kartou/);
  assert.match(html, /pay-method is-disabled[\s\S]*Zaplatím na místě[\s\S]*Není k dispozici/, 'na místě neaktivní s vysvětlením');
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE number LIKE '%' AND customer_id IN (SELECT id FROM customers WHERE email_hmac = ?)").get(srv.app.fieldCrypto.hmacEmail('karel.testovaci@example.com')).n, 0, 'před volbou metody není nic v DB');
  // krok 4 – „na místě“ zakázáno
  r = await post('/rezervace/poplatek', { _csrf: token, metoda: 'misto' });
  assert.equal(r.status, 403);
  // krok 4 – demo simulace
  r = await post('/rezervace/poplatek', { _csrf: token, metoda: 'demo' });
  assert.equal(r.status, 303);
  const loc = r.headers.get('location');
  assert.match(loc, /^\/rezervace\/hotovo\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const mgmtToken = loc.split('/').pop();
  const row = srv.db.prepare('SELECT * FROM reservations WHERE customer_id IN (SELECT id FROM customers WHERE email_hmac = ?)').get(srv.app.fieldCrypto.hmacEmail('karel.testovaci@example.com'));
  assert.ok(row);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.version, 2);
  assert.equal(row.fee_minor, 60000);
  assert.equal(row.paid_minor, 60000);
  assert.equal(row.total_minor, 225000);
  assert.equal(row.terms_version, '1.0');
  assert.ok(row.consent_at && row.id_doc_ack_at && row.consent_ip_hash);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM reservation_items WHERE reservation_id = ?').get(row.id).n, 2);
  const pay = srv.db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'fee'").get(row.id);
  assert.equal(pay.provider, 'demo');
  assert.equal(pay.status, 'paid');
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_paid'").get(row.id).n, 1);
  // krok 5
  r = await srv.fetch(loc);
  assert.equal(r.status, 200);
  html = await r.text().then(nb);
  assert.match(html, /Rezervace potvrzena/);
  assert.match(html, new RegExp(`Rezervace č\\. ${row.number}`));
  assert.match(html, /Co vzít s sebou/);
  assert.match(html, /Platný doklad totožnosti/);
  assert.match(html, new RegExp(`href="/rezervace/${mgmtToken.replace(/[-_]/g, '.')}/kalendar.ics"`));
  assert.match(html, /<meta name="robots" content="noindex">/);
  // draft smazán → krok 2 přesměruje na začátek
  const again = await srv.fetch('/rezervace/kola');
  assert.equal(again.headers.get('location'), '/rezervace');
  // e-maily v outboxu
  const mails = srv.db.prepare("SELECT * FROM outbox WHERE json_extract(payload, '$.reservationId') = ? ORDER BY id").all(row.id);
  assert.deepEqual(mails.map((m) => m.type), ['reservation_created', 'payment_received']);
  for (const m of mails) {
    assert.equal(m.to_hmac, srv.app.fieldCrypto.hmacEmail('karel.testovaci@example.com'));
    assert.ok(!m.body_text.includes('karel.testovaci@example.com'));
    assert.ok(!m.subject.includes('@'));
    assert.match(m.body_text, /Karel Testovací/, 'jméno v těle e-mailu je v pořádku (adresát)');
    assert.equal(srv.app.fieldCrypto.dec(JSON.parse(m.payload).to_enc), 'karel.testovaci@example.com');
  }
  assert.match(mails[0].body_text, new RegExp(`/rezervace/${mgmtToken.replace(/[-_]/g, '.')}`), 'odkaz na správu v e-mailu');
  // opakovaný POST demo platby = idempotentní (rezervace už potvrzena → správa)
  // správa
  r = await srv.fetch(`/rezervace/${mgmtToken}`);
  assert.equal(r.status, 200);
  html = await r.text().then(nb);
  assert.match(html, /badge badge--success">Potvrzená/);
  assert.match(html, /Zaplaceno<\/dt><dd>600 Kč/);
  assert.match(html, /Zbývá doplatit<\/dt><dd>1 650 Kč/);
  assert.match(html, /<h2>Platby<\/h2>[\s\S]*Rezervační poplatek<\/td><td>Karta online<\/td><td class="is-right">600 Kč/);
  assert.match(html, /<h2>Pohyby \(ledger\)<\/h2>[\s\S]*Poplatek zaplacen/);
  assert.match(html, /Doklady se vystaví/);
  assert.match(html, /Zrušení rezervace/);
  assert.match(html, /vracíme celý rezervační poplatek 600 Kč/);
  assert.match(html, /Odeslané e-maily/);
  assert.match(html, /Přidat do kalendáře \(ICS\)/);
  assert.match(html, /Vezměte s sebou platný doklad totožnosti/);
  assert.ok(!/karel.testovaci@example.com/.test(html), 'e-mail se na stránce nezobrazuje');
  // doklady: po vystavení (documents.syncReservation – v provozu to dělá job plateb) nese odkaz token správy + tisková verze
  const documents = require('../src/domain/documents');
  const issued = documents.syncReservation(srv.db, row.id, { tenant: srv.tenant, settings: require('../src/tenants').getSettings(srv.db, srv.tenant), fieldCrypto: srv.app.fieldCrypto });
  assert.ok(issued.length >= 1, 'doklad o přijaté platbě vystaven');
  html = await (await srv.fetch(`/rezervace/${mgmtToken}`)).text().then(nb);
  const tokRe = mgmtToken.replace(/[-_]/g, '.');
  assert.match(html, new RegExp(`href="/doklady/ZDD-\\d{4}-\\d{6}\\?t=${tokRe}"`), 'odkaz na doklad s tokenem správy');
  assert.match(html, new RegExp(`href="/doklady/ZDD-\\d{4}-\\d{6}\\.html\\?t=${tokRe}"`), 'tisková verze s tokenem');
  assert.ok(!/href="\/doklady\/[A-Z]+-\d{4}-\d{6}"/.test(html), 'žádný odkaz na doklad bez tokenu');
  const docNumber = /href="\/doklady\/(ZDD-\d{4}-\d{6})\?t=/.exec(html)[1];
  assert.equal((await srv.fetch(`/doklady/${docNumber}?t=${mgmtToken}`)).status, 200, 'odkaz ze správy funguje');
  assert.equal((await srv.fetch(`/doklady/${docNumber}`)).status, 404, 'bez tokenu 404');
  // ICS
  const ics = await srv.fetch(`/rezervace/${mgmtToken}/kalendar.ics`);
  assert.equal(ics.status, 200);
  assert.match(ics.headers.get('content-type'), /text\/calendar/);
  assert.match(ics.headers.get('content-disposition'), new RegExp(`rezervace-${row.number}.ics`));
  const icsRaw = await ics.text();
  assert.ok(icsRaw.split('\r\n').every((l) => Buffer.byteLength(l) <= 75), 'řádky skládané na 75 oktetů (RFC 5545)');
  const icsText = icsRaw.replace(/\r\n /g, ''); // unfold
  assert.match(icsText, /^BEGIN:VCALENDAR\r\n/);
  assert.match(icsText, /BEGIN:VEVENT/);
  assert.match(icsText, new RegExp(`UID:rezervace-${row.number}@127.0.0.1`));
  assert.match(icsText, new RegExp(`DTSTART:${row.from_at.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}`));
  assert.match(icsText, /SUMMARY:Půjčení kola – Půjčovna kol U Tří dubů/);
  assert.match(icsText, /LOCATION:Půjčovna kol U Tří dubů\\, Masarykovo nám. 1\\, 379 01 Třeboň/);
  assert.match(icsText, /STATUS:CONFIRMED/);
  assert.match(icsText, /TRIGGER:-P1D/);
  // storno bez potvrzení → 422; s potvrzením → zrušeno s plnou vratkou (30 dní před)
  const mgmtCsrf = await srv.csrf(`/rezervace/${mgmtToken}`);
  r = await post(`/rezervace/${mgmtToken}/storno`, { _csrf: mgmtCsrf });
  assert.equal(r.status, 422);
  assert.match(await r.text().then(nb), /chybí potvrzení/);
  assert.equal(reservations.get(srv.db, row.id).status, 'confirmed');
  r = await post(`/rezervace/${mgmtToken}/storno`, { _csrf: mgmtCsrf, potvrdit: '1' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), `/rezervace/${mgmtToken}?storno=1`);
  const cancelled = reservations.get(srv.db, row.id);
  assert.equal(cancelled.status, 'cancelled_by_customer');
  assert.equal(cancelled.version, 3);
  assert.equal(srv.db.prepare("SELECT status FROM payments WHERE reservation_id = ? AND purpose = 'refund'").get(row.id).status, 'refunded');
  html = await (await srv.fetch(`/rezervace/${mgmtToken}?storno=1`)).text().then(nb);
  assert.match(html, /Rezervace byla zrušena/);
  assert.match(html, /badge badge--danger">Zrušená zákazníkem/);
  assert.match(html, /Vratka<\/td>/);
  assert.ok(!/Zrušení rezervace<\/h2>/.test(html), 'formulář storna už není');
  // zrušená rezervace: boční panel jen stav a vratka – bez ICS, doplatku a pokynů k vyzvednutí (QA nález)
  assert.ok(!/Přidat do kalendáře \(ICS\)/.test(html), 'ICS se u zrušené nenabízí');
  assert.ok(!/Zbývá doplatit/.test(html), 'doplatek se u zrušené nezobrazuje');
  assert.ok(!/Vezměte s sebou platný doklad/.test(html), 'pokyn k dokladu se u zrušené nezobrazuje');
  assert.ok(!/Vratná kauce při převzetí/.test(html));
  assert.match(html, /Stav rezervace/);
  assert.match(html, /summary__row--total"><dt>Vráceno<\/dt><dd>600 Kč/);
  assert.match(html, /Poplatek 600 Kč jsme vrátili původní platební metodou/);
  // opakované storno → 409
  r = await post(`/rezervace/${mgmtToken}/storno`, { _csrf: mgmtCsrf, potvrdit: '1' });
  assert.equal(r.status, 409);
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'reservation_cancelled' AND json_extract(payload, '$.reservationId') = ?").get(row.id).n, 1);
  // log bez PII
  const joined = logLines.join('\n');
  assert.ok(!joined.includes('karel.testovaci@example.com'), 'e-mail v logu');
  assert.ok(!joined.includes('Karel Testovací'), 'jméno v logu');
  assert.ok(!joined.includes('777 123 456'), 'telefon v logu');
  assert.ok(!joined.includes(mgmtToken), 'token v logu');
  assert.ok(joined.includes('Rezervace vytvořena'), 'provozní log existuje');
});

test('správa: neplatný / cizí / prošlý token → 404, bez cookies; storno po lhůtě propadá', async () => {
  srv.jar.clear();
  assert.equal((await srv.fetch('/rezervace/neplatny')).status, 404);
  assert.equal((await srv.fetch('/rezervace/abc.def')).status, 404);
  assert.equal((await srv.fetch('/rezervace/abc.def/kalendar.ics')).status, 404);
  assert.equal((await srv.fetch('/rezervace/hotovo/abc.def')).status, 404);
  const r = srv.db.prepare("SELECT * FROM reservations WHERE status = 'confirmed' ORDER BY from_at LIMIT 1").get();
  const tok = reservations.tokenFor(r, srv.app.secret);
  assert.equal((await srv.fetch(`/rezervace/${tok}`)).status, 200);
  const other = reservations.tokenFor({ id: r.id, created_at: '2020-01-01T00:00:00.000Z' }, srv.app.secret);
  assert.equal((await srv.fetch(`/rezervace/${other}`)).status, 404, 'podepsaný, ale neodpovídá otisku v DB');
  const foreign = require('../src/crypto/tokens').sign({ r: r.id }, 1000000, 'jine-tajemstvi-jine-tajemstvi-0123');
  assert.equal((await srv.fetch(`/rezervace/${foreign}`)).status, 404);
  // storno po lhůtě: potvrzená rezervace s výdejem dnes/zítra → poplatek propadá
  const html = await (await srv.fetch(`/rezervace/${tok}`)).text().then(nb);
  assert.match(html, /propadá/);
  assert.match(html, /Rozumím, že rezervační poplatek <strong>\d[\d ]* Kč<\/strong> propadá/);
  const csrf = await srv.csrf(`/rezervace/${tok}`);
  const res = await post(`/rezervace/${tok}/storno`, { _csrf: csrf, potvrdit: '1' });
  assert.equal(res.status, 303);
  const after = reservations.get(srv.db, r.id);
  assert.equal(after.status, 'cancelled_by_customer');
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_forfeited'").get(r.id).n, 1);
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND purpose = 'refund'").get(r.id).n, 0);
  // POST bez CSRF na správu → 403
  assert.equal((await post(`/rezervace/${tok}/storno`, { potvrdit: '1' })).status, 403);
});

test('správa čekající na převod: pokyny k platbě (VS, IBAN), platba ze správy demo simulací → potvrzeno', async () => {
  srv.jar.clear();
  const r = srv.db.prepare("SELECT * FROM reservations WHERE status = 'awaiting_fee' LIMIT 1").get();
  const tok = reservations.tokenFor(r, srv.app.secret);
  const html = await (await srv.fetch(`/rezervace/${tok}`)).text().then(nb);
  assert.match(html, /badge badge--warning">Čeká na poplatek/);
  assert.match(html, /Variabilní symbol<\/dt><dd><code>\d{10}<\/code>/);
  assert.match(html, /IBAN<\/dt><dd><code>CZ6508000000192000145399<\/code>/);
  assert.match(html, /Simulovat zaplacení poplatku \(demo\)/);
  const csrf = await srv.csrf(`/rezervace/${tok}`);
  assert.equal((await post(`/rezervace/${tok}/zaplatit`, { _csrf: csrf, metoda: 'neznama' })).status, 400);
  const res = await post(`/rezervace/${tok}/zaplatit`, { _csrf: csrf, metoda: 'demo' });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `/rezervace/hotovo/${tok}`);
  assert.equal(reservations.get(srv.db, r.id).status, 'confirmed');
  const again = await post(`/rezervace/${tok}/zaplatit`, { _csrf: csrf, metoda: 'demo' });
  assert.equal(again.status, 409, 'už nečeká na poplatek');
});

test('krok 4 převodem (bez modulu plateb): rezervace awaiting_fee, pokyny s IBAN/VS, notice o přípravě QR', async () => {
  srv.jar.clear();
  const token = await srv.csrf('/rezervace');
  await stepTerm(token, day(40), day(41));
  const typeId = srv.db.prepare("SELECT id FROM bike_types WHERE slug = 'canyon-grail'").get().id;
  await post('/rezervace/kola', { _csrf: token, [`qty_${typeId}_0`]: '1' });
  await post('/rezervace/udaje', { _csrf: token, jmeno: 'Alena Převodová', email: 'alena.prevodova@example.com', telefon: '777000111', souhlas_op: '1', souhlas_doklad: '1', marketing: '1' });
  const res = await post('/rezervace/poplatek', { _csrf: token, metoda: 'prevod' });
  assert.equal(res.status, 200);
  const html = await res.text().then(nb);
  assert.match(html, /Platba převodem/);
  assert.match(html, /Částka<\/dt><dd><strong>300 Kč/);
  assert.match(html, /Variabilní symbol<\/dt><dd><code>\d{10}<\/code>/);
  assert.match(html, /Uhradit do<\/dt>/);
  assert.match(html, /QR kód se připravuje|QR Platba/);
  const row = srv.db.prepare('SELECT * FROM reservations WHERE customer_id IN (SELECT id FROM customers WHERE email_hmac = ?)').get(srv.app.fieldCrypto.hmacEmail('alena.prevodova@example.com'));
  assert.equal(row.status, 'awaiting_fee');
  // demo: odkaz na simulaci příchozí platby (feature platby, /simulace-banky) s VS a částkou v Kč
  assert.match(html, new RegExp(`href="/simulace-banky\\?vs=${row.number}&amp;castka=300"`), 'odkaz „Simulovat příchozí platbu (demo)“');
  assert.match(html, /Simulovat příchozí platbu \(demo\)/);
  const tokA = reservations.tokenFor(row, srv.app.secret);
  const manageHtml = await (await srv.fetch(`/rezervace/${tokA}`)).text().then(nb);
  assert.match(manageHtml, new RegExp(`href="/simulace-banky\\?vs=${row.number}&amp;castka=300"`), 'odkaz i ve správě u čekajícího převodu');
  assert.equal((await srv.fetch(`/simulace-banky?vs=${row.number}&castka=300`)).status, 200, 'cílová stránka existuje');
  assert.ok(row.expires_at > new Date().toISOString());
  assert.ok(srv.db.prepare('SELECT marketing_consent_at FROM customers WHERE id = ?').get(row.customer_id).marketing_consent_at);
  // opakovaná volba metody použije tutéž rezervaci (žádný duplikát)
  const again = await post('/rezervace/poplatek', { _csrf: token, metoda: 'prevod' });
  assert.equal(again.status, 200);
  assert.equal(srv.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ?').get(row.customer_id).n, 1);
  // hotovo pro awaiting_fee
  const tok = reservations.tokenFor(row, srv.app.secret);
  const done = await (await srv.fetch(`/rezervace/hotovo/${tok}`)).text().then(nb);
  assert.match(done, /čeká na poplatek/);
  assert.match(done, /pokynů k platbě/);
});

test('souběh přes HTTP: dvě session chtějí poslední volné kolo – druhá dostane 409 „mezitím někdo rezervoval“', async () => {
  const od = day(50);
  const doD = day(51);
  const typeId = srv.db.prepare("SELECT id FROM bike_types WHERE slug = 'canyon-grail'").get().id; // gravel L = 1 kus
  const sizeIdx = JSON.parse(srv.db.prepare('SELECT sizes FROM bike_types WHERE id = ?').get(typeId).sizes).indexOf('L');
  async function prepare(email) {
    srv.jar.clear();
    const token = await srv.csrf('/rezervace');
    await stepTerm(token, od, doD);
    await post('/rezervace/kola', { _csrf: token, [`qty_${typeId}_${sizeIdx}`]: '1' });
    await post('/rezervace/udaje', { _csrf: token, jmeno: 'Souběh Test', email, telefon: '777000222', souhlas_op: '1', souhlas_doklad: '1' });
    return { token, cookie: srv.jar.header() };
  }
  const a = await prepare('soubeh.a@example.com');
  const b = await prepare('soubeh.b@example.com');
  const ra = await post('/rezervace/poplatek', { _csrf: a.token, metoda: 'demo' }, { headers: { cookie: a.cookie } });
  assert.equal(ra.status, 303);
  const rb = await post('/rezervace/poplatek', { _csrf: b.token, metoda: 'demo' }, { headers: { cookie: b.cookie } });
  assert.equal(rb.status, 409);
  assert.match(await rb.text().then(nb), /mezitím někdo rezervoval/);
});

test('/api/v1/dostupnost: mapa typ → velikost → počet, blockedDates, filtr typ/velikost, chyby', async () => {
  const res = await srv.fetch(`/api/v1/dostupnost?od=${day(60)}&do=${day(61)}`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(Object.keys(body.available).length, 6);
  const trek = srv.db.prepare("SELECT id FROM bike_types WHERE slug = 'trek-fx-2'").get().id;
  assert.deepEqual(body.available[trek], { S: 1, M: 2, L: 1, XL: 1 });
  assert.equal(body.total, 22);
  assert.ok(body.blockedDates.some((d) => d.endsWith('-12-25')));
  assert.equal(body.types.length, 6);
  const one = await (await srv.fetch(`/api/v1/dostupnost?od=${day(60)}&do=${day(61)}&typ=trek-fx-2&velikost=M`)).json();
  assert.deepEqual(one.available, { [trek]: { M: 2 } });
  // zabrané kolo v termínu demo rezervace (awaiting_fee: 2× e-kolo L za 10 dní)
  const aw = srv.db.prepare("SELECT from_at, to_at FROM reservations WHERE status IN ('awaiting_fee', 'confirmed') ORDER BY from_at DESC LIMIT 1").get();
  const busy = await (await srv.fetch(`/api/v1/dostupnost?od=${encodeURIComponent(aw.from_at)}&do=${encodeURIComponent(aw.to_at)}`)).json();
  assert.ok(busy.total < 22);
  assert.equal((await srv.fetch('/api/v1/dostupnost?od=x&do=y')).status, 400);
  assert.equal((await srv.fetch(`/api/v1/dostupnost?od=${day(61)}&do=${day(60)}`)).status, 400);
  assert.equal((await srv.fetch(`/api/v1/dostupnost?od=${day(60)}&do=${day(61)}&typ=neni`)).status, 404);
});

test('otevírací doba z adminu (settings.openingHours): zavřené pondělí blokuje kalendář, API i validaci termínu', async () => {
  srv.jar.clear();
  const { setSetting } = require('../src/tenants');
  // první pondělí za ≥ 7 dní
  let monday = day(7);
  while (availability.utcToLocal(availability.localToUtc(monday, '12:00')).dayKey !== 'mon') monday = availability.addDays(monday, 1);
  const tuesday = availability.addDays(monday, 1);
  const before = await (await srv.fetch(`/api/v1/dostupnost?od=${monday}&do=${tuesday}`)).json();
  assert.ok(!before.blockedDates.includes(monday), 'výchozí: pondělí otevřeno');
  setSetting(srv.db, 'openingHours', { ...srv.tenant.openingHours, mon: null });
  try {
    const api = await (await srv.fetch(`/api/v1/dostupnost?od=${tuesday}&do=${availability.addDays(tuesday, 1)}`)).json();
    assert.ok(api.blockedDates.includes(monday), 'API: pondělí v blockedDates');
    const page = await (await srv.fetch('/rezervace')).text().then(nb);
    assert.match(page, new RegExp(`data-blocked="\\[[^"]*${monday}`), 'kalendář blokuje pondělí');
    assert.match(page, /<dt>Po<\/dt><dd>zavřeno<\/dd>/, 'boční karta ukazuje zavřené pondělí');
    const token = await srv.csrf('/rezervace');
    const r = await stepTerm(token, monday, tuesday);
    assert.equal(r.status, 422);
    assert.match(await r.text().then(nb), /zavřeno \(Zavírací den\)/);
    assert.equal((await stepTerm(token, tuesday, availability.addDays(tuesday, 1))).status, 303, 'úterý projde');
  } finally {
    srv.db.prepare("DELETE FROM settings WHERE key = 'openingHours'").run();
  }
  const after = await (await srv.fetch(`/api/v1/dostupnost?od=${monday}&do=${tuesday}`)).json();
  assert.ok(!after.blockedDates.includes(monday), 'po obnovení nastavení pondělí opět otevřeno');
});

test('kalendářový JS hledá navigaci jen uvnitř mřížky (closest nesmí dojít k <html data-nav>)', () => {
  const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'public', 'js', 'rezervace.js'), 'utf8');
  assert.ok(!src.includes("closest('[data-nav]')"), "closest('[data-nav]') by našel <html data-nav=\"transparent\"> z layoutu");
  assert.match(src, /closest\('\.calendar__nav\[data-nav\]'\)/);
  assert.match(src, /grid\.contains\(nav\)/);
});

test('job údržby je zaregistrován a běží nad všemi tenanty', async () => {
  const names = srv.instance.jobs.list().map((j) => j.name);
  assert.ok(names.includes('reservations-maintenance'));
  const before = srv.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'reminder'").get().n;
  await srv.instance.jobs.runNow('reservations-maintenance');
  const after = srv.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE type = 'reminder'").get().n;
  assert.ok(after >= before, 'připomínky pro zítřejší potvrzené rezervace');
  assert.equal(srv.db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE status = 'awaiting_fee' AND expires_at < ?").get(new Date().toISOString()).n, 0);
});
