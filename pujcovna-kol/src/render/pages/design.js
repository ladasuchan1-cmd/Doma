'use strict';
// Stránka: /design (feature design, jen demo) – galerie všech komponent s ukázkovými daty a popis tří designů.
// Vstup: { tenant, theme, themes, csrf, settings }. Výstup: Html tělo.

const { html } = require('../html');
const c = require('../components');

const SAMPLE_TYPES = [
  { slug: 'trek-fx-2', name: 'Trekové kolo Trek FX 2', category: 'trek', sizes: ['S', 'M', 'L', 'XL'], photos: [], from_price_minor: 39000 },
  { slug: 'rockhopper', name: 'Horské kolo Specialized Rockhopper', category: 'mtb', sizes: ['M', 'L'], photos: [], from_price_minor: 45000 },
  { slug: 'cube-touring-hybrid', name: 'Elektrokolo Cube Touring Hybrid', category: 'ebike', sizes: ['S', 'M', 'L'], photos: [], from_price_minor: 89000 },
];

function block(title, children, note) {
  return html`<section class="gallery__block">
  <h3 class="gallery__title">${title}</h3>
  ${note ? html`<p class="gallery__note">${note}</p>` : ''}
  <div class="gallery__demo">${children}</div>
</section>`;
}

function design({ theme, themes, csrf }) {
  const today = new Date();
  const days = Array.from({ length: 14 }, (_, i) => new Date(today.getTime() + i * 86400000).toISOString().slice(0, 10));
  return html`
${c.hero({
  eyebrow: 'Demo musteru',
  title: 'Tři designy, jeden web',
  text: 'Stejné HTML, stejné komponenty a data – jiné tokeny, fonty a layoutové varianty. Přepněte design a prohlédněte si, jak se mění každá komponenta.',
  cta: 'Zpět na domovskou stránku',
  ctaHref: '/',
  secondaryCta: 'Administrace',
  secondaryHref: '/admin',
})}

${c.section({
  variant: 'designs',
  title: 'Tři designy',
  lead: 'Subdoména určuje výchozí design (outdoor., sport., family.ksprehledy.cz); v demu ho přepíná cookie z tohoto přepínače.',
  children: html`${c.grid(
    Object.entries(themes).map(
      ([name, t]) => html`<article class="card card--design${name === theme ? ' is-active' : ''}">
  <div class="card__body">
    ${c.badge(name === theme ? 'Aktivní' : t.hint, name === theme ? 'success' : 'info')}
    <h3 class="card__title">${t.label}</h3>
    <p class="card__text">${t.description}</p>
    <dl class="summary">
      <div class="summary__row"><dt>Hero</dt><dd>${t.hero}</dd></div>
      <div class="summary__row"><dt>Navigace</dt><dd>${t.nav}</dd></div>
      <div class="summary__row"><dt>Karty</dt><dd>${t.cards}</dd></div>
      <div class="summary__row"><dt>Fonty</dt><dd>${t.fonts.display} · ${t.fonts.body}${t.fonts.accent ? ` · ${t.fonts.accent}` : ''}</dd></div>
    </dl>
    ${c.button({ label: name === theme ? 'Používá se' : `Přepnout na ${t.label}`, href: `/design/nastavit?design=${name}&zpet=/design`, variant: name === theme ? 'ghost' : 'primary', disabled: name === theme })}
  </div>
</article>`
    ),
    3
  )}
  ${c.notice(html`Administrace běží na <a href="/admin">/admin</a> – <strong>demo přístup viz přihlašovací stránka</strong>. Všechny platby jsou simulované, e-maily se ukládají do outboxu.`, 'info')}`,
})}

${c.section({
  variant: 'gallery',
  title: 'Galerie komponent',
  lead: 'Každá komponenta používá jen třídy ze specifikace; téma ji styluje přes CSS proměnné.',
  children: html`
${block('Tlačítka', html`<div class="gallery__row">
  ${c.button({ label: 'Primární', variant: 'primary' })} ${c.button({ label: 'Sekundární', variant: 'secondary' })} ${c.button({ label: 'Ghost', variant: 'ghost' })} ${c.button({ label: 'Nebezpečné', variant: 'danger' })}
</div><div class="gallery__row">
  ${c.button({ label: 'Malé', variant: 'primary', size: 'sm' })} ${c.button({ label: 'Velké', variant: 'primary', size: 'lg' })} ${c.button({ label: 'S ikonou', variant: 'secondary', iconName: 'calendar' })} ${c.button({ label: 'Neaktivní', variant: 'primary', disabled: true })}
</div>`)}

${block('Odznaky a stavy', html`<div class="gallery__row">${c.badge('Horské')} ${c.badge('Potvrzeno', 'success')} ${c.badge('Čeká na platbu', 'warning')} ${c.badge('Stornováno', 'danger')} ${c.badge('Vydáno', 'info')}</div>`)}

${block('Upozornění', html`${c.notice('Informace: rezervační poplatek se při řádném využití započítá na nájemné.', 'info')}
${c.notice('Rezervace byla potvrzena. Potvrzení jsme poslali e-mailem.', 'success')}
${c.notice('Zrušení méně než 48 h před začátkem – poplatek propadá.', 'warning')}
${c.notice('Kolo mezitím někdo rezervoval. Vyberte prosím jiný termín nebo velikost.', 'danger')}`)}

${block('Cenovka', html`<div class="gallery__row">${c.price(39000, 'den', { prefix: 'od' })} ${c.price(89000, 'den')} ${c.price(30000)} ${c.price(1250050)}</div>`)}

${block('Karty kol', c.grid(SAMPLE_TYPES.map((t, i) => c.bikeCard(t, { price: t.from_price_minor, available: i === 1 ? 0 : 3 })), 3), 'Bez fotek se zobrazí zástupná ikona; fotky dodá agent tématu / demo data.')}

${block('Kroky', html`${c.steps(['Termín', 'Kola', 'Údaje', 'Poplatek', 'Hotovo'], 2)}`)}

${block('Formulář', c.form({
  action: '/design',
  method: 'post',
  csrf,
  attrs: { 'aria-label': 'Ukázkový formulář (neodesílá se)' },
  children: [
    c.field({ label: 'Jméno a příjmení', name: 'demo_jmeno', type: 'text', value: 'Jana Nováková', required: true, autocomplete: 'off' }),
    c.field({ label: 'E-mail', name: 'demo_email', type: 'email', value: 'jana@example.com', required: true, hint: 'Pošleme sem potvrzení rezervace.' }),
    c.field({ label: 'Telefon', name: 'demo_tel', type: 'tel', value: '', error: 'Zadejte prosím telefon ve tvaru +420 …' }),
    c.field({ label: 'Velikost', name: 'demo_vel', type: 'select', value: 'M', options: ['S', 'M', 'L', 'XL'] }),
    c.field({ label: 'Počet kol', name: 'demo_pocet', type: 'number', value: 2, min: 1, max: 10 }),
    c.field({ label: 'Poznámka', name: 'demo_pozn', type: 'textarea', value: '', hint: 'Nepovinné.' }),
    c.field({ label: html`Souhlasím s <a href="/podminky">obchodními podmínkami</a>.`, name: 'demo_op', type: 'checkbox', required: true }),
    c.field({ label: 'Beru na vědomí, že při převzetí předložím platný doklad totožnosti a půjčovna si zapíše jeho typ a číslo. Bez toho kolo nelze vydat.', name: 'demo_doklad', type: 'checkbox', required: true, checked: true }),
  ],
  submit: 'Odeslat (ukázka)',
}), 'Formulář je jen ukázka – odeslání vrátí 405.')}

${block('Kalendář termínu', c.calendarRange({ name: 'termin', min: days[0], blocked: [days[3], { from: days[7], to: days[8] }] }), 'Bez JS funguje jako dvě pole typu datum; s JS se vykreslí mřížka a blokované dny z data-blocked.')}

${block('Tabulka', c.table({
  caption: 'Ceník – Trekové kolo Trek FX 2',
  head: ['Délka', 'Cena za den', 'Celkem'],
  rows: [
    ['1 den', { value: '390 Kč', align: 'right' }, { value: '390 Kč', align: 'right' }],
    ['2–3 dny', { value: '350 Kč', align: 'right' }, { value: 'od 700 Kč', align: 'right' }],
    ['4–6 dní', { value: '320 Kč', align: 'right' }, { value: 'od 1 280 Kč', align: 'right' }],
    ['7 a více dní', { value: '290 Kč', align: 'right' }, { value: 'od 2 030 Kč', align: 'right' }],
  ],
}))}

${block('Souhrn', c.summary([
  ['Termín', '12. 7. – 14. 7. 2026'],
  ['Kola', '2× Trekové kolo Trek FX 2 (M, L)'],
  ['Příslušenství', '2× přilba'],
  ['Cena celkem', '1 600 Kč'],
  { label: 'Rezervační poplatek nyní', value: '600 Kč', strong: true },
]))}

${block('Záložky', c.tabs([
  { label: 'Všechna kola', href: '/kola', active: true, count: 6 },
  { label: 'Trekové', href: '/kola?kategorie=trek' },
  { label: 'Horské', href: '/kola?kategorie=mtb' },
  { label: 'Elektrokola', href: '/kola?kategorie=ebike' },
]))}

${block('Timeline (admin)', c.timeline({
  days,
  rows: [
    { label: 'Trekové kolo Trek FX 2', bars: [{ fromIndex: 0, toIndex: 1, status: 'checked_out', label: '2607000101' }, { fromIndex: 3, toIndex: 5, status: 'confirmed', label: '2607000104' }, { fromIndex: 9, toIndex: 9, status: 'awaiting_fee', label: '2607000110' }] },
    { label: 'Elektrokolo Cube Touring Hybrid', bars: [{ fromIndex: 1, toIndex: 4, status: 'confirmed', label: '2607000102' }, { fromIndex: 6, toIndex: 7, status: 'cancelled_by_customer', label: '2607000107' }] },
    { label: 'Dětské kolo Woom 4', bars: [{ fromIndex: 2, toIndex: 2, status: 'returned', label: '2607000103' }] },
  ],
}))}

${block('Kontaktní karta', c.contactCard({ legalName: 'U Tří dubů s.r.o.', address: 'Masarykovo nám. 1, 379 01 Třeboň', phone: '+420 000 000 000', email: 'info@ksprehledy.cz', ico: '00000000' }, { mon: ['09:00', '18:00'], tue: ['09:00', '18:00'], wed: ['09:00', '18:00'], thu: ['09:00', '18:00'], fri: ['09:00', '18:00'], sat: ['08:00', '19:00'], sun: ['08:00', '19:00'] }))}

${block('Zajímavost a trasa', c.grid([
  c.poiCard({ name: 'Rybník Svět', type: 'rybník', distanceKm: 1.2, summary: 'Rybník na jižním okraji Třeboně, založený Jakubem Krčínem v 16. století. Po hrázi vede naučná stezka.', wikipediaUrl: 'https://cs.wikipedia.org/wiki/Sv%C4%9Bt_(rybn%C3%ADk)', image: null }),
  c.routeCard({ nazev: 'Okruh kolem Světa', ref: '1034', sit: 'rcn', druh: 'cyklotrasa', delkaKm: 12.4, gpxHref: '/mapa/gpx/ukazka.gpx', href: '/mapa' }),
], 2), 'Fotky zajímavostí doplní agent mapy včetně attribution (autor, licence, zdroj).')}
  `,
})}
`;
}

module.exports = { design, SAMPLE_TYPES };
