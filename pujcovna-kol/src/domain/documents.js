'use strict';
// Doklady (SPEC kap. 9 a 10, rozhodnutí zadavatele 3): číselné řady per typ a rok, HTML dokladů s tiskovým CSS
// (/css/doklady.css), uložení do tabulky documents.
//   issue(db, type, reservation, data) → { id, number, type, html, issuedAt }
//       type: receipt (PD-) doklad o přijaté platbě u neplátce · simplified_tax_doc (ZDD-) zjednodušený daňový doklad
//       § 30 ZDPH (plátce, platba ≤ 10 000 Kč, bez identifikace zákazníka) · tax_doc (DD-) daňový doklad · final_doc (KD-)
//       konečný doklad / vyúčtování se započtením poplatku a rozpisem DPH · credit_note (OD-) opravný doklad k vratce ·
//       contract (SML-) smlouva + předávací protokol (ČÁST A + B; zároveň vystaví i samostatný handover) · handover (PP-)
//       předávací protokol (ČÁST B) · return_protocol (VP-) protokol o vrácení (ČÁST C) – tři poslední přes
//       require('../features/pravni').renderLegal(...) ze šablony legal/smlouva-o-najmu-a-predavaci-protokol.md; údaje
//       rezervace dopočítává contractParams() (kola s dešifrovaným výrobním číslem, kauce, vyúčtování, čísla souvisejících
//       dokladů), nic nezůstává „…………“ – chybějící údaj je „neuvedeno“, pozdější „doplní se“.
//       data: { tenant, settings, now, payment, items, customer: { name, address, email, phone, idDocType, idDocNumberMasked,
//              refundAccount }, note, refDocument, fieldCrypto, legal: { …přepisy placeholderů, KOLA?: [záznam per kolo] },
//              bikes: [{ itemId, bikeId, frameNo? }], operator: { id, name }, numbers: { contract, return_protocol, final_doc },
//              handover: false } – podle typu (viz jednotlivé buildery).
//   paymentDocType({ tenant, amountMinor }) → 'simplified_tax_doc' | 'tax_doc' | 'receipt'
//   issueForPayment(db, { reservation, payment, tenant, settings, fieldCrypto, now })  – doklad k přijaté platbě (idempotentní
//       podle payments.id), issueFinal(db, …) – konečný doklad po uzavření, issueCreditNote(db, { reservation, refundPayment, … }),
//       issueContract(db, { reservation, kind, customer, operator, bikes, … }) – smlouva / protokoly
//   syncReservation(db, reservationId, deps) – doplní chybějící doklady (platby poplatku/doplatku, vratky, konečný doklad)
//   syncAll(db, deps) – totéž pro všechny rezervace (job), get(db, number), listFor(db, reservationId), wrapPrint(html, opts)
//   vatSplit(amountMinor, rate) → { baseMinor, vatMinor, totalMinor }  (daň shora, § 37 odst. 2 ZDPH; zaokrouhlení na haléře)
// Peníze v haléřích, časy ISO UTC; HTML výhradně přes html`` (escapování). Uložené html je fragment <article class="doc">,
// wrapPrint() z něj udělá samostatnou tiskovou stránku. Nikdy nelogovat údaje zákazníka.

const { nowIso, parseJson } = require('../db');
const { html, raw, joinHtml } = require('../render/html');
const format = require('../render/format');
const ledger = require('../payments/ledger');

const TYPES = Object.freeze(['receipt', 'simplified_tax_doc', 'tax_doc', 'final_doc', 'credit_note', 'contract', 'handover', 'return_protocol']);

const PREFIXES = Object.freeze({
  receipt: 'PD',
  simplified_tax_doc: 'ZDD',
  tax_doc: 'DD',
  final_doc: 'KD',
  credit_note: 'OD',
  contract: 'SML',
  handover: 'PP',
  return_protocol: 'VP',
});

const LABELS = Object.freeze({
  receipt: 'Doklad o přijaté platbě',
  simplified_tax_doc: 'Zjednodušený daňový doklad',
  tax_doc: 'Daňový doklad',
  final_doc: 'Konečný daňový doklad – vyúčtování',
  credit_note: 'Opravný daňový doklad',
  contract: 'Smlouva o nájmu jízdního kola a předávací protokol',
  handover: 'Předávací protokol',
  return_protocol: 'Protokol o vrácení',
});

const PURPOSE_LABELS = Object.freeze({ fee: 'Rezervační poplatek', balance: 'Doplatek nájemného', deposit_hold: 'Kauce', refund: 'Vratka' });
const METHOD_LABELS = Object.freeze({ card: 'platební kartou online', bank_transfer: 'bankovním převodem', cash: 'hotově', terminal: 'platební kartou (terminál)' });

const SIMPLIFIED_LIMIT_MINOR = 10000 * 100; // § 30 ZDPH: zjednodušený daňový doklad do 10 000 Kč včetně
const DEFAULT_VAT_RATE = 21;
const BLANK = '…………';

class DocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentError';
  }
}

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

function iso(value) {
  if (value instanceof Date) return value.toISOString();
  if (value) return new Date(value).toISOString();
  return nowIso();
}

function pragueYear(isoStr) {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric' }).format(new Date(isoStr)));
}

/** Spustí fn v transakci, pokud už jedna neběží (node:sqlite neumí vnořené BEGIN). */
function inTransaction(db, fn) {
  if (db.isTransaction) return fn(db);
  const { transaction } = require('../db');
  return transaction(db, fn);
}

/** Další číslo řady: <PREFIX>-<rok>-<6 číslic>. Volat v transakci. */
function nextNumber(db, type, now = nowIso()) {
  const prefix = PREFIXES[type];
  if (!prefix) throw new DocumentError(`Neznámý typ dokladu „${type}“.`);
  const year = pragueYear(now);
  const like = `${prefix}-${year}-%`;
  const last = db.prepare('SELECT number FROM documents WHERE number LIKE ? ORDER BY number DESC LIMIT 1').get(like);
  const seq = last ? Number(String(last.number).slice(prefix.length + 6)) + 1 : 1;
  if (!Number.isFinite(seq) || seq > 999999) throw new DocumentError(`Vyčerpána číselná řada ${prefix}-${year}.`);
  return `${prefix}-${year}-${String(seq).padStart(6, '0')}`;
}

function vatRate(settings) {
  const v = settings && settings.vatRate !== undefined ? Number(settings.vatRate) : DEFAULT_VAT_RATE;
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_VAT_RATE;
}

/** Daň „shora“ z částky včetně DPH (§ 37 odst. 2 ZDPH); záporné částky (opravný doklad) zachovají znaménko. */
function vatSplit(amountMinor, rate = DEFAULT_VAT_RATE) {
  const total = Math.round(Number(amountMinor) || 0);
  const base = Math.round(total / (1 + rate / 100));
  return { baseMinor: base, vatMinor: total - base, totalMinor: total, rate };
}

