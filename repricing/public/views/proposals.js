// Návrhy cen – filtry, tabulka staré → nové ceny, hromadné schválení/zamítnutí, schválení vše dle filtru,
// ruční úprava ceny v řádku, rozbalitelné vysvětlení, stažení XLSX.
import { h, mount, debounce } from '../lib/dom.js';
import { api, apiUrl, cachedGet, itemsOf, isAbort, bindDownload } from '../lib/api.js';
import { icon } from '../lib/icons.js';
import { DataTable } from '../lib/table.js';
import { emptyState, flagBadges, statusBadge, changeEl, segmented, searchInput, badge, callout, dl } from '../lib/ui.js';
import { explainList, priceMove } from '../lib/decision.js';
import {
  finalPrice, finalMargin, basePriceChange, basePrice, displayChange, staleProposals, isSelectableProposal, bulkStatus,
} from '../lib/proposal-model.js';
import { confirmDialog } from '../lib/modal.js';
import { toast } from '../lib/toast.js';
import {
  money, signedMoney, percent, int, count, FLAG_LABELS, parseInputNumber, relTime, dateTime,
} from '../lib/format.js';

export const title = 'Návrhy cen';

const STATUSES = [
  { value: 'pending', label: 'Čeká' },
  { value: 'approved', label: 'Schváleno' },
  { value: 'exported', label: 'Exportováno' },
  { value: 'rejected', label: 'Zamítnuto' },
  { value: 'superseded', label: 'Nahrazeno' },
  { value: 'all', label: 'Vše' },
];

/** „všech 5 …“ / „všechny 3 …“ / „1 …“ (shoda s číslovkou). */
function allOf(n) {
  return n === 1 ? '' : n >= 2 && n <= 4 ? 'všechny ' : 'všech ';
}

function prod(r) {
  return r.product || { code: r.code, name: r.name, manufacturer: r.manufacturer };
}

