// Nastavení – obecné, export (XML šablona, POHODA, webhook), plánování, uchovávání dat;
// API tokeny (token se zobrazí jen jednou), změna hesla, auditní log.
import { h, mount } from '../lib/dom.js';
import { api, itemsOf, isAbort, basePath } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { tabs } from '../lib/tabs.js';
import { DataTable } from '../lib/table.js';
import {
  card, field, switchEl, numberInput, withSuffix, select, emptyState, errorState, skeletonBlocks, callout, codeBlock, copyField, badge, checkbox, button,
} from '../lib/ui.js';
import { chipsInput } from '../lib/chips.js';
import { openModal, confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import { dateTime, relTime, SCOPE_LABELS, parseInputNumber } from '../lib/format.js';

export const title = 'Nastavení';

const XML_FIELDS = ['code', 'ean', 'name', 'manufacturer', 'price', 'old_price', 'change_pct', 'vat_rate', 'currency', 'changed_at', 'proposal_id', 'product_id'];
const SCOPE_HELP = {
  read: 'čtení dat (přehledy, produkty, návrhy)',
  import: 'posílání katalogu a cen konkurence',
  export: 'stahování feedů, ack, push',
  admin: 'vše včetně nastavení a schvalování',
};
const RUN_INTERVALS = [
  { value: 0, label: 'Vypnuto' },
  { value: 30, label: 'Každých 30 min' },
  { value: 60, label: 'Každou hodinu' },
  { value: 120, label: 'Každé 2 h' },
  { value: 240, label: 'Každé 4 h' },
  { value: 360, label: 'Každých 6 h' },
  { value: 720, label: 'Každých 12 h' },
  { value: 1440, label: 'Jednou denně' },
];

function get(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function set(obj, path, v) {
  const keys = path.split('.');
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (o[keys[i]] == null || typeof o[keys[i]] !== 'object') o[keys[i]] = {};
    o = o[keys[i]];
  }
  o[keys[keys.length - 1]] = v;
}

export async function show(root, ctx) {
  ctx.setTitle('Nastavení', 'Chování aplikace, export, plánování a přístupy');

  // =============================================================== obecná nastavení
  let original = null;
  let draft = null;
  let removedHeaders = new Set();
  const saveBar = h('div', { class: 'bulkbar', hidden: true, role: 'region', 'aria-label': 'Neuložené změny' });

  function markDirty() {
    const dirty = JSON.stringify(draft) !== JSON.stringify(original) || removedHeaders.size > 0;
    saveBar.hidden = !dirty;
  }

  function numField(path, label, opts = {}) {
    const inp = numberInput(get(draft, path), { placeholder: opts.placeholder || '' });
    inp.addEventListener('input', () => {
      const v = parseInputNumber(inp.value);
      const bad = Number.isNaN(v) || (v == null && !opts.nullable) || (opts.int && v != null && !Number.isInteger(v)) || (opts.min != null && v != null && v < opts.min) || (opts.max != null && v != null && v > opts.max);
      inp.classList.toggle('is-invalid', Boolean(bad));
      if (bad) return;
      set(draft, path, v);
      markDirty();
    });
    return field({ label, control: withSuffix(inp, opts.suffix), input: inp, help: opts.help });
  }
  function boolField(path, label, help) {
    const sw = switchEl({ checked: Boolean(get(draft, path)), label, onChange: (v) => { set(draft, path, v); markDirty(); } });
    return h('div', { class: 'field field-switch' }, sw, help ? h('div', { class: 'field-help' }, help) : null);
  }
  function textField(path, label, opts = {}) {
    const inp = h('input', { class: ['input', opts.mono ? 'input-mono' : null], type: opts.type || 'text', value: get(draft, path) ?? '', placeholder: opts.placeholder || '' });
    inp.addEventListener('input', () => { set(draft, path, inp.value.trim()); markDirty(); });
    return field({ label, control: inp, help: opts.help });
  }
  function selField(path, label, options, help) {
    const s = select(options, get(draft, path), { onChange: (e) => { const o = options.find((x) => String(x.value) === e.target.value); set(draft, path, o ? o.value : e.target.value); markDirty(); } });
    return field({ label, control: s, help });
  }

  function headersEditor() {
    const host = h('div', { class: 'stack-sm' });
    const render = () => {
      const hdrs = get(draft, 'export.webhook.headers') || {};
      const rows = Object.entries(hdrs).map(([k, v]) => {
        const kIn = h('input', { class: 'input input-mono', value: k, 'aria-label': 'Název hlavičky' });
        const vIn = h('input', { class: 'input input-mono', value: v ?? '', 'aria-label': 'Hodnota hlavičky ' + k });
        const commit = () => {
          const cur = { ...(get(draft, 'export.webhook.headers') || {}) };
          delete cur[k];
          if (kIn.value.trim()) cur[kIn.value.trim()] = vIn.value;
          if (kIn.value.trim() !== k) removedHeaders.add(k);
          set(draft, 'export.webhook.headers', cur);
          markDirty();
          render();
        };
        kIn.addEventListener('change', commit);
        vIn.addEventListener('change', commit);
        return h('div', { class: 'row', style: 'flex-wrap:nowrap' }, kIn, vIn, h('button', {
          type: 'button', class: 'btn-icon', 'aria-label': 'Odebrat hlavičku ' + k,
          onClick: () => {
            const cur = { ...(get(draft, 'export.webhook.headers') || {}) };
            delete cur[k];
            removedHeaders.add(k);
            set(draft, 'export.webhook.headers', cur);
            markDirty();
            render();
          },
        }, icon('trash', { size: 15 })));
      });
      mount(host, rows.length ? rows : h('p', { class: 'muted small', style: 'margin:0' }, 'Žádné vlastní hlavičky.'), h('div', null, h('button', {
        type: 'button', class: 'btn btn-sm',
        onClick: () => {
          const cur = { ...(get(draft, 'export.webhook.headers') || {}) };
          let n = 'X-Header';
          let i = 1;
          while (n in cur) n = 'X-Header-' + ++i;
          cur[n] = '';
          removedHeaders.delete(n);
          set(draft, 'export.webhook.headers', cur);
          markDirty();
          render();
        },
      }, icon('plus', { size: 14 }), h('span', null, 'Přidat hlavičku'))));
    };
    render();
    return field({ label: 'HTTP hlavičky webhooku', control: host, help: 'Např. Authorization: Bearer … pro ověření v adminu.' });
  }

  function xmlPreview() {
    const tpl = get(draft, 'export.xml') || {};
    const fields = Array.isArray(tpl.fields) ? tpl.fields : Object.keys(tpl.fields || {});
    const sample = { code: 'TRK-MAR7GEN3-M', ean: '8592842012345', name: 'Trek Marlin 7 Gen 3, M', manufacturer: 'Trek', price: 20990, old_price: 21990, change_pct: -4.55, vat_rate: 21, currency: 'CZK', changed_at: '2026-09-25T08:00:00Z', proposal_id: 1201, product_id: 7 };
    const root = tpl.root || 'prices';
    const item = tpl.item || 'item';
    const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<${root} generated="…" count="1" currency="CZK">`, `  <${item}>`, ...fields.map((f) => `    <${f}>${sample[f] ?? ''}</${f}>`), `  </${item}>`, `</${root}>`];
    return lines.join('\n');
  }

  function generalPanel() {
    const host = h('div', { class: 'stack' });
    const render = () => {
      const xmlPrev = h('div');
      const updXml = () => mount(xmlPrev, codeBlock(xmlPreview(), { title: 'Náhled XML feedu' }));
      const xmlFields = chipsInput({
        values: Array.isArray(get(draft, 'export.xml.fields')) ? get(draft, 'export.xml.fields') : Object.keys(get(draft, 'export.xml.fields') || {}),
        suggestions: XML_FIELDS,
        allowNew: false,
        placeholder: 'Přidat pole…',
        onChange: (v) => { set(draft, 'export.xml.fields', v); markDirty(); updXml(); },
      });
      const rootIn = textField('export.xml.root', 'Kořenový element', { mono: true });
      const itemIn = textField('export.xml.item', 'Element položky', { mono: true });
      rootIn.querySelector('input').addEventListener('input', updXml);
      itemIn.querySelector('input').addEventListener('input', updXml);
      updXml();
      mount(
        host,
        card({
          title: 'Obecné',
          icon: 'settings',
          dataset: { card: 'general' },
          body: [
            h('div', { class: 'form-grid' },
              field({ label: 'Měna', control: h('input', { class: 'input', value: get(draft, 'currency') || 'CZK', readonly: true }), help: 'Všechny ceny jsou v CZK.' }),
              numField('vat_rate_default', 'Výchozí sazba DPH', { suffix: '%', min: 0, max: 99, help: 'Pro produkty bez sazby DPH v katalogu.' }),
              numField('offer_max_age_days', 'Max. stáří cen konkurence', { suffix: 'dní', int: true, min: 1, help: 'Starší ceny se v cenotvorbě ignorují.' }),
              numField('retention_days', 'Uchovávat historii', { suffix: 'dní', int: true, min: 7, help: 'Starší historie cen, auditu a zamítnuté návrhy se mažou.' })
            ),
            h('div', { class: 'form-grid form-grid-2', style: 'margin-top:8px' },
              boolField('purchase_includes_vat', 'Nákupní ceny v importu jsou s DPH', 'Standard POHODY je bez DPH. Zapněte, pokud váš export obsahuje nákupní ceny s DPH – přepočtou se.'),
              boolField('metrics_in_stock_only', 'Metriky v přehledech jen z nabídek skladem', 'Týká se přehledů a filtrů (index, pozice). Strategie mají vlastní nastavení.')
            ),
          ],
        }),
        card({
          title: 'Export',
          icon: 'download',
          dataset: { card: 'export-settings' },
          body: [
            h('div', { class: 'form-grid form-grid-2' },
              boolField('export.update_current_price', 'Po exportu přepsat aktuální cenu produktu', 'Exportovaná cena se zapíše jako aktuální a do historie – další přecenění pak počítá s ní.'),
              selField('export.feed_scope', 'Obsah feedu ceníku', [{ value: 'all', label: 'Celý ceník (všechny aktivní produkty)' }, { value: 'approved', label: 'Jen schválené změny' }])
            ),
            h('h3', { class: 'form-subtitle' }, 'XML feed'),
            h('div', { class: 'form-grid' }, rootIn, itemIn),
            h('div', { style: 'margin-top:14px' }, field({ label: 'Pole v položce (v tomto pořadí)', control: xmlFields.el, input: xmlFields.input })),
            h('div', { style: 'margin-top:12px' }, xmlPrev),
            h('h3', { class: 'form-subtitle' }, 'POHODA XML'),
            h('div', { class: 'form-grid' },
              textField('export.pohoda.ico', 'IČO účetní jednotky', { placeholder: '12345678', help: 'Musí odpovídat IČO v POHODĚ, jinak import odmítne.' }),
              textField('export.pohoda.application', 'Aplikace', { help: 'Uvádí se v hlavičce datového balíku.' }),
              selField('export.pohoda.filter_by', 'Párovat zásoby podle', [{ value: 'code', label: 'Kódu (doporučeno)' }, { value: 'ean', label: 'EAN' }]),
              textField('export.pohoda.price_level', 'Cenová hladina', { placeholder: 'prázdné = prodejní cena', help: 'Zkratka cenové hladiny v POHODĚ, pokud se nemá měnit základní prodejní cena.' })
            ),
            h('h3', { class: 'form-subtitle' }, 'Webhook do adminu'),
            h('div', { class: 'form-grid form-grid-2' },
              textField('export.webhook.url', 'URL webhooku', { type: 'url', mono: true, placeholder: 'https://admin.example.cz/hooks/ceny' }),
              selField('export.webhook.format', 'Formát těla', [{ value: 'json', label: 'JSON' }, { value: 'xml', label: 'XML (šablona výše)' }])
            ),
            h('div', { class: 'form-grid form-grid-2', style: 'margin-top:14px' },
              numField('export.webhook.timeout_ms', 'Časový limit', { suffix: 'ms', int: true, min: 1000 }),
              boolField('export.webhook.auto_push', 'Povolit automatické odesílání', 'Odesílání po naplánovaném přecenění řídí volba v sekci Plánování.')
            ),
            h('div', { style: 'margin-top:14px' }, headersEditor()),
          ],
        }),
        card({
          title: 'Plánování',
          icon: 'clock',
          dataset: { card: 'schedule' },
          body: h('div', { class: 'form-grid form-grid-2' },
            selField('schedule.run_interval_minutes', 'Automatické přecenění', RUN_INTERVALS, 'Pravidelné přecenění všech produktů. Návrhy čekají na schválení (kromě automaticky schvalovaných).'),
            h('div', null,
              boolField('schedule.run_after_import', 'Přecenit po importu cen konkurence', 'Po každém úspěšném importu nabídek (API, URL zdroj) se spustí přecenění.'),
              boolField('schedule.auto_push_after_run', 'Po přecenění odeslat schválené změny webhookem', 'Vyžaduje nastavenou URL webhooku.'))
          ),
        })
      );
    };
    render();
    return { host, render };
  }

  async function saveSettings() {
    const body = JSON.parse(JSON.stringify(draft));
    delete body.currency;
    // Deep-merge na serveru neumí mazat klíče – odebrané hlavičky posíláme jako null.
    if (removedHeaders.size) {
      body.export = body.export || {};
      body.export.webhook = body.export.webhook || {};
      body.export.webhook.headers = { ...(body.export.webhook.headers || {}) };
      for (const k of removedHeaders) if (!(k in body.export.webhook.headers)) body.export.webhook.headers[k] = null;
    }
    try {
      const res = await api.put('/settings', body);
      original = JSON.parse(JSON.stringify(res || draft));
      draft = JSON.parse(JSON.stringify(original));
      if (draft?.export?.webhook?.headers) for (const [k, v] of Object.entries(draft.export.webhook.headers)) if (v == null) delete draft.export.webhook.headers[k];
      original = JSON.parse(JSON.stringify(draft));
      removedHeaders = new Set();
      toast('Nastavení uloženo', { type: 'success' });
      markDirty();
      general.render();
    } catch {
      /* toast s chybou */
    }
  }

  mount(
    saveBar,
    h('span', { class: 'strong' }, 'Máte neuložené změny nastavení'),
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => { draft = JSON.parse(JSON.stringify(original)); removedHeaders = new Set(); markDirty(); general.render(); } }, 'Zahodit'),
    h('button', { type: 'button', class: 'btn btn-sm btn-primary', dataset: { action: 'save-settings' }, onClick: () => saveSettings() }, 'Uložit nastavení')
  );

  let general = null;
  const generalHost = h('div', { class: 'stack' }, skeletonBlocks(3, 160));

  async function loadSettings() {
    try {
      original = await api.get('/settings', null, { signal: ctx.signal, silent: true });
      draft = JSON.parse(JSON.stringify(original));
      general = generalPanel();
      mount(generalHost, general.host, saveBar);
    } catch (e) {
      if (isAbort(e)) return;
      mount(generalHost, errorState(e, () => loadSettings()));
    }
  }

  // =============================================================== tokeny
  const tokenTable = new DataTable({
    columns: [
      { key: 'name', label: 'Název', sortable: true, render: (t) => h('span', { class: 'strong' }, t.name) },
      { key: 'prefix', label: 'Token', render: (t) => h('span', { class: 'mono small' }, (t.prefix || '') + '…') },
      { key: 'scopes', label: 'Oprávnění', render: (t) => h('span', { class: 'tags' }, (Array.isArray(t.scopes) ? t.scopes : []).map((s) => badge(SCOPE_LABELS[s] || s, s === 'admin' ? 'warning' : 'info'))) },
      { key: 'created_at', label: 'Vytvořen', sortable: true, hideSm: true, render: (t) => h('span', { class: 'small', title: dateTime(t.created_at) }, relTime(t.created_at)) },
      { key: 'last_used_at', label: 'Naposledy použit', sortable: true, render: (t) => (t.last_used_at ? h('span', { class: 'small', title: dateTime(t.last_used_at) }, relTime(t.last_used_at)) : h('span', { class: 'muted small' }, 'nikdy')) },
      { key: 'actions', label: '', align: 'right', render: (t) => button('Zrušit', { icon: 'trash', size: 'sm', variant: 'ghost', onClick: () => revoke(t) }) },
    ],
    clientSort: true,
    caption: 'API tokeny',
    empty: () => emptyState({ icon: 'key', title: 'Žádné API tokeny', text: 'Token potřebuje admin pro stahování feedů a nástroj na sběr cen pro posílání dat.', compact: true }),
  });

  async function revoke(t) {
    const ok = await confirmDialog({ title: 'Zrušit token', message: 'Zrušit token „' + t.name + '“? Aplikace, které ho používají, přestanou fungovat.', confirmLabel: 'Zrušit token', danger: true });
    if (!ok) return;
    try {
      await api.del('/tokens/' + encodeURIComponent(t.id));
      toast('Token zrušen', { type: 'success' });
    } catch {
      /* toast */
    }
    loadTokens();
  }

  function showNewToken(res, name) {
    const origin = location.origin + basePath().replace(/\/$/, '');
    const m = openModal({
      title: 'Token vytvořen',
      size: 'lg',
      body: h(
        'div',
        { class: 'token-box', dataset: { role: 'new-token' } },
        callout(h('span', null, h('b', null, 'Zkopírujte si token hned – zobrazí se jen jednou. '), 'V databázi je uložen jen jeho otisk.'), 'warning'),
        field({ label: 'Token „' + name + '“', control: copyField(res.token, { ariaLabel: 'Nový API token' }) }),
        codeBlock(`curl "${origin}/api/v1/auth/me" -H "Authorization: Bearer ${res.token}"`, { title: 'Ověření' })
      ),
      footer: [h('button', { type: 'button', class: 'btn btn-primary', onClick: () => m.close() }, 'Mám zkopírováno')],
      closeOnBackdrop: false,
    });
  }

  function tokensPanel() {
    const nameIn = h('input', { class: 'input', placeholder: 'Např. Admin – stahování feedu', maxlength: 80 });
    const scopes = new Set(['read']);
    const scopeChecks = ['read', 'import', 'export', 'admin'].map((s) => checkbox(SCOPE_LABELS[s] + ' – ' + SCOPE_HELP[s], scopes.has(s), (v) => { if (v) scopes.add(s); else scopes.delete(s); }, { class: 'scope-' + s }));
    const createBtn = h('button', { type: 'submit', class: 'btn btn-primary', dataset: { action: 'create-token' } }, icon('key', { size: 16 }), h('span', null, 'Vytvořit token'));
    const form = h(
      'form',
      {
        class: 'stack-sm',
        onSubmit: async (e) => {
          e.preventDefault();
          if (!nameIn.value.trim()) {
            toast('Zadejte název tokenu.', { type: 'error' });
            nameIn.focus();
            return;
          }
          if (!scopes.size) {
            toast('Vyberte alespoň jedno oprávnění.', { type: 'error' });
            return;
          }
          createBtn.disabled = true;
          try {
            const res = await api.post('/tokens', { name: nameIn.value.trim(), scopes: [...scopes] });
            showNewToken(res, nameIn.value.trim());
            nameIn.value = '';
            loadTokens();
          } catch {
            /* toast */
          }
          createBtn.disabled = false;
        },
      },
      field({ label: 'Název tokenu', control: nameIn, help: 'Pojmenujte podle toho, kdo token používá.' }),
      h('fieldset', { class: 'stack-sm', style: 'border:0;padding:0;margin:0' }, h('legend', { class: 'field-label', style: 'margin-bottom:6px' }, 'Oprávnění'), scopeChecks),
      h('div', null, createBtn)
    );
    loadTokens();
    return h('div', { class: 'stack' }, card({ title: 'Nový token', icon: 'plus', body: form }), card({ title: 'Existující tokeny', icon: 'key', flush: true, body: tokenTable.el, dataset: { card: 'tokens' } }));
  }

  async function loadTokens() {
    tokenTable.setLoading(true);
    try {
      const r = await api.get('/tokens', null, { signal: ctx.signal, silent: true });
      tokenTable.setData(itemsOf(r));
    } catch (e) {
      if (isAbort(e)) return;
      tokenTable.setError(e, () => loadTokens());
    }
  }

  // =============================================================== heslo
  function passwordPanel() {
    const cur = h('input', { type: 'password', class: 'input', autocomplete: 'current-password' });
    const n1 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password', minlength: 8 });
    const n2 = h('input', { type: 'password', class: 'input', autocomplete: 'new-password' });
    const err = h('div', { class: 'field-error', role: 'alert' });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Změnit heslo');
    return card({
      title: 'Změna hesla',
      icon: 'lock',
      subtitle: 'Heslo pro přihlášení do webového rozhraní. Je-li nastaveno proměnnou CENOTVORBA_PASSWORD, má přednost.',
      body: h(
        'form',
        {
          class: 'stack-sm',
          style: 'max-width:420px',
          onSubmit: async (e) => {
            e.preventDefault();
            err.textContent = '';
            if (n1.value.length < 8) {
              err.textContent = 'Nové heslo musí mít alespoň 8 znaků.';
              return;
            }
            if (n1.value !== n2.value) {
              err.textContent = 'Hesla se neshodují.';
              return;
            }
            btn.disabled = true;
            try {
              await api.post('/settings/password', { current: cur.value, new: n1.value }, { silent: true });
              toast('Heslo změněno', { type: 'success' });
              cur.value = '';
              n1.value = '';
              n2.value = '';
            } catch (ex) {
              err.textContent = ex.message || 'Heslo se nepodařilo změnit.';
            }
            btn.disabled = false;
          },
        },
        field({ label: 'Současné heslo', control: cur }),
        field({ label: 'Nové heslo', control: n1, help: 'Alespoň 8 znaků.' }),
        field({ label: 'Nové heslo znovu', control: n2 }),
        err,
        h('div', null, btn)
      ),
    });
  }

  // =============================================================== audit
  function auditPanel() {
    const t = new DataTable({
      columns: [
        { key: 'at', label: 'Čas', sortable: true, value: (a) => Date.parse(a.at), render: (a) => h('span', { class: 'nowrap small', title: relTime(a.at) }, dateTime(a.at)) },
        { key: 'actor', label: 'Kdo', sortable: true, render: (a) => h('span', { class: 'small' }, a.actor || '–') },
        { key: 'action', label: 'Akce', sortable: true, render: (a) => h('span', { class: 'mono small' }, a.action) },
        { key: 'entity', label: 'Objekt', hideSm: true, render: (a) => h('span', { class: 'small' }, (a.entity || '') + (a.entity_id != null ? ' #' + a.entity_id : '')) },
        { key: 'detail', label: 'Detail', hideSm: true, render: (a) => h('span', { class: 'small muted mono ellipsis', style: 'max-width:360px;display:inline-block', title: a.detail || '' }, a.detail || '') },
      ],
      clientSort: true,
      sort: { key: 'at', dir: 'desc' },
      caption: 'Auditní log',
      empty: () => emptyState({ title: 'Audit je prázdný', compact: true }),
    });
    (async () => {
      t.setLoading(true);
      try {
        const r = await api.get('/audit', null, { signal: ctx.signal, silent: true });
        t.setData(itemsOf(r));
      } catch (e) {
        if (!isAbort(e)) t.setError(e);
      }
    })();
    return card({ title: 'Auditní log', icon: 'clock', subtitle: 'Posledních 200 změn (kdo, co, kdy).', flush: true, body: t.el });
  }

  const tb = tabs({
    label: 'Nastavení',
    active: ['tokeny', 'heslo', 'audit'].includes(ctx.query.tab) ? ctx.query.tab : 'obecne',
    items: [
      { id: 'obecne', label: 'Obecné a export', render: () => { if (!general) loadSettings(); return generalHost; } },
      { id: 'tokeny', label: 'API tokeny', render: () => tokensPanel() },
      { id: 'heslo', label: 'Heslo', render: () => passwordPanel() },
      { id: 'audit', label: 'Auditní log', render: () => auditPanel() },
    ],
    onChange: (id) => ctx.setQuery({ tab: id === 'obecne' ? null : id }),
  });
  mount(root, tb.el);
}
