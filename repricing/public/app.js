// Cenotvorba – vstupní bod SPA: rozvržení (postranní menu, horní lišta), hash router, přihlášení,
// odznak čekajících návrhů, globální akce „Spustit přecenění“ a přepínání motivu.
import { h, mount } from './lib/dom.js';
import { api, onUnauthorized, isAbort, invalidate } from './lib/api.js';
import { parseHash, matchRoute, buildHash, queryString } from './lib/router.js';
import { icon, brandMark } from './lib/icons.js';
import { toast } from './lib/toast.js';
import { openModal, confirmDialog, closeAllModals } from './lib/modal.js';
import { button, emptyState, skeletonBlocks, skeletonTable, errorState } from './lib/ui.js';
import { runStatsView, supersedeWarning } from './lib/run-stats.js';
import { int, count } from './lib/format.js';

const NAV = [
  { section: 'Cenotvorba' },
  { path: '/prehled', label: 'Přehled', icon: 'dashboard' },
  { path: '/produkty', label: 'Produkty', icon: 'box' },
  { path: '/navrhy', label: 'Návrhy cen', icon: 'tag', badge: 'pending' },
  { path: '/strategie', label: 'Strategie', icon: 'sliders' },
  { path: '/segmenty', label: 'Segmenty', icon: 'layers' },
  { path: '/konkurence', label: 'Konkurence', icon: 'store' },
  { section: 'Data' },
  { path: '/import', label: 'Import dat', icon: 'upload' },
  { path: '/export', label: 'Export', icon: 'download' },
  { section: 'Systém' },
  { path: '/nastaveni', label: 'Nastavení', icon: 'settings' },
];

const ROUTES = [
  { pattern: '/login', load: () => import('./views/login.js'), bare: true, public: true },
  { pattern: '/prehled', load: () => import('./views/dashboard.js'), nav: '/prehled' },
  { pattern: '/produkty', load: () => import('./views/products.js'), nav: '/produkty' },
  { pattern: '/produkty/:id', load: () => import('./views/product-detail.js'), nav: '/produkty' },
  { pattern: '/navrhy', load: () => import('./views/proposals.js'), nav: '/navrhy' },
  { pattern: '/strategie', load: () => import('./views/strategies.js'), nav: '/strategie' },
  { pattern: '/strategie/:id', load: () => import('./views/strategy-edit.js'), nav: '/strategie' },
  { pattern: '/segmenty', load: () => import('./views/segments.js'), nav: '/segmenty' },
  { pattern: '/segmenty/:id', load: () => import('./views/segment-edit.js'), nav: '/segmenty' },
  { pattern: '/konkurence', load: () => import('./views/competitors.js'), nav: '/konkurence' },
  { pattern: '/import', load: () => import('./views/import.js'), nav: '/import' },
  { pattern: '/export', load: () => import('./views/export.js'), nav: '/export' },
  { pattern: '/nastaveni', load: () => import('./views/settings.js'), nav: '/nastaveni' },
];

const DEFAULT_ROUTE = '/prehled';

const state = {
  me: null,
  version: null,
  layout: null,
  controller: null,
  cleanups: [],
  renderSeq: 0,
  current: null,
  badgeTimer: null,
  confirmingRun: false,
};

const appEl = document.getElementById('app');

// ------------------------------------------------------------------ motiv

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'Motiv: podle systému', light: 'Motiv: světlý', dark: 'Motiv: tmavý' };
const THEME_ICON = { auto: 'monitor', light: 'sun', dark: 'moon' };

function getTheme() {
  try {
    const t = localStorage.getItem('ct-theme');
    return THEMES.includes(t) ? t : 'auto';
  } catch {
    return 'auto';
  }
}