/** Typ dokladu k přijaté platbě podle plátcovství a výše (rozhodnutí 3). */
function paymentDocType({ tenant, amountMinor }) {
  const vat = !!(tenant && tenant.business && tenant.business.vatPayer);
  if (!vat) return 'receipt';
  return Math.abs(Math.round(Number(amountMinor) || 0)) <= SIMPLIFIED_LIMIT_MINOR ? 'simplified_tax_doc' : 'tax_doc';
}

function loadItems(db, reservationId) {
  const { loadItems: load } = require('../mail/outbox');
  return load(db, reservationId);
}

/** Dešifruje jméno (a e-mail/telefon) zákazníka – jen do paměti pro doklad s identifikací. */
function customerOf(db, reservation, fieldCrypto) {
  if (!reservation.customer_id || !fieldCrypto) return null;
  const c = db.prepare('SELECT name_enc, email_enc, phone_enc, address_enc, id_doc_type, id_doc_number_enc, anonymized_at FROM customers WHERE id = ?').get(reservation.customer_id);
  if (!c || c.anonymized_at) return null;
  const dec = (v) => {
    try {
      return v ? fieldCrypto.dec(v) : '';
    } catch {
      return '';
    }
  };
  const docNumber = dec(c.id_doc_number_enc);
  return { name: dec(c.name_enc), email: dec(c.email_enc), phone: dec(c.phone_enc), address: dec(c.address_enc), idDocType: c.id_doc_type || '', idDocNumberMasked: docNumber ? `•••••${docNumber.slice(-3)}` : '' };
}

function supplier(tenant) {
  const b = (tenant && tenant.business) || {};
  return { name: b.legalName || (tenant && tenant.name) || '', address: b.address || '', ico: b.ico || '', dic: b.dic || '', vatPayer: !!b.vatPayer, email: b.email || '', phone: b.phone || '', iban: b.iban || '', accountNumber: b.accountNumber || '', bankName: b.bankName || '' };
}

// ---------------------------------------------------------------------------------------------------------
// Render dokladů (HTML fragment)

function head({ type, number, tenant, issuedAt, taxDate, meta = [], customer = null, customerRequired = false }) {
  const s = supplier(tenant);
  const rows = [
    ['Datum vystavení', format.date(issuedAt)],
    taxDate ? ['Datum uskutečnění plnění / přijetí platby', format.date(taxDate)] : null,
    ...meta,
  ].filter(Boolean);
  return html`<header class="doc__head">
  <div class="doc__title-block">
    <p class="doc__kind">${LABELS[type]}</p>
    <h1 class="doc__title">č. ${number}</h1>
  </div>
  <div class="doc__parties">
    <div class="doc__party doc__party--supplier">
      <p class="doc__party-label">Dodavatel</p>
      <p><strong>${s.name}</strong>${s.address ? html`<br>${s.address}` : ''}${s.ico ? html`<br>IČO ${s.ico}` : ''}${s.vatPayer && s.dic ? html`<br>DIČ ${s.dic}` : ''}</p>
      <p class="doc__vat-status">${s.vatPayer ? 'Plátce DPH' : 'Nejsme plátci DPH'}</p>
      ${s.email || s.phone ? html`<p class="doc__contact">${[s.email, s.phone].filter(Boolean).join(' · ')}</p>` : ''}
    </div>
    ${customerRequired
      ? html`<div class="doc__party doc__party--customer">
      <p class="doc__party-label">Odběratel</p>
      <p>${customer && customer.name ? html`<strong>${customer.name}</strong>` : html`<em>neuvedeno</em>`}${customer && customer.address ? html`<br>${customer.address}` : ''}</p>
    </div>`
      : html`<div class="doc__party doc__party--note"><p class="doc__party-label">Odběratel</p><p><em>Zjednodušený daňový doklad se podle § 30 zákona č. 235/2004 Sb. vystavuje bez identifikace odběratele.</em></p></div>`}
  </div>
  <dl class="doc__meta">${rows.map((r) => html`<div><dt>${r[0]}</dt><dd>${r[1]}</dd></div>`)}</dl>
</header>`;
}

function itemsTable(items) {
  return html`<table class="doc__items table">
  <thead><tr><th scope="col">Položka</th><th scope="col" class="is-right">Množství</th><th scope="col" class="is-right">Cena za jednotku</th><th scope="col" class="is-right">Celkem</th></tr></thead>
  <tbody>${items.map(
    (it) => html`<tr${it.negative ? raw(' class="doc__item--negative"') : ''}><td>${it.label}${it.note ? html`<br><small class="doc__item-note">${it.note}</small>` : ''}</td><td class="is-right">${it.qty !== undefined && it.qty !== null ? `${it.qty} ${it.unit || 'ks'}` : ''}</td><td class="is-right">${it.unitMinor !== undefined && it.unitMinor !== null ? format.money(it.unitMinor) : ''}</td><td class="is-right">${format.money(it.amountMinor)}</td></tr>`
  )}</tbody>
</table>`;
}

function vatTable({ vatPayer, lines, rate }) {
  if (!vatPayer) return html`<p class="doc__novat">Dodavatel není plátcem DPH; částky jsou konečné.</p>`;
  const taxable = lines.filter((l) => l.vat !== false);
  const exempt = lines.filter((l) => l.vat === false);
  const total = taxable.reduce((a, l) => a + l.amountMinor, 0);
  const split = vatSplit(total, rate);
  return html`<table class="doc__vat table">
  <thead><tr><th scope="col">Rekapitulace DPH</th><th scope="col" class="is-right">Základ daně</th><th scope="col" class="is-right">Sazba</th><th scope="col" class="is-right">DPH</th><th scope="col" class="is-right">Celkem vč. DPH</th></tr></thead>
  <tbody>
    <tr><td>Zdanitelná plnění</td><td class="is-right">${format.money(split.baseMinor)}</td><td class="is-right">${rate} %</td><td class="is-right">${format.money(split.vatMinor)}</td><td class="is-right">${format.money(split.totalMinor)}</td></tr>
    ${exempt.length ? html`<tr><td>Mimo předmět DPH (náhrada škody, smluvní pokuta – § 2 odst. 1 ZDPH)</td><td class="is-right">–</td><td class="is-right">–</td><td class="is-right">–</td><td class="is-right">${format.money(exempt.reduce((a, l) => a + l.amountMinor, 0))}</td></tr>` : ''}
  </tbody>
</table>
<p class="doc__vat-note">Daň vypočtena z částky včetně daně podle § 37 odst. 2 zákona č. 235/2004 Sb., o DPH.</p>`;
}

function article(type, number, inner) {
  return html`<article class="doc doc--${type}" data-number="${number}">${inner}<footer class="doc__foot"><p>Doklad byl vystaven elektronicky a je platný bez podpisu a razítka. Vygenerováno rezervačním systémem půjčovny.</p></footer></article>`.toString();
}

