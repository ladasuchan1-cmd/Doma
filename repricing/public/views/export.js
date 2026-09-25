// Export – feedy pro admin (URL s tokenem), stažení souborů, odeslání webhookem, dokumentace potvrzení (ack), historie.
import { h, mount } from '../lib/dom.js';
import { api, apiUrl, itemsOf, isAbort, basePath, bindDownload } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { DataTable } from '../lib/table.js';
import { card, kpi, emptyState, callout, codeBlock, copyField, jobStatusBadge, checkbox, select, field, dl, button, changeEl } from '../lib/ui.js';
import { confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import { int, dateTime, relTime, EXPORT_KIND_LABELS, count, truncate, duration, detailText } from '../lib/format.js';
import { priceMove } from '../lib/decision.js';
import { finalPrice, finalChangePct } from '../lib/proposal-model.js';

export const title = 'Export';

export async function show(root, ctx) {
  ctx.setTitle('Export', 'Jak se schválené ceny dostanou do adminu a POHODY');
  const origin = location.origin + basePath().replace(/\/$/, '');
  const feedBase = origin + '/feed/';
  let settings = null;
  let approved = null;

  const approvedHost = h('div');
  const webhookHost = h('div');
  const logHost = h('div');

  // ------------------------------------------------------------- feedy
  const feedRows = [
    ['Změny (schválené) – XML', 'changes.xml'],
    ['Změny (schválené) – JSON', 'changes.json'],
    ['Změny (schválené) – CSV', 'changes.csv'],
    ['Celý ceník – XML', 'prices.xml'],
    ['Celý ceník – JSON', 'prices.json'],
    ['Celý ceník – CSV', 'prices.csv'],
  ];
  const feedsCard = card({
    title: 'Feedy pro admin',
    icon: 'link',
    subtitle: 'Admin si je stahuje pravidelně (cron). VAS_TOKEN nahraďte tokenem s oprávněním export.',
    actions: [h('a', { class: 'btn btn-sm', href: '#/nastaveni?tab=tokeny' }, icon('key', { size: 14 }), h('span', null, 'Vytvořit token'))],
    dataset: { card: 'feeds' },
    body: [
      feedRows.map(([label, file]) => h('div', { class: 'feed-row' }, h('span', { class: 'small strong' }, label), copyField(feedBase + file + '?token=VAS_TOKEN', { ariaLabel: 'URL feedu ' + label }))),
      h(
        'div',
        { style: 'margin-top:12px' },
        callout(h('span', null, h('b', null, 'changes'), ' obsahuje jen schválené a dosud neexportované změny. Přidejte ', h('code', null, '&mark=1'), ' a stažené změny se rovnou označí jako exportované (hlavička X-Export-Id), nebo je po úspěšném importu v adminu potvrďte voláním ack (viz níže). ', h('b', null, 'prices'), ' je vždy celý ceník.'), 'info')
      ),
    ],
  });

  // ------------------------------------------------------------- stažení
  const markChanges = { v: false };
  const changeLinks = ['json', 'xml', 'csv'].map((f) => h('a', { class: 'btn btn-sm', href: apiUrl('/export/changes.' + f), download: '', dataset: { format: f } }, icon('download', { size: 14 }), h('span', null, f.toUpperCase())));
  function updateChangeLinks() {
    for (const a of changeLinks) a.href = apiUrl('/export/changes.' + a.dataset.format, markChanges.v ? { mark: 1 } : null);
  }
  const afterDownload = (r) => {
    if (r.exportId) {
      toast('Staženo ' + r.filename + ' – ' + count(r.count ?? 0, 'změna označena', 'změny označeny', 'změn označeno') + ' jako exportované (export #' + r.exportId + ').', { type: 'success' });
      ctx.notifyChanged('export');
      loadApproved();
      loadLog();
    }
  };
  for (const a of changeLinks) bindDownload(a, afterDownload);
  const pohodaScope = select([{ value: 'approved', label: 'Jen schválené změny' }, { value: 'all', label: 'Celý ceník' }], 'approved');
  // bez parametru server použije nastavení (export.pohoda.encoding, výchozí windows-1250) – posíláme ho vždy explicitně
  const pohodaEnc = select([{ value: 'windows-1250', label: 'Windows-1250 (výchozí)' }, { value: 'utf-8', label: 'UTF-8' }], 'windows-1250');
  const pohodaMark = { v: false };
  const pohodaLink = h('a', { class: 'btn btn-sm btn-primary', download: '', dataset: { action: 'pohoda' } }, icon('download', { size: 14 }), h('span', null, 'POHODA XML'));
  function updatePohoda() {
    pohodaLink.href = apiUrl('/export/pohoda.xml', { scope: pohodaScope.value, encoding: pohodaEnc.value, mark: pohodaMark.v ? 1 : null });
  }
  pohodaScope.addEventListener('change', updatePohoda);
  pohodaEnc.addEventListener('change', updatePohoda);
  bindDownload(pohodaLink, afterDownload);
  updatePohoda();
  const downloadsCard = card({
    title: 'Stáhnout soubory',
    icon: 'download',
    dataset: { card: 'downloads' },
    body: h(
      'div',
      { class: 'download-grid' },
      h('div', { class: 'download' }, h('h3', null, 'Schválené změny'), h('p', null, 'Kód, EAN, název, nová a stará cena, změna %. Pro ruční import do adminu.'), h('div', { class: 'btn-group' }, changeLinks), checkbox('Označit jako exportované', false, (v) => { markChanges.v = v; updateChangeLinks(); })),
      h(
        'div',
        { class: 'download' },
        h('h3', null, 'POHODA XML'),
        h('p', null, 'Datový balík pro import do POHODY (aktualizace prodejní ceny zásob, párování podle kódu nebo EAN).'),
        h('div', { class: 'stack-sm' }, field({ label: 'Rozsah', control: pohodaScope }), field({ label: 'Kódování', control: pohodaEnc })),
        checkbox('Označit jako exportované', false, (v) => { pohodaMark.v = v; updatePohoda(); }),
        h('div', null, pohodaLink)
      ),
      h('div', { class: 'download' }, h('h3', null, 'Ceník'), h('p', null, 'Všechny aktivní produkty s cenou k exportu (schválený návrh, jinak aktuální cena).'), h('div', { class: 'btn-group' }, ['xlsx', 'csv', 'json', 'xml'].map((f) => bindDownload(h('a', { class: 'btn btn-sm', href: apiUrl('/export/pricelist.' + f), download: '' }, icon('download', { size: 14 }), h('span', null, f.toUpperCase())))))),
      h('div', { class: 'download' }, h('h3', null, 'Návrhy cen (XLSX)'), h('p', null, 'Přehled čekajících návrhů pro poradu nebo schválení mimo aplikaci.'), h('div', null, bindDownload(h('a', { class: 'btn btn-sm', href: apiUrl('/export/proposals.xlsx', { status: 'pending' }), download: '' }, icon('download', { size: 14 }), h('span', null, 'Návrhy XLSX')))))
    ),
  });

  // ------------------------------------------------------------- ack
  const ackCard = card({
    title: 'Potvrzení importu v adminu (ack)',
    icon: 'check',
    subtitle: 'Doporučený postup pro spolehlivý přenos: stáhnout → naimportovat → potvrdit. Nepotvrzené změny zůstanou ve feedu i příště.',
    body: h(
      'div',
      { class: 'stack' },
      h('ol', { class: 'validation-list' },
        h('li', null, 'Admin stáhne ', h('code', null, 'GET /api/v1/export/changes.json'), ' (nebo feed ', h('code', null, '/feed/changes.json?token=…'), ').'),
        h('li', null, 'Každá položka má ', h('code', null, 'proposal_id'), ', ', h('code', null, 'code'), ' a ', h('code', null, 'price'), ' (s DPH).'),
        h('li', null, 'Po úspěšném uložení cen admin zavolá ', h('code', null, 'POST /api/v1/export/ack'), ' s ID návrhů nebo kódy produktů.'),
        h('li', null, 'Cenotvorba je označí jako exportované a (dle nastavení) přepíše aktuální cenu produktu.')
      ),
      codeBlock([
        `curl "${origin}/api/v1/export/changes.json" -H "Authorization: Bearer $CENOTVORBA_TOKEN"`,
        '',
        `curl -X POST "${origin}/api/v1/export/ack" \\`,
        '  -H "Authorization: Bearer $CENOTVORBA_TOKEN" -H "Content-Type: application/json" \\',
        '  --data-binary \'{"proposal_ids": [1201, 1202, 1203]}\'',
        '',
        '# nebo podle kódů produktů',
        `curl -X POST "${origin}/api/v1/export/ack" -H "Authorization: Bearer $CENOTVORBA_TOKEN" \\`,
        '  -H "Content-Type: application/json" --data-binary \'{"codes": ["TRK-MAR7GEN3-M", "SHI-DEOXT"]}\'',
      ].join('\n'), { title: 'Příklad' }),
      h('p', { class: 'muted small' }, 'Odpověď: {"export_id": 12, "count": 3}. Potvrdit lze jen schválené návrhy; jiné se ignorují.')
    ),
  });

  const logTable = new DataTable({
    columns: [
      { key: 'created_at', label: 'Čas', sortable: true, value: (e) => Date.parse(e.created_at), render: (e) => h('div', { class: 'cell-2' }, h('span', { class: 'nowrap' }, dateTime(e.created_at)), h('span', { class: 'cell-sub' }, relTime(e.created_at))) },
      { key: 'kind', label: 'Způsob', sortable: true, render: (e) => EXPORT_KIND_LABELS[e.kind] || e.kind },
      { key: 'target', label: 'Cíl', hideSm: true, render: (e) => h('span', { class: 'small mono', title: e.target || '' }, truncate(e.target || '–', 48)) },
      { key: 'count', label: 'Položek', format: 'int', sortable: true },
      { key: 'status', label: 'Stav', render: (e) => jobStatusBadge(e.status) },
      { key: 'detail', label: 'Detail', hideSm: true, render: (e) => h('span', { class: 'small muted', title: typeof e.detail === 'object' && e.detail ? JSON.stringify(e.detail, null, 1) : e.detail || '' }, truncate(detailText(e.detail), 80)) },
    ],
    clientSort: true,
    sort: { key: 'created_at', dir: 'desc' },
    caption: 'Historie exportů',
    empty: () => emptyState({ icon: 'download', title: 'Zatím žádný export', text: 'Každé stažení s označením, odeslání webhookem nebo ack se zapíše sem.', compact: true }),
  });

  mount(
    root,
    h(
      'div',
      { class: 'stack' },
      h('div', { class: 'grid-2' }, approvedHost, webhookHost),
      feedsCard,
      downloadsCard,
      ackCard,
      card({ title: 'Historie exportů', icon: 'clock', flush: true, body: logTable.el, dataset: { card: 'export-log' } }),
      logHost
    )
  );

  async function loadApproved() {
    let rows = [];
    try {
      const r = await api.get('/proposals', { status: 'approved', limit: 6, sort: 'decided_at', dir: 'desc' }, { signal: ctx.signal, silent: true });
      approved = r?.total ?? 0;
      rows = itemsOf(r);
    } catch (e) {
      if (isAbort(e)) return;
      approved = null;
    }
    const list = rows.length
      ? h(
        'ul',
        { class: 'export-preview', 'aria-label': 'Schválené změny k exportu' },
        rows.map((r) => {
          const p = r.product || { code: r.code, name: r.name };
          return h(
            'li',
            { dataset: { proposalId: r.id } },
            h('div', { class: 'export-preview-name' }, h('a', { href: '#/produkty/' + encodeURIComponent(r.product_id), title: p.name || '' }, p.name || p.code || '#' + r.product_id), h('span', { class: 'mono muted small' }, p.code || '')),
            h('div', { class: 'export-preview-price' }, priceMove(r.old_price, finalPrice(r)), changeEl(finalChangePct(r)))
          );
        }),
        approved > rows.length ? h('li', { class: 'muted small' }, '… a další ' + count(approved - rows.length, 'změna', 'změny', 'změn')) : null
      )
      : null;
    mount(
      approvedHost,
      card({
        title: 'Čeká na export',
        icon: 'download',
        dataset: { card: 'approved' },
        body: h(
          'div',
          { class: 'stack-sm' },
          kpi({ label: 'Schválené změny cen', value: approved == null ? '–' : int(approved), sub: approved ? 'připraveno pro admin / POHODU' : 'nic nečeká', tone: approved ? 'info' : null }),
          list,
          h('div', { class: 'row' }, h('a', { class: 'btn btn-sm', href: '#/navrhy?status=approved' }, 'Zobrazit schválené'), h('a', { class: 'btn btn-sm btn-ghost', href: '#/navrhy' }, 'Schválit další'))
        ),
      })
    );
  }

  async function push(btn) {
    const ok = await confirmDialog({ title: 'Odeslat schválené změny', message: 'Odeslat ' + (approved ? count(approved, 'schválenou změnu', 'schválené změny', 'schválených změn') : 'schválené změny') + ' na ' + settings.export.webhook.url + '? Po úspěchu se označí jako exportované.', confirmLabel: 'Odeslat' });
    if (!ok) return;
    btn.disabled = true;
    btn.classList.add('is-busy');
    const resultHost = webhookHost.querySelector('[data-role="push-result"]');
    try {
      const r = await api.post('/export/push', {});
      const good = r && r.ok !== false;
      toast(good ? 'Odesláno: ' + count(r?.count ?? 0, 'změna', 'změny', 'změn') : 'Webhook selhal (HTTP ' + (r?.status ?? '?') + ')', { type: good ? 'success' : 'error' });
      if (resultHost) {
        mount(resultHost, callout(h('div', null, dl([['Výsledek', good ? 'OK' : 'Chyba'], ['HTTP status', String(r?.status ?? '–')], ['Doba', duration(r?.duration_ms)], ['Odesláno', int(r?.count)], r?.export_id ? ['Export', '#' + r.export_id] : null, r?.body ? ['Odpověď', h('code', { class: 'small' }, truncate(String(r.body), 300))] : null])), good ? 'success' : 'danger'));
      }
      ctx.notifyChanged('export');
    } catch {
      /* toast */
    }
    btn.disabled = false;
    btn.classList.remove('is-busy');
    loadApproved();
    loadLog();
  }

  async function loadSettings() {
    try {
      settings = await api.get('/settings', null, { signal: ctx.signal, silent: true });
    } catch (e) {
      if (isAbort(e)) return;
      settings = null;
    }
    const wh = settings?.export?.webhook || {};
    const enc = String(settings?.export?.pohoda?.encoding || '').toLowerCase();
    if (enc === 'utf-8' || enc === 'windows-1250') {
      pohodaEnc.value = enc;
      updatePohoda();
    }
    const pushBtn = button('Odeslat schválené změny', { icon: 'send', variant: 'primary', disabled: !wh.url, dataset: { action: 'push' } });
    pushBtn.addEventListener('click', () => push(pushBtn));
    mount(
      webhookHost,
      card({
        title: 'Odeslat webhookem',
        icon: 'send',
        subtitle: 'Cenotvorba pošle schválené změny POSTem na URL adminu (JSON nebo XML).',
        dataset: { card: 'webhook' },
        body: h(
          'div',
          { class: 'stack-sm' },
          wh.url
            ? dl([['URL', h('span', { class: 'mono small' }, wh.url)], ['Formát', String(wh.format || 'json').toUpperCase()], ['Automaticky po přecenění', settings?.schedule?.auto_push_after_run || wh.auto_push ? 'ano' : 'ne']])
            : callout(h('span', null, 'Webhook zatím není nastaven. ', h('a', { href: '#/nastaveni' }, 'Nastavit URL →')), 'warning'),
          h('div', { class: 'row' }, pushBtn, h('a', { class: 'btn btn-sm btn-ghost', href: '#/nastaveni' }, 'Nastavení')),
          h('div', { dataset: { role: 'push-result' } })
        ),
      })
    );
  }

  async function loadLog() {
    logTable.setLoading(true);
    try {
      const r = await api.get('/exports', null, { signal: ctx.signal, silent: true });
      logTable.setData(itemsOf(r));
    } catch (e) {
      if (isAbort(e)) return;
      logTable.setError(e, () => loadLog());
    }
  }

  ctx.onChanged((what) => {
    if (what !== 'export') {
      loadApproved();
      loadLog();
    }
  });
  await Promise.all([loadApproved(), loadSettings(), loadLog()]);
}
