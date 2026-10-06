'use strict';
// Admin → Nastavení (jen owner; SPEC kap. 13): poplatek, storno lhůta, buffer, otevírací doba, zavírací dny, brána (mock),
// banka (mock), DPH, varianty právních textů (klíče settings pro legalParams), lhůty retence, uživatelé.
// Admin → Účet (všichni): změna hesla, 2FA s QR otpauth:// a ověřením kódu.
// Vstup: data z features/admin.js (settings = efektivní nastavení). Výstup: Html.

const s = require('./shared');
const { html, raw, c, format } = s;

const DAYS = format.DAY_KEYS;

/** Volby selectů právních variant (hodnoty čte legalParams ve features/pravni.js). */
const LEGAL_OPTIONS = Object.freeze({
  accountingMode: [
    { value: '', label: 'automaticky podle právní formy (s. r. o. = účetnictví)' },
    { value: 'ucetnictvi', label: 'účetnictví' },
    { value: 'danova-evidence', label: 'daňová evidence' },
  ],
  signatureMode: [
    { value: 'obrazovka', label: 'na obrazovce (elektronicky, protokol e-mailem)' },
    { value: 'papir', label: 'na papíře (dvě vyhotovení)' },
  ],
  idDocPrint: [
    { value: 'maskovane', label: 'maskované (jen poslední znaky)' },
    { value: 'plne', label: 'celé číslo dokladu' },
  ],
});

/**
 * Karta „Právní texty – varianty“: klíče settings, kterými legalParams (feature pravni) přepíná bloky v OP, Zásadách,
 * záznamu o činnostech a smlouvě. Hodnoty se projeví okamžitě na /podminky, /soukromi, /reklamace; změna samotného
 * znění dokumentů (ne hodnot) = nová legal.version v tenant.json.
 */