/** Doklad o přijaté platbě (receipt / simplified_tax_doc / tax_doc). */
function renderPaymentDoc({ type, number, reservation, payment, items, tenant, settings, issuedAt, customer }) {
  const s = supplier(tenant);
  const rate = vatRate(settings);
  const amount = Math.round(Number(payment.captured_minor) > 0 && payment.status === 'paid' ? Number(payment.captured_minor) : Number(payment.amount_minor));
  const purpose = payment.purpose === 'balance' ? 'balance' : 'fee';
  const lines = [];
  if (purpose === 'fee') {
    const perBike = items.items.length ? items.items : [{ typeName: 'kolo', size: '', qty: 1, feeMinor: amount }];
    const feeSum = perBike.reduce((a, it) => a + Number(it.feeMinor || 0), 0);
    for (const it of perBike) {
      const fee = Number(it.feeMinor || 0);
      lines.push({ label: `Rezervační poplatek – zajištění rezervace č. ${reservation.number}: ${it.typeName}${it.size ? ` (vel. ${it.size})` : ''}`, qty: it.qty, unitMinor: it.qty ? Math.round(fee / it.qty) : fee, amountMinor: fee });
    }
    if (feeSum !== amount) lines.push({ label: feeSum < amount ? 'Přeplatek rezervačního poplatku – kredit k započtení na nájemné' : 'Rozdíl oproti rozpisu poplatku', amountMinor: amount - feeSum });
  } else {
    lines.push({ label: `Doplatek nájemného k rezervaci č. ${reservation.number} (${format.dateTime(reservation.from_at)} – ${format.dateTime(reservation.to_at)})`, qty: 1, unitMinor: amount, amountMinor: amount });
  }
  const meta = [
    ['Forma úhrady', METHOD_LABELS[payment.method] || payment.method],
    ['Variabilní symbol', payment.vs || reservation.number],
    ['Rezervace', `č. ${reservation.number}, termín ${format.dateTime(reservation.from_at)} – ${format.dateTime(reservation.to_at)}`],
    payment.provider_ref && payment.method === 'card' ? ['Reference platby', payment.provider_ref] : null,
  ].filter(Boolean);
  const inner = html`${head({ type, number, tenant, issuedAt, taxDate: payment.updated_at || issuedAt, meta, customer, customerRequired: type === 'tax_doc' })}
<section class="doc__body">
  ${itemsTable(lines)}
  ${vatTable({ vatPayer: s.vatPayer, lines, rate })}
  <p class="doc__total"><span>Přijatá platba celkem</span><strong>${format.money(amount)}</strong></p>
  <p class="doc__note">${purpose === 'fee' ? 'Rezervační poplatek je úplatou za zajištění služby (blokaci kol na termín) a při řádném využití rezervace se v plné výši započítává na nájemné; při zrušení po storno lhůtě nebo nevyzvednutí propadá (Obchodní podmínky čl. 4 a 6).' : 'Doplatek nájemného; konečné vyúčtování vystavíme po vrácení kol.'}${s.vatPayer ? ' Doklad k přijaté úplatě podle § 28 odst. 8 zákona o DPH.' : ''}</p>
</section>`;
  return article(type, number, inner);
}

/** Konečný doklad (vyúčtování) po uzavření rezervace: položky, započtení poplatku, DPH, saldo. */
function renderFinalDoc({ number, reservation, items, tenant, settings, issuedAt, customer, bal, ledgerRows, feeDocs }) {
  const s = supplier(tenant);
  const rate = vatRate(settings);
  const lines = [];
  for (const it of items.items) lines.push({ label: `Nájem: ${it.typeName}${it.size ? ` (vel. ${it.size})` : ''}, ${format.dateTime(reservation.from_at)} – ${format.dateTime(reservation.to_at)}`, qty: it.qty, unitMinor: it.unitPriceMinor, amountMinor: it.amountMinor });
  for (const a of items.accessories) lines.push({ label: `Příslušenství: ${a.label}`, qty: a.qty, unitMinor: a.qty ? Math.round(a.amountMinor / a.qty) : a.amountMinor, amountMinor: a.amountMinor });
  const rentalSum = lines.reduce((acc, l) => acc + l.amountMinor, 0);
  if (rentalSum !== Number(reservation.total_minor)) lines.push({ label: 'Úprava ceny (sleva / zaokrouhlení)', amountMinor: Number(reservation.total_minor) - rentalSum });
  const damage = ledgerRows.filter((l) => l.type === 'damage');
  for (const d of damage) lines.push({ label: `Náhrada škody: ${d.note || 'poškození při vrácení'}`, amountMinor: Number(d.amount_minor), vat: false });
  const feePaid = bal.feePaidMinor;
  const advanceLines = feePaid > 0 ? [{ label: `Započtení rezervačního poplatku${feeDocs.length ? ` (doklad č. ${feeDocs.map((d) => d.number).join(', ')})` : ''}`, amountMinor: -feePaid, negative: true }] : [];
  const balancePaid = bal.balancePaidMinor;
  const captured = bal.depositCapturedMinor;
  const totalDue = Number(reservation.total_minor) + bal.damageMinor;
  const remaining = totalDue - feePaid - balancePaid - captured + bal.refundedMinor;
  const meta = [
    ['Rezervace', `č. ${reservation.number}`],
    ['Doba nájmu', `${format.dateTime(reservation.from_at)} – ${format.dateTime(reservation.to_at)}`],
    ['Variabilní symbol', reservation.number],
  ];
  const inner = html`${head({ type: 'final_doc', number, tenant, issuedAt, taxDate: reservation.updated_at || issuedAt, meta, customer, customerRequired: true })}
<section class="doc__body">
  ${itemsTable([...lines, ...advanceLines])}
  ${vatTable({ vatPayer: s.vatPayer, lines: [...lines, ...advanceLines], rate })}
  ${s.vatPayer && feePaid > 0 ? html`<p class="doc__vat-note">Základ daně a daň jsou sníženy o základ daně a daň z přijatého rezervačního poplatku (§ 37a zákona o DPH): nájemné celkem základ ${format.money(vatSplit(rentalSum, rate).baseMinor)} + DPH ${format.money(vatSplit(rentalSum, rate).vatMinor)}, započtený poplatek základ ${format.money(vatSplit(feePaid, rate).baseMinor)} + DPH ${format.money(vatSplit(feePaid, rate).vatMinor)}.</p>` : ''}
  <dl class="doc__settlement">
    <div><dt>Cena nájmu celkem</dt><dd>${format.money(reservation.total_minor)}</dd></div>
    ${bal.damageMinor > 0 ? html`<div><dt>Náhrada škody</dt><dd>${format.money(bal.damageMinor)}</dd></div>` : ''}
    <div><dt>Započtený rezervační poplatek</dt><dd>− ${format.money(feePaid)}</dd></div>
    ${balancePaid > 0 ? html`<div><dt>Uhrazený doplatek</dt><dd>− ${format.money(balancePaid)}</dd></div>` : ''}
    ${captured > 0 ? html`<div><dt>Strženo z kauce</dt><dd>− ${format.money(captured)}</dd></div>` : ''}
    ${bal.refundedMinor > 0 ? html`<div><dt>Vráceno</dt><dd>+ ${format.money(bal.refundedMinor)}</dd></div>` : ''}
    <div class="doc__settlement-total"><dt>${remaining > 0 ? 'Zbývá uhradit' : remaining < 0 ? 'Přeplatek k vrácení' : 'Uhrazeno v plné výši'}</dt><dd>${format.money(Math.abs(remaining))}</dd></div>
  </dl>
  ${bal.depositHeldMinor > 0 ? html`<p class="doc__note">Kauce ${format.money(bal.depositHeldMinor)}: strženo ${format.money(captured)}, uvolněno ${format.money(bal.depositReleasedMinor)}. Kauce není úplatou za plnění a nepodléhá DPH.</p>` : ''}
</section>`;
  return article('final_doc', number, inner);
}

