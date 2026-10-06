'use strict';
// Integrační testy feature „admin“ (SPEC kap. 13) přes běžící server s demo daty: přihlášení (demo box, zámek po 10
// pokusech, rate limit login, uzamčený účet), CSRF a Origin, role (staff nevidí Nastavení), každá stránka 200 po
// přihlášení a 303 na login bez něj, průchod doklad → kola → kauce → výdej → vrácení → uzavření přes HTTP (stavy, ledger,
// předání, doklady), storno půjčovnou, simulace příchozího převodu (fio-mock), poi_overrides, nastavení, audit,
// anonymizace zákazníka, retence dokladu, QR štítky, TOTP (zapnutí + přihlášení s kódem). Log nesmí obsahovat PII.
const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('./helpers');
const { createLogger } = require('../src/log');
const demo = require('../tools/demo-data');
const totp = require('../src/crypto/totp');
const admin = require('../src/features/admin');

const nb = (s) => s.replace(/ /g, ' ');
const silent = { info() {}, warn() {}, error() {}, debug() {} };
const DEMO_EMAIL = 'demo@ksprehledy.cz';
const DEMO_PASSWORD = 'kolo-demo-2026';
const ID_DOC_NUMBER = 'AB987654321';

let srv;
let db;
const logLines = [];

test.before(async () => {
  const log = createLogger({ level: 'debug', stdout: { write: (l) => logLines.push(l) }, stderr: { write: (l) => logLines.push(l) } });
  srv = await startServer({ log });
  db = srv.db;
  await demo.seed({ db, tenant: srv.tenant, config: srv.instance.config, fieldCrypto: srv.app.fieldCrypto, log: silent });
});
test.after(async () => {
  if (srv) await srv.stop();
});

function post(path, body, init = {}) {
  return srv.fetch(path, { method: 'POST', body, ...init });
}

async function login(email = DEMO_EMAIL, password = DEMO_PASSWORD) {
  srv.jar.clear();
  const token = await srv.csrf('/admin/login');
  return post('/admin/login', { _csrf: token, email, heslo: password, zpet: '/admin' });
}

/** CSRF token přihlášené admin session (hidden input v odhlašovacím formuláři). */
function adminCsrf() {
  return srv.csrf('/admin/ucet');
}

function resetLoginLimit() {
  for (const ip of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) srv.app.rateLimiter.reset(ip, 'login');
}

function byNumberSuffix(predicate) {
  return db.prepare('SELECT * FROM reservations ORDER BY id').all().find(predicate);
}

const PAGES = ['/admin', '/admin/rezervace', '/admin/kalendar', '/admin/kola', '/admin/kola/typ/novy', '/admin/kola/kus/novy', '/admin/kola/stitky', '/admin/cenik', '/admin/platby', '/admin/emaily', '/admin/zakaznici', '/admin/obsah', '/admin/nastaveni', '/admin/ucet', '/admin/ucet/2fa', '/admin/audit'];

test('bez přihlášení: GET stránek → 303 na /admin/login?zpet=…, POST bez CSRF → 403, login stránka v demu zobrazuje Demo přístup', async () => {
  srv.jar.clear();
  for (const p of PAGES) {
    const r = await srv.fetch(p);
    assert.equal(r.status, 303, p);
    assert.equal(r.headers.get('location'), `/admin/login?zpet=${encodeURIComponent(p)}`, p);
  }
  assert.equal((await srv.fetch('/admin/rezervace/1')).status, 303);
  const login_ = await srv.fetch('/admin/login');
  assert.equal(login_.status, 200);
  const html = nb(await login_.text());
  assert.match(html, /Demo přístup/);
  assert.match(html, /demo@ksprehledy\.cz/);
  assert.match(html, /kolo-demo-2026/);
  assert.match(html, /name="_csrf"/);
  assert.match(html, /<body class="admin admin--login">/);
  assert.ok(!/ style="/.test(html), 'bez inline stylů');
  const cookie = login_.headers.getSetCookie().find((c) => c.startsWith('__Host-pk_adm='));
  assert.ok(cookie, 'login stránka založí admin session pro CSRF');
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /HttpOnly/);
  // POST bez tokenu
  assert.equal((await post('/admin/login', { email: DEMO_EMAIL, heslo: DEMO_PASSWORD })).status, 403);
  // POST s cizím Origin
  const token = await srv.csrf('/admin/login');
  assert.equal((await post('/admin/login', { _csrf: token, email: DEMO_EMAIL, heslo: DEMO_PASSWORD }, { headers: { origin: 'https://utocnik.example' } })).status, 403);
  // akce bez přihlášení (bez admin session) → 403
  srv.jar.clear();
  assert.equal((await post('/admin/rezervace/1/storno', { duvod: 'x' })).status, 403);
});

