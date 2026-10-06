'use strict';
// Demo data (SPEC kap. 14) – skeleton kostry. Idempotentní naplnění DB tenanta; --reset smaže data a naplní znovu.
//   node --disable-warning=ExperimentalWarning tools/demo-data.js [--reset] [--tenant demo]
// Export seed({ db, tenant, config, fieldCrypto, reset, log }) používá i noční reset v server.js (job demo-reset).
// Kostra vytváří admin uživatele demo@ksprehledy.cz / kolo-demo-2026 (scrypt). Sekce // === KOLA === (typy kol,
// kusy, sezóny, ceník, příslušenství, zavírací dny) doplní agent kola, sekci // === REZERVACE === (rezervace, zákazníci,
// platby, ledger, doklady, outbox, audit) doplní agent rezervace. Každý edituje jen svou sekci.

const path = require('node:path');
const { loadConfig, ensureSecret, DEMO_ADMIN_EMAIL, DEMO_ADMIN_PASSWORD } = require('../src/config');
const { openTenantDb, nowIso, transaction } = require('../src/db');
const { loadTenants, seedSettings } = require('../src/tenants');
const { createFieldCrypto } = require('../src/crypto/fields');
const { hashPassword } = require('../src/crypto/passwords');
const defaultLog = require('../src/log');

// Pořadí respektuje cizí klíče (děti před rodiči). meta a settings zůstávají.
const RESET_TABLES = [
  'ledger_entries',
  'documents',
  'handovers',
  'bank_transactions',
  'webhook_events',
  'payments',
  'reservation_items',
  'reservations',
  'customers',
  'price_rules',
  'bikes',
  'accessories',
  'seasons',
  'closures',
  'bike_types',
  'outbox',
  'audit_log',
  'sessions',
  'poi_overrides',
  'content_pages',
  'users',
];

/** Smaže všechna data kromě meta a settings. */
function resetAll(db) {
  for (const t of RESET_TABLES) db.exec(`DELETE FROM ${t}`);
}

/** Admin účet dema (upsert podle e-mailu). */
function seedAdmin(db, { email = DEMO_ADMIN_EMAIL, password = DEMO_ADMIN_PASSWORD, name = 'Správce dema' } = {}) {
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  const hash = hashPassword(password);
  if (existing) {
    db.prepare("UPDATE users SET password_hash = ?, role = 'owner', disabled = 0, failed_logins = 0, locked_until = NULL WHERE id = ?").run(hash, existing.id);
    return existing.id;
  }
  const r = db.prepare("INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?)").run(email.toLowerCase(), name, hash, nowIso());
  return Number(r.lastInsertRowid);
}

/**
 * Naplní DB tenanta demo daty.
 * @param {{db, tenant, config, fieldCrypto, reset?: boolean, log?: object}} opts
 * @returns {{ adminId: number }}
 */
