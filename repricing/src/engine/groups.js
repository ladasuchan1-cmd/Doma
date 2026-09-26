'use strict';
// Cenové skupiny – sjednocení ceny velikostí / barev jednoho modelu (products.group_code, strategie config.group.align).
// Čistá funkce nad výsledky vyhodnocení (bez databáze); volá ji run.js (přecenění, zkušební běh, simulace, detail produktu).
//
// Postup (SPEC §6.10):
//  1. Členové = produkty se stejným group_code (porovnání jako kód: bez mezer, velká písmena), o kterých rozhodla
//     TATÁŽ strategie a ta má group.align ≠ 'off'. Člen, o kterém rozhodla jiná strategie (např. ležák v doprodeji),
//     se nesjednocuje – skupina se tak dělí podle strategií.
//  2. Do výpočtu jdou výsledné ceny členů: nová cena u změny, aktuální cena u „beze změny“. Přeskočení členové
//     (zamčeno, nulový sklad, neplatná DPH…) cenu drží, do výpočtu nejdou, ale ve vysvětlení se uvedou.
//  3. Cena skupiny = nejnižší / nejvyšší / medián výsledných cen, omezená na [nejvyšší ze spodních hranic členů,
//     nejnižší z horních hranic členů]. Prázdný interval → ceny zůstávají samostatné, všichni členové dostanou
//     příznak group_conflict (limity nelze splnit jednou cenou).
//  4. Zaokrouhlení podle strategie (bod v nastaveném směru, pak na druhé straně) – musí zůstat v intervalu, jinak
//     nezaokrouhlená cena v celých korunách.
//  5. Každý člen dostane tuto cenu: znovu se posoudí „beze změny“ / práh minimální změny vůči JEHO aktuální ceně,
//     přepočítá se marže, pořadí, změna, příznaky below_cost / big_change a automatické schválení. Cena mimo limit
//     změny člena (max. snížení / zvýšení, zákaz snížení / zvýšení) se nikdy neschválí automaticky. Příznak group_aligned
//     a krok vysvětlení „Sjednoceno ve skupině X (N produktů, režim …) → Y Kč“.

const { round, net, marginPct, median } = require('../util/num');
const { codeKey } = require('../util/keys');
const { roundPrice, priceCandidates } = require('./rounding');
const { normalizeConfig, isNormalized, GROUP_ALIGN_LABELS } = require('./presets');
const { formatMoney, formatPct, BLOCKING_FLAGS, FLAG_LABELS } = require('./pricing');

const EPS = 1e-9;
const CENT = 0.005;

/** Klíč skupiny produktu (null = produkt do žádné skupiny nepatří). */
function groupKey(product) {
  const g = product && product.group_code;
  if (g == null || typeof g === 'object') return null;
  const k = codeKey(String(g));
  return k || null;
}