test('přihlášení: špatné heslo, zámek účtu po 10 pokusech, rate limit login, odemknutí a úspěšné přihlášení', async () => {
  srv.jar.clear();
  resetLoginLimit();
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?').run(DEMO_EMAIL);
  const token = await srv.csrf('/admin/login');
  // neznámý uživatel → stejná hláška
  let r = await post('/admin/login', { _csrf: token, email: 'nikdo@example.com', heslo: 'x' });
  assert.equal(r.status, 401);
  assert.match(nb(await r.text()), /Nesprávný e-mail nebo heslo/);
  resetLoginLimit();
  for (let i = 1; i <= 10; i++) {
    r = await post('/admin/login', { _csrf: token, email: DEMO_EMAIL, heslo: 'spatne-heslo' });
    if (i < 10) assert.equal(r.status, 401, `pokus ${i}`);
    else {
      assert.equal(r.status, 403, 'desátý pokus uzamkne');
      assert.match(nb(await r.text()), /uzamčen/);
    }
  }
  const u = db.prepare('SELECT failed_logins, locked_until FROM users WHERE email = ?').get(DEMO_EMAIL);
  assert.equal(u.failed_logins, 10);
  assert.ok(u.locked_until && Date.parse(u.locked_until) > Date.now(), 'locked_until v budoucnu');
  assert.ok(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'auth.lockout'").get().n >= 1);
  // 11. požadavek → rate limit 429
  r = await post('/admin/login', { _csrf: token, email: DEMO_EMAIL, heslo: DEMO_PASSWORD });
  assert.equal(r.status, 429);
  assert.ok(r.headers.get('retry-after'));
  // po uvolnění limitu: správné heslo, ale účet je uzamčený
  resetLoginLimit();
  r = await post('/admin/login', { _csrf: token, email: DEMO_EMAIL, heslo: DEMO_PASSWORD });
  assert.equal(r.status, 403);
  assert.match(nb(await r.text()), /dočasně uzamčen/);
  // odemknout a přihlásit
  db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE email = ?').run(DEMO_EMAIL);
  r = await post('/admin/login', { _csrf: token, email: DEMO_EMAIL, heslo: DEMO_PASSWORD });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/admin');
  const cookie = r.headers.getSetCookie().find((c) => c.startsWith('__Host-pk_adm='));
  assert.ok(cookie, 'po přihlášení nová session (regenerate)');
  assert.match(cookie, /SameSite=Strict/);
  const me = db.prepare('SELECT failed_logins, locked_until, last_login_at FROM users WHERE email = ?').get(DEMO_EMAIL);
  assert.equal(me.failed_logins, 0);
  assert.equal(me.locked_until, null);
  assert.ok(me.last_login_at);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.login' AND user_id = (SELECT id FROM users WHERE email = ?)").get(DEMO_EMAIL));
});

test('po přihlášení: každá stránka 200 v admin shellu, bez inline stylů a nerozvinutých {{…}}; JS a CSS adminu se servírují', async () => {
  for (const p of PAGES) {
    const r = await srv.fetch(p);
    assert.equal(r.status, 200, p);
    const html = nb(await r.text());
    assert.match(html, /<body class="admin">/, p);
    assert.match(html, /class="admin__nav"/, p);
    assert.ok(!/\{\{[A-Z_]+\}\}/.test(html), `${p}: nerozvinutý placeholder`);
    assert.ok(!/ style="/.test(html), `${p}: inline styl`);
    assert.match(html, /\/css\/admin\.css\?v=/, p);
    assert.match(html, /<script src="\/admin\/admin\.js\?v=test" defer>/, p);
  }
  for (const f of ['/admin/dom.js', '/admin/toast.js', '/admin/modal.js', '/admin/table.js', '/admin/admin.js', '/css/admin.css']) {
    const r = await srv.fetch(f);
    assert.equal(r.status, 200, f);
  }
  const detail = await srv.fetch('/admin/rezervace/1');
  assert.equal(detail.status, 200);
  assert.equal((await srv.fetch('/admin/rezervace/999999')).status, 404);
});

test('role: owner založí uživatele staff; staff nevidí Nastavení (403), ostatní stránky 200; owner se přihlásí zpět', async () => {
  const token = await adminCsrf();
  let r = await post('/admin/nastaveni/uzivatele', { _csrf: token, email: 'obsluha@example.com', name: 'Obsluha Testovací', role: 'staff', password: 'obsluha-heslo-123' });
  assert.equal(r.status, 303);
  const staff = db.prepare("SELECT * FROM users WHERE email = 'obsluha@example.com'").get();
  assert.ok(staff && staff.role === 'staff');
  assert.match(staff.password_hash, /^scrypt\$/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.create' AND entity_id = ?").get(String(staff.id)));
  r = await login('obsluha@example.com', 'obsluha-heslo-123');
  assert.equal(r.status, 303);
  r = await srv.fetch('/admin/nastaveni');
  assert.equal(r.status, 403);
  assert.match(nb(await r.text()), /jen majiteli/);
  assert.equal((await post('/admin/nastaveni', { _csrf: await adminCsrf(), sekce: 'retence' })).status, 403);
  for (const p of ['/admin', '/admin/rezervace', '/admin/kola', '/admin/platby', '/admin/ucet']) assert.equal((await srv.fetch(p)).status, 200, p);
  const html = nb(await (await srv.fetch('/admin')).text());
  assert.ok(!/href="\/admin\/nastaveni"/.test(html), 'staff nemá odkaz Nastavení v navigaci');
  // odhlášení
  r = await post('/admin/logout', { _csrf: await adminCsrf() });
  assert.equal(r.status, 303);
  assert.equal((await srv.fetch('/admin')).status, 303);
  r = await login();
  assert.equal(r.status, 303);
});

test('detail rezervace: dešifrovaná pole zákazníka jen zde + audit customer.view; seznam zákazníka nezobrazuje', async () => {
  const r6 = byNumberSuffix((r) => r.status === 'confirmed' && r.id === 6) || byNumberSuffix((r) => r.status === 'confirmed');
  const before = db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'customer.view' AND entity_id = ?").get(String(r6.customer_id)).n;
  const res = await srv.fetch(`/admin/rezervace/${r6.id}`);
  assert.equal(res.status, 200);
  const html = nb(await res.text());
  assert.match(html, /Martin Kučera/);
  assert.match(html, /martin\.kucera@example\.com/);
  assert.match(html, /Zapsat doklad totožnosti/);
  assert.match(html, /Přiřadit kola/);
  assert.match(html, /Vydat kola/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'customer.view' AND entity_id = ?").get(String(r6.customer_id)).n, before + 1);
  const list = nb(await (await srv.fetch('/admin/rezervace')).text());
  assert.ok(!/Martin Kučera/.test(list), 'seznam bez jmen');
});

test('průchod přes HTTP: výdej bez dokladu odmítnut → doklad → kola → kauce → výdej → vrácení → uzavření (stavy, ledger, předání, doklady, audit)', async () => {
  const r6 = db.prepare('SELECT * FROM reservations WHERE id = 6').get();
  assert.equal(r6.status, 'confirmed');
  const token = await adminCsrf();
  const base = `/admin/rezervace/${r6.id}`;
  const detailHtml = async () => nb(await (await srv.fetch(base)).text());

  // 1) výdej bez dokladu → odmítnuto (flash), stav zůstává
  let r = await post(`${base}/vydat`, { _csrf: token, potvrzeni: '1' });
  assert.equal(r.status, 303);
  let html = await detailHtml();
  assert.match(html, /zapsat typ a číslo dokladu totožnosti/);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r6.id).status, 'confirmed');

  // 2) doklad
  r = await post(`${base}/doklad`, { _csrf: token, typ: 'op', cislo: ID_DOC_NUMBER, souhlas: '1' });
  assert.equal(r.status, 303);
  const cust = db.prepare('SELECT * FROM customers WHERE id = ?').get(r6.customer_id);
  assert.equal(cust.id_doc_type, 'občanský průkaz');
  assert.ok(cust.id_doc_number_enc && !cust.id_doc_number_enc.includes(ID_DOC_NUMBER), 'číslo dokladu šifrované');
  assert.equal(srv.app.fieldCrypto.dec(cust.id_doc_number_enc), ID_DOC_NUMBER);
  assert.ok(cust.id_doc_consent_at);
  assert.ok(Date.parse(cust.id_doc_delete_after) > Date.parse(r6.to_at) + 29 * 86400000, 'výmaz po vrácení + retence');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'customer.id_doc_recorded' AND entity_id = ?").get(String(cust.id)));
  html = await detailHtml();
  assert.match(html, /•••••321/, 'maskované číslo dokladu');
  assert.ok(!html.includes(ID_DOC_NUMBER), 'plné číslo se nezobrazuje');

  // 3) přiřazení kola (volný kus EMT, velikost L)
  const row = db.prepare('SELECT * FROM reservation_items WHERE reservation_id = ?').get(r6.id);
  const bike = db.prepare("SELECT * FROM bikes WHERE bike_type_id = ? AND size = ? AND status = 'available' ORDER BY inventory_code").get(row.bike_type_id, row.size);
  const busyBike = db.prepare("SELECT i.bike_id FROM reservation_items i JOIN reservations x ON x.id = i.reservation_id WHERE x.status = 'checked_out' AND i.bike_id IS NOT NULL LIMIT 1").get();
  // kolize: kus vydaný v jiné rezervaci (jiný typ) musí být odmítnut
  r = await post(`${base}/kola`, { _csrf: token, [`item_${row.id}`]: String(busyBike.bike_id) });
  assert.equal(r.status, 303);
  assert.equal(db.prepare('SELECT bike_id FROM reservation_items WHERE id = ?').get(row.id).bike_id, null, 'kolidující kus nepřiřazen');
  r = await post(`${base}/kola`, { _csrf: token, [`item_${row.id}`]: String(bike.id) });
  assert.equal(r.status, 303);
  assert.equal(db.prepare('SELECT bike_id FROM reservation_items WHERE id = ?').get(row.id).bike_id, bike.id);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'reservation.assign_bikes' AND entity_id = ?").get(String(r6.id)));

  // 4) kauce hotově 10 000 Kč
  r = await post(`${base}/kauce`, { _csrf: token, metoda: 'cash', castka: '10000' });
  assert.equal(r.status, 303);
  const hold = db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'deposit_hold' ORDER BY id DESC").get(r6.id);
  assert.ok(hold);
  assert.equal(hold.status, 'authorized');
  assert.equal(hold.amount_minor, 1000000);
  assert.equal(hold.method, 'cash');

  // 5) výdej s doplatkem terminálem
  const due = r6.total_minor - r6.paid_minor;
  r = await post(`${base}/vydat`, { _csrf: token, potvrzeni: '1', doplatek_metoda: 'terminal', doplatek_castka: String(due / 100), poznamka: 'Baterie 100 %, zámek předán' });
  assert.equal(r.status, 303);
  let fresh = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r6.id);
  assert.equal(fresh.status, 'checked_out');
  assert.equal(fresh.deposit_minor, 1000000);
  assert.equal(fresh.deposit_method, 'cash');
  assert.equal(fresh.paid_minor, r6.total_minor, 'doplatek se započítal');
  assert.equal(fresh.version, r6.version + 1);
  const ledger = () => db.prepare('SELECT type, amount_minor FROM ledger_entries WHERE reservation_id = ? ORDER BY id').all(r6.id);
  assert.ok(ledger().some((l) => l.type === 'deposit_held' && l.amount_minor === 1000000));
  assert.ok(ledger().some((l) => l.type === 'balance_paid' && l.amount_minor === due));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM handovers WHERE reservation_id = ? AND type = 'pickup'").get(r6.id).n, 1);
  const contract = db.prepare("SELECT * FROM documents WHERE reservation_id = ? AND type = 'contract'").get(r6.id);
  assert.ok(contract, 'smlouva vystavena');
  assert.match(contract.number, /^SML-\d{4}-\d{6}$/);
  assert.match(contract.html, /Martin Kučera/);
  assert.match(contract.html, new RegExp(bike.inventory_code));
  assert.ok(!contract.html.includes(ID_DOC_NUMBER), 'smlouva s maskovaným číslem dokladu');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'reservation.check_out' AND entity_id = ? AND user_id IS NOT NULL").get(String(r6.id)));
  html = await detailHtml();
  assert.match(html, /Vrátit kola/);
  assert.match(html, new RegExp(contract.number));
  // tisk dokladu
  const print = await srv.fetch(`/admin/doklady/${contract.number}`);
  assert.equal(print.status, 200);
  assert.match(await print.text(), /<!doctype html>/i);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'document.view'").get());

  // 6) vrácení s poškozením 200 Kč
  r = await post(`${base}/vratit`, { _csrf: token, stav: 'poskozeno', poskozeni: '200', poznamka: 'Škrábanec na rámu' });
  assert.equal(r.status, 303);
  fresh = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r6.id);
  assert.equal(fresh.status, 'returned');
  assert.ok(ledger().some((l) => l.type === 'damage' && l.amount_minor === 20000));
  assert.equal(db.prepare("SELECT damage_minor FROM handovers WHERE reservation_id = ? AND type = 'return'").get(r6.id).damage_minor, 20000);
  assert.ok(db.prepare("SELECT 1 FROM documents WHERE reservation_id = ? AND type = 'return_protocol'").get(r6.id), 'protokol o vrácení');
  html = await detailHtml();
  assert.match(html, /Uzavřít rezervaci/);
  // karta Uzavřít (nález QA „dvojí inkaso škody“): stržení předvyplněno škodou, doplatek výchozí „Neuhrazen“ a jeho
  // částka už snížená o stržení (200 − 200 = 0), formulář nese data pro JS přepočet
  const closeForm = html.match(/<form[^>]*data-settlement[^>]*>[\s\S]*?<\/form>/);
  assert.ok(closeForm, 'formulář Uzavřít s data-settlement');
  assert.match(closeForm[0], /data-due="20000"/);
  assert.match(closeForm[0], /data-max-capture="1000000"/);
  assert.match(closeForm[0], /name="strhnout_castka"[^>]*value="200"/);
  assert.match(closeForm[0], /<select[^>]*name="doplatek_metoda"[^>]*>\s*<option value="" selected>/);
  assert.match(closeForm[0], /name="doplatek_castka"[^>]*value="0"/);
  assert.match(closeForm[0], /Po stržení z kauce zbývá <span data-settlement-remaining>0 Kč<\/span>/);
  assert.match(html, /obojí dohromady nesmí dlužnou částku přesáhnout/);

  // 7a) nekonzistentní kombinace (škoda stržena z kauce i zaplacena terminálem) → 422 s vysvětlením, nic se nezapsalo
  const balancePaymentsBefore = db.prepare("SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND purpose = 'balance'").get(r6.id).n;
  r = await post(`${base}/uzavrit`, { _csrf: token, kauce_akce: 'strhnout', strhnout_castka: '200', doplatek_metoda: 'terminal', doplatek_castka: '200' });
  assert.equal(r.status, 422);
  html = nb(await r.text());
  assert.match(html, /Vypořádání by vedlo k přeplatku: zbývá uhradit 200 Kč, ale stržení z kauce 200 Kč a doplatek 200 Kč \(Terminál\) dávají dohromady 400 Kč/);
  assert.match(html, /Škodu zapište jen jednou/);
  assert.match(html, /Uzavřít rezervaci/, 'odpověď 422 obsahuje detail s formulářem');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r6.id).status, 'returned');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM payments WHERE reservation_id = ? AND purpose = 'balance'").get(r6.id).n, balancePaymentsBefore, 'doplatek se při 422 nezapsal');
  assert.ok(!ledger().some((l) => l.type === 'deposit_captured'), 'kauce se při 422 nestrhla');
  assert.equal(db.prepare('SELECT status FROM payments WHERE id = ?').get(hold.id).status, 'authorized');
  // samotné stržení nad dlužnou částku → také 422
  r = await post(`${base}/uzavrit`, { _csrf: token, kauce_akce: 'strhnout', strhnout_castka: '300' });
  assert.equal(r.status, 422);
  assert.match(nb(await r.text()), /Strhnout lze nejvýše 200 Kč/);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r6.id).status, 'returned');

  // 7) uzavření – strhnout 200 Kč z kauce (doplatek „Neuhrazen“ – výchozí stav formuláře)
  r = await post(`${base}/uzavrit`, { _csrf: token, kauce_akce: 'strhnout', strhnout_castka: '200', doplatek_metoda: '', doplatek_castka: '0' });
  assert.equal(r.status, 303);
  fresh = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r6.id);
  assert.equal(fresh.status, 'closed');
  assert.ok(ledger().some((l) => l.type === 'deposit_captured' && l.amount_minor === 20000));
  assert.ok(ledger().some((l) => l.type === 'deposit_released' && l.amount_minor === 980000));
  const balancePaid = ledger().filter((l) => l.type === 'balance_paid');
  assert.equal(balancePaid.length, 1, 'jediný doplatek (z výdeje) – škoda stržená z kauce nevytvoří balance_paid navíc');
  assert.equal(balancePaid[0].amount_minor, due);
  assert.equal(fresh.paid_minor, r6.total_minor, 'paid_minor bez škody inkasované dvakrát');
  const holdAfter = db.prepare('SELECT * FROM payments WHERE id = ?').get(hold.id);
  assert.equal(holdAfter.status, 'partially_captured');
  assert.equal(holdAfter.captured_minor, 20000);
  if (admin.modules().documents) {
    const finalDoc = db.prepare("SELECT * FROM documents WHERE reservation_id = ? AND type = 'final_doc'").get(r6.id);
    assert.ok(finalDoc, 'konečný doklad');
    assert.ok(!/Přeplatek k vrácení/.test(finalDoc.html), 'konečný doklad bez přeplatku');
    assert.match(finalDoc.html, /Uhrazeno v plné výši/);
  }
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'reservation.close' AND entity_id = ?").get(String(r6.id)));
  html = await detailHtml();
  assert.match(html, /Uzavřená/);
  assert.ok(!/Uzavřít rezervaci/.test(html), 'žádné další akce');
  // opakované uzavření je odmítnuto doménou (no-op / chyba), stav zůstává
  r = await post(`${base}/uzavrit`, { _csrf: token, kauce_akce: 'uvolnit' });
  assert.equal(r.status, 303);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r6.id).status, 'closed');
});

