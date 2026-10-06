'use strict';
// Sdílené části admin stránek (SPEC kap. 13): obal „shell“ s vlastní admin navigací (uvnitř veřejného layoutu, body
// má třídu .admin), karty, tabulky s data-atributy pro progresivní JS (řazení, filtr), štítky stavů plateb / ledgeru /
// dokladů / e-mailů, drobné formulářové pomocníky. Vše vrací bezpečný Html (escapování přes html``).
// Vstup: prostá data z src/features/admin.js. Výstup: Html fragmenty.

const { html, raw, attr, joinHtml, isHtml } = require('../../html');
const c = require('../../components');
const format = require('../../format');
const { STATUS_LABELS, STATUS_TONES } = require('../../../domain/reservations');

/** Položky admin navigace; `owner` = jen pro roli owner. */
const NAV = Object.freeze([
  { label: 'Dnes', href: '/admin', icon: 'clock' },
  { label: 'Rezervace', href: '/admin/rezervace', icon: 'check' },
  { label: 'Kalendář', href: '/admin/kalendar', icon: 'calendar' },
  { label: 'Kola', href: '/admin/kola', icon: 'bike' },
  { label: 'Ceník', href: '/admin/cenik', icon: 'card' },
  { label: 'Platby', href: '/admin/platby', icon: 'card' },
  { label: 'E-maily', href: '/admin/emaily', icon: 'mail' },
  { label: 'Poptávky', href: '/admin/nabidky', icon: 'card' },
  { label: 'Zákazníci', href: '/admin/zakaznici', icon: 'shield' },
  { label: 'Obsah', href: '/admin/obsah', icon: 'map' },
  { label: 'Nastavení', href: '/admin/nastaveni', icon: 'wrench', owner: true },
  { label: 'Audit', href: '/admin/audit', icon: 'info' },
]);

const PURPOSE_LABELS = Object.freeze({ fee: 'Rezervační poplatek', balance: 'Doplatek', deposit_hold: 'Kauce', refund: 'Vratka' });
const METHOD_LABELS = Object.freeze({ card: 'Karta online', bank_transfer: 'Převod / QR', cash: 'Hotově', terminal: 'Terminál' });
const PAYMENT_STATUS = Object.freeze({
  created: ['založena', 'neutral'],
  pending: ['čeká', 'warning'],
  paid: ['zaplaceno', 'success'],
  authorized: ['blokováno', 'info'],
  captured: ['strženo', 'info'],
  partially_captured: ['částečně strženo', 'info'],
  released: ['uvolněno', 'neutral'],
  failed: ['selhala', 'danger'],
  expired: ['propadla', 'danger'],
  refunded: ['vráceno', 'neutral'],
  partially_refunded: ['částečně vráceno', 'neutral'],
});
const LEDGER_LABELS = Object.freeze({ fee_paid: 'Poplatek zaplacen', balance_paid: 'Doplatek zaplacen', deposit_held: 'Kauce složena', deposit_captured: 'Stržení z kauce', deposit_released: 'Kauce uvolněna', refund: 'Vratka', fee_forfeited: 'Poplatek propadl', damage: 'Poškození' });
const LEDGER_SIGN = Object.freeze({ fee_paid: 1, balance_paid: 1, deposit_held: 0, deposit_captured: 1, deposit_released: 0, refund: -1, fee_forfeited: 0, damage: 0 });
const DOC_LABELS = Object.freeze({ receipt: 'Doklad o přijaté platbě', simplified_tax_doc: 'Zjednodušený daňový doklad', tax_doc: 'Daňový doklad', final_doc: 'Konečný doklad', credit_note: 'Opravný doklad', contract: 'Smlouva o nájmu', handover: 'Předávací protokol', return_protocol: 'Protokol o vrácení' });
const MAIL_LABELS = Object.freeze({ reservation_created: 'Potvrzení rezervace', payment_received: 'Platba přijata', reminder: 'Připomínka', reservation_cancelled: 'Zrušení rezervace', balance_qr: 'Doplatek – QR', contact: 'Dotaz z webu', nabidka: 'Poptávka nabídky (hotely a půjčovny)', internal_preauth_warning: 'Interní: preautorizace vyprší', internal_preauth_released: 'Interní: preautorizace uvolněna' });
const ROLE_LABELS = Object.freeze({ owner: 'majitel', staff: 'obsluha' });
const BIKE_STATUS = Object.freeze({ available: ['k dispozici', 'success'], maintenance: ['v servisu', 'warning'], retired: ['vyřazeno', 'neutral'] });
const CATEGORY_LABELS = c.CATEGORY_LABELS;
const ID_DOC_TYPES = Object.freeze({ op: 'občanský průkaz', pas: 'cestovní pas', rp: 'řidičský průkaz' });

function content(children) {
  if (children === null || children === undefined) return '';
  if (Array.isArray(children)) return joinHtml(children);
  return isHtml(children) ? children : html`${children}`;
}

function statusBadge(status) {
  return c.badge(STATUS_LABELS[status] || status, STATUS_TONES[status] || 'neutral');
}

