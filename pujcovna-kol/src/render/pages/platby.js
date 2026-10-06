'use strict';
// Stránky feature „platby“ (SPEC kap. 10): simulační platební brána (samostatná stránka bez layoutu webu – vypadá jako
// brána třetí strany, výrazně označená „SIMULACE PLATEBNÍ BRÁNY – žádné peníze se nepřevádějí“), výsledek platby,
// demo simulace banky (příchozí převod) a zobrazení dokladu v layoutu webu. Vstupy jsou prostá data z
// src/features/platby.js; výstup Html nebo { title, body, noindex }. Bez inline JS/CSS, vše přes html``.

const { html, raw } = require('../html');
const c = require('../components');
const format = require('../format');

const PURPOSE_LABELS = Object.freeze({ fee: 'Rezervační poplatek', balance: 'Doplatek nájemného', deposit_hold: 'Kauce – blokace na kartě (preautorizace)', refund: 'Vratka' });
const STATUS_LABELS = Object.freeze({ created: 'čeká na zaplacení', pending: 'čeká na zaplacení', paid: 'zaplaceno', authorized: 'blokováno (preautorizace)', captured: 'strženo', partially_captured: 'částečně strženo', released: 'blokace uvolněna', failed: 'zamítnuto / zrušeno', expired: 'vypršelo', refunded: 'vráceno', partially_refunded: 'částečně vráceno' });
const DOC_LABELS = Object.freeze({ receipt: 'Doklad o přijaté platbě', simplified_tax_doc: 'Zjednodušený daňový doklad', tax_doc: 'Daňový doklad', final_doc: 'Konečný doklad', credit_note: 'Opravný doklad', contract: 'Smlouva o nájmu', handover: 'Předávací protokol', return_protocol: 'Protokol o vrácení' });

/** Samostatná stránka „brány“ (bez layoutu webu): base.css pro tokeny + platby.css. */
function standalone({ title, body, assets }) {
  return (
    '<!doctype html>\n' +
    html`<html lang="cs" data-theme="gateway">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title}</title>
<link rel="icon" href="/tenant/logo.svg" type="image/svg+xml">
<link rel="stylesheet" href="${assets.base}">
<link rel="stylesheet" href="${assets.platby}">
</head>
<body class="gw">
<div class="gw__banner" role="alert"><strong>SIMULACE PLATEBNÍ BRÁNY – žádné peníze se nepřevádějí</strong> <span class="gw__banner-text">Ukázkový režim rezervačního systému.</span></div>
<main class="gw__main" id="obsah">${body}</main>
<footer class="gw__foot"><p>Simulační brána dema „Půjčovna kol“. V ostrém provozu zde zákazník vidí stránku skutečné platební brány (karta, Apple Pay / Google Pay, bankovní tlačítka); data karty nikdy neprocházejí serverem půjčovny.</p></footer>
</body>
</html>`.toString()
  );
}

function summaryRows({ payment, reservation, tenant }) {
  return c.summary([
    ['Obchodník', (tenant.business && tenant.business.legalName) || tenant.name],
    ['Účel platby', PURPOSE_LABELS[payment.purpose] || payment.purpose],
    ['Rezervace', `č. ${reservation.number}`],
    ['Variabilní symbol', payment.vs || reservation.number],
    ['Reference transakce', payment.provider_ref || '–'],
    { label: payment.purpose === 'deposit_hold' ? 'Částka k blokaci' : 'Částka k úhradě', value: format.money(payment.amount_minor), strong: true },
  ]);
}