function legalCard({ settings, csrf }) {
  const st = settings || {};
  return s.card({
    id: 'pravni',
    title: 'Právní texty – varianty',
    actions: html`<a class="btn btn--ghost btn--sm" href="/podminky" target="_blank" rel="noopener">Podmínky</a><a class="btn btn--ghost btn--sm" href="/soukromi" target="_blank" rel="noopener">Ochrana osobních údajů</a>`,
    children: s.form({
      action: '/admin/nastaveni',
      csrf,
      children: html`<input type="hidden" name="sekce" value="pravni">
      <p class="small muted">Přepínače doplňují nebo skrývají odstavce obchodních podmínek, zásad ochrany osobních údajů, záznamu o činnostech zpracování a smlouvy. Projeví se ihned; nová verze podmínek (datum účinnosti) se vydává až při změně samotného znění.</p>
      <h3 class="admin-card__subtitle">Doklady a podpis</h3>
      <div class="admin-grid admin-grid--3">
        ${c.field({ label: 'Vedení evidence', name: 'accounting_mode', type: 'select', value: st.accountingMode || '', options: LEGAL_OPTIONS.accountingMode, hint: 'Určuje lhůty uchování dokladů v Zásadách.' })}
        ${c.field({ label: 'Podpis smlouvy a protokolů', name: 'signature_mode', type: 'select', value: st.signatureMode || 'obrazovka', options: LEGAL_OPTIONS.signatureMode })}
        ${c.field({ label: 'Číslo dokladu totožnosti na výtisku', name: 'id_doc_print', type: 'select', value: st.idDocPrint || 'maskovane', options: LEGAL_OPTIONS.idDocPrint })}
      </div>
      <div class="admin-grid admin-grid--3">
        ${c.field({ label: 'Vyžadujeme druhý doklad totožnosti', name: 'second_id_doc', type: 'checkbox', checked: !!st.secondIdDoc })}
        ${c.field({ label: 'Zapisujeme datum narození a adresu bydliště', name: 'record_birth_address', type: 'checkbox', checked: !!st.recordBirthAddress })}
        ${c.field({ label: 'Kola mají GPS lokátor (sledování polohy)', name: 'gps_trackers', type: 'checkbox', checked: !!st.gpsTrackers })}
      </div>
      <h3 class="admin-card__subtitle">Platby a pojištění</h3>
      <div class="admin-grid admin-grid--3">
        ${c.field({ label: 'Pojišťovna (kola pojištěna u)', name: 'insurance', value: st.insurance || '', maxlength: 120, hint: 'Prázdné = kola nejsou pojištěna pro případ škody způsobené nájemcem.' })}
        ${s.moneyField({ label: 'Poplatek za nabití e-kola (Kč)', name: 'charging_flat', valueMinor: st.chargingFlatMinor ?? 0, hint: '0 = nabití neúčtujeme.' })}
        ${c.field({ label: 'Poskytovatel platebního terminálu', name: 'terminal_provider', value: st.terminalProvider || '', maxlength: 80, hint: 'Prázdné = terminál neuvádíme.' })}
        ${c.field({ label: 'Účetní / daňový poradce (název)', name: 'accountant_name', value: st.accountantName || '', maxlength: 120, hint: 'Prázdné = externí účetní neuvádíme.' })}
        ${c.field({ label: 'Role účetního', name: 'accountant_role', value: st.accountantRole || '', maxlength: 60, placeholder: 'zpracovatel' })}
      </div>
      <div class="admin-grid admin-grid--3">
        ${c.field({ label: 'Doplatek je nutné uhradit před převzetím', name: 'balance_before_pickup', type: 'checkbox', checked: !!st.balanceBeforePickup })}
        ${c.field({ label: 'Při dřívějším vrácení vracíme poměrnou část nájemného', name: 'early_return_refund', type: 'checkbox', checked: !!st.earlyReturnRefund })}
      </div>
      <h3 class="admin-card__subtitle">Analytika a předávání údajů</h3>
      <div class="admin-grid admin-grid--3">
        ${c.field({ label: 'Analytický nástroj (cookies)', name: 'analytics_tool', value: st.analyticsTool || '', maxlength: 80, hint: 'Prázdné = web bez cookie lišty (jen technické cookies).' })}
        ${c.field({ label: 'Poskytovatel analytiky', name: 'analytics_provider', value: st.analyticsProvider || '', maxlength: 120 })}
        ${c.field({ label: 'Tabulka analytických cookies (markdown)', name: 'analytics_cookies_table', type: 'textarea', rows: 4, value: st.analyticsCookiesTable || '', maxlength: 4000, hint: 'Volitelně: | Název | Účel | Doba | – vloží se do Zásad.' })}
      </div>
      <div class="admin-grid admin-grid--3">
        ${c.field({ label: 'Předáváme údaje mimo EU / EHP', name: 'transfer_outside_eu', type: 'checkbox', checked: !!st.transferOutsideEu })}
        ${c.field({ label: 'Popis předávání mimo EU (komu, záruky)', name: 'transfer_outside_eu_text', type: 'textarea', rows: 3, value: st.transferOutsideEuText || '', maxlength: 2000 })}
      </div>`,
      submit: 'Uložit právní varianty',
      submitVariant: 'secondary',
    }),
  });
}

