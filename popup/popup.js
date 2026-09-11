(async function () {
  'use strict';
  const R = self.TermsRender;
  const $ = (id) => document.getElementById(id);
  const send = (m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: String(e) }));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tab && tab.id;
  const isWeb = tab && /^https?:/i.test(tab.url || '');

  const { settings } = await send({ type: 'GET_SETTINGS' });
  $('nokey').classList.toggle('hidden', !!(settings && settings.apiKey));
  $('btn-options').onclick = () => chrome.runtime.openOptionsPage();
  $('link-options').onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

  function setStatus(html) { $('status').innerHTML = html; }
  function showLoading(msg) { $('result').innerHTML = '<div class="loading"><div class="spin"></div><div>' + R.esc(msg || 'Čtu podmínky…') + '</div></div>'; }
  function showError(err) { $('result').innerHTML = '<p class="err" style="color:#c62828">' + R.esc(err) + '</p>'; }
  function showResult(r) { $('result').innerHTML = R.renderResult(r); R.bindTabs($('result')); }

  // Stav pro aktuální kartu
  let pageInfo = null;
  if (isWeb) {
    const st = await send({ type: 'GET_TAB_STATE', tabId });
    const s = st && st.state;
    if (s && s.status === 'done' && s.result) showResult(s.result);
    else if (s && s.status === 'loading') showLoading();
    else if (s && s.status === 'error' && s.error && s.error !== 'NO_API_KEY') showError(s.error);

    pageInfo = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' }).catch(() => null);
    if (pageInfo && pageInfo.ok) {
      const d = pageInfo.detection;
      const kindText = d.kind === 'document' ? 'Tato stránka vypadá jako dokument s podmínkami' : d.kind === 'consent' ? 'Stránka s nákupem / registrací / instalací, odkazuje na podmínky' : 'Na této stránce nebyly rozpoznány podmínky';
      setStatus('<span class="kind">' + R.esc(kindText) + '</span>' + (d.reason ? '<br><small>' + R.esc(d.reason) + '</small>' : '') + '<br><small>' + R.esc(new URL(pageInfo.url).hostname) + ' · ' + (d.length || 0) + ' znaků textu</small>');
      if (d.termsLinks && d.termsLinks.length) {
        $('btn-links').classList.remove('hidden');
        $('btn-links').textContent = 'Analyzovat odkazované podmínky (' + d.termsLinks.length + ')';
      }
    } else {
      setStatus('<span class="err">Na této stránce nelze číst obsah (rozšíření se sem nenačetlo – zkuste stránku obnovit).</span>');
      $('btn-analyze').disabled = true;
    }
  } else {
    setStatus('Otevřete webovou stránku, nebo vložte text ručně.');
    $('btn-analyze').disabled = true;
  }

  $('btn-analyze').onclick = async () => {
    if (!pageInfo || !pageInfo.ok) return;
    showLoading('Analyzuji stránku…');
    const resp = await send({ type: 'ANALYZE_TEXT', tabId, text: pageInfo.text, meta: { url: pageInfo.url, title: pageInfo.title, context: 'Uživatel požádal o analýzu celé stránky.' }, minLength: 200 });
    if (resp.ok) showResult(resp.result); else showError(resp.error === 'NO_API_KEY' ? 'Zadejte API klíč v nastavení, nebo povolte offline analýzu.' : resp.error);
    loadHistory();
  };

  $('btn-links').onclick = async () => {
    if (!pageInfo || !pageInfo.ok) return;
    showLoading('Stahuji a analyzuji odkazované podmínky…');
    const resp = await send({ type: 'ANALYZE_LINKS', tabId, links: pageInfo.detection.termsLinks, context: pageInfo.detection.context, meta: { url: pageInfo.url, title: pageInfo.title } });
    if (resp.ok) { showResult(resp.result); chrome.tabs.sendMessage(tabId, { type: 'SHOW_RESULT', result: resp.result }).catch(() => {}); }
    else showError(resp.error);
    loadHistory();
  };

  $('btn-paste').onclick = () => { $('paste-box').classList.toggle('hidden'); $('paste-text').focus(); };
  $('btn-paste-cancel').onclick = () => $('paste-box').classList.add('hidden');
  $('btn-paste-run').onclick = async () => {
    const text = $('paste-text').value.trim();
    if (text.length < 100) { showError('Vložte alespoň 100 znaků textu.'); return; }
    showLoading('Analyzuji vložený text…');
    const resp = await send({ type: 'ANALYZE_TEXT', tabId, text, meta: { url: 'vložený text', title: 'Ručně vložený text', context: 'Uživatel vložil text ručně.' }, minLength: 100 });
    if (resp.ok) showResult(resp.result); else showError(resp.error);
    loadHistory();
  };

  async function loadHistory() {
    const { history } = await chrome.storage.local.get('history');
    const h = (history || []).slice(0, 8);
    const cls = { standardni: 'ok', pozor: 'warn', nebezpecne: 'danger' };
    $('history').innerHTML = h.length ? h.map((e) => {
      const d = new Date(e.ts);
      const url = /^https?:/.test(e.url || '') ? e.url : '';
      return '<li><span class="dot ' + (cls[e.verdict] || '') + '"></span>' +
        (url ? '<a href="' + R.esc(url) + '" target="_blank" title="' + R.esc(e.title || '') + '">' + R.esc(e.title || url) + '</a>' : '<span style="flex:1">' + R.esc(e.title || '') + '</span>') +
        '<span class="ts">' + d.getDate() + '.' + (d.getMonth() + 1) + '. ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + '</span></li>';
    }).join('') : '<li style="color:#999">Zatím nic.</li>';
  }
  loadHistory();
})();
