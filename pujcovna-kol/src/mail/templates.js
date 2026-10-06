'use strict';
// E-mailové šablony (SPEC kap. 9): potvrzení rezervace, platba přijata, připomínka den před, storno, QR na doplatek.
// Každá šablona: fn(data) → { subject, text, html }. HTML je jednoduché sémantické (bez CSS), text je plný ekvivalent.
// Vstup data (sestavuje src/mail/outbox.js → buildMailData):
//   { tenant, baseUrl, reservation (řádek reservations), customer: { name }, items: [{ typeName, size, qty, amountMinor }],
//     accessories: [{ label, qty, amountMinor }], manageUrl, icsUrl, payment?: { amountMinor, method, at, iban,
//     accountNumber, vs, spayd, expiresAt }, cancellation?: výstup cancellation.quote, cancelledBy?: 'customer'|'operator',
//     document?: { number, url }, balanceMinor?, feeForfeited? }
// Šablony nikdy nelogují; e-mailová adresa do nich nevstupuje (adresát řeší outbox přes to_hmac / payload.to_enc).

const { html, raw } = require('../render/html');
const format = require('../render/format');

const METHOD_LABELS = Object.freeze({ card: 'kartou online', bank_transfer: 'bankovním převodem', cash: 'hotově', terminal: 'platebním terminálem' });

function esc(s) {
  return html`${s}`.toString();
}

function term(r) {
  return `${format.dateTime(r.from_at)} – ${format.dateTime(r.to_at)}`;
}

function itemsText(data) {
  const lines = (data.items || []).map((it) => `  - ${it.qty}× ${it.typeName} (velikost ${it.size}) … ${format.money(it.amountMinor)}`);
  for (const a of data.accessories || []) lines.push(`  - ${a.qty}× ${a.label} … ${format.money(a.amountMinor)}`);
  return lines.join('\n');
}

function itemsHtml(data) {
  return html`<ul>${(data.items || []).map((it) => html`<li>${it.qty}× ${it.typeName} (velikost ${it.size}) – ${format.money(it.amountMinor)}</li>`)}${(data.accessories || []).map((a) => html`<li>${a.qty}× ${a.label} – ${format.money(a.amountMinor)}</li>`)}</ul>`;
}

function footerText(data) {
  const b = data.tenant.business || {};
  return [`${data.tenant.name}`, b.address, b.phone ? `Tel.: ${b.phone}` : null, b.email ? `E-mail: ${b.email}` : null, `${data.baseUrl}`].filter(Boolean).join('\n');
}

function footerHtml(data) {
  const b = data.tenant.business || {};
  return html`<hr><p><strong>${data.tenant.name}</strong><br>${b.address || ''}${b.phone ? html`<br>Tel.: ${b.phone}` : ''}${b.email ? html`<br>E-mail: ${b.email}` : ''}<br><a href="${data.baseUrl}">${data.baseUrl}</a></p>`;
}

function wrap(title, bodyHtml, data) {
  return `<!doctype html>\n<html lang="cs"><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${bodyHtml}${footerHtml(data)}</body></html>`;
}

function greeting(data) {
  return data.customer && data.customer.name ? `Dobrý den, ${data.customer.name},` : 'Dobrý den,';
}

function idDocText(data) {
  const accepted = (data.settings && data.settings.acceptedIdDocs) || 'občanský průkaz, cestovní pas nebo řidičský průkaz';
  return `Při převzetí předložte prosím platný doklad totožnosti (${accepted}). Zapíšeme si jeho typ a číslo – bez toho kolo nemůžeme vydat. Důvodem je ověření totožnosti a platnosti dokladu a ochrana kol před krádeží.`;
}

function cancellationText(data) {
  const h = data.settings && data.settings.cancellation ? data.settings.cancellation.freeHoursBefore : 48;
  return `Storno: zrušíte-li rezervaci nejméně ${h} hodin před začátkem, vrátíme celý rezervační poplatek; při pozdějším zrušení nebo nevyzvednutí poplatek propadá. Rezervaci spravujete na odkazu výše.`;
}