/** Stránka brány s tlačítky Zaplatit / Zamítnout / Zrušit. */
function gateway({ csrf, payment, reservation, tenant, sig, action, assets }) {
  const hold = payment.purpose === 'deposit_hold';
  const body = html`<section class="gw__card">
  <header class="gw__head">
    <p class="gw__brand">Simulační brána <span class="gw__brand-tag">DEMO</span></p>
    <h1 class="gw__title">${hold ? 'Blokace kauce na platební kartě' : 'Platba kartou'}</h1>
    <p class="gw__lead">${hold ? 'Částka se z karty nestrhává, pouze blokuje. Po vrácení kol půjčovna blokaci uvolní nebo strhne jen prokázanou škodu.' : 'Po zaplacení vás brána vrátí zpět do rezervačního systému, kde se stav načte z databáze (nikdy z adresy návratu).'}</p>
  </header>
  ${summaryRows({ payment, reservation, tenant })}
  <div class="gw__fake-card" aria-hidden="true">
    <div class="gw__fake-row"><span class="gw__fake-label">Číslo karty</span><span class="gw__fake-value">•••• •••• •••• 4242</span></div>
    <div class="gw__fake-row"><span class="gw__fake-label">Platnost</span><span class="gw__fake-value">12/29</span><span class="gw__fake-label">CVC</span><span class="gw__fake-value">•••</span></div>
    <p class="gw__fake-note">Ukázka – žádné údaje karty se nezadávají ani neukládají.</p>
  </div>
  <div class="gw__actions">
    ${c.form({ action, method: 'post', csrf, attrs: { class: 'form gw__form' }, children: html`<input type="hidden" name="sig" value="${sig}"><input type="hidden" name="akce" value="zaplatit">${c.button({ label: hold ? `Blokovat ${format.money(payment.amount_minor)}` : `Zaplatit ${format.money(payment.amount_minor)}`, type: 'submit', variant: 'primary', size: 'lg' })}` })}
    ${c.form({ action, method: 'post', csrf, attrs: { class: 'form gw__form' }, children: html`<input type="hidden" name="sig" value="${sig}"><input type="hidden" name="akce" value="zamitnout">${c.button({ label: 'Zamítnout (simulovat chybu banky)', type: 'submit', variant: 'danger' })}` })}
    ${c.form({ action, method: 'post', csrf, attrs: { class: 'form gw__form' }, children: html`<input type="hidden" name="sig" value="${sig}"><input type="hidden" name="akce" value="zrusit">${c.button({ label: 'Zrušit a vrátit se', type: 'submit', variant: 'ghost' })}` })}
  </div>
  <p class="gw__security">${c.icon('shield')} Simulace odpovídá toku skutečné brány: po akci odešle brána interní notifikaci se sdíleným tajemstvím, systém půjčovny stav znovu ověří dotazem na bránu a teprve potom potvrdí rezervaci.</p>
</section>`;
  return standalone({ title: `${hold ? 'Blokace kauce' : 'Platba'} ${format.money(payment.amount_minor)} – simulační brána`, body, assets });
}

/** Výsledek po akci (zamítnuto / zrušeno / už vyřízeno / odkaz vypršel). */
function result({ payment, reservation, tenant, event, returnPath, assets, message }) {
  const tone = event === 'paid' || event === 'authorized' ? 'success' : event === 'invalid' ? 'warning' : 'danger';
  const headline = { paid: 'Platba proběhla', authorized: 'Kauce byla blokována', failed: 'Platba byla zamítnuta', cancelled: 'Platba byla zrušena', done: 'Platba už byla vyřízena', invalid: 'Odkaz na platbu je neplatný nebo vypršel' }[event] || 'Výsledek platby';
  const body = html`<section class="gw__card">
  <header class="gw__head"><p class="gw__brand">Simulační brána <span class="gw__brand-tag">DEMO</span></p><h1 class="gw__title">${headline}</h1></header>
  ${c.notice(message || (payment ? `Stav transakce ${payment.provider_ref || ''}: ${STATUS_LABELS[payment.status] || payment.status}.` : 'Platbu nelze zobrazit.'), tone)}
  ${payment && reservation && tenant ? summaryRows({ payment, reservation, tenant }) : ''}
  <p class="gw__actions gw__actions--result">${c.button({ label: 'Zpět do rezervačního systému', href: returnPath || '/', variant: 'primary', size: 'lg' })}</p>
  ${event === 'failed' || event === 'cancelled' ? html`<p class="gw__hint">Rezervace zůstává ve stavu „čeká na poplatek“. Platbu můžete zopakovat ze stránky správy rezervace nebo zvolit převod s QR kódem.</p>` : ''}
</section>`;
  return standalone({ title: `${headline} – simulační brána`, body, assets });
}