/** Opravný daňový doklad k vratce rezervačního poplatku (storno). */
function renderCreditNote({ number, reservation, refund, tenant, settings, issuedAt, customer, refDocument, reason }) {
  const s = supplier(tenant);
  const rate = vatRate(settings);
  const amount = -Math.abs(Math.round(Number(refund.amount_minor)));
  const lines = [{ label: `Vrácení rezervačního poplatku k rezervaci č. ${reservation.number}${reason ? ` – ${reason}` : ''}`, qty: 1, unitMinor: amount, amountMinor: amount, negative: true }];
  const meta = [
    ['Opravovaný doklad', refDocument ? `č. ${refDocument.number} ze dne ${format.date(refDocument.issued_at)}` : 'doklad k rezervačnímu poplatku'],
    ['Důvod opravy', reason || 'zrušení rezervace – vrácení rezervačního poplatku (§ 42 zákona o DPH)'],
    ['Forma vratky', METHOD_LABELS[refund.method] || refund.method],
    ['Variabilní symbol', refund.vs || reservation.number],
  ];
  const inner = html`${head({ type: 'credit_note', number, tenant, issuedAt, taxDate: refund.updated_at || issuedAt, meta, customer, customerRequired: !!(refDocument && refDocument.type === 'tax_doc') })}
<section class="doc__body">
  ${itemsTable(lines)}
  ${vatTable({ vatPayer: s.vatPayer, lines, rate })}
  <p class="doc__total"><span>Vráceno celkem</span><strong>${format.money(Math.abs(amount))}</strong></p>
  <p class="doc__note">${refund.status === 'refunded' ? 'Vratka byla odeslána původní platební metodou.' : 'Vratka bude odeslána převodem; částka se připíše podle vaší banky obvykle do 5 pracovních dnů.'}</p>
</section>`;
  return article('credit_note', number, inner);
}

// ---------------------------------------------------------------------------------------------------------
// Smlouva a protokoly (legal/smlouva-o-najmu-a-predavaci-protokol.md)

// Které části šablony se tisknou: smlouva = ČÁST A + B (protokol o vrácení C se tiskne až při vrácení jako samostatný
// doklad VP-, část D je interní), předávací protokol = ČÁST B, protokol o vrácení = ČÁST C.
const CONTRACT_SECTIONS = Object.freeze({
  contract: { omitHeadings: [/^ČÁST C/, /^C\.\d/, /^ČÁST D/, /^D\.\d/] },
  handover: { only: [/^ČÁST B/, /^B\.\d/] },
  return_protocol: { only: [/^ČÁST C/, /^C\.\d/] },
});

// Texty místo „…………“ pro údaje, které se doplní později nebo nejsou k dispozici (QA: doklady nemají působit nedokončeně).
const LATER = 'doplní se';
const NOT_GIVEN = 'neuvedeno';
const NONE = '–';
const HANDWRITTEN = '____'; // pole vyplňované obsluhou rukou na vytištěném protokolu (např. % nabití baterie)

const DEPOSIT_FORM_LABELS = Object.freeze({ cash: 'hotově', terminal: 'terminál', card: 'preautorizace kartou' });
const DEPOSIT_RETURN_LABELS = Object.freeze({ cash: 'hotově na místě', terminal: 'zpět na tutéž kartu přes terminál', card: 'uvolnění preautorizace' });

/** Spojí hodnoty kol do jedné buňky (zpětně kompatibilní tvar bez cyklu {{#KOLA}}). */
function joinOr(list, fallback) {
  const arr = list.filter((v) => v !== null && v !== undefined && String(v) !== '');
  return arr.length ? arr.join('; ') : fallback;
}

/** Hodnota z `extra`, která skutečně něco říká ('…………' a '' = nevyplněno). */
function given(value) {
  if (value === null || value === undefined) return false;
  const s = String(value).trim();
  return s !== '' && s !== BLANK;
}

function cleanExtra(extra) {
  const out = {};
  for (const [k, v] of Object.entries(extra || {})) if (Array.isArray(v) || typeof v === 'object' ? v !== null : given(v)) out[k] = v;
  return out;
}

/** Zpoždění vrácení po odečtení tolerance (minuty) – text pro C.1. */
function lateText(reservation, now, settings) {
  const tolerance = Number(settings && settings.lateToleranceMinutes);
  const tol = Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 30;
  const minutes = Math.floor((new Date(now).getTime() - new Date(reservation.to_at).getTime()) / 60000) - tol;
  return minutes > 0 ? `${format.plural(minutes, 'minuta', 'minuty', 'minut')} (zaokrouhleno na celé minuty)` : 'včas (0 min)';
}

/**
 * Slovník údajů rezervace pro šablonu smlouvy (klíče podle tabulky Parametry šablony). Co lze, dopočítá z DB (položky,
 * kusy včetně dešifrovaného výrobního čísla, ledger, platby, už vystavené doklady); customer/operator/bikes/extra předává
 * admin nebo demo data a mají přednost. Údaje, které se doplní později, dostanou text „doplní se“, neznámé „neuvedeno“;
 * „…………“ se v hotovém dokladu nevyskytuje. Vrací { params, bikes, items }; params.KOLA je pole záznamů KOLO_* pro
 * cyklus {{#KOLA}}…{{/KOLA}} (řádky B.1, B.2, C.2 a tabulka B.3 pro každé kolo).
 */
