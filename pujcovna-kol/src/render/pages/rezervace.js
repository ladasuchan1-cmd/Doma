'use strict';
// Stránky feature „rezervace“ (SPEC kap. 9): kroky 1–5 (termín, kola, údaje, poplatek, hotovo), platba převodem,
// správa rezervace přes token. Vstupy jsou prostá data z src/features/rezervace.js; výstup Html tělo nebo
// { title, description, body, noindex }. Všechny stránky fungují bez JS (dva <input type=date> + select času,
// číselná pole, tlačítka formulářů); public/js/rezervace.js jen vylepšuje (kalendář, živá dostupnost, součty).

const { html, raw } = require('../html');
const c = require('../components');
const format = require('../format');
const { STATUS_LABELS, STATUS_TONES } = require('../../domain/reservations');
const cancellation = require('../../domain/cancellation');

const STEP_ITEMS = [
  { label: 'Termín', href: '/rezervace', description: 'Kdy kola vyzvednete a vrátíte' },
  { label: 'Kola', href: '/rezervace/kola', description: 'Typ, velikost, počet, příslušenství' },
  { label: 'Údaje', href: '/rezervace/udaje', description: 'Kontakt a souhlasy' },
  { label: 'Poplatek', href: '/rezervace/poplatek', description: 'Rezervační poplatek online' },
  { label: 'Hotovo', description: 'Potvrzení a e-mail' },
];

const PAYMENT_LABELS = Object.freeze({ fee: 'Rezervační poplatek', balance: 'Doplatek', deposit_hold: 'Kauce (blokace)', refund: 'Vratka' });
const METHOD_LABELS = Object.freeze({ card: 'Karta online', bank_transfer: 'Převod / QR', cash: 'Hotově', terminal: 'Terminál' });
const PAYMENT_STATUS = Object.freeze({ created: 'založena', pending: 'čeká', paid: 'zaplaceno', authorized: 'blokováno', captured: 'strženo', partially_captured: 'částečně strženo', released: 'uvolněno', failed: 'selhala', expired: 'propadla', refunded: 'vráceno', partially_refunded: 'částečně vráceno' });
const LEDGER_LABELS = Object.freeze({ fee_paid: 'Poplatek zaplacen', balance_paid: 'Doplatek zaplacen', deposit_held: 'Kauce složena', deposit_captured: 'Stržení z kauce', deposit_released: 'Kauce uvolněna', refund: 'Vratka', fee_forfeited: 'Poplatek propadl', damage: 'Poškození' });
const DOC_LABELS = Object.freeze({ receipt: 'Příjmový doklad', simplified_tax_doc: 'Zjednodušený daňový doklad', tax_doc: 'Daňový doklad', final_doc: 'Konečné vyúčtování', credit_note: 'Opravný doklad', contract: 'Smlouva o nájmu', handover: 'Předávací protokol', return_protocol: 'Protokol o vrácení' });

function stepHeader(active, title, lead) {
  return html`<section class="section section--page-head"><div class="container">
  <p class="section__eyebrow">Rezervace · krok ${active + 1} z ${STEP_ITEMS.length}</p>
  <h1 class="section__title">${title}</h1>
  ${lead ? html`<p class="section__lead">${lead}</p>` : ''}
  ${c.steps(STEP_ITEMS, active)}
</div></section>`;
}

function termLine(term) {
  return html`<p class="term-line"><strong>Termín:</strong> ${format.dateTime(term.fromAt)} – ${format.dateTime(term.toAt)} <span class="term-line__days">(${format.plural(term.days, 'den', 'dny', 'dní')})</span> <a class="term-line__change" href="/rezervace">změnit</a></p>`;
}

function statusBadge(status) {
  return c.badge(STATUS_LABELS[status] || status, STATUS_TONES[status] || 'neutral');
}