async function seed({ db, tenant, config, fieldCrypto, reset = false, log = defaultLog }) {
  const summary = { tenant: tenant.slug, reset };
  transaction(db, () => {
    if (reset) resetAll(db);
    seedSettings(db, tenant);
    summary.adminId = seedAdmin(db, { email: config.adminUser || DEMO_ADMIN_EMAIL, password: config.adminPassword || DEMO_ADMIN_PASSWORD });

    // === KOLA ===
    // Agent kola: 6 typů kol (bike_types, upsert podle slug), 22 kusů (bikes, upsert podle inventory_code), sezóna
    // „Hlavní sezóna“ 15. 6.–15. 9. letos i příští rok (+15 %, zaokrouhleno na 10 Kč), price_rules v pásmech
    // 1 / 2–3 / 4–6 / 7+ dní + hour + halfday (pro typ se vždy smažou a znovu vloží), accessories (upsert podle slug),
    // closures 24.–26. 12. (letos i příští rok). Fotky: public/img/demo/kola/ (CC BY, viz ATTRIBUTION.md tamtéž).
    {
      const IMG = '/img/demo/kola';
      const photo = (file, alt, author, license, licenseUrl, sourceUrl) => ({ src: `${IMG}/${file}`, alt, author, license, licenseUrl, sourceUrl });
      const CC_BY_2 = ['CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0'];
      const CC_BY_4 = ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0'];
      const COMMONS = 'https://commons.wikimedia.org/wiki/File:';
      // ceny v Kč: [1 den, 2–3 dny, 4–6 dní, 7+ dní], hour, halfday
      const TYPES = [
        {
          slug: 'trek-fx-2', name: 'Trekové kolo Trek FX 2', category: 'trek', sort: 1, sizes: ['S', 'M', 'L', 'XL'], deposit: 5000, fee: 300, value: 25000,
          day: [390, 350, 320, 290], hour: 90, halfday: 250, bikes: ['S', 'M', 'M', 'L', 'XL'], code: 'TRK',
          description: 'Univerzální trekové kolo na hráze rybníků i asfaltové cyklostezky. Pohodlný posed, odpružená vidlice, blatníky, nosič a světla v ceně.',
          specs: { Rám: 'hliník Alpha Gold', Převody: 'Shimano Altus 2×9', Brzdy: 'hydraulické kotoučové', Kola: '28" (700c), pláště 38 mm', Hmotnost: '12,5 kg', Výbava: 'blatníky, nosič, světla, zámek', 'Doporučená výška jezdce': 'S 155–168 cm · M 165–178 cm · L 175–188 cm · XL 185–198 cm' },
          photos: [photo('trek-fx-2-1.jpg', 'Trekové kolo s rovnými řídítky opřené o zeď', 'Taiyo FUJII', ...CC_BY_2, `${COMMONS}Giant_Escape_M2.jpg`), photo('trek-fx-2-2.jpg', 'Cestovní kolo s brašnami na cyklostezce', 'Giubar', ...CC_BY_4, `${COMMONS}Bici_da_cicloturismo_sulla_ciclabile_FGV_1.jpg`)],
        },
        {
          slug: 'rockhopper', name: 'Horské kolo Specialized Rockhopper', category: 'mtb', sort: 2, sizes: ['S', 'M', 'L', 'XL'], deposit: 7000, fee: 300, value: 30000,
          day: [450, 400, 370, 340], hour: 100, halfday: 290, bikes: ['M', 'M', 'L', 'XL'], code: 'MTB',
          description: 'Hardtail na lesní cesty a singletraily v okolí Třeboně. Odpružená vidlice 100 mm, široké pláště, kotoučové brzdy.',
          specs: { Rám: 'hliník A1', Vidlice: 'odpružená, zdvih 100 mm', Převody: 'Shimano Deore 1×11', Brzdy: 'hydraulické kotoučové', Kola: '29" (S: 27,5")', Hmotnost: '13,8 kg', 'Doporučená výška jezdce': 'S 158–170 cm · M 168–180 cm · L 178–190 cm · XL 188–200 cm' },
          photos: [photo('rockhopper-1.jpg', 'Horské kolo (hardtail) z boku', 'Glory Cycles', ...CC_BY_2, `${COMMONS}Orbea_Alma_M10_2019.jpg`)],
        },
        {
          slug: 'cube-touring-hybrid', name: 'Elektrokolo trekové Cube Touring Hybrid', category: 'ebike', sort: 3, sizes: ['S', 'M', 'L'], deposit: 10000, fee: 500, value: 75000,
          day: [890, 790, 690, 590], hour: 190, halfday: 590, bikes: ['S', 'M', 'L', 'L'], code: 'ETR',
          description: 'Trekové elektrokolo se středovým motorem Bosch a dojezdem až 100 km. Ideální na celodenní výlet k Rožmberku a zpět bez námahy.',
          specs: { Motor: 'Bosch Performance Line, 65 Nm', Baterie: '625 Wh, dojezd 70–110 km', Převody: 'Shimano Deore 1×10', Brzdy: 'hydraulické kotoučové', Kola: '28"', Hmotnost: '24 kg', Výbava: 'blatníky, nosič, světla, zámek', 'Doporučená výška jezdce': 'S 158–170 cm · M 168–180 cm · L 178–192 cm' },
          photos: [photo('cube-touring-hybrid-1.jpg', 'Elektrokolo s pomocným motorem a baterií (ilustrační foto)', 'MIKI Yoshihito', ...CC_BY_2, `${COMMONS}Electric_assisted_bicycle_in_Japan_5358337867_4aa32aa34e_z.jpg`)],
        },
        {
          slug: 'haibike-alltrail', name: 'Elektrokolo horské Haibike AllTrail', category: 'ebike', sort: 4, sizes: ['M', 'L', 'XL'], deposit: 10000, fee: 500, value: 90000,
          day: [990, 890, 790, 690], hour: 210, halfday: 650, bikes: ['M', 'L', 'XL'], code: 'EMT',
          description: 'Horské elektrokolo s odpružením 120 mm pro lesní cesty a náročnější terén. Silný motor Yamaha, integrovaná baterie.',
          specs: { Motor: 'Yamaha PW-ST, 70 Nm', Baterie: '630 Wh, dojezd 60–100 km', Vidlice: 'odpružená, zdvih 120 mm', Převody: 'Shimano Deore 1×12', Brzdy: 'hydraulické kotoučové, kotouče 203/180 mm', Kola: '29"', Hmotnost: '25 kg', 'Doporučená výška jezdce': 'M 168–180 cm · L 178–190 cm · XL 188–200 cm' },
          photos: [photo('haibike-alltrail-1.jpg', 'Horské elektrokolo s integrovanou baterií', 'Tony Hisgett', ...CC_BY_2, `${COMMONS}Cube_Mountain_ebike_(50198895002).jpg`)],
        },
        {
          slug: 'woom-4', name: 'Dětské kolo Woom 4', category: 'kids', sort: 5, sizes: ['20"', '24"'], deposit: 2000, fee: 300, value: 12000,
          day: [250, 220, 200, 180], hour: 60, halfday: 160, bikes: ['20"', '20"', '24"', '24"'], code: 'KID',
          description: 'Lehké dětské kolo s nízkým nástupem a dětskými brzdovými pákami. Velikost 20" pro děti 6–8 let, 24" pro 8–11 let.',
          specs: { Rám: 'hliník, lehká konstrukce', Převody: '20": 1×8 · 24": 1×8', Brzdy: 'V-brzdy s dětskými pákami', Hmotnost: '20": 7,7 kg · 24": 8,6 kg', 'Doporučená výška dítěte': '20" 118–130 cm · 24" 125–145 cm', Výbava: 'zvonek, odrazky, stojánek' },
          photos: [photo('woom-4-1.jpg', 'Dětské kolo', 'MIKI Yoshihito', ...CC_BY_2, `${COMMONS}CADILLAC_kids_bike._(14563341987).jpg`)],
        },
        {
          slug: 'canyon-grail', name: 'Gravel Canyon Grail', category: 'gravel', sort: 6, sizes: ['M', 'L'], deposit: 8000, fee: 300, value: 45000,
          day: [590, 540, 490, 450], hour: 130, halfday: 390, bikes: ['M', 'L'], code: 'GRV',
          description: 'Rychlé gravel kolo na šotolinové hráze a pískové lesní cesty Třeboňska. Karbonový rám, široké pláště, pohodlný posed.',
          specs: { Rám: 'karbon', Převody: 'Shimano GRX 2×11', Brzdy: 'hydraulické kotoučové', Kola: '28" (700c), pláště 40 mm', Hmotnost: '9,2 kg', 'Doporučená výška jezdce': 'M 170–182 cm · L 180–192 cm' },
          photos: [photo('canyon-grail-1.jpg', 'Gravel kolo s titanovým rámem', 'Jeff Dieffenbach', ...CC_BY_4, `${COMMONS}Titanium-frame-gravel-bicycle.jpg`), photo('canyon-grail-2.jpg', 'Gravel kolo v tunelu na cyklostezce', 'Tristan Schmurr', ...CC_BY_2, `${COMMONS}Gravel_bike_inside_Hovelange_tunnel.jpg`)],
        },
      ];
      const ACCESSORIES = [
        { slug: 'prilba', name: 'Cyklistická přilba', price: 50, stock: 15 },
        { slug: 'detska-sedacka', name: 'Dětská sedačka (do 22 kg)', price: 100, stock: 4 },
        { slug: 'vozik', name: 'Dětský vozík za kolo (2 děti)', price: 250, stock: 2 },
        { slug: 'zamek', name: 'Zámek', price: 0, stock: 30 },
      ];
      const kc = (v) => Math.round(v * 100);
      const seasonal = (v) => Math.round((v * 1.15) / 10) * 10;
      const year = Number(nowIso().slice(0, 4));

      const upsertType = db.prepare(
        `INSERT INTO bike_types(slug, name, category, description, photos, sizes, specs, deposit_minor, fee_minor, value_minor, active, sort)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, category = excluded.category, description = excluded.description, photos = excluded.photos,
           sizes = excluded.sizes, specs = excluded.specs, deposit_minor = excluded.deposit_minor, fee_minor = excluded.fee_minor, value_minor = excluded.value_minor,
           active = 1, sort = excluded.sort`
      );
      const upsertBike = db.prepare(
        `INSERT INTO bikes(bike_type_id, inventory_code, size, frame_no_enc, status, note) VALUES (?, ?, ?, ?, 'available', NULL)
         ON CONFLICT(inventory_code) DO UPDATE SET bike_type_id = excluded.bike_type_id, size = excluded.size`
      );
      const upsertAccessory = db.prepare(
        `INSERT INTO accessories(slug, name, price_minor, stock, active) VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(slug) DO UPDATE SET name = excluded.name, price_minor = excluded.price_minor, stock = excluded.stock, active = 1`
      );
      const insertRule = db.prepare('INSERT INTO price_rules(bike_type_id, season_id, unit, from_qty, price_minor) VALUES (?, ?, ?, ?, ?)');

      // sezóny: smazat staré „Hlavní sezóna“ (včetně jejich pravidel) a založit letos + příští rok
      const typeIds = {};
      for (const t of TYPES) {
        upsertType.run(t.slug, t.name, t.category, t.description, JSON.stringify(t.photos), JSON.stringify(t.sizes), JSON.stringify(t.specs), kc(t.deposit), kc(t.fee), kc(t.value), t.sort);
        typeIds[t.slug] = db.prepare('SELECT id FROM bike_types WHERE slug = ?').get(t.slug).id;
        db.prepare('DELETE FROM price_rules WHERE bike_type_id = ?').run(typeIds[t.slug]);
      }
      db.prepare("DELETE FROM price_rules WHERE season_id IN (SELECT id FROM seasons WHERE name = 'Hlavní sezóna')").run();
      db.prepare("DELETE FROM seasons WHERE name = 'Hlavní sezóna'").run();
      const seasonIds = [year, year + 1].map((y) => Number(db.prepare('INSERT INTO seasons(name, date_from, date_to) VALUES (?, ?, ?)').run('Hlavní sezóna', `${y}-06-15`, `${y}-09-15`).lastInsertRowid));

      const TIERS = [1, 2, 4, 7];
      for (const t of TYPES) {
        const id = typeIds[t.slug];
        TIERS.forEach((fromQty, i) => insertRule.run(id, null, 'day', fromQty, kc(t.day[i])));
        insertRule.run(id, null, 'hour', 1, kc(t.hour));
        insertRule.run(id, null, 'halfday', 1, kc(t.halfday));
        for (const sid of seasonIds) {
          TIERS.forEach((fromQty, i) => insertRule.run(id, sid, 'day', fromQty, kc(seasonal(t.day[i]))));
          insertRule.run(id, sid, 'hour', 1, kc(seasonal(t.hour)));
          insertRule.run(id, sid, 'halfday', 1, kc(seasonal(t.halfday)));
        }
        t.bikes.forEach((size, i) => {
          const code = `${t.code}-${String(i + 1).padStart(2, '0')}`;
          upsertBike.run(id, code, size, fieldCrypto.enc(`WTU${t.code}${String(100 + i)}DEMO`));
        });
      }
      for (const a of ACCESSORIES) upsertAccessory.run(a.slug, a.name, kc(a.price), a.stock);
      db.prepare("DELETE FROM closures WHERE reason = 'Vánoce'").run();
      for (const y of [year, year + 1]) db.prepare('INSERT INTO closures(date_from, date_to, reason) VALUES (?, ?, ?)').run(`${y}-12-24`, `${y}-12-26`, 'Vánoce');
      summary.bikeTypes = TYPES.length;
      summary.bikes = db.prepare('SELECT COUNT(*) AS n FROM bikes').get().n;
    }
    // === /KOLA ===

    // === REZERVACE ===
    // Agent rezervace: 12 rezervací kolem dnešního dne (dnes = new Date() při seedu) vytvořených přes doménové funkce
    // (reservations.create + transition), takže zákazníci (šifrovaná pole, e-mail HMAC), položky, platby, ledger, audit
    // i outbox vznikají stejně jako v ostrém provozu. Seeduje se jen při --reset nebo do prázdné tabulky reservations.
    // Doklady (documents) vystavuje modul platby/documents – zde zatím nevznikají (viz docs/TODO-INTEGRACE.md).
    if (reset || db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n === 0) {
      const reservations = require('../src/domain/reservations');
      const availability = require('../src/domain/availability');
      const outbox = require('../src/mail/outbox');
      const { getSettings, publicBaseUrl } = require('../src/tenants');
      const settings = getSettings(db, tenant);
      const secret = ensureSecret(config);
      const baseUrl = publicBaseUrl(tenant);
      const mail = { fieldCrypto, tenant, settings, baseUrl, secret };
      const today = availability.utcToLocal(new Date()).date;
      const D = (offsetDays, time) => availability.localToUtc(availability.addDays(today, offsetDays), time);
      const at = (offsetDays, time) => D(offsetDays, time).toISOString();
      const typeId = (slug) => db.prepare('SELECT id FROM bike_types WHERE slug = ?').get(slug).id;
      const CUSTOMERS = [
        { name: 'Jana Nováková', email: 'jana.novakova@example.com', phone: '+420 777 000 001' },
        { name: 'Petr Svoboda', email: 'petr.svoboda@example.com', phone: '+420 777 000 002' },
        { name: 'Eva Dvořáková', email: 'eva.dvorakova@example.com', phone: '+420 777 000 003' },
        { name: 'Tomáš Černý', email: 'tomas.cerny@example.com', phone: '+420 777 000 004' },
        { name: 'Lucie Procházková', email: 'lucie.prochazkova@example.com', phone: '+420 777 000 005' },
        { name: 'Martin Kučera', email: 'martin.kucera@example.com', phone: '+420 777 000 006' },
        { name: 'Hana Veselá', email: 'hana.vesela@example.com', phone: '+420 777 000 007' },
        { name: 'Jakub Horák', email: 'jakub.horak@example.com', phone: '+420 777 000 008' },
        { name: 'Markéta Němcová', email: 'marketa.nemcova@example.com', phone: '+420 777 000 009' },
        { name: 'Ondřej Marek', email: 'ondrej.marek@example.com', phone: '+420 777 000 010' },
      ];
      const business = tenant.business || {};
      const spaydFor = (amountMinor, vs) => `SPD*1.0*ACC:${business.iban || ''}*AM:${(amountMinor / 100).toFixed(2)}*CC:CZK*X-VS:${vs}*MSG:REZERVACE ${vs}`;

      /** Založí rezervaci (awaiting_fee) k danému okamžiku. items: [{ slug, size, qty }] */
      const make = ({ customer, createdAt, from, to, items, accessories = [], note }) =>
        reservations.create({
          db,
          tenant,
          settings,
          fieldCrypto,
          secret,
          baseUrl,
          now: new Date(createdAt),
          ipHash: 'demo',
          draft: { fromAt: from, toAt: to, items: items.map((it) => ({ typeId: typeId(it.slug), size: it.size, qty: it.qty })), accessories, customer, consents: { termsVersion: (tenant.legal && tenant.legal.version) || '1.0', marketing: false }, note },
        }).reservation;

      /** Zaplacení poplatku: řádek payments + přechod fee_paid (e-mail „platba přijata“). */
      const payFee = (r, { method, when, providerRef }) => {
        const provider = method === 'card' ? 'mock' : 'fio-mock';
        const p = reservations.recordPayment(db, { reservationId: r.id, purpose: 'fee', method, provider, providerRef: providerRef || `${provider.toUpperCase()}-${r.number}`, amountMinor: r.fee_minor, status: 'paid', idempotencyKey: `demo:${r.number}:fee`, vs: r.number, spayd: method === 'bank_transfer' ? spaydFor(r.fee_minor, r.number) : null, now: when });
        if (method === 'bank_transfer') {
          db.prepare('INSERT INTO bank_transactions(source, tx_id, booked_at, amount_minor, vs, msg, counter_account, counter_name, matched_payment_id, raw) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)').run('fio-mock', `DEMO-TX-${r.number}`, when, r.fee_minor, r.number, `REZERVACE ${r.number}`, '123456789/0100', p.id);
        }
        reservations.transition(db, r.id, 'fee_paid', { paymentId: p.id, amountMinor: r.fee_minor, method, now: when, settings, mail });
        return p;
      };

      /** Výdej: přiřadí první volné kusy, zapíše kauci (cash / terminal / card preautorizace) a doplatek. */
      const checkOut = (r, { when, depositMethod, balanceMethod = 'terminal' }) => {
        const detail = reservations.loadDetail(db, r);
        const used = new Set();
        const assignments = detail.itemRows.map((row) => {
          const bike = db.prepare("SELECT id FROM bikes WHERE bike_type_id = ? AND size = ? AND status = 'available' ORDER BY inventory_code").all(row.bike_type_id, row.size).find((b) => !used.has(b.id));
          if (bike) used.add(bike.id);
          return { itemId: row.id, bikeId: bike ? bike.id : null };
        });
        let depositPaymentId = null;
        if (depositMethod === 'card') {
          depositPaymentId = reservations.recordPayment(db, { reservationId: r.id, purpose: 'deposit_hold', method: 'card', provider: 'mock', providerRef: `MOCK-HOLD-${r.number}`, amountMinor: r.deposit_minor, capturedMinor: 0, status: 'authorized', idempotencyKey: `demo:${r.number}:deposit`, vs: r.number, now: when }).id;
        } else {
          depositPaymentId = reservations.recordPayment(db, { reservationId: r.id, purpose: 'deposit_hold', method: depositMethod, provider: 'manual', amountMinor: r.deposit_minor, capturedMinor: 0, status: 'authorized', idempotencyKey: `demo:${r.number}:deposit`, vs: r.number, now: when }).id;
        }
        const balance = Math.max(0, r.total_minor - r.paid_minor);
        let balancePaymentId = null;
        if (balance > 0) balancePaymentId = reservations.recordPayment(db, { reservationId: r.id, purpose: 'balance', method: balanceMethod, provider: 'manual', amountMinor: balance, status: 'paid', idempotencyKey: `demo:${r.number}:balance`, vs: r.number, now: when }).id;
        return reservations.transition(db, r.id, 'check_out', { items: assignments, depositMinor: r.deposit_minor, depositMethod, paymentId: depositPaymentId, balancePaidMinor: balance, balancePaymentId, balanceMethod, userId: summary.adminId, now: when, settings }).reservation;
      };
      const giveBack = (r, { when, damageMinor = 0, note }) => reservations.transition(db, r.id, 'return', { damageMinor, note, userId: summary.adminId, now: when, settings }).reservation;
      const close = (r, { when, capturedMinor = 0 }) => {
        const hold = db.prepare("SELECT id FROM payments WHERE reservation_id = ? AND purpose = 'deposit_hold'").get(r.id);
        if (hold) db.prepare('UPDATE payments SET status = ?, captured_minor = ?, updated_at = ? WHERE id = ?').run(capturedMinor > 0 ? 'partially_captured' : 'released', capturedMinor, when, hold.id);
        return reservations.transition(db, r.id, 'close', { depositCapturedMinor: capturedMinor, paymentId: hold ? hold.id : null, userId: summary.adminId, now: when, settings }).reservation;
      };

      // 1) uzavřená: před 10 dny, 2× trek M, kauce preautorizací karty (uvolněna), doplatek terminálem
      let r1 = make({ customer: CUSTOMERS[0], createdAt: at(-20, '14:10'), from: at(-10, '09:00'), to: at(-8, '17:00'), items: [{ slug: 'trek-fx-2', size: 'M', qty: 2 }], accessories: [{ slug: 'zamek', qty: 2 }] });
      payFee(r1, { method: 'card', when: at(-20, '14:12') });
      r1 = checkOut(reservations.get(db, r1.id), { when: at(-10, '09:05'), depositMethod: 'card' });
      r1 = giveBack(r1, { when: at(-8, '16:40'), note: 'Kola v pořádku, umytá.' });
      close(r1, { when: at(-8, '16:45') });

      // 2) uzavřená: jednodenní gravel před 6 dny, poplatek převodem, kauce hotově
      let r2 = make({ customer: CUSTOMERS[1], createdAt: at(-12, '19:30'), from: at(-6, '09:00'), to: at(-6, '16:00'), items: [{ slug: 'canyon-grail', size: 'M', qty: 1 }] });
      payFee(r2, { method: 'bank_transfer', when: at(-11, '08:02') });
      r2 = checkOut(reservations.get(db, r2.id), { when: at(-6, '09:10'), depositMethod: 'cash', balanceMethod: 'cash' });
      r2 = giveBack(r2, { when: at(-6, '15:50') });
      close(r2, { when: at(-6, '15:55') });

      // 3) vrácená, čeká na uzavření: elektrokolo s přilbou, poškození 500 Kč (škrábanec na rámu), kauce kartou
      let r3 = make({ customer: CUSTOMERS[2], createdAt: at(-9, '10:00'), from: at(-3, '10:00'), to: at(-1, '17:00'), items: [{ slug: 'cube-touring-hybrid', size: 'M', qty: 1 }], accessories: [{ slug: 'prilba', qty: 1 }] });
      payFee(r3, { method: 'card', when: at(-9, '10:03') });
      r3 = checkOut(reservations.get(db, r3.id), { when: at(-3, '10:05'), depositMethod: 'card' });
      giveBack(r3, { when: at(-1, '16:30'), damageMinor: 50000, note: 'Škrábanec na horní rámové trubce – řeší se stržením z kauce.' });

      // 4) vydaná s preautorizovanou kaucí, vrací se zítra: 2× horské kolo
      let r4 = make({ customer: CUSTOMERS[3], createdAt: at(-7, '21:15'), from: at(-2, '09:00'), to: at(1, '17:00'), items: [{ slug: 'rockhopper', size: 'L', qty: 1 }, { slug: 'rockhopper', size: 'M', qty: 1 }] });
      payFee(r4, { method: 'card', when: at(-7, '21:16') });
      checkOut(reservations.get(db, r4.id), { when: at(-2, '09:20'), depositMethod: 'card' });

      // 5) vydaná, dnešní vrácení: rodina – 2× dětské 20", trek L + XL, dětská sedačka, kauce hotově
      let r5 = make({ customer: CUSTOMERS[4], createdAt: at(-5, '12:40'), from: at(-1, '09:00'), to: at(0, '17:00'), items: [{ slug: 'woom-4', size: '20"', qty: 2 }, { slug: 'trek-fx-2', size: 'L', qty: 1 }, { slug: 'trek-fx-2', size: 'XL', qty: 1 }], accessories: [{ slug: 'prilba', qty: 4 }] });
      payFee(r5, { method: 'card', when: at(-5, '12:41') });
      checkOut(reservations.get(db, r5.id), { when: at(-1, '09:15'), depositMethod: 'cash' });

      // 6) potvrzená, dnešní výdej: horské elektrokolo; připomínka odešla včera
      const r6 = make({ customer: CUSTOMERS[5], createdAt: at(-5, '08:00'), from: at(0, '10:00'), to: at(2, '17:00'), items: [{ slug: 'haibike-alltrail', size: 'L', qty: 1 }] });
      payFee(r6, { method: 'card', when: at(-5, '08:01') });
      outbox.sendReservationMail(db, { type: 'reminder', reservation: reservations.get(db, r6.id), tenant, settings, fieldCrypto, baseUrl, token: reservations.tokenFor(r6, secret), now: at(-1, '09:00') });

      // 7) potvrzená na zítra (připomínku pošle job): 2× trek + přilby, zaplaceno převodem (spárováno s příchozí platbou)
      const r7 = make({ customer: CUSTOMERS[6], createdAt: at(-4, '17:20'), from: at(1, '09:00'), to: at(3, '17:00'), items: [{ slug: 'trek-fx-2', size: 'S', qty: 1 }, { slug: 'trek-fx-2', size: 'M', qty: 1 }], accessories: [{ slug: 'prilba', qty: 2 }] });
      payFee(r7, { method: 'bank_transfer', when: at(-3, '06:45') });

      // 8) potvrzená za 5 dní: gravel L
      const r8 = make({ customer: CUSTOMERS[7], createdAt: at(-1, '20:05'), from: at(5, '09:00'), to: at(6, '17:00'), items: [{ slug: 'canyon-grail', size: 'L', qty: 1 }] });
      payFee(r8, { method: 'card', when: at(-1, '20:06') });

      // 9) čeká na převod (QR): 2× trekové elektrokolo za 10 dní, platba bank_transfer pending
      const r9 = make({ customer: CUSTOMERS[8], createdAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(), from: at(10, '09:00'), to: at(12, '17:00'), items: [{ slug: 'cube-touring-hybrid', size: 'L', qty: 2 }] });
      reservations.recordPayment(db, { reservationId: r9.id, purpose: 'fee', method: 'bank_transfer', provider: 'fio-mock', amountMinor: r9.fee_minor, status: 'pending', idempotencyKey: `demo:${r9.number}:fee`, vs: r9.number, spayd: spaydFor(r9.fee_minor, r9.number), now: r9.created_at });

      // 10) stornovaná zákazníkem před lhůtou (plná vratka): trek XL za 3 dny
      const r10 = make({ customer: CUSTOMERS[9], createdAt: at(-6, '11:30'), from: at(3, '09:00'), to: at(4, '17:00'), items: [{ slug: 'trek-fx-2', size: 'XL', qty: 1 }] });
      payFee(r10, { method: 'card', when: at(-6, '11:31') });
      reservations.transition(db, r10.id, 'cancel_by_customer', { now: at(-5, '09:12'), settings, mail, ipHash: 'demo' });

      // 11) nevyzvednutá (no-show): horské kolo před 4 dny, poplatek propadl
      const r11 = make({ customer: CUSTOMERS[1], createdAt: at(-9, '15:00'), from: at(-4, '09:00'), to: at(-4, '17:00'), items: [{ slug: 'rockhopper', size: 'M', qty: 1 }] });
      payFee(r11, { method: 'card', when: at(-9, '15:01') });
      reservations.transition(db, r11.id, 'no_show', { now: at(-4, '17:05'), settings });

      // 12) propadlá: převod nedorazil, expirovala před 6 dny
      const r12 = make({ customer: CUSTOMERS[3], createdAt: at(-8, '09:00'), from: at(2, '09:00'), to: at(3, '17:00'), items: [{ slug: 'trek-fx-2', size: 'L', qty: 1 }] });
      reservations.recordPayment(db, { reservationId: r12.id, purpose: 'fee', method: 'bank_transfer', provider: 'fio-mock', amountMinor: r12.fee_minor, status: 'expired', idempotencyKey: `demo:${r12.number}:fee`, vs: r12.number, spayd: spaydFor(r12.fee_minor, r12.number), now: r12.created_at });
      reservations.transition(db, r12.id, 'expire', { now: at(-6, '09:00'), settings });

      summary.reservations = db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n;
      summary.customers = db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
      summary.outbox = db.prepare('SELECT COUNT(*) AS n FROM outbox').get().n;
    }
    // === /REZERVACE ===

    // === PLATBY ===
    // Agent platby: k seedovaným rezervacím doplní SPAYD s datem splatnosti u čekajících převodů, záznamy notifikací
    // simulační brány (webhook_events) k zaplaceným platbám kartou, doklady (zjednodušené daňové doklady k poplatkům,
    // opravný doklad k vratce stornované rezervace, konečné doklady uzavřených rezervací), zápis dokladu totožnosti
    // zákazníkům vydaných rezervací a smlouvy / protokoly (SML- + PP-, VP-) k vydaným, vráceným a uzavřeným rezervacím.
    // Běží jen při --reset nebo do prázdné tabulky documents.
    if (reset || db.prepare('SELECT COUNT(*) AS n FROM documents').get().n === 0) {
      const reservations = require('../src/domain/reservations');
      const documents = require('../src/domain/documents');
      const bank = require('../src/payments/bank-transfer');
      const mockGateway = require('../src/payments/mock-gateway');
      const { getSettings, publicBaseUrl } = require('../src/tenants');
      const settings = getSettings(db, tenant);
      const deps = { tenant, settings, fieldCrypto, now: nowIso(), log: { info() {}, warn() {}, error() {}, debug() {} } };
      const business = tenant.business || {};
      let iban = null;
      try {
        iban = business.iban && bank.validateIban(business.iban) ? business.iban : bank.ibanFromCzAccount(business.accountNumber);
      } catch {
        iban = null;
      }
      // 1) čekající / propadlé převody: SPAYD podle specifikace (vč. DT = expirace rezervace)
      if (iban) {
        for (const p of db.prepare("SELECT p.*, r.expires_at, r.number FROM payments p JOIN reservations r ON r.id = p.reservation_id WHERE p.method = 'bank_transfer' AND p.purpose = 'fee'").all()) {
          const spayd = bank.spayd({ iban, amountMinor: p.amount_minor, vs: p.vs || p.number, msg: `Rezervace ${p.number}`, dueDate: p.expires_at || p.created_at });
          db.prepare('UPDATE payments SET spayd = ? WHERE id = ?').run(spayd, p.id);
        }
      }
      // 2) notifikace simulační brány k zaplaceným / blokovaným platbám kartou (jako po skutečném průchodu bránou)
      const insEvent = db.prepare('INSERT OR IGNORE INTO webhook_events(provider, event_id, payload, received_at, processed_at) VALUES (?, ?, ?, ?, ?)');
      for (const p of db.prepare("SELECT * FROM payments WHERE provider = ? AND status IN ('paid', 'authorized', 'released', 'partially_captured', 'captured', 'refunded')").all(mockGateway.PROVIDER)) {
        const status = ['paid', 'refunded'].includes(p.status) ? 'paid' : 'authorized';
        insEvent.run(mockGateway.PROVIDER, `mock:${p.provider_ref}:${status}`, JSON.stringify({ transId: p.provider_ref, status }), p.updated_at, p.updated_at);
      }
      // 3) doklady k platbám, opravný doklad k vratce, konečné doklady uzavřených rezervací (idempotentně)
      documents.syncAll(db, deps);
      // 4) doklad totožnosti u vydaných / vrácených / uzavřených rezervací: zápis typu a čísla je podmínkou výdeje (SPEC
      //    kap. 0, rozhodnutí 1), proto ho demo zákazníkům těchto rezervací doplní (fiktivní čísla; stejný zápis jako
      //    admin „Zapsat doklad“: typ, šifrované číslo, souhlas při výdeji, výmaz po idDocRetentionDays od vrácení).
      const ID_DOC_TYPES = ['občanský průkaz', 'cestovní pas', 'řidičský průkaz'];
      const retentionDays = Number(settings.idDocRetentionDays) > 0 ? Number(settings.idDocRetentionDays) : 30;
      const issuedReservations = db.prepare("SELECT * FROM reservations WHERE status IN ('checked_out', 'returned', 'closed') ORDER BY id").all();
      const auditAt = (r, action) => {
        const row = db.prepare("SELECT at FROM audit_log WHERE entity = 'reservation' AND entity_id = ? AND action = ? ORDER BY id LIMIT 1").get(String(r.id), action);
        return row ? row.at : null;
      };
      for (const r of issuedReservations) {
        const pickupAt = auditAt(r, 'reservation.check_out') || r.from_at;
        const customer = r.customer_id ? db.prepare('SELECT id, id_doc_type, anonymized_at FROM customers WHERE id = ?').get(r.customer_id) : null;
        if (!customer || customer.anonymized_at || customer.id_doc_type) continue;
        const type = ID_DOC_TYPES[customer.id % ID_DOC_TYPES.length];
        const number = String(100000000 + ((customer.id * 7919 + 4242) % 900000000)); // fiktivní 9-místné číslo
        const deleteAfter = new Date(Math.max(new Date(r.to_at).getTime(), new Date(pickupAt).getTime()) + retentionDays * 86400000).toISOString();
        db.prepare('UPDATE customers SET id_doc_type = ?, id_doc_number_enc = ?, id_doc_consent_at = ?, id_doc_delete_after = ? WHERE id = ?').run(type, fieldCrypto.enc(number), pickupAt, deleteAfter, customer.id);
        db.prepare('INSERT INTO audit_log(at, user_id, action, entity, entity_id, meta, ip_hash) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(pickupAt, summary.adminId, 'customer.id_doc_recorded', 'customer', String(customer.id), JSON.stringify({ reservationId: r.id, type, deleteAfter, demo: true }));
      }
      // 5) smlouva + předávací protokol (SML- a PP-) u vydaných / vrácených / uzavřených rezervací, protokol o vrácení (VP-)
      //    u vrácených / uzavřených; údaje (kola s výrobním číslem, kauce, škoda, čísla dokladů) dopočítá documents.contractParams
      const operator = { id: summary.adminId, name: 'Správce D.' };
      for (const r of issuedReservations) {
        const detail = reservations.loadDetail(db, r);
        const bikes = detail.itemRows.map((row) => ({ itemId: row.id, bikeId: row.bike_id }));
        const ebike = detail.itemRows.some((row) => row.category === 'ebike');
        documents.issueContract(db, { reservation: r, kind: 'contract', tenant, settings, fieldCrypto, operator, bikes, legal: ebike ? { KOLO_BATERIE_PROCENTA: '100' } : {}, now: auditAt(r, 'reservation.check_out') || r.from_at });
        if (r.status === 'returned' || r.status === 'closed') {
          documents.issueContract(db, { reservation: r, kind: 'return_protocol', tenant, settings, fieldCrypto, operator, bikes, legal: ebike ? { KOLO_VRACENI_BATERIE_PROCENTA: '40' } : {}, now: auditAt(r, 'reservation.return') || r.to_at });
        }
      }
      summary.payments = db.prepare('SELECT COUNT(*) AS n FROM payments').get().n;
      summary.documents = db.prepare('SELECT COUNT(*) AS n FROM documents').get().n;
      summary.webhookEvents = db.prepare('SELECT COUNT(*) AS n FROM webhook_events').get().n;
    }
    // === /PLATBY ===
  });
  log.info('Demo data naplněna', summary);
  return summary;
}

async function main(argv) {
  const reset = argv.includes('--reset');
  const tIdx = argv.indexOf('--tenant');
  const only = tIdx >= 0 ? argv[tIdx + 1] : null;
  const config = loadConfig(process.env);
  const secret = ensureSecret(config);
  const fieldCrypto = createFieldCrypto(secret);
  const tenants = loadTenants(config.tenantsDir).filter((t) => !only || t.slug === only);
  if (!tenants.length) throw new Error(only ? `Tenant „${only}“ nenalezen.` : 'Žádný tenant.');
  for (const tenant of tenants) {
    const db = openTenantDb(tenant.slug, config.dataDir);
    try {
      await seed({ db, tenant, config, fieldCrypto, reset });
      console.log(`Tenant ${tenant.slug}: demo data ${reset ? 'resetována a ' : ''}naplněna (${path.join(config.dataDir, 'tenants', tenant.slug + '.db')}).`);
      console.log(`Admin: ${config.adminUser} / ${config.adminPassword || '(heslo z PK_ADMIN_PASSWORD)'}`);
    } finally {
      db.close();
    }
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('Chyba:', e.message);
    process.exit(1);
  });
}

module.exports = { seed, seedAdmin, resetAll, RESET_TABLES };