function contractParams(db, { reservation, tenant, settings, customer, operator, bikes, extra = {}, now = nowIso(), numbers = {}, fieldCrypto = null, kind = 'contract' }) {
  const items = loadItems(db, reservation.id);
  const bal = ledger.balance(db, reservation.id);
  const feePaid = bal.feePaidMinor;
  const due = Math.max(0, Number(reservation.total_minor) - feePaid - bal.balancePaidMinor);
  const feeDoc = db.prepare("SELECT number FROM documents WHERE reservation_id = ? AND type IN ('receipt','simplified_tax_doc','tax_doc') AND json_extract(data, '$.purpose') = 'fee' ORDER BY id LIMIT 1").get(reservation.id);
  const feeLedger = db.prepare("SELECT created_at FROM ledger_entries WHERE reservation_id = ? AND type = 'fee_paid' ORDER BY id LIMIT 1").get(reservation.id);
  const hold = db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'deposit_hold' ORDER BY id DESC LIMIT 1").get(reservation.id);
  const damageRows = db.prepare("SELECT amount_minor, note FROM ledger_entries WHERE reservation_id = ? AND type = 'damage' ORDER BY id").all(reservation.id);
  const docNumber = (type) => {
    const d = db.prepare('SELECT number FROM documents WHERE reservation_id = ? AND type = ? ORDER BY id DESC LIMIT 1').get(reservation.id, type);
    return d ? d.number : null;
  };
  const dec = (value) => {
    if (!value || !fieldCrypto) return '';
    try {
      return fieldCrypto.dec(value) || '';
    } catch {
      return '';
    }
  };
  const ex = cleanExtra(extra);
  const exBikes = Array.isArray(ex.KOLA) ? ex.KOLA : null;

  // --- kola -------------------------------------------------------------------------------------------------
  const rowsById = new Map(items.rows.map((r) => [r.id, r]));
  const bikeList = (bikes && bikes.length ? bikes : items.rows.map((r) => ({ itemId: r.id, bikeId: r.bike_id }))).map((b, i) => {
    const row = rowsById.get(Number(b.itemId)) || items.rows[i] || {};
    const bike = b.bikeId ? db.prepare('SELECT b.*, t.name AS type_name, t.category, t.value_minor, t.deposit_minor FROM bikes b JOIN bike_types t ON t.id = b.bike_type_id WHERE b.id = ?').get(Number(b.bikeId)) : null;
    const type = row.bike_type_id ? db.prepare('SELECT name, category, value_minor, deposit_minor FROM bike_types WHERE id = ?').get(row.bike_type_id) : null;
    return {
      order: i + 1,
      type: (bike && bike.type_name) || (type && type.name) || row.type_name || NOT_GIVEN,
      ebike: ((bike && bike.category) || (type && type.category) || row.category) === 'ebike',
      code: bike ? bike.inventory_code : b.inventoryCode || LATER,
      size: row.size || (bike && bike.size) || NOT_GIVEN,
      frameNo: b.frameNo || (bike ? dec(bike.frame_no_enc) : '') || NOT_GIVEN,
      value: format.money((bike && bike.value_minor) || (type && type.value_minor) || 0),
      deposit: format.money((bike && bike.deposit_minor) || (type && type.deposit_minor) || 0),
    };
  });
  // zámek dostává každé kolo vždy; ostatní příslušenství rezervace se vypíše u prvního kola
  const otherAccessories = items.accessories.filter((a) => !/z[aá]mek/i.test(`${a.slug || ''} ${a.label || ''}`));
  const accessoriesText = otherAccessories.length ? `zámek s 2 klíči, ${otherAccessories.map((a) => `${a.qty}× ${a.label}`).join(', ')}` : 'zámek s 2 klíči';

  // --- kauce a vyúčtování ------------------------------------------------------------------------------------
  const depositMethod = reservation.deposit_method || (hold ? hold.method : null);
  const depositMinor = Number(reservation.deposit_minor) || (hold ? Number(hold.amount_minor) : 0);
  const damageMinor = damageRows.reduce((a, d) => a + Number(d.amount_minor), 0);
  const damageNote = damageRows.map((d) => d.note).filter(Boolean).join('; ');
  const closed = reservation.status === 'closed';
  const usedMinor = closed ? bal.depositCapturedMinor : Math.min(damageMinor, depositMinor);
  const returnedMinor = closed ? bal.depositReleasedMinor : Math.max(0, depositMinor - usedMinor);
  const preauthRef = hold && hold.method === 'card' ? hold.provider_ref || null : null;
  const preauthUntil = hold && hold.method === 'card' ? format.dateTime(new Date(new Date(hold.created_at).getTime() + (Number(settings && settings.preauthMaxDays) || 7) * 86400000)) : null;
  const returnForm = depositMethod ? `${DEPOSIT_RETURN_LABELS[depositMethod] || depositMethod}${depositMethod === 'card' && preauthRef ? ` (ref. ${preauthRef})` : ''}` : NONE;
  const c = customer || {};
  const refundAccount = c.refundAccount || (depositMethod === 'cash' ? 'doplní nájemce' : NONE);
  const operatorName = (operator && operator.name) || LATER;

  const contractNumber = numbers.contract || (kind === 'contract' ? null : docNumber('contract')) || LATER;
  const returnNumber = numbers.return_protocol || (kind === 'return_protocol' ? null : docNumber('return_protocol')) || `${LATER} při vrácení`;
  const finalNumber = numbers.final_doc || docNumber('final_doc') || (closed ? LATER : '(vystaví se při uzavření rezervace)');

  const out = {
    SMLOUVA_CISLO: contractNumber,
    PROTOKOL_VRACENI_CISLO: returnNumber,
    KONECNY_DOKLAD_CISLO: finalNumber,
    DOKLAD_POPLATEK_CISLO: feeDoc ? feeDoc.number : feePaid > 0 ? LATER : 'poplatek nebyl hrazen předem',
    REZERVACE_CISLO: reservation.number,
    REZERVACE_DATUM: format.dateTime(reservation.created_at),
    REZERVACE_POTVRZENI_DATUM: feeLedger ? format.dateTime(feeLedger.created_at) : format.dateTime(reservation.created_at),
    NAJEM_OD: format.dateTime(reservation.from_at),
    NAJEM_DO: format.dateTime(reservation.to_at),
    CENA_CELKEM: format.money(reservation.total_minor),
    POPLATEK_ZAPLACENO: format.money(feePaid),
    POPLATEK_ZAPLACENO_DNE: feeLedger ? format.date(feeLedger.created_at) : NONE,
    DOPLATEK: format.money(Math.max(0, Number(reservation.total_minor) - feePaid)),
    DOPLATEK_STAV: bal.balancePaidMinor > 0 ? `zaplacen ${format.money(bal.balancePaidMinor)}` : due > 0 ? 'k úhradě při převzetí' : 'bez doplatku',
    K_UHRADE_PRI_PREVZETI: format.money(due),
    KAUCE_CELKEM: format.money(depositMinor),
    NAJEMCE_JMENO: c.name || NOT_GIVEN,
    NAJEMCE_TELEFON: c.phone || NOT_GIVEN,
    NAJEMCE_EMAIL: c.email || NOT_GIVEN,
    NAJEMCE_DOKLAD_TYP: c.idDocType || NOT_GIVEN,
    NAJEMCE_DOKLAD_CISLO_TISK: c.idDocNumberMasked || NOT_GIVEN,
    NAJEMCE_UCET_VRATKA: refundAccount,
    // sloučené hodnoty kol (když šablona nepoužije cyklus {{#KOLA}})
    KOLO_PORADI: bikeList.length ? bikeList.map((b) => b.order).join(' / ') : '1',
    KOLO_TYP: joinOr(bikeList.map((b) => `${b.order}. ${b.type}`), NOT_GIVEN),
    KOLO_JE_EKOLO: bikeList.some((b) => b.ebike) ? 'ano' : 'ne',
    KOLO_INVENTARNI_KOD: joinOr(bikeList.map((b) => b.code), LATER),
    KOLO_VELIKOST: joinOr(bikeList.map((b) => b.size), NOT_GIVEN),
    KOLO_VYROBNI_CISLO: joinOr(bikeList.map((b) => b.frameNo), NOT_GIVEN),
    KOLO_HODNOTA: joinOr(bikeList.map((b) => b.value), NOT_GIVEN),
    KOLO_KAUCE: joinOr(bikeList.map((b) => b.deposit), NOT_GIVEN),
    KOLO_PRISLUSENSTVI: accessoriesText,
    KOLO_BATERIE_PROCENTA: bikeList.some((b) => b.ebike) ? HANDWRITTEN : NONE,
    KOLO_VRACENI_STAV: damageMinor > 0 ? 'poškozeno' : 'v pořádku',
    KOLO_VRACENI_POSKOZENI: damageMinor > 0 ? damageNote || 'poškození při vrácení' : 'bez nového poškození',
    KOLO_VRACENI_BATERIE_PROCENTA: bikeList.some((b) => b.ebike) ? HANDWRITTEN : NONE,
    // kauce (B.4, C.4)
    KAUCE_FORMA: depositMethod ? DEPOSIT_FORM_LABELS[depositMethod] || depositMethod : LATER,
    KAUCE_HOTOVE: depositMethod === 'cash' ? 'ano' : 'ne',
    KAUCE_TERMINAL_REF: depositMethod === 'terminal' ? (hold && hold.provider_ref) || 'dle účtenky terminálu' : NONE,
    KAUCE_PREAUTH_REF: depositMethod === 'card' ? preauthRef || NOT_GIVEN : NONE,
    KAUCE_PREAUTH_PLATNOST_DO: depositMethod === 'card' ? preauthUntil || NOT_GIVEN : NONE,
    KAUCE_POUZITO: format.money(usedMinor),
    KAUCE_DRZENO: format.money(0),
    KAUCE_VRACENO: format.money(returnedMinor),
    KAUCE_VRACENO_FORMA: returnForm,
    ZBYVA_DOPLATIT: format.money(Math.max(0, damageMinor - depositMinor)),
    ZBYVA_VRATIT: format.money(0),
    // vyúčtování při vrácení (C.3)
    SKODA_POPIS: damageMinor > 0 ? damageNote || 'poškození při vrácení' : 'bez škody',
    SKODA_CASTKA: format.money(damageMinor),
    VYUCTOVANI_CELKEM: format.money(damageMinor),
    NAMITKY_TEXT: 'žádné',
    VRACENI_ZPOZDENI: kind === 'return_protocol' || closed || reservation.status === 'returned' ? lateText(reservation, now, settings) : LATER,
    PREDANI_CAS: format.dateTime(now),
    OBSLUHA_JMENO: operatorName,
    VRACENI_OBSLUHA_JMENO: operatorName,
    VRACENI_CAS: format.dateTime(now),
  };
  // Pole záznamů pro cyklus {{#KOLA}}: každé kolo svůj řádek; skalární KOLO_* z `extra` platí pro všechna kola,
  // pole extra.KOLA (po jednom záznamu na kolo) má přednost.
  const perBikeKeys = ['KOLO_BATERIE_PROCENTA', 'KOLO_POSKOZENI_POZNAMKA', 'KOLO_FOTO_POCET', 'KOLO_VRACENI_STAV', 'KOLO_VRACENI_POSKOZENI', 'KOLO_VRACENI_FOTO_POCET', 'KOLO_VRACENI_BATERIE_PROCENTA', 'KOLO_VRACENI_PRISLUSENSTVI_CHYBI', 'KOLO_PRISLUSENSTVI'];
  const KOLA = bikeList.map((b, i) => {
    const rec = {
      KOLO_PORADI: String(b.order),
      KOLO_TYP: b.type,
      KOLO_JE_EKOLO: b.ebike ? 'ano' : 'ne',
      KOLO_INVENTARNI_KOD: b.code,
      KOLO_VELIKOST: b.size,
      KOLO_VYROBNI_CISLO: b.frameNo,
      KOLO_HODNOTA: b.value,
      KOLO_KAUCE: b.deposit,
      KOLO_PRISLUSENSTVI: i === 0 ? accessoriesText : 'zámek s 2 klíči',
      KOLO_BATERIE_PROCENTA: b.ebike ? HANDWRITTEN : NONE,
      KOLO_POSKOZENI_POZNAMKA: 'bez poškození',
      KOLO_FOTO_POCET: '0',
      KOLO_VRACENI_STAV: out.KOLO_VRACENI_STAV,
      KOLO_VRACENI_POSKOZENI: out.KOLO_VRACENI_POSKOZENI,
      KOLO_VRACENI_FOTO_POCET: '0',
      KOLO_VRACENI_BATERIE_PROCENTA: b.ebike ? HANDWRITTEN : NONE,
      KOLO_VRACENI_PRISLUSENSTVI_CHYBI: 'nic',
    };
    for (const k of perBikeKeys) if (given(ex[k])) rec[k] = String(ex[k]);
    if (exBikes && exBikes[i] && typeof exBikes[i] === 'object') for (const [k, v] of Object.entries(exBikes[i])) if (given(v)) rec[k] = String(v);
    return rec;
  });
  const params = Object.assign(out, ex, KOLA.length ? { KOLA } : {});
  return { params, bikes: bikeList, items };
}