/** 1. Potvrzení rezervace (po vytvoření; obsahuje pokyny k úhradě poplatku, je-li rezervace awaiting_fee). */
function reservationCreated(data) {
  const r = data.reservation;
  const subject = `Rezervace č. ${r.number} – ${data.tenant.name}`;
  const awaiting = r.status === 'awaiting_fee';
  const p = data.payment || {};
  const payText = awaiting
    ? [
        `Rezervační poplatek ${format.money(r.fee_minor)} uhraďte prosím ${r.expires_at ? `do ${format.dateTime(r.expires_at)}` : 'co nejdříve'}, jinak rezervace propadne.`,
        p.iban ? `Převodem: IBAN ${p.iban}${p.accountNumber ? ` (č. ú. ${p.accountNumber})` : ''}, částka ${format.money(p.amountMinor || r.fee_minor)}, variabilní symbol ${p.vs || r.number}.` : null,
        p.spayd ? `QR Platba: ${p.spayd}` : null,
        `Kartou online nebo QR kódem: ${data.manageUrl}`,
      ]
        .filter(Boolean)
        .join('\n')
    : `Rezervační poplatek ${format.money(r.paid_minor)} je uhrazen, rezervace je potvrzena.`;
  const text = [
    greeting(data),
    '',
    `děkujeme za rezervaci kol v půjčovně ${data.tenant.name}.`,
    '',
    `Číslo rezervace: ${r.number}`,
    `Termín: ${term(r)}`,
    'Kola a příslušenství:',
    itemsText(data),
    `Cena pronájmu celkem: ${format.money(r.total_minor)}`,
    `Rezervační poplatek (započítá se do ceny): ${format.money(r.fee_minor)}`,
    r.deposit_minor ? `Vratná kauce při převzetí: ${format.money(r.deposit_minor)}` : null,
    '',
    payText,
    '',
    `Správa rezervace (stav, platba, storno): ${data.manageUrl}`,
    data.icsUrl ? `Přidat do kalendáře (ICS): ${data.icsUrl}` : null,
    '',
    idDocText(data),
    '',
    cancellationText(data),
    '',
    footerText(data),
  ]
    .filter((l) => l !== null)
    .join('\n');
  const body = html`<p>${greeting(data)}</p><p>děkujeme za rezervaci kol v půjčovně ${data.tenant.name}.</p>
<p><strong>Číslo rezervace:</strong> ${r.number}<br><strong>Termín:</strong> ${term(r)}</p>
<p><strong>Kola a příslušenství:</strong></p>${itemsHtml(data)}
<p>Cena pronájmu celkem: <strong>${format.money(r.total_minor)}</strong><br>Rezervační poplatek (započítá se do ceny): <strong>${format.money(r.fee_minor)}</strong>${r.deposit_minor ? html`<br>Vratná kauce při převzetí: ${format.money(r.deposit_minor)}` : ''}</p>
${awaiting
    ? html`<p><strong>Rezervační poplatek ${format.money(r.fee_minor)} uhraďte prosím ${r.expires_at ? html`do ${format.dateTime(r.expires_at)}` : 'co nejdříve'}, jinak rezervace propadne.</strong></p>
${p.iban ? html`<p>Převodem: IBAN <code>${p.iban}</code>${p.accountNumber ? html` (č. ú. ${p.accountNumber})` : ''}, částka <strong>${format.money(p.amountMinor || r.fee_minor)}</strong>, variabilní symbol <strong>${p.vs || r.number}</strong>.</p>` : ''}
<p>Kartou online nebo QR kódem: <a href="${data.manageUrl}">${data.manageUrl}</a></p>`
    : html`<p>Rezervační poplatek ${format.money(r.paid_minor)} je uhrazen, rezervace je potvrzena.</p>`}
<p>Správa rezervace (stav, platba, storno): <a href="${data.manageUrl}">${data.manageUrl}</a>${data.icsUrl ? html`<br>Přidat do kalendáře: <a href="${data.icsUrl}">ICS soubor</a>` : ''}</p>
<p>${idDocText(data)}</p>
<p>${cancellationText(data)}</p>`;
  return { subject, text, html: wrap(subject, body.toString(), data) };
}

