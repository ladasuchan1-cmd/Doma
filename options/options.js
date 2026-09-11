(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const send = (m) => chrome.runtime.sendMessage(m).catch((e) => ({ ok: false, error: String(e) }));
  const FIELDS = ['apiKey', 'model', 'effort', 'autoMode', 'autoOnDocuments', 'showOverlay', 'notify', 'useLocalFallback'];

  const { settings } = await send({ type: 'GET_SETTINGS' });
  for (const f of FIELDS) {
    const el = $(f);
    if (el.type === 'checkbox') el.checked = !!settings[f]; else el.value = settings[f] || '';
  }
  $('ignoredHosts').value = (settings.ignoredHosts || []).join('\n');

  function collect() {
    const out = {};
    for (const f of FIELDS) { const el = $(f); out[f] = el.type === 'checkbox' ? el.checked : el.value.trim(); }
    out.ignoredHosts = $('ignoredHosts').value.split(/\s+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
    return out;
  }

  $('btn-save').onclick = async () => {
    const r = await send({ type: 'SAVE_SETTINGS', settings: collect() });
    const m = $('msg'); m.className = r.ok ? 'ok' : 'err'; m.textContent = r.ok ? 'Uloženo.' : ('Chyba: ' + r.error);
    setTimeout(() => { m.textContent = ''; }, 3000);
  };
  $('btn-clear').onclick = async () => { await send({ type: 'CLEAR_CACHE' }); const m = $('msg'); m.className = 'ok'; m.textContent = 'Mezipaměť vymazána.'; setTimeout(() => { m.textContent = ''; }, 3000); };
  $('btn-test').onclick = async () => {
    const m = $('testmsg'); m.textContent = 'Testuji…'; m.style.color = '#555';
    const r = await send({ type: 'TEST_API_KEY', apiKey: $('apiKey').value.trim(), model: $('model').value });
    if (r.ok) { m.style.color = '#2e7d32'; m.textContent = 'Klíč funguje (model ' + r.model + ').'; }
    else { m.style.color = '#c62828'; m.textContent = 'Chyba: ' + r.error; }
  };
})();