/** Krok 1 – termín. values: { od, od_cas, do, do_cas, typ }; slots: ['08:00', …]; blocked: ['YYYY-MM-DD'] */
function termin({ csrf, values, errors, slots, blocked, minDate, maxDate, tenant, preselect }) {
  const rows = format.openingHoursRows(tenant.openingHours || {});
  return {
    title: 'Rezervace – termín',
    noindex: false,
    body: html`
${stepHeader(0, 'Vyberte termín', 'Vyzvednutí i vrácení probíhá v otevírací době půjčovny. Zavřené dny jsou v kalendáři blokované.')}
<section class="section section--step"><div class="container step-layout">
  <div class="step-main">
    ${Object.keys(errors).length ? c.notice('Zkontrolujte prosím označená pole.', 'danger') : ''}
    ${preselect ? c.notice(html`Předvybraný typ kola: <strong>${preselect.name}</strong>. Počet a velikost zvolíte v dalším kroku.`, 'info') : ''}
    ${c.form({
      action: '/rezervace',
      method: 'post',
      csrf,
      attrs: { 'data-term-form': true, novalidate: true },
      children: html`
        ${preselect ? html`<input type="hidden" name="typ" value="${preselect.slug}">` : ''}
        ${c.calendarRange({ name: 'termin', min: minDate, max: maxDate, blocked, from: values.od, to: values.do, labels: { from: 'Datum vyzvednutí', to: 'Datum vrácení' } })}
        <div class="time-grid">
          ${c.field({ label: 'Čas vyzvednutí', name: 'od_cas', type: 'select', value: values.od_cas || '09:00', options: slots, required: true, error: errors.od })}
          ${c.field({ label: 'Čas vrácení', name: 'do_cas', type: 'select', value: values.do_cas || '17:00', options: slots, required: true, error: errors.do })}
        </div>
        ${errors.obecne ? html`<p class="field__error">${errors.obecne}</p>` : ''}
        <p class="calendar__status" data-availability-status aria-live="polite"></p>
      `,
      submit: 'Pokračovat k výběru kol',
    })}
  </div>
  <aside class="step-side">
    <div class="info-card">
      <h2 class="info-card__title">Otevírací doba</h2>
      <dl class="contact-card__hours">${rows.map((r) => html`<div><dt>${r.days}</dt><dd>${r.hours}</dd></div>`)}</dl>
      <p class="info-card__text">Do 4 hodin účtujeme hodinovou sazbu, do 6 hodin půlden, jinak každý započatý den. Kola lze rezervovat nejvýše na 30 dní.</p>
    </div>
  </aside>
</div></section>`,
  };
}

/** Řádek výběru velikosti: qty input nebo „obsazeno“. */
function sizeRow(type, sizeIdx, size, available, qty, perBikeMinor) {
  const name = `qty_${type.id}_${sizeIdx}`;
  const id = `f-${name}`;
  return html`<li class="bike-pick__size">
  <span class="bike-pick__size-label">${size}</span>
  ${available > 0 ? c.badge(format.plural(available, 'volné', 'volná', 'volných'), 'success') : c.badge('Obsazeno', 'danger')}
  <label class="visually-hidden" for="${id}">Počet kol ${type.name} velikost ${size}</label>
  <input class="field__input bike-pick__qty" type="number" id="${id}" name="${name}" min="0" max="${available}" step="1" value="${qty || 0}" inputmode="numeric" data-price="${perBikeMinor}" data-fee="${type.fee_minor}"${available > 0 ? '' : raw(' disabled')}>
</li>`;
}

