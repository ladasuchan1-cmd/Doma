// Detail produktu – karta, nabídky konkurence (vč. důvodů vyřazení), graf vývoje cen,
// vysvětlení rozhodnutí strategie, historie návrhů a úprava zámku / min / max / poznámky / ruční ceny.
import { h, mount } from '../lib/dom.js';
import { api, isAbort } from '../lib/api.js';
import { buildHash } from '../lib/router.js';
import { icon } from '../lib/icons.js';
import {
  card, kpi, badge, positionBadge, emptyState, errorState, skeletonBlocks, skeletonTable, dl, extLink, numberInput, switchEl, field, withSuffix,
  segmented, statusBadge, changeEl, callout, flagBadges,
} from '../lib/ui.js';
import { simpleTable } from '../lib/table.js';
import { lineChart, sparkline, seriesWithCurrent, SERIES_COLORS } from '../lib/charts.js';
import { decisionView } from '../lib/decision.js';
import { confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import {
  money, percent, int, index, number, availability, age, ageDays, relTime, dateTime, date, excludedLabel, signedPercent, parseInputNumber, toNum,
  reasonLabel, TRIED_RESULT_LABELS,
} from '../lib/format.js';
import { finalPrice, isManual, proposalAtRisk, basePriceChange, displayChange } from '../lib/proposal-model.js';

export const title = 'Detail produktu';

const RANGES = [
  { value: '30', label: '30 dní' },
  { value: '90', label: '90 dní' },
  { value: '180', label: '180 dní' },
  { value: 'all', label: 'Vše' },
];

function competitorColor(id) {
  const n = Number(id);
  return SERIES_COLORS[(Number.isFinite(n) ? n - 1 : 0) % SERIES_COLORS.length];
}

const DAY = 86400000;

/** ISO → hodnota pro <input type="datetime-local"> v místním čase. */
function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** Body řady od `from` (poslední bod před `from` se posune na `from`). */
function clip(points, from) {
  if (from == null) return points;
  const before = points.filter((p) => p.t < from);
  const after = points.filter((p) => p.t >= from);
  if (before.length) after.unshift({ t: from, v: before[before.length - 1].v });
  return after;
}

const TRIED_VARIANT = { decided: 'success', fallthrough: 'warning', not_applicable: 'neutral' };

/** Které strategie se na produkt zkoušely a proč se (ne)použily – explain.tried z API. */
function triedList(tried) {
  const list = Array.isArray(tried) ? tried : [];
  if (!list.length) return null;
  return h(
    'details',
    { class: 'tried', open: list.some((t) => t.result === 'fallthrough') || null },
    h('summary', null, 'Pořadí strategií pro tento produkt (' + int(list.length) + ')'),
    h(
      'ol',
      { class: 'tried-list' },
      list.map((t) => h(
        'li',
        { class: 'tried-' + (t.result || 'x') },
        badge(TRIED_RESULT_LABELS[t.result] || t.result || '–', TRIED_VARIANT[t.result] || 'neutral', t.code ? reasonLabel(t.code) : null),
        t.strategy_id != null ? h('a', { href: '#/strategie/' + encodeURIComponent(t.strategy_id) }, t.name || '#' + t.strategy_id) : h('span', null, t.name || '–'),
        t.why ? h('span', { class: 'muted small' }, '– ' + t.why) : null
      ))
    )
  );
}

export async function show(root, ctx) {
  const id = ctx.params.id;
  ctx.setTitle('Detail produktu', h('a', { href: '#/produkty' }, '← Produkty'));
  let range = ctx.query.range || '90';

  async function load() {
    mount(root, h('div', { class: 'stack' }, skeletonBlocks(1, 70), skeletonBlocks(6, 70), h('div', { class: 'card' }, skeletonTable(6, 6))));
    let d;
    try {
      d = await api.get('/products/' + encodeURIComponent(id), null, { signal: ctx.signal, silent: true });
    } catch (e) {
      if (isAbort(e)) return;
      if (e.status === 404) {
        mount(root, emptyState({ icon: 'box', title: 'Produkt nenalezen', text: 'Produkt #' + id + ' neexistuje nebo byl smazán.', actions: [h('a', { class: 'btn', href: '#/produkty' }, 'Zpět na produkty')] }));
        return;
      }
      mount(root, errorState(e, () => load()));
      return;
    }
    render(d);
  }

  function render(d) {
    const p = d.product || {};
    const lockActive = p.lock_active != null ? Boolean(p.lock_active) : Boolean(Number(p.locked));
    const offers = Array.isArray(d.offers) ? d.offers : [];
    const hist = d.history || {};
    const ex = d.explain || {};
    const proposals = Array.isArray(d.proposals) ? d.proposals : [];
    ctx.setTitle(p.name || p.code || 'Produkt', h('span', null, h('a', { href: '#/produkty' }, 'Produkty'), ' / ', h('span', { class: 'mono' }, p.code || '')));
    ctx.setActions(
      h('a', { class: 'btn btn-ghost hide-sm', href: buildHash('/navrhy', { q: p.code, status: 'all' }) }, icon('tag', { size: 16 }), h('span', { class: 'lbl' }, 'Návrhy')),
      h('button', {
        type: 'button', class: 'btn', dataset: { action: 'reprice-one' },
        onClick: async () => {
          // contract-1: přepočet může nahradit schválený (neexportovaný) návrh – schválení by se ztratilo; bez potvrzení ne
          const risk = proposalAtRisk(proposals);
          if (risk) {
            const ok = await confirmDialog({
              title: 'Přepočítat produkt',
              message: 'Produkt má schválený, dosud neexportovaný návrh ' + money(finalPrice(risk)) + (isManual(risk) ? ' (ruční cena)' : '') + '. ' +
                'Když přepočet vyjde na jinou cenu, nahradí ho nový návrh a schválení se ztratí' +
                (isManual(risk) ? ' – ruční cena se do nového návrhu přenese, ale musí se znovu schválit' : '') + '. Pokračovat?',
              confirmLabel: 'Přepočítat',
              danger: true,
            });
            if (!ok) return;
          }
          const r = await ctx.runPricing({ productIds: [Number(p.id) || p.id], skipConfirm: true, quiet: true });
          if (r) load();
        },
      }, icon('refresh', { size: 16 }), h('span', { class: 'lbl' }, 'Přepočítat'))
    );

    // ----------------------------------------------------- hlavička
    const segs = Array.isArray(ex.segments) ? ex.segments : [];
    const head = h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'card-body detail-head' },
        h(
          'div',
          { style: 'min-width:0;flex:1' },
          h('h2', { class: 'product-title' }, p.name || p.code),
          h(
            'div',
            { class: 'meta' },
            h('span', null, 'Kód ', h('b', { class: 'mono' }, p.code || '–')),
            p.ean ? h('span', null, 'EAN ', h('b', { class: 'mono' }, p.ean)) : null,
            p.mpn ? h('span', null, 'MPN ', h('b', { class: 'mono' }, p.mpn)) : null,
            p.manufacturer ? h('span', null, 'Výrobce ', h('b', null, p.manufacturer)) : null,
            p.category ? h('span', null, 'Kategorie ', h('b', null, p.category)) : null,
            p.supplier ? h('span', null, 'Dodavatel ', h('b', null, p.supplier)) : null,
            p.owner ? h('span', null, 'Odpovídá ', h('b', null, p.owner)) : null,
            // C3: varianty jednoho modelu (velikosti / barvy) – odkaz na všechny produkty skupiny
            p.group_code
              ? h('span', { dataset: { role: 'group-code' } }, 'Skupina ', h('a', { class: 'mono strong', href: buildHash('/produkty', { filter: { field: 'group_code', op: '=', value: p.group_code }, cols: 'code,name,group_code,stock,price,margin_pct,market_min,position,proposal' }), title: 'Zobrazit všechny varianty modelu (velikosti, barvy)' }, p.group_code))
              : null
          ),
          h(
            'div',
            { class: 'row', style: 'margin-top:8px' },
            positionBadge(p.position),
            lockActive ? badge(p.locked_until ? 'Zamčeno do ' + dateTime(p.locked_until) : 'Zamčeno – nepřeceňuje se', 'warning') : null,
            !lockActive && Number(p.locked) && p.locked_until ? badge('Zámek vypršel ' + relTime(p.locked_until), 'neutral') : null,
            p.active === 0 || p.active === false ? badge('Neaktivní', 'neutral') : null,
            segs.map((s) => h('a', { href: '#/segmenty/' + encodeURIComponent(s.id), class: 'tag-chip' }, icon('layers', { size: 12 }), ' ', s.name || '#' + s.id))
          )
        )
      )
    );

    // ----------------------------------------------------- KPI
    const ourHistory = (Array.isArray(hist.our) ? hist.our : []).map((r) => ({ t: Date.parse(r.at), v: Number(r.price) })).filter((x) => Number.isFinite(x.t) && Number.isFinite(x.v)).sort((a, b) => a.t - b.t);
    // Naše cena v grafu = historie změn + aktuální cena (i když historie je prázdná).
    const ourPoints = seriesWithCurrent(ourHistory, toNum(p.price), p.price_changed_at || p.created_at);
    const kpis = h(
      'div',
      { class: 'kpi-grid compact' },
      kpi({ label: 'Cena s DPH', value: money(p.price), sub: ourPoints.length > 1 ? sparkline(ourPoints.map((x) => x.v), { width: 110, height: 24, color: 'var(--series-us)', ariaLabel: 'Vývoj naší ceny' }) : (p.price_changed_at ? 'změněno ' + relTime(p.price_changed_at) : null) }),
      kpi({ label: 'Nákup bez DPH', value: money(p.purchase_price), sub: p.vat != null ? 'DPH ' + number(p.vat, 0) + ' %' : null }),
      kpi({ label: 'Marže', value: percent(p.margin_pct), tone: p.margin_pct != null && p.margin_pct < 0 ? 'danger' : null, sub: p.profit_abs != null ? 'zisk ' + money(p.profit_abs, { decimals: 0 }) + ' / ks' : null }),
      kpi({ label: 'MOC', value: money(p.msrp), sub: p.msrp_diff_pct != null ? signedPercent(p.msrp_diff_pct) + ' vs. MOC' : null }),
      kpi({ label: 'Nejnižší cena trhu', value: money(p.market_min), sub: p.cheapest_competitor || (p.market_count ? null : 'bez konkurence') }),
      kpi({ label: 'Index vs. min / medián', value: index(p.price_index), sub: 'medián ' + index(p.price_index_median) }),
      kpi({ label: 'Pořadí', value: p.rank != null ? p.rank + '.' : '–', sub: 'z ' + int((p.market_count || 0) + 1) + ' (vč. nás)' }),
      kpi({ label: 'Sklad', value: int(p.stock) + ' ks', sub: p.days_of_cover != null ? 'na ' + int(p.days_of_cover) + ' dní' : 'prodeje 30 d: ' + int(p.sales_30) }),
      kpi({ label: 'Prodeje 30 / 90 dní', value: int(p.sales_30) + ' / ' + int(p.sales_90) })
    );

    // ----------------------------------------------------- nabídky
    const offerRows = offers.map((o, i) => ({ ...o, _key: 'o' + (o.competitor_id ?? i), _total: o.price != null ? Number(o.price) + (Number(o.shipping) || 0) : null }));
    if (p.price != null) offerRows.push({ _key: 'us', _us: true, competitor: 'Naše cena', price: p.price, shipping: null, _total: p.price, in_stock: p.stock > 0 ? 1 : 0 });
    offerRows.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const offersTable = simpleTable(
      [
        {
          key: 'competitor', label: 'Konkurent', sortable: true,
          render: (o) => o._us
            ? h('span', { class: 'strong' }, 'Naše cena')
            : h('div', { class: 'cell-2' }, h('span', { class: 'row', style: 'gap:6px;flex-wrap:nowrap' }, h('span', { class: 'swatch', style: { background: competitorColor(o.competitor_id) } }), o.url ? extLink(o.url, o.label || o.competitor) : h('span', null, o.label || o.competitor || '–')), o.label && o.label !== o.competitor ? h('span', { class: 'cell-sub' }, o.competitor) : null),
        },
        { key: 'price', label: 'Cena', format: 'money', sortable: true },
        { key: 'shipping', label: 'Doprava', format: 'money', sortable: true, hideSm: true },
        { key: '_total', label: 'S dopravou', format: 'money', sortable: true, hideSm: true, hideLg: true },
        {
          key: 'diff', label: 'vs. my', align: 'right', value: (o) => (o._us || !p.price ? null : (o.price - p.price) / p.price),
          render: (o) => (o._us || !p.price || o.price == null ? h('span', { class: 'muted' }, '–') : h('span', { class: o.price < p.price ? 'chg chg-down' : 'chg chg-up' }, signedPercent(((o.price - p.price) / p.price) * 100))),
        },
        { key: 'in_stock', label: 'Dostupnost', render: (o) => (o._us ? h('span', { class: 'muted' }, int(p.stock) + ' ks') : h('span', { class: o.in_stock === 0 ? 'muted' : null }, availability(o.in_stock, o.delivery_days))) },
        {
          key: 'observed_at', label: 'Stáří', sortable: true, value: (o) => (o._us ? null : Date.parse(o.observed_at)),
          render: (o) => (o._us ? '' : h('span', { class: (ageDays(o.observed_at) ?? 0) > 7 ? 'chg chg-down' : 'muted', title: dateTime(o.observed_at) }, age(o.observed_at))),
        },
        {
          key: 'prev_price', label: 'Změna', hideSm: true,
          render: (o) => (o._us || o.prev_price == null || !o.prev_price ? h('span', { class: 'muted' }, '–') : h('span', { title: 'Dříve ' + money(o.prev_price) + (o.changed_at ? ', ' + relTime(o.changed_at) : '') }, changeEl(((o.price - o.prev_price) / o.prev_price) * 100))),
        },
        {
          key: 'excluded', label: 'V trhu', title: 'Započteno do trhu (výchozí filtr: zapnutí konkurenti, čerstvé ceny)',
          render: (o) => {
            if (o._us) return '';
            const r = o.excluded ?? o.excluded_reason ?? null;
            return r ? badge(excludedLabel(r), 'warning') : badge('Ano', 'success');
          },
        },
      ],
      offerRows,
      {
        rowKey: '_key',
        rowClass: (o) => (o._us ? 'is-us' : o.excluded || o.excluded_reason ? 'is-muted' : null),
        empty: () => emptyState({ icon: 'store', title: 'Žádné nabídky konkurence', text: 'Pro tento produkt zatím nikdo nemá cenu, nebo se nepodařilo spárovat. Zkontrolujte nespárované nabídky.', compact: true, actions: [h('a', { class: 'btn btn-sm', href: '#/konkurence?tab=unmatched' }, 'Nespárované nabídky')] }),
      }
    );
    const offersCard = card({
      title: 'Nabídky konkurence',
      icon: 'store',
      subtitle: offers.length ? int(offers.length) + ' nabídek · vyřazené se do trhu nepočítají (výchozí filtr trhu)' : null,
      flush: true,
      body: offersTable,
    });

    // ----------------------------------------------------- graf
    const chartHost = h('div');
    const compHist = Array.isArray(hist.competitors) ? hist.competitors : [];
    const byComp = new Map();
    for (const r of compHist) {
      const key = r.competitor_id ?? r.competitor;
      if (!byComp.has(key)) byComp.set(key, { id: key, name: r.competitor || 'Konkurent #' + key, points: [] });
      const t = Date.parse(r.observed_at);
      if (Number.isFinite(t) && r.price != null) byComp.get(key).points.push({ t, v: Number(r.price) });
    }
    function drawChart() {
      const now = Date.now();
      const rangeFrom = range === 'all' ? null : now - Number(range) * DAY;
      const series = [];
      for (const c of [...byComp.values()].sort((a, b) => String(a.name).localeCompare(String(b.name), 'cs'))) {
        const pts = clip(c.points.sort((a, b) => a.t - b.t), rangeFrom);
        if (pts.length) series.push({ id: 'c' + c.id, name: c.name, color: competitorColor(c.id), points: pts, markers: true });
      }
      const ours = clip(ourPoints, rangeFrom);
      if (ours.length) series.push({ id: 'us', name: 'Naše cena', color: 'var(--series-us)', points: ours, us: true, markers: true });
      // Osa X podle dat: když data pokrývají kratší dobu než zvolené období, graf se na ně přiblíží (min. 7 dní).
      const allT = series.flatMap((x) => x.points.map((pt) => pt.t));
      let from = rangeFrom;
      if (allT.length) {
        const dataFrom = Math.min(...allT);
        from = rangeFrom == null ? dataFrom : Math.max(rangeFrom, dataFrom);
        from = Math.min(from - DAY / 2, now - 7 * DAY);
        if (rangeFrom != null) from = Math.max(from, rangeFrom);
      }
      // Bez historie změn je naše cena jen jeden bod – přidáme vodorovnou čáru aktuální ceny pro srovnání s konkurencí.
      const refLines = !ourHistory.length && toNum(p.price) != null ? [{ v: toNum(p.price), label: 'naše aktuální cena', color: 'var(--series-us)' }] : [];
      mount(chartHost, lineChart({ series, refLines, height: 280, from: from ?? undefined, to: now, ariaLabel: 'Vývoj naší ceny a cen konkurence', emptyText: 'Pro zvolené období nejsou žádná data' }));
    }
    const rangeCtl = segmented(RANGES, range, (v) => {
      range = v;
      drawChart();
    }, { label: 'Období grafu', class: 'seg-sm' });
    const chartCard = card({ title: 'Vývoj cen', icon: 'chart', subtitle: 'Naše cena (silná čára) a ceny konkurentů. Kliknutím na legendu řadu skryjete.', actions: [rangeCtl], body: chartHost, dataset: { card: 'history' } });

    // ----------------------------------------------------- rozhodnutí
    const strategy = ex.strategy;
    const decisionCard = card({
      title: 'Rozhodnutí strategie',
      icon: 'sliders',
      subtitle: strategy ? h('span', null, 'Platí strategie ', h('a', { href: '#/strategie/' + encodeURIComponent(strategy.id) }, strategy.name || '#' + strategy.id), ' – co by přecenění teď udělalo a proč.') : null,
      body: [
        strategy
          ? decisionView(ex.decision, { showMarket: true })
          : callout(h('span', null, 'Na produkt se nevztahuje žádná zapnutá strategie, přecenění ho přeskočí. ', h('a', { href: '#/strategie' }, 'Nastavit strategie →')), 'warning'),
        triedList(ex.tried),
      ],
      dataset: { card: 'decision' },
    });

    // ----------------------------------------------------- historie návrhů
    const propCard = card({
      title: 'Historie návrhů',
      icon: 'tag',
      flush: true,
      body: simpleTable(
        [
          { key: 'created_at', label: 'Datum', sortable: true, render: (r) => h('span', { title: dateTime(r.created_at) }, date(r.created_at)) },
          {
            key: 'old_price', label: 'Původní',
            // contract-2: otevřený návrh ze staré ceny produktu – ukázat, že se cena mezitím změnila
            render: (r) => {
              const ch = basePriceChange(r, toNum(p.price));
              return ch && !ch.taken
                ? h('span', { title: 'Cena produktu se od návrhu změnila: ' + money(ch.from) + ' → ' + money(ch.to) }, money(r.old_price), ' ', badge('cena se změnila', 'warning'))
                : money(r.old_price);
            },
          },
          { key: 'new_price', label: 'Návrh', align: 'right', render: (r) => h('span', { class: 'num strong', title: isManual(r) ? 'Ruční cena (navrženo ' + money(r.new_price) + ')' : null }, money(finalPrice(r)), isManual(r) ? h('span', { class: 'muted' }, ' ✎') : null) },
          { key: 'change_pct', label: 'Změna', align: 'right', title: 'U otevřených návrhů proti aktuální ceně produktu', render: (r) => changeEl(displayChange(r, toNum(p.price)).pct) },
          { key: 'flags', label: 'Příznaky', hideSm: true, render: (r) => flagBadges(r.flags) },
          { key: 'status', label: 'Stav', render: (r) => statusBadge(r.status) },
        ],
        proposals,
        { sort: { key: 'created_at', dir: 'desc' }, empty: () => emptyState({ title: 'Zatím žádné návrhy', text: 'Návrhy vzniknou při přecenění.', compact: true }) }
      ),
    });

    // ----------------------------------------------------- nastavení produktu
    const untilIn = h('input', { type: 'datetime-local', class: 'input', value: toLocalInput(lockActive ? p.locked_until : null), 'aria-label': 'Zamčeno do', dataset: { field: 'locked_until' } });
    const untilField = field({ label: 'Zamčeno do', control: untilIn, help: 'Prázdné = natrvalo. Po tomto okamžiku se produkt znovu přeceňuje.' });
    untilField.hidden = !lockActive;
    const lockSw = switchEl({ checked: lockActive, label: 'Zamknout cenu (nepřeceňovat)', onChange: (v) => { untilField.hidden = !v; } });
    const minIn = numberInput(p.min_price, { placeholder: 'bez limitu' });
    const maxIn = numberInput(p.max_price, { placeholder: 'bez limitu' });
    const noteIn = h('textarea', { class: 'input', rows: 3, placeholder: 'Např. dohoda s dodavatelem, akce…' });
    noteIn.value = p.note || '';
    const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary', dataset: { action: 'save-product' } }, 'Uložit');
    const settingsForm = h(
      'form',
      {
        class: 'stack-sm',
        onSubmit: async (e) => {
          e.preventDefault();
          const min = parseInputNumber(minIn.value);
          const max = parseInputNumber(maxIn.value);
          if (Number.isNaN(min) || Number.isNaN(max)) {
            toast('Min./max. cena musí být číslo.', { type: 'error' });
            return;
          }
          if (min != null && max != null && min > max) {
            toast('Minimální cena je vyšší než maximální.', { type: 'error' });
            return;
          }
          saveBtn.disabled = true;
          try {
            const sw = lockSw.querySelector('[role=switch]') || lockSw;
            const locked = sw.getAttribute('aria-checked') === 'true';
            const until = locked && untilIn.value ? new Date(untilIn.value) : null;
            if (until && (Number.isNaN(until.getTime()) || until.getTime() <= Date.now())) {
              toast('„Zamčeno do“ musí být v budoucnosti.', { type: 'error' });
              saveBtn.disabled = false;
              return;
            }
            await api.patch('/products/' + encodeURIComponent(p.id), { locked, locked_until: until ? until.toISOString() : null, min_price: min, max_price: max, note: noteIn.value.trim() || null });
            toast('Nastavení produktu uloženo', { type: 'success' });
            ctx.notifyChanged('product');
            load();
          } catch {
            /* chyba už je v toastu */
          } finally {
            saveBtn.disabled = false;
          }
        },
      },
      lockSw,
      h('p', { class: 'field-help' }, 'Zamčený produkt žádná strategie nepřecení – cena zůstane, dokud zámek nezrušíte nebo nevyprší.'),
      untilField,
      h('div', { class: 'form-grid form-grid-2' }, field({ label: 'Minimální cena', control: withSuffix(minIn, 'Kč'), input: minIn, help: 'Cena nikdy neklesne níž (pokud to strategie respektuje).' }), field({ label: 'Maximální cena', control: withSuffix(maxIn, 'Kč'), input: maxIn })),
      field({ label: 'Poznámka', control: noteIn }),
      h('div', { class: 'form-actions' }, saveBtn)
    );
    const priceIn = numberInput(null, { placeholder: String(p.price ?? '') });
    const manualPrice = h(
      'form',
      {
        class: 'stack-sm',
        onSubmit: async (e) => {
          e.preventDefault();
          const v = parseInputNumber(priceIn.value);
          if (v == null || Number.isNaN(v) || v <= 0) {
            toast('Zadejte novou cenu s DPH.', { type: 'error' });
            return;
          }
          const ok = await confirmDialog({ title: 'Ruční změna ceny', message: `Změnit aktuální cenu z ${money(p.price)} na ${money(v)}? Změna se zapíše do historie jako ruční; do adminu se dostane jen exportem ceníku.`, confirmLabel: 'Změnit cenu' });
          if (!ok) return;
          try {
            await api.patch('/products/' + encodeURIComponent(p.id), { price: v });
            toast('Cena změněna', { type: 'success' });
            ctx.notifyChanged('product');
            load();
          } catch {
            /* toast */
          }
        },
      },
      field({ label: 'Nová aktuální cena', control: h('div', { class: 'row', style: 'flex-wrap:nowrap' }, withSuffix(priceIn, 'Kč'), h('button', { type: 'submit', class: 'btn' }, 'Změnit')), input: priceIn, help: 'Použijte, když se cena změnila mimo Cenotvorbu. Návrhy cen se tím nemění.' })
    );
    const settingsCard = card({ title: 'Nastavení produktu', icon: 'lock', body: [settingsForm, h('hr', { class: 'hr' }), manualPrice], dataset: { card: 'product-settings' } });

    const attrs = p.attrs && typeof p.attrs === 'object' ? Object.entries(p.attrs) : [];
    const attrsCard = card({ title: 'Atributy z importu', icon: 'file', body: attrs.length ? dl(attrs.map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])) : h('p', { class: 'muted' }, 'Žádné další atributy. Nenamapované sloupce katalogu se ukládají sem (např. N, sezóna).') });
    const infoCard = card({
      title: 'Údaje',
      icon: 'info',
      body: dl([
        ['Hodnota skladu', money(p.stock_value, { decimals: 0 })],
        ['Přirážka', percent(p.markup_pct)],
        ['Rozdíl od min. trhu', p.gap_min_abs != null ? money(p.gap_min_abs, { decimals: 0 }) + ' (' + signedPercent(p.gap_min_pct) + ')' : '–'],
        ['Nabídek skladem', int(p.offers_instock)],
        ['Cena změněna', p.price_changed_at ? dateTime(p.price_changed_at) : '–'],
        ['Aktualizováno', dateTime(p.updated_at)],
        ['Založeno', date(p.created_at)],
      ]),
    });

    mount(
      root,
      h(
        'div',
        { class: 'stack' },
        head,
        kpis,
        h('div', { class: 'grid-main-side' }, h('div', { class: 'stack' }, offersCard, chartCard, decisionCard, propCard), h('div', { class: 'stack' }, settingsCard, attrsCard, infoCard))
      )
    );
    drawChart();
  }

  await load();
}
