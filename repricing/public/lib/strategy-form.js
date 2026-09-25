// Formulář konfigurace strategie – všechny volby SPEC §6.5 ve skupinách
// Cíl ceny / Konkurence / Limity a marže / Zaokrouhlení / Sklad / Schvalování, s nápovědou u každé volby.
import { h, mount } from './dom.js';
import { icon } from './icons.js';
import { field, numberInput, select, switchEl, withSuffix, segmented, card } from './ui.js';
import { chipsInput } from './chips.js';
import { parseInputNumber, money } from './format.js';
import {
  mergeConfig, getPath, setPath, HELP, TARGET_MODES, TARGET_MODE_MAP, FALLBACK_MODES, ZERO_STOCK_MODES, ROUNDING_MODES,
  ROUNDING_DIRECTIONS, roundingExamples, stepFor,
} from './strategy-model.js';

/**
 * @param {{config?: object, competitors?: {name: string, label?: string, tags?: string[]}[], onChange?: (config: object) => void}} o
 * @returns {{el: HTMLElement, getConfig: () => object, sections: Record<string, HTMLElement>}}
 */
export function strategyForm(o) {
  const cfg = mergeConfig(o.config || {});
  const competitors = o.competitors || [];
  const compNames = competitors.map((c) => ({ value: c.name, label: c.label ? c.label + ' (' + c.name + ')' : c.name }));
  const tagSet = new Set(['klíčový', 'marketplace']);
  for (const c of competitors) for (const t of c.tags || []) tagSet.add(t);
  const tagList = [...tagSet].map((t) => ({ value: t, label: t }));

  const emit = () => {
    refreshVisibility();
    if (o.onChange) o.onChange(JSON.parse(JSON.stringify(cfg)));
  };

  // ------------------------------------------------ pomocníci polí
  function num(path, label, opts = {}) {
    const nullable = opts.nullable !== false;
    const inp = numberInput(getPath(cfg, path), { placeholder: opts.placeholder ?? (nullable ? 'bez limitu' : ''), size: 7 });
    inp.dataset.path = path;
    inp.addEventListener('input', () => {
      const v = parseInputNumber(inp.value);
      const bad = Number.isNaN(v) || (v == null && !nullable) || (opts.int && v != null && !Number.isInteger(v)) || (opts.min != null && v != null && v < opts.min);
      inp.classList.toggle('is-invalid', Boolean(bad));
      inp.setAttribute('aria-invalid', bad ? 'true' : 'false');
      if (bad) return;
      setPath(cfg, path, v == null ? (opts.emptyValue ?? null) : v);
      emit();
    });
    return field({ label, control: withSuffix(inp, opts.suffix), input: inp, help: opts.help ?? HELP[path], class: 'field-num' });
  }

  function toggle(path, label, opts = {}) {
    const sw = switchEl({
      checked: Boolean(getPath(cfg, path)),
      label,
      onChange: (v) => {
        setPath(cfg, path, v);
        emit();
      },
    });
    const btn = sw.querySelector ? sw.querySelector('[role=switch]') || sw : sw;
    btn.dataset.path = path;
    return h('div', { class: 'field field-switch' }, sw, h('div', { class: 'field-help' }, opts.help ?? HELP[path]));
  }

  function choice(path, label, options, opts = {}) {
    const sel = select(options.map((x) => ({ value: x.value, label: x.label })), getPath(cfg, path), {
      onChange: (e) => {
        setPath(cfg, path, e.target.value);
        emit();
      },
    });
    sel.dataset.path = path;
    return field({ label, control: sel, help: opts.help ?? HELP[path] });
  }

  function chips(path, label, suggestions, opts = {}) {
    const c = chipsInput({
      values: getPath(cfg, path) || [],
      suggestions,
      placeholder: opts.placeholder || 'Vyberte…',
      onChange: (v) => {
        setPath(cfg, path, v);
        emit();
      },
    });
    c.input.dataset.path = path;
    return field({ label, control: c.el, input: c.input, help: HELP[path] });
  }

  // ------------------------------------------------ Cíl ceny
  const modeHelp = h('p', { class: 'mode-help' });
  const example = h('p', { class: 'mode-example' });
  const modeSel = select(TARGET_MODES.map((m) => ({ value: m.value, label: m.label })), cfg.target.mode, {
    onChange: (e) => {
      cfg.target.mode = e.target.value;
      emit();
    },
  });
  modeSel.dataset.path = 'target.mode';
  const tOffsetPct = num('target.offset_pct', 'Posun v %', { nullable: false, suffix: '%', placeholder: '0', emptyValue: 0 });
  const tOffsetAbs = num('target.offset_abs', 'Posun v Kč', { nullable: false, suffix: 'Kč', placeholder: '0', emptyValue: 0 });
  const tRank = num('target.rank', 'Pozice', { nullable: false, int: true, min: 1, placeholder: '1' });
  const compSel = select(compNames, cfg.target.competitor, {
    placeholder: '— vyberte konkurenta —',
    onChange: (e) => {
      cfg.target.competitor = e.target.value || null;
      emit();
    },
  });
  if (cfg.target.competitor && !compNames.some((c) => c.value === cfg.target.competitor)) {
    compSel.appendChild(h('option', { value: cfg.target.competitor }, cfg.target.competitor));
    compSel.value = cfg.target.competitor;
  }
  compSel.dataset.path = 'target.competitor';
  const tCompetitor = field({ label: 'Konkurent', control: compSel, help: HELP['target.competitor'] });
  const tMarkup = num('target.markup_pct', 'Přirážka', { suffix: '%', placeholder: 'např. 40' });
  const tFixed = num('target.fixed_price', 'Pevná cena', { suffix: 'Kč', placeholder: 'např. 9 990' });
  const presetsRow = h(
    'div',
    { class: 'quick-offsets' },
    h('span', { class: 'muted' }, 'Rychlá volba:'),
    [[-1, 0, '−1 %'], [-2, 0, '−2 %'], [0, -1, '−1 Kč'], [0, -10, '−10 Kč'], [0, 0, 'bez posunu']].map(([p, a, l]) =>
      h('button', {
        type: 'button', class: 'btn btn-xs',
        onClick: () => {
          cfg.target.offset_pct = p;
          cfg.target.offset_abs = a;
          tOffsetPct.querySelector('input').value = String(p).replace('.', ',');
          tOffsetAbs.querySelector('input').value = String(a).replace('.', ',');
          emit();
        },
      }, l)
    )
  );
  const targetSection = card({
    title: 'Cíl ceny',
    icon: 'target',
    subtitle: 'Od jaké ceny se odvíjí nová cena.',
    class: 'form-section',
    dataset: { section: 'target' },
    body: [
      field({ label: 'Režim', control: modeSel }),
      modeHelp,
      h('div', { class: 'form-grid' }, tOffsetPct, tOffsetAbs, tRank, tCompetitor, tMarkup, tFixed),
      presetsRow,
      example,
    ],
  });

  // ------------------------------------------------ Konkurence
  const fbMarkup = num('fallback.markup_pct', 'Přirážka (náhradní režim)', { suffix: '%', placeholder: 'např. 30' });
  const fbOffset = num('fallback.offset_pct', 'Posun od MOC', { nullable: false, suffix: '%', placeholder: '0', emptyValue: 0 });
  const marketNote = h('div', { class: 'callout callout-info section-note' }, icon('info', { size: 16 }), h('div', null, 'Zvolený režim cíle konkurenci nepoužívá – tato nastavení se uplatní jen při změně režimu.'));
  const compSection = card({
    title: 'Konkurence',
    icon: 'store',
    subtitle: 'Které nabídky se započítají do trhu a co dělat, když trh chybí.',
    class: 'form-section',
    dataset: { section: 'competitors' },
    body: [
      marketNote,
      h(
        'div',
        { class: 'form-grid form-grid-2' },
        chips('competitors.include', 'Jen tito konkurenti', compNames, { placeholder: 'všichni zapnutí' }),
        chips('competitors.exclude', 'Ignorovat konkurenty', compNames, { placeholder: 'nikdo' }),
        chips('competitors.include_tags', 'Jen se štítky', tagList, { placeholder: 'bez omezení' }),
        chips('competitors.exclude_tags', 'Vyloučit štítky', tagList, { placeholder: 'žádné' })
      ),
      h('div', { class: 'form-grid form-grid-2' }, toggle('competitors.in_stock_only', 'Jen nabídky skladem'), toggle('competitors.include_shipping', 'Počítat s dopravou')),
      h(
        'div',
        { class: 'form-grid' },
        num('competitors.min_competitors', 'Min. počet konkurentů', { nullable: false, int: true, min: 1, placeholder: '1' }),
        num('competitors.max_age_days', 'Max. stáří ceny', { int: true, min: 1, suffix: 'dní', placeholder: 'z nastavení' }),
        num('competitors.outlier_pct', 'Vyřadit podezřele nízké', { suffix: '%', placeholder: 'vypnuto' })
      ),
      h('h3', { class: 'form-subtitle' }, 'Když konkurence chybí'),
      h('div', { class: 'form-grid' }, choice('fallback.mode', 'Náhradní režim', FALLBACK_MODES), fbMarkup, fbOffset),
      h('p', { class: 'field-help fb-mode-help' }),
    ],
  });

  // ------------------------------------------------ Limity a marže
  const limitsSection = card({
    title: 'Limity a marže',
    icon: 'lock',
    subtitle: 'Pojistky, které platí vždy – spodní hranice má přednost před vším ostatním.',
    class: 'form-section',
    dataset: { section: 'limits' },
    body: [
      h('h3', { class: 'form-subtitle' }, 'Spodní a horní hranice'),
      h(
        'div',
        { class: 'form-grid' },
        num('limits.min_margin_pct', 'Minimální marže', { suffix: '%', placeholder: 'bez limitu' }),
        num('limits.min_profit_abs', 'Minimální zisk / ks', { suffix: 'Kč' }),
        num('limits.max_margin_pct', 'Maximální marže', { suffix: '%' }),
        num('limits.max_above_msrp_pct', 'Max. nad MOC', { suffix: '%', placeholder: 'MOC neomezuje' }),
        num('limits.max_below_msrp_pct', 'Max. pod MOC', { suffix: '%' })
      ),
      toggle('limits.respect_product_limits', 'Dodržet min./max. cenu produktu'),
      h('h3', { class: 'form-subtitle' }, 'Změna za jedno přecenění'),
      h('div', { class: 'form-grid form-grid-2' }, toggle('limits.allow_decrease', 'Povolit zlevňování'), toggle('limits.allow_increase', 'Povolit zdražování')),
      h(
        'div',
        { class: 'form-grid' },
        num('limits.max_decrease_pct', 'Max. snížení', { suffix: '%' }),
        num('limits.max_increase_pct', 'Max. zvýšení', { suffix: '%' }),
        num('limits.min_change_pct', 'Ignorovat změny pod', { suffix: '%', placeholder: '0', nullable: false, emptyValue: 0 }),
        num('limits.min_change_abs', 'nebo pod', { suffix: 'Kč', placeholder: '0', nullable: false, emptyValue: 0, help: HELP['limits.min_change_abs'] })
      ),
    ],
  });

  // ------------------------------------------------ Zaokrouhlení
  const bandsBody = h('tbody');
  const bandsTable = h(
    'table',
    { class: 'table table-dense bands-table' },
    h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Do ceny (Kč)'), h('th', { scope: 'col' }, 'Konec'), h('th', { scope: 'col' }, 'Krok'), h('th', { scope: 'col' }, 'Příklad'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Akce')))),
    bandsBody
  );
  const examplesEl = h('div', { class: 'round-examples' });
  function renderBands() {
    const bands = cfg.rounding.bands || (cfg.rounding.bands = []);
    mount(
      bandsBody,
      bands.map((b, i) => {
        const upTo = numberInput(b.up_to, { ariaLabel: 'Pásmo ' + (i + 1) + ': do ceny', placeholder: '∞ (bez meze)', size: 8 });
        const ending = numberInput(b.ending, { ariaLabel: 'Pásmo ' + (i + 1) + ': konec', size: 5 });
        const step = numberInput(b.step, { ariaLabel: 'Pásmo ' + (i + 1) + ': krok', placeholder: String(stepFor({ ending: b.ending })), size: 5 });
        const sample = h('span', { class: 'muted num' });
        const updSample = () => {
          const probe = b.up_to != null ? Math.max(1, b.up_to - (stepFor(b) * 0.37)) : (bands[i - 1]?.up_to ?? 0) * 1.37 + 1234;
          const r = roundingExamples({ ...cfg.rounding, bands: [b] }, [probe])[0];
          sample.textContent = money(Math.round(probe)) + ' → ' + money(r.result);
        };
        const onNum = (inp, key, nullable) => inp.addEventListener('input', () => {
          const v = parseInputNumber(inp.value);
          const bad = Number.isNaN(v) || (v == null && !nullable);
          inp.classList.toggle('is-invalid', bad);
          if (bad) return;
          if (v == null) delete b[key];
          else b[key] = v;
          if (key === 'up_to' && v == null) b.up_to = null;
          step.placeholder = String(stepFor({ ending: b.ending }));
          updSample();
          renderExamples();
          emit();
        });
        onNum(upTo, 'up_to', true);
        onNum(ending, 'ending', false);
        onNum(step, 'step', true);
        updSample();
        return h(
          'tr',
          null,
          h('td', null, upTo),
          h('td', null, ending),
          h('td', null, step),
          h('td', null, sample),
          h('td', null, h('button', {
            type: 'button', class: 'btn-icon', 'aria-label': 'Odebrat pásmo ' + (i + 1),
            onClick: () => {
              bands.splice(i, 1);
              renderBands();
              renderExamples();
              emit();
            },
          }, icon('trash', { size: 15 })))
        );
      })
    );
  }
  function renderExamples() {
    const ex = roundingExamples(cfg.rounding, [449.5, 1234, 8765, 12345, 45678]);
    mount(examplesEl, h('span', { class: 'muted' }, 'Náhled:'), ex.map((e) => h('span', { class: 'round-ex num' }, money(e.value) + ' → ' + money(e.result))));
  }
  const dirCtl = segmented(ROUNDING_DIRECTIONS, cfg.rounding.direction, (v) => {
    cfg.rounding.direction = v;
    renderExamples();
    emit();
  }, { label: 'Směr zaokrouhlení' });
  const roundModeSel = select(ROUNDING_MODES, cfg.rounding.mode, {
    onChange: (e) => {
      cfg.rounding.mode = e.target.value;
      renderExamples();
      emit();
    },
  });
  roundModeSel.dataset.path = 'rounding.mode';
  const bandsWrap = h(
    'div',
    { class: 'bands' },
    h('div', { class: 'dt-scroll' }, bandsTable),
    h('button', {
      type: 'button', class: 'btn btn-sm',
      onClick: () => {
        const bands = cfg.rounding.bands;
        const last = bands[bands.length - 1];
        if (last && last.up_to == null) {
          const prevUp = bands[bands.length - 2]?.up_to ?? 1000;
          bands.splice(bands.length - 1, 0, { up_to: prevUp * 10, ending: 90 });
        } else bands.push({ up_to: null, ending: 990 });
        renderBands();
        renderExamples();
        emit();
      },
    }, icon('plus', { size: 14 }), h('span', null, 'Přidat pásmo')),
    h('p', { class: 'field-help' }, HELP['rounding.bands'])
  );
  const roundingSection = card({
    title: 'Zaokrouhlení',
    icon: 'tag',
    subtitle: 'Psychologické cenové konce a směr zaokrouhlení.',
    class: 'form-section',
    dataset: { section: 'rounding' },
    body: [
      h('div', { class: 'form-grid form-grid-2' }, field({ label: 'Způsob', control: roundModeSel, help: HELP['rounding.mode'] }), field({ label: 'Směr', control: dirCtl, input: dirCtl.firstChild, help: HELP['rounding.direction'] })),
      bandsWrap,
      examplesEl,
    ],
  });

  // ------------------------------------------------ Sklad
  const stockSection = card({
    title: 'Sklad',
    icon: 'box',
    class: 'form-section',
    dataset: { section: 'stock' },
    body: [choice('stock.zero_stock', 'Produkty s nulovým skladem', ZERO_STOCK_MODES)],
  });

  // ------------------------------------------------ Schvalování
  const autoMax = num('approval.auto_max_change_pct', 'Automaticky schválit změny do', { suffix: '%', placeholder: 'např. 5' });
  const approvalSection = card({
    title: 'Schvalování',
    icon: 'check',
    class: 'form-section',
    dataset: { section: 'approval' },
    body: [toggle('approval.auto', 'Schvalovat automaticky'), autoMax, h('p', { class: 'field-help' }, 'Limit změny se používá i pro příznak „Velká změna“ u ručně schvalovaných návrhů.')],
  });

  function show(el, on) {
    el.hidden = !on;
  }

  function refreshVisibility() {
    const m = TARGET_MODE_MAP[cfg.target.mode] || {};
    modeHelp.textContent = m.help || '';
    show(tOffsetPct, Boolean(m.offsets));
    show(tOffsetAbs, Boolean(m.offsets));
    show(presetsRow, Boolean(m.offsets));
    show(tRank, cfg.target.mode === 'rank');
    show(tCompetitor, cfg.target.mode === 'competitor');
    show(tMarkup, cfg.target.mode === 'cost_plus');
    show(tFixed, cfg.target.mode === 'fixed');
    show(marketNote, !m.market);
    compSection.classList.toggle('is-dimmed', !m.market);
    show(fbMarkup, cfg.fallback.mode === 'cost_plus');
    show(fbOffset, cfg.fallback.mode === 'msrp');
    const fbHelp = compSection.querySelector('.fb-mode-help');
    if (fbHelp) fbHelp.textContent = (FALLBACK_MODES.find((f) => f.value === cfg.fallback.mode) || {}).help || '';
    show(bandsWrap, cfg.rounding.mode === 'ending');
    show(dirCtl.closest('.field') || dirCtl, cfg.rounding.mode !== 'none');
    show(autoMax, Boolean(cfg.approval.auto));
    // příklad výpočtu cíle (bez limitů a zaokrouhlení)
    const t = cfg.target;
    let ex = '';
    if (m.offsets) {
      const ref = 10000;
      const target = ref * (1 + (Number(t.offset_pct) || 0) / 100) + (Number(t.offset_abs) || 0);
      const refName = { undercut_min: 'nejnižší cena', rank: 'cena na ' + (t.rank || 1) + '. místě', market_avg: 'průměr trhu', market_median: 'medián trhu', competitor: 'cena konkurenta', msrp: 'MOC' }[t.mode] || 'reference';
      ex = 'Příklad: ' + refName + ' ' + money(ref) + ' → cíl ' + money(Math.round(target * 100) / 100) + ' (před limity a zaokrouhlením).';
    } else if (t.mode === 'cost_plus' && t.markup_pct != null) {
      const net = 1000 * (1 + t.markup_pct / 100);
      ex = 'Příklad: nákup 1 000 Kč bez DPH → ' + money(Math.round(net)) + ' bez DPH = ' + money(Math.round(net * 1.21)) + ' s DPH 21 %.';
    } else if (t.mode === 'match_min') {
      ex = 'Příklad: nejnižší cena 10 000 Kč → cíl 10 000 Kč.';
    }
    example.textContent = ex;
    show(example, Boolean(ex));
  }

  renderBands();
  renderExamples();
  refreshVisibility();

  const sections = {
    target: targetSection,
    competitors: compSection,
    limits: limitsSection,
    rounding: roundingSection,
    stock: stockSection,
    approval: approvalSection,
  };
  const el = h('div', { class: 'strategy-form' }, Object.values(sections));
  return { el, sections, getConfig: () => JSON.parse(JSON.stringify(cfg)) };
}
