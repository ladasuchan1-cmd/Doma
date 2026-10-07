'use strict';
// Stránky správy platformy (/platforma) a průvodce pro nového klienta (/zalozeni/:token). Vstup: data z
// src/features/klienti.js, výstup Html těla stránek. Třídy pr-* stylované v public/css/klienti.css jen přes tokeny.
//   platformLogin, platformDashboard, inviteCreated          správa platformy
//   wizardIntro, wizardStep (podle kroku), wizardDone, wizardBlocked   průvodce

const { html, attr } = require('../html');
const c = require('../components');
const format = require('../format');
const { THEMES } = require('../../themes');
const { STAV_LABELS, STAVY } = require('../../klienti');

const KROKY = Object.freeze([
  { id: 'provozovna', label: 'Provozovna' },
  { id: 'adresa', label: 'Adresa webu' },
  { id: 'vzhled', label: 'Vzhled' },
  { id: 'kola', label: 'Kola' },
  { id: 'provoz', label: 'Provoz a ceny' },
  { id: 'ucet', label: 'Účet správce' },
  { id: 'kontrola', label: 'Kontrola' },
]);

const kc = (n) => format.money(Math.round(Number(n) || 0) * 100);
const v = (o, k) => (o && o[k] !== undefined && o[k] !== null ? o[k] : '');

// ---------------------------------------------------------------------------------------------------------
// Správa platformy

function platformLogin({ csrf, error }) {
  return c.section({
    variant: 'page-head',
    title: 'Správa platformy',
    titleTag: 'h1',
    lead: 'Pozvánky do průvodce pro nové půjčovny a přehled založených webů. Přístup jen pro provozovatele.',
    children: html`${error ? c.notice(error, 'danger') : ''}${c.form({
      action: '/platforma/prihlaseni',
      csrf,
      attrs: { class: 'form pr-login' },
      children: [c.field({ label: 'Heslo platformy', name: 'heslo', type: 'password', required: true, autocomplete: 'current-password' })],
      submit: 'Přihlásit',
    })}`,
  });
}

function inviteRow(i, csrf) {
  const stav = { platna: ['platná', 'success'], vyprsela: ['vypršela', 'warning'], pouzita: ['použitá', 'info'], zrusena: ['zrušená', 'neutral'] }[i.stav] || [i.stav, 'neutral'];
  return [
    html`<strong>${i.nazev || '–'}</strong><br><small class="pr-muted">${i.email || 'bez e-mailu'}</small>`,
    html`${c.badge(stav[0], stav[1])}${i.rozpracovano ? html` <small class="pr-muted">rozpracováno</small>` : ''}`,
    html`<small>${format.dateTime(i.createdAt)}<br>platí do ${format.date(i.expiresAt)}</small>`,
    i.tenantSlug ? html`<a href="#klient-${i.tenantSlug}">${i.tenantSlug}</a>` : '',
    i.stav === 'platna'
      ? html`<form method="post" action="/platforma/pozvanky/${i.id}/zrusit" class="pr-inline"><input type="hidden" name="_csrf" value="${csrf}"><button class="btn btn--ghost btn--sm" type="submit">Zrušit</button></form>`
      : '',
  ];
}

function clientRow(k, csrf) {
  return [
    html`<strong id="klient-${k.slug}">${k.nazev}</strong><br><a href="https://${k.host}" rel="noopener" target="_blank">${k.host}</a>`,
    html`<small>${format.dateTime(k.createdAt)}</small><br><small class="pr-muted">${k.email}</small>`,
    html`<form method="post" action="/platforma/klienti/${k.slug}/stav" class="pr-inline">
  <input type="hidden" name="_csrf" value="${csrf}">
  <label class="visually-hidden" for="stav-${k.slug}">Stav webu ${k.nazev}</label>
  <select class="field__input field__input--select" id="stav-${k.slug}" name="stav">${STAVY.map((s) => html`<option${attr({ value: s, selected: s === k.stav })}>${STAV_LABELS[s]}</option>`)}</select>
  <button class="btn btn--secondary btn--sm" type="submit">Uložit</button>
</form>`,
  ];
}