export async function show(root, ctx) {
  const q = ctx.query;
  const st = {
    status: q.status || 'pending',
    q: q.q || '',
    strategy: q.strategy || '',
    segment: q.segment || '',
    direction: q.direction || '',
    flag: q.flag || '',
    manufacturer: q.manufacturer || '',
    run: q.run || '',
    sort: q.sort || '',
    dir: q.dir || '',
    page: Math.max(1, Number(q.page) || 1),
    limit: Number(q.limit) || 50,
  };
  ctx.setTitle('Návrhy cen', '');
  let summary = null;
  let total = 0;
  let maxId = null; // nejvyšší id ve výpisu – „schválit vše“ ho posílá jako expect (seznam se mezitím nezměnil)
  let flagged = 0; // počet rizikových návrhů ve filtru (hromadné schválení je vynechá)
  let rows = [];
  let editing = null;

  const [strRes, segRes, facRes] = await Promise.allSettled([cachedGet('/strategies'), cachedGet('/segments'), cachedGet('/products/facets')]);
  if (ctx.signal.aborted) return;
  const strategies = strRes.status === 'fulfilled' ? itemsOf(strRes.value) : [];
  const segments = segRes.status === 'fulfilled' ? itemsOf(segRes.value) : [];
  const manufacturers = facRes.status === 'fulfilled' ? facRes.value?.manufacturers || [] : [];

  function filterParams() {
    return {
      status: st.status,
      q: st.q || null,
      strategy: st.strategy || null,
      segment: st.segment || null,
      direction: st.direction || null,
      flag: st.flag || null,
      manufacturer: st.manufacturer || null,
      run: st.run || null,
    };
  }
  function queryParams() {
    return { ...filterParams(), sort: st.sort || null, dir: st.dir || null, page: st.page, limit: st.limit };
  }

  const xlsxLink = bindDownload(h('a', { class: 'btn btn-ghost', download: '', dataset: { action: 'xlsx' } }, icon('download', { size: 16 }), h('span', { class: 'lbl' }, 'XLSX')));
  const approveAllBtn = h('button', { type: 'button', class: 'btn btn-success', dataset: { action: 'approve-all' }, onClick: () => decideAll('approve') }, icon('check', { size: 16 }), h('span', { class: 'lbl' }, 'Schválit vše dle filtru'));
  const rejectAllBtn = h('button', { type: 'button', class: 'btn btn-ghost', dataset: { action: 'reject-all' }, onClick: () => decideAll('reject') }, icon('x', { size: 16 }), h('span', { class: 'lbl' }, 'Zamítnout vše'));
  ctx.setActions(xlsxLink, rejectAllBtn, approveAllBtn);

  function updateActions() {
    xlsxLink.href = apiUrl('/export/proposals.xlsx', filterParams());
    xlsxLink.title = 'Stáhnout návrhy podle aktuálních filtrů jako XLSX';
    const canApprove = bulkStatus('approve', st.status) != null && total > 0;
    // contract-10: zamítnout hromadně jde i schválené (neexportované) – na záložce Schváleno
    const rejectSt = bulkStatus('reject', st.status);
    approveAllBtn.disabled = !canApprove;
    rejectAllBtn.disabled = !(rejectSt != null && total > 0);
    approveAllBtn.title = canApprove ? 'Schválit všechny čekající návrhy odpovídající filtru' : 'Hromadně lze schvalovat jen čekající návrhy';
    rejectAllBtn.title = rejectSt === 'approved' ? 'Zamítnout všechny schválené (neexportované) návrhy odpovídající filtru – neodejdou do adminu' : 'Zamítnout všechny čekající návrhy odpovídající filtru';
  }

  // --------------------------------------------------------------- akce
  function decidedToast(kind, n, res = {}) {
    const msg = (kind === 'approve' ? 'Schváleno: ' : 'Zamítnuto: ') + count(n, 'návrh', 'návrhy', 'návrhů');
    const skips = [
      [res.skipped_locked, 'zamčený produkt'],
      [res.skipped_inactive, 'neaktivní produkt'],
      [res.skipped_flagged, 'rizikový příznak – schvalte jednotlivě'],
    ].filter(([v]) => Number(v) > 0).map(([v, why]) => count(Number(v), 'návrh přeskočen', 'návrhy přeskočeny', 'návrhů přeskočeno') + ' (' + why + ')');
    if (skips.length) toast(msg + ' · ' + skips.join(' · '), { type: n ? 'warning' : 'error' });
    else toast(msg, { type: n ? 'success' : 'info' });
  }

  /**
   * contract-2: schvalování návrhů, které vznikly při jiné ceně produktu (import katalogu, ruční změna ceny) –
   * exportovala by se cena spočítaná ze staré ceny. Vrací true, když uživatel přesto pokračuje (nebo nic takového není).
   */
  async function confirmStale(list) {
    const stale = staleProposals(list);
    if (!stale.length) return true;
    const ex = stale.slice(0, 3).map((r) => {
      const ch = basePriceChange(r);
      return h('li', null, h('span', { class: 'mono' }, prod(r).code || '#' + r.product_id), ': návrh ze ', money(ch.from), ', teď ', money(ch.to), ' → k exportu ', money(finalPrice(r)));
    });
    return confirmDialog({
      title: 'Cena produktu se od návrhu změnila',
      message: h(
        'div',
        null,
        h('p', null, count(stale.length, 'návrh vznikl', 'návrhy vznikly', 'návrhů vzniklo') + ' při jiné ceně produktu, než je teď (import katalogu nebo ruční změna). Schválením se exportuje cena spočítaná ze staré ceny.'),
        h('ul', { class: 'validation-list' }, ex),
        h('p', { class: 'muted small' }, 'Doporučujeme tyto produkty nejdřív přecenit znovu.')
      ),
      confirmLabel: 'Přesto schválit',
      danger: true,
    });
  }

  async function decide(kind, ids) {
    if (!ids.length) return;
    if (kind === 'approve') {
      const idSet = new Set(ids.map(String));
      if (!(await confirmStale(rows.filter((r) => idSet.has(String(r.id)) && r.status === 'pending')))) return;
    }
    try {
      const res = await api.post('/proposals/' + kind, { ids });
      const n = res?.updated ?? ids.length;
      decidedToast(kind, n, res || {});
      table.clearSelection();
      ctx.notifyChanged('proposals');
    } catch {
      /* toast */
    }
    load();
  }

  async function decideAll(kind) {
    const target = bulkStatus(kind, st.status);
    if (!target) return;
    // přesný počet známe, jen když výpis ukazuje právě cílový stav (jinak souhrn stavu – bez ostatních filtrů)
    const exact = st.status === target;
    const n = exact ? total : summary?.[target] ?? total;
    const what = target === 'approved'
      ? count(n, 'schválený (neexportovaný) návrh', 'schválené (neexportované) návrhy', 'schválených (neexportovaných) návrhů')
      : count(n, 'čekající návrh', 'čekající návrhy', 'čekajících návrhů');
    const pageStale = kind === 'approve' ? staleProposals(rows).length : 0;
    const ok = await confirmDialog({
      title: kind === 'approve' ? 'Schválit vše dle filtru' : 'Zamítnout vše dle filtru',
      message: h(
        'div',
        null,
        h('p', null, (kind === 'approve' ? 'Schválit ' : 'Zamítnout ') + (exact ? allOf(n) + what : 'všechny ' + (target === 'approved' ? 'schválené' : 'čekající') + ' návrhy') + ' odpovídající aktuálnímu filtru?'),
        kind === 'approve' ? h('p', { class: 'muted small' }, 'Schválené ceny se objeví v exportu (feed, webhook, POHODA XML).') : null,
        kind === 'approve' && flagged > 0 ? h('p', { class: 'muted small' }, count(flagged, 'návrh s rizikovým příznakem se přeskočí', 'návrhy s rizikovým příznakem se přeskočí', 'návrhů s rizikovým příznakem se přeskočí') + ' (pod nákupem, velká změna, ruční cena mimo meze…) – schvalte je jednotlivě.') : null,
        pageStale ? callout(count(pageStale, 'návrh na této stránce vznikl', 'návrhy na této stránce vznikly', 'návrhů na této stránce vzniklo') + ' při jiné ceně produktu, než je teď – schválením se exportuje cena ze staré ceny. Doporučujeme je nejdřív přecenit.', 'warning') : null,
        target === 'approved' ? h('p', { class: 'muted small' }, 'Zamítnuté návrhy se neodešlou do adminu (feed, webhook, POHODA).') : null
      ),
      confirmLabel: kind === 'approve' ? 'Schválit ' + (exact ? int(n) : 'vše') : 'Zamítnout',
      danger: kind === 'reject' || pageStale > 0,
    });
    if (!ok) return;
    const filter = filterParams();
    // Hromadně jen cílový stav (API by při zamítnutí bez stavu zamítlo čekající i schválené).
    filter.status = target;
    for (const k of Object.keys(filter)) if (filter[k] == null) delete filter[k];
    const body = { all: true, filter };
    // Výpis ukazoval přesně tento výběr → server ověří, že se mezitím nezměnil (nové přecenění, jiný uživatel)
    if (exact) body.expect = { count: total, max_id: maxId };
    try {
      const res = await api.post('/proposals/' + kind, body);
      decidedToast(kind, res?.updated ?? 0, res || {});
      ctx.notifyChanged('proposals');
    } catch {
      /* toast (409 = seznam se změnil → obnoví se níže) */
    }
    load();
  }

  async function saveManual(r, value) {
    const v = value === '' ? null : parseInputNumber(value);
    if (v != null && (Number.isNaN(v) || v <= 0)) {
      toast('Zadejte kladnou cenu, nebo pole vymažte pro zrušení ruční ceny.', { type: 'error' });
      return false;
    }
    const url = '/proposals/' + encodeURIComponent(r.id);
    const wasApproved = r.status === 'approved';
    let upd;
    try {
      upd = await api.patch(url, { manual_price: v }, { silent: true });
    } catch (e) {
      // contract-12: riziková ruční cena (pod nákupem, mimo min./max. produktu, velká změna – překlep?) vyžaduje potvrzení
      if (e?.status === 409 && e.details?.code === 'MANUAL_PRICE_CONFIRM') {
        const reasons = Array.isArray(e.details.reasons) ? e.details.reasons : [];
        const ok = await confirmDialog({
          title: 'Zkontrolujte ruční cenu',
          message: h(
            'div',
            null,
            h('p', null, 'Ruční cena ', h('b', null, money(v)), ' pro ', h('span', { class: 'mono' }, prod(r).code || '#' + r.product_id), ' je neobvyklá:'),
            reasons.length ? h('ul', { class: 'validation-list' }, reasons.map((t) => h('li', null, t))) : null,
            h('p', { class: 'muted small' }, 'Nejde o překlep? Po uložení dostane návrh příznak' + (wasApproved ? ' a vrátí se ke schválení.' : '.'))
          ),
          confirmLabel: 'Uložit i tak',
          danger: true,
        });
        if (!ok) return false;
        try {
          upd = await api.patch(url, { manual_price: v, confirm: true });
        } catch {
          return false;
        }
      } else {
        toast(e?.message || 'Ruční cenu se nepodařilo uložit.', { type: 'error' });
        return false;
      }
    }
    Object.assign(r, upd && typeof upd === 'object' ? upd : { manual_price: v });
    if (upd && !upd.product && r.product == null) r.product = prod(r);
    const reopened = wasApproved && r.status === 'pending';
    toast((v == null ? 'Ruční cena zrušena' : 'Ruční cena uložena: ' + money(v)) + (reopened ? ' · návrh se vrátil ke schválení' : ''), { type: reopened ? 'warning' : 'success' });
    if (reopened) ctx.notifyChanged('proposals');
    return true;
  }

  // --------------------------------------------------------------- tabulka
  function priceCell(r) {
    const eff = finalPrice(r);
    const editable = r.status === 'pending' || r.status === 'approved';
    if (editing === r.id) {
      const inp = h('input', { type: 'text', inputmode: 'decimal', class: 'input input-num', value: String(eff ?? '').replace('.', ','), 'aria-label': 'Ruční cena pro ' + (prod(r).code || '') });
      const done = async (save) => {
        if (save) {
          const ok = await saveManual(r, inp.value.trim());
          if (!ok) return;
        }
        editing = null;
        table.setData(rows, { total, page: st.page, limit: st.limit });
        table.el.querySelector(`tr[data-key="${r.id}"] .price-edit`)?.focus();
      };
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          done(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          done(false);
        }
      });
      setTimeout(() => {
        inp.focus();
        inp.select();
      }, 0);
      return h(
        'span',
        { class: 'inline-edit' },
        inp,
        h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Uložit ruční cenu', onClick: () => done(true) }, icon('check', { size: 15 })),
        h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Zrušit úpravu', onClick: () => done(false) }, icon('x', { size: 15 }))
      );
    }
    const content = [h('span', null, money(eff))];
    if (r.manual_price != null) content.push(badge('ručně', 'info', 'Ruční cena – exportuje se místo navržené ' + money(r.new_price)));
    if (!editable) return h('span', { class: 'num strong' }, content);
    return h(
      'button',
      {
        type: 'button',
        class: 'price-edit',
        title: 'Upravit cenu ručně (Enter uloží, Esc zruší; prázdné pole ruční cenu zruší)',
        onClick: () => {
          editing = r.id;
          table.setData(rows, { total, page: st.page, limit: st.limit });
        },
      },
      content,
      icon('edit', { size: 13 })
    );
  }

  const columns = [
    {
      key: 'product',
      label: 'Produkt',
      sortKey: 'code',
      render: (r) => {
        const p = prod(r);
        return h('div', { class: 'cell-2' }, h('a', { href: '#/produkty/' + encodeURIComponent(r.product_id), class: 'cell-name', style: 'max-width:220px', title: p.name }, p.name || p.code || '#' + r.product_id), h('span', { class: 'cell-sub ellipsis', style: 'max-width:220px' }, h('span', { class: 'mono' }, p.code || ''), p.manufacturer ? ' · ' + p.manufacturer : ''));
      },
    },
    { key: 'strategy_name', label: 'Strategie', hideSm: true, hideLg: true, render: (r) => h('div', { class: 'cell-2' }, h('span', { class: 'ellipsis', style: 'max-width:190px' }, r.strategy_name || '–'), r.segment_name ? h('span', { class: 'cell-sub ellipsis', style: 'max-width:190px' }, r.segment_name) : null) },
    {
      key: 'old_price',
      label: 'Stará cena',
      title: 'Cena, ze které se vychází (aktuální cena produktu; když se od vzniku návrhu změnila, je označená)',
      align: 'right',
      sortable: true,
      render: (r) => {
        // contract-2: cena produktu se od vzniku návrhu změnila (import katalogu, ruční změna) → ukázat aktuální a označit
        const ch = basePriceChange(r);
        if (!ch) return h('span', { class: 'num' }, money(r.old_price));
        const tip = 'Cena produktu se od návrhu změnila: ' + money(ch.from) + ' → ' + money(ch.to) + (ch.taken ? ' (už odpovídá ceně k exportu).' : '. Návrh vychází ze staré ceny – doporučujeme produkt přecenit znovu.');
        return h(
          'div',
          { class: 'cell-2', style: 'align-items:flex-end', dataset: { stale: ch.taken ? 'taken' : '1' }, title: tip },
          h('span', { class: 'num' }, money(ch.to)),
          h('span', { class: 'cell-sub' }, badge(ch.taken ? 'cena převzata' : 'cena se změnila', ch.taken ? 'info' : 'warning', tip), ' návrh ze ', money(ch.from))
        );
      },
    },
    { key: 'new_price', label: 'Nová cena', title: 'Cena k exportu (ruční cena má přednost před navrženou)', align: 'right', sortKey: 'final_price', render: priceCell },
    {
      key: 'change_pct',
      label: 'Změna',
      align: 'right',
      sortable: true,
      defaultDesc: true,
      render: (r) => {
        // změna, kterou schválení opravdu udělá – proti aktuální ceně produktu (contract-2)
        const d = displayChange(r);
        return h('div', { class: 'cell-2', style: 'align-items:flex-end' }, changeEl(d.pct), d.abs != null ? h('span', { class: 'cell-sub num' }, signedMoney(d.abs)) : null);
      },
    },
    {
      key: 'margin_after',
      label: 'Marže',
      title: 'Marže po změně (pod ní marže před změnou)',
      align: 'right',
      sortable: true,
      render: (r) => {
        const after = finalMargin(r);
        return h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: after != null && after < 0 ? 'chg chg-down' : 'num strong' }, percent(after)), h('span', { class: 'cell-sub num' }, 'z ' + percent(r.margin_before)));
      },
    },
    { key: 'market_min', label: 'Min. trh', align: 'right', hideSm: true, render: (r) => h('div', { class: 'cell-2', style: 'align-items:flex-end' }, h('span', { class: 'num' }, money(r.market_min)), r.competitor_count != null ? h('span', { class: 'cell-sub' }, count(r.competitor_count, 'konkurent', 'konkurenti', 'konkurentů')) : null) },
    { key: 'rank', label: 'Pořadí', align: 'center', hideSm: true, hideLg: true, title: 'Pořadí mezi konkurenty před → po (1 = nejlevnější)', render: (r) => h('span', { class: 'num' }, (r.rank_before ?? '–') + ' → ' + (r.rank_after ?? '–')) },
    { key: 'flags', label: 'Příznaky', render: (r) => flagBadges(r.flags) },
    { key: 'status', label: 'Stav', class: 'col-status', render: (r) => statusBadge(r.status) },
    {
      key: 'actions',
      label: 'Akce',
      align: 'right',
      render: (r) => {
        const decided = r.decided_at ? h('span', { class: 'muted small nowrap', title: dateTime(r.decided_at) + (r.decided_by ? ' · ' + r.decided_by : '') }, relTime(r.decided_at)) : null;
        if (r.status === 'pending') {
          return h(
            'span',
            { class: 'row-actions' },
            h('button', { type: 'button', class: 'btn-icon approve', 'aria-label': 'Schválit návrh ' + (prod(r).code || ''), title: 'Schválit', dataset: { action: 'approve-row' }, onClick: () => decide('approve', [r.id]) }, icon('check', { size: 16 })),
            h('button', { type: 'button', class: 'btn-icon reject', 'aria-label': 'Zamítnout návrh ' + (prod(r).code || ''), title: 'Zamítnout', dataset: { action: 'reject-row' }, onClick: () => decide('reject', [r.id]) }, icon('x', { size: 16 }))
          );
        }
        if (r.status === 'approved') {
          // contract-10: omylem schválený (i automaticky) návrh jde vrátit zamítnutím, dokud není exportovaný
          return h(
            'span',
            { class: 'row-actions' },
            decided,
            h('button', {
              type: 'button', class: 'btn-icon reject', 'aria-label': 'Zamítnout schválený návrh ' + (prod(r).code || ''), title: 'Zamítnout – zrušit schválení (neodejde do adminu)', dataset: { action: 'reject-approved-row' },
              onClick: async () => {
                const ok = await confirmDialog({ title: 'Zamítnout schválený návrh', message: 'Zrušit schválení návrhu ' + (prod(r).code || '#' + r.product_id) + ' (' + money(finalPrice(r)) + ')? Cena se neodešle do adminu; nový návrh vznikne při dalším přecenění.', confirmLabel: 'Zamítnout', danger: true });
                if (ok) decide('reject', [r.id]);
              },
            }, icon('x', { size: 16 }))
          );
        }
        return decided || '';
      },
    },
  ];

  const bulkCount = h('span', { class: 'strong' });
  // vybrané mohou být i schválené (jen k zamítnutí) – schválit má smysl jen čekající
  const approveSelBtn = h('button', { type: 'button', class: 'btn btn-sm btn-success', dataset: { action: 'approve-selected' }, onClick: () => decide('approve', [...table.selected]) }, icon('check', { size: 14 }), h('span', null, 'Schválit vybrané'));
  const bulkbar = h(
    'div',
    { class: 'bulkbar', hidden: true, role: 'region', 'aria-label': 'Hromadné akce' },
    bulkCount,
    approveSelBtn,
    h('button', { type: 'button', class: 'btn btn-sm btn-danger', dataset: { action: 'reject-selected' }, onClick: () => decide('reject', [...table.selected]) }, icon('x', { size: 14 }), h('span', null, 'Zamítnout vybrané')),
    h('button', { type: 'button', class: 'btn btn-sm btn-ghost', onClick: () => table.clearSelection() }, 'Zrušit výběr')
  );

  const table = new DataTable({
    columns,
    rowKey: 'id',
    selectable: true,
    isSelectable: isSelectableProposal, // contract-10: i schválené (neexportované) – k zamítnutí
    expandable: (r) =>
      h(
        'div',
        { class: 'grid-main-side' },
        h('div', null, h('div', { class: 'form-subtitle' }, 'Proč tato cena'), explainList(r.explain)),
        h(
          'div',
          null,
          h('div', { class: 'form-subtitle' }, 'Detail'),
          dl([
            ['Cena k exportu', priceMove(basePrice(r), finalPrice(r))],
            basePriceChange(r) ? ['Cena při vzniku návrhu', h('span', null, money(r.old_price), ' ', badge('cena produktu se od návrhu změnila', 'warning'))] : null,
            r.manual_price != null ? ['Navržená cena', money(r.new_price) + ' (nahrazena ruční cenou)'] : null,
            ['Cílová cena', money(r.target_price)],
            ['Reference', money(r.reference_price)],
            ['Nákup bez DPH', money(prod(r).purchase_price ?? r.purchase_price)],
            ['Sklad', int(prod(r).stock)],
            ['Nejlevnější konkurent', r.cheapest_competitor ? r.cheapest_competitor + ' · ' + money(r.market_min) : money(r.market_min)],
            ['Vytvořeno', dateTime(r.created_at)],
            r.exported_at ? ['Exportováno', dateTime(r.exported_at) + (r.export_id ? ' (export #' + r.export_id + ')' : '')] : null,
          ]),
          h('div', { class: 'row', style: 'margin-top:10px' }, h('a', { class: 'btn btn-sm', href: '#/produkty/' + encodeURIComponent(r.product_id) }, 'Detail produktu'))
        )
      ),
    onSelectionChange: (keys) => {
      bulkbar.hidden = !keys.length;
      bulkCount.textContent = 'Vybráno: ' + count(keys.length, 'návrh', 'návrhy', 'návrhů');
      const sel = new Set(keys.map(String));
      approveSelBtn.disabled = !rows.some((r) => sel.has(String(r.id)) && r.status === 'pending');
    },
    pagination: true,
    page: st.page,
    limit: st.limit,
    sort: st.sort ? { key: st.sort, dir: st.dir || 'asc' } : null,
    onSort: (s) => {
      st.sort = s.key;
      st.dir = s.dir;
      st.page = 1;
      load();
    },
    onPage: (p, l) => {
      st.page = p;
      st.limit = l;
      load();
    },
    caption: 'Návrhy cen',
    empty: () => {
      if (st.status === 'pending' && !st.q && !st.strategy && !st.segment && !st.direction && !st.flag && !st.manufacturer) {
        return emptyState({
          icon: 'check',
          title: 'Žádné čekající návrhy',
          text: 'Všechno je vyřízeno. Nové návrhy vzniknou po přecenění – spusťte ho tlačítkem nahoře nebo nastavte automatické přecenění.',
          actions: [h('button', { type: 'button', class: 'btn btn-primary', onClick: () => ctx.runPricing() }, icon('play', { size: 14 }), h('span', null, 'Spustit přecenění')), h('a', { class: 'btn', href: '#/export' }, 'Export schválených')],
        });
      }
      return emptyState({ icon: 'filter', title: 'Žádné návrhy neodpovídají filtru', text: 'Zkuste jiný stav nebo filtr.', compact: true });
    },
  });

  // --------------------------------------------------------------- filtry
  const statusCtl = segmented(STATUSES, st.status, (v) => {
    st.status = v;
    st.page = 1;
    table.clearSelection();
    load();
  }, { label: 'Stav návrhu' });
  const onSearch = debounce(() => {
    st.page = 1;
    load();
  }, 280);
  const sel = (key, label, options) => {
    const s = h('select', {
      class: 'select', 'aria-label': label,
      onChange: (e) => {
        st[key] = e.target.value;
        st.page = 1;
        load();
      },
    }, h('option', { value: '' }, label + ': vše'), options.map((o) => h('option', { value: String(o.value) }, o.label)));
    s.value = st[key];
    return s;
  };
  const filtersToggle = h('button', {
    type: 'button', class: 'btn filters-toggle', 'aria-expanded': 'false',
    onClick: () => { toolbar.classList.toggle('is-open'); filtersToggle.setAttribute('aria-expanded', toolbar.classList.contains('is-open') ? 'true' : 'false'); },
  }, icon('filter', { size: 16 }), h('span', null, 'Filtry'));
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchInput(st.q, (v) => {
      st.q = v;
      onSearch();
    }, { placeholder: 'Kód, název nebo EAN…', ariaLabel: 'Hledat návrhy' }),
    filtersToggle,
    h('span', { class: 'toolbar-more' },
      sel('strategy', 'Strategie', strategies.map((s) => ({ value: s.id, label: s.name }))),
      sel('segment', 'Segment', segments.map((s) => ({ value: s.id, label: s.name }))),
      sel('direction', 'Směr', [{ value: 'up', label: '▲ Zdražení' }, { value: 'down', label: '▼ Zlevnění' }]),
      sel('flag', 'Příznak', Object.entries(FLAG_LABELS).map(([k, v]) => ({ value: k, label: v }))),
      sel('manufacturer', 'Výrobce', manufacturers.map((m) => ({ value: m.value, label: `${m.value} (${int(m.count)})` }))))
  );
  const summaryEl = h('div', { class: 'row small muted', style: 'margin:-4px 0 10px' });
  const runNote = h('div');
  const staleNote = h('div', { dataset: { role: 'stale-note' } });

  mount(root, h('div', { class: 'stack-sm' }, h('div', { class: 'row-between', style: 'margin-bottom:8px' }, statusCtl), toolbar, runNote, summaryEl, staleNote, h('div', { class: 'card' }, table.el), bulkbar));

  function renderSummary() {
    if (!summary) return mount(summaryEl);
    mount(
      summaryEl,
      h('span', null, count(total, 'návrh', 'návrhy', 'návrhů') + ' ve filtru'),
      h('span', { class: 'chg chg-up' }, '▲ ' + int(summary.up) + ' zdražení'),
      h('span', { class: 'chg chg-down' }, '▼ ' + int(summary.down) + ' zlevnění'),
      h('span', null, '· celkem čeká ' + int(summary.pending) + ', schváleno ' + int(summary.approved) + ', dnes exportováno ' + int(summary.exported_today))
    );
    ctx.setSub(int(summary.pending) + ' čeká na schválení · ' + int(summary.approved) + ' schváleno k exportu');
    // contract-2: návrhy ze staré ceny produktu – upozornit a nabídnout přecenění těchto produktů
    const stale = staleProposals(rows);
    mount(
      staleNote,
      stale.length
        ? callout(h('span', null, count(stale.length, 'návrh na této stránce vznikl', 'návrhy na této stránce vznikly', 'návrhů na této stránce vzniklo') + ' při jiné ceně produktu, než je teď (import katalogu nebo ruční změna ceny) – změna v % je přepočtená na aktuální cenu. ',
          h('button', {
            type: 'button', class: 'btn btn-xs', dataset: { action: 'reprice-stale' },
            onClick: async () => {
              const res = await ctx.runPricing({ productIds: [...new Set(stale.map((r) => Number(r.product_id)))] });
              if (res) load();
            },
          }, 'Přecenit tyto produkty')), 'warning')
        : null
    );
  }

  if (st.run) mount(runNote, callout(h('span', null, 'Zobrazeny návrhy z běhu #' + st.run + '. ', h('button', { type: 'button', class: 'btn btn-xs', onClick: () => { st.run = ''; mount(runNote); load(); } }, 'Zobrazit všechny')), 'info'));

  let seq = 0;
  async function load() {
    const my = ++seq;
    ctx.setQuery({ ...queryParams(), status: st.status !== 'pending' ? st.status : null, page: st.page > 1 ? st.page : null, limit: st.limit !== 50 ? st.limit : null });
    updateActions();
    table.setLoading(true);
    try {
      const res = await api.get('/proposals', queryParams(), { signal: ctx.signal, silent: true });
      if (my !== seq) return;
      rows = itemsOf(res);
      total = res.total ?? rows.length;
      maxId = res.max_id ?? null;
      flagged = Number(res.flagged) || 0;
      summary = res.summary || null;
      editing = null;
      table.el.classList.toggle('hide-status', st.status === 'pending');
      table.setData(rows, { total, page: res.page, limit: res.limit });
      renderSummary();
      updateActions();
    } catch (e) {
      if (isAbort(e) || my !== seq) return;
      table.setError(e, () => load());
    }
  }
  ctx.onChanged((what) => {
    if (what !== 'proposals') load();
  });
  await load();
}
