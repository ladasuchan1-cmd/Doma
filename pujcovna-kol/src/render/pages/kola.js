'use strict';
// Stránky feature „kola“ (SPEC kap. 8): /kola (filtry + karty), /kola/:slug (galerie, specifikace, velikosti s dostupností,
// ceník typu, poplatek a kauce, CTA Rezervovat), /cenik (všechny typy, sezóny, příslušenství, poplatek, kauce, storno).
// Vstupy jsou prostá data z src/features/kola.js; výstup Html tělo (nebo { title, description, body, jsonLd }).

const { html, raw } = require('../html');
const c = require('../components');
const format = require('../format');
const { TIER_LABELS, UNIT_LABELS } = require('../../domain/pricing');

const TIERS = [1, 2, 4, 7];

/** Fotka typu: první položka photos (řetězec nebo { src, alt, author, license, licenseUrl, sourceUrl }). */
function photoOf(photo) {
  if (!photo) return null;
  return typeof photo === 'string' ? { src: photo, alt: '' } : photo;
}

function attribution(photo) {
  if (!photo || (!photo.author && !photo.license)) return '';
  return html`<span class="attribution">Foto: ${photo.sourceUrl ? html`<a href="${photo.sourceUrl}" rel="noopener" target="_blank">${photo.author || 'Wikimedia Commons'}</a>` : photo.author || ''}${photo.license ? html`, ${photo.licenseUrl ? html`<a href="${photo.licenseUrl}" rel="noopener" target="_blank">${photo.license}</a>` : photo.license}` : ''}</span>`;
}

function termText(term) {
  if (!term) return '';
  return format.dateRange(term.fromAt, term.toAt, { withTime: true });
}

/** Filtry (GET formulář, funguje bez JS). */
function filters({ filters: f, categories, sizes, categoryLabels }) {
  return html`<form class="form filters" method="get" action="/kola" data-autosubmit>
  <div class="filters__grid">
    ${c.field({ label: 'Kategorie', name: 'kategorie', type: 'select', value: f.kategorie || '', options: [{ value: '', label: 'Všechny kategorie' }, ...categories.map((k) => ({ value: k, label: categoryLabels[k] || k }))] })}
    ${c.field({ label: 'Velikost', name: 'velikost', type: 'select', value: f.velikost || '', options: [{ value: '', label: 'Všechny velikosti' }, ...sizes.map((s) => ({ value: s, label: s }))] })}
    ${c.field({ label: 'Vyzvednutí', name: 'od', type: 'date', value: f.od || '', min: f.minDate })}
    ${c.field({ label: 'Vrácení', name: 'do', type: 'date', value: f.do || '', min: f.minDate })}
  </div>
  <div class="filters__actions">
    ${c.button({ label: 'Zobrazit', type: 'submit', variant: 'primary' })}
    ${f.kategorie || f.velikost || f.od || f.do ? c.button({ label: 'Zrušit filtry', href: '/kola', variant: 'ghost' }) : ''}
  </div>
</form>`;
}

/** /kola */
function list({ types, filters: f, categories, sizes, categoryLabels, term, termError }) {
  const lead = term
    ? `Dostupnost a ceny pro termín ${termText(term)} (${format.plural(term.days, 'den', 'dny', 'dní')}). Cena za den podle délky pronájmu a sezóny; rezervační poplatek se započítá do ceny.`
    : 'Trekové, horské a elektrokola pro dospělé, dětská kola a gravel. Zadejte termín a uvidíte volné kusy a cenu za den pro vaši délku pronájmu.';
  return {
    title: 'Kola k zapůjčení',
    description: 'Přehled kol k zapůjčení v Třeboni: trekové, horské, elektrokola, dětská kola a gravel. Ceny od 250 Kč za den, dostupnost online.',
    body: html`
${c.section({ variant: 'page-head', title: 'Kola k zapůjčení', titleTag: 'h1', lead })}
${c.section({
  variant: 'filters',
  children: html`${filters({ filters: f, categories, sizes, categoryLabels })}${termError ? c.notice(termError, 'warning') : ''}`,
})}
${c.section({
  variant: 'bikes',
  children: types.length
    ? c.grid(
        types.map((t) =>
          c.bikeCard(t, {
            price: t.price_minor,
            available: t.available,
            href: term ? `/kola/${t.slug}?od=${encodeURIComponent(term.od)}&do=${encodeURIComponent(term.do)}${f.velikost ? `&velikost=${encodeURIComponent(f.velikost)}` : ''}` : undefined,
          })
        ),
        3
      )
    : c.notice('Zadaným filtrům neodpovídá žádné kolo. Zkuste jinou kategorii nebo velikost.', 'info'),
})}
${c.section({
  variant: 'cta',
  children: html`<p class="section__more">${c.button({ label: 'Začít rezervaci', href: term ? `/rezervace?od=${encodeURIComponent(term.od)}&do=${encodeURIComponent(term.do)}` : '/rezervace', variant: 'primary', size: 'lg' })} ${c.button({ label: 'Kompletní ceník', href: '/cenik', variant: 'ghost' })}</p>`,
})}
`,
  };
}