/** data: { csrf, invites[], clients[], prefill: {email, nazev, poznamka}, flash, domena, notice } */
function platformDashboard({ csrf, invites, clients, prefill = {}, flash, domena }) {
  return html`
${c.section({
    variant: 'page-head',
    title: 'Správa platformy',
    titleTag: 'h1',
    lead: `Nové weby vznikají na adrese <název>.${domena}. Klient dostane odkaz do průvodce, vyplní údaje a web se spustí v náhledovém provozu.`,
    children: html`${flash ? c.notice(flash.text, flash.tone || 'success') : ''}
<p class="pr-links"><a href="/nabidka#priklady">Modelové propočty s naší marží</a> · <a href="/admin/nabidky">Poptávky z konfigurátoru</a> <small class="nab-muted">(marže a nákupní ceny vidíte jen s tímto přihlášením)</small></p>
<form method="post" action="/platforma/odhlaseni" class="pr-inline pr-logout"><input type="hidden" name="_csrf" value="${csrf}"><button class="btn btn--ghost btn--sm" type="submit">Odhlásit</button></form>`,
  })}
${c.section({
    id: 'nova-pozvanka',
    title: 'Nová pozvánka do průvodce',
    lead: 'Odkaz platí 14 dní a jde použít jednou. Pošlete ho e-mailem nebo zprávou – po vytvoření se zobrazí jen jednou.',
    children: c.form({
      action: '/platforma/pozvanky',
      csrf,
      attrs: { class: 'form pr-invite' },
      children: [
        html`<div class="pr-grid">`,
        c.field({ label: 'Název ubytování / půjčovny', name: 'nazev', value: prefill.nazev, required: true, maxlength: 120 }),
        c.field({ label: 'E-mail klienta', name: 'email', type: 'email', value: prefill.email, required: true, maxlength: 200, autocomplete: 'off' }),
        html`</div>`,
        c.field({ label: 'Poznámka (jen pro nás)', name: 'poznamka', type: 'textarea', rows: 2, value: prefill.poznamka, maxlength: 500 }),
      ],
      submit: 'Vytvořit pozvánku',
    }),
  })}
${c.section({
    id: 'klienti',
    title: `Weby klientů (${clients.length})`,
    lead: 'Náhledový provoz: web běží, platby jsou simulované a stránky nesou pruh „náhledový provoz“. Ostrý provoz zapněte až po podpisu smlouvy a nastavení plateb.',
    children: clients.length ? c.table({ head: ['Web', 'Založen', 'Stav'], rows: clients.map((k) => clientRow(k, csrf)) }) : c.notice('Zatím žádný klient – vytvořte pozvánku výše.', 'info'),
  })}
${c.section({
    id: 'pozvanky',
    title: 'Pozvánky',
    children: invites.length ? c.table({ head: ['Klient', 'Stav', 'Vytvořena', 'Web', ''], rows: invites.map((i) => inviteRow(i, csrf)) }) : c.notice('Zatím žádná pozvánka.', 'info'),
  })}`;
}