/** Krok 2 – kola. types: [{ …type, sizes, availability: { size: n }, quote, selected: { size: qty } }], accessories: [{ …, qty }] */
function kola({ csrf, term, types, accessories, errors, notice }) {
  return {
    title: 'Rezervace – výběr kol',
    body: html`
${stepHeader(1, 'Vyberte kola', 'Počet kusů zadejte u velikosti. Cena je za kolo pro celý zvolený termín; rezervační poplatek se platí teď a započítá se do ceny.')}
<section class="section section--step"><div class="container step-layout">
  <div class="step-main">
    ${termLine(term)}
    ${notice ? c.notice(notice, 'danger') : ''}
    ${errors && errors.obecne ? c.notice(errors.obecne, 'danger') : ''}
    ${c.form({
      action: '/rezervace/kola',
      method: 'post',
      csrf,
      attrs: { 'data-bike-form': true },
      children: html`
        <ul class="bike-pick-list">${types.map((t) => {
          const photo = t.photos && t.photos[0] ? (typeof t.photos[0] === 'string' ? { src: t.photos[0] } : t.photos[0]) : null;
          const q = t.quote;
          return html`<li class="bike-pick${t.totalAvailable > 0 ? '' : ' is-unavailable'}" data-type="${t.id}">
  <div class="bike-pick__media">${photo ? html`<img src="${photo.src}" alt="${photo.alt || t.name}" loading="lazy" width="400" height="267">` : html`<div class="card__placeholder">${c.icon('bike')}</div>`}</div>
  <div class="bike-pick__body">
    <p class="bike-pick__badges">${c.badge(c.CATEGORY_LABELS[t.category] || t.category)} ${t.totalAvailable > 0 ? '' : c.badge('V tomto termínu obsazeno', 'danger')}</p>
    <h2 class="bike-pick__title"><a href="/kola/${t.slug}?od=${encodeURIComponent(term.od)}&amp;do=${encodeURIComponent(term.do)}">${t.name}</a></h2>
    ${q ? html`<p class="bike-pick__price"><strong>${format.money(q.bikesMinor)}</strong> za kolo a termín <small>(${format.plural(q.units, q.unit === 'day' ? 'den' : q.unit === 'hour' ? 'hodina' : 'půlden', q.unit === 'day' ? 'dny' : q.unit === 'hour' ? 'hodiny' : 'půldny', q.unit === 'day' ? 'dní' : q.unit === 'hour' ? 'hodin' : 'půldnů')} à ${format.money(q.unitPriceMinor)})</small> · poplatek ${format.money(t.fee_minor)} · kauce ${format.money(t.deposit_minor)}</p>` : c.notice('Ceník se připravuje.', 'info')}
    <ul class="bike-pick__sizes">${t.sizes.map((s, i) => sizeRow(t, i, s, t.availability[s] || 0, t.selected[s] || 0, q ? Math.round(q.bikesMinor) : 0))}</ul>
  </div>
</li>`;
        })}</ul>
        ${accessories.length
          ? html`<fieldset class="accessories">
  <legend class="accessories__title">Příslušenství <small>(cena za den)</small></legend>
  <ul class="accessories__list">${accessories.map(
    (a) => html`<li class="accessories__item">
    <label class="accessories__label" for="f-acc_${a.slug}">${a.name} <span class="accessories__price">${a.price_minor ? `${format.money(a.price_minor)} / den` : 'zdarma'}</span></label>
    <input class="field__input accessories__qty" type="number" id="f-acc_${a.slug}" name="acc_${a.slug}" min="0" max="${a.stock}" step="1" value="${a.qty || 0}" inputmode="numeric" data-price="${a.price_minor}" data-days="${term.days}">
  </li>`
  )}</ul>
</fieldset>`
          : ''}
        <div class="pick-summary" data-pick-summary hidden>
          <p class="pick-summary__line">Vybráno <strong data-pick-count>0</strong> kol · cena pronájmu <strong data-pick-total>0 Kč</strong> · rezervační poplatek teď <strong data-pick-fee>0 Kč</strong></p>
        </div>
      `,
      submit: 'Pokračovat k údajům',
    })}
  </div>
  <aside class="step-side">
    <div class="info-card">
      <h2 class="info-card__title">Jak se počítá cena</h2>
      <p class="info-card__text">Pásma podle délky: 1 den · 2–3 dny · 4–6 dní · 7 a více dní. V hlavní sezóně platí sezónní sazba. Příslušenství se účtuje za den.</p>
      <p class="info-card__text">Rezervační poplatek za každé kolo zaplatíte online hned; zbytek při převzetí nebo předem. <a href="/cenik#storno">Storno pravidla</a></p>
    </div>
  </aside>
</div></section>`,
  };
}

