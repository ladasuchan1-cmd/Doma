'use strict';
// Komponenty UI (SPEC kap. 6) – všechny vracejí bezpečný Html fragment a používají výhradně třídy z tabulky ve
// specifikaci; tématické CSS je stylují, HTML se mezi tématy nemění. Texty hodnot se escapují přes html``.
// Vstup: prostá data (řetězce, čísla, pole). Výstup: Html (raw fragment).

const { html, raw, attr, joinHtml, isHtml } = require('./html');
const format = require('./format');

const CATEGORY_LABELS = Object.freeze({ mtb: 'Horské', trek: 'Trekové', ebike: 'Elektrokolo', kids: 'Dětské', gravel: 'Gravel', city: 'Městské' });
const TONES = new Set(['success', 'warning', 'danger', 'info', 'neutral']);

function cls(...parts) {
  return parts.filter(Boolean).join(' ');
}

function content(children) {
  if (children === null || children === undefined) return '';
  if (Array.isArray(children)) return joinHtml(children);
  return isHtml(children) ? children : html`${children}`;
}

/** Ikona ze sprite /img/icons.svg (dekorativní, aria-hidden). */
function icon(name, { label } = {}) {
  const safe = String(name).replace(/[^a-z0-9-]/g, '');
  return html`<svg class="icon icon--${safe}"${attr({ 'aria-hidden': label ? null : 'true', role: label ? 'img' : null, 'aria-label': label || null })} width="24" height="24"><use href="/img/icons.svg#${safe}"></use></svg>`;
}

/** Hero sekce. */
function hero({ title, text, cta, ctaHref, image, imageAlt, secondaryCta, secondaryHref, accent, eyebrow } = {}) {
  return html`<section class="hero">
  <div class="hero__media">${image ? html`<img src="${image}" alt="${imageAlt || ''}" width="1600" height="900" fetchpriority="high">` : html`<div class="hero__placeholder" aria-hidden="true"></div>`}</div>
  <div class="hero__body container">
    ${eyebrow ? html`<p class="hero__eyebrow">${eyebrow}</p>` : ''}
    <h1 class="hero__title">${title}</h1>
    ${text ? html`<p class="hero__text">${text}</p>` : ''}
    ${accent ? html`<p class="hero__accent">${accent}</p>` : ''}
    <div class="hero__actions">
      ${cta ? button({ label: cta, href: ctaHref || '/rezervace', variant: 'primary', size: 'lg' }) : ''}
      ${secondaryCta ? button({ label: secondaryCta, href: secondaryHref || '/kola', variant: 'ghost', size: 'lg' }) : ''}
    </div>
  </div>
</section>`;
}

/** Sekce s nadpisem a volitelným úvodem. */
function section({ title, lead, children, variant, id, titleTag = 'h2', eyebrow } = {}) {
  return html`<section class="${cls('section', variant && `section--${variant}`)}"${attr({ id })}>
  <div class="container">
    ${eyebrow ? html`<p class="section__eyebrow">${eyebrow}</p>` : ''}
    ${title ? raw(`<${titleTag} class="section__title">${html`${title}`}</${titleTag}>`) : ''}
    ${lead ? html`<p class="section__lead">${lead}</p>` : ''}
    ${content(children)}
  </div>
</section>`;
}

/** Mřížka karet. */
function grid(children, cols = 3) {
  const n = [1, 2, 3, 4].includes(Number(cols)) ? Number(cols) : 3;
  return html`<div class="grid grid--${n}">${content(children)}</div>`;
}