function nastaveni({ settings, openingHours, closures, users, me, csrf, gateways, matchers }) {
  const fee = settings.feeMinor || {};
  const dep = settings.depositMinor || {};
  const canc = settings.cancellation || {};
  return html`
${s.card({
    title: 'Rezervace a platby',
    children: s.form({
      action: '/admin/nastaveni',
      csrf,
      children: html`<input type="hidden" name="sekce" value="rezervace">
      <div class="admin-grid admin-grid--3">
        ${s.moneyField({ label: 'Rezervační poplatek za kolo (Kč)', name: 'fee_default', valueMinor: fee.default ?? 30000, required: true })}
        ${s.moneyField({ label: 'Rezervační poplatek za elektrokolo (Kč)', name: 'fee_ebike', valueMinor: fee.ebike ?? fee.default ?? 50000, required: true })}
        ${c.field({ label: 'Storno zdarma nejméně (hodin před začátkem)', name: 'free_hours', type: 'number', value: canc.freeHoursBefore ?? 48, min: 0, step: 1, required: true })}
        ${c.field({ label: 'Buffer mezi pronájmy (minut)', name: 'buffer', type: 'number', value: settings.bufferMinutes ?? 60, min: 0, step: 5, required: true })}
        ${c.field({ label: 'Lhůta úhrady převodem (hodin)', name: 'transfer_hours', type: 'number', value: settings.transferExpiryHours ?? 48, min: 1, step: 1, required: true })}
        ${c.field({ label: 'Max. délka preautorizace kauce (dní)', name: 'preauth_days', type: 'number', value: settings.preauthMaxDays ?? 7, min: 1, max: 30, step: 1, required: true })}
        ${c.field({ label: 'Nejdelší pronájem online (dní)', name: 'max_days', type: 'number', value: settings.maxRentalDays ?? 30, min: 1, step: 1, required: true })}
        ${s.moneyField({ label: 'Tolerance párování převodu (Kč)', name: 'tolerance', valueMinor: settings.paymentToleranceMinor ?? 500 })}
        ${c.field({ label: 'Sazba DPH (%)', name: 'vat_rate', type: 'number', value: settings.vatRate ?? 21, min: 0, max: 100, step: 1, required: true })}
        ${c.field({ label: 'Platební brána', name: 'gateway', type: 'select', value: settings.gateway || 'mock', options: gateways })}
        ${c.field({ label: 'Párování banky', name: 'bank_matcher', type: 'select', value: settings.bankMatcher || 'fio-mock', options: matchers })}
        ${c.field({ label: 'Akceptované doklady (text do OP)', name: 'accepted_docs', value: settings.acceptedIdDocs || '', maxlength: 120 })}
      </div>
      ${c.field({ label: 'Povolit platbu poplatku až na místě (rezervace bez garance)', name: 'allow_on_site', type: 'checkbox', checked: !!settings.allowPayOnSite })}
      ${dep.default !== undefined ? '' : ''}`,
      submit: 'Uložit',
    }),
  })}
${legalCard({ settings, csrf })}
<div class="admin-grid admin-grid--2">
${s.card({
    title: 'Lhůty uchování (retence)',
    children: s.form({
      action: '/admin/nastaveni',
      csrf,
      children: html`<input type="hidden" name="sekce" value="retence">
      <div class="admin-grid admin-grid--2">
        ${c.field({ label: 'Číslo dokladu totožnosti (dní po vrácení)', name: 'id_doc_days', type: 'number', value: settings.idDocRetentionDays ?? 30, min: 1, step: 1, required: true, hint: 'Po uplynutí se číslo automaticky maže (job).' })}
        ${c.field({ label: 'Nedokončené rezervace (dní)', name: 'reservation_days', type: 'number', value: settings.reservationRetentionDays ?? 90, min: 1, step: 1, required: true })}
        ${c.field({ label: 'Smlouvy a protokoly (let)', name: 'contract_years', type: 'number', value: settings.contractRetentionYears ?? 3, min: 1, step: 1, required: true })}
        ${c.field({ label: 'Logy (dní)', name: 'log_days', type: 'number', value: settings.logRetentionDays ?? 365, min: 1, step: 1, required: true })}
      </div>`,
      submit: 'Uložit lhůty',
      submitVariant: 'secondary',
    }),
  })}
${s.card({
    title: 'Otevírací doba',
    children: s.form({
      action: '/admin/nastaveni',
      csrf,
      children: html`<input type="hidden" name="sekce" value="oteviraci">
      <p class="small muted">Prázdný čas = zavřeno. Výchozí hodnoty jsou z tenant.json; uložené nastavení (settings.openingHours) je nadřazené.</p>
      ${s.tableWrap(html`<table class="table table--compact"><thead><tr><th scope="col">Den</th><th scope="col">Otevřeno od</th><th scope="col">do</th></tr></thead><tbody>${DAYS.map(
        (d) => html`<tr><th scope="row">${format.DAY_LABELS_LONG[d]}</th><td><label class="visually-hidden" for="oh-${d}-0">Od</label><input class="field__input field__input--sm" id="oh-${d}-0" name="oh_${d}_from" type="time" step="1800" value="${(openingHours[d] || [])[0] || ''}"></td><td><label class="visually-hidden" for="oh-${d}-1">Do</label><input class="field__input field__input--sm" id="oh-${d}-1" name="oh_${d}_to" type="time" step="1800" value="${(openingHours[d] || [])[1] || ''}"></td></tr>`
      )}</tbody></table>`)}`,
      submit: 'Uložit otevírací dobu',
      submitVariant: 'secondary',
    }),
  })}
</div>
${s.card({
    title: 'Zavírací dny',
    children: html`${s.table({
      head: ['Od', 'Do', 'Důvod', { label: '', sort: false }],
      rows: closures.map((cl) => [s.date(cl.date_from), s.date(cl.date_to), cl.reason || '–', s.actionButton({ action: `/admin/nastaveni/zavreno/${cl.id}/smazat`, csrf, label: 'Smazat', variant: 'danger', confirm: 'Smazat zavírací den?' })]),
      empty: 'Žádné zavírací dny.',
      sortable: false,
    })}
    ${s.form({
      action: '/admin/nastaveni/zavreno',
      csrf,
      children: html`<div class="admin-grid admin-grid--3">${c.field({ label: 'Od', name: 'date_from', type: 'date', required: true })}${c.field({ label: 'Do', name: 'date_to', type: 'date', required: true })}${c.field({ label: 'Důvod', name: 'reason', maxlength: 80 })}</div>`,
      submit: 'Přidat zavírací dny',
      submitVariant: 'secondary',
    })}`,
  })}
${s.card({
    title: 'Uživatelé',
    children: html`${s.table({
      head: ['E-mail', 'Jméno', 'Role', '2FA', 'Stav', 'Poslední přihlášení', { label: '', sort: false }],
      rows: users.map((u) => [
        u.email,
        u.name,
        s.ROLE_LABELS[u.role] || u.role,
        u.totp_enabled ? c.badge('zapnuto', 'success') : html`<span class="muted">ne</span>`,
        u.disabled ? c.badge('zablokován', 'danger') : u.locked_until && Date.parse(u.locked_until) > Date.now() ? c.badge(`uzamčen do ${format.time(u.locked_until)}`, 'warning') : c.badge('aktivní', 'success'),
        u.last_login_at ? s.dt(u.last_login_at) : html`<span class="muted">nikdy</span>`,
        html`<form class="form form--inline" method="post" action="/admin/nastaveni/uzivatele/${u.id}"><input type="hidden" name="_csrf" value="${csrf}">
          <label class="visually-hidden" for="role-${u.id}">Role</label><select class="field__input field__input--select field__input--sm" id="role-${u.id}" name="role"${u.id === me.id ? raw(' disabled') : ''}>${Object.entries(s.ROLE_LABELS).map(([v, l]) => html`<option value="${v}"${v === u.role ? raw(' selected') : ''}>${l}</option>`)}</select>
          <label class="visually-hidden" for="pw-${u.id}">Nové heslo</label><input class="field__input field__input--sm" id="pw-${u.id}" name="password" type="password" placeholder="nové heslo" autocomplete="new-password" minlength="10">
          ${c.button({ label: 'Uložit', type: 'submit', variant: 'secondary', size: 'sm', name: 'akce', value: 'ulozit' })}
          ${u.failed_logins || u.locked_until ? c.button({ label: 'Odemknout', type: 'submit', variant: 'ghost', size: 'sm', name: 'akce', value: 'odemknout' }) : ''}
          ${u.id !== me.id ? c.button({ label: u.disabled ? 'Povolit' : 'Zablokovat', type: 'submit', variant: u.disabled ? 'ghost' : 'danger', size: 'sm', name: 'akce', value: u.disabled ? 'povolit' : 'zablokovat' }) : ''}
          ${u.totp_enabled && u.id !== me.id ? c.button({ label: 'Vypnout 2FA', type: 'submit', variant: 'ghost', size: 'sm', name: 'akce', value: 'vypnout-2fa' }) : ''}
        </form>`,
      ]),
      sortable: false,
    })}
    <h3 class="admin-card__subtitle">Nový uživatel</h3>
    ${s.form({
      action: '/admin/nastaveni/uzivatele',
      csrf,
      children: html`<div class="admin-grid admin-grid--3">${c.field({ label: 'E-mail', name: 'email', type: 'email', required: true, autocomplete: 'off' })}${c.field({ label: 'Jméno', name: 'name', required: true, maxlength: 80 })}${c.field({ label: 'Role', name: 'role', type: 'select', value: 'staff', options: Object.entries(s.ROLE_LABELS).map(([value, label]) => ({ value, label })) })}${c.field({ label: 'Heslo (min. 10 znaků)', name: 'password', type: 'password', required: true, autocomplete: 'new-password', minlength: 10 })}</div><p class="small muted">Dvoufázové ověření si každý uživatel zapíná sám na stránce <a href="/admin/ucet">Účet</a>.</p>`,
      submit: 'Přidat uživatele',
      submitVariant: 'secondary',
    })}`,
  })}`;
}