/** Vyrenderuje smlouvu / protokol přes feature pravni. */
function renderContract(db, { kind, number, reservation, tenant, settings, customer, operator, bikes, extra, now, numbers, fieldCrypto }) {
  const pravni = require('../features/pravni');
  const base = pravni.legalParams(tenant, settings);
  const own = kind === 'return_protocol' ? 'return_protocol' : kind === 'handover' ? 'handover' : 'contract';
  const { params } = contractParams(db, { reservation, tenant, settings, customer, operator, bikes, extra, now, numbers: { ...numbers, [own]: number }, fieldCrypto, kind });
  const doc = pravni.renderLegal('smlouva-o-najmu-a-predavaci-protokol', { ...base, ...params }, CONTRACT_SECTIONS[kind]);
  const related = kind === 'contract' ? '' : ` · ke smlouvě č. ${params.SMLOUVA_CISLO}`;
  const inner = html`<header class="doc__head doc__head--legal">
  <p class="doc__kind">${LABELS[kind]}</p>
  <h1 class="doc__title">č. ${number}</h1>
  <p class="doc__subtitle">Rezervace č. ${reservation.number} · ${format.dateTime(reservation.from_at)} – ${format.dateTime(reservation.to_at)}${related} · vystaveno ${format.dateTime(now)}</p>
</header>
<section class="doc__body doc__legal">${raw(doc.html)}</section>`;
  return { html: article(kind, number, inner), missing: doc.missing };
}

