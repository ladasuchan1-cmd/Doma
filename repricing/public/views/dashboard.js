// Přehled – KPI, rozložení cenových pozic, upozornění, konkurenti, výrobci, poslední běh a importy.
import { h, mount } from '../lib/dom.js';
import { api, isAbort } from '../lib/api.js';
import { buildHash } from '../lib/router.js';
import { icon } from '../lib/icons.js';
import {
  card, kpi, emptyState, errorState, skeletonBlocks, skeletonTable, button, jobStatusBadge,
} from '../lib/ui.js';
import { stackedBar, barList } from '../lib/charts.js';
import { simpleTable } from '../lib/table.js';
import {
  int, percent, signedPercent, signedMoney, index, relTime, dateTime, POSITION_LABELS, POSITION_ORDER, KIND_LABELS, TRIGGER_LABELS, count, duration,
} from '../lib/format.js';
import { statsList } from '../lib/import-model.js';
import { runSummaryText } from '../lib/run-stats.js';

export const title = 'Přehled';

const POS_COLORS = { cheapest: 'var(--pos-cheapest)', middle: 'var(--pos-middle)', most_expensive: 'var(--pos-most)', no_data: 'var(--pos-none)' };
const ALERT_STYLE = {
  below_cost: ['danger', 'alert-circle'],
  import_error: ['danger', 'alert-circle'],
  undercut: ['warning', 'alert'],
  stale: ['warning', 'clock'],
};

function onboarding() {
  const steps = [
    ['Nahrajte katalog produktů', 'CSV/XLSX export skladových zásob z POHODY nebo JSON/XML z adminu.', '#/import'],
    ['Pošlete ceny konkurence', 'Soubor, URL feed nebo API – párování přes kód, EAN nebo MPN.', '#/import'],
    ['Rozdělte produkty do segmentů', 'Např. ležáky N7/N8, klíčové značky, produkty bez konkurence.', '#/segmenty'],
    ['Nastavte strategie', 'Jak se chovat vůči trhu: podlézt nejnižší cenu, držet pozici, medián…', '#/strategie'],
    ['Přeceňte a exportujte', 'Schvalte návrhy a pošlete nové ceny do adminu / POHODY.', '#/export'],
  ];
  return h(
    'div',
    { class: 'stack' },
    card({
      body: emptyState({
        icon: 'upload',
        title: 'Zatím tu nejsou žádné produkty',
        text: 'Cenotvorba potřebuje váš katalog (kódy, nákupní a prodejní ceny, sklad) a ceny konkurence. Začněte importem dat.',
        actions: [h('a', { class: 'btn btn-primary', href: '#/import' }, icon('upload', { size: 16 }), h('span', null, 'Importovat data')), h('a', { class: 'btn', href: '#/import?tab=api' }, 'Jak posílat data přes API')],
      }),
    }),
    card({
      title: 'Jak začít',
      body: h('ol', { class: 'list-plain' }, steps.map(([t, d, href], i) => h('li', null, h('span', { class: 'strategy-num' }, String(i + 1)), h('div', { style: 'flex:1;min-width:0' }, h('a', { href, class: 'strong' }, t), h('div', { class: 'muted small' }, d))))),
    })
  );
}

function kpis(d) {
  const p = d.products || {};
  const pr = d.proposals || {};
  const pos = d.position || {};
  const withMarket = p.with_market || 0;
  const cheapestPct = withMarket ? ((pos.cheapest || 0) / withMarket) * 100 : null;
  return h(
    'div',
    { class: 'kpi-grid' },
    kpi({ label: 'Aktivní produkty', icon: 'box', value: int(p.active), sub: [h('span', null, 's konkurencí ' + int(p.with_market)), h('span', null, 'bez ' + int(p.without_market)), p.locked ? h('span', null, icon('lock', { size: 12 }), ' ' + int(p.locked)) : null], href: '#/produkty' }),
    kpi({ label: 'Index vs. nejlevnější', icon: 'chart', value: index(d.price_index?.vs_min), sub: 'vs. medián trhu ' + index(d.price_index?.vs_median) + ' · 100 = stejná cena', tone: (d.price_index?.vs_min ?? 100) > 105 ? 'warning' : 'info' }),
    kpi({ label: 'Jsme nejlevnější', icon: 'target', value: int(pos.cheapest), sub: cheapestPct != null ? percent(cheapestPct, 0) + ' produktů s konkurencí' : 'bez dat o trhu', href: buildHash('/produkty', { position: 'cheapest' }) }),
    kpi({ label: 'Čeká na schválení', icon: 'tag', value: int(pr.pending), tone: pr.pending ? 'warning' : null, sub: [h('span', { class: 'chg chg-up' }, '▲ ' + int(pr.up)), h('span', { class: 'chg chg-down' }, '▼ ' + int(pr.down)), pr.avg_change_pct != null ? h('span', null, 'Ø ' + signedPercent(pr.avg_change_pct)) : null], href: '#/navrhy' }),
    kpi({ label: 'Schváleno k exportu', icon: 'download', value: int(pr.approved), sub: 'exportováno za 7 dní: ' + int(pr.exported_7d), href: '#/export' }),
    kpi({ label: 'Dopad návrhů na marži', icon: 'zap', value: signedMoney(pr.margin_impact_abs, { decimals: 0 }), sub: 'bez DPH, 1 ks od každého produktu', tone: (pr.margin_impact_abs || 0) < 0 ? 'danger' : 'good' })
  );
}