/** Tabulka ceníku jednoho typu (řádky: mimo sezónu + sezóny). rows = pricing.mergeSeasonRows(priceTable). */
function priceTableFor(rows, { caption } = {}) {
  const head = ['Období', ...TIERS.map((t) => TIER_LABELS[t]), 'Hodina', 'Půlden'];
  const body = rows.map((r) => {
    const label = r.season
      ? html`${r.season.name}<br><small>${r.ranges.map((x) => format.dateRange(x.from, x.to)).join(', ')}</small>`
      : 'Mimo sezónu';
    return [
      { value: label, header: true },
      ...TIERS.map((t) => (r.tiers[t] !== undefined ? { value: format.money(r.tiers[t]), align: 'right' } : { value: '–', align: 'right' })),
      { value: r.hour !== null && r.hour !== undefined ? format.money(r.hour) : '–', align: 'right' },
      { value: r.halfday !== null && r.halfday !== undefined ? format.money(r.halfday) : '–', align: 'right' },
    ];
  });
  return c.table({ head, rows: body, caption });
}

/** /kola/:slug */
function detail({ type, priceRows, availabilityBySize, totalsBySize, term, quote, settings, baseUrl, freeHours, categoryLabels }) {
  const photos = (type.photos || []).map(photoOf).filter(Boolean);
  const main = photos[0] || null;
  const specs = Object.entries(type.specs || {});
  const sizes = type.sizes || [];
  const fee = Number(type.fee_minor);
  const deposit = Number(type.deposit_minor);
  const reserveHref = `/rezervace?typ=${encodeURIComponent(type.slug)}${term ? `&od=${encodeURIComponent(term.od)}&do=${encodeURIComponent(term.do)}&od_cas=${encodeURIComponent(term.odCas)}&do_cas=${encodeURIComponent(term.doCas)}` : ''}`;
  const availableTotal = availabilityBySize ? Object.values(availabilityBySize).reduce((a, b) => a + b, 0) : null;
  const jsonLd = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: type.name,
    description: type.description || undefined,
    category: categoryLabels[type.category] || type.category,
    image: photos.length ? photos.map((p) => baseUrl + p.src) : undefined,
    url: `${baseUrl}/kola/${type.slug}`,
    offers: {
      '@type': 'Offer',
      url: `${baseUrl}/kola/${type.slug}`,
      priceCurrency: 'CZK',
      price: type.from_price_minor !== null && type.from_price_minor !== undefined ? (type.from_price_minor / 100).toFixed(2) : undefined,
      priceSpecification: type.from_price_minor !== null && type.from_price_minor !== undefined ? { '@type': 'UnitPriceSpecification', price: (type.from_price_minor / 100).toFixed(2), priceCurrency: 'CZK', unitText: 'den' } : undefined,
      availability: availableTotal === null ? 'https://schema.org/InStock' : availableTotal > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      businessFunction: 'http://purl.org/goodrelations/v1#LeaseOut',
    },
  };
  const description = `${type.name} – půjčovna kol Třeboň. ${type.description ? type.description.slice(0, 120) : ''} Cena od ${type.from_price_minor !== null && type.from_price_minor !== undefined ? format.money(type.from_price_minor) : '–'} za den, rezervace online.`;
  return {
    title: type.name,
    description,
    jsonLd: JSON.parse(JSON.stringify(jsonLd)),
    body: html`
<section class="section section--page-head"><div class="container">
  <p class="breadcrumbs"><a href="/kola">Kola</a> › ${categoryLabels[type.category] || type.category}</p>
  <h1 class="section__title">${type.name}</h1>
  ${type.description ? html`<p class="section__lead">${type.description}</p>` : ''}
</div></section>
<section class="section section--detail"><div class="container detail">
  <div class="detail__media">
    ${main
      ? html`<figure class="gallery" data-gallery>
      <img class="gallery__main" src="${main.src}" alt="${main.alt || type.name}" width="1200" height="800">
      ${photos.length > 1
        ? html`<ul class="gallery__thumbs">${photos.map((p, i) => html`<li><a class="gallery__thumb${i === 0 ? ' is-active' : ''}" href="${p.src}" data-src="${p.src}" data-alt="${p.alt || type.name}"${i === 0 ? raw(' aria-current="true"') : ''}><img src="${p.src}" alt="${p.alt || `${type.name} – fotografie ${i + 1}`}" loading="lazy" width="200" height="133"></a></li>`)}</ul>`
        : ''}
      <figcaption class="gallery__caption">${photos.map((p) => attribution(p)).filter((x) => x !== '').map((x, i) => html`${i ? raw(' · ') : ''}${x}`)}</figcaption>
    </figure>`
      : html`<div class="gallery gallery--empty"><div class="card__placeholder">${c.icon('bike')}</div></div>`}
  </div>
  <aside class="detail__side">
    <div class="price-box">
      ${quote
        ? html`<p class="price-box__label">Cena pro ${termText(term)}</p>
        ${c.price(quote.bikesMinor, null)}
        <p class="price-box__meta">${format.plural(quote.units, UNIT_LABELS[quote.unit], quote.unit === 'day' ? 'dny' : quote.unit === 'hour' ? 'hodiny' : 'půldny', quote.unit === 'day' ? 'dní' : quote.unit === 'hour' ? 'hodin' : 'půldnů')} à ${format.money(quote.unitPriceMinor)} za kolo${quote.breakdown.some((b) => b.season) ? ' (včetně sezónní sazby)' : ''}</p>`
        : html`<p class="price-box__label">Cena</p>${type.from_price_minor !== null && type.from_price_minor !== undefined ? c.price(type.from_price_minor, 'den', { prefix: 'od' }) : c.notice('Ceník se připravuje.', 'info')}`}
      ${c.summary([
        ['Rezervační poplatek', html`${format.money(fee)} <small>za kolo, započítá se do ceny</small>`],
        ['Vratná kauce při převzetí', format.money(deposit)],
        ['Velikosti', sizes.join(', ') || '–'],
      ])}
      ${c.button({ label: 'Rezervovat', href: reserveHref, variant: 'primary', size: 'lg' })}
      <p class="price-box__hint">Zrušení nejméně ${freeHours} h před začátkem: poplatek vracíme celý. <a href="/cenik#storno">Storno pravidla</a></p>
    </div>
    <form class="form term-form" method="get" action="/kola/${type.slug}">
      <h2 class="term-form__title">Dostupnost pro termín</h2>
      <div class="term-form__grid">
        ${c.field({ label: 'Vyzvednutí', name: 'od', type: 'date', value: term ? term.od : '', min: format.isoDate(new Date()), required: true })}
        ${c.field({ label: 'Vrácení', name: 'do', type: 'date', value: term ? term.do : '', min: format.isoDate(new Date()), required: true })}
      </div>
      ${c.button({ label: 'Ověřit dostupnost', type: 'submit', variant: 'secondary' })}
    </form>
  </aside>
  <div class="detail__body">
    <h2>Velikosti${term ? html` a dostupnost <small>(${termText(term)})</small>` : ''}</h2>
    <ul class="sizes">${sizes.map((s) => {
      const n = availabilityBySize ? availabilityBySize[s] || 0 : null;
      const total = totalsBySize ? totalsBySize[s] || 0 : null;
      return html`<li class="sizes__item"><span class="sizes__size">${s}</span> ${n === null ? html`<span class="sizes__total">${format.plural(total || 0, 'kus', 'kusy', 'kusů')}</span>` : n > 0 ? c.badge(format.plural(n, 'kolo volné', 'kola volná', 'kol volných'), 'success') : c.badge('Obsazeno', 'danger')}</li>`;
    })}</ul>
    ${specs.length
      ? html`<h2>Specifikace</h2>${c.table({ rows: specs.map(([k, v]) => [{ value: k, header: true }, String(v)]), compact: true })}`
      : ''}
    <h2 id="cenik">Ceník typu</h2>
    ${priceTableFor(priceRows)}
    <p class="detail__note">Délka pronájmu: do 4 hodin se účtuje hodinová sazba, do 6 hodin půlden, jinak každý započatý den. Pásma platí podle celkového počtu dní; sezónní sazba se uplatní na dny spadající do sezóny.</p>
  </div>
</div></section>
`,
  };
}

