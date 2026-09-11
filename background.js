/*
 * Service worker rozšíření – běží na pozadí.
 *  - přijímá zprávy z content skriptu (detekce, žádost o analýzu)
 *  - stahuje odkazované dokumenty s podmínkami (fetch s host_permissions obejde CORS)
 *  - volá Claude API nebo offline analyzátor, výsledky cachuje
 *  - nastavuje badge na ikoně, posílá systémové notifikace
 *  - kontextové menu: „Analyzovat vybraný text“ / „Analyzovat tuto stránku“
 */
importScripts('lib/keywords.js', 'lib/detector.js', 'lib/extract.js', 'lib/schema.js', 'lib/local-analyzer.js', 'lib/claude.js');

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'claude-opus-5',
  effort: 'medium',
  autoMode: true,          // aktivovat se sama na pokladně / registraci / instalaci
  autoOnDocuments: true,   // analyzovat i přímo otevřené stránky s podmínkami
  showOverlay: true,       // zobrazit panel přímo ve stránce
  notify: true,            // systémová notifikace u nebezpečných podmínek
  useLocalFallback: true,  // bez klíče použít offline analýzu
  minTextLength: 800,
  ignoredHosts: [],
};

const CACHE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_CACHE_ENTRIES = 300;
const inflight = new Map(); // klíč -> Promise (dedup souběžných analýz)
const tabState = new Map(); // tabId -> { status, result, error, url }

// ---------- pomocné ----------
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

async function cacheGet(key) {
  const { cache } = await chrome.storage.local.get('cache');
  const entry = cache && cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) return null;
  return entry.result;
}

async function cacheSet(key, result) {
  const { cache } = await chrome.storage.local.get('cache');
  const c = cache || {};
  c[key] = { ts: Date.now(), result };
  const keys = Object.keys(c);
  if (keys.length > MAX_CACHE_ENTRIES) {
    keys.sort((a, b) => c[a].ts - c[b].ts).slice(0, keys.length - MAX_CACHE_ENTRIES).forEach((k) => delete c[k]);
  }
  await chrome.storage.local.set({ cache: c });
}

async function addHistory(entry) {
  const { history } = await chrome.storage.local.get('history');
  const h = history || [];
  h.unshift(entry);
  await chrome.storage.local.set({ history: h.slice(0, 100) });
}

function hostOf(url) { try { return new URL(url).hostname; } catch (e) { return ''; } }

function setBadge(tabId, result, status) {
  if (tabId == null) return;
  const map = { standardni: { text: 'OK', color: '#2e7d32' }, pozor: { text: '!', color: '#f9a825' }, nebezpecne: { text: '!!', color: '#c62828' } };
  let cfg;
  if (status === 'loading') cfg = { text: '…', color: '#546e7a' };
  else if (status === 'error') cfg = { text: 'x', color: '#546e7a' };
  else if (result) cfg = map[result.verdict] || { text: '?', color: '#546e7a' };
  else cfg = { text: '', color: '#546e7a' };
  chrome.action.setBadgeText({ tabId, text: cfg.text }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color }).catch(() => {});
}

function notifyIfNeeded(settings, result, meta) {
  if (!settings.notify || !result || result.verdict === 'standardni') return;
  const title = result.verdict === 'nebezpecne' ? 'Pozor: rizikové podmínky' : 'Podmínky stojí za pozornost';
  const crit = (result.findings || []).filter((f) => f.severity !== 'info').slice(0, 3).map((f) => '• ' + f.title).join('\n');
  chrome.notifications.create('terms-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message: (hostOf(meta.url) ? hostOf(meta.url) + '\n' : '') + (crit || result.summary.slice(0, 200)),
    priority: result.verdict === 'nebezpecne' ? 2 : 1,
  }, () => void chrome.runtime.lastError);
}