function positionCard(d) {
  const pos = d.position || {};
  const segs = POSITION_ORDER.map((k) => ({ key: k, label: POSITION_LABELS[k], value: pos[k] || 0, color: POS_COLORS[k], href: buildHash('/produkty', { position: k }) }));
  return card({
    title: 'Naše cenová pozice vůči trhu',
    icon: 'target',
    subtitle: 'Kolik aktivních produktů je nejlevnějších, uprostřed nebo nejdražších mezi konkurenty.',
    body: stackedBar(segs, { ariaLabel: 'Rozložení cenových pozic', height: 26 }),
    dataset: { card: 'position' },
  });
}

function alertsCard(d) {
  const alerts = Array.isArray(d.alerts) ? d.alerts : [];
  return card({
    title: 'Upozornění',
    icon: 'alert',
    subtitle: alerts.length ? count(alerts.length, 'položka vyžaduje pozornost', 'položky vyžadují pozornost', 'položek vyžaduje pozornost') : null,
    body: alerts.length
      ? h(
        'ul',
        { class: 'alert-list' },
        alerts.map((a) => {
          const [variant, ic] = ALERT_STYLE[a.type] || ['info', 'info'];
          return h(
            'li',
            { class: 'alert-' + variant },
            icon(ic, { size: 16 }),
            h('div', { style: 'flex:1;min-width:0' }, a.text),
            a.product_id ? h('a', { href: '#/produkty/' + encodeURIComponent(a.product_id), class: 'small nowrap' }, 'Detail') : null
          );
        })
      )
      : emptyState({ icon: 'check', title: 'Vše v pořádku', text: 'Žádné produkty pod nákupní cenou ani zastaralá data.', compact: true }),
  });
}

function competitorsCard(d) {
  const list = Array.isArray(d.competitors) ? d.competitors : [];
  return card({
    title: 'Konkurenti',
    icon: 'store',
    subtitle: 'Podíl nabídek, kde je konkurent levnější než my.',
    actions: [h('a', { href: '#/konkurence', class: 'btn btn-sm btn-ghost' }, 'Spravovat')],
    body: list.length
      ? barList(
        list.map((c) => ({ label: c.name, value: c.cheaper_than_us_pct ?? 0, display: c.cheaper_than_us_pct == null ? '–' : percent(c.cheaper_than_us_pct, 0), title: `${c.name}: ${int(c.offers)} nabídek, levnější u ${percent(c.cheaper_than_us_pct, 0)}` })),
        { max: 100, color: 'var(--s2)', ariaLabel: 'Podíl nabídek levnějších než naše cena' }
      )
      : emptyState({ icon: 'store', title: 'Žádná data o konkurenci', text: 'Importujte ceny konkurence – konkurenti se založí automaticky.', compact: true, actions: [h('a', { class: 'btn btn-sm', href: '#/import' }, 'Import cen')] }),
  });
}