/** 2. Platba přijata – rezervace potvrzena. */
function paymentReceived(data) {
  const r = data.reservation;
  const p = data.payment || {};
  const subject = `Platba přijata – rezervace č. ${r.number} je potvrzena`;
  const balance = Math.max(0, Number(r.total_minor) - Number(r.paid_minor));
  const text = [
    greeting(data),
    '',
    `přijali jsme vaši platbu ${format.money(p.amountMinor ?? r.paid_minor)}${p.method ? ` ${METHOD_LABELS[p.method] || p.method}` : ''}${p.at ? ` (${format.dateTime(p.at)})` : ''}. Rezervace č. ${r.number} na termín ${term(r)} je potvrzena.`,
    '',
    data.document ? `Doklad o přijaté platbě ${data.document.number}: ${data.document.url}` : null,
    balance > 0 ? `Zbývá doplatit ${format.money(balance)} – při převzetí, nebo předem online: ${data.manageUrl}` : 'Pronájem je uhrazen v plné výši.',
    '',
    `Správa rezervace: ${data.manageUrl}`,
    '',
    idDocText(data),
    '',
    footerText(data),
  ]
    .filter((l) => l !== null)
    .join('\n');
  const body = html`<p>${greeting(data)}</p>
<p>přijali jsme vaši platbu <strong>${format.money(p.amountMinor ?? r.paid_minor)}</strong>${p.method ? html` ${METHOD_LABELS[p.method] || p.method}` : ''}${p.at ? html` (${format.dateTime(p.at)})` : ''}. Rezervace č. <strong>${r.number}</strong> na termín ${term(r)} je potvrzena.</p>
${data.document ? html`<p>Doklad o přijaté platbě ${data.document.number}: <a href="${data.document.url}">${data.document.url}</a></p>` : ''}
<p>${balance > 0 ? html`Zbývá doplatit <strong>${format.money(balance)}</strong> – při převzetí, nebo předem online na <a href="${data.manageUrl}">stránce rezervace</a>.` : 'Pronájem je uhrazen v plné výši.'}</p>
<p>Správa rezervace: <a href="${data.manageUrl}">${data.manageUrl}</a></p>
<p>${idDocText(data)}</p>`;
  return { subject, text, html: wrap(subject, body.toString(), data) };
}

/** 3. Připomínka den před vyzvednutím. */
function reminder(data) {
  const r = data.reservation;
  const b = data.tenant.business || {};
  const subject = `Zítra vyzvednutí kol – rezervace č. ${r.number}`;
  const balance = Math.max(0, Number(r.total_minor) - Number(r.paid_minor));
  const text = [
    greeting(data),
    '',
    `připomínáme vyzvednutí kol ${format.dateTime(r.from_at)} v půjčovně ${data.tenant.name}${b.address ? `, ${b.address}` : ''}. Vrácení: ${format.dateTime(r.to_at)}.`,
    '',
    'Kola a příslušenství:',
    itemsText(data),
    '',
    'Co vzít s sebou:',
    `  - platný doklad totožnosti (zapíšeme typ a číslo – bez toho kolo nevydáme),`,
    r.deposit_minor ? `  - vratnou kauci ${format.money(r.deposit_minor)} (hotově, kartou na terminálu nebo preautorizací karty),` : null,
    balance > 0 ? `  - doplatek ${format.money(balance)} (lze uhradit i předem online: ${data.manageUrl}).` : '  - pronájem je uhrazen v plné výši.',
    '',
    `Správa rezervace: ${data.manageUrl}`,
    '',
    footerText(data),
  ]
    .filter((l) => l !== null)
    .join('\n');
  const body = html`<p>${greeting(data)}</p>
<p>připomínáme vyzvednutí kol <strong>${format.dateTime(r.from_at)}</strong> v půjčovně ${data.tenant.name}${b.address ? html`, ${b.address}` : ''}. Vrácení: ${format.dateTime(r.to_at)}.</p>
<p><strong>Kola a příslušenství:</strong></p>${itemsHtml(data)}
<p><strong>Co vzít s sebou:</strong></p><ul><li>platný doklad totožnosti (zapíšeme typ a číslo – bez toho kolo nevydáme),</li>${r.deposit_minor ? html`<li>vratnou kauci ${format.money(r.deposit_minor)} (hotově, kartou na terminálu nebo preautorizací karty),</li>` : ''}<li>${balance > 0 ? html`doplatek <strong>${format.money(balance)}</strong> (lze uhradit i předem online na <a href="${data.manageUrl}">stránce rezervace</a>).` : 'pronájem je uhrazen v plné výši.'}</li></ul>
<p>Správa rezervace: <a href="${data.manageUrl}">${data.manageUrl}</a></p>`;
  return { subject, text, html: wrap(subject, body.toString(), data) };
}

