/*
 * Content skript – běží na každé stránce (lehce, bez síťových požadavků):
 *  1. sesbírá signály (URL, titulek, nadpisy, tlačítka, labely, odkazy, formuláře)
 *  2. detektor rozhodne: dokument s podmínkami / kontext souhlasu / nic
 *  3. pošle pozadí zprávu PAGE_DETECTED → pozadí analyzuje a pošle zpět SHOW_RESULT
 *  4. vykreslí plovoucí panel v shadow DOM
 */
(function () {
  'use strict';
  if (window.__termsGuardLoaded) return;
  window.__termsGuardLoaded = true;

  const D = self.TermsDetector;
  const E = self.TermsExtract;
  const R = self.TermsRender;

  let lastKey = null;      // aby se stejná stránka neanalyzovala dvakrát
  let checks = 0;          // omezení počtu opakovaných kontrol na SPA
  let panel = null;

  function collectSignals() {
    const q = (sel, max) => Array.from(document.querySelectorAll(sel)).slice(0, max);
    const txt = (el) => (el.innerText || el.textContent || el.value || '').trim();
    const buttons = q('button, input[type=submit], input[type=button], a.btn, a.button, [role=button]', 150).map(txt).filter(Boolean);
    const labels = q('label, .checkbox, .form-check, [class*=consent], [class*=agree], [class*=souhlas]', 150).map(txt).filter(Boolean);
    const headings = q('h1, h2', 30).map(txt).filter(Boolean);
    const links = q('a[href]', 800).map((a) => ({ href: a.getAttribute('href'), text: txt(a) || a.getAttribute('title') || a.getAttribute('aria-label') || '' }));
    const hasPasswordField = !!document.querySelector('input[type=password]');
    const hasPaymentField = !!document.querySelector('input[autocomplete^=cc-], input[name*=card], input[name*=karta], iframe[src*=stripe], iframe[src*=adyen], iframe[src*=gopay], iframe[src*=comgate], iframe[src*=paypal], iframe[src*=braintree]');
    const text = E.fromDocument(document);
    return { url: location.href, title: document.title, headings, buttons, labels, links, hasPasswordField, hasPaymentField, text };
  }

  function runDetection(trigger) {
    if (document.hidden && trigger !== 'manual') return;
    if (['chrome:', 'about:', 'chrome-extension:'].includes(location.protocol)) return;
    const signals = collectSignals();
    const det = D.detect(signals);
    const key = det.kind + '|' + location.href.replace(/#.*$/, '') + '|' + (det.kind === 'document' ? E.hash(signals.text.slice(0, 20000)) : det.termsLinks.map((l) => l.url).join(','));
    if (det.kind === 'none' || key === lastKey) return;
    lastKey = key;
    chrome.runtime.sendMessage({
      type: 'PAGE_DETECTED',
      detection: { kind: det.kind, reason: det.reason, score: det.score, context: det.context, termsLinks: det.termsLinks },
      meta: { url: location.href, title: document.title },
      text: det.kind === 'document' ? signals.text : '',
    }).then((resp) => {
      if (resp && !resp.ok && resp.error && resp.error !== 'NO_API_KEY') showError(resp.error);
    }).catch(() => {});
  }

  // Pro kontextové menu „Analyzovat tuto stránku“ a popup.
  window.__termsGuardExtract = () => E.fromDocument(document);

  // ---------- panel ----------
  function ensurePanel() {
    if (panel) return panel;
    const host = document.createElement('div');
    host.id = 'terms-guard-host';
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;top:16px;right:16px;';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host{all:initial}
        *{box-sizing:border-box}
        .box{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;color:#222;background:#fff;width:min(420px,calc(100vw - 32px));max-height:min(80vh,720px);display:flex;flex-direction:column;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.06);overflow:hidden;font-size:13px}
        .head{display:flex;align-items:center;gap:8px;padding:8px 10px 8px 12px;background:#1f2933;color:#fff;cursor:move;user-select:none}
        .head .t{font-weight:700;flex:1;font-size:13px}
        .head button{all:unset;cursor:pointer;color:#fff;opacity:.85;padding:2px 6px;border-radius:4px;font-size:14px;line-height:1}
        .head button:hover{background:rgba(255,255,255,.15);opacity:1}
        .body{padding:12px;overflow:auto}
        .body.min{display:none}
        .loading{display:flex;align-items:center;gap:10px;padding:6px 0}
        .spin{width:16px;height:16px;border:2px solid #ccc;border-top-color:#1a73e8;border-radius:50%;animation:s 1s linear infinite;flex:none}
        @keyframes s{to{transform:rotate(360deg)}}
        .err{color:#c62828}
        .actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px}
        .actions button{all:unset;cursor:pointer;font-size:12px;padding:5px 10px;border-radius:6px;background:#eef1f4;color:#333;font-family:inherit}
        .actions button:hover{background:#e0e5ea}
        ${R.CSS}
      </style>
      <div class="box" role="dialog" aria-label="Hlídač podmínek">
        <div class="head"><span>🛡️</span><span class="t">Hlídač podmínek</span>
          <button class="min" title="Minimalizovat">–</button><button class="close" title="Zavřít">✕</button></div>
        <div class="body"></div>
      </div>`;
    shadow.querySelector('.close').addEventListener('click', () => { host.remove(); panel = null; });
    shadow.querySelector('.min').addEventListener('click', (e) => {
      const b = shadow.querySelector('.body');
      b.classList.toggle('min');
      e.target.textContent = b.classList.contains('min') ? '▢' : '–';
    });
    // přetahování
    const head = shadow.querySelector('.head');
    let drag = null;
    head.addEventListener('mousedown', (e) => { if (e.target.tagName === 'BUTTON') return; drag = { x: e.clientX - host.offsetLeft, y: e.clientY - host.offsetTop }; e.preventDefault(); });
    window.addEventListener('mousemove', (e) => { if (!drag) return; host.style.left = Math.max(0, e.clientX - drag.x) + 'px'; host.style.top = Math.max(0, e.clientY - drag.y) + 'px'; host.style.right = 'auto'; });
    window.addEventListener('mouseup', () => { drag = null; });
    (document.body || document.documentElement).appendChild(host);
    panel = { host, shadow, body: shadow.querySelector('.body') };
    return panel;
  }

  function showLoading(msg) {
    const p = ensurePanel();
    p.body.classList.remove('min');
    p.body.innerHTML = '<div class="loading"><div class="spin"></div><div>' + R.esc(msg || 'Čtu podmínky…') + '</div></div>';
  }

  function showError(err) {
    const p = ensurePanel();
    p.body.classList.remove('min');
    p.body.innerHTML = '<p class="err">' + R.esc(err) + '</p>' + actionsHtml();
    bindActions(p);
  }

  function actionsHtml() {
    return '<div class="actions"><button data-a="page">Analyzovat celou stránku</button><button data-a="ignore">Ignorovat tento web</button><button data-a="options">Nastavení</button></div>';
  }

  function bindActions(p) {
    p.body.querySelectorAll('.actions button').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'page') {
        showLoading('Analyzuji celou stránku…');
        const resp = await chrome.runtime.sendMessage({ type: 'ANALYZE_TEXT', text: E.fromDocument(document), meta: { url: location.href, title: document.title, context: 'Uživatel požádal o analýzu celé stránky.' }, minLength: 200, force: true }).catch((e) => ({ ok: false, error: String(e) }));
        if (resp && resp.ok) showResult(resp.result); else showError((resp && resp.error) || 'Neznámá chyba');
      } else if (a === 'ignore') {
        const s = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
        const hosts = new Set((s.settings.ignoredHosts || []).concat(location.hostname));
        await chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: { ignoredHosts: [...hosts] } });
        p.host.remove(); panel = null;
      } else if (a === 'options') {
        chrome.runtime.sendMessage({ type: 'OPEN_OPTIONS' }).catch(() => {});
      }
    }));
  }

  function showResult(result) {
    const p = ensurePanel();
    p.body.classList.remove('min');
    p.body.innerHTML = R.renderResult(result) + actionsHtml();
    R.bindTabs(p.body);
    bindActions(p);
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SHOW_RESULT') { showResult(msg.result); sendResponse({ ok: true }); }
    else if (msg.type === 'SHOW_ERROR') { showError(msg.error); sendResponse({ ok: true }); }
    else if (msg.type === 'SHOW_LOADING') { showLoading(msg.message); sendResponse({ ok: true }); }
    else if (msg.type === 'EXTRACT_PAGE') {
      const signals = collectSignals();
      const det = D.detect(signals);
      sendResponse({ ok: true, text: signals.text, title: document.title, url: location.href, detection: { kind: det.kind, reason: det.reason, context: det.context, termsLinks: det.termsLinks, length: det.length } });
    }
    else if (msg.type === 'RERUN_DETECTION') { lastKey = null; runDetection('manual'); sendResponse({ ok: true }); }
    return false;
  });

  // ---------- spouštění ----------
  const schedule = (() => { let t; return (why) => { clearTimeout(t); t = setTimeout(() => runDetection(why), 900); }; })();
  schedule('load');
  // SPA navigace a dynamicky vykreslené pokladny/registrace
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; checks = 0; schedule('navigate'); } }, 1000);
  const mo = new MutationObserver(() => { if (checks < 12) { checks++; schedule('mutation'); } });
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule('visible'); });
})();