/** Tlačítko nebo odkaz vypadající jako tlačítko. */
function button({ label, href, variant = 'primary', size, type = 'button', name, value, disabled, attrs, iconName, ariaLabel } = {}) {
  const classes = cls('btn', `btn--${variant}`, size && `btn--${size}`, iconName && 'btn--icon');
  const inner = html`${iconName ? icon(iconName) : ''}<span class="btn__label">${label}</span>`;
  if (href && !disabled) return html`<a class="${classes}" href="${href}"${attr({ 'aria-label': ariaLabel, ...attrs })}>${inner}</a>`;
  return html`<button class="${classes}"${attr({ type, name, value, disabled: !!disabled, 'aria-label': ariaLabel, ...attrs })}>${inner}</button>`;
}

/** Cena v haléřích: 39000 → <p class="price"><strong class="price__amount">390 Kč</strong><span class="price__unit">/ den</span></p> */
function price(minor, unit, { prefix } = {}) {
  return html`<p class="price">${prefix ? html`<span class="price__prefix">${prefix} </span>` : ''}<strong class="price__amount">${format.money(minor)}</strong>${unit ? html` <span class="price__unit">/ ${unit}</span>` : ''}</p>`;
}

/** Odznak / stav. */
function badge(text, tone) {
  const t = TONES.has(tone) ? tone : null;
  return html`<span class="${cls('badge', t && `badge--${t}`)}">${text}</span>`;
}

/** Upozornění. */
function notice(text, tone = 'info', { title } = {}) {
  const t = TONES.has(tone) ? tone : 'info';
  return html`<div class="notice notice--${t}" role="${t === 'danger' || t === 'warning' ? 'alert' : 'status'}">${title ? html`<strong class="notice__title">${title}</strong> ` : ''}${content(text)}</div>`;
}

/**
 * Karta typu kola. type = řádek bike_types (sizes JSON pole).
 * unit = jednotka u ceny (výchozí „den“ → „/ den“); u výsledků filtru s termínem lze předat např. „den při 3 dnech“
 * nebo '' (bez jednotky). pricePrefix = předpona ceny (výchozí „od“, '' = bez předpony).
 */
function bikeCard(type, { price: priceMinor, available, href, image, imageAlt, unit = 'den', pricePrefix = 'od' } = {}) {
  const sizes = Array.isArray(type.sizes) ? type.sizes : [];
  const photos = Array.isArray(type.photos) ? type.photos : [];
  const img = image || (photos[0] && (typeof photos[0] === 'string' ? photos[0] : photos[0].src)) || null;
  const alt = imageAlt || (photos[0] && photos[0].alt) || type.name;
  const link = href || `/kola/${type.slug}`;
  const sizeText = sizes.length ? (sizes.length > 1 ? `velikosti ${sizes[0]}–${sizes[sizes.length - 1]}` : `velikost ${sizes[0]}`) : '';
  return html`<article class="card card--bike">
  <a class="card__media" href="${link}" tabindex="-1" aria-hidden="true">${img ? html`<img src="${img}" alt="${alt}" loading="lazy" width="800" height="600">` : html`<div class="card__placeholder">${icon('bike')}</div>`}</a>
  <div class="card__body">
    <span class="badge">${CATEGORY_LABELS[type.category] || type.category}</span>
    <h3 class="card__title"><a href="${link}">${type.name}</a></h3>
    ${sizeText ? html`<p class="card__meta">${sizeText}</p>` : ''}
    ${priceMinor !== undefined && priceMinor !== null ? price(priceMinor, unit || null, { prefix: pricePrefix || null }) : ''}
    ${available !== undefined && available !== null ? html`<p class="card__availability">${available > 0 ? badge(`${format.plural(available, 'kolo volné', 'kola volná', 'kol volných')}`, 'success') : badge('Obsazeno', 'danger')}</p>` : ''}
    ${button({ label: 'Detail', href: link, variant: 'secondary' })}
  </div>
</article>`;
}