// ---------- stažení odkazovaných dokumentů ----------
async function fetchDocument(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', redirect: 'follow' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const ct = res.headers.get('content-type') || '';
    if (/pdf/i.test(ct) || /\.pdf(\?|$)/i.test(url)) {
      return { url, title: url, text: '', error: 'PDF – rozšíření zatím neumí číst PDF. Otevřete dokument a použijte „Analyzovat vybraný text“.' };
    }
    const html = await res.text();
    return { url, title: TermsExtract.titleFromHtml(html) || url, text: TermsExtract.fromHtml(html) };
  } catch (e) {
    return { url, title: url, text: '', error: e && e.message ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

// ---------- jádro: analýza textu ----------
async function analyzeText(text, meta, settings, opts = {}) {
  text = TermsExtract.cleanWhitespace(text || '');
  if (text.length < (opts.minLength != null ? opts.minLength : 200)) {
    throw new Error('Text je příliš krátký na analýzu (' + text.length + ' znaků).');
  }
  const engine = settings.apiKey ? 'claude' : (settings.useLocalFallback ? 'local' : null);
  if (!engine) throw new Error('NO_API_KEY');

  const key = engine + ':' + (settings.apiKey ? settings.model : 'local') + ':' + TermsExtract.hash(text);
  if (!opts.force) {
    const cached = await cacheGet(key);
    if (cached) return Object.assign({}, cached, { _cached: true });
  }
  if (inflight.has(key)) return inflight.get(key);

  const p = (async () => {
    let result;
    if (engine === 'claude') {
      try {
        result = await TermsClaude.analyze(text, meta, settings);
      } catch (e) {
        if (settings.useLocalFallback) {
          result = TermsLocalAnalyzer.analyze(text, meta);
          result._fallbackError = e.message;
          result.summary = 'Claude API selhalo (' + e.message + '). ' + result.summary;
        } else {
          throw e;
        }
      }
    } else {
      result = TermsLocalAnalyzer.analyze(text, meta);
    }
    result._analyzedAt = Date.now();
    result._textLength = text.length;
    await cacheSet(key, result);
    await addHistory({ ts: result._analyzedAt, url: meta.url, title: meta.title, verdict: result.verdict, risk_score: result.risk_score, engine: result._engine, document_type: result.document_type });
    return result;
  })();
  inflight.set(key, p);
  try { return await p; } finally { inflight.delete(key); }
}

// Analýza „kontextu souhlasu“: stáhne odkazované dokumenty, spojí a analyzuje.
async function analyzeConsentContext(detection, pageMeta, settings) {
  const links = (detection.termsLinks || []).slice(0, 4);
  const docs = await Promise.all(links.map((l) => fetchDocument(l.url)));
  const good = docs.filter((d) => d.text && d.text.length >= 500);
  if (!good.length) {
    const errs = docs.map((d) => d.error).filter(Boolean).join('; ');
    throw new Error('Nepodařilo se stáhnout odkazované podmínky' + (errs ? ' (' + errs + ')' : '') + '.');
  }
  const combined = good.map((d) => '===== ' + d.title + ' (' + d.url + ') =====\n' + d.text).join('\n\n');
  const meta = {
    url: pageMeta.url,
    title: pageMeta.title,
    context: describeContext(detection.context) + '. Stránka odkazuje na tyto dokumenty: ' + good.map((d) => d.title).join(', '),
    sources: good.map((d) => ({ url: d.url, title: d.title, length: d.text.length })),
  };
  const result = await analyzeText(combined, meta, settings);
  result._sources = meta.sources;
  return result;
}

function describeContext(ctx) {
  const names = { checkout: 'dokončuje nákup / objednávku', signup: 'zakládá účet / registruje se', install: 'instaluje aplikaci či rozšíření' };
  const parts = (ctx || []).map((c) => names[c]).filter(Boolean);
  return parts.length ? 'Uživatel právě ' + parts.join(' a ') : 'Uživatel má před sebou souhlas s podmínkami';
}

// ---------- zprávy ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const tabId = sender.tab ? sender.tab.id : (msg.tabId != null ? msg.tabId : null);
    try {
      switch (msg.type) {
        case 'PAGE_DETECTED': return await onPageDetected(msg, sender, tabId);
        case 'ANALYZE_TEXT': {
          const settings = await getSettings();
          setBadge(tabId, null, 'loading');
          setState(tabId, { status: 'loading', url: msg.meta && msg.meta.url });
          const result = await analyzeText(msg.text, msg.meta || {}, settings, { force: !!msg.force, minLength: msg.minLength });
          setState(tabId, { status: 'done', result, url: msg.meta && msg.meta.url });
          setBadge(tabId, result);
          return { ok: true, result };
        }
        case 'ANALYZE_LINKS': {
          const settings = await getSettings();
          setBadge(tabId, null, 'loading');
          setState(tabId, { status: 'loading', url: msg.meta && msg.meta.url });
          const result = await analyzeConsentContext({ termsLinks: msg.links, context: msg.context || [] }, msg.meta || {}, settings);
          setState(tabId, { status: 'done', result, url: msg.meta && msg.meta.url });
          setBadge(tabId, result);
          return { ok: true, result };
        }
        case 'GET_TAB_STATE': return { ok: true, state: tabState.get(msg.tabId) || null };
        case 'GET_SETTINGS': return { ok: true, settings: await getSettings() };
        case 'SAVE_SETTINGS': {
          const settings = Object.assign({}, await getSettings(), msg.settings || {});
          await chrome.storage.local.set({ settings });
          return { ok: true, settings };
        }
        case 'OPEN_OPTIONS': chrome.runtime.openOptionsPage(); return { ok: true };
        case 'CLEAR_CACHE': await chrome.storage.local.set({ cache: {} }); return { ok: true };
        case 'TEST_API_KEY': {
          const settings = Object.assign({}, await getSettings(), { apiKey: msg.apiKey, model: msg.model || 'claude-opus-5', useLocalFallback: false });
          const r = await TermsClaude.analyze('Testovací text. Cena služby je 10 Kč měsíčně. Předplatné lze zrušit e-mailem na info@example.com s výpovědní lhůtou 30 dní.', { url: 'test', title: 'test' }, Object.assign({}, settings, { effort: 'low' }));
          return { ok: true, model: r._model, usage: r._usage };
        }
        default: return { ok: false, error: 'Neznámý typ zprávy: ' + msg.type };
      }
    } catch (e) {
      const error = e && e.message ? e.message : String(e);
      if (tabId != null) { setState(tabId, { status: 'error', error }); setBadge(tabId, null, error === 'NO_API_KEY' ? '' : 'error'); }
      return { ok: false, error };
    }
  })().then(sendResponse);
  return true; // asynchronní odpověď
});