function paymentBadge(status) {
  const [label, tone] = PAYMENT_STATUS[status] || [status, 'neutral'];
  return c.badge(label, tone);
}

function bikeBadge(status) {
  const [label, tone] = BIKE_STATUS[status] || [status, 'neutral'];
  return c.badge(label, tone);
}

function money(minor) {
  return html`<span class="num">${format.money(minor)}</span>`;
}

function dt(iso) {
  return iso ? html`<time datetime="${iso}">${format.dateTime(iso)}</time>` : html`<span class="muted">–</span>`;
}

function date(iso) {
  return iso ? html`<time datetime="${iso}">${format.date(iso)}</time>` : html`<span class="muted">–</span>`;
}

/** Odkaz na detail rezervace podle čísla. */
function reservationLink(r) {
  return html`<a class="mono" href="/admin/rezervace/${r.id}">${r.number}</a>`;
}

/**
 * Admin shell: boční navigace + hlavička stránky + flash + obsah. Vkládá se jako tělo do veřejného layoutu.
 * @param {{ title: string, body: any, user: object|null, path: string, flash?: {tone, text}|null, demo: boolean, csrf: string,
 *   actions?: any, lead?: string, wide?: boolean, counts?: object }} p
 */
function shell(p) {
  const current = (href) => (href === '/admin' ? p.path === '/admin' : p.path === href || p.path.startsWith(href + '/'));
  const items = NAV.filter((n) => !n.owner || (p.user && p.user.role === 'owner'));
  return html`<div class="admin-shell${p.wide ? ' admin-shell--wide' : ''}">
  <aside class="admin__side">
    <p class="admin__brand"><a href="/admin">Administrace</a>${p.demo ? html` <span class="badge badge--info">demo</span>` : ''}</p>
    <input class="admin__nav-toggle" type="checkbox" id="admin-nav-toggle" aria-hidden="true">
    <label class="admin__nav-label btn btn--secondary btn--sm" for="admin-nav-toggle">Menu</label>
    <nav class="admin__nav" aria-label="Administrace">
      <ul class="admin__nav-list">${items.map(
        (n) => html`<li><a class="admin__nav-link${current(n.href) ? ' is-active' : ''}" href="${n.href}"${attr({ 'aria-current': current(n.href) ? 'page' : null })}>${c.icon(n.icon)}<span>${n.label}</span>${p.counts && p.counts[n.href] ? html` <span class="admin__nav-count">${p.counts[n.href]}</span>` : ''}</a></li>`
      )}</ul>
      ${p.user
        ? html`<div class="admin__user">
        <p class="admin__user-name"><a href="/admin/ucet">${p.user.name}</a><br><small class="muted">${p.user.email} · ${ROLE_LABELS[p.user.role] || p.user.role}</small></p>
        <form class="admin__logout" method="post" action="/admin/logout"><input type="hidden" name="_csrf" value="${p.csrf}"><button class="btn btn--ghost btn--sm" type="submit">Odhlásit</button></form>
      </div>`
        : ''}
      <p class="admin__back"><a href="/">← Veřejný web</a></p>
    </nav>
  </aside>
  <div class="admin__main">
    <header class="admin__head">
      <div><h1 class="admin__title">${p.title}</h1>${p.lead ? html`<p class="admin__lead">${p.lead}</p>` : ''}</div>
      ${p.actions ? html`<div class="admin__actions">${content(p.actions)}</div>` : ''}
    </header>
    ${p.flash ? html`<div class="admin-flash" data-toast="${p.flash.tone}">${c.notice(raw(p.flash.html || ''), p.flash.tone)}</div>` : ''}
    <div class="admin__content">${content(p.body)}</div>
  </div>
</div>`;
}

/** Karta se záhlavím. */
function card({ title, children, actions, id, tone, compact } = {}) {
  return html`<section class="admin-card${tone ? ` admin-card--${tone}` : ''}${compact ? ' admin-card--compact' : ''}"${attr({ id })}>
  ${title || actions ? html`<header class="admin-card__head">${title ? html`<h2 class="admin-card__title">${title}</h2>` : ''}${actions ? html`<div class="admin-card__actions">${content(actions)}</div>` : ''}</header>` : ''}
  <div class="admin-card__body">${content(children)}</div>
</section>`;
}

/** Mřížka karet / statistik. */
function stats(items) {
  return html`<div class="admin-stats">${items.map(
    (s) => html`<a class="admin-stat${s.tone ? ` admin-stat--${s.tone}` : ''}" href="${s.href || '#'}"><span class="admin-stat__value">${s.value}</span><span class="admin-stat__label">${s.label}</span></a>`
  )}</div>`;
}

/**
 * Obal tabulky s vodorovným posunem: `.table-scroll` (pozicovaný rámec – progresivní JS mu přidává třídy
 * is-scrollable / is-scroll-left / is-scroll-right pro vyblednuté okraje a nápovědu) > `.table-wrap` (overflow-x: auto,
 * position: relative, aby absolutně pozicované `.visually-hidden` popisky polí v buňkách nepřetékaly stránku).
 * Používají ho všechny tabulky administrace (table() i ručně skládané tabulky ceníku a otevírací doby).
 */