/** Vlastní účet: heslo, 2FA. setup = { secret, otpauth, qrSvg } když se 2FA právě zapíná. */
function ucet({ me, csrf, setup, issuer }) {
  return html`
<div class="admin-grid admin-grid--2">
${s.card({
    title: 'Změna hesla',
    children: s.form({
      action: '/admin/ucet/heslo',
      csrf,
      children: html`${c.field({ label: 'Současné heslo', name: 'stare', type: 'password', required: true, autocomplete: 'current-password' })}${c.field({ label: 'Nové heslo (min. 10 znaků)', name: 'nove', type: 'password', required: true, autocomplete: 'new-password', minlength: 10 })}${c.field({ label: 'Nové heslo znovu', name: 'nove2', type: 'password', required: true, autocomplete: 'new-password', minlength: 10 })}`,
      submit: 'Změnit heslo',
      submitVariant: 'secondary',
    }),
  })}
${s.card({
    id: '2fa',
    title: 'Dvoufázové ověření (TOTP)',
    children: me.totp_enabled
      ? html`${c.notice('2FA je zapnuté – při přihlášení se po hesle vyžaduje kód z autentikátoru.', 'success')}
      ${s.form({ action: '/admin/ucet/2fa/vypnout', csrf, children: c.field({ label: 'Aktuální kód z autentikátoru', name: 'kod', inputmode: 'numeric', required: true, autocomplete: 'one-time-code' }), submit: 'Vypnout 2FA', submitVariant: 'danger', confirm: 'Vypnout dvoufázové ověření?' })}`
      : setup
        ? html`<p>1. Naskenujte QR kód v aplikaci (Google Authenticator, Aegis, 1Password…), nebo zadejte klíč ručně. 2. Zadejte vygenerovaný kód.</p>
      <div class="admin-2fa">
        <div class="admin-2fa__qr">${raw(setup.qrSvg)}</div>
        <div><p class="small">Klíč: <code class="admin-2fa__secret">${setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code><br><small class="muted">Vydavatel: ${issuer} · účet: ${me.email} · SHA-1, 6 číslic, 30 s</small></p>
        ${s.form({ action: '/admin/ucet/2fa', csrf, children: c.field({ label: 'Kód z autentikátoru', name: 'kod', inputmode: 'numeric', required: true, autocomplete: 'one-time-code', pattern: '[0-9 ]{6,7}' }), submit: 'Ověřit a zapnout 2FA' })}
        <p class="small"><a href="/admin/ucet">Zrušit</a></p></div>
      </div>`
        : html`<p>2FA je vypnuté. Doporučujeme zapnout – zejména pro účet s rolí majitel.</p><p><a class="btn btn--primary" href="/admin/ucet/2fa">Zapnout 2FA</a></p>`,
  })}
</div>`;
}

module.exports = { nastaveni, ucet, LEGAL_OPTIONS };