/** Krok 3 – údaje a souhlasy. */
function udaje({ csrf, term, values, errors, legalVersion, settings, summary }) {
  const freeHours = cancellation.freeHours(settings);
  const accepted = settings.acceptedIdDocs || 'občanský průkaz, cestovní pas nebo řidičský průkaz';
  const retention = Number(settings.idDocRetentionDays) || 30;
  return {
    title: 'Rezervace – vaše údaje',
    body: html`
${stepHeader(2, 'Vaše údaje', 'Potřebujeme jen to, co je nutné k rezervaci a smlouvě. Údaje ukládáme šifrovaně.')}
<section class="section section--step"><div class="container step-layout">
  <div class="step-main">
    ${termLine(term)}
    ${Object.keys(errors).length ? c.notice('Bez vyplnění označených polí a potvrzení obou povinných souhlasů nelze pokračovat.', 'danger') : ''}
    ${c.form({
      action: '/rezervace/udaje',
      method: 'post',
      csrf,
      attrs: { 'data-consent-form': true, novalidate: true },
      children: [
        c.field({ label: 'Jméno a příjmení', name: 'jmeno', type: 'text', value: values.jmeno, required: true, error: errors.jmeno, autocomplete: 'name', maxlength: 100 }),
        c.field({ label: 'E-mail', name: 'email', type: 'email', value: values.email, required: true, error: errors.email, autocomplete: 'email', maxlength: 200, hint: 'Pošleme sem potvrzení, odkaz na správu rezervace a připomínku den před vyzvednutím.' }),
        c.field({ label: 'Telefon', name: 'telefon', type: 'tel', value: values.telefon, required: true, error: errors.telefon, autocomplete: 'tel', maxlength: 40, hint: 'Pro případ změny nebo problému s kolem.' }),
        html`<fieldset class="consents"><legend class="consents__title">Povinná potvrzení</legend>
          ${c.field({
            label: html`Souhlasím s <a href="/podminky" target="_blank" rel="noopener">obchodními podmínkami</a> (verze ${legalVersion}) a beru na vědomí poučení: rezervace kol na konkrétní termín je službou v určeném čase, u které podle § 1837 písm. j) občanského zákoníku <strong>nelze odstoupit od smlouvy ve 14denní lhůtě</strong>; platí storno pravidla – zrušení nejméně ${freeHours} hodin před začátkem = vrácení celého rezervačního poplatku, později nebo při nevyzvednutí poplatek propadá.`,
            name: 'souhlas_op',
            type: 'checkbox',
            value: '1',
            checked: values.souhlas_op,
            required: true,
            error: errors.souhlas_op,
            attrs: { 'data-required-consent': true },
          })}
          ${c.field({
            label: html`<strong>Beru na vědomí, že při převzetí předložím platný doklad totožnosti a půjčovna si zapíše jeho typ a číslo. Bez toho kolo nelze vydat.</strong>`,
            name: 'souhlas_doklad',
            type: 'checkbox',
            value: '1',
            checked: values.souhlas_doklad,
            required: true,
            error: errors.souhlas_doklad,
            attrs: { 'data-required-consent': true },
            hint: html`<details class="consent-details"><summary>Proč to požadujeme a co s údaji děláme</summary>
              <ul>
                <li><strong>Ověření totožnosti a platnosti dokladu.</strong> Přijímáme ${accepted}. Číslo dokladu obsluha ověří v <a href="https://aplikace.mvcr.cz/neplatne-doklady/" rel="noopener" target="_blank">Databázi neplatných dokladů Ministerstva vnitra ČR</a> – kolo nevydáme na odcizený či neplatný doklad.</li>
                <li><strong>Ochrana kol před krádeží.</strong> Krádeže jízdních kol patří v ČR k nejčastějším majetkovým trestným činům; zápis dokladu je podmínkou, bez které půjčovna kola v hodnotě desítek tisíc korun nemůže vydat, a umožňuje vymáhat případnou škodu.</li>
                <li><strong>Co ukládáme:</strong> jen typ a číslo dokladu, šifrovaně, do předávacího protokolu. Nikdy nepořizujeme kopie ani skeny. Údaj automaticky mažeme ${format.plural(retention, 'den', 'dny', 'dní')} po vypořádání pronájmu. Podrobnosti v <a href="/soukromi" target="_blank" rel="noopener">zásadách ochrany osobních údajů</a>.</li>
              </ul></details>`,
          })}
        </fieldset>`,
        c.field({ label: 'Chci dostávat občasné tipy na výlety a novinky půjčovny e-mailem (nepovinné, lze kdykoli odvolat).', name: 'marketing', type: 'checkbox', value: '1', checked: values.marketing }),
      ],
      submit: 'Pokračovat k poplatku',
    })}
  </div>
  <aside class="step-side">
    ${summary ? summaryCard(summary, { title: 'Vaše rezervace' }) : ''}
  </aside>
</div></section>`,
  };
}

/** Souhrn položek (karta vpravo / krok 4). summary = { items, accessories, totalMinor, feeMinor, depositMinor, term } */
function summaryCard(summary, { title = 'Souhrn', showFee = true } = {}) {
  return html`<div class="info-card summary-card">
  <h2 class="info-card__title">${title}</h2>
  <p class="info-card__text">${format.dateTime(summary.term.fromAt)} – ${format.dateTime(summary.term.toAt)} (${format.plural(summary.term.days, 'den', 'dny', 'dní')})</p>
  <ul class="summary-card__items">${summary.items.map((it) => html`<li>${it.qty}× ${it.typeName} <small>vel. ${it.size}</small><span class="summary-card__amount">${format.money(it.amountMinor)}</span></li>`)}${summary.accessories.map((a) => html`<li>${a.qty}× ${a.label}<span class="summary-card__amount">${format.money(a.amountMinor)}</span></li>`)}</ul>
  ${c.summary([
    ['Cena pronájmu', format.money(summary.totalMinor)],
    showFee ? { label: 'Rezervační poplatek nyní', value: format.money(summary.feeMinor), strong: true } : null,
    ['Doplatek při převzetí', format.money(Math.max(0, summary.totalMinor - summary.feeMinor))],
    ['Vratná kauce při převzetí', format.money(summary.depositMinor)],
  ].filter(Boolean))}
</div>`;
}

