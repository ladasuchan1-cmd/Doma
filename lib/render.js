/*
 * Vykreslení výsledku analýzy do HTML – sdílené panelem ve stránce (shadow DOM) i popupem.
 */
(function (root) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const VERDICT = {
    standardni: { label: 'Standardní podmínky', cls: 'ok', icon: '✔' },
    pozor: { label: 'Pozor – stojí za pozornost', cls: 'warn', icon: '!' },
    nebezpecne: { label: 'Rizikové podmínky', cls: 'danger', icon: '!!' },
  };
  const SEV = { kriticke: { label: 'Kritické', cls: 'sev-crit' }, varovne: { label: 'Varování', cls: 'sev-warn' }, info: { label: 'Info', cls: 'sev-info' } };
  const CAT = { data: 'Osobní údaje', treti_strany: 'Třetí strany', platby: 'Platby', zruseni: 'Zrušení', prava: 'Vaše práva', odpovednost: 'Odpovědnost', jine: 'Ostatní' };

  function list(items, empty) {
    if (!items || !items.length) return '<p class="tg-muted">' + esc(empty) + '</p>';
    return '<ul>' + items.map((i) => '<li>' + esc(i) + '</li>').join('') + '</ul>';
  }

  function renderFindings(findings) {
    if (!findings || !findings.length) return '<p class="tg-muted">Žádné rizikové nálezy.</p>';
    return findings.map((f) => {
      const s = SEV[f.severity] || SEV.info;
      return '<div class="tg-finding ' + s.cls + '">' +
        '<div class="tg-finding-head"><span class="tg-pill">' + esc(s.label) + '</span><span class="tg-cat">' + esc(CAT[f.category] || f.category) + '</span><strong>' + esc(f.title) + '</strong></div>' +
        '<p>' + esc(f.detail) + '</p>' +
        (f.quote ? '<blockquote>„' + esc(f.quote) + '“</blockquote>' : '') +
        '</div>';
    }).join('');
  }

  function renderData(d) {
    if (!d) return '<p class="tg-muted">Bez informací.</p>';
    return '<div class="tg-kv">' +
      '<div><b>Sdílení s třetími stranami:</b> ' + (d.shares_with_third_parties ? '<span class="tg-bad">ano</span>' : '<span class="tg-good">nenalezeno</span>') + '</div>' +
      '<div><b>Přenos mimo EU:</b> ' + (d.transfers_outside_eu ? '<span class="tg-bad">ano</span>' : '<span class="tg-good">nenalezeno</span>') + '</div>' +
      '</div>' +
      '<p>' + esc(d.detail) + '</p>' +
      '<h4>Komu</h4>' + list(d.parties, 'Konkrétní příjemci nejsou uvedeni.') +
      '<h4>Za jakým účelem</h4>' + list(d.purposes, 'Účely nejsou uvedeny.');
  }

  function renderCancel(c) {
    if (!c) return '<p class="tg-muted">Bez informací.</p>';
    return '<div class="tg-kv">' +
      '<div><b>Automatické prodlužování:</b> ' + (c.auto_renewal ? '<span class="tg-bad">ANO – nezapomeňte včas zrušit</span>' : '<span class="tg-good">nenalezeno</span>') + '</div>' +
      '<div><b>Lhůta:</b> ' + esc(c.notice_period || 'neuvedeno') + '</div>' +
      '<div><b>Sankce / poplatky:</b> ' + esc(c.penalties || 'žádné uvedeny') + '</div>' +
      '<div><b>Vrácení peněz:</b> ' + esc(c.refund || 'neuvedeno') + '</div>' +
      '</div>' +
      '<h4>Jak zrušit</h4><p>' + (c.found ? esc(c.how) : '<span class="tg-bad">Dokument neuvádí, jak smlouvu či předplatné zrušit.</span>') + '</p>' +
      (c.steps && c.steps.length ? '<h4>Kroky / citace</h4><ol>' + c.steps.map((s) => '<li>' + esc(s) + '</li>').join('') + '</ol>' : '');
  }

  function renderPrices(p) {
    if (!p || !p.length) return '<p class="tg-muted">V dokumentu nebyly nalezeny žádné ceny ani poplatky.</p>';
    return '<table class="tg-table"><thead><tr><th>Položka</th><th>Částka</th><th>Období</th><th>Poznámka</th></tr></thead><tbody>' +
      p.map((x) => '<tr><td>' + esc(x.item) + '</td><td class="tg-amount">' + esc(x.amount) + '</td><td>' + esc(x.period) + '</td><td>' + esc(x.note) + '</td></tr>').join('') +
      '</tbody></table>';
  }

  function renderResult(r, opts) {
    opts = opts || {};
    const v = VERDICT[r.verdict] || VERDICT.pozor;
    const engine = r._engine === 'claude' ? 'Analyzováno modelem ' + esc(r._model || 'Claude') : 'Rychlá offline analýza (bez API klíče)';
    const nCrit = (r.findings || []).filter((f) => f.severity === 'kriticke').length;
    const nWarn = (r.findings || []).filter((f) => f.severity === 'varovne').length;
    const sources = r._sources && r._sources.length
      ? '<div class="tg-sources">Zdroje: ' + r._sources.map((s) => '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a>').join(', ') + '</div>'
      : '';
    return '' +
      '<div class="tg-verdict ' + v.cls + '">' +
        '<div class="tg-verdict-icon">' + v.icon + '</div>' +
        '<div class="tg-verdict-text"><div class="tg-verdict-label">' + esc(v.label) + '</div>' +
        '<div class="tg-verdict-sub">' + esc(r.document_type || '') + ' · riziko ' + esc(r.risk_score) + '/100 · ' +
        nCrit + ' kritických, ' + nWarn + ' varování</div></div>' +
      '</div>' +
      '<p class="tg-summary">' + esc(r.summary) + '</p>' +
      (r.key_points && r.key_points.length ? '<div class="tg-keypoints"><h4>Nejdůležitější body</h4>' + list(r.key_points) + '</div>' : '') +
      '<div class="tg-tabs" role="tablist">' +
        '<button class="tg-tab active" data-tab="risks">Rizika (' + (r.findings || []).length + ')</button>' +
        '<button class="tg-tab" data-tab="data">Data</button>' +
        '<button class="tg-tab" data-tab="cancel">Zrušení</button>' +
        '<button class="tg-tab" data-tab="prices">Ceny (' + (r.prices || []).length + ')</button>' +
      '</div>' +
      '<div class="tg-panel active" data-panel="risks">' + renderFindings(r.findings) + '</div>' +
      '<div class="tg-panel" data-panel="data">' + renderData(r.data_sharing) + '</div>' +
      '<div class="tg-panel" data-panel="cancel">' + renderCancel(r.cancellation) + '</div>' +
      '<div class="tg-panel" data-panel="prices">' + renderPrices(r.prices) + '</div>' +
      '<div class="tg-footer">' + engine + (r._cached ? ' · z mezipaměti' : '') + (r._truncated ? ' · dokument zkrácen' : '') +
        (r._fallbackError ? ' · <span class="tg-bad">' + esc(r._fallbackError) + '</span>' : '') + sources +
        '<div class="tg-disclaimer">Automatická analýza, nenahrazuje právní poradenství.</div></div>';
  }

  function bindTabs(rootEl) {
    rootEl.querySelectorAll('.tg-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        rootEl.querySelectorAll('.tg-tab').forEach((b) => b.classList.toggle('active', b === btn));
        rootEl.querySelectorAll('.tg-panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === btn.dataset.tab));
      });
    });
  }

  const CSS = `
    .tg-verdict{display:flex;gap:12px;align-items:center;padding:12px 14px;border-radius:10px;color:#fff;margin-bottom:10px}
    .tg-verdict.ok{background:#2e7d32}.tg-verdict.warn{background:#ef8f00}.tg-verdict.danger{background:#c62828}
    .tg-verdict-icon{font-size:26px;font-weight:800;width:40px;height:40px;border-radius:50%;background:rgba(255,255,255,.22);display:flex;align-items:center;justify-content:center;flex:none}
    .tg-verdict-label{font-weight:700;font-size:15px}.tg-verdict-sub{font-size:12px;opacity:.92;margin-top:2px}
    .tg-summary{font-size:13.5px;line-height:1.45;margin:0 0 10px}
    .tg-keypoints{background:#f4f6f8;border-radius:8px;padding:8px 12px;margin-bottom:10px}
    .tg-keypoints h4,.tg-panel h4{margin:6px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#555}
    .tg-keypoints ul,.tg-panel ul,.tg-panel ol{margin:4px 0 4px 18px;padding:0;font-size:13px;line-height:1.4}
    .tg-tabs{display:flex;gap:4px;border-bottom:1px solid #ddd;margin-bottom:8px;flex-wrap:wrap}
    .tg-tab{background:none;border:none;border-bottom:2px solid transparent;padding:6px 10px;font-size:13px;cursor:pointer;color:#444;font-family:inherit}
    .tg-tab.active{border-bottom-color:#1a73e8;color:#1a73e8;font-weight:600}
    .tg-panel{display:none;font-size:13px;line-height:1.45}.tg-panel.active{display:block}
    .tg-finding{border-left:4px solid #999;background:#fafafa;padding:8px 10px;margin-bottom:8px;border-radius:0 8px 8px 0}
    .tg-finding.sev-crit{border-color:#c62828;background:#fff3f3}.tg-finding.sev-warn{border-color:#ef8f00;background:#fff8e6}.tg-finding.sev-info{border-color:#607d8b}
    .tg-finding-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px}
    .tg-finding p{margin:4px 0}
    .tg-pill{font-size:10.5px;font-weight:700;text-transform:uppercase;padding:2px 6px;border-radius:10px;background:#607d8b;color:#fff}
    .sev-crit .tg-pill{background:#c62828}.sev-warn .tg-pill{background:#ef8f00}
    .tg-cat{font-size:11px;color:#666}
    blockquote{margin:6px 0 0;padding:6px 10px;border-left:3px solid #ccc;color:#555;font-style:italic;font-size:12px;background:#fff}
    .tg-kv{display:grid;gap:4px;margin-bottom:8px}.tg-kv b{color:#333}
    .tg-bad{color:#c62828;font-weight:600}.tg-good{color:#2e7d32;font-weight:600}.tg-muted{color:#777}
    .tg-table{width:100%;border-collapse:collapse;font-size:12.5px}.tg-table th,.tg-table td{border-bottom:1px solid #e5e5e5;padding:5px 6px;text-align:left;vertical-align:top}
    .tg-table th{background:#f4f6f8;font-weight:600}.tg-amount{white-space:nowrap;font-weight:700}
    .tg-footer{margin-top:10px;font-size:11px;color:#777;border-top:1px solid #eee;padding-top:6px}
    .tg-sources{margin-top:4px}.tg-sources a{color:#1a73e8}
    .tg-disclaimer{margin-top:4px;font-style:italic}
  `;

  const API = { renderResult, bindTabs, esc, CSS, VERDICT };
  root.TermsRender = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