/** /cenik */
function cenik({ types, seasons, accessories, settings, categoryLabels, freeHours, bufferMinutes }) {
  const head = ['Typ kola', ...TIERS.map((t) => TIER_LABELS[t]), 'Hodina', 'Půlden', 'Poplatek', 'Kauce'];
  const tableFor = (pick) =>
    c.table({
      head,
      rows: types.map((t) => {
        const r = pick(t.priceRows);
        return [
          { value: html`<a href="/kola/${t.slug}">${t.name}</a><br><small>${categoryLabels[t.category] || t.category}</small>`, header: true },
          ...TIERS.map((tier) => ({ value: r && r.tiers[tier] !== undefined ? format.money(r.tiers[tier]) : '–', align: 'right' })),
          { value: r && r.hour !== null && r.hour !== undefined ? format.money(r.hour) : '–', align: 'right' },
          { value: r && r.halfday !== null && r.halfday !== undefined ? format.money(r.halfday) : '–', align: 'right' },
          { value: format.money(t.fee_minor), align: 'right' },
          { value: format.money(t.deposit_minor), align: 'right' },
        ];
      }),
    });
  const seasonNames = [...new Set(seasons.map((s) => s.name))];
  return {
    title: 'Ceník',
    description: 'Ceník půjčovny kol v Třeboni: ceny za den podle délky pronájmu, sezónní sazby, příslušenství, rezervační poplatek, kauce a storno pravidla.',
    body: html`
${c.section({ variant: 'page-head', title: 'Ceník', titleTag: 'h1', lead: 'Ceny jsou za jedno kolo a den; při delším pronájmu klesají. Do 4 hodin účtujeme hodinovou sazbu, do 6 hodin půlden. Všechny ceny včetně DPH.' })}
${c.section({
  variant: 'cenik',
  title: 'Mimo sezónu',
  children: types.length ? tableFor((rows) => rows.find((r) => !r.season)) : c.notice('Ceník se připravuje.', 'info'),
})}
${seasonNames.map((name) =>
  c.section({
    variant: 'cenik',
    title: name,
    lead: `Platí ${seasons
      .filter((s) => s.name === name)
      .map((s) => format.dateRange(s.date_from, s.date_to))
      .join(', ')}. Sezónní sazba se uplatní na dny pronájmu spadající do sezóny.`,
    children: tableFor((rows) => rows.find((r) => r.season && r.season.name === name) || rows.find((r) => !r.season)),
  })
)}
${c.section({
  variant: 'cenik',
  title: 'Příslušenství',
  lead: 'Účtuje se za den pronájmu. Zámek a základní mapu dáváme ke každému kolu zdarma.',
  children: accessories.length
    ? c.table({ head: ['Položka', 'Cena / den', 'Skladem'], rows: accessories.map((a) => [{ value: a.name, header: true }, { value: a.price_minor ? format.money(a.price_minor) : 'zdarma', align: 'right' }, { value: format.plural(a.stock, 'kus', 'kusy', 'kusů'), align: 'right' }]) })
    : c.notice('Příslušenství se připravuje.', 'info'),
})}
${c.section({
  variant: 'cenik',
  id: 'storno',
  title: 'Rezervační poplatek, kauce a storno',
  children: html`<div class="grid grid--3">
    <article class="rule-card"><h3 class="rule-card__title">Rezervační poplatek</h3><p>Při online rezervaci platíte poplatek ${format.money(settings.feeMinor && settings.feeMinor.default ? settings.feeMinor.default : 30000)} za kolo (u elektrokol ${format.money(settings.feeMinor && settings.feeMinor.ebike ? settings.feeMinor.ebike : 50000)}). Je úplatou za zajištění termínu – blokaci kol – a při řádném využití se celý započítá do nájemného. Zbytek ceny doplatíte při převzetí nebo předem online.</p></article>
    <article class="rule-card"><h3 class="rule-card__title">Storno pravidla</h3><p>Zrušíte-li rezervaci <strong>nejméně ${freeHours} hodin</strong> před začátkem, vrátíme celý poplatek. Při pozdějším zrušení nebo nevyzvednutí poplatek propadá. Zrušení ze strany půjčovny = vždy plná vratka.</p>${c.table({ compact: true, rows: [[{ value: `${freeHours} h a více před začátkem`, header: true }, 'vrácení 100 % poplatku'], [{ value: `méně než ${freeHours} h / nevyzvednutí`, header: true }, 'poplatek propadá']] })}</article>
    <article class="rule-card"><h3 class="rule-card__title">Kauce a doklad</h3><p>Při převzetí skládáte vratnou kauci podle typu kola (hotově, kartou na terminálu nebo preautorizací karty) a předložíte platný doklad totožnosti – zapíšeme si jeho typ a číslo. Bez dokladu kolo nevydáme. Mezi dvěma pronájmy téhož kola držíme ${format.plural(bufferMinutes, 'minutu', 'minuty', 'minut')} na kontrolu a servis.</p></article>
  </div>
  <p class="section__more">${c.button({ label: 'Rezervovat kolo', href: '/rezervace', variant: 'primary', size: 'lg' })} ${c.button({ label: 'Obchodní podmínky', href: '/podminky', variant: 'ghost' })}</p>`,
})}
`,
  };
}

module.exports = { list, detail, cenik, filters, priceTableFor, photoOf, attribution, TIERS };