/** Krok 4 – poplatek a volba metody. */
function poplatek({ csrf, term, summary, demo, providerAvailable, allowPayOnSite, notice, noticeTone, reservation }) {
  const fee = summary.feeMinor;
  return {
    title: 'Rezervace – rezervační poplatek',
    body: html`
${stepHeader(3, 'Rezervační poplatek', `Zaplacením poplatku ${format.money(fee)} pro vás termín závazně zablokujeme. Poplatek se započítá do ceny pronájmu.`)}
<section class="section section--step"><div class="container step-layout">
  <div class="step-main">
    ${termLine(term)}
    ${notice ? c.notice(notice, noticeTone || 'warning') : ''}
    ${reservation ? c.notice(html`Rezervace <strong>č. ${reservation.number}</strong> je založena a čeká na poplatek${reservation.expires_at ? html` do <strong>${format.dateTime(reservation.expires_at)}</strong>` : ''}. Vyberte způsob platby.`, 'info') : ''}
    ${!providerAvailable ? c.notice(html`<strong>Online platba se připravuje.</strong> Platební brána a QR platba budou k dispozici v dalším kroku vývoje dema.${demo ? ' Pro ukázku průchodu můžete zaplacení poplatku simulovat.' : ''}`, 'info') : ''}
    <div class="pay-methods">
      ${c.form({
        action: '/rezervace/poplatek',
        method: 'post',
        csrf,
        attrs: { class: 'form pay-method' },
        children: html`<input type="hidden" name="metoda" value="karta"><div class="pay-method__body">${c.icon('card')}<h2 class="pay-method__title">Platební karta</h2><p class="pay-method__text">Okamžité potvrzení. Přesměrujeme vás na platební bránu${demo ? ' (v demu simulační stránka)' : ''}.</p></div>${c.button({ label: `Zaplatit kartou ${format.money(fee)}`, type: 'submit', variant: 'primary', disabled: !providerAvailable })}`,
      })}
      ${c.form({
        action: '/rezervace/poplatek',
        method: 'post',
        csrf,
        attrs: { class: 'form pay-method' },
        children: html`<input type="hidden" name="metoda" value="prevod"><div class="pay-method__body">${c.icon('shield')}<h2 class="pay-method__title">Převod / QR Platba</h2><p class="pay-method__text">Zobrazíme IBAN, částku, variabilní symbol a QR kód. Rezervaci držíme do přijetí platby (${format.plural(Number(summary.transferExpiryHours) || 48, 'hodinu', 'hodiny', 'hodin')}).</p></div>${c.button({ label: 'Zaplatit převodem', type: 'submit', variant: 'secondary' })}`,
      })}
      <div class="form pay-method${allowPayOnSite ? '' : ' is-disabled'}">
        ${allowPayOnSite
          ? c.form({ action: '/rezervace/poplatek', method: 'post', csrf, children: html`<input type="hidden" name="metoda" value="misto"><div class="pay-method__body">${c.icon('pin')}<h2 class="pay-method__title">Zaplatím na místě</h2><p class="pay-method__text">Rezervace bez garance – půjčovna může kola přednostně vydat platícím zákazníkům.</p></div>${c.button({ label: 'Rezervovat bez poplatku', type: 'submit', variant: 'ghost' })}` })
          : html`<div class="pay-method__body">${c.icon('pin')}<h2 class="pay-method__title">Zaplatím na místě</h2><p class="pay-method__text">Tato půjčovna platbu poplatku na místě nenabízí: bez uhrazeného poplatku nemůže kola na termín závazně blokovat. Online rezervace se potvrzuje až zaplacením.</p></div>${c.button({ label: 'Není k dispozici', variant: 'ghost', disabled: true })}`}
      </div>
      ${demo
        ? c.form({
            action: '/rezervace/poplatek',
            method: 'post',
            csrf,
            attrs: { class: 'form pay-method pay-method--demo' },
            children: html`<input type="hidden" name="metoda" value="demo"><div class="pay-method__body">${c.badge('DEMO', 'warning')}<h2 class="pay-method__title">Simulovat zaplacení poplatku (demo)</h2><p class="pay-method__text">Jen v ukázkovém režimu: označí poplatek ${format.money(fee)} jako zaplacený, žádné peníze se nepřevádějí.</p></div>${c.button({ label: 'Simulovat zaplacení poplatku (demo)', type: 'submit', variant: 'secondary' })}`,
          })
        : ''}
    </div>
    <p class="step-back"><a href="/rezervace/udaje">‹ Zpět k údajům</a></p>
  </div>
  <aside class="step-side">${summaryCard(summary, { title: 'Souhrn rezervace' })}</aside>
</div></section>`,
  };
}