/** Formulářové pole. type: text | email | tel | number | date | time | password | textarea | select | checkbox | hidden */
function field({ label, name, type = 'text', value, required, hint, error, options, placeholder, autocomplete, rows = 4, checked, id, min, max, step, pattern, maxlength, inputmode, disabled, attrs } = {}) {
  const fid = id || `f-${String(name).replace(/[^A-Za-z0-9_-]/g, '-')}`;
  const describedBy = [hint ? `${fid}-hint` : null, error ? `${fid}-error` : null].filter(Boolean).join(' ') || null;
  const common = { id: fid, name, required: !!required, 'aria-describedby': describedBy, 'aria-invalid': error ? 'true' : null, disabled: !!disabled, ...attrs };
  if (type === 'hidden') return html`<input type="hidden"${attr({ name, value: value ?? '' })}>`;
  let control;
  if (type === 'textarea') {
    control = html`<textarea class="field__input field__input--textarea"${attr({ ...common, rows, placeholder, maxlength })}>${value ?? ''}</textarea>`;
  } else if (type === 'select') {
    control = html`<select class="field__input field__input--select"${attr(common)}>${(options || []).map((o) => {
      const opt = typeof o === 'object' ? o : { value: o, label: o };
      return html`<option${attr({ value: opt.value, selected: String(opt.value) === String(value ?? ''), disabled: !!opt.disabled })}>${opt.label}</option>`;
    })}</select>`;
  } else if (type === 'checkbox') {
    return html`<div class="${cls('field', 'field--checkbox', error && 'has-error')}">
  <label class="field__check" for="${fid}"><input class="field__checkbox" type="checkbox"${attr({ ...common, value: value ?? '1', checked: !!checked })}><span class="field__label">${content(label)}${required ? html` <span class="field__required" aria-hidden="true">*</span>` : ''}</span></label>
  ${hint ? html`<p class="field__hint" id="${fid}-hint">${content(hint)}</p>` : ''}
  ${error ? html`<p class="field__error" id="${fid}-error">${error}</p>` : ''}
</div>`;
  } else {
    control = html`<input class="field__input"${attr({ ...common, type, value: value ?? '', placeholder, autocomplete, min, max, step, pattern, maxlength, inputmode })}>`;
  }
  return html`<div class="${cls('field', `field--${type}`, error && 'has-error')}">
  <label class="field__label" for="${fid}">${label}${required ? html` <span class="field__required" aria-hidden="true">*</span>` : ''}</label>
  ${control}
  ${hint ? html`<p class="field__hint" id="${fid}-hint">${content(hint)}</p>` : ''}
  ${error ? html`<p class="field__error" id="${fid}-error">${error}</p>` : ''}
</div>`;
}

/**
 * Formulář s hidden _csrf. Třída z `attrs.class` se sloučí s výchozí „form“ (bez duplicit), aby nevznikl druhý
 * atribut class, který prohlížeč ignoruje: attrs { class: 'form pay-method' } → <form class="form pay-method" …>.
 */
function form({ action, method = 'post', csrf, children, attrs, submit, submitVariant = 'primary' } = {}) {
  const m = String(method).toLowerCase() === 'get' ? 'get' : 'post';
  const { class: extraClass, className, ...rest } = attrs || {};
  const classes = [...new Set(['form', ...String(extraClass || className || '').split(/\s+/).filter(Boolean)])].join(' ');
  return html`<form class="${classes}" method="${m}"${attr({ action, ...rest })}>
  ${m === 'post' && csrf ? html`<input type="hidden" name="_csrf" value="${csrf}">` : ''}
  ${content(children)}
  ${submit ? html`<div class="form__actions">${button({ label: submit, type: 'submit', variant: submitVariant })}</div>` : ''}
</form>`;
}

/**
 * Kroky 1-2-3. items: řetězce nebo { label, href, description }. Hotové kroky (i < activeIndex) s `href` jsou odkazy,
 * ale jen dokud průchod běží: je-li aktivní poslední krok (např. „Hotovo“ po dokončení rezervace), odkazy zpět se
 * nevypisují – vedly by na smazaný rozepsaný stav a působily jako možnost upravit hotovou rezervaci.
 * opts.links: true = odkazy vždy, false = nikdy, 'auto' (výchozí) = podle pravidla výše.
 */