test('storno půjčovnou: cancel_by_operator s důvodem → plná vratka, e-mail, audit; stav se mění jen přechodem', async () => {
  const r8 = db.prepare("SELECT * FROM reservations WHERE id = 8 AND status = 'confirmed'").get();
  assert.ok(r8);
  const token = await adminCsrf();
  let r = await post(`/admin/rezervace/${r8.id}/storno`, { _csrf: token, duvod: 'x' });
  assert.equal(r.status, 303);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r8.id).status, 'confirmed', 'krátký důvod odmítnut');
  r = await post(`/admin/rezervace/${r8.id}/storno`, { _csrf: token, duvod: 'Porucha kola, náhradní není k dispozici' });
  assert.equal(r.status, 303);
  const fresh = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r8.id);
  assert.equal(fresh.status, 'cancelled_by_operator');
  assert.match(fresh.note, /Porucha kola/);
  assert.ok(db.prepare("SELECT 1 FROM payments WHERE reservation_id = ? AND purpose = 'refund'").get(r8.id), 'vratka založena');
  assert.ok(db.prepare("SELECT 1 FROM ledger_entries WHERE reservation_id = ? AND type = 'refund' AND amount_minor = ?").get(r8.id, r8.paid_minor));
  assert.ok(db.prepare("SELECT 1 FROM outbox WHERE type = 'reservation_cancelled' AND json_extract(payload, '$.reservationId') = ?").get(r8.id));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'reservation.cancel_by_operator' AND entity_id = ?").get(String(r8.id)));
  const html = nb(await (await srv.fetch(`/admin/rezervace/${r8.id}`)).text());
  assert.match(html, /Zrušená půjčovnou/);
});

