// Konkurence – seznam konkurentů (zapnutí, štítky, popisek, poznámka) a ruční párování nespárovaných nabídek.
import { h, mount, debounce } from '../lib/dom.js';
import { api, itemsOf, isAbort, invalidate } from '../lib/api.js';
import { DataTable } from '../lib/table.js';
import { tabs } from '../lib/tabs.js';
import { emptyState, switchEl, field, callout, extLink, searchInput, button } from '../lib/ui.js';
import { chipsInput } from '../lib/chips.js';
import { openModal, confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import { int, money, percent, index, relTime, dateTime, count, truncate } from '../lib/format.js';

export const title = 'Konkurence';

const DEFAULT_TAGS = ['klíčový', 'marketplace', 'bazar', 'kamenná prodejna', 'zahraniční'];

export async function show(root, ctx) {
  ctx.setTitle('Konkurence', 'Kdo se počítá do trhu a jak se párují nabídky');
  let competitors = [];

  // =============================================================== konkurenti
  function editCompetitor(c) {
    const allTags = [...new Set([...DEFAULT_TAGS, ...competitors.flatMap((x) => x.tags || [])])];
    const labelIn = h('input', { class: 'input', value: c.label || '', placeholder: c.name });
    const tagsIn = chipsInput({ values: c.tags || [], suggestions: allTags, placeholder: 'Přidat štítek…' });
    const noteIn = h('textarea', { class: 'input', rows: 3 });
    noteIn.value = c.note || '';
    const enabledSw = switchEl({ checked: Boolean(c.enabled), label: 'Započítávat do trhu' });
    const saveBtn = h('button', { type: 'button', class: 'btn btn-primary' }, 'Uložit');
    const m = openModal({
      title: 'Konkurent ' + c.name,
      body: h(
        'div',
        { class: 'stack-sm' },
        field({ label: 'Zobrazovaný název', control: labelIn, help: 'Nepovinné – jinak se zobrazuje název z importu (' + c.name + ').' }),
        field({ label: 'Štítky', control: tagsIn.el, input: tagsIn.input, help: 'Podle štítků lze konkurenty zahrnout nebo vyloučit ve strategiích (např. „klíčový“, „marketplace“).' }),
        field({ label: 'Poznámka', control: noteIn }),
        enabledSw,
        h('p', { class: 'field-help' }, 'Vypnutý konkurent se ignoruje ve všech výpočtech (metriky, strategie, přehledy). Jeho nabídky se dál importují.')
      ),
      footer: [h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Zrušit'), saveBtn],
      initialFocus: 'input',
    });
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      try {
        const sw = enabledSw.querySelector('[role=switch]');
        await api.patch('/competitors/' + encodeURIComponent(c.id), { label: labelIn.value.trim() || null, tags: tagsIn.getValues(), note: noteIn.value.trim() || null, enabled: sw.getAttribute('aria-checked') === 'true' });
        invalidate('/competitors');
        toast('Konkurent uložen', { type: 'success' });
        m.close();
        loadCompetitors();
        ctx.notifyChanged('competitors');
      } catch {
        saveBtn.disabled = false;
      }
    });
  }

  async function setEnabled(c, on) {
    try {
      await api.patch('/competitors/' + encodeURIComponent(c.id), { enabled: on });
      c.enabled = on ? 1 : 0;
      invalidate('/competitors');
      toast((on ? 'Zapnuto: ' : 'Vypnuto: ') + c.name, { type: 'success', timeout: 2000 });
      compTable.setData(competitors);
    } catch {
      compTable.setData(competitors);
    }
  }

  const compTable = new DataTable({
    columns: [
      { key: 'name', label: 'Konkurent', sortable: true, render: (c) => h('div', { class: 'cell-2' }, h('span', { class: 'strong' }, c.label || c.name), c.label && c.label !== c.name ? h('span', { class: 'cell-sub' }, c.name) : null) },
      { key: 'tags', label: 'Štítky', render: (c) => (c.tags?.length ? h('span', { class: 'tags' }, c.tags.map((t) => h('span', { class: 'tag-chip' }, t))) : h('span', { class: 'muted' }, '–')) },
      { key: 'offers', label: 'Nabídek', format: 'int', sortable: true },
      {
        key: 'products_cheaper_than_us', label: 'Levnější než my', align: 'right', sortable: true,
        render: (c) => h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: 'num strong' }, int(c.products_cheaper_than_us)), c.offers ? h('span', { class: 'cell-sub' }, percent(((c.products_cheaper_than_us || 0) / c.offers) * 100, 0) + ' nabídek') : null),
      },
      { key: 'avg_index', label: 'Prům. index', align: 'right', sortable: true, title: 'Jejich cena / naše cena × 100 (pod 100 = levnější než my)', render: (c) => h('span', { class: c.avg_index != null && c.avg_index < 97 ? 'chg chg-down' : c.avg_index > 103 ? 'chg chg-up' : 'num' }, index(c.avg_index)) },
      { key: 'last_seen_at', label: 'Naposledy', sortable: true, hideSm: true, value: (c) => (c.last_seen_at ? Date.parse(c.last_seen_at) : null), render: (c) => h('span', { title: dateTime(c.last_seen_at), class: 'muted' }, relTime(c.last_seen_at)) },
      { key: 'note', label: 'Poznámka', hideSm: true, render: (c) => (c.note ? h('span', { class: 'small', title: c.note }, truncate(c.note, 40)) : '') },
      { key: 'enabled', label: 'Aktivní', align: 'center', render: (c) => switchEl({ checked: Boolean(c.enabled), ariaLabel: (c.enabled ? 'Vypnout ' : 'Zapnout ') + c.name, onChange: (v) => setEnabled(c, v) }) },
      { key: 'actions', label: '', align: 'right', render: (c) => button('Upravit', { icon: 'edit', size: 'sm', onClick: () => editCompetitor(c) }) },
    ],
    clientSort: true,
    sort: { key: 'offers', dir: 'desc' },
    rowClass: (c) => (c.enabled ? null : 'is-muted'),
    caption: 'Konkurenti',
    empty: () => emptyState({ icon: 'store', title: 'Zatím žádní konkurenti', text: 'Konkurenti se zakládají automaticky při importu cen konkurence (pole „konkurent“).', actions: [h('a', { class: 'btn btn-primary', href: '#/import' }, 'Importovat ceny konkurence')] }),
  });

  async function loadCompetitors() {
    compTable.setLoading(true);
    try {
      const r = await api.get('/competitors', null, { signal: ctx.signal, silent: true });
      competitors = itemsOf(r);
      compTable.setData(competitors);
      ctx.setSub(count(competitors.length, 'konkurent', 'konkurenti', 'konkurentů') + ' · ' + int(competitors.filter((c) => c.enabled).length) + ' zapnuto');
    } catch (e) {
      if (isAbort(e)) return;
      compTable.setError(e, () => loadCompetitors());
    }
  }

  // =============================================================== nespárované
  const um = { competitor: '', q: '', page: 1, limit: 50 };
  let unmatchedTotal = 0;

  function matchModal(u) {
    let chosen = null;
    const results = h('div', { class: 'match-results', role: 'listbox', 'aria-label': 'Nalezené produkty' });
    const confirmBtn = h('button', { type: 'button', class: 'btn btn-primary', disabled: true, dataset: { action: 'confirm-match' } }, 'Spárovat');
    const initialQ = u.ean || u.mpn || (u.name || '').split(/\s+/).slice(0, 3).join(' ');
    const input = h('input', { type: 'search', class: 'input', value: initialQ, placeholder: 'Kód, název nebo EAN produktu…', 'aria-label': 'Hledat produkt', autocomplete: 'off' });
    let seq = 0;
    const search = async () => {
      const my = ++seq;
      const q = input.value.trim();
      if (!q) {
        mount(results, h('p', { class: 'muted small' }, 'Zadejte kód, název nebo EAN.'));
        return;
      }
      mount(results, h('p', { class: 'muted small' }, 'Hledám…'));
      try {
        const r = await api.get('/products', { q, limit: 8, status: 'all' }, { silent: true });
        if (my !== seq) return;
        const items = itemsOf(r);
        if (!items.length) {
          mount(results, h('p', { class: 'muted small' }, 'Nic nenalezeno. Zkuste kratší dotaz nebo jen část názvu.'));
          return;
        }
        mount(
          results,
          items.map((p) =>
            h(
              'button',
              {
                type: 'button',
                class: 'match-item',
                role: 'option',
                'aria-pressed': chosen && chosen.id === p.id ? 'true' : 'false',
                onClick: (e) => {
                  chosen = p;
                  results.querySelectorAll('.match-item').forEach((b) => b.setAttribute('aria-pressed', 'false'));
                  e.currentTarget.setAttribute('aria-pressed', 'true');
                  confirmBtn.disabled = false;
                  confirmBtn.textContent = 'Spárovat s ' + p.code;
                },
              },
              h('span', { class: 'cell-2' }, h('span', { class: 'strong ellipsis' }, p.name || p.code), h('span', { class: 'cell-sub' }, h('span', { class: 'mono' }, p.code), p.ean ? ' · EAN ' + p.ean : '', p.manufacturer ? ' · ' + p.manufacturer : '')),
              h('span', { class: 'num' }, money(p.price))
            )
          )
        );
      } catch (e) {
        if (my === seq) mount(results, h('p', { class: 'field-error' }, e.message));
      }
    };
    input.addEventListener('input', debounce(search, 250));
    const m = openModal({
      title: 'Spárovat nabídku',
      size: 'lg',
      body: h(
        'div',
        { class: 'stack-sm' },
        h(
          'div',
          { class: 'offer-box' },
          h('div', { class: 'strong' }, u.name || '(bez názvu)'),
          h('div', { class: 'meta' }, h('span', null, 'Konkurent ', h('b', null, u.competitor || '–')), h('span', null, 'Cena ', h('b', null, money(u.price))), u.ean ? h('span', null, 'EAN ', h('b', { class: 'mono' }, u.ean)) : null, u.mpn ? h('span', null, 'MPN ', h('b', { class: 'mono' }, u.mpn)) : null, u.code ? h('span', null, 'Kód ', h('b', { class: 'mono' }, u.code)) : null, u.url ? extLink(u.url, 'Odkaz') : null)
        ),
        field({ label: 'Najít náš produkt', control: input, help: 'Po spárování se uloží alias (EAN / MPN / ID / název) – příští importy tuto nabídku spárují automaticky.' }),
        results
      ),
      footer: [h('button', { type: 'button', class: 'btn', onClick: () => m.close() }, 'Zrušit'), confirmBtn],
      initialFocus: 'input',
    });
    confirmBtn.addEventListener('click', async () => {
      if (!chosen) return;
      confirmBtn.disabled = true;
      try {
        await api.post('/unmatched/' + encodeURIComponent(u.id) + '/match', { product_id: chosen.id });
        toast('Spárováno: nabídka ' + (u.competitor || '') + ' → ' + chosen.code, { type: 'success' });
        m.close();
        loadUnmatched();
        loadCompetitors();
        ctx.notifyChanged('offers');
      } catch {
        confirmBtn.disabled = false;
      }
    });
    search();
  }

  async function discard(u) {
    const ok = await confirmDialog({ title: 'Zahodit nabídku', message: 'Zahodit nespárovanou nabídku „' + (u.name || u.match_key) + '“? Při dalším importu se může objevit znovu.', confirmLabel: 'Zahodit', danger: true });
    if (!ok) return;
    try {
      await api.del('/unmatched/' + encodeURIComponent(u.id));
      toast('Nabídka zahozena', { type: 'success', timeout: 2000 });
    } catch {
      /* toast */
    }
    loadUnmatched();
  }

  const umTable = new DataTable({
    columns: [
      { key: 'competitor', label: 'Konkurent', render: (u) => h('span', { class: 'nowrap' }, u.competitor || '–') },
      { key: 'name', label: 'Nabídka', render: (u) => h('div', { class: 'cell-2' }, u.url ? extLink(u.url, truncate(u.name || u.url, 70)) : h('span', null, u.name || '–'), h('span', { class: 'cell-sub mono' }, u.match_key || '')) },
      {
        key: 'ids', label: 'Identifikátory', hideSm: true,
        render: (u) => h('div', { class: 'cell-2 small' }, [['EAN', u.ean], ['MPN', u.mpn], ['Kód', u.code], ['ID', u.ext_id]].filter(([, v]) => v).map(([k, v]) => h('span', null, h('span', { class: 'muted' }, k + ' '), h('span', { class: 'mono' }, v)))),
      },
      { key: 'price', label: 'Cena', format: 'money' },
      { key: 'seen_count', label: 'Viděno', align: 'right', render: (u) => h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: 'num' }, int(u.seen_count) + '×'), h('span', { class: 'cell-sub', title: dateTime(u.last_seen_at) }, relTime(u.last_seen_at))) },
      {
        key: 'actions', label: 'Akce', align: 'right',
        render: (u) => h('span', { class: 'row-actions' }, button('Spárovat', { icon: 'link', size: 'sm', variant: 'primary', onClick: () => matchModal(u), dataset: { action: 'match' } }), button('', { icon: 'trash', size: 'sm', variant: 'ghost', title: 'Zahodit', onClick: () => discard(u) })),
      },
    ],
    pagination: true,
    page: um.page,
    limit: um.limit,
    onPage: (p, l) => {
      um.page = p;
      um.limit = l;
      loadUnmatched();
    },
    caption: 'Nespárované nabídky',
    empty: () => emptyState({ icon: 'check', title: 'Všechny nabídky jsou spárované', text: 'Nabídky, které se při importu nepodaří přiřadit k produktu (chybí EAN/kód nebo nesedí), se objeví tady.', compact: true }),
  });

  async function loadUnmatched() {
    umTable.setLoading(true);
    try {
      const r = await api.get('/unmatched', { competitor: um.competitor || null, q: um.q || null, page: um.page, limit: um.limit }, { signal: ctx.signal, silent: true });
      unmatchedTotal = r.total ?? itemsOf(r).length;
      umTable.setData(itemsOf(r), { total: unmatchedTotal, page: r.page || um.page, limit: r.limit || um.limit });
      tb.setBadge('unmatched', unmatchedTotal || null);
    } catch (e) {
      if (isAbort(e)) return;
      umTable.setError(e, () => loadUnmatched());
    }
  }

  function unmatchedPanel() {
    const compSel = h('select', {
      class: 'select', 'aria-label': 'Konkurent',
      onChange: (e) => { um.competitor = e.target.value; um.page = 1; loadUnmatched(); },
    }, h('option', { value: '' }, 'Konkurent: vše'));
    compReady.then(() => {
      for (const c of competitors) compSel.appendChild(h('option', { value: String(c.id) }, c.label || c.name));
      compSel.value = um.competitor;
    });
    const onQ = debounce(() => { um.page = 1; loadUnmatched(); }, 280);
    loadUnmatched();
    return h(
      'div',
      { class: 'stack-sm' },
      callout('Nabídky, které import nepřiřadil k žádnému produktu. Spárováním se vytvoří trvalý alias, takže příští import je spáruje sám.', 'info'),
      h('div', { class: 'toolbar' }, searchInput(um.q, (v) => { um.q = v; onQ(); }, { placeholder: 'Název, EAN, MPN…', ariaLabel: 'Hledat nespárované nabídky' }), compSel),
      h('div', { class: 'card' }, umTable.el)
    );
  }

  const compReady = loadCompetitors();
  const tb = tabs({
    label: 'Konkurence',
    active: ctx.query.tab === 'unmatched' ? 'unmatched' : 'competitors',
    items: [
      {
        id: 'competitors',
        label: 'Konkurenti',
        render: () => h('div', { class: 'stack-sm' }, callout('Vypnutý konkurent se nepočítá do trhu ve strategiích ani v přehledech. Štítky slouží k hromadnému zahrnutí/vyloučení konkurentů ve strategiích.', 'info'), h('div', { class: 'card' }, compTable.el)),
      },
      { id: 'unmatched', label: 'Nespárované nabídky', badge: null, render: () => unmatchedPanel() },
    ],
    onChange: (id) => ctx.setQuery({ tab: id === 'unmatched' ? 'unmatched' : null }),
  });
  mount(root, tb.el);
  await compReady;
  // počet nespárovaných do odznaku záložky
  if (tb.active() !== 'unmatched') {
    api.get('/unmatched', { limit: 1 }, { signal: ctx.signal, silent: true }).then((r) => tb.setBadge('unmatched', r?.total || null), () => {});
  }
}