function numOr(v) {
  if (v == null || typeof v === 'boolean' || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
const pos = (v) => {
  const n = numOr(v);
  return n != null && n > 0 ? n : null;
};

function plural(n, one, few, many) {
  if (n === 1) return one;
  if (n >= 2 && n <= 4) return few;
  return many;
}

const signed = (v, fmt) => (v > 0 ? `+${fmt(v)}` : fmt(v));

/** Normalizovaný config strategie (připravená strategie z run.js ho už má). null = neplatný. */
function configOf(strategy) {
  if (!strategy) return null;
  if (Array.isArray(strategy.errors) && strategy.errors.length) return null;
  const cfg = strategy.config;
  if (isNormalized(cfg)) return cfg;
  const n = normalizeConfig(cfg);
  return n.errors.length ? null : n.config;
}

/** Pořadí ceny v trhu z rozhodnutí (market.used je seřazené vzestupně podle efektivní ceny). */
function rankIn(market, price) {
  if (!market || !market.count || !Array.isArray(market.used) || price == null) return null;
  const p = round(price, 2);
  let n = 0;
  for (const o of market.used) if (o.effective < p - EPS) n += 1;
  return n + 1;
}

/** Výsledná cena člena (nová u změny, aktuální u „beze změny“), jinak null. */
function resultingPrice(d) {
  if (!d) return null;
  if (d.action === 'change') return pos(d.new_price);
  if (d.action === 'no_change') return pos(d.old_price);
  return null;
}

/** Cena skupiny podle režimu. */
function aggregate(prices, mode) {
  if (mode === 'min') return Math.min(...prices);
  if (mode === 'max') return Math.max(...prices);
  return median(prices);
}

/**
 * Zaokrouhlí cenu skupiny podle strategie tak, aby zůstala v [lo, hi].
 * @returns {{price: number, rounded: boolean}}
 */
function roundWithin(value, rounding, lo, hi) {
  const ok = (x) => x != null && Number.isFinite(x) && x > 0 && (lo == null || x >= lo - EPS) && (hi == null || x <= hi + EPS);
  const first = roundPrice(value, rounding, rounding && rounding.direction);
  if (ok(first)) return { price: first, rounded: true };
  const cand = priceCandidates(value, rounding);
  const second = first === cand.down ? cand.up : cand.down;
  if (ok(second)) return { price: second, rounded: true };
  // mezi hranicemi není cenový bod → celé koruny co nejblíž cílové hodnotě (uvnitř intervalu)
  let x = Math.round(value);
  if (lo != null) x = Math.max(x, Math.ceil(lo - EPS));
  if (hi != null) x = Math.min(x, Math.floor(hi + EPS));
  if (!ok(x)) x = round(value, 2); // interval užší než 1 Kč
  return { price: x, rounded: false };
}

/** Leží cena v limitu změny člena (max. snížení / zvýšení, zákaz snížení / zvýšení) vůči jeho aktuální ceně? */
function withinChangeLimit(price, cur, L) {
  if (cur == null) return true;
  let lo = -Infinity;
  let hi = Infinity;
  if (L.max_decrease_pct != null) lo = cur * (1 - L.max_decrease_pct / 100);
  if (L.max_increase_pct != null) hi = cur * (1 + L.max_increase_pct / 100);
  if (!L.allow_decrease) lo = Math.max(lo, cur);
  if (!L.allow_increase) hi = Math.min(hi, cur);
  return price >= lo - CENT && price <= hi + CENT;
}

function flagOn(d, f) {
  if (!d.flags.includes(f)) d.flags.push(f);
}

function flagOff(d, f) {
  const i = d.flags.indexOf(f);
  if (i >= 0) d.flags.splice(i, 1);
}

/**
 * Nastaví členu skupiny sjednocenou cenu a přepočítá rozhodnutí.
 * @param {{product, decision}} m
 * @param {number} price cena skupiny
 * @param {object} cfg normalizovaný config strategie
 * @param {object} settings
 * @param {{step: string, text: string}} groupStep krok vysvětlení
 */
function applyToMember(m, price, cfg, settings, groupStep) {
  const d = m.decision;
  const p = m.product || {};
  const L = cfg.limits;
  const A = cfg.approval;
  const cur = pos(d.old_price);
  const purchase = pos(p.purchase_price);
  const vat = numOr(p.vat_rate) ?? numOr(settings && settings.vat_rate_default) ?? 21;
  const prevAction = d.action;
  const within = (x) => (d.floor == null || x >= d.floor - EPS) && (d.ceiling == null || x <= d.ceiling + EPS);

  // krok schválení se počítá znovu
  d.explain = d.explain.filter((s) => s.step !== 'approval');
  d.explain.push(groupStep);
  flagOff(d, 'below_cost');
  flagOff(d, 'big_change');
  flagOn(d, 'group_aligned');
  d.auto_approve = false;

  let noChangeReason = null;
  if (cur != null) {
    const diff = Math.abs(price - cur);
    const thr = Math.max(L.min_change_abs || 0, (cur * (L.min_change_pct || 0)) / 100);
    if (diff < CENT) noChangeReason = prevAction === 'no_change' && d.reason ? d.reason : 'same_price';
    else if (diff < thr - EPS && within(cur)) noChangeReason = 'below_threshold';
    if (noChangeReason) {
      d.action = 'no_change';
      d.reason = noChangeReason;
      d.new_price = d.old_price;
      d.rank_after = d.rank_before;
      d.margin_after = d.margin_before;
      d.change_abs = 0;
      d.change_pct = 0;
      d.explain.push({
        step: 'result',
        text:
          noChangeReason === 'below_threshold'
            ? `Po sjednocení: změna ${formatMoney(diff)} je pod prahem ${formatMoney(thr)} → beze změny (${formatMoney(cur)})`
            : `Po sjednocení: cena ${formatMoney(cur)} zůstává beze změny`,
      });
      return;
    }
  }

  d.action = 'change';
  d.reason = null;
  d.new_price = price;
  d.rank_after = rankIn(d.market, price);
  d.margin_after = marginPct(price, purchase, vat);
  if (cur != null) {
    d.change_abs = round(price - cur, 2);
    d.change_pct = round(((price - cur) / cur) * 100, 2);
  } else {
    d.change_abs = null;
    d.change_pct = null;
  }
  if (purchase != null && net(price, vat) < purchase - EPS) {
    flagOn(d, 'below_cost');
    d.explain.push({ step: 'warning', text: `Pozor: sjednocená cena ${formatMoney(round(net(price, vat), 2))} bez DPH je pod nákupní cenou ${formatMoney(purchase)}` });
  }
  if (A.auto_max_change_pct != null && d.change_pct != null && Math.abs(d.change_pct) > A.auto_max_change_pct + EPS) flagOn(d, 'big_change');

  let res = cur != null ? `Nová cena po sjednocení ${formatMoney(price)} (${signed(d.change_pct, formatPct)}, ${signed(d.change_abs, formatMoney)})` : `Nová cena po sjednocení ${formatMoney(price)} (dosud bez ceny)`;
  if (d.margin_after != null) res += `, marže ${d.margin_before != null ? `${formatPct(d.margin_before)} → ` : ''}${formatPct(d.margin_after)}`;
  if (d.rank_after != null) res += `, pořadí ${d.rank_before != null ? `${d.rank_before} → ` : ''}${d.rank_after}`;
  d.explain.push({ step: 'result', text: res });

  if (A.auto) {
    const reasons = [];
    for (const f of BLOCKING_FLAGS) {
      if (!d.flags.includes(f)) continue;
      reasons.push(f === 'big_change' ? `velká změna (${formatPct(Math.abs(d.change_pct))} > ${formatPct(A.auto_max_change_pct)})` : FLAG_LABELS[f]);
    }
    if (d.flags.includes('no_cost') && cur != null && price < cur) reasons.push('snížení ceny bez známé nákupní ceny');
    if (cur == null) reasons.push('produkt dosud nemá cenu');
    // sjednocená cena může ležet mimo limit změny člena – takovou změnu vždy posoudí člověk
    if (!withinChangeLimit(price, cur, L)) reasons.push('sjednocená cena je mimo limit změny strategie');
    if (!reasons.length) {
      d.auto_approve = true;
      d.explain.push({
        step: 'approval',
        text: A.auto_max_change_pct != null && d.change_pct != null ? `Automaticky schváleno (změna ${formatPct(Math.abs(d.change_pct))} ≤ ${formatPct(A.auto_max_change_pct)})` : 'Automaticky schváleno',
      });
    } else {
      d.explain.push({ step: 'approval', text: `Nutné ruční schválení: ${reasons.join(', ')}` });
    }
  } else {
    d.explain.push({ step: 'approval', text: 'Návrh čeká na ruční schválení' });
  }
}

/**
 * Sjednotí ceny ve skupinách (mutuje rozhodnutí v items).
 * @param {Array<{product: object, decision: object|null, strategy: object|null}>} items výsledky vyhodnocení
 *   (strategy = strategie, která rozhodla – připravená z run.js, porovnává se identitou objektu)
 * @param {{settings?: object}} [ctx]
 * @returns {{aligned: number, conflicts: number, members: number}} počty skupin a sjednocených členů
 */
function alignGroups(items, ctx = {}) {
  const out = { aligned: 0, conflicts: 0, members: 0 };
  const byStrategy = new Map(); // strategie → Map(klíč skupiny → členové)
  for (const it of items || []) {
    if (!it || !it.decision || !it.strategy) continue;
    const key = groupKey(it.product);
    if (!key) continue;
    let cfgEntry = byStrategy.get(it.strategy);
    if (!cfgEntry) {
      const cfg = configOf(it.strategy);
      cfgEntry = { cfg, groups: new Map() };
      byStrategy.set(it.strategy, cfgEntry);
    }
    if (!cfgEntry.cfg || !cfgEntry.cfg.group || cfgEntry.cfg.group.align === 'off') continue;
    const list = cfgEntry.groups.get(key);
    if (list) list.push(it);
    else cfgEntry.groups.set(key, [it]);
  }

  for (const [, { cfg, groups }] of byStrategy) {
    if (!cfg || !cfg.group || cfg.group.align === 'off') continue;
    const mode = cfg.group.align;
    const modeLabel = GROUP_ALIGN_LABELS[mode] || mode;
    for (const [, members] of groups) {
      if (members.length < 2) continue;
      const participants = [];
      const held = [];
      for (const m of members) {
        if (resultingPrice(m.decision) != null) participants.push(m);
        else held.push(m);
      }
      if (participants.length < 2) continue;
      const code = String(participants[0].product.group_code).trim();
      const heldText = held.length
        ? `; beze změny ${plural(held.length, 'zůstává', 'zůstávají', 'zůstává')} ${held.length} ${plural(held.length, 'člen', 'členové', 'členů')} (${held
            .slice(0, 5)
            .map((m) => m.product.code ?? m.product.id)
            .join(', ')}${held.length > 5 ? ', …' : ''} – přeskočeno)`
        : '';
      const floors = participants.map((m) => m.decision.floor).filter((v) => v != null && Number.isFinite(v));
      const ceilings = participants.map((m) => m.decision.ceiling).filter((v) => v != null && Number.isFinite(v));
      const lo = floors.length ? Math.max(...floors) : null;
      const hi = ceilings.length ? Math.min(...ceilings) : null;
      const n = participants.length;
      const count = `${n} ${plural(n, 'produkt', 'produkty', 'produktů')}`;

      if (lo != null && hi != null && lo > hi + EPS) {
        out.conflicts += 1;
        const step = {
          step: 'group',
          text: `Skupinu ${code} (${count}, režim ${modeLabel}) nelze sjednotit: nejvyšší spodní hranice členů ${formatMoney(lo)} je nad nejnižší horní hranicí ${formatMoney(hi)} – ceny zůstávají samostatné${heldText}`,
        };
        for (const m of participants) {
          flagOn(m.decision, 'group_conflict');
          m.decision.explain.push(step);
          m.decision.group = { code, align: mode, members: n, price: null, conflict: true };
        }
        continue;
      }

      const prices = participants.map((m) => resultingPrice(m.decision));
      const agg = aggregate(prices, mode);
      let target = agg;
      if (lo != null && target < lo) target = lo;
      if (hi != null && target > hi) target = hi;
      const { price, rounded } = roundWithin(target, cfg.rounding, lo, hi);
      let detail = '';
      if (Math.abs(target - agg) > CENT) detail += `; ${target > agg ? `zvednuto na spodní hranici skupiny ${formatMoney(lo)}` : `sníženo na horní hranici skupiny ${formatMoney(hi)}`}`;
      if (!rounded) detail += '; mezi hranicemi skupiny není cenový bod → bez zaokrouhlení';
      const step = {
        step: 'group',
        text: `Sjednoceno ve skupině ${code} (${count}, režim ${modeLabel}) → ${formatMoney(price)}${detail}${heldText}`,
      };
      out.aligned += 1;
      for (const m of participants) {
        applyToMember(m, price, cfg, ctx.settings, step);
        m.decision.group = { code, align: mode, members: n, price, conflict: false };
        out.members += 1;
      }
    }
  }
  return out;
}

module.exports = { alignGroups, groupKey };