/** Pokyny k převodu (po volbě „převod“). payment: { amountMinor, iban, accountNumber, vs, spayd, qrSvg, expiresAt } */
function prevod({ reservation, payment, token, tenant, notice }) {
  const manage = `/rezervace/${encodeURIComponent(token)}`;
  return {
    title: 'Rezervace – platba převodem',
    noindex: true,
    body: html`
${stepHeader(3, 'Platba převodem', `Rezervace č. ${reservation.number} je založena. Po připsání platby ji potvrdíme e-mailem.`)}
<section class="section section--step"><div class="container step-layout">
  <div class="step-main">
    ${notice ? c.notice(notice, 'info') : ''}
    ${bankInstructions({ reservation, payment, tenant })}
    <p class="step-actions">${c.button({ label: 'Pokračovat na potvrzení', href: `/rezervace/hotovo/${encodeURIComponent(token)}`, variant: 'primary' })} ${c.button({ label: 'Správa rezervace', href: manage, variant: 'ghost' })}</p>
  </div>
  <aside class="step-side"><div class="info-card"><h2 class="info-card__title">Co bude dál</h2><p class="info-card__text">Platbu párujeme podle variabilního symbolu${payment.expiresAt ? html`; rezervaci držíme do <strong>${format.dateTime(payment.expiresAt)}</strong>` : ''}. Jakmile dorazí, pošleme potvrzení a doklad. Stav sledujte na stránce správy rezervace.</p></div></aside>
</div></section>`,
  };
}

function bankInstructions({ reservation, payment, tenant }) {
  const b = tenant.business || {};
  const iban = payment.iban || b.iban || '';
  return html`<div class="bank-box">
  <div class="bank-box__data">
    ${c.summary([
      ['Částka', html`<strong>${format.money(payment.amountMinor)}</strong>`],
      ['IBAN', html`<code>${iban}</code>`],
      b.accountNumber ? ['Číslo účtu', html`<code>${b.accountNumber}</code>${b.bankName ? html` <small>(${b.bankName})</small>` : ''}`] : null,
      ['Variabilní symbol', html`<code>${payment.vs || reservation.number}</code>`],
      ['Zpráva pro příjemce', `Rezervace ${reservation.number}`],
      payment.expiresAt ? ['Uhradit do', format.dateTime(payment.expiresAt)] : null,
    ].filter(Boolean))}
  </div>
  <div class="bank-box__qr">
    ${payment.qrSvg ? html`<div class="bank-box__qr-img" role="img" aria-label="QR Platba ${format.money(payment.amountMinor)}, VS ${payment.vs || reservation.number}">${raw(payment.qrSvg)}</div><p class="bank-box__qr-hint">Naskenujte v bankovní aplikaci (QR Platba).</p>` : html`<div class="bank-box__qr-placeholder">${c.icon('card')}<p>QR kód se připravuje – použijte údaje vlevo.</p></div>`}
    ${payment.spayd ? html`<p class="bank-box__spayd"><small>SPAYD: <code>${payment.spayd}</code></small></p>` : ''}
  </div>
</div>`;
}

/** Krok 5 – hotovo. */
function hotovo({ reservation, detail, token, tenant, settings }) {
  const manage = `/rezervace/${encodeURIComponent(token)}`;
  const awaiting = reservation.status === 'awaiting_fee';
  const accepted = settings.acceptedIdDocs || 'občanský průkaz, cestovní pas nebo řidičský průkaz';
  return {
    title: `Rezervace č. ${reservation.number}`,
    noindex: true,
    body: html`
${stepHeader(4, awaiting ? 'Rezervace založena – čeká na poplatek' : 'Rezervace potvrzena', `Číslo rezervace ${reservation.number}. Potvrzení jsme poslali e-mailem${awaiting ? ' včetně pokynů k platbě' : ' spolu s dokladem o přijaté platbě'}.`)}
<section class="section section--step"><div class="container step-layout">
  <div class="step-main">
    ${awaiting ? c.notice(html`Rezervace bude potvrzena po přijetí rezervačního poplatku ${format.money(reservation.fee_minor)}${reservation.expires_at ? html` – nejpozději do <strong>${format.dateTime(reservation.expires_at)}</strong>` : ''}. Zaplatit můžete i později ze <a href="${manage}">správy rezervace</a>.`, 'warning') : c.notice(html`Poplatek ${format.money(reservation.paid_minor)} je zaplacen a termín je pro vás zablokovaný. ${statusBadge(reservation.status)}`, 'success')}
    <div class="done-grid">
      <div class="info-card">
        <h2 class="info-card__title">Co vzít s sebou</h2>
        <ul class="checklist">
          <li><strong>Platný doklad totožnosti</strong> (${accepted}) – zapíšeme typ a číslo, bez dokladu kolo nevydáme.</li>
          <li>Vratnou kauci ${format.money(reservation.deposit_minor)} (hotově, kartou na terminálu nebo preautorizací karty).</li>
          <li>Doplatek ${format.money(detail.balanceMinor)} – při převzetí nebo předem online.</li>
          <li>Pohodlné oblečení; přilby a zámky máme pro vás připravené.</li>
        </ul>
      </div>
      <div class="info-card">
        <h2 class="info-card__title">Správa rezervace</h2>
        <p class="info-card__text">Odkaz máte i v e-mailu. Najdete tam stav, platby, doklady a storno s výpočtem podle ${cancellation.freeHours(settings)}hodinového pravidla.</p>
        <p class="info-card__actions">${c.button({ label: 'Otevřít správu rezervace', href: manage, variant: 'primary' })} ${c.button({ label: 'Přidat do kalendáře (ICS)', href: `${manage}/kalendar.ics`, variant: 'secondary', attrs: { download: `rezervace-${reservation.number}.ics` } })}</p>
      </div>
    </div>
  </div>
  <aside class="step-side">${summaryCard({ term: { fromAt: reservation.from_at, toAt: reservation.to_at, days: detail.days }, items: detail.items, accessories: detail.accessories, totalMinor: reservation.total_minor, feeMinor: reservation.fee_minor, depositMinor: reservation.deposit_minor }, { title: `Rezervace č. ${reservation.number}` })}</aside>
</div></section>`,
  };
}