/** data: { link, email, nazev, expiresAt, mailto } */
function inviteCreated({ link, email, nazev, expiresAt, mailto }) {
  return c.section({
    variant: 'page-head',
    title: 'Pozvánka je připravená',
    titleTag: 'h1',
    lead: `Pošlete odkaz klientovi ${nazev ? `(${nazev})` : ''}. Platí do ${format.date(expiresAt)} a jde použít jednou. Znovu se už nezobrazí – v databázi je jen jeho otisk.`,
    children: html`<div class="pr-link">
  <label class="field__label" for="pr-odkaz">Odkaz do průvodce</label>
  <input class="field__input pr-link__input" id="pr-odkaz" type="text" readonly value="${link}">
</div>
<p class="pr-actions">${c.button({ label: email ? `Otevřít e-mail pro ${email}` : 'Otevřít e-mail', href: mailto, variant: 'primary' })} ${c.button({ label: 'Zpět na přehled', href: '/platforma', variant: 'ghost' })}</p>
<p class="pr-muted">Kopie e-mailu je i ve frontě e-mailů (v administraci Půjčovny → E-maily), dokud nebude zapojené automatické odesílání.</p>`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Průvodce

function stepNav(token, activeIndex, done) {
  return html`<nav class="pr-steps" aria-label="Kroky průvodce">${stepList(token, activeIndex, done)}</nav>`;
}

function stepList(token, activeIndex, done) {
  return c.steps(
    KROKY.map((k, i) => ({ label: k.label, href: done[k.id] || i < activeIndex ? `/zalozeni/${token}/${k.id}` : undefined })),
    activeIndex,
    { links: true }
  );
}

function wizardIntro({ token, nazev, firstStep, rozpracovano }) {
  return html`${c.section({
    variant: 'page-head',
    eyebrow: 'Průvodce založením webu',
    title: nazev ? `Vítejte, ${nazev}` : 'Vítejte',
    titleTag: 'h1',
    lead: 'Za zhruba 10 minut založíte vlastní web půjčovny kol s online rezervacemi. Rozpracovaný průvodce se ukládá – můžete se k odkazu kdykoli vrátit.',
    children: html`<ol class="pr-intro-list">${KROKY.map((k) => html`<li>${k.label}</li>`)}</ol>
<div class="pr-intro-need">
  <h2 class="pr-subtitle">Co budete potřebovat</h2>
  <ul class="nab-list nab-list--bullets">
    <li>IČO, sídlo a kontaktní údaje provozovatele půjčovny,</li>
    <li>adresu, kde se kola vydávají (stačí odkaz z Mapy.cz),</li>
    <li>logo v PNG nebo JPG (nepovinné) a představu o cenách za den,</li>
    <li>e-mail a heslo pro správce webu.</li>
  </ul>
</div>
<p class="pr-actions">${c.button({ label: rozpracovano ? 'Pokračovat v průvodci' : 'Začít', href: `/zalozeni/${token}/${firstStep}`, variant: 'primary', size: 'lg' })}</p>
<p class="pr-muted">Web se spustí v náhledovém provozu: všechno funguje, jen platby jsou zatím zkušební. Ostrý provoz zapneme po podpisu smlouvy.</p>`,
  })}`;
}

function wrapStep({ token, index, done, title, lead, csrf, errors, children, multipart, submit = 'Pokračovat', back }) {
  const hasErr = errors && Object.keys(errors).length;
  return html`${c.section({
    variant: 'page-head',
    eyebrow: `Krok ${index + 1} ze ${KROKY.length}`,
    title,
    titleTag: 'h1',
    lead,
    children: stepNav(token, index, done),
  })}
<div class="container pr-step">
  ${hasErr ? c.notice(errors._form || 'Formulář obsahuje chyby – zkontrolujte prosím označená pole.', 'danger') : ''}
  ${c.form({
    action: `/zalozeni/${token}/${KROKY[index].id}`,
    csrf,
    attrs: { class: 'form pr-form', ...(multipart ? { enctype: 'multipart/form-data' } : {}) },
    children: html`${children}
<div class="form__actions pr-form__actions">${back ? c.button({ label: 'Zpět', href: back, variant: 'ghost' }) : ''}${c.button({ label: submit, type: 'submit', variant: 'primary' })}</div>`,
  })}
</div>`;
}

function stepProvozovna({ d = {}, e = {} }) {
  return html`<div class="pr-grid">
${c.field({ label: 'Název na webu', name: 'nazev', value: v(d, 'nazev'), required: true, maxlength: 80, error: e.nazev, hint: 'Jak vás znají hosté, např. „Hotel U Tří dubů“.' })}
${c.field({ label: 'Obchodní firma / jméno podnikatele', name: 'firma', value: v(d, 'firma'), required: true, maxlength: 120, error: e.firma, hint: 'Jak je v rejstříku, např. „U Tří dubů s.r.o.“ – objeví se v obchodních podmínkách.' })}
${c.field({ label: 'IČO', name: 'ico', value: v(d, 'ico'), required: true, inputmode: 'numeric', maxlength: 8, error: e.ico })}
${c.field({ label: 'DIČ', name: 'dic', value: v(d, 'dic'), maxlength: 12, error: e.dic, hint: 'Jen pro plátce DPH, např. CZ12345678.' })}
</div>
${c.field({ label: 'Jsme plátci DPH', name: 'platceDph', type: 'checkbox', checked: !!d.platceDph })}
<div class="pr-grid">
${c.field({ label: 'Sídlo', name: 'sidlo', value: v(d, 'sidlo'), required: true, maxlength: 200, error: e.sidlo, autocomplete: 'street-address' })}
${c.field({ label: 'Kde se kola vydávají', name: 'provozovna', value: v(d, 'provozovna'), maxlength: 200, error: e.provozovna, hint: 'Nevyplníte-li, platí sídlo.' })}
${c.field({ label: 'E-mail pro hosty', name: 'email', type: 'email', value: v(d, 'email'), required: true, maxlength: 200, error: e.email, autocomplete: 'email' })}
${c.field({ label: 'Telefon', name: 'telefon', type: 'tel', value: v(d, 'telefon'), required: true, maxlength: 30, error: e.telefon, autocomplete: 'tel' })}
${c.field({ label: 'Kdo jedná za firmu', name: 'zastupce', value: v(d, 'zastupce'), maxlength: 120, error: e.zastupce, hint: 'Např. „Jana Nováková, jednatelka“.' })}
${c.field({ label: 'Váš stávající web', name: 'web', value: v(d, 'web'), maxlength: 200, error: e.web, hint: 'Podle něj navrhneme adresu, např. utridubu.cz → utridubu.' })}
${c.field({ label: 'Číslo účtu pro platby převodem', name: 'ucet', value: v(d, 'ucet'), maxlength: 30, error: e.ucet, hint: 'Ve tvaru 19-2000145399/0800. Z něj se tvoří QR platby.' })}
${c.field({ label: 'Banka', name: 'banka', value: v(d, 'banka'), maxlength: 80, error: e.banka })}
</div>`;
}

function stepAdresa({ d = {}, e = {}, domena, navrh }) {
  return html`<div class="pr-grid">
${c.field({ label: `Adresa webu (název.${domena})`, name: 'slug', value: v(d, 'slug') || navrh || '', required: true, maxlength: 30, pattern: '[a-z][a-z0-9-]{1,28}[a-z0-9]', error: e.slug, hint: html`Malá písmena bez diakritiky, číslice a pomlčka, 3–30 znaků. Web poběží na <strong>${v(d, 'slug') || navrh || 'nazev'}.${domena}</strong>.` })}
${c.field({ label: 'Poloha výdeje kol', name: 'poloha', value: v(d, 'polohaText'), required: true, maxlength: 400, error: e.poloha, hint: 'Vložte odkaz z Mapy.cz nebo Google Map, nebo souřadnice „49.0035, 14.7708“. Podle ní se ukáže mapa tras a zajímavostí v okolí.' })}
</div>
<p class="pr-muted">Na svém stávajícím webu pak jen přidáte odkaz nebo tlačítko „Půjčit kolo“ – nic dalšího se nepropojuje.</p>`;
}

function stepVzhled({ d = {}, e = {}, maLogo }) {
  const choices = Object.entries(THEMES).map(
    ([id, t]) => html`<label class="pr-theme${(v(d, 'design') || 'outdoor') === id ? ' is-checked' : ''}">
  <input class="pr-theme__input" type="radio" name="design" value="${id}"${attr({ checked: (v(d, 'design') || 'outdoor') === id, required: true })}>
  <span class="pr-theme__title">${t.label}</span>
  <span class="pr-theme__hint">${t.hint}</span>
  <a class="pr-theme__preview" href="/?design=${id}" target="_blank" rel="noopener">Ukázka</a>
</label>`
  );
  return html`<fieldset class="pr-themes"><legend class="field__label">Design webu <span class="field__required" aria-hidden="true">*</span></legend>${choices}</fieldset>
${e.design ? html`<p class="field__error">${e.design}</p>` : ''}
<div class="pr-grid">
${c.field({ label: 'Logo (PNG, JPG nebo WebP, nejvýš 1 MB)', name: 'logo', type: 'file', error: e.logo, attrs: { accept: 'image/png,image/jpeg,image/webp' }, hint: maLogo ? 'Logo je nahrané. Nový soubor ho nahradí.' : 'Bez loga se použije jednoduchá ikona kola a název.' })}
${maLogo ? c.field({ label: 'Odstranit nahrané logo', name: 'smazatLogo', type: 'checkbox' }) : ''}
${c.field({ label: 'Krátký slogan', name: 'claim', value: v(d, 'claim'), maxlength: 80, error: e.claim, hint: 'Např. „Kola, která vás vezmou dál“.' })}
${c.field({ label: 'Nadpis úvodní stránky', name: 'nadpis', value: v(d, 'nadpis'), maxlength: 90, error: e.nadpis })}
</div>
${c.field({ label: 'Úvodní text', name: 'text', type: 'textarea', rows: 3, value: v(d, 'text'), maxlength: 300, error: e.text, hint: 'Jedna dvě věty pro hosty. Texty můžete kdykoli změnit v administraci.' })}`;
}

function stepKola({ d = {}, e = {}, modely }) {
  const volby = new Map(((d && d.volby) || []).map((x) => [x.slug, x]));
  const rows = modely.map((m) => {
    const x = volby.get(m.slug) || {};
    const def = m.pujcovna && Array.isArray(m.pujcovna.den) ? m.pujcovna.den[0] : 500;
    return html`<article class="pr-bike">
  <div class="pr-bike__body">
    <h3 class="pr-bike__title">${m.znacka} ${m.model}</h3>
    <p class="pr-muted">${m.popis}</p>
    <p class="pr-bike__meta">Velikosti ${(m.velikosti || []).join(', ')} · kauce ${kc(m.pujcovna ? m.pujcovna.kauce : 0)}</p>
  </div>
  <div class="pr-bike__fields">
    ${c.field({ label: 'Počet kusů', name: `pocet_${m.slug}`, type: 'number', value: x.pocet ?? 0, min: 0, max: 50, step: 1, inputmode: 'numeric', error: e[`pocet_${m.slug}`] })}
    ${c.field({ label: 'Cena za den (Kč)', name: `cena_${m.slug}`, type: 'number', value: x.cenaDen ?? def, min: 50, max: 5000, step: 10, inputmode: 'numeric', error: e[`cena_${m.slug}`] })}
  </div>
</article>`;
  });
  return html`${e.kola ? c.notice(e.kola, 'warning') : ''}<div class="pr-bikes">${rows}</div>
<p class="pr-muted">Ceny na více dní (2–3, 4–6 a 7+ dní), hodinu a půlden dopočítáme ve stejném poměru jako v ukázce – vše upravíte v administraci v Ceníku. Další typy kol přidáte tamtéž.</p>`;
}

function stepProvoz({ d = {}, e = {} }) {
  return html`<fieldset class="pr-fieldset"><legend class="field__label">Otevírací doba výdeje</legend>
<div class="pr-grid pr-grid--4">
${c.field({ label: 'Po–Pá od', name: 'vsedniOd', type: 'time', value: v(d, 'vsedniOd') || '09:00', error: e.vsedniOd })}
${c.field({ label: 'Po–Pá do', name: 'vsedniDo', type: 'time', value: v(d, 'vsedniDo') || '18:00', error: e.vsedniDo })}
${c.field({ label: 'So–Ne od', name: 'vikendOd', type: 'time', value: v(d, 'vikendOd') || '08:00', error: e.vikendOd })}
${c.field({ label: 'So–Ne do', name: 'vikendDo', type: 'time', value: v(d, 'vikendDo') || '19:00', error: e.vikendDo })}
</div>
<p class="pr-muted">Necháte-li obě pole dne prázdná, je ten den zavřeno. Přesnější rozpis po dnech nastavíte v administraci.</p>
</fieldset>
<div class="pr-grid">
${c.field({ label: 'Rezervační poplatek za kolo (Kč)', name: 'poplatek', type: 'number', value: v(d, 'poplatek') || 300, min: 100, max: 1000, step: 10, error: e.poplatek })}
${c.field({ label: 'Rezervační poplatek za elektrokolo (Kč)', name: 'poplatekEkolo', type: 'number', value: v(d, 'poplatekEkolo') || 500, min: 100, max: 1500, step: 10, error: e.poplatekEkolo })}
</div>
<p class="pr-muted">Poplatek se započítá do nájemného. Zrušení nejpozději 48 hodin předem = poplatek vracíme celý; později propadá jako úplata za zajištění kola (stejně jako v obchodních podmínkách ukázky).</p>`;
}

function stepUcet({ d = {}, e = {}, token }) {
  return html`<div class="pr-grid">
${c.field({ label: 'Vaše jméno', name: 'jmeno', value: v(d, 'jmeno'), required: true, maxlength: 80, error: e.jmeno, autocomplete: 'name' })}
${c.field({ label: 'E-mail pro přihlášení do administrace', name: 'email', type: 'email', value: v(d, 'email'), required: true, maxlength: 200, error: e.email, autocomplete: 'username' })}
${c.field({ label: d.passwordHash ? 'Nové heslo (nevyplníte-li, zůstane uložené)' : 'Heslo', name: 'heslo', type: 'password', required: !d.passwordHash, error: e.heslo, autocomplete: 'new-password', hint: 'Alespoň 12 znaků. Ukládáme jen jeho otisk.' })}
${c.field({ label: 'Heslo znovu', name: 'heslo2', type: 'password', required: !d.passwordHash, error: e.heslo2, autocomplete: 'new-password' })}
</div>
${c.field({ label: html`Souhlasím se smlouvou o poskytování webu a se <a href="/zalozeni/${token}/zpracovatelska-smlouva" target="_blank" rel="noopener">zpracovatelskou smlouvou</a> (zpracování osobních údajů vašich hostů na našich serverech v EU).`, name: 'souhlas', type: 'checkbox', checked: !!d.souhlas, required: true, error: e.souhlas })}`;
}

function summaryRows(draft, { domena, modely }) {
  const p = draft.provozovna || {};
  const a = draft.adresa || {};
  const z = draft.vzhled || {};
  const k = (draft.kola && draft.kola.volby) || [];
  const pr = draft.provoz || {};
  const u = draft.ucet || {};
  const bySlug = new Map(modely.map((m) => [m.slug, m]));
  const day = (od, d) => (od && d ? `${od}–${d}` : 'zavřeno');
  return [
    ['Provozovna', html`${p.nazev}<br><small class="pr-muted">${p.firma}, IČO ${p.ico}${p.platceDph ? `, DIČ ${p.dic}` : ', neplátce DPH'} · ${p.sidlo}</small>`],
    ['Kontakt pro hosty', `${p.email} · ${p.telefon}`],
    ['Adresa webu', html`<strong>https://${a.slug}.${domena}</strong>`],
    ['Poloha výdeje', a.poloha ? `${a.poloha.lat}, ${a.poloha.lon}` : '–'],
    ['Design', html`${(THEMES[z.design] || {}).label || z.design}${z.logo ? ' · vlastní logo' : ' · výchozí ikona'}`],
    ['Kola', html`<ul class="nab-list">${k.filter((x) => x.pocet > 0).map((x) => html`<li>${x.pocet}× ${(bySlug.get(x.slug) || {}).model || x.slug} – ${kc(x.cenaDen)} / den</li>`)}</ul>`],
    ['Otevírací doba', `Po–Pá ${day(pr.vsedniOd, pr.vsedniDo)}, So–Ne ${day(pr.vikendOd, pr.vikendDo)}`],
    ['Rezervační poplatek', `${kc(pr.poplatek)} / kolo, ${kc(pr.poplatekEkolo)} / elektrokolo`],
    ['Správce webu', `${u.jmeno} (${u.email})`],
  ];
}

function stepKontrola({ draft, domena, modely }) {
  return html`${c.summary(summaryRows(draft, { domena, modely }))}
<p class="pr-muted">Po spuštění poběží web v náhledovém provozu: rezervace a administrace fungují, platby jsou zkušební a stránky to hostům říkají. Údaje, texty, ceny i kola můžete kdykoli změnit v administraci.</p>`;
}

/** data: { token, krok, index, done, csrf, errors, draft, d, domena, modely, navrh, maLogo } */
function wizardStep(data) {
  const { token, krok, index, done, csrf, errors = {}, d = {}, draft = {}, domena, modely, navrh, maLogo } = data;
  const back = index > 0 ? `/zalozeni/${token}/${KROKY[index - 1].id}` : `/zalozeni/${token}`;
  const map = {
    provozovna: { title: 'Kdo web provozuje', lead: 'Údaje se doplní do obchodních podmínek, smlouvy o nájmu a dokladů.', children: stepProvozovna({ d, e: errors }) },
    adresa: { title: 'Kde web poběží', lead: 'Adresa webu a místo, kde si hosté kola vyzvednou.', children: stepAdresa({ d, e: errors, domena, navrh }) },
    vzhled: { title: 'Jak bude web vypadat', lead: 'Vyberte jeden ze tří designů a nahrajte logo.', children: stepVzhled({ d, e: errors, maLogo }), multipart: true },
    kola: { title: 'Jaká kola půjčujete', lead: 'Zadejte počet kusů a cenu za den. Modely jsou z naší nabídky.', children: stepKola({ d, e: errors, modely }) },
    provoz: { title: 'Provoz a rezervační poplatek', lead: 'Kdy vydáváte kola a kolik hosté zaplatí při rezervaci.', children: stepProvoz({ d, e: errors }) },
    ucet: { title: 'Účet správce', lead: 'Tímto e-mailem a heslem se přihlásíte do administrace svého webu.', children: stepUcet({ d, e: errors, token }) },
    kontrola: { title: 'Zkontrolujte a spusťte', lead: 'Když vše sedí, web se spustí hned.', children: stepKontrola({ draft, domena, modely }), submit: 'Spustit web' },
  };
  const s = map[krok];
  return wrapStep({ token, index, done, csrf, errors, back, title: s.title, lead: s.lead, children: s.children, multipart: s.multipart, submit: s.submit });
}

/** data: { host, adminUrl, nazev, kusy } */
function wizardDone({ host, nazev, kusy }) {
  return c.section({
    variant: 'page-head',
    title: 'Hotovo – web běží',
    titleTag: 'h1',
    lead: `${nazev ? `${nazev}: ` : ''}web je založený${kusy ? ` s ${kusy} koly` : ''} a běží v náhledovém provozu. Zabezpečený certifikát pro novou adresu se vystaví zhruba do dvou minut.`,
    children: html`${c.steps(KROKY.map((k) => k.label).concat('Hotovo'), KROKY.length, { links: false })}
<ul class="nab-list nab-list--bullets pr-done">
  <li>Web pro hosty: <a href="https://${host}" rel="noopener">https://${host}</a></li>
  <li>Administrace: <a href="https://${host}/admin" rel="noopener">https://${host}/admin</a> – přihlaste se e-mailem a heslem z průvodce.</li>
  <li>Na svůj stávající web přidejte odkaz nebo tlačítko „Půjčit kolo“ vedoucí na adresu výše.</li>
  <li>Ostrý provoz s platbami zapneme po podpisu smlouvy – ozveme se.</li>
</ul>`,
  });
}

/** data: { title, text, tone, link } */
function wizardBlocked({ title, text, link }) {
  return c.section({ variant: 'page-head', title, titleTag: 'h1', lead: text, children: link ? html`<p class="pr-actions">${c.button({ label: link.label, href: link.href, variant: 'primary' })}</p>` : '' });
}

module.exports = { KROKY, platformLogin, platformDashboard, inviteCreated, wizardIntro, wizardStep, wizardDone, wizardBlocked, summaryRows };