function steps(items, activeIndex = -1, { links = 'auto' } = {}) {
  const list = items || [];
  const finished = activeIndex >= 0 && activeIndex === list.length - 1;
  const withLinks = links === true || (links === 'auto' && !finished);
  return html`<ol class="steps">${list.map((it, i) => {
    const item = typeof it === 'object' ? it : { label: it };
    const state = i < activeIndex ? 'is-done' : i === activeIndex ? 'is-active' : '';
    const inner = html`<span class="steps__num" aria-hidden="true">${i + 1}</span><span class="steps__label">${item.label}</span>${item.description ? html`<span class="steps__desc">${item.description}</span>` : ''}`;
    return html`<li class="${cls('steps__item', state)}"${attr({ 'aria-current': i === activeIndex ? 'step' : null })}>${withLinks && item.href && i < activeIndex ? html`<a class="steps__link" href="${item.href}">${inner}</a>` : inner}</li>`;
  })}</ol>`;
}

/** Tabulka. head: pole popisků; rows: pole polí (hodnoty nebo { value, align, header }). */
function table({ head, rows, caption, compact } = {}) {
  const cell = (c, tag) => {
    const v = c && typeof c === 'object' && !isHtml(c) && !Array.isArray(c) && 'value' in c ? c : { value: c };
    const t = v.header ? 'th' : tag;
    return raw(`<${t}${attr({ class: v.align ? `is-${v.align}` : null, scope: t === 'th' ? 'row' : null })}>${content(v.value)}</${t}>`);
  };
  return html`<div class="table-wrap"><table class="${cls('table', compact && 'table--compact')}">
  ${caption ? html`<caption class="table__caption">${caption}</caption>` : ''}
  ${head && head.length ? html`<thead><tr>${head.map((h) => html`<th scope="col">${content(h)}</th>`)}</tr></thead>` : ''}
  <tbody>${(rows || []).map((r) => html`<tr>${r.map((c) => cell(c, 'td'))}</tr>`)}</tbody>
</table></div>`;
}

/** Souhrn (definiční seznam). rows: [[label, value]] nebo [{ label, value, strong }]. */
function summary(rows) {
  return html`<dl class="summary">${(rows || []).map((r) => {
    const row = Array.isArray(r) ? { label: r[0], value: r[1] } : r;
    return html`<div class="${cls('summary__row', row.strong && 'summary__row--total')}"><dt>${content(row.label)}</dt><dd>${content(row.value)}</dd></div>`;
  })}</dl>`;
}

/**
 * Kalendářový výběr termínu: wrapper pro progresivní JS + fallback dvou <input type="date"> bez JS.
 * blocked: pole ISO dat (YYYY-MM-DD) nebo intervalů { from, to }, předává se v data-blocked (JSON).
 * after: volitelný Html (nebo pole) vložený do .calendar__fallback za oba inputy (např. výběr času vyzvednutí/vrácení);
 * .calendar__status je prázdný živý region (aria-live) pro hlášky klientského JS. Bez `after` je výstup shodný jako dříve.
 */
function calendarRange({ name = 'termin', min, max, blocked = [], from, to, fromName = 'od', toName = 'do', labels = {}, after } = {}) {
  const minDate = min || format.isoDate(new Date());
  return html`<div class="calendar" data-calendar data-name="${name}" data-min="${minDate}"${attr({ 'data-max': max || null })} data-blocked="${JSON.stringify(blocked || [])}">
  <div class="calendar__fallback">
    ${field({ label: labels.from || 'Od', name: fromName, type: 'date', value: from, required: true, min: minDate, max })}
    ${field({ label: labels.to || 'Do', name: toName, type: 'date', value: to, required: true, min: minDate, max })}
    ${after ? content(after) : ''}
  </div>
  <div class="calendar__grid" hidden aria-hidden="true"></div>
  ${after ? html`<p class="calendar__status" aria-live="polite"></p>` : ''}
</div>`;
}