// ---------------------------------------------------------------------------------------------------------
// Vystavení a čtení

function get(db, number) {
  return db.prepare('SELECT * FROM documents WHERE number = ?').get(String(number || '')) || null;
}

function listFor(db, reservationId) {
  return db.prepare('SELECT id, type, number, issued_at, data FROM documents WHERE reservation_id = ? ORDER BY id').all(Number(reservationId)).map((d) => ({ ...d, data: parseJson(d.data, {}) }));
}

function insert(db, { reservation, type, number, issuedAt, htmlStr, data }) {
  const r = db.prepare('INSERT INTO documents(reservation_id, type, number, issued_at, html, data) VALUES (?, ?, ?, ?, ?, ?)').run(reservation.id, type, number, issuedAt, htmlStr, JSON.stringify(data || {}));
  return { id: Number(r.lastInsertRowid), number, type, html: htmlStr, issuedAt };
}

/**
 * Vystaví doklad daného typu. Vrací { id, number, type, html, issuedAt }.
 * data podle typu – viz hlavička souboru. Údaje zákazníka se do `documents.data` neukládají (jen do HTML, je-li nutné).
 */
function issue(db, type, reservation, data = {}) {
  if (!TYPES.includes(type)) throw new DocumentError(`Neznámý typ dokladu „${type}“.`);
  if (!reservation || !reservation.id) throw new DocumentError('Chybí rezervace.');
  const tenant = data.tenant || {};
  const settings = data.settings || {};
  const now = iso(data.now);
  return inTransaction(db, () => {
    const number = nextNumber(db, type, now);
    const items = loadItems(db, reservation.id);
    const customer = data.customer || customerOf(db, reservation, data.fieldCrypto);
    let htmlStr;
    const meta = { reservationNumber: reservation.number };
    if (type === 'receipt' || type === 'simplified_tax_doc' || type === 'tax_doc') {
      if (!data.payment) throw new DocumentError('Doklad k platbě potřebuje data.payment.');
      htmlStr = renderPaymentDoc({ type, number, reservation, payment: data.payment, items, tenant, settings, issuedAt: now, customer: type === 'tax_doc' ? customer : null });
      Object.assign(meta, { paymentId: data.payment.id, amountMinor: Number(data.payment.captured_minor) > 0 && data.payment.status === 'paid' ? Number(data.payment.captured_minor) : Number(data.payment.amount_minor), purpose: data.payment.purpose, method: data.payment.method, vatRate: tenant.business && tenant.business.vatPayer ? vatRate(settings) : null });
    } else if (type === 'final_doc') {
      const bal = ledger.balance(db, reservation.id);
      const ledgerRows = ledger.list(db, reservation.id);
      const feeDocs = db.prepare("SELECT number FROM documents WHERE reservation_id = ? AND type IN ('receipt','simplified_tax_doc','tax_doc') AND json_extract(data, '$.purpose') = 'fee' ORDER BY id").all(reservation.id);
      htmlStr = renderFinalDoc({ number, reservation, items, tenant, settings, issuedAt: now, customer, bal, ledgerRows, feeDocs });
      Object.assign(meta, { totalMinor: Number(reservation.total_minor), feePaidMinor: bal.feePaidMinor, balancePaidMinor: bal.balancePaidMinor, damageMinor: bal.damageMinor, depositCapturedMinor: bal.depositCapturedMinor, vatRate: tenant.business && tenant.business.vatPayer ? vatRate(settings) : null });
    } else if (type === 'credit_note') {
      if (!data.refund) throw new DocumentError('Opravný doklad potřebuje data.refund (řádek payments purpose=refund).');
      const refDocument = data.refDocument || db.prepare("SELECT * FROM documents WHERE reservation_id = ? AND type IN ('simplified_tax_doc','tax_doc','receipt') AND json_extract(data, '$.purpose') = 'fee' ORDER BY id DESC LIMIT 1").get(reservation.id) || null;
      htmlStr = renderCreditNote({ number, reservation, refund: data.refund, tenant, settings, issuedAt: now, customer, refDocument, reason: data.reason });
      Object.assign(meta, { paymentId: data.refund.id, amountMinor: -Math.abs(Number(data.refund.amount_minor)), refNumber: refDocument ? refDocument.number : null });
    } else {
      const res = renderContract(db, { kind: type, number, reservation, tenant, settings, customer, operator: data.operator, bikes: data.bikes, extra: data.legal, now, numbers: data.numbers || {}, fieldCrypto: data.fieldCrypto });
      htmlStr = res.html;
      Object.assign(meta, { missing: res.missing, operatorId: data.operator ? data.operator.id || null : null });
      if (data.numbers && data.numbers.contract && type !== 'contract') meta.contractNumber = data.numbers.contract;
    }
    const doc = insert(db, { reservation, type, number, issuedAt: now, htmlStr, data: meta });
    // Výdej = smlouva + předávací protokol (SPEC kap. 9): ke smlouvě se v téže transakci vystaví i samostatný protokol PP-
    // (ČÁST B s číslem smlouvy), pokud volající nepředá handover: false.
    if (type === 'contract' && data.handover !== false) {
      doc.handover = issue(db, 'handover', reservation, { ...data, handover: false, numbers: { ...(data.numbers || {}), contract: number } });
    }
    return doc;
  });
}

/** Doklad k přijaté platbě (idempotentní podle payments.id). Vrací existující nebo nový. */
function issueForPayment(db, { reservation, payment, tenant, settings, fieldCrypto, now }) {
  const existing = db.prepare("SELECT * FROM documents WHERE reservation_id = ? AND type IN ('receipt','simplified_tax_doc','tax_doc') AND json_extract(data, '$.paymentId') = ?").get(reservation.id, Number(payment.id));
  if (existing) return { id: existing.id, number: existing.number, type: existing.type, html: existing.html, issuedAt: existing.issued_at, existing: true };
  const amount = Number(payment.captured_minor) > 0 && payment.status === 'paid' ? Number(payment.captured_minor) : Number(payment.amount_minor);
  const type = paymentDocType({ tenant, amountMinor: amount });
  return issue(db, type, reservation, { tenant, settings, payment, fieldCrypto, now });
}