function applyTheme(t) {
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

function setTheme(t) {
  try {
    localStorage.setItem('ct-theme', t);
  } catch {
    /* soukromé okno – jen pro tuto relaci */
  }
  applyTheme(t);
}

applyTheme(getTheme());

// ------------------------------------------------------------------ rozvržení

function buildLayout() {
  const navLinks = new Map();
  const badges = {};
  const items = [];
  let list = null;
  for (const n of NAV) {
    if (n.section) {
      items.push(h('div', { class: 'nav-section' }, n.section));
      list = h('ul', { class: 'nav' });
      items.push(list);
      continue;
    }
    const badge = n.badge ? h('span', { class: 'nav-badge', hidden: true, 'aria-label': 'čekajících návrhů' }) : null;
    if (badge) badges[n.badge] = badge;
    const a = h('a', { href: '#' + n.path, dataset: { nav: n.path } }, icon(n.icon, { size: 18 }), h('span', null, n.label), badge);
    navLinks.set(n.path, a);
    list.appendChild(h('li', null, a));
  }
  const themeLabel = h('span', null, THEME_LABEL[getTheme()]);
  const themeIcon = h('span', { class: 'theme-icon' }, icon(THEME_ICON[getTheme()], { size: 18 }));
  const themeBtn = h(
    'button',
    {
      type: 'button',
      class: 'side-btn',
      title: 'Přepnout motiv (podle systému / světlý / tmavý)',
      onClick: () => {
        const next = THEMES[(THEMES.indexOf(getTheme()) + 1) % THEMES.length];
        setTheme(next);
        themeLabel.textContent = THEME_LABEL[next];
        mount(themeIcon, icon(THEME_ICON[next], { size: 18 }));
      },
    },
    themeIcon,
    themeLabel
  );
  const userEl = h('div', { class: 'side-user', dataset: { role: 'user-name' } }, icon('user', { size: 16 }), h('span', { class: 'ellipsis' }, state.me?.user || ''));
  const versionEl = h('div', { class: 'side-version' });
  const sidebar = h(
    'aside',
    { class: 'sidebar', id: 'sidebar', 'aria-label': 'Hlavní navigace' },
    h('a', { class: 'brand', href: '#' + DEFAULT_ROUTE }, brandMark(), h('span', null, 'Cenotvorba', h('small', null, 'repricing & cenotvorba'))),
    h('nav', { 'aria-label': 'Sekce aplikace' }, items),
    h(
      'div',
      { class: 'sidebar-foot' },
      themeBtn,
      h('button', { type: 'button', class: 'side-btn', onClick: logout }, icon('logout', { size: 18 }), h('span', null, 'Odhlásit se')),
      userEl,
      versionEl
    )
  );
  const backdrop = h('div', { class: 'sidebar-backdrop', onClick: () => toggleNav(false) });
  const menuBtn = h(
    'button',
    { type: 'button', class: 'btn btn-ghost btn-icon-only menu-toggle', 'aria-label': 'Otevřít menu', 'aria-controls': 'sidebar', 'aria-expanded': 'false', onClick: () => toggleNav() },
    icon('menu', { size: 20 })
  );
  const title = h('h1', { class: 'page-title', id: 'page-title' }, '');
  const sub = h('div', { class: 'page-sub' });
  const actions = h('div', { class: 'top-actions' });
  const runBtn = button('Spustit přecenění', { variant: 'primary', icon: 'play', onClick: () => runPricing(), dataset: { action: 'run-pricing' } });
  runBtn.title = 'Přepočítat návrhy cen pro všechny aktivní produkty';
  const topbar = h('header', { class: 'topbar' }, menuBtn, h('div', { class: 'titles' }, title, sub), actions, runBtn);
  const content = h('main', { class: 'content', id: 'content', tabindex: '-1' });
  const root = h(
    'div',
    { class: 'app' },
    h('a', { class: 'skip-link', href: '#content', onClick: (e) => { e.preventDefault(); content.focus(); } }, 'Přeskočit na obsah'),
    sidebar,
    backdrop,
    h('div', { class: 'main' }, topbar, content)
  );
  return { root, sidebar, navLinks, badges, title, sub, actions, runBtn, content, menuBtn, userEl, versionEl };
}

function toggleNav(force) {
  const L = state.layout;
  if (!L) return;
  const open = force ?? !L.root.classList.contains('nav-open');
  L.root.classList.toggle('nav-open', open);
  L.menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  L.menuBtn.setAttribute('aria-label', open ? 'Zavřít menu' : 'Otevřít menu');
  if (open) L.sidebar.querySelector('a[aria-current="page"], a')?.focus();
}

function ensureLayout() {
  if (state.layout && state.layout.root.isConnected) return state.layout;
  state.layout = buildLayout();
  mount(appEl, state.layout.root);
  refreshBadge();
  if (state.badgeTimer) clearInterval(state.badgeTimer);
  state.badgeTimer = setInterval(() => {
    if (document.visibilityState === 'visible') refreshBadge();
  }, 60000);
  api.get('/health', null, { silent: true }).then((r) => {
    if (r?.version && state.layout) state.layout.versionEl.textContent = 'verze ' + r.version;
  }, () => {});
  return state.layout;
}

function setActiveNav(navPath) {
  for (const [path, a] of state.layout.navLinks) {
    if (path === navPath) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

// ------------------------------------------------------------------ odznak a globální akce

export async function refreshBadge() {
  const L = state.layout;
  if (!L) return;
  try {
    const r = await api.get('/proposals', { status: 'pending', limit: 1 }, { silent: true });
    const n = r?.summary?.pending ?? r?.total ?? 0;
    const b = L.badges.pending;
    b.textContent = n > 999 ? '999+' : String(n);
    b.hidden = !n;
    b.setAttribute('aria-label', int(n) + ' čekajících návrhů');
  } catch {
    /* odznak není kritický */
  }
}

/** Oznámí zobrazeným pohledům, že se data změnila (po přecenění, schválení …). */
export function notifyChanged(what = 'data') {
  invalidate();
  window.dispatchEvent(new CustomEvent('ct:changed', { detail: { what } }));
  refreshBadge();
}

/** Počet schválených, dosud neexportovaných návrhů (null = nepodařilo se zjistit). */
async function approvedCount() {
  try {
    const r = await api.get('/proposals', { status: 'approved', limit: 1 }, { silent: true });
    return r?.summary?.approved ?? r?.total ?? null;
  } catch {
    return null;
  }
}

export async function runPricing(opts = {}) {
  if (!opts.skipConfirm) {
    if (state.confirmingRun) return null; // dvojklik během zjišťování počtu neotevře dva dialogy
    state.confirmingRun = true;
    let ok = false;
    try {
      // contract-1: přecenění nahradí i SCHVÁLENÉ neexportované návrhy (a jejich ruční ceny) – říct to výslovně s počtem
      const warn = opts.productIds ? null : supersedeWarning(await approvedCount());
      ok = await confirmDialog({
        title: 'Spustit přecenění',
        message: h(
          'div',
          null,
          h('p', null, (opts.productIds
            ? 'Přepočítá návrh ceny pro vybrané produkty podle aktuálních strategií.'
            : 'Přepočítá návrhy cen pro všechny aktivní produkty podle zapnutých strategií.') +
            ' Otevřené návrhy, u kterých vyjde jiná cena, nahradí nové – i schválené, dosud neexportované (ruční ceny se přenesou, ale čekají na nové schválení).'),
          warn ? h('div', { class: 'callout callout-warning', dataset: { role: 'supersede-warning' } }, icon('alert', { size: 16 }), h('div', { class: 'callout-body' }, warn)) : null
        ),
        confirmLabel: warn ? 'Přesto přecenit' : 'Spustit přecenění',
        danger: Boolean(warn),
      });
    } finally {
      state.confirmingRun = false;
    }
    if (!ok) return null;
  }
  const btn = state.layout?.runBtn;
  if (btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
  }
  const t = toast('Přeceňuji…', { type: 'info', timeout: 0 });
  try {
    const res = await api.post('/runs', opts.productIds ? { product_ids: opts.productIds } : {});
    t.close();
    notifyChanged('run');
    if (opts.quiet) {
      const sup = Number(res?.stats?.superseded) || 0;
      toast('Přecenění dokončeno' + (sup ? ' · ' + count(sup, 'starší návrh nahrazen', 'starší návrhy nahrazeny', 'starších návrhů nahrazeno') : ''), { type: 'success' });
      return res;
    }
    const m = openModal({
      title: 'Přecenění dokončeno',
      size: 'lg',
      body: [res?.run_id ? h('p', { class: 'muted' }, 'Běh #' + res.run_id) : null, runStatsView(res?.stats || {})],
      footer: [
        h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Zavřít'),
        h('a', { class: 'btn btn-primary', href: '#/navrhy', onClick: () => m.close() }, 'Zobrazit návrhy'),
      ],
    });
    return res;
  } catch {
    t.close();
    return null;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
    }
  }
}

async function logout() {
  try {
    await api.post('/auth/logout', {}, { silent: true });
  } catch {
    /* odhlášení lokálně i tak */
  }
  state.me = null;
  if (state.badgeTimer) clearInterval(state.badgeTimer);
  state.layout = null;
  location.hash = '#/login';
}

// ------------------------------------------------------------------ router

function currentHash() {
  return location.hash || '#' + DEFAULT_ROUTE;
}

function navigate(hash, { replace = false } = {}) {
  if (replace) {
    history.replaceState(null, '', hash);
    render();
  } else location.hash = hash;
}

/** Změní query v hashi bez znovuvykreslení pohledu (filtry v URL). */
function setQuery(query) {
  const { path } = parseHash(location.hash);
  const next = buildHash(path, query);
  if (next !== location.hash) history.replaceState(null, '', next);
}

onUnauthorized(() => {
  state.me = null;
  const { path, query } = parseHash(currentHash());
  if (path === '/login') return;
  location.hash = '#/login' + queryString({ next: path + queryString(query) });
});

function runCleanups() {
  // dialogy opouštěné stránky zavřít (jinak by zůstaly nad novou stránkou a dál jednaly – contract-15)
  closeAllModals('nav');
  if (state.controller) state.controller.abort();
  for (const fn of state.cleanups.splice(0)) {
    try {
      fn();
    } catch {
      /* úklid nesmí shodit navigaci */
    }
  }
}

async function ensureMe() {
  if (state.me) return true;
  try {
    state.me = await api.get('/auth/me', null, { silent: true, allow401: true });
    return true;
  } catch (e) {
    if (e.status === 401) return false;
    throw e;
  }
}

function pageSkeleton() {
  return h('div', { class: 'skeleton-page', 'aria-hidden': 'true' }, skeletonBlocks(4, 84), h('div', { class: 'card' }, skeletonTable(8, 7)));
}

// Pro testy/automatizaci: <div id="app" data-render-seq="N" data-ready="N"> – ready = seq, když je pohled načtený.
function markReady(seq) {
  if (seq === state.renderSeq) appEl.dataset.ready = String(seq);
}

async function render() {
  const seq = ++state.renderSeq;
  appEl.dataset.renderSeq = String(seq);
  appEl.removeAttribute('data-ready');
  const { path, query } = parseHash(currentHash());
  if (path === '/') {
    navigate('#' + DEFAULT_ROUTE, { replace: true });
    return;
  }
  runCleanups();
  const match = matchRoute(ROUTES, path);
  const route = match?.route;

  if (route?.public) {
    state.layout = null;
    const mod = await route.load();
    if (seq !== state.renderSeq) return;
    const root = h('div');
    mount(appEl, root);
    const controller = new AbortController();
    state.controller = controller;
    await mod.show(root, makeCtx(root, match, query, controller, route));
    markReady(seq);
    return;
  }

  let authed;
  try {
    authed = await ensureMe();
  } catch (e) {
    if (seq !== state.renderSeq) return;
    mount(appEl, h('div', { class: 'login' }, h('div', { class: 'login-card' }, errorState(e, () => render()))));
    markReady(seq);
    return;
  }
  if (seq !== state.renderSeq) return;
  if (!authed) {
    location.hash = '#/login' + queryString({ next: path + queryString(query) });
    return;
  }

  const L = ensureLayout();
  // C9: jméno z přihlášení (jinak „admin“) – jen pro přehled, kdo schvaluje
  L.userEl.lastChild.textContent = state.me?.user || '';
  L.userEl.title = state.me?.user ? 'Přihlášen jako ' + state.me.user + ' (jméno se zapisuje ke schválení a do auditu)' : '';
  toggleNav(false);
  L.actions.replaceChildren();
  L.sub.replaceChildren();
  L.content.dataset.view = '';

  if (!route) {
    setActiveNav(null);
    setTitle('Stránka nenalezena');
    mount(L.content, emptyState({ icon: 'alert', title: 'Tato stránka neexistuje', text: 'Adresa ' + path + ' neodpovídá žádné sekci.', actions: [h('a', { class: 'btn btn-primary', href: '#' + DEFAULT_ROUTE }, 'Zpět na přehled')] }));
    markReady(seq);
    return;
  }
  setActiveNav(route.nav);
  mount(L.content, pageSkeleton());
  let mod;
  try {
    mod = await route.load();
  } catch (e) {
    if (seq !== state.renderSeq) return;
    mount(L.content, errorState(new Error('Stránku se nepodařilo načíst: ' + e.message), () => render()));
    markReady(seq);
    return;
  }
  if (seq !== state.renderSeq) return;
  const controller = new AbortController();
  state.controller = controller;
  const root = h('div', { class: 'view' });
  mount(L.content, root);
  L.content.dataset.view = route.pattern.split('/')[1] + (route.pattern.includes(':') ? '-detail' : '');
  if (mod.title) setTitle(mod.title);
  try {
    await mod.show(root, makeCtx(root, match, query, controller, route));
  } catch (e) {
    if (isAbort(e) || seq !== state.renderSeq) return;
    console.error(e);
    mount(root, errorState(e, () => render()));
  }
  markReady(seq);
}

function setTitle(title, sub) {
  const L = state.layout;
  document.title = (title ? title + ' · ' : '') + 'Cenotvorba';
  if (!L) return;
  L.title.textContent = title || '';
  if (sub === undefined) return;
  mount(L.sub, sub || '');
}

function makeCtx(root, match, query, controller, route) {
  return {
    params: match?.params || {},
    query,
    route,
    signal: controller.signal,
    me: state.me,
    setTitle,
    setSub: (sub) => state.layout && mount(state.layout.sub, sub || ''),
    setActions: (...nodes) => state.layout && mount(state.layout.actions, nodes.flat().filter(Boolean)),
    navigate,
    setQuery,
    refreshBadge,
    notifyChanged,
    runPricing,
    onCleanup: (fn) => state.cleanups.push(fn),
    /** Přihlásí posluchač na změnu dat (po přecenění apod.), automaticky se odhlásí při odchodu. */
    onChanged: (fn) => {
      const handler = (e) => fn(e.detail?.what);
      window.addEventListener('ct:changed', handler);
      state.cleanups.push(() => window.removeEventListener('ct:changed', handler));
    },
    loggedIn: (me) => {
      state.me = me || state.me;
    },
  };
}

window.addEventListener('hashchange', () => render());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.layout?.root.classList.contains('nav-open') && !document.querySelector('dialog[open]')) toggleNav(false);
});
window.addEventListener('unhandledrejection', (e) => {
  if (isAbort(e.reason)) {
    e.preventDefault();
    return;
  }
  if (e.reason && e.reason.name === 'ApiError') {
    // chyba API už byla oznámena toastem
    e.preventDefault();
  }
});

render();