/** Správa rezervace přes token. */
function sprava({ reservation, detail, token, csrf, quote, tenant, settings, demo, providerAvailable, notice, noticeTone, pendingTransfer, errors = {} }) {
  const r = reservation;
  const manage = `/rezervace/${encodeURIComponent(token)}`;
  const cancellable = ['awaiting_fee', 'confirmed'].includes(r.status);
  const awaiting = r.status === 'awaiting_fee';
  return {
    title: `Rezervace č. ${r.number}`,
    noindex: true,
    body: html`
<section class="section section--page-head"><div class="container">
  <p class="section__eyebrow">Správa rezervace</p>
  <h1 class="section__title">Rezervace č. ${r.number} ${statusBadge(r.status)}</h1>
  <p class="section__lead">${format.dateTime(r.from_at)} – ${format.dateTime(r.to_at)} · ${tenant.name}${tenant.business && tenant.business.address ? html`, ${tenant.business.address}` : ''}</p>
</div></section>
<section class="section section--manage"><div class="container manage">
  <div class="manage__main">
    ${notice ? c.notice(notice, noticeTone || 'info') : ''}
    ${awaiting
      ? html`<div class="manage__block">
      <h2>Rezervační poplatek</h2>
      ${c.notice(html`Rezervace čeká na úhradu poplatku <strong>${format.money(r.fee_minor)}</strong>${r.expires_at ? html` do <strong>${format.dateTime(r.expires_at)}</strong>` : ''}. Po jeho přijetí termín závazně zablokujeme.`, 'warning')}
      ${pendingTransfer ? bankInstructions({ reservation: r, payment: pendingTransfer, tenant }) : ''}
      <div class="pay-methods pay-methods--inline">
        ${c.form({ action: `${manage}/zaplatit`, method: 'post', csrf, attrs: { class: 'form pay-method' }, children: html`<input type="hidden" name="metoda" value="karta"><div class="pay-method__body"><h3 class="pay-method__title">Platební karta</h3></div>${c.button({ label: `Zaplatit kartou ${format.money(r.fee_minor)}`, type: 'submit', variant: 'primary', disabled: !providerAvailable })}` })}
        ${!pendingTransfer ? c.form({ action: `${manage}/zaplatit`, method: 'post', csrf, attrs: { class: 'form pay-method' }, children: html`<input type="hidden" name="metoda" value="prevod"><div class="pay-method__body"><h3 class="pay-method__title">Převod / QR</h3></div>${c.button({ label: 'Zobrazit údaje k převodu', type: 'submit', variant: 'secondary' })}` }) : ''}
        ${demo ? c.form({ action: `${manage}/zaplatit`, method: 'post', csrf, attrs: { class: 'form pay-method pay-method--demo' }, children: html`<input type="hidden" name="metoda" value="demo"><div class="pay-method__body">${c.badge('DEMO', 'warning')}<h3 class="pay-method__title">Simulovat zaplacení poplatku (demo)</h3></div>${c.button({ label: 'Simulovat zaplacení poplatku (demo)', type: 'submit', variant: 'secondary' })}` }) : ''}
      </div>
      ${!providerAvailable ? c.notice('Online platba se připravuje – platební brána a QR platba budou doplněny v dalším kroku vývoje dema.', 'info') : ''}
    </div>`
      : ''}
    <div class="manage__block">
      <h2>Položky</h2>
      ${c.table({
        head: ['Kolo', 'Velikost', 'Počet', 'Cena'],
        rows: [
          ...detail.items.map((it) => [{ value: html`<a href="/kola/${it.typeSlug}">${it.typeName}</a>`, header: true }, it.size, { value: String(it.qty), align: 'right' }, { value: format.money(it.amountMinor), align: 'right' }]),
          ...detail.accessories.map((a) => [{ value: a.label, header: true }, '–', { value: String(a.qty), align: 'right' }, { value: format.money(a.amountMinor), align: 'right' }]),
        ],
      })}
      ${c.summary([
        ['Cena pronájmu', format.money(r.total_minor)],
        ['Rezervační poplatek', format.money(r.fee_minor)],
        ['Zaplaceno', format.money(r.paid_minor)],
        { label: 'Zbývá doplatit', value: format.money(detail.balanceMinor), strong: true },
        ['Vratná kauce při převzetí', format.money(r.deposit_minor)],
      ])}
    </div>
    <div class="manage__block">
      <h2>Platby</h2>
      ${detail.payments.length
        ? c.table({ head: ['Datum', 'Účel', 'Metoda', 'Částka', 'Stav'], rows: detail.payments.map((p) => [format.dateTime(p.created_at), PAYMENT_LABELS[p.purpose] || p.purpose, METHOD_LABELS[p.method] || p.method, { value: format.money(p.amount_minor), align: 'right' }, c.badge(PAYMENT_STATUS[p.status] || p.status, ['paid', 'captured', 'refunded', 'released'].includes(p.status) ? 'success' : ['failed', 'expired'].includes(p.status) ? 'danger' : 'warning')]) })
        : html`<p class="manage__empty">Zatím žádné platby.</p>`}
    </div>
    <div class="manage__block">
      <h2>Pohyby (ledger)</h2>
      ${detail.ledger.length
        ? c.table({ head: ['Datum', 'Pohyb', 'Částka', 'Poznámka'], rows: detail.ledger.map((l) => [format.dateTime(l.created_at), LEDGER_LABELS[l.type] || l.type, { value: format.money(l.amount_minor), align: 'right' }, l.note || '']) })
        : html`<p class="manage__empty">Zatím žádné pohyby.</p>`}
    </div>
    <div class="manage__block">
      <h2>Doklady</h2>
      ${detail.documents.length
        ? html`<ul class="doc-list">${detail.documents.map((d) => html`<li><a href="/doklady/${encodeURIComponent(d.number)}">${DOC_LABELS[d.type] || d.type} ${d.number}</a> <small>(${format.date(d.issued_at)})</small></li>`)}</ul>`
        : html`<p class="manage__empty">Doklady se vystaví po přijetí platby a při výdeji kol.</p>`}
    </div>
    ${cancellable
      ? html`<div class="manage__block manage__block--cancel" id="storno">
      <h2>Zrušení rezervace</h2>
      <p>${cancellation.describe(quote)}</p>
      ${quote.rule === 'free' && quote.paidMinor > 0 ? html`<p class="manage__hint">Bezplatné zrušení je možné do <strong>${format.dateTime(quote.deadlineAt)}</strong>.</p>` : ''}
      ${c.form({
        action: `${manage}/storno`,
        method: 'post',
        csrf,
        attrs: { class: 'form cancel-form' },
        children: [
          c.field({
            label: quote.forfeitMinor > 0 ? html`Rozumím, že rezervační poplatek <strong>${format.money(quote.forfeitMinor)}</strong> propadá, a chci rezervaci zrušit.` : html`Chci rezervaci č. ${r.number} zrušit${quote.refundMinor > 0 ? html` a rozumím, že poplatek ${format.money(quote.refundMinor)} bude vrácen původní platební metodou` : ''}.`,
            name: 'potvrdit',
            type: 'checkbox',
            value: '1',
            required: true,
            error: errors.potvrdit,
          }),
        ],
        submit: 'Zrušit rezervaci',
        submitVariant: 'danger',
      })}
    </div>`
      : ''}
  </div>
  <aside class="manage__side">
    <div class="info-card">
      <h2 class="info-card__title">Rychlé odkazy</h2>
      <p class="info-card__actions"><a class="btn btn--secondary" href="${manage}/kalendar.ics" download="rezervace-${r.number}.ics">Přidat do kalendáře (ICS)</a> <a class="btn btn--ghost" href="/kontakt">Kontaktovat půjčovnu</a></p>
      <p class="info-card__text">Vyzvednutí: ${format.dateTime(r.from_at)}<br>Vrácení: ${format.dateTime(r.to_at)}<br>Vezměte s sebou platný doklad totožnosti.</p>
    </div>
    ${detail.mails.length ? html`<div class="info-card"><h2 class="info-card__title">Odeslané e-maily</h2><ul class="mail-list">${detail.mails.map((m) => html`<li>${m.subject} <small>(${format.dateTime(m.created_at)})</small></li>`)}</ul></div>` : ''}
  </aside>
</div></section>`,
  };
}

module.exports = { STEP_ITEMS, PAYMENT_LABELS, METHOD_LABELS, LEDGER_LABELS, DOC_LABELS, stepHeader, termin, kola, udaje, poplatek, prevod, hotovo, sprava, summaryCard, bankInstructions, statusBadge };