test('potvrzení poplatku hotově u rezervace čekající na poplatek (fee_paid přes transition)', async () => {
  // vlastní rezervace, aby zůstala demo rezervace čekající na převod pro test simulace banky
  const reservations = require('../src/domain/reservations');
  const availability = require('../src/domain/availability');
  const today = availability.utcToLocal(new Date()).date;
  const typeId = db.prepare("SELECT id FROM bike_types WHERE slug = 'woom-4'").get().id;
  const created = reservations.create({
    db,
    tenant: srv.tenant,
    settings: admin.getSettings(db, srv.tenant),
    fieldCrypto: srv.app.fieldCrypto,
    secret: srv.app.secret,
    draft: { fromAt: availability.localToUtc(availability.addDays(today, 40), '10:00'), toAt: availability.localToUtc(availability.addDays(today, 41), '16:00'), items: [{ typeId, size: '24"', qty: 1 }], customer: { name: 'Test Admin', email: 'test.admin@example.com', phone: '+420 777 000 099' }, consents: { termsVersion: '1.0' } },
  });
  const r12 = created.reservation;
  assert.equal(r12.status, 'awaiting_fee');
  const token = await adminCsrf();
  const r = await post(`/admin/rezervace/${r12.id}/potvrdit-platbu`, { _csrf: token, metoda: 'cash', castka: String(r12.fee_minor / 100) });
  assert.equal(r.status, 303);
  const fresh = db.prepare('SELECT * FROM reservations WHERE id = ?').get(r12.id);
  assert.equal(fresh.status, 'confirmed');
  assert.equal(fresh.paid_minor, r12.fee_minor);
  assert.ok(db.prepare("SELECT 1 FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_paid'").get(r12.id));
  assert.ok(db.prepare("SELECT 1 FROM payments WHERE reservation_id = ? AND purpose = 'fee' AND method = 'cash' AND status = 'paid'").get(r12.id));
});