/** Opravný doklad k vratce (idempotentní podle payments.id vratky). */
function issueCreditNote(db, { reservation, refund, tenant, settings, fieldCrypto, now, reason }) {
  const existing = db.prepare("SELECT * FROM documents WHERE reservation_id = ? AND type = 'credit_note' AND json_extract(data, '$.paymentId') = ?").get(reservation.id, Number(refund.id));
  if (existing) return { id: existing.id, number: existing.number, type: existing.type, html: existing.html, issuedAt: existing.issued_at, existing: true };
  return issue(db, 'credit_note', reservation, { tenant, settings, refund, fieldCrypto, now, reason });
}

/** Konečný doklad (jen jeden na rezervaci). */
function issueFinal(db, { reservation, tenant, settings, fieldCrypto, now }) {
  const existing = db.prepare("SELECT * FROM documents WHERE reservation_id = ? AND type = 'final_doc'").get(reservation.id);
  if (existing) return { id: existing.id, number: existing.number, type: existing.type, html: existing.html, issuedAt: existing.issued_at, existing: true };
  return issue(db, 'final_doc', reservation, { tenant, settings, fieldCrypto, now });
}

/**
 * Smlouva (kind contract), předávací protokol (handover) nebo protokol o vrácení (return_protocol).
 * U smlouvy se zároveň vystaví předávací protokol PP- (vrácený jako `.handover`); `handover: false` to vypne.
 * bikes: [{ itemId, bikeId, frameNo? }] – výrobní číslo se bez frameNo dešifruje z bikes.frame_no_enc (fieldCrypto).
 */
function issueContract(db, { reservation, kind = 'contract', tenant, settings, fieldCrypto, customer, operator, bikes, legal, numbers, now, handover }) {
  if (!['contract', 'handover', 'return_protocol'].includes(kind)) throw new DocumentError(`Neznámý druh smluvního dokumentu „${kind}“.`);
  return issue(db, kind, reservation, { tenant, settings, fieldCrypto, customer, operator, bikes, legal, numbers, now, handover });
}

/**
 * Doplní chybějící doklady rezervace: ke každé zaplacené platbě poplatku/doplatku doklad, ke každé provedené vratce
 * zdaněného poplatku opravný doklad, k uzavřené rezervaci konečný doklad. Vrací pole nově vystavených dokladů.
 */
function syncReservation(db, reservationId, { tenant, settings = {}, fieldCrypto = null, now = nowIso(), log = null } = {}) {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(Number(reservationId));
  if (!reservation) return [];
  const issued = [];
  const hasFeeDoc = () => !!db.prepare("SELECT 1 FROM documents WHERE reservation_id = ? AND type IN ('receipt','simplified_tax_doc','tax_doc') AND json_extract(data, '$.purpose') = 'fee'").get(reservation.id);
  for (const p of db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose IN ('fee','balance') AND status IN ('paid','refunded','partially_refunded') ORDER BY id").all(reservation.id)) {
    // doklad k platbě: jen pokud ji rezervace eviduje v ledgeru (zaplacený poplatek / doplatek)
    const inLedger = db.prepare("SELECT 1 FROM ledger_entries WHERE reservation_id = ? AND type IN ('fee_paid','balance_paid') AND (payment_id = ? OR payment_id IS NULL)").get(reservation.id, p.id);
    if (!inLedger) continue;
    if (p.purpose === 'fee' && hasFeeDoc() && !db.prepare("SELECT 1 FROM documents WHERE reservation_id = ? AND json_extract(data, '$.paymentId') = ?").get(reservation.id, p.id)) {
      // druhý doklad k poplatku nevystavujeme (např. demo + ostrá platba) – jen jeden doklad poplatku
      continue;
    }
    // datum vystavení = okamžik platby (dohnání zpětně vystaví doklad k datu přijetí platby)
    const d = issueForPayment(db, { reservation, payment: p, tenant, settings, fieldCrypto, now: p.updated_at && p.updated_at < now ? p.updated_at : now });
    if (!d.existing) issued.push(d);
  }
  for (const r of db.prepare("SELECT * FROM payments WHERE reservation_id = ? AND purpose = 'refund' AND status IN ('refunded','paid') ORDER BY id").all(reservation.id)) {
    if (!hasFeeDoc()) continue;
    const d = issueCreditNote(db, { reservation, refund: r, tenant, settings, fieldCrypto, now: r.updated_at && r.updated_at < now ? r.updated_at : now });
    if (!d.existing) issued.push(d);
  }
  if (reservation.status === 'closed') {
    const d = issueFinal(db, { reservation, tenant, settings, fieldCrypto, now: reservation.updated_at && reservation.updated_at < now ? reservation.updated_at : now });
    if (!d.existing) issued.push(d);
  }
  if (log && issued.length) log.info('Doklady vystaveny', { reservationId: reservation.id, numbers: issued.map((d) => d.number) });
  return issued;
}

/** Projde rezervace s platbami / uzavřené a doplní doklady (job). Vrací počet vystavených. */
function syncAll(db, deps = {}) {
  let n = 0;
  const ids = db
    .prepare("SELECT r.id FROM reservations r WHERE r.status = 'closed' OR EXISTS (SELECT 1 FROM payments p WHERE p.reservation_id = r.id AND p.status IN ('paid','refunded','partially_refunded')) ORDER BY r.id")
    .all()
    .map((r) => r.id);
  for (const id of ids) {
    try {
      n += syncReservation(db, id, deps).length;
    } catch (e) {
      if (deps.log) deps.log.warn('Vystavení dokladu selhalo', { reservationId: id, error: e.message });
    }
  }
  return n;
}

/** Samostatná tisková stránka dokladu (bez layoutu webu). */
function wrapPrint(fragment, { title = 'Doklad', cssHref = '/css/doklady.css', lang = 'cs' } = {}) {
  return (
    '<!doctype html>\n' +
    html`<html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title><link rel="stylesheet" href="${cssHref}"></head><body class="doc-print">${raw(fragment)}</body></html>`.toString()
  );
}

module.exports = {
  TYPES,
  PREFIXES,
  LABELS,
  PURPOSE_LABELS,
  METHOD_LABELS,
  SIMPLIFIED_LIMIT_MINOR,
  DEFAULT_VAT_RATE,
  DocumentError,
  nextNumber,
  vatSplit,
  vatRate,
  paymentDocType,
  issue,
  issueForPayment,
  issueCreditNote,
  issueFinal,
  issueContract,
  contractParams,
  syncReservation,
  syncAll,
  get,
  listFor,
  wrapPrint,
  joinHtml,
};
