// Import dat – průvodce nahráním souboru (náhled → mapování → zkušební/ostrý import → uložení jako zdroj),
// správa zdrojů (URL + interval), historie importů a návod pro posílání dat přes API.
import { h, mount, debounce } from '../lib/dom.js';
import { api, itemsOf, isAbort, invalidate, basePath } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { tabs } from '../lib/tabs.js';
import { DataTable, simpleTable } from '../lib/table.js';
import {
  card, field, emptyState, errorState, callout, codeBlock, badge, jobStatusBadge, segmented, switchEl, button, checkbox, select, numberInput,
} from '../lib/ui.js';
import { openModal, confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import {
  CANONICAL, buildMapping, missingRequired, hasMatchKey, statsList, curlExamples,
} from '../lib/import-model.js';
import {
  int, bytes, dateTime, relTime, duration, KIND_LABELS, ORIGIN_LABELS, truncate, count, parseInputNumber,
} from '../lib/format.js';

export const title = 'Import dat';

const INTERVALS = [
  { value: 0, label: 'Jen ručně / přes API' },
  { value: 15, label: 'Každých 15 min' },
  { value: 30, label: 'Každých 30 min' },
  { value: 60, label: 'Každou hodinu' },
  { value: 120, label: 'Každé 2 h' },
  { value: 360, label: 'Každých 6 h' },
  { value: 720, label: 'Každých 12 h' },
  { value: 1440, label: 'Jednou denně' },
];

function intervalLabel(m) {
  const f = INTERVALS.find((x) => x.value === Number(m));
  if (f) return f.label;
  return 'Každých ' + int(m) + ' min';
}

function statsGrid(stats, kind) {
  const list = statsList(stats);
  if (!list.length) return h('p', { class: 'muted' }, 'Bez statistik.');
  const tone = (st) => ((st.key === 'errors' || st.key === 'unmatched') && st.value ? 'is-bad' : ['matched', 'created'].includes(st.key) && st.value ? 'is-good' : null);
  return h(
    'div',
    { class: 'stack-sm' },
    h('div', { class: 'stat-grid' }, list.map((st) => h('div', { class: ['stat', tone(st)] }, h('div', { class: 'stat-label' }, st.label), h('div', { class: 'stat-value' }, int(st.value))))),
    errorsList(stats?.errors),
    kind === 'offers' && stats?.unmatched
      ? callout(h('span', null, count(stats.unmatched, 'nabídka se nespárovala', 'nabídky se nespárovaly', 'nabídek se nespárovalo') + ' s katalogem. ', h('a', { href: '#/konkurence?tab=unmatched' }, 'Spárovat ručně →')), 'warning')
      : null
  );
}

function errorsList(errors) {
  if (!Array.isArray(errors) || !errors.length) return null;
  return h(
    'details',
    { class: 'disclosure' },
    h('summary', null, icon('chevron-right', { size: 14 }), 'Chyby (' + int(errors.length) + ')'),
    h('ul', { class: 'validation-list' }, errors.slice(0, 100).map((e) => h('li', null, typeof e === 'string' ? e : (e.row != null ? 'Řádek ' + e.row + ': ' : '') + (e.message || JSON.stringify(e)))))
  );
}

export async function show(root, ctx) {
  ctx.setTitle('Import dat', 'Katalog produktů a ceny konkurence ze souboru, URL nebo API');

  // =============================================================== průvodce
  const wz = {
    kind: ctx.query.kind === 'products' ? 'products' : 'offers',
    file: null,
    preview: null,
    fields: {},
    defaults: {},
    csv: { delimiter: '', decimal: '', encoding: '', header_row: '' },
    format: 'auto',
    item_path: '',
    price_net: false,
    attrs: 'all',
    replace: '',
    deactivate_missing: false,
    result: null,
    dryResult: null,
    busy: false,
  };
  const wizardHost = h('div', { class: 'stack' });

  function mapping() {
    return buildMapping({ format: wz.format, item_path: wz.item_path, fields: wz.fields, defaults: wz.defaults, csv: wz.csv, price_net: wz.price_net, attrs: wz.attrs });
  }

  function importQuery(dry) {
    const q = { mapping: JSON.stringify(mapping()) };
    if (dry) q.dry_run = 1;
    if (wz.kind === 'offers' && wz.replace) q.replace = wz.replace;
    if (wz.kind === 'products' && wz.deactivate_missing) q.deactivate_missing = 1;
    return q;
  }

  async function runPreview(withMapping) {
    if (!wz.file) return;
    wz.busy = true;
    renderWizard();
    try {
      const query = { kind: wz.kind };
      if (withMapping) query.mapping = JSON.stringify(mapping());
      const p = await api.upload('/import/preview', wz.file, query, { signal: ctx.signal });
      wz.preview = p;
      if (!withMapping) {
        wz.fields = { ...(p?.suggested || {}) };
        wz.item_path = p?.itemPath || '';
      }
    } catch (e) {
      if (isAbort(e)) return;
      if (!withMapping) wz.preview = null;
      wz.previewError = e;
    } finally {
      wz.busy = false;
      renderWizard();
    }
  }
  const refreshPreview = debounce(() => runPreview(true), 600);

  function setFile(file) {
    if (!file) return;
    if (file.size > 300 * 1024 * 1024) {
      toast('Soubor je větší než 300 MB – pošlete ho raději přes API nebo URL zdroj.', { type: 'error' });
      return;
    }
    Object.assign(wz, { file, preview: null, previewError: null, fields: {}, defaults: {}, result: null, dryResult: null, item_path: '', format: 'auto', csv: { delimiter: '', decimal: '', encoding: '', header_row: '' } });
    runPreview(false);
  }

  function stepsEl() {
    const step = !wz.file ? 1 : wz.result ? 3 : 2;
    const li = (n, text) => h('li', { class: step === n ? 'is-active' : step > n ? 'is-done' : null, 'aria-current': step === n ? 'step' : null }, text);
    return h('ol', { class: 'steps', 'aria-label': 'Postup importu' }, li(1, 'Soubor'), li(2, 'Mapování polí'), li(3, 'Import'));
  }

  function dropzone() {
    const input = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.json,.xml,.xlsx', id: 'import-file', 'aria-describedby': 'import-file-help', onChange: (e) => setFile(e.target.files[0]) });
    const dz = h(
      'label',
      { class: 'dropzone', for: 'import-file', dataset: { role: 'dropzone' } },
      icon('upload', { size: 32 }),
      h('span', { class: 'dropzone-title' }, 'Přetáhněte soubor sem nebo klikněte a vyberte'),
      h('span', { class: 'muted', id: 'import-file-help' }, 'CSV (i z Excelu / POHODY ve windows-1250), XLSX, JSON nebo XML (Heureka, Google feed, POHODA …)'),
      input
    );
    ['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('is-over'); }));
    ['dragleave', 'dragend'].forEach((ev) => dz.addEventListener(ev, () => dz.classList.remove('is-over')));
    dz.addEventListener('drop', (e) => {
      e.preventDefault();
      dz.classList.remove('is-over');
      const f = e.dataTransfer?.files?.[0];
      if (f) setFile(f);
    });
    return dz;
  }

  function pastePanel() {
    const ta = h('textarea', { class: 'input input-mono', rows: 6, placeholder: 'kod;konkurent;cena\nTRK-MAR7GEN3-M;VeloMarket.cz;20990', 'aria-label': 'Data k importu' });
    return h(
      'details',
      { class: 'disclosure' },
      h('summary', null, icon('chevron-right', { size: 14 }), 'Nebo vložte data jako text (CSV / JSON / XML)'),
      h('div', { class: 'stack-sm', style: 'margin-top:8px' }, ta, h('div', null, h('button', {
        type: 'button', class: 'btn btn-sm',
        onClick: () => {
          const t = ta.value.trim();
          if (!t) return;
          const ext = t.startsWith('<') ? 'xml' : t.startsWith('{') || t.startsWith('[') ? 'json' : 'csv';
          const type = { xml: 'application/xml', json: 'application/json', csv: 'text/csv' }[ext];
          setFile(new File([t], 'vlozena-data.' + ext, { type }));
        },
      }, 'Načíst vložená data')))
    );
  }

  function kindSelector() {
    return h(
      'div',
      { class: 'stack-sm' },
      segmented([{ value: 'offers', label: 'Ceny konkurence' }, { value: 'products', label: 'Katalog produktů' }], wz.kind, (v) => {
        wz.kind = v;
        ctx.setQuery({ tab: null, kind: v === 'products' ? 'products' : null });
        if (wz.file) runPreview(false);
        else renderWizard();
      }, { label: 'Co importujete' }),
      h('p', { class: 'field-help' }, wz.kind === 'offers'
        ? 'Ceny konkurence: každý řádek = cena jednoho konkurenta pro jeden produkt. Párování přes náš kód, EAN, MPN nebo ID poskytovatele; konkurent se založí automaticky.'
        : 'Katalog: kód (POHODA „Kód“), název, nákupní a prodejní cena, sklad… Neznámé sloupce (např. N, sezóna, imprese) se uloží jako atributy pro segmenty.')
    );
  }

  function optionsCard() {
    const p = wz.preview || {};
    const fmtSel = select([{ value: 'auto', label: 'Automaticky (' + (p.format || '?').toUpperCase() + ')' }, { value: 'csv', label: 'CSV' }, { value: 'xlsx', label: 'XLSX' }, { value: 'json', label: 'JSON' }, { value: 'xml', label: 'XML' }], wz.format, { onChange: (e) => { wz.format = e.target.value; refreshPreview(); } });
    const pathIn = h('input', { class: 'input input-mono', value: wz.item_path || '', placeholder: 'např. SHOP.SHOPITEM', onInput: (e) => { wz.item_path = e.target.value.trim(); refreshPreview(); } });
    const delimSel = select([{ value: '', label: 'Automaticky' }, { value: ';', label: 'Středník ;' }, { value: ',', label: 'Čárka ,' }, { value: '\t', label: 'Tabulátor' }, { value: '|', label: 'Svislítko |' }], wz.csv.delimiter, { onChange: (e) => { wz.csv.delimiter = e.target.value; refreshPreview(); } });
    const decSel = select([{ value: '', label: 'Automaticky' }, { value: ',', label: 'Čárka (12,50)' }, { value: '.', label: 'Tečka (12.50)' }], wz.csv.decimal, { onChange: (e) => { wz.csv.decimal = e.target.value; refreshPreview(); } });
    const encSel = select([{ value: '', label: 'Automaticky' }, { value: 'utf-8', label: 'UTF-8' }, { value: 'windows-1250', label: 'Windows-1250 (Excel, POHODA)' }, { value: 'iso-8859-2', label: 'ISO-8859-2' }], wz.csv.encoding, { onChange: (e) => { wz.csv.encoding = e.target.value; refreshPreview(); } });
    const hdrIn = numberInput(wz.csv.header_row, { placeholder: '1', size: 4 });
    hdrIn.addEventListener('input', () => { const v = parseInputNumber(hdrIn.value); if (!Number.isNaN(v)) { wz.csv.header_row = v == null ? '' : v; refreshPreview(); } });
    const fmt = wz.format !== 'auto' ? wz.format : p.format;
    const kindOpts = wz.kind === 'offers'
      ? [
        field({
          label: 'Staré nabídky',
          control: select([{ value: '', label: 'Ponechat (jen aktualizovat)' }, { value: 'competitors', label: 'Nahradit u konkurentů v souboru' }, { value: 'all', label: 'Nahradit všechny nabídky' }], wz.replace, { onChange: (e) => { wz.replace = e.target.value; } }),
          help: 'Nahradit = nabídky, které v souboru chybí, se smažou (konkurent produkt přestal nabízet).',
        }),
        h('div', { class: 'field' }, checkbox('Ceny v souboru jsou bez DPH', wz.price_net, (v) => { wz.price_net = v; refreshPreview(); }), h('span', { class: 'field-help' }, 'Přepočítají se na ceny s DPH podle sazby produktu.')),
      ]
      : [
        h('div', { class: 'field' }, checkbox('Deaktivovat produkty, které v souboru chybí', wz.deactivate_missing, (v) => { wz.deactivate_missing = v; }), h('span', { class: 'field-help' }, 'Použijte jen u úplného exportu katalogu.')),
        h('div', { class: 'field' }, checkbox('Nenamapované sloupce uložit jako atributy', wz.attrs !== 'none', (v) => { wz.attrs = v ? 'all' : 'none'; refreshPreview(); }), h('span', { class: 'field-help' }, 'Atributy lze použít v segmentech (např. attrs.N).')),
      ];
    return card({
      title: 'Soubor a volby',
      icon: 'file',
      actions: [button('Jiný soubor', { size: 'sm', variant: 'ghost', icon: 'x', onClick: () => { Object.assign(wz, { file: null, preview: null, result: null, dryResult: null }); renderWizard(); } })],
      body: [
        h('div', { class: 'file-info' }, icon('file', { size: 18 }), h('span', { class: 'strong' }, wz.file.name), h('span', { class: 'muted' }, bytes(wz.file.size)), p.format ? badge(String(p.format).toUpperCase(), 'info') : null, p.itemPath ? badge('položky: ' + p.itemPath, 'neutral') : null, p.headers ? h('span', { class: 'muted small' }, int(p.headers.length) + ' sloupců') : null),
        h(
          'div',
          { class: 'form-grid', style: 'margin-top:14px' },
          field({ label: 'Formát', control: fmtSel }),
          fmt === 'xml' || fmt === 'json' ? field({ label: 'Cesta k položkám', control: pathIn, help: 'Opakující se element / pole. Prázdné = automaticky.' }) : null,
          fmt === 'csv' ? field({ label: 'Oddělovač', control: delimSel }) : null,
          fmt === 'csv' || fmt === 'xlsx' ? field({ label: 'Desetinná čárka', control: decSel }) : null,
          fmt === 'csv' ? field({ label: 'Kódování', control: encSel }) : null,
          fmt === 'csv' ? field({ label: 'Řádek záhlaví', control: hdrIn }) : null
        ),
        h('div', { class: 'form-grid form-grid-2', style: 'margin-top:14px' }, kindOpts),
      ],
    });
  }

  function mappingCard() {
    const p = wz.preview || {};
    const headers = Array.isArray(p.headers) ? p.headers : [];
    const sample = Array.isArray(p.sample) ? p.sample : [];
    const rows = CANONICAL[wz.kind].map((f) => {
      const sel = h('select', { class: 'select', 'aria-label': 'Sloupec pro ' + f.label, dataset: { canonical: f.key } }, h('option', { value: '' }, '— nemapovat —'), headers.map((hd) => h('option', { value: hd }, hd)));
      sel.value = wz.fields[f.key] || '';
      const def = h('input', { class: 'input', value: wz.defaults[f.key] ?? '', placeholder: f.required ? 'povinné, pokud chybí sloupec' : '', 'aria-label': 'Výchozí hodnota pro ' + f.label, dataset: { default: f.key } });
      const ex = h('span', { class: 'map-sample' });
      const updEx = () => {
        const col = wz.fields[f.key];
        const vals = col ? sample.slice(0, 3).map((r) => r[col]).filter((v) => v != null && v !== '') : [];
        ex.textContent = vals.length ? vals.map((v) => truncate(String(v), 24)).join(' · ') : wz.defaults[f.key] ? '„' + wz.defaults[f.key] + '“ (výchozí)' : '–';
        ex.title = ex.textContent;
      };
      updEx();
      sel.addEventListener('change', () => {
        if (sel.value) wz.fields[f.key] = sel.value;
        else delete wz.fields[f.key];
        updEx();
        refreshValidation();
        refreshPreview();
      });
      def.addEventListener('input', () => {
        if (def.value.trim()) wz.defaults[f.key] = def.value.trim();
        else delete wz.defaults[f.key];
        updEx();
        refreshValidation();
        refreshPreview();
      });
      return h(
        'tr',
        null,
        h('td', null, h('div', { class: 'cell-2' }, h('span', { class: 'strong' }, f.label, f.required ? h('span', { class: 'req', style: 'color:var(--danger)' }, ' *') : null), h('span', { class: 'cell-sub mono' }, f.key))),
        h('td', null, sel),
        h('td', null, def),
        h('td', { class: 'hide-sm' }, ex)
      );
    });
    return card({
      title: 'Mapování polí',
      icon: 'link',
      subtitle: 'Ke každému poli Cenotvorby vyberte sloupec ze souboru, nebo zadejte pevnou hodnotu (např. název konkurenta, když soubor obsahuje ceny jednoho obchodu). Návrh mapování je automatický.',
      flush: true,
      dataset: { card: 'mapping' },
      body: h('div', { class: 'dt-scroll' }, h('table', { class: 'table table-dense map-table' }, h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Pole'), h('th', { scope: 'col' }, 'Sloupec v souboru'), h('th', { scope: 'col' }, 'Výchozí hodnota'), h('th', { scope: 'col', class: 'hide-sm' }, 'Ukázka'))), h('tbody', null, rows))),
    });
  }

  const validationHost = h('div');
  function refreshValidation() {
    const miss = missingRequired(wz.kind, wz.fields, wz.defaults);
    const items = [];
    if (miss.length) items.push('Chybí povinné pole: ' + miss.join(', ') + '.');
    if (!hasMatchKey(wz.kind, wz.fields)) items.push('Namapujte aspoň jeden párovací klíč: náš kód, EAN, MPN, ID nebo název.');
    mount(validationHost, items.length ? callout(h('ul', { class: 'validation-list' }, items.map((t) => h('li', null, t))), 'warning') : null);
    return items;
  }

  function previewTables() {
    const p = wz.preview || {};
    const headers = (Array.isArray(p.headers) ? p.headers : []).slice(0, 14);
    const sample = (Array.isArray(p.sample) ? p.sample : []).slice(0, 5).map((r, i) => ({ ...r, __i: i }));
    const canon = (Array.isArray(p.canonical) ? p.canonical : []).map((r, i) => ({ ...(r || {}), __i: i, __bad: r == null }));
    const canonKeys = [...new Set(canon.flatMap((r) => Object.keys(r).filter((k) => !k.startsWith('__'))))];
    const errs = Array.isArray(p.errors) ? p.errors : [];
    return h(
      'div',
      { class: 'grid-2' },
      card({
        title: 'Ukázka ze souboru',
        icon: 'file',
        subtitle: 'Prvních ' + int(sample.length) + ' záznamů, ' + int((p.headers || []).length) + ' sloupců' + ((p.headers || []).length > 14 ? ' (zobrazeno 14)' : ''),
        flush: true,
        body: sample.length ? simpleTable(headers.map((k) => ({ key: k, label: k, render: (r) => h('span', { class: 'small nowrap' }, truncate(r[k] == null ? '' : String(r[k]), 40)) })), sample, { rowKey: '__i' }) : emptyState({ title: 'Soubor neobsahuje žádné záznamy', compact: true }),
      }),
      card({
        title: 'Výsledek po mapování',
        icon: 'check',
        subtitle: 'Takto záznamy uvidí Cenotvorba.' + (errs.length ? ' Chyby: ' + int(errs.length) : ''),
        flush: true,
        dataset: { card: 'canonical' },
        body: [
          canon.length
            ? simpleTable(canonKeys.map((k) => ({ key: k, label: k, render: (r) => (r.__bad ? h('span', { class: 'muted' }, '–') : h('span', { class: 'small nowrap' }, truncate(typeof r[k] === 'object' ? JSON.stringify(r[k]) : String(r[k] ?? ''), 32))) })), canon, { rowKey: '__i', rowClass: (r) => (r.__bad ? 'is-muted' : null) })
            : emptyState({ title: 'Zatím nic', text: 'Namapujte povinná pole.', compact: true }),
          errs.length ? h('div', { style: 'padding:10px 16px' }, errorsList(errs)) : null,
        ],
      })
    );
  }

  async function doImport(dry) {
    if (refreshValidation().length && !dry) {
      const ok = await confirmDialog({ title: 'Mapování není úplné', message: 'Některá povinná pole chybí – řádky bez nich skončí chybou. Přesto importovat?', confirmLabel: 'Importovat' });
      if (!ok) return;
    }
    if (!dry && wz.kind === 'offers' && wz.replace === 'all') {
      const ok = await confirmDialog({ title: 'Nahradit všechny nabídky', message: 'Všechny nabídky konkurence, které nejsou v tomto souboru, se smažou. Pokračovat?', confirmLabel: 'Nahradit', danger: true });
      if (!ok) return;
    }
    wz.busy = true;
    renderWizard();
    try {
      const res = await api.upload('/import/' + wz.kind, wz.file, importQuery(dry), { signal: ctx.signal });
      if (dry) wz.dryResult = res;
      else {
        wz.result = res;
        invalidate();
        ctx.notifyChanged('import');
        toast('Import dokončen: ' + int(res?.stats?.received) + ' záznamů', { type: 'success' });
      }
    } catch (e) {
      if (isAbort(e)) return;
    } finally {
      wz.busy = false;
      renderWizard();
    }
  }

  function saveAsSource() {
    const nameIn = h('input', { class: 'input', value: (wz.kind === 'offers' ? 'Ceny konkurence – ' : 'Katalog – ') + (wz.file?.name || ''), required: true });
    const urlIn = h('input', { class: 'input', type: 'url', placeholder: 'https://… (nepovinné)' });
    const intSel = select(INTERVALS, 0);
    const m = openModal({
      title: 'Uložit mapování jako zdroj',
      body: h(
        'div',
        { class: 'stack-sm' },
        h('p', { class: 'muted' }, 'Zdroj si pamatuje mapování i volby. Data pak můžete posílat přes API s parametrem source=ID, nebo je Cenotvorba bude stahovat z URL v intervalu.'),
        field({ label: 'Název', control: nameIn, required: true }),
        field({ label: 'URL ke stahování', control: urlIn, help: 'Např. feed od nástroje na sběr cen nebo export z adminu. Prázdné = data posíláte sami.' }),
        field({ label: 'Interval stahování', control: intSel })
      ),
      footer: [
        h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Zrušit'),
        h('button', {
          type: 'button', class: 'btn btn-primary', dataset: { action: 'save-source' },
          onClick: async (e) => {
            if (!nameIn.value.trim()) { nameIn.focus(); return; }
            e.currentTarget.disabled = true;
            try {
              const options = wz.kind === 'offers' ? (wz.replace ? { replace: wz.replace } : {}) : wz.deactivate_missing ? { deactivate_missing: true } : {};
              const s = await api.post('/sources', { name: nameIn.value.trim(), kind: wz.kind, url: urlIn.value.trim() || null, method: 'GET', headers: {}, mapping: mapping(), options, interval_minutes: Number(intSel.value) || 0, enabled: true });
              toast('Zdroj uložen' + (s?.id ? ' (ID ' + s.id + ')' : ''), { type: 'success' });
              m.close();
              sourcesDirty = true;
            } catch {
              e.currentTarget.disabled = false;
            }
          },
        }, 'Uložit zdroj'),
      ],
      initialFocus: 'input',
    });
  }

  function resultCard() {
    const r = wz.result;
    return card({
      title: 'Import dokončen',
      icon: 'check',
      subtitle: r?.import_id ? 'Import #' + r.import_id : null,
      dataset: { card: 'import-result' },
      body: [
        statsGrid(r?.stats, wz.kind),
        h(
          'div',
          { class: 'form-actions' },
          button('Uložit mapování jako zdroj', { icon: 'plus', onClick: saveAsSource, dataset: { action: 'open-save-source' } }),
          wz.kind === 'offers' ? button('Spustit přecenění', { icon: 'play', variant: 'primary', onClick: () => ctx.runPricing() }) : h('a', { class: 'btn btn-primary', href: '#/produkty' }, 'Zobrazit produkty'),
          button('Importovat další soubor', { variant: 'ghost', onClick: () => { Object.assign(wz, { file: null, preview: null, result: null, dryResult: null }); renderWizard(); } })
        ),
      ],
    });
  }

  function renderWizard() {
    const parts = [stepsEl()];
    if (!wz.file) {
      parts.push(card({ title: 'Co importujete', icon: 'upload', body: [kindSelector(), h('div', { style: 'margin-top:14px' }, dropzone()), h('div', { style: 'margin-top:10px' }, pastePanel())] }));
      parts.push(callout(h('span', null, 'Data můžete posílat i automaticky – přes API nebo URL zdroj s intervalem. ', h('a', { href: '#/import?tab=api' }, 'Jak posílat data přes API →')), 'info'));
    } else if (wz.result) {
      parts.push(resultCard());
    } else {
      parts.push(card({ title: 'Co importujete', icon: 'upload', body: kindSelector() }));
      if (wz.busy && !wz.preview) {
        parts.push(card({ body: h('div', { class: 'row' }, h('span', { class: 'btn is-busy btn-ghost', 'aria-hidden': 'true' }, 'x'), h('span', null, 'Načítám náhled souboru…')) }));
      } else if (!wz.preview) {
        parts.push(card({ body: errorState(wz.previewError || new Error('Náhled se nepodařil.'), () => runPreview(false)) }));
      } else {
        parts.push(optionsCard(), mappingCard(), validationHost, previewTables());
        refreshValidation();
        const dryBtn = h('button', { type: 'button', class: 'btn', disabled: wz.busy, dataset: { action: 'dry-run' }, onClick: () => doImport(true) }, icon('eye', { size: 16 }), h('span', null, 'Zkušební import (bez zápisu)'));
        const goBtn = h('button', { type: 'button', class: ['btn', 'btn-primary', wz.busy ? 'is-busy' : null], disabled: wz.busy, dataset: { action: 'import' } }, icon('upload', { size: 16 }), h('span', null, 'Importovat'));
        goBtn.addEventListener('click', () => doImport(false));
        parts.push(
          card({
            title: 'Import',
            icon: 'upload',
            dataset: { card: 'import-actions' },
            body: [
              wz.dryResult ? h('div', { class: 'stack-sm', style: 'margin-bottom:14px' }, h('div', { class: 'form-subtitle' }, 'Výsledek zkušebního importu (nic se nezapsalo)'), statsGrid(wz.dryResult.stats, wz.kind)) : h('p', { class: 'muted' }, 'Zkušební import ověří celý soubor (párování, chyby) bez zápisu do databáze.'),
              h('div', { class: 'form-actions' }, dryBtn, goBtn, h('span', { class: 'toolbar-spacer' }), button('Uložit mapování jako zdroj', { variant: 'ghost', icon: 'plus', onClick: saveAsSource })),
            ],
          })
        );
      }
    }
    mount(wizardHost, parts);
  }

  // =============================================================== zdroje
  let sourcesDirty = false;
  function sourceModal(src) {
    const s = src || { name: '', kind: 'offers', url: '', method: 'GET', headers: {}, mapping: {}, options: {}, interval_minutes: 0, enabled: 1 };
    const nameIn = h('input', { class: 'input', value: s.name || '' });
    const kindSel = select([{ value: 'offers', label: KIND_LABELS.offers }, { value: 'products', label: KIND_LABELS.products }], s.kind);
    const urlIn = h('input', { class: 'input input-mono', type: 'url', value: s.url || '', placeholder: 'https://…' });
    const methodSel = select([{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }], s.method || 'GET');
    const intSel = select(INTERVALS.some((x) => x.value === Number(s.interval_minutes)) ? INTERVALS : [...INTERVALS, { value: s.interval_minutes, label: intervalLabel(s.interval_minutes) }], s.interval_minutes || 0);
    const enabledSw = switchEl({ checked: Boolean(s.enabled), label: 'Zdroj je aktivní' });
    const jsonArea = (v) => {
      const ta = h('textarea', { class: 'input json-edit', rows: 5, spellcheck: 'false' });
      ta.value = JSON.stringify(v || {}, null, 2);
      return ta;
    };
    const headersTa = jsonArea(s.headers);
    const mappingTa = jsonArea(s.mapping);
    const optionsTa = jsonArea(s.options);
    const err = h('div', { class: 'field-error', role: 'alert' });
    const m = openModal({
      title: src ? 'Upravit zdroj' : 'Nový zdroj dat',
      size: 'lg',
      body: h(
        'div',
        { class: 'stack-sm' },
        h('div', { class: 'form-grid form-grid-2' }, field({ label: 'Název', control: nameIn, required: true }), field({ label: 'Druh dat', control: kindSel })),
        h('div', { class: 'form-grid form-grid-2' }, field({ label: 'URL', control: urlIn, help: 'Prázdné = data posíláte přes API (POST /import/…?source=ID) nebo nahráním souboru.' }), field({ label: 'Metoda', control: methodSel })),
        h('div', { class: 'form-grid form-grid-2' }, field({ label: 'Interval stahování', control: intSel }), h('div', { class: 'field' }, enabledSw)),
        field({ label: 'HTTP hlavičky (JSON)', control: headersTa, help: 'Např. {"Authorization": "Bearer …"} pro chráněný feed.' }),
        h('details', { class: 'disclosure' }, h('summary', null, icon('chevron-right', { size: 14 }), 'Pokročilé: mapování a volby (JSON)'), h('div', { class: 'stack-sm', style: 'margin-top:8px' }, field({ label: 'Mapování', control: mappingTa, help: '{"fields": {"ean": "EAN", "price": "Cena"}, "defaults": {"competitor": "…"}, "csv": {"decimal": ","}, "item_path": "…"}' }), field({ label: 'Volby', control: optionsTa, help: 'Nabídky: {"replace": "competitors"}; katalog: {"deactivate_missing": true}' }))),
        err
      ),
      footer: [
        h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Zrušit'),
        h('button', {
          type: 'button', class: 'btn btn-primary',
          onClick: async (e) => {
            let headers;
            let mp;
            let opts;
            try {
              headers = JSON.parse(headersTa.value || '{}');
              mp = JSON.parse(mappingTa.value || '{}');
              opts = JSON.parse(optionsTa.value || '{}');
            } catch (ex) {
              err.textContent = 'Neplatný JSON: ' + ex.message;
              return;
            }
            if (!nameIn.value.trim()) {
              err.textContent = 'Zadejte název zdroje.';
              nameIn.focus();
              return;
            }
            e.currentTarget.disabled = true;
            const body = { name: nameIn.value.trim(), kind: kindSel.value, url: urlIn.value.trim() || null, method: methodSel.value, headers, mapping: mp, options: opts, interval_minutes: Number(intSel.value) || 0, enabled: enabledSw.querySelector('[role=switch]').getAttribute('aria-checked') === 'true' };
            try {
              if (src) await api.put('/sources/' + encodeURIComponent(src.id), body);
              else await api.post('/sources', body);
              toast('Zdroj uložen', { type: 'success' });
              m.close();
              loadSources();
            } catch {
              e.currentTarget.disabled = false;
            }
          },
        }, 'Uložit'),
      ],
    });
  }

  async function runSource(s, btn) {
    btn.disabled = true;
    btn.classList.add('is-busy');
    try {
      const r = await api.post('/sources/' + encodeURIComponent(s.id) + '/run', {});
      toast('Zdroj „' + s.name + '“ načten: ' + int(r?.stats?.received) + ' záznamů', { type: 'success' });
      ctx.notifyChanged('import');
    } catch {
      /* toast */
    }
    btn.disabled = false;
    btn.classList.remove('is-busy');
    loadSources();
  }

  async function toggleSource(s, on) {
    try {
      await api.put('/sources/' + encodeURIComponent(s.id), { ...s, enabled: on });
      toast(on ? 'Zdroj zapnut' : 'Zdroj vypnut', { type: 'success', timeout: 1800 });
    } catch {
      /* toast */
    }
    loadSources();
  }

  async function deleteSource(s) {
    const ok = await confirmDialog({ title: 'Smazat zdroj', message: 'Smazat zdroj „' + s.name + '“? Historie importů zůstane.', confirmLabel: 'Smazat', danger: true });
    if (!ok) return;
    try {
      await api.del('/sources/' + encodeURIComponent(s.id));
      toast('Zdroj smazán', { type: 'success' });
    } catch {
      /* toast */
    }
    loadSources();
  }

  const srcTable = new DataTable({
    columns: [
      { key: 'name', label: 'Zdroj', sortable: true, render: (s) => h('div', { class: 'cell-2' }, h('span', { class: 'strong' }, s.name), h('span', { class: 'cell-sub' }, KIND_LABELS[s.kind] || s.kind, ' · ID ', h('span', { class: 'mono' }, String(s.id)))) },
      { key: 'url', label: 'URL', hideSm: true, render: (s) => (s.url ? h('span', { class: 'mono small', title: s.url }, truncate(s.url, 48)) : h('span', { class: 'muted small' }, 'bez URL – API / soubor')) },
      { key: 'interval_minutes', label: 'Interval', sortable: true, render: (s) => h('span', { class: 'small' }, s.url ? intervalLabel(s.interval_minutes) : '–') },
      {
        key: 'last_run_at', label: 'Poslední běh', sortable: true, value: (s) => (s.last_run_at ? Date.parse(s.last_run_at) : null),
        render: (s) => (s.last_run_at ? h('div', { class: 'cell-2' }, h('span', { class: 'row', style: 'gap:6px' }, jobStatusBadge(s.last_status), h('span', { class: 'small', title: dateTime(s.last_run_at) }, relTime(s.last_run_at))), s.last_message ? h('span', { class: 'cell-sub ellipsis', style: 'max-width:260px', title: s.last_message }, s.last_message) : null) : h('span', { class: 'muted' }, 'zatím neběžel')),
      },
      { key: 'enabled', label: 'Aktivní', align: 'center', render: (s) => switchEl({ checked: Boolean(s.enabled), ariaLabel: 'Aktivní: ' + s.name, onChange: (v) => toggleSource(s, v) }) },
      {
        key: 'actions', label: 'Akce', align: 'right',
        render: (s) => {
          const runBtn = button('Spustit', { icon: 'play', size: 'sm', disabled: !s.url, title: s.url ? 'Stáhnout a importovat teď' : 'Zdroj nemá URL' });
          runBtn.addEventListener('click', () => runSource(s, runBtn));
          return h('span', { class: 'row-actions' }, runBtn, button('', { icon: 'edit', size: 'sm', variant: 'ghost', title: 'Upravit', onClick: () => sourceModal(s) }), button('', { icon: 'trash', size: 'sm', variant: 'ghost', title: 'Smazat', onClick: () => deleteSource(s) }));
        },
      },
    ],
    clientSort: true,
    caption: 'Zdroje dat',
    empty: () => emptyState({ icon: 'link', title: 'Žádné zdroje', text: 'Zdroj = uložené mapování + volitelně URL a interval stahování. Vytvořte ho z průvodce importem („Uložit mapování jako zdroj“) nebo ručně.', actions: [button('Nový zdroj', { icon: 'plus', variant: 'primary', onClick: () => sourceModal(null) })] }),
  });

  async function loadSources() {
    srcTable.setLoading(true);
    try {
      const r = await api.get('/sources', null, { signal: ctx.signal, silent: true });
      srcTable.setData(itemsOf(r));
      sourcesDirty = false;
    } catch (e) {
      if (isAbort(e)) return;
      srcTable.setError(e, () => loadSources());
    }
  }

  // =============================================================== historie
  const logTable = new DataTable({
    columns: [
      { key: 'started_at', label: 'Začátek', sortable: true, value: (i) => Date.parse(i.started_at), render: (i) => h('div', { class: 'cell-2' }, h('span', { class: 'nowrap' }, dateTime(i.started_at)), h('span', { class: 'cell-sub' }, relTime(i.started_at))) },
      { key: 'kind', label: 'Druh', sortable: true, render: (i) => h('div', { class: 'cell-2' }, h('span', null, KIND_LABELS[i.kind] || i.kind), h('span', { class: 'cell-sub' }, (i.format ? String(i.format).toUpperCase() : '') + (i.origin ? ' · ' + (ORIGIN_LABELS[i.origin] || i.origin) : ''))) },
      { key: 'source_name', label: 'Zdroj', hideSm: true, render: (i) => h('span', { class: 'small' }, i.source_name || (i.source_id ? '#' + i.source_id : '–')) },
      { key: 'status', label: 'Stav', sortable: true, render: (i) => jobStatusBadge(i.status) },
      { key: 'duration', label: 'Trvání', align: 'right', hideSm: true, render: (i) => h('span', { class: 'num small' }, i.finished_at ? duration(Date.parse(i.finished_at) - Date.parse(i.started_at)) : '–') },
      {
        key: 'stats', label: 'Výsledek',
        render: (i) => {
          if (i.error) return h('span', { class: 'small chg-down', title: i.error }, truncate(i.error, 70));
          const s = statsList(i.stats).filter((x) => ['received', 'matched', 'unmatched', 'created', 'updated', 'errors'].includes(x.key) && x.value);
          return h('span', { class: 'small' }, s.map((x) => x.label.toLowerCase() + ' ' + int(x.value)).join(' · ') || '–');
        },
      },
    ],
    clientSort: true,
    sort: { key: 'started_at', dir: 'desc' },
    expandable: (i) => h('div', { class: 'stack-sm' }, statsGrid(i.stats, i.kind), i.error ? callout(i.error, 'danger') : null),
    caption: 'Historie importů',
    empty: () => emptyState({ icon: 'clock', title: 'Zatím žádné importy', compact: true }),
  });

  async function loadLog() {
    logTable.setLoading(true);
    try {
      const r = await api.get('/imports', null, { signal: ctx.signal, silent: true });
      logTable.setData(itemsOf(r));
    } catch (e) {
      if (isAbort(e)) return;
      logTable.setError(e, () => loadLog());
    }
  }

  // =============================================================== API
  function apiPanel() {
    const origin = location.origin + basePath().replace(/\/$/, '');
    const examples = curlExamples(origin);
    const fieldTable = (kind) =>
      simpleTable(
        [
          { key: 'key', label: 'Pole', render: (f) => h('span', { class: 'mono' }, f.key) },
          { key: 'label', label: 'Význam', render: (f) => h('span', null, f.label, f.required ? h('span', { style: 'color:var(--danger)' }, ' *') : null) },
          { key: 'help', label: 'Poznámka', hideSm: true, render: (f) => h('span', { class: 'small muted' }, f.help || (f.type === 'number' ? 'číslo (12990, „12 990 Kč“, „12.990,-“)' : '')) },
        ],
        CANONICAL[kind],
        { rowKey: 'key' }
      );
    return h(
      'div',
      { class: 'stack' },
      callout(h('span', null, 'Každé volání potřebuje API token s oprávněním ', h('b', null, 'import'), ' (hlavička Authorization: Bearer … nebo X-Api-Key). Token vytvoříte v ', h('a', { href: '#/nastaveni?tab=tokeny' }, 'Nastavení → API tokeny'), '. Formát (JSON / XML / CSV / XLSX) se pozná automaticky; mapování pošlete parametrem mapping nebo odkazem na uložený zdroj source=ID.'), 'info'),
      card({
        title: 'Příklady volání',
        icon: 'code',
        body: examples.map((ex) => h('div', { class: 'api-example', dataset: { example: ex.id } }, h('h3', { class: 'code-title' }, ex.title), h('p', { class: 'muted small' }, ex.text), codeBlock(ex.code))),
      }),
      h(
        'div',
        { class: 'grid-2' },
        card({ title: 'Pole – ceny konkurence', icon: 'store', flush: true, body: fieldTable('offers') }),
        card({ title: 'Pole – katalog produktů', icon: 'box', flush: true, body: fieldTable('products') })
      ),
      card({
        title: 'Dostupnost a čísla',
        icon: 'info',
        body: h(
          'ul',
          { class: 'validation-list' },
          h('li', null, 'Dostupnost: „skladem“, „ano“, true, 1, „in stock“ = skladem; „ne“, „vyprodáno“, „na dotaz“, „preorder“ = není skladem; číslo nebo „do 3 dnů“ = dny dodání.'),
          h('li', null, 'Čísla v CZ i EN formátu: 12990, „12 990 Kč“, „12.990,-“, „12,990.00“. U CSV z Excelu nastavte v mapování csv.decimal = ",".'),
          h('li', null, 'Ceny jsou s DPH; nákupní cena bez DPH (lze změnit v Nastavení). Ceny bez DPH v nabídkách označte mapping.price_net = true.'),
          h('li', null, 'Datum zjištění (observed_at): ISO 8601, „25.9.2026 14:30“ nebo unixový čas. Starší ceny než uložené se ignorují.')
        ),
      })
    );
  }

  const tb = tabs({
    label: 'Import dat',
    active: ['sources', 'log', 'api'].includes(ctx.query.tab) ? ctx.query.tab : 'upload',
    items: [
      { id: 'upload', label: 'Nahrát soubor', render: () => { renderWizard(); return wizardHost; } },
      {
        id: 'sources',
        label: 'Zdroje dat',
        render: () => {
          loadSources();
          return h('div', { class: 'stack-sm' }, h('div', { class: 'row-between' }, h('p', { class: 'muted', style: 'margin:0' }, 'Zdroje se stahují automaticky podle intervalu (plánovač běží každou minutu).'), button('Nový zdroj', { icon: 'plus', onClick: () => sourceModal(null), dataset: { action: 'new-source' } })), h('div', { class: 'card' }, srcTable.el));
        },
      },
      { id: 'log', label: 'Historie importů', render: () => { loadLog(); return h('div', { class: 'card' }, logTable.el); } },
      { id: 'api', label: 'Posílání přes API', render: () => apiPanel() },
    ],
    onChange: (id) => {
      ctx.setQuery({ tab: id === 'upload' ? null : id });
      if (id === 'sources' && sourcesDirty) loadSources();
    },
  });
  mount(root, tb.el);
}