/** Demo simulace banky: příchozí převod (v layoutu webu). */
function bankSim({ csrf, values = {}, errors = {}, outcome = null, pending = [], unmatched = [], tenant }) {
  const b = tenant.business || {};
  const outcomeNotice = outcome
    ? outcome.result.outcome === 'paid' || outcome.result.outcome === 'overpaid'
      ? c.notice(html`Příchozí platba ${format.money(outcome.tx.amount_minor)} (VS ${outcome.tx.vs || '–'}) byla <strong>spárována</strong>${outcome.result.outcome === 'overpaid' ? html` – <strong>přeplatek ${format.money(outcome.result.diffMinor)}</strong> je evidován jako kredit` : ''}; rezervace je potvrzena a zákazníkovi odešel e-mail s dokladem.`, 'success')
      : outcome.result.outcome === 'partial'
        ? c.notice(html`Příchozí platba ${format.money(outcome.tx.amount_minor)} je <strong>nedoplatek</strong> – platba zůstává čekající, zbývá ${format.money(outcome.result.remainingMinor)}; zákazníkovi odešel e-mail s QR kódem na zbytek.`, 'warning')
        : c.notice(html`Příchozí platba ${format.money(outcome.tx.amount_minor)} (VS ${outcome.tx.vs || '–'}) <strong>nebyla spárována</strong> (${outcome.result.reason || 'bez shody'}) – čeká ve frontě na ruční přiřazení v adminu.`, 'danger')
    : '';
  return {
    title: 'Simulace banky – příchozí převod',
    noindex: true,
    body: html`
<section class="section section--page-head"><div class="container">
  <p class="section__eyebrow">Demo · simulace externí služby</p>
  <h1 class="section__title">Simulace banky – příchozí převod</h1>
  <p class="section__lead">Nahrazuje bankovní API (Fio): vložíte „příchozí platbu“ na účet půjčovny ${b.accountNumber ? html`<code>${b.accountNumber}</code>` : ''} a systém ji spáruje podle variabilního symbolu stejně jako v ostrém provozu. Žádné peníze se nepřevádějí.</p>
</div></section>
<section class="section"><div class="container banksim">
  <div class="banksim__main">
    ${outcomeNotice}
    ${errors.obecne ? c.notice(errors.obecne, 'danger') : ''}
    ${c.form({
      action: '/simulace-banky',
      method: 'post',
      csrf,
      attrs: { class: 'form banksim__form' },
      children: [
        c.field({ label: 'Částka (Kč)', name: 'castka', type: 'text', value: values.castka || '', required: true, error: errors.castka, inputmode: 'decimal', hint: 'Např. 1000 nebo 995,50. Tolerance párování je ±5 Kč; menší částka = nedoplatek, větší = přeplatek (kredit).' }),
        c.field({ label: 'Variabilní symbol', name: 'vs', type: 'text', value: values.vs || '', required: true, error: errors.vs, inputmode: 'numeric', maxlength: 10, hint: 'Číslo rezervace (10 číslic). Neznámý VS skončí ve frontě nespárovaných.' }),
        c.field({ label: 'Zpráva pro příjemce', name: 'zprava', type: 'text', value: values.zprava || '', maxlength: 60 }),
        c.field({ label: 'Protiúčet (plátce)', name: 'protiucet', type: 'text', value: values.protiucet || '123456789/0100', maxlength: 40 }),
      ],
      submit: 'Simulovat příchozí platbu',
    })}
  </div>
  <aside class="banksim__side">
    <div class="info-card">
      <h2 class="info-card__title">Čekající platby převodem</h2>
      ${pending.length
        ? html`<ul class="banksim__pending">${pending.map((p) => html`<li><strong>VS ${p.vs}</strong> · ${format.money(Math.max(0, p.amount_minor - p.captured_minor))}${p.captured_minor > 0 ? html` <small>(přijato ${format.money(p.captured_minor)})</small>` : ''} <small>· rezervace č. ${p.number}, uhradit do ${format.dateTime(p.expires_at)}</small></li>`)}</ul>`
        : html`<p class="info-card__text">Žádná rezervace teď nečeká na převod. Založte rezervaci a zvolte „Převod / QR“.</p>`}
    </div>
    <div class="info-card">
      <h2 class="info-card__title">Nespárované pohyby (${unmatched.length})</h2>
      ${unmatched.length ? html`<ul class="banksim__pending">${unmatched.slice(0, 8).map((t) => html`<li>${format.money(t.amount_minor)} · VS ${t.vs || '–'} <small>· ${format.dateTime(t.booked_at)}, ${t.tx_id}</small></li>`)}</ul>` : html`<p class="info-card__text">Fronta je prázdná.</p>`}
      <p class="info-card__text">Ruční přiřazení k platbě řeší admin (Platby → nespárované).</p>
    </div>
  </aside>
</div></section>`,
  };
}

/** Doklad v layoutu webu (náhled + odkazy na tisk). */
function documentPage({ doc, reservation, printHref, backHref, demo }) {
  return {
    title: `${DOC_LABELS[doc.type] || 'Doklad'} ${doc.number}`,
    noindex: true,
    body: html`
<section class="section section--doc"><div class="container">
  <div class="doc-toolbar">
    <p class="doc-toolbar__meta">${DOC_LABELS[doc.type] || doc.type} <strong>${doc.number}</strong> · vystaveno ${format.dateTime(doc.issued_at)}${reservation ? html` · rezervace č. ${reservation.number}` : ''}</p>
    <p class="doc-toolbar__actions">${c.button({ label: 'Tisková verze', href: printHref, variant: 'secondary', attrs: { target: '_blank', rel: 'noopener' } })} ${backHref ? c.button({ label: 'Zpět na rezervaci', href: backHref, variant: 'ghost' }) : ''}</p>
  </div>
  ${demo ? c.notice('Demo: fiktivní půjčovna, fiktivní zákazníci. Doklad má náležitosti podle zákona o DPH, ale nejde o skutečný účetní doklad.', 'info') : ''}
  <div class="doc-frame">${raw(doc.html)}</div>
</div></section>`,
  };
}

module.exports = { PURPOSE_LABELS, STATUS_LABELS, DOC_LABELS, standalone, gateway, result, bankSim, documentPage };