/** Záložky (odkazy). items: { label, href, active, count } */
function tabs(items, { ariaLabel = 'Záložky' } = {}) {
  return html`<nav class="tabs" aria-label="${ariaLabel}"><ul class="tabs__list">${(items || []).map(
    (it) => html`<li class="tabs__item"><a class="${cls('tabs__tab', it.active && 'is-active')}" href="${it.href}"${attr({ 'aria-current': it.active ? 'page' : null })}>${it.label}${it.count !== undefined ? html` <span class="tabs__count">${it.count}</span>` : ''}</a></li>`
  )}</ul></nav>`;
}

/**
 * Timeline (admin kalendář). days: pole ISO dat (sloupce); rows: { label, href, bars: [{ fromIndex, toIndex, status, label, href }] }.
 * Pozice se předávají přes vlastní CSS proměnné v atributu style? Ne – bez inline stylů: používáme data-from / data-span
 * a CSS grid-column přes [data-from="n"] pravidla v base.css (do 31 sloupců).
 */
function timeline({ rows, days } = {}) {
  const cols = (days || []).length || 14;
  return html`<div class="timeline" data-days="${cols}" role="table" aria-label="Obsazenost">
  <div class="timeline__head" role="row"><div class="timeline__label" role="columnheader">Typ / kolo</div>${(days || []).map((d) => html`<div class="timeline__day" role="columnheader">${format.date(d).replace(/\s?\d{4}$/, '')}</div>`)}</div>
  ${(rows || []).map(
    (r) => html`<div class="timeline__row" role="row">
    <div class="timeline__label" role="rowheader">${r.href ? html`<a href="${r.href}">${r.label}</a>` : r.label}</div>
    <div class="timeline__track" role="cell">${(r.bars || []).map((b) => {
      const from = Math.max(0, Math.min(cols - 1, Number(b.fromIndex) || 0));
      const to = Math.max(from, Math.min(cols - 1, Number(b.toIndex ?? b.fromIndex) || 0));
      const inner = html`<span class="timeline__bar-label">${b.label || ''}</span>`;
      const attrs = { class: cls('timeline__bar', `status-${String(b.status || 'confirmed').replace(/[^a-z_-]/g, '')}`), 'data-from': from + 1, 'data-span': to - from + 1, title: b.title || b.label || null };
      return b.href ? html`<a${attr({ ...attrs, href: b.href })}>${inner}</a>` : html`<span${attr(attrs)}>${inner}</span>`;
    })}</div>
  </div>`
  )}
</div>`;
}

/** Kontaktní karta (patička, kontakt). */
function contactCard(business = {}, openingHours = {}, { title = 'Kontakt', mapHref } = {}) {
  const rows = format.openingHoursRows(openingHours);
  const phoneHref = business.phone ? `tel:${String(business.phone).replace(/\s+/g, '')}` : null;
  const map = mapHref || (business.address ? `https://mapy.cz/zakladni?q=${encodeURIComponent(business.address)}` : null);
  return html`<div class="contact-card">
  <h3 class="contact-card__title">${title}</h3>
  <address class="contact-card__address">
    ${business.legalName ? html`<strong>${business.legalName}</strong><br>` : ''}
    ${business.address ? html`${business.address}<br>` : ''}
    ${business.phone ? html`<a href="${phoneHref}">${business.phone}</a><br>` : ''}
    ${business.email ? html`<a href="mailto:${business.email}">${business.email}</a>` : ''}
  </address>
  ${business.ico ? html`<p class="contact-card__meta">IČO ${business.ico}${business.dic ? html`, DIČ ${business.dic}` : ''}</p>` : ''}
  ${rows.length ? html`<h4 class="contact-card__subtitle">Otevírací doba</h4><dl class="contact-card__hours">${rows.map((r) => html`<div><dt>${r.days}</dt><dd>${r.hours}</dd></div>`)}</dl>` : ''}
  ${map ? html`<p class="contact-card__map"><a href="${map}" rel="noopener" target="_blank">Zobrazit na mapě</a></p>` : ''}
</div>`;
}