function setState(tabId, patch) {
  if (tabId == null) return;
  tabState.set(tabId, Object.assign({}, tabState.get(tabId) || {}, patch, { ts: Date.now() }));
}

async function onPageDetected(msg, sender, tabId) {
  const settings = await getSettings();
  const det = msg.detection;
  const host = hostOf(msg.meta.url);
  setState(tabId, { status: 'detected', detection: det, url: msg.meta.url, result: null, error: null });

  if (settings.ignoredHosts.includes(host)) return { ok: true, action: 'ignored' };
  if (det.kind === 'document' && !settings.autoOnDocuments) return { ok: true, action: 'skip' };
  if (det.kind === 'consent' && !settings.autoMode) return { ok: true, action: 'skip' };
  if (!settings.apiKey && !settings.useLocalFallback) return { ok: true, action: 'no_key' };

  setBadge(tabId, null, 'loading');
  setState(tabId, { status: 'loading' });
  let result;
  if (det.kind === 'document') {
    result = await analyzeText(msg.text, { url: msg.meta.url, title: msg.meta.title, context: 'Uživatel si otevřel přímo tento dokument.' }, settings, { minLength: settings.minTextLength });
  } else {
    result = await analyzeConsentContext(det, msg.meta, settings);
  }
  setState(tabId, { status: 'done', result });
  setBadge(tabId, result);
  if (!result._cached) notifyIfNeeded(settings, result, msg.meta);
  if (settings.showOverlay && tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: 'SHOW_RESULT', result, detection: det }).catch(() => {});
  }
  return { ok: true, action: 'analyzed', result };
}

// ---------- kontextové menu ----------
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'analyze-selection', title: 'Analyzovat vybraný text jako podmínky', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'analyze-page', title: 'Analyzovat tuto stránku jako podmínky', contexts: ['page'] });
    chrome.contextMenus.create({ id: 'analyze-link', title: 'Analyzovat odkazované podmínky', contexts: ['link'] });
  });
  const { settings } = await chrome.storage.local.get('settings');
  if (!settings) {
    await chrome.storage.local.set({ settings: DEFAULT_SETTINGS });
    chrome.runtime.openOptionsPage();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  const settings = await getSettings();
  try {
    setBadge(tab.id, null, 'loading');
    setState(tab.id, { status: 'loading', url: tab.url });
    let result;
    if (info.menuItemId === 'analyze-selection') {
      result = await analyzeText(info.selectionText || '', { url: tab.url, title: tab.title, context: 'Uživatel označil text ručně.' }, settings, { minLength: 100 });
    } else if (info.menuItemId === 'analyze-link') {
      result = await analyzeConsentContext({ termsLinks: [{ url: info.linkUrl }], context: [] }, { url: tab.url, title: tab.title }, settings);
    } else {
      const [inj] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => (window.__termsGuardExtract ? window.__termsGuardExtract() : document.body.innerText) });
      result = await analyzeText(inj && inj.result ? inj.result : '', { url: tab.url, title: tab.title, context: 'Uživatel požádal o analýzu celé stránky.' }, settings, { minLength: 200 });
    }
    setState(tab.id, { status: 'done', result });
    setBadge(tab.id, result);
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_RESULT', result, detection: { kind: 'manual' } }).catch(() => {});
  } catch (e) {
    const error = e && e.message ? e.message : String(e);
    setState(tab.id, { status: 'error', error });
    setBadge(tab.id, null, 'error');
    chrome.tabs.sendMessage(tab.id, { type: 'SHOW_ERROR', error }).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabState.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' && info.url) { tabState.delete(tabId); setBadge(tabId, null, ''); } });

// Úklid cache jednou denně.
chrome.alarms.create('cleanup', { periodInMinutes: 24 * 60 });
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'cleanup') return;
  const { cache } = await chrome.storage.local.get('cache');
  if (!cache) return;
  const now = Date.now();
  for (const k of Object.keys(cache)) if (now - cache[k].ts > CACHE_TTL_MS) delete cache[k];
  await chrome.storage.local.set({ cache });
});