function activityCard(d) {
  const run = d.last_run;
  const imports = Array.isArray(d.last_imports) ? d.last_imports : [];
  const runBody = run
    ? h(
      'div',
      { class: 'stack-sm' },
      h('div', { class: 'row-between' }, h('div', null, h('div', { class: 'strong' }, 'Běh #' + run.id + ' · ' + (TRIGGER_LABELS[run.trigger] || run.trigger || '')), h('div', { class: 'muted small', title: dateTime(run.started_at) }, relTime(run.started_at) + (run.finished_at ? ' · trval ' + duration(new Date(run.finished_at) - new Date(run.started_at)) : ''))), jobStatusBadge(run.status)),
      run.status === 'error' ? h('div', { class: 'callout callout-danger' }, icon('alert-circle', { size: 16 }), h('div', null, run.error || 'Běh skončil chybou.')) : h('div', { class: 'small' }, runSummaryText(run.stats))
    )
    : h('p', { class: 'muted' }, 'Přecenění zatím neproběhlo.');
  const importList = imports.length
    ? h(
      'ul',
      { class: 'list-plain' },
      imports.map((i) => {
        const st = statsList(i.stats).filter((x) => ['received', 'matched', 'unmatched', 'created', 'updated', 'errors'].includes(x.key) && x.value);
        return h(
          'li',
          null,
          jobStatusBadge(i.status),
          h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 'ellipsis' }, (KIND_LABELS[i.kind] || i.kind) + (i.format ? ' · ' + String(i.format).toUpperCase() : '') + (i.source_name ? ' · ' + i.source_name : '')), h('div', { class: 'muted small ellipsis' }, i.error || st.map((x) => x.label.toLowerCase() + ' ' + int(x.value)).join(', ') || '–')),
          h('span', { class: 'muted small nowrap', title: dateTime(i.started_at) }, relTime(i.started_at))
        );
      })
    )
    : h('p', { class: 'muted' }, 'Zatím žádné importy.');
  return card({
    title: 'Poslední aktivita',
    icon: 'clock',
    actions: [h('a', { href: '#/import?tab=log', class: 'btn btn-sm btn-ghost' }, 'Historie importů')],
    body: h('div', { class: 'stack' }, h('div', null, h('div', { class: 'form-subtitle' }, 'Přecenění'), runBody), h('div', null, h('div', { class: 'form-subtitle' }, 'Importy'), importList)),
  });
}

function manufacturerCard(d) {
  const rows = (Array.isArray(d.by_manufacturer) ? d.by_manufacturer : []).map((r, i) => ({ id: i, ...r }));
  return card({
    title: 'Podle výrobců',
    icon: 'layers',
    subtitle: 'Index = naše cena / nejnižší cena trhu × 100 (průměr za produkty s konkurencí).',
    flush: true,
    body: simpleTable(
      [
        { key: 'manufacturer', label: 'Výrobce', sortable: true, render: (r) => h('a', { href: buildHash('/produkty', { manufacturer: r.manufacturer }) }, r.manufacturer || '–') },
        { key: 'products', label: 'Produktů', format: 'int', sortable: true },
        { key: 'avg_index', label: 'Prům. index', format: 'index', sortable: true, render: (r) => h('span', { class: r.avg_index > 105 ? 'chg chg-down' : r.avg_index != null && r.avg_index <= 100 ? 'chg chg-up' : 'num' }, index(r.avg_index)) },
        { key: 'cheapest_pct', label: 'Nejlevnější', format: 'percent', sortable: true, title: 'Podíl produktů, kde jsme nejlevnější' },
        { key: 'avg_margin_pct', label: 'Prům. marže', format: 'percent', sortable: true },
      ],
      rows,
      { sort: { key: 'products', dir: 'desc' }, empty: () => emptyState({ title: 'Žádní výrobci', compact: true }) }
    ),
  });
}

export async function show(root, ctx) {
  ctx.setTitle('Přehled', '');
  const refreshBtn = button('Obnovit', { icon: 'refresh', variant: 'ghost', onClick: () => load() });
  ctx.setActions(refreshBtn);
  ctx.onChanged(() => load());

  async function load() {
    if (!root.firstChild) mount(root, h('div', { class: 'stack' }, skeletonBlocks(6, 92), h('div', { class: 'grid-2' }, skeletonBlocks(1, 160), skeletonBlocks(1, 160)), h('div', { class: 'card' }, skeletonTable(6, 5))));
    let d;
    try {
      d = await api.get('/dashboard', null, { signal: ctx.signal, silent: true });
    } catch (e) {
      if (isAbort(e)) return;
      mount(root, errorState(e, () => load()));
      return;
    }
    if (!d || !d.products || !d.products.active) {
      mount(root, onboarding());
      return;
    }
    const lastRun = d.last_run;
    ctx.setSub(lastRun ? 'Poslední přecenění ' + relTime(lastRun.started_at) : 'Přecenění zatím neproběhlo');
    mount(
      root,
      h(
        'div',
        { class: 'stack' },
        kpis(d),
        h('div', { class: 'grid-2' }, positionCard(d), alertsCard(d)),
        h('div', { class: 'grid-2' }, competitorsCard(d), activityCard(d)),
        manufacturerCard(d),
        d.proposals?.pending
          ? h('div', { class: 'callout callout-info' }, icon('info', { size: 16 }), h('div', { class: 'callout-body' }, 'Máte ' + count(d.proposals.pending, 'čekající návrh', 'čekající návrhy', 'čekajících návrhů') + ' cen. ', h('a', { href: '#/navrhy' }, 'Projít a schválit →')))
          : null
      )
    );
  }
  await load();
}