/** Karta zajímavosti (okolí). poi: { name, type, distanceKm, summary, wikipediaUrl, image: { file, author, license, licenseUrl, sourceUrl }, href } */
function poiCard(poi = {}) {
  const img = poi.image || null;
  const src = img ? img.src || (img.file ? `/okoli/img/${img.file}` : null) : null;
  return html`<article class="card card--poi">
  ${src ? html`<div class="card__media"><img src="${src}" alt="${img.alt || poi.name || ''}" loading="lazy" width="800" height="600"></div>` : ''}
  <div class="card__body">
    ${poi.type ? html`<span class="badge">${poi.type}</span>` : ''}
    <h3 class="card__title">${poi.href ? html`<a href="${poi.href}">${poi.name}</a>` : poi.name}</h3>
    ${poi.distanceKm !== undefined && poi.distanceKm !== null ? html`<p class="card__meta">${format.km(poi.distanceKm)} od půjčovny</p>` : ''}
    ${poi.summary ? html`<p class="card__text">${poi.summary}</p>` : ''}
    <p class="card__links">${poi.wikipediaUrl ? html`<a href="${poi.wikipediaUrl}" rel="noopener" target="_blank">Wikipedie</a>` : ''}${poi.mapHref ? html` · <a href="${poi.mapHref}" rel="noopener" target="_blank">Navigovat</a>` : ''}</p>
    ${img && (img.author || img.license) ? html`<p class="card__attribution">Foto: ${img.sourceUrl ? html`<a href="${img.sourceUrl}" rel="noopener" target="_blank">${img.author || 'Wikimedia Commons'}</a>` : img.author || ''}${img.license ? html`, ${img.licenseUrl ? html`<a href="${img.licenseUrl}" rel="noopener" target="_blank">${img.license}</a>` : img.license}` : ''}</p>` : ''}
  </div>
</article>`;
}

/** Karta trasy. route: { id, nazev, ref, sit, druh, delkaKm, elevation, gpxHref, href } */
function routeCard(route = {}) {
  const net = route.sit ? String(route.sit).toLowerCase().replace(/[^a-z0-9_-]/g, '') : '';
  return html`<article class="card card--route"${attr({ 'data-network': net || null })}>
  <div class="card__body">
    <p class="card__badges">${route.sit ? badge(String(route.sit).toUpperCase(), 'info') : ''}${route.ref ? html` ${badge(`č. ${route.ref}`)}` : ''}</p>
    <h3 class="card__title">${route.href ? html`<a href="${route.href}">${route.nazev || route.name || 'Trasa'}</a>` : route.nazev || route.name || 'Trasa'}</h3>
    <p class="card__meta">${route.delkaKm !== undefined ? format.km(route.delkaKm) : ''}${route.druh ? html` · ${route.druh}` : ''}${route.elevation && route.elevation.up !== undefined ? html` · ↑ ${format.number(route.elevation.up)} m` : ''}</p>
    ${route.gpxHref ? html`<p class="card__links"><a class="btn btn--secondary btn--sm" href="${route.gpxHref}" download>Stáhnout GPX</a></p>` : ''}
  </div>
</article>`;
}

module.exports = {
  CATEGORY_LABELS,
  icon,
  hero,
  section,
  grid,
  bikeCard,
  button,
  field,
  form,
  steps,
  table,
  badge,
  notice,
  price,
  summary,
  calendarRange,
  tabs,
  timeline,
  contactCard,
  poiCard,
  routeCard,
};