/** 4. Storno (zákazníkem nebo půjčovnou) s výsledkem storno engine. */
function cancelled(data) {
  const r = data.reservation;
  const q = data.cancellation || { refundMinor: 0, forfeitMinor: 0, rule: 'free' };
  const byOperator = data.cancelledBy === 'operator';
  const subject = `Rezervace č. ${r.number} byla zrušena`;
  let outcome;
  if (q.paidMinor === 0 || (!q.refundMinor && !q.forfeitMinor)) outcome = 'Rezervační poplatek nebyl uhrazen, nic se nevrací ani neúčtuje.';
  else if (byOperator || q.rule === 'free') outcome = `Vracíme celý rezervační poplatek ${format.money(q.refundMinor)}${byOperator ? ' (zrušení ze strany půjčovny)' : ` (zrušeno nejméně ${q.freeHoursBefore} hodin před začátkem)`}. Vratka jde stejnou cestou, jakou byl poplatek zaplacen; u převodu ji potvrzuje obsluha.`;
  else outcome = `Rezervace byla zrušena méně než ${q.freeHoursBefore} hodin před začátkem, rezervační poplatek ${format.money(q.forfeitMinor)} proto propadá jako úplata za zajištění termínu.`;
  const text = [
    greeting(data),
    '',
    `${byOperator ? 'půjčovna zrušila' : 'na vaši žádost jsme zrušili'} rezervaci č. ${r.number} na termín ${term(r)}.`,
    '',
    outcome,
    data.document ? `Opravný doklad ${data.document.number}: ${data.document.url}` : null,
    '',
    `Detail rezervace: ${data.manageUrl}`,
    'Budeme rádi, když si u nás kolo půjčíte jindy.',
    '',
    footerText(data),
  ]
    .filter((l) => l !== null)
    .join('\n');
  const body = html`<p>${greeting(data)}</p>
<p>${byOperator ? 'půjčovna zrušila' : 'na vaši žádost jsme zrušili'} rezervaci č. <strong>${r.number}</strong> na termín ${term(r)}.</p>
<p>${outcome}</p>
${data.document ? html`<p>Opravný doklad ${data.document.number}: <a href="${data.document.url}">${data.document.url}</a></p>` : ''}
<p>Detail rezervace: <a href="${data.manageUrl}">${data.manageUrl}</a><br>Budeme rádi, když si u nás kolo půjčíte jindy.</p>`;
  return { subject, text, html: wrap(subject, body.toString(), data) };
}

/** 5. QR na doplatek (zbytek ceny převodem / QR Platbou). */
function balanceQr(data) {
  const r = data.reservation;
  const p = data.payment || {};
  const amount = p.amountMinor ?? Math.max(0, Number(r.total_minor) - Number(r.paid_minor));
  const subject = `Doplatek ${format.money(amount)} k rezervaci č. ${r.number}`;
  const text = [
    greeting(data),
    '',
    `k rezervaci č. ${r.number} (${term(r)}) zbývá doplatit ${format.money(amount)}. Můžete zaplatit předem převodem nebo QR Platbou, případně při převzetí.`,
    '',
    p.iban ? `IBAN: ${p.iban}${p.accountNumber ? ` (č. ú. ${p.accountNumber})` : ''}` : null,
    `Částka: ${format.money(amount)}`,
    `Variabilní symbol: ${p.vs || r.number}`,
    p.expiresAt ? `Uhraďte prosím do ${format.dateTime(p.expiresAt)}.` : null,
    p.spayd ? `QR Platba (SPAYD): ${p.spayd}` : null,
    '',
    `QR kód a platba kartou: ${data.manageUrl}`,
    '',
    footerText(data),
  ]
    .filter((l) => l !== null)
    .join('\n');
  const qr = p.qrSvg ? html`<p><img src="data:image/svg+xml;base64,${Buffer.from(String(p.qrSvg), 'utf8').toString('base64')}" alt="QR Platba – doplatek ${format.money(amount)}" width="220" height="220"></p>` : '';
  const body = html`<p>${greeting(data)}</p>
<p>k rezervaci č. <strong>${r.number}</strong> (${term(r)}) zbývá doplatit <strong>${format.money(amount)}</strong>. Můžete zaplatit předem převodem nebo QR Platbou, případně při převzetí.</p>
<p>${p.iban ? html`IBAN: <code>${p.iban}</code>${p.accountNumber ? html` (č. ú. ${p.accountNumber})` : ''}<br>` : ''}Částka: <strong>${format.money(amount)}</strong><br>Variabilní symbol: <strong>${p.vs || r.number}</strong>${p.expiresAt ? html`<br>Uhraďte prosím do ${format.dateTime(p.expiresAt)}.` : ''}</p>
${qr}
<p>QR kód a platba kartou: <a href="${data.manageUrl}">${data.manageUrl}</a></p>`;
  return { subject, text, html: wrap(subject, body.toString(), data) };
}

const TEMPLATES = Object.freeze({
  reservation_created: reservationCreated,
  payment_received: paymentReceived,
  reminder,
  reservation_cancelled: cancelled,
  balance_qr: balanceQr,
});

/** Vyrenderuje šablonu podle typu. */
function render(type, data) {
  const fn = TEMPLATES[type];
  if (!fn) throw new Error(`Neznámá e-mailová šablona „${type}“.`);
  return fn(data);
}

module.exports = { TEMPLATES, render, reservationCreated, paymentReceived, reminder, cancelled, balanceQr, METHOD_LABELS, raw };