function tableWrap(inner) {
  return html`<div class="table-scroll"><div class="table-wrap">${content(inner)}</div></div>`;
}

/**
 * Tabulka se stejnými třídami jako komponenta table(), navíc data-sortable (JS řazení kliknutím na záhlaví) a
 * volitelný filtr. rows: pole polí hodnot (Html nebo text); head: popisky (string nebo { label, align, sort: 'num'|'text'|false }).
 */
function table({ head, rows, caption, empty = 'Žádné záznamy.', sortable = true, filter = false, id, compact = true } = {}) {
  if (!rows || !rows.length) return html`<p class="admin-empty">${empty}</p>`;
  const heads = (head || []).map((h) => (typeof h === 'object' && h !== null && !isHtml(h) ? h : { label: h }));
  return html`${filter ? html`<p class="admin-filter"><label class="visually-hidden" for="${id || 'tbl'}-filter">Filtrovat tabulku</label><input class="field__input" id="${id || 'tbl'}-filter" type="search" placeholder="Filtrovat…" data-table-filter="${id || 'tbl'}"></p>` : ''}
${tableWrap(html`<table class="table${compact ? ' table--compact' : ''}"${attr({ id, 'data-sortable': sortable ? 'true' : null })}>
  ${caption ? html`<caption class="table__caption">${caption}</caption>` : ''}
  <thead><tr>${heads.map((h) => html`<th scope="col"${attr({ class: h.align ? `is-${h.align}` : null, 'data-sort': h.sort === false ? 'none' : h.sort || 'text' })}>${content(h.label)}</th>`)}</tr></thead>
  <tbody>${rows.map((r) => html`<tr>${r.map((cell, i) => html`<td${attr({ class: heads[i] && heads[i].align ? `is-${heads[i].align}` : null })}>${content(cell)}</td>`)}</tr>`)}</tbody>
</table>`)}`;
}

/** Formulář s CSRF (admin session) – obal nad komponentou form s volitelným potvrzením (data-confirm pro JS). */
function form({ action, csrf, children, submit, submitVariant = 'primary', confirm, inline, attrs = {}, method = 'post' } = {}) {
  return c.form({ action, method, csrf, children, submit, submitVariant, attrs: { ...(confirm ? { 'data-confirm': confirm } : {}), ...(inline ? { class: 'form form--inline' } : {}), ...attrs } });
}

/** Tlačítkový formulář (jedna akce). */
function actionButton({ action, csrf, label, variant = 'secondary', confirm, hidden = {}, size = 'sm' }) {
  return html`<form class="form form--inline" method="post" action="${action}"${attr({ 'data-confirm': confirm || null })}><input type="hidden" name="_csrf" value="${csrf}">${Object.entries(hidden).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v ?? ''}">`)}${c.button({ label, type: 'submit', variant, size })}</form>`;
}

/** Peněžní pole (Kč, desetinné). value v haléřích. */
function moneyField({ label, name, valueMinor, required, hint, min = 0, step = 'any' }) {
  const v = valueMinor === undefined || valueMinor === null ? '' : (Number(valueMinor) / 100).toFixed(Number(valueMinor) % 100 === 0 ? 0 : 2);
  return c.field({ label, name, type: 'number', value: v, required, hint, min, step, inputmode: 'decimal', attrs: { 'data-money': true } });
}

/** Stránkování: ?strana=n */
function pager({ page, pages, href }) {
  if (pages <= 1) return '';
  const link = (n, label) => html`<a class="btn btn--ghost btn--sm" href="${href}${href.includes('?') ? '&' : '?'}strana=${n}">${label}</a>`;
  return html`<nav class="admin-pager" aria-label="Stránkování">${page > 1 ? link(page - 1, '← Předchozí') : ''}<span class="admin-pager__info">Strana ${page} z ${pages}</span>${page < pages ? link(page + 1, 'Další →') : ''}</nav>`;
}

/** Souhrn položek rezervace: „2× Trekové kolo (M), 1× Dětské kolo (20")“. */
function itemsSummary(items) {
  if (!items || !items.length) return html`<span class="muted">bez položek</span>`;
  return html`${items.map((it, i) => html`${i ? ', ' : ''}${it.qty}× ${it.typeName}${it.size ? html` <small class="muted">(${it.size})</small>` : ''}`)}`;
}

module.exports = {
  NAV,
  PURPOSE_LABELS,
  METHOD_LABELS,
  PAYMENT_STATUS,
  LEDGER_LABELS,
  LEDGER_SIGN,
  DOC_LABELS,
  MAIL_LABELS,
  ROLE_LABELS,
  BIKE_STATUS,
  CATEGORY_LABELS,
  ID_DOC_TYPES,
  content,
  statusBadge,
  paymentBadge,
  bikeBadge,
  money,
  dt,
  date,
  reservationLink,
  shell,
  card,
  stats,
  tableWrap,
  table,
  form,
  actionButton,
  moneyField,
  pager,
  itemsSummary,
  html,
  raw,
  attr,
  c,
  format,
};