test('simulace příchozího převodu (fio-mock): spáruje podle VS a potvrdí rezervaci; bez VS skončí mezi nespárovanými', { skip: !admin.modules().fio && 'modul plateb (fio-mock) zatím není k dispozici' }, async () => {
  const pending = db.prepare("SELECT r.* FROM reservations r JOIN payments p ON p.reservation_id = r.id WHERE r.status = 'awaiting_fee' AND p.method = 'bank_transfer' AND p.status = 'pending' ORDER BY r.id").get();
  assert.ok(pending, 'demo má rezervaci čekající na převod');
  const token = await adminCsrf();
  let r = await post('/admin/platby/simulace', { _csrf: token, castka: String(pending.fee_minor / 100), vs: pending.number, zprava: 'test' });
  assert.equal(r.status, 303);
  assert.equal(r.headers.get('location'), '/admin/platby');
  const fresh = db.prepare('SELECT * FROM reservations WHERE id = ?').get(pending.id);
  assert.equal(fresh.status, 'confirmed');
  assert.ok(db.prepare("SELECT 1 FROM bank_transactions WHERE vs = ? AND matched_payment_id IS NOT NULL").get(pending.number));
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'bank.simulate_incoming'").get());
  // bez VS → nespárované
  r = await post('/admin/platby/simulace', { _csrf: token, castka: '123', vs: '', zprava: 'bez symbolu' });
  assert.equal(r.status, 303);
  assert.ok(db.prepare("SELECT 1 FROM bank_transactions WHERE matched_payment_id IS NULL AND amount_minor = 12300").get());
  const html = nb(await (await srv.fetch('/admin/platby')).text());
  assert.match(html, /Nespárované příchozí pohyby \([1-9]/);
  assert.match(html, /Simulovat příchozí převod/);
});

test('obsah: poi_overrides – skrýt zajímavost se projeví na /okoli; texty webu do settings', async () => {
  const mapa = require('../src/features/mapa');
  const okoli = mapa.loadOkoli(srv.tenant);
  const token = await adminCsrf();
  if (okoli && okoli.pois.length) {
    const poi = okoli.pois[0];
    let r = await post(`/admin/obsah/poi/${encodeURIComponent(poi.id)}`, { _csrf: token, hidden: '1', sort: '3', custom_text: 'Vlastní popis z adminu' });
    assert.equal(r.status, 303);
    const row = db.prepare('SELECT * FROM poi_overrides WHERE poi_id = ?').get(String(poi.id));
    assert.equal(row.hidden, 1);
    assert.equal(row.sort, 3);
    assert.equal(row.custom_text, 'Vlastní popis z adminu');
    const pub = nb(await (await srv.fetch('/okoli')).text());
    assert.ok(!pub.includes(`>${poi.name}<`), 'skrytá zajímavost není na /okoli');
    const adm = nb(await (await srv.fetch('/admin/obsah')).text());
    assert.match(adm, /Vlastní popis z adminu/);
    r = await post(`/admin/obsah/poi/${encodeURIComponent(poi.id)}`, { _csrf: token, hidden: '0', sort: '', custom_text: 'Jen vlastní text' });
    assert.equal(db.prepare('SELECT hidden, sort FROM poi_overrides WHERE poi_id = ?').get(String(poi.id)).hidden, 0);
    const pub2 = nb(await (await srv.fetch('/okoli')).text());
    assert.match(pub2, /Jen vlastní text/);
    r = await post(`/admin/obsah/poi/${encodeURIComponent(poi.id)}`, { _csrf: token, reset: '1' });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM poi_overrides WHERE poi_id = ?').get(String(poi.id)).n, 0);
    assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'poi.override'").get());
  }
  const r = await post('/admin/obsah/texty', { _csrf: token, heroTitle: 'Nový titulek z adminu', heroText: '', about: 'O nás' });
  assert.equal(r.status, 303);
  const texts = admin.getSettings(db, srv.tenant).texts;
  assert.deepEqual(texts, { heroTitle: 'Nový titulek z adminu', about: 'O nás' });
});

test('nastavení (owner): změna storno lhůty, bufferu a retence → settings + audit; validace odmítne nesmysl', async () => {
  const token = await adminCsrf();
  const body = { _csrf: token, sekce: 'rezervace', fee_default: '350', fee_ebike: '550', free_hours: '24', buffer: '30', transfer_hours: '48', preauth_days: '7', max_days: '30', tolerance: '5', vat_rate: '21', gateway: 'mock', bank_matcher: 'fio-mock', accepted_docs: 'občanský průkaz nebo cestovní pas' };
  let r = await post('/admin/nastaveni', body);
  assert.equal(r.status, 303);
  let st = admin.getSettings(db, srv.tenant);
  assert.equal(st.cancellation.freeHoursBefore, 24);
  assert.equal(st.bufferMinutes, 30);
  assert.deepEqual(st.feeMinor, { default: 35000, ebike: 55000 });
  assert.equal(st.allowPayOnSite, false);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'settings.update' AND user_id IS NOT NULL").get());
  // veřejný ceník odráží novou lhůtu
  const cenik = nb(await (await srv.fetch('/cenik')).text());
  assert.match(cenik, /24 hodin/);
  // retence
  r = await post('/admin/nastaveni', { _csrf: token, sekce: 'retence', id_doc_days: '45', reservation_days: '90', contract_years: '3', log_days: '365' });
  assert.equal(r.status, 303);
  assert.equal(admin.getSettings(db, srv.tenant).idDocRetentionDays, 45);
  // nesmysl → neuloží se
  r = await post('/admin/nastaveni', { _csrf: token, sekce: 'retence', id_doc_days: '-1', reservation_days: 'x', contract_years: '3', log_days: '365' });
  assert.equal(r.status, 303);
  assert.equal(admin.getSettings(db, srv.tenant).idDocRetentionDays, 45);
  // otevírací doba
  r = await post('/admin/nastaveni', { _csrf: token, sekce: 'oteviraci', oh_mon_from: '08:00', oh_mon_to: '17:00', oh_tue_from: '', oh_tue_to: '' });
  assert.equal(r.status, 303);
  st = admin.getSettings(db, srv.tenant);
  assert.deepEqual(st.openingHours.mon, ['08:00', '17:00']);
  assert.equal(st.openingHours.tue, null);
  // zavírací dny
  r = await post('/admin/nastaveni/zavreno', { _csrf: token, date_from: '2030-01-01', date_to: '2030-01-02', reason: 'Inventura' });
  assert.equal(r.status, 303);
  const cl = db.prepare("SELECT * FROM closures WHERE reason = 'Inventura'").get();
  assert.ok(cl);
  r = await post(`/admin/nastaveni/zavreno/${cl.id}/smazat`, { _csrf: token });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM closures WHERE reason = 'Inventura'").get().n, 0);
  // vrátit lhůtu na 48 h pro ostatní testy
  await post('/admin/nastaveni', { ...body, free_hours: '48', buffer: '60', fee_default: '300', fee_ebike: '500' });
  assert.equal(admin.getSettings(db, srv.tenant).cancellation.freeHoursBefore, 48);
});

test('nastavení (owner): varianty právních textů – stránka nabízí klíče legalParams, uložení se projeví v Zásadách', async () => {
  const token = await adminCsrf();
  const page = await (await srv.fetch('/admin/nastaveni')).text();
  for (const name of ['accounting_mode', 'signature_mode', 'id_doc_print', 'analytics_tool', 'insurance', 'gps_trackers', 'transfer_outside_eu', 'charging_flat', 'second_id_doc']) {
    assert.ok(page.includes(`name="${name}"`), `pole ${name} je na stránce Nastavení`);
  }
  // výchozí stav: bez analytiky → Zásady bez cookie lišty
  let zas = nb(await (await srv.fetch('/soukromi')).text());
  assert.match(zas, /není cookie lišta/);
  let r = await post('/admin/nastaveni', { _csrf: token, sekce: 'pravni', accounting_mode: 'danova-evidence', signature_mode: 'papir', id_doc_print: 'plne', second_id_doc: '1', gps_trackers: '1', insurance: 'Pojišťovna XY', charging_flat: '50', analytics_tool: 'Matomo', analytics_provider: 'InnoCraft', accountant_role: '' });
  assert.equal(r.status, 303);
  const st = admin.getSettings(db, srv.tenant);
  assert.equal(st.accountingMode, 'danova-evidence');
  assert.equal(st.signatureMode, 'papir');
  assert.equal(st.idDocPrint, 'plne');
  assert.equal(st.secondIdDoc, true);
  assert.equal(st.recordBirthAddress, false);
  assert.equal(st.gpsTrackers, true);
  assert.equal(st.insurance, 'Pojišťovna XY');
  assert.equal(st.chargingFlatMinor, 5000);
  assert.equal(st.analyticsTool, 'Matomo');
  zas = nb(await (await srv.fetch('/soukromi')).text());
  assert.match(zas, /Analytické cookies/);
  assert.match(zas, /nástroje Matomo/);
  assert.match(zas, /Pojišťovna XY/);
  assert.match(zas, /Listinné protokoly\./);
  assert.ok(!/není cookie lišta/.test(zas));
  // neplatná hodnota selectu → výchozí; stránka ukazuje uložené hodnoty
  r = await post('/admin/nastaveni', { _csrf: token, sekce: 'pravni', signature_mode: 'fax', id_doc_print: 'plne', analytics_tool: '' });
  assert.equal(r.status, 303);
  const st2 = admin.getSettings(db, srv.tenant);
  assert.equal(st2.signatureMode, 'obrazovka');
  assert.equal(st2.analyticsTool, '');
  assert.equal(st2.gpsTrackers, false);
  const page2 = await (await srv.fetch('/admin/nastaveni')).text();
  assert.match(page2, /<option value="plne" selected>/);
  zas = nb(await (await srv.fetch('/soukromi')).text());
  assert.match(zas, /není cookie lišta/);
});

test('kola a ceník: nový typ, nový kus (validace velikosti), změna stavu, ceník typu, sezóna, příslušenství, QR štítky', async () => {
  const token = await adminCsrf();
  let r = await post('/admin/kola/typ', { _csrf: token, name: 'Městské kolo Testovací', slug: '', category: 'city', sizes: 'M, L', deposit: '3000', fee: '300', value: '15000', sort: '9', description: 'Popis', specs: 'Rám: ocel\nPřevody: 7', photos: '/img/demo/kola/trek-fx-2-2.jpg', active: '1' });
  assert.equal(r.status, 303);
  const type = db.prepare("SELECT * FROM bike_types WHERE slug = 'mestske-kolo-testovaci'").get();
  assert.ok(type);
  assert.equal(type.deposit_minor, 300000);
  assert.deepEqual(JSON.parse(type.sizes), ['M', 'L']);
  assert.equal(JSON.parse(type.photos)[0].src, '/img/demo/kola/trek-fx-2-2.jpg');
  assert.equal(JSON.parse(type.specs)['Rám'], 'ocel');
  // kus se špatnou velikostí → 422
  r = await post('/admin/kola/kus', { _csrf: token, bike_type_id: String(type.id), inventory_code: 'CTY-01', size: 'XL', status: 'available', frame_no: 'WTU-TEST-1' });
  assert.equal(r.status, 422);
  r = await post('/admin/kola/kus', { _csrf: token, bike_type_id: String(type.id), inventory_code: 'cty-01', size: 'M', status: 'available', frame_no: 'WTU-TEST-1', note: 'nový' });
  assert.equal(r.status, 303);
  const bike = db.prepare("SELECT * FROM bikes WHERE inventory_code = 'CTY-01'").get();
  assert.ok(bike);
  assert.ok(bike.frame_no_enc && !bike.frame_no_enc.includes('WTU-TEST-1'));
  r = await post(`/admin/kola/kus/${bike.id}/stav`, { _csrf: token, status: 'maintenance' });
  assert.equal(db.prepare('SELECT status FROM bikes WHERE id = ?').get(bike.id).status, 'maintenance');
  // ceník typu: základ povinný
  r = await post(`/admin/cenik/typ/${type.id}`, { _csrf: token, p_0_hour_1: '50' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM price_rules WHERE bike_type_id = ?').get(type.id).n, 0, 'bez základní ceny se neuloží');
  r = await post(`/admin/cenik/typ/${type.id}`, { _csrf: token, p_0_day_1: '290', p_0_day_2: '260', p_0_day_4: '240', p_0_day_7: '200', p_0_hour_1: '70', p_0_halfday_1: '190' });
  assert.equal(r.status, 303);
  const rules = db.prepare('SELECT unit, from_qty, price_minor FROM price_rules WHERE bike_type_id = ? ORDER BY unit, from_qty').all(type.id);
  assert.equal(rules.length, 6);
  assert.ok(rules.some((x) => x.unit === 'day' && x.from_qty === 1 && x.price_minor === 29000));
  // sezóna + příslušenství
  r = await post('/admin/cenik/sezona', { _csrf: token, name: 'Podzim test', date_from: '2030-09-16', date_to: '2030-10-31' });
  const season = db.prepare("SELECT * FROM seasons WHERE name = 'Podzim test'").get();
  assert.ok(season);
  r = await post('/admin/cenik/prislusenstvi', { _csrf: token, name: 'Košík testovací', price: '20', stock: '3' });
  const acc = db.prepare("SELECT * FROM accessories WHERE name = 'Košík testovací'").get();
  assert.ok(acc && acc.price_minor === 2000 && acc.stock === 3);
  r = await post(`/admin/cenik/prislusenstvi/${acc.id}`, { _csrf: token, name: 'Košík testovací', price: '25', stock: '2' });
  assert.equal(db.prepare('SELECT active, price_minor FROM accessories WHERE id = ?').get(acc.id).active, 0, 'nezaškrtnuté active → neaktivní');
  r = await post(`/admin/cenik/sezona/${season.id}/smazat`, { _csrf: token });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM seasons WHERE id = ?').get(season.id).n, 0);
  // štítky
  const labels = nb(await (await srv.fetch(`/admin/kola/stitky?typ=${type.id}`)).text());
  assert.match(labels, /<svg class="qr-svg"/);
  assert.match(labels, /CTY-01/);
  const cenik = nb(await (await srv.fetch('/admin/cenik')).text());
  assert.match(cenik, /Městské kolo Testovací/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'bike_type.create'").get());
});

test('kalendář: timeline 14 dní s řádky typů a kusů, bloky odkazují na detail', async () => {
  const res = await srv.fetch('/admin/kalendar');
  assert.equal(res.status, 200);
  const html = nb(await res.text());
  assert.match(html, /<div class="timeline timeline--admin" data-days="14"/);
  assert.match(html, /timeline__row--type/);
  assert.match(html, /timeline__row--bike/);
  assert.match(html, /class="timeline__bar status-(checked_out|confirmed|awaiting_fee|returned)[^"]*" data-from="\d+" data-span="\d+"[^>]*href="\/admin\/rezervace\/\d+"/);
  const r7 = await srv.fetch('/admin/kalendar?dny=7&od=2030-01-01');
  assert.match(nb(await r7.text()), /data-days="7"/);
});

test('e-maily: outbox seznam a detail se sandboxovaným náhledem, bez adresy příjemce', async () => {
  const list = await srv.fetch('/admin/emaily');
  assert.equal(list.status, 200);
  const mail = db.prepare('SELECT * FROM outbox WHERE body_html IS NOT NULL ORDER BY id LIMIT 1').get();
  const res = await srv.fetch(`/admin/emaily/${mail.id}`);
  assert.equal(res.status, 200);
  const html = nb(await res.text());
  assert.match(html, /<iframe class="admin-mail-frame" title="Náhled e-mailu" sandbox="" srcdoc="/);
  assert.match(html, /Textová verze/);
  assert.ok(!/example\.com/.test(html.replace(/srcdoc="[^"]*"/, '').replace(/<pre class="admin-pre">[\s\S]*?<\/pre>/g, '')), 'adresa příjemce se nezobrazuje mimo tělo e-mailu');
  assert.ok(!/to_enc/.test(html));
});

test('zákazníci: hledání podle e-mailu (HMAC), karta s auditem, export JSON, anonymizace', async () => {
  const token = await adminCsrf();
  const email = 'jana.novakova@example.com';
  let res = await srv.fetch(`/admin/zakaznici?email=${encodeURIComponent(email)}`);
  assert.equal(res.status, 200);
  let html = nb(await res.text());
  const hmac = srv.app.fieldCrypto.hmacEmail(email);
  const cust = db.prepare('SELECT * FROM customers WHERE email_hmac = ?').get(hmac);
  assert.ok(cust);
  assert.match(html, new RegExp(`href="/admin/zakaznici/${cust.id}"`));
  res = await srv.fetch(`/admin/zakaznici/${cust.id}`);
  html = nb(await res.text());
  assert.match(html, /Jana Nováková/);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'customer.view' AND entity_id = ?").get(String(cust.id)));
  res = await srv.fetch(`/admin/zakaznici/${cust.id}/export.json`);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.customer.name, 'Jana Nováková');
  assert.equal(json.customer.email, email);
  assert.ok(Array.isArray(json.reservations) && json.reservations.length >= 1);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'customer.export' AND entity_id = ?").get(String(cust.id)));
  // anonymizace: zákazník r1 má jen uzavřenou rezervaci
  const active = db.prepare("SELECT COUNT(*) AS n FROM reservations WHERE customer_id = ? AND status IN ('awaiting_fee','confirmed','checked_out','returned')").get(cust.id).n;
  assert.equal(active, 0);
  res = await post(`/admin/zakaznici/${cust.id}/anonymizovat`, { _csrf: token });
  assert.equal(res.status, 303);
  const after = db.prepare('SELECT * FROM customers WHERE id = ?').get(cust.id);
  assert.ok(after.anonymized_at);
  assert.notEqual(after.email_hmac, hmac);
  assert.equal(srv.app.fieldCrypto.dec(after.name_enc), 'Anonymizovaný zákazník');
  assert.equal(after.phone_enc, null);
  assert.equal(after.id_doc_number_enc, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers WHERE email_hmac = ?').get(hmac).n, 0, 'hledání podle e-mailu už nic nenajde');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE to_hmac = ?').get(hmac).n, 0, 'outbox bez vazby na adresu');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'customer.anonymize' AND entity_id = ?").get(String(cust.id)));
  html = nb(await (await srv.fetch(`/admin/zakaznici/${cust.id}`)).text());
  assert.match(html, /anonymizován/);
  assert.ok(!/Jana Nováková/.test(html));
  assert.equal((await srv.fetch(`/admin/zakaznici/${cust.id}/export.json`)).status, 404);
  // zákazník s aktivní rezervací anonymizovat nelze
  const activeCust = db.prepare("SELECT customer_id FROM reservations WHERE status IN ('confirmed','checked_out') AND customer_id IS NOT NULL LIMIT 1").get();
  res = await post(`/admin/zakaznici/${activeCust.customer_id}/anonymizovat`, { _csrf: token });
  assert.equal(db.prepare('SELECT anonymized_at FROM customers WHERE id = ?').get(activeCust.customer_id).anonymized_at, null);
});

test('retence dokladu totožnosti: job smaže prošlé číslo a zapíše audit', async () => {
  const cust = db.prepare('SELECT * FROM customers WHERE id_doc_number_enc IS NOT NULL LIMIT 1').get();
  assert.ok(cust, 'z průchodu zůstal zapsaný doklad');
  db.prepare("UPDATE customers SET id_doc_delete_after = '2000-01-01T00:00:00.000Z' WHERE id = ?").run(cust.id);
  await admin.idDocRetentionJob({ tenants: [srv.tenant], dbs: srv.dbs, log: silent });
  const after = db.prepare('SELECT * FROM customers WHERE id = ?').get(cust.id);
  assert.equal(after.id_doc_number_enc, null);
  assert.equal(after.id_doc_type, null);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'customer.id_doc_deleted' AND entity_id = ? AND json_extract(meta, '$.reason') = 'retention'").get(String(cust.id)));
});

test('audit: stránka 200 s filtrem akce, záznamy přihlášení i změn mají uživatele', async () => {
  const res = await srv.fetch('/admin/audit?akce=auth.login');
  assert.equal(res.status, 200);
  const html = nb(await res.text());
  assert.match(html, /auth\.login/);
  assert.match(html, /demo@ksprehledy\.cz/);
  const byEntity = await srv.fetch('/admin/audit?entita=reservation%206');
  assert.match(nb(await byEntity.text()), /reservation\.check_out/);
  const total = db.prepare('SELECT COUNT(*) AS n FROM audit_log WHERE user_id IS NOT NULL').get().n;
  assert.ok(total > 20, 'změny z adminu jsou auditované');
});

test('TOTP: zapnutí 2FA s QR otpauth a ověřením kódu, odhlášení a přihlášení heslem + kódem (špatný kód odmítnut)', async () => {
  let res = await srv.fetch('/admin/ucet/2fa');
  assert.equal(res.status, 200);
  let html = nb(await res.text());
  assert.match(html, /<svg class="qr-svg"/);
  const m = /<code class="admin-2fa__secret">([A-Z2-7 ]+)<\/code>/.exec(html);
  assert.ok(m, 'stránka ukazuje klíč pro ruční zadání');
  const secret = m[1].replace(/\s+/g, '');
  assert.equal(totp.base32Decode(secret).length, 20);
  let token = await adminCsrf();
  // špatný kód
  res = await post('/admin/ucet/2fa', { _csrf: token, kod: '000000' });
  assert.equal(res.status, 303);
  assert.equal(db.prepare('SELECT totp_enabled FROM users WHERE email = ?').get(DEMO_EMAIL).totp_enabled, 0);
  // správný kód
  res = await post('/admin/ucet/2fa', { _csrf: token, kod: totp.totp(secret) });
  assert.equal(res.status, 303);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(DEMO_EMAIL);
  assert.equal(u.totp_enabled, 1);
  assert.ok(u.totp_secret_enc && !u.totp_secret_enc.includes(secret), 'secret šifrovaný');
  assert.equal(srv.app.fieldCrypto.dec(u.totp_secret_enc), secret);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'user.totp_enable'").get());
  html = nb(await (await srv.fetch('/admin/ucet')).text());
  assert.match(html, /2FA je zapnuté/);
  // odhlásit a přihlásit: heslo → krok 2FA
  res = await post('/admin/logout', { _csrf: token });
  assert.equal(res.status, 303);
  resetLoginLimit();
  res = await login();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin/login/2fa');
  assert.equal((await srv.fetch('/admin')).status, 303, 'před kódem stále nepřihlášen');
  res = await srv.fetch('/admin/login/2fa');
  assert.equal(res.status, 200);
  assert.match(nb(await res.text()), /Ověření druhým faktorem/);
  token = await srv.csrf('/admin/login/2fa');
  res = await post('/admin/login/2fa', { _csrf: token, kod: '123456' });
  assert.equal(res.status, 401);
  assert.match(nb(await res.text()), /Kód nesouhlasí/);
  res = await post('/admin/login/2fa', { _csrf: token, kod: totp.totp(secret) });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/admin');
  assert.equal((await srv.fetch('/admin')).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'auth.login' AND json_extract(meta, '$.via') = 'password+totp'").get());
  // vypnout s kódem
  res = await post('/admin/ucet/2fa/vypnout', { _csrf: await adminCsrf(), kod: totp.totp(secret) });
  assert.equal(db.prepare('SELECT totp_enabled FROM users WHERE email = ?').get(DEMO_EMAIL).totp_enabled, 0);
});

test('log neobsahuje osobní údaje ani tajemství', () => {
  const all = logLines.join('\n');
  assert.ok(all.length > 0);
  assert.ok(!all.includes('jana.novakova'), 'e-mail v logu');
  assert.ok(!all.includes('Martin Kučera'), 'jméno v logu');
  assert.ok(!all.includes(ID_DOC_NUMBER), 'číslo dokladu v logu');
  assert.ok(!all.includes(DEMO_PASSWORD), 'heslo v logu');
  assert.ok(!/obsluha-heslo/.test(all));
});
