'use strict';
// Výpočet nové ceny jednoho produktu podle jedné strategie – SPEC §6.7. Čistá funkce (bez databáze).
//
// Pořadí kroků (každý přidá české vysvětlení do `explain`):
//   1. zámek → skip locked
//   2. nulový sklad (skip / msrp)
//   3. trh podle filtru konkurence strategie
//   4. cíl podle režimu; chybí-li základ ceny → záložní postup (next = propadnout na další strategii)
//   5. hranice: spodní (min. marže, min. zisk, MOC floor, ruční min.) a horní (MOC strop, max. marže, ruční max.)
//   6. omezení změny → strop → podlaha. PODLAHA VŽDY VYHRÁVÁ.
//   7. zaokrouhlení (pod podlahu nikdy; nad strop jen když to podlaha vynutí)
//   8. práh minimální změny
//   9. metriky a příznaky
//  10. automatické schválení
//
// Peníze: všechny prodejní ceny jsou s DPH, nákupní bez DPH. Hranice se zaokrouhlují „na bezpečnou stranu“
// (spodní nahoru na haléře, horní dolů), aby zaokrouhlovací šum nikdy nepustil cenu pod podlahu.

const { DEFAULT_SETTINGS } = require('../db');
const { round, net, gross, marginPct } = require('../util/num');
const { buildMarket, rankOf, findCompetitorOffer, EXCLUDE_REASONS } = require('./market');
const { roundPrice, priceCandidates, describeRounding } = require('./rounding');
const { normalizeConfig, isNormalized, MARKET_MODES, TARGET_MODE_LABELS } = require('./presets');
const { isLockActive, daysSince, toDate, parseDateTime } = require('./metrics');

const EPS = 1e-9;
const CENT = 0.005;

/**
 * Příznaky, které blokují automatické schválení.
 * `ceiling_over_change_limit` není v SPEC §6.7 krok 10 – konzervativní rozšíření (zrcadlo floor_over_change_limit):
 * horní hranice (typicky MOC strop nebo ruční max. cena) vynutila snížení větší, než dovoluje limit změny
 * (max_decrease_pct / allow_decrease) → takové snížení nikdy neschvalovat automaticky.
 */
const BLOCKING_FLAGS = Object.freeze(['limits_conflict', 'floor_over_change_limit', 'ceiling_over_change_limit', 'below_cost', 'big_change']);

/** České popisky příznaků. */
const FLAG_LABELS = Object.freeze({
  change_limited: 'změna omezena limitem',
  ceiling: 'omezeno horní hranicí',
  floor: 'zvednuto na spodní hranici',
  limits_conflict: 'konflikt limitů (spodní hranice nad horní)',
  floor_over_change_limit: 'spodní hranice vyžaduje změnu nad limit',
  ceiling_over_change_limit: 'horní hranice vyžaduje snížení nad limit',
  no_cost: 'chybí nákupní cena',
  below_cost: 'pod nákupní cenou',
  big_change: 'velká změna',
  fallback: 'použit záložní postup',
  rounding_skipped: 'bez zaokrouhlení (mezi limity není cenový bod)',
});

/** České popisky důvodů (reason) rozhodnutí. */
const REASON_LABELS = Object.freeze({
  locked: 'cena je zamčena',
  zero_stock: 'produkt není skladem',
  no_msrp: 'chybí MOC',
  fallthrough: 'chybí základ ceny – propadá na další strategii',
  invalid_config: 'neplatná konfigurace strategie',
  invalid_target: 'neplatná cílová cena',
  invalid_vat: 'neplatná sazba DPH',
  below_threshold: 'změna pod prahem',
  same_price: 'cena se nemění',
  no_price_point: 'žádný vhodný cenový bod v povolených mezích',
  keep: 'aktuální cena je v mezích',
  clearance_wait: 'doprodej čeká na další krok',
  no_market: 'chybí trh',
  no_competitor: 'chybí nabídka konkurenta',
  no_cost: 'chybí nákupní cena',
  no_price: 'chybí aktuální cena',
  no_strategy: 'žádná strategie',
});

// ---------------------------------------------------------------------------------------------
// Formátování (české texty vysvětlení)

// Vlastní formátování shodné s Intl.NumberFormat('cs-CZ') (oddělovač tisíců NBSP, desetinná čárka,
// znaménko „-“) – Intl je při ~20 voláních na produkt × 30 000 produktů zbytečně pomalé.
// Shodu s Intl ověřuje test engine-pricing.
const NBSP = '\u00a0';
function groupCs(intDigits) {
  let out = '';
  for (let i = intDigits.length; i > 0; i -= 3) out = intDigits.slice(Math.max(0, i - 3), i) + (out ? NBSP + out : '');
  return out;
}
function numCs(v, fracDigits, trimZeros) {
  let r = round(v, fracDigits);
  if (Object.is(r, -0) || r === 0) r = 0;
  const neg = r < 0;
  let [i, d = ''] = Math.abs(r).toFixed(fracDigits).split('.');
  if (trimZeros) d = d.replace(/0+$/, '');
  return (neg ? '-' : '') + groupCs(i) + (d ? ',' + d : '');
}

/** 12490 → „12 490 Kč“ (oddělovač tisíců = NBSP jako v Intl cs-CZ), 12490.5 → „12 490,50 Kč“. */
function formatMoney(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  const r = round(v, 2);
  return `${numCs(r, Number.isInteger(r) ? 0 : 2, false)} Kč`;
}

/** 1.5 → „1,5 %“ (nejvýše 2 desetinná místa). */
function formatPct(v) {
  if (v == null || !Number.isFinite(v)) return '–';
  return `${numCs(v, 2, true)} %`;
}

/** Číslo česky (nejvýše 2 desetinná místa), např. kusy. */
function formatNum(v) {
  return v == null || !Number.isFinite(v) ? '–' : numCs(v, 2, true);
}

const signed = (v, fmt) => (v > 0 ? `+${fmt(v)}` : fmt(v));

function plural(n, one, few, many) {
  const a = Math.abs(n);
  if (a === 1) return one;
  if (a >= 2 && a <= 4 && Number.isInteger(a)) return few;
  return many;
}

function describeOffset(pct, abs) {
  const parts = [];
  if (pct) parts.push(pct < 0 ? `o ${formatPct(-pct)} levněji` : `o ${formatPct(pct)} dráž`);
  if (abs) parts.push(abs < 0 ? `o ${formatMoney(-abs)} levněji` : `o ${formatMoney(abs)} dráž`);
  return parts.length ? parts.join(' a ') : 'bez posunu';
}

function formatDateTime(iso) {
  const t = parseDateTime(iso);
  if (t == null) return String(iso);
  return new Date(t).toLocaleString('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

// ---------------------------------------------------------------------------------------------

// Číslo z řádku produktu. Přijímá i číselný řetězec („13490“) – jinak by se např. nákupní cena v textové podobě
// tiše brala jako chybějící a vypadla by maržová podlaha. Boolean ani prázdný řetězec číslo nejsou.
function numOr(v) {
  if (v == null || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
// Kladné číslo, jinak null (cena 0 / záporná = chybějící údaj).
const pos = (v) => {
  const n = numOr(v);
  return n != null && n > 0 ? n : null;
};
const ceilCents = (x) => Math.ceil(round(x * 100, 6)) / 100;
const floorCents = (x) => Math.floor(round(x * 100, 6)) / 100;

function marketSummary(m) {
  return {
    count: m.count,
    min: m.min,
    max: m.max,
    avg: m.avg,
    median: m.median,
    cheapest: m.cheapest ? { competitor: m.cheapest.competitor ?? null, price: m.cheapest.price, effective: m.cheapest.effective } : null,
    used: m.offers.map((o) => ({ competitor: o.competitor ?? null, price: o.price, effective: o.effective, in_stock: o.in_stock ?? null })),
    excluded: m.excluded.map((e) => ({ competitor: e.offer.competitor ?? null, price: e.offer.price ?? null, reason: e.reason })),
  };
}

function skip(d, reason) {
  d.action = 'skip';
  d.reason = reason;
  d.new_price = null;
  return d;
}

function noChange(d, reason) {
  d.action = 'no_change';
  d.reason = reason;
  d.new_price = d.old_price;
  d.rank_after = d.rank_before;
  d.margin_after = d.margin_before;
  d.change_abs = d.old_price != null ? 0 : null;
  d.change_pct = d.old_price != null ? 0 : null;
  return d;
}

/**
 * Spočítá rozhodnutí o ceně jednoho produktu podle jedné strategie.
 * Použitelnost strategie (segment, podmínky, časové okno) kontroluje volající (run.js).
 * @param {object} product řádek produktu (price, purchase_price, vat_rate, msrp, stock, sales_30, locked, locked_until,
 *   min_price, max_price, price_changed_at, id)
 * @param {Array<object>} offers nabídky konkurence (SPEC §6.1)
 * @param {{id?, name?, segment_id?, config}} strategy config nemusí být normalizovaný
 * @param {{now?: Date|string, settings?: object}} [ctx]
 * @returns {object} Decision (SPEC §6.7)
 */
function computePrice(product, offers, strategy, ctx = {}) {
  product = product || {};
  const strat = strategy || {};
  const now = toDate(ctx.now);
  const settings = ctx.settings ? { ...DEFAULT_SETTINGS, ...ctx.settings } : DEFAULT_SETTINGS;
  const vat = numOr(product.vat_rate) ?? numOr(settings.vat_rate_default) ?? 21;
  // Záporná sazba (nebo ≥ 100 %) je chyba dat: snížila by spodní hranice z marže a zároveň by oklamala kontrolu
  // „pod nákupní cenou“ (net = cena / (1 + DPH)) → produkt se nepřeceňuje (skip invalid_vat, viz níže).
  const vatOk = vat >= 0 && vat < 100;
  const cur = pos(product.price);
  // nákupní cena ≤ 0 = chybějící údaj (marži nelze ověřit)
  const purchase = pos(product.purchase_price);
  const msrp = pos(product.msrp);

  const d = {
    action: null,
    reason: null,
    product_id: product.id ?? null,
    strategy_id: strat.id ?? null,
    segment_id: strat.segment_id ?? null,
    strategy_name: strat.name ?? null,
    old_price: cur,
    new_price: null,
    target_price: null,
    reference_price: null,
    floor: null,
    ceiling: null,
    market: null,
    rank_before: null,
    rank_after: null,
    margin_before: vatOk ? marginPct(cur, purchase, vat) : null,
    margin_after: null,
    change_abs: null,
    change_pct: null,
    flags: [],
    explain: [],
    auto_approve: false,
  };
  const say = (step, text) => d.explain.push({ step, text });
  const flag = (f) => {
    if (!d.flags.includes(f)) d.flags.push(f);
  };
  const fm = formatMoney;
  const fp = formatPct;

  // --- konfigurace ----------------------------------------------------------------------------
  let cfg = strat.config;
  if (!isNormalized(cfg)) {
    const n = normalizeConfig(cfg);
    if (n.errors.length) {
      say('config', `Neplatná konfigurace strategie: ${n.errors.join('; ')}`);
      d.market = marketSummary(buildMarket([], null, {}));
      return skip(d, 'invalid_config');
    }
    cfg = n.config;
  }
  const T = cfg.target;
  const L = cfg.limits;
  const R = cfg.rounding;
  const A = cfg.approval;
  const FB = cfg.fallback;
  const stratLabel = strat.name ? `Strategie „${strat.name}“` : 'Strategie';
  say('strategy', `${stratLabel}: ${TARGET_MODE_LABELS[T.mode] || T.mode}`);

  // Trh počítáme vždy (i pro přeskočené produkty – UI ho zobrazuje).
  const market = buildMarket(offers, cfg.competitors, { now, maxAgeDays: settings.offer_max_age_days });
  d.market = marketSummary(market);
  d.rank_before = rankOf(cur, market);

  // --- 1. zámek -------------------------------------------------------------------------------
  if (isLockActive(product, now)) {
    say('lock', product.locked_until ? `Cena je ručně zamčena do ${formatDateTime(product.locked_until)} – beze změny` : 'Cena je ručně zamčena – beze změny');
    return skip(d, 'locked');
  }

  // --- 2. nulový sklad ------------------------------------------------------------------------
  const stock = numOr(product.stock); // null = neznámý sklad → přeceňuje se běžně
  let zeroStockMsrp = false;
  if (stock != null && stock <= 0) {
    if (cfg.stock.zero_stock === 'skip') {
      say('stock', `Produkt není skladem (${formatNum(stock)} ks) – strategie takové produkty nepřeceňuje`);
      return skip(d, 'zero_stock');
    }
    if (cfg.stock.zero_stock === 'msrp') {
      if (msrp == null) {
        say('stock', 'Produkt není skladem a nemá MOC – cenu podle MOC nelze nastavit');
        return skip(d, 'no_msrp');
      }
      zeroStockMsrp = true;
    }
  }

  // --- 2b. sazba DPH (ochrana peněz – viz vatOk) -------------------------------------------------
  if (!vatOk) {
    say('vat', `Neplatná sazba DPH ${formatNum(vat)} % – hranice marže ani cenu nelze spolehlivě spočítat, produkt se nepřeceňuje`);
    return skip(d, 'invalid_vat');
  }

  // --- 3. trh ---------------------------------------------------------------------------------
  if (market.count) {
    const ch = market.cheapest;
    let t = `Nejnižší cena trhu: ${fm(market.min)} (${ch.label || ch.competitor}), ${market.count} ${plural(market.count, 'konkurent', 'konkurenti', 'konkurentů')}`;
    if (market.count > 1) t += `, medián ${fm(market.median)}`;
    if (cfg.competitors.include_shipping) t += ' (ceny vč. dopravy)';
    say('market', t);
  } else {
    say('market', 'Trh: žádná použitelná nabídka konkurence');
  }
  if (market.excluded.length) {
    const counts = {};
    for (const e of market.excluded) counts[e.reason] = (counts[e.reason] || 0) + 1;
    const n = market.excluded.length;
    say(
      'market',
      `Vyřazeno nabídek: ${n} – ${Object.entries(counts)
        .map(([r, c]) => `${EXCLUDE_REASONS[r] || r} (${c})`)
        .join(', ')}`
    );
  }
  if (cur != null && d.rank_before != null) say('market', `Naše cena ${fm(cur)} je ${d.rank_before}. v pořadí z ${market.count + 1} prodejců`);

  // --- 4. cíl ---------------------------------------------------------------------------------
  let target = null;
  let ref = null;
  let hold = null; // důvod „beze změny, pokud aktuální cena neporušuje limity“
  let missing = null;
  const minComp = cfg.competitors.min_competitors || 1;
  const withOffset = (x) => x * (1 + (T.offset_pct || 0) / 100) + (T.offset_abs || 0);
  const offText = describeOffset(T.offset_pct, T.offset_abs);

  if (zeroStockMsrp) {
    ref = msrp;
    target = msrp;
    say('target', `Produkt není skladem → cíl: MOC ${fm(msrp)}`);
  } else {
    switch (T.mode) {
      case 'undercut_min':
      case 'match_min':
      case 'rank':
      case 'market_avg':
      case 'market_median': {
        if (market.count < minComp) {
          missing = 'no_market';
          break;
        }
        let refText;
        if (T.mode === 'undercut_min' || T.mode === 'match_min') {
          ref = market.min;
          refText = `nejnižší cena trhu ${fm(ref)}`;
        } else if (T.mode === 'rank') {
          const idx = Math.min(T.rank, market.count) - 1;
          ref = market.prices[idx];
          const who = market.offers[idx].label || market.offers[idx].competitor;
          refText =
            T.rank > market.count
              ? `požadovaná pozice ${T.rank}, konkurentů je jen ${market.count} → cena nejdražšího ${fm(ref)} (${who})`
              : `pozice ${T.rank} → cena ${T.rank}. nejlevnějšího konkurenta ${fm(ref)} (${who})`;
        } else if (T.mode === 'market_avg') {
          ref = market.avg;
          refText = `průměr trhu ${fm(ref)}`;
        } else {
          ref = market.median;
          refText = `medián trhu ${fm(ref)}`;
        }
        if (T.mode === 'match_min') {
          target = ref; // match_min posun ignoruje
          say('target', `Cíl: vyrovnat ${refText} → ${fm(target)}`);
        } else {
          target = withOffset(ref);
          say('target', `Cíl: ${refText}, ${offText} → ${fm(target)}`);
        }
        break;
      }
      case 'competitor': {
        const o = findCompetitorOffer(market, T.competitor);
        if (!o) {
          missing = 'no_competitor';
          break;
        }
        ref = o.effective;
        target = withOffset(ref);
        say('target', `Cíl: cena konkurenta ${o.label || o.competitor} ${fm(ref)}, ${offText} → ${fm(target)}`);
        break;
      }
      case 'msrp': {
        if (msrp == null) {
          missing = 'no_msrp';
          break;
        }
        ref = msrp;
        target = withOffset(msrp);
        say('target', `Cíl: MOC ${fm(msrp)}, ${offText} → ${fm(target)}`);
        break;
      }
      case 'cost_plus': {
        if (purchase == null) {
          missing = 'no_cost';
          break;
        }
        ref = round(gross(purchase, vat), 2);
        target = gross(purchase * (1 + T.markup_pct / 100), vat);
        say('target', `Cíl: nákupní cena ${fm(purchase)} bez DPH + přirážka ${fp(T.markup_pct)} + DPH ${fp(vat)} → ${fm(target)}`);
        break;
      }
      case 'keep': {
        if (cur == null) {
          missing = 'no_price';
          break;
        }
        ref = cur;
        target = cur;
        hold = 'keep';
        say('target', `Cíl: držet aktuální cenu ${fm(cur)} (jen hlídání limitů)`);
        break;
      }
      case 'fixed': {
        ref = T.fixed_price;
        target = T.fixed_price;
        say('target', `Cíl: pevná cena ${fm(target)}`);
        break;
      }
      case 'clearance': {
        if (cur == null) {
          missing = 'no_price';
          break;
        }
        ref = cur;
        const days = daysSince(product.price_changed_at, now); // null = cena se nikdy neměnila → krok je na řadě
        const sales = numOr(product.sales_30) ?? 0;
        const due = days == null || days >= T.every_days;
        const slow = sales <= T.max_sales_30;
        const daysText = days == null ? 'cena se zatím neměnila' : `od poslední změny ceny ${days} ${plural(days, 'den', 'dny', 'dní')}`;
        if (due && slow) {
          target = cur * (1 - T.step_pct / 100);
          say('target', `Doprodej: ${daysText} (krok každých ${T.every_days} dní), prodej za 30 dní ${formatNum(sales)} ks (limit ${formatNum(T.max_sales_30)}) → sleva ${fp(T.step_pct)} → ${fm(target)}`);
        } else {
          target = cur;
          hold = 'clearance_wait';
          say(
            'target',
            !due
              ? `Doprodej čeká: ${daysText}, další sleva až po ${T.every_days} dnech`
              : `Doprodej čeká: produkt se prodává (${formatNum(sales)} ks za 30 dní > ${formatNum(T.max_sales_30)})`
          );
        }
        break;
      }
      default:
        say('config', `Neznámý režim cíle „${T.mode}“`);
        return skip(d, 'invalid_config');
    }
  }

  // --- 4b. záložní postup ---------------------------------------------------------------------
  if (missing) {
    const MISSING_TEXT = {
      no_market: `použitelných nabídek konkurence je ${market.count}, strategie vyžaduje alespoň ${minComp}`,
      no_competitor: `chybí použitelná nabídka konkurenta „${T.competitor}“`,
      no_msrp: 'produkt nemá MOC',
      no_cost: 'produkt nemá nákupní cenu',
      no_price: 'produkt nemá aktuální prodejní cenu',
    };
    d.base_missing = missing;
    say('fallback', `Chybí základ ceny: ${MISSING_TEXT[missing]}`);
    const fallthrough = (text) => {
      say('fallback', text);
      return skip(d, 'fallthrough');
    };
    switch (FB.mode) {
      case 'keep':
        if (cur == null) return fallthrough('Záložní postup „ponechat cenu“ nelze použít (chybí aktuální cena) → další strategie');
        flag('fallback');
        ref = cur;
        target = cur;
        hold = missing;
        say('fallback', `Záložní postup: ponechat aktuální cenu ${fm(cur)}, pokud neporušuje limity`);
        break;
      case 'msrp':
        if (msrp == null) return fallthrough('Záložní postup „MOC“ nelze použít (produkt nemá MOC) → další strategie');
        flag('fallback');
        ref = msrp;
        target = msrp * (1 + (FB.offset_pct || 0) / 100);
        say('fallback', `Záložní postup: MOC ${fm(msrp)}, ${describeOffset(FB.offset_pct, 0)} → ${fm(target)}`);
        break;
      case 'cost_plus': {
        const mk = FB.markup_pct ?? T.markup_pct;
        if (purchase == null || mk == null) return fallthrough('Záložní postup „nákup + přirážka“ nelze použít (chybí nákupní cena) → další strategie');
        flag('fallback');
        ref = round(gross(purchase, vat), 2);
        target = gross(purchase * (1 + mk / 100), vat);
        say('fallback', `Záložní postup: nákupní cena ${fm(purchase)} bez DPH + přirážka ${fp(mk)} + DPH → ${fm(target)}`);
        break;
      }
      default:
        return fallthrough('Záložní postup: přejít na další strategii');
    }
  }

  if (!(typeof target === 'number' && Number.isFinite(target) && target > 0)) {
    say('target', 'Vypočtená cílová cena není kladné číslo – produkt se nepřeceňuje');
    return skip(d, 'invalid_target');
  }
  d.target_price = round(target, 2);
  d.reference_price = ref != null ? round(ref, 2) : null;

  // --- 5. hranice -----------------------------------------------------------------------------
  const floors = [];
  const ceilings = [];
  if (purchase != null) {
    if (L.min_margin_pct != null) {
      if (L.min_margin_pct >= 100) {
        say('config', 'Minimální marže musí být menší než 100 %');
        return skip(d, 'invalid_config');
      }
      const v = ceilCents(gross(purchase / (1 - L.min_margin_pct / 100), vat));
      floors.push({ v, text: `Minimální marže ${fp(L.min_margin_pct)} → spodní hranice ${fm(v)}` });
    }
    if (L.min_profit_abs != null) {
      const v = ceilCents(gross(purchase + L.min_profit_abs, vat));
      floors.push({ v, text: `Minimální zisk ${fm(L.min_profit_abs)} na kus → spodní hranice ${fm(v)}` });
    }
    if (L.max_margin_pct != null) {
      const v = floorCents(gross(purchase / (1 - L.max_margin_pct / 100), vat));
      ceilings.push({ v, text: `Maximální marže ${fp(L.max_margin_pct)} → horní hranice ${fm(v)}` });
    }
  } else {
    flag('no_cost');
    say('limits', 'Chybí nákupní cena – marži nelze hlídat, automaticky se cena nesníží');
  }
  if (msrp != null) {
    if (L.max_below_msrp_pct != null) {
      const v = ceilCents(msrp * (1 - L.max_below_msrp_pct / 100));
      floors.push({ v, text: `Nejvýše ${fp(L.max_below_msrp_pct)} pod MOC ${fm(msrp)} → spodní hranice ${fm(v)}` });
    }
    if (L.max_above_msrp_pct != null) {
      const v = floorCents(msrp * (1 + L.max_above_msrp_pct / 100));
      const t = L.max_above_msrp_pct === 0 ? `Strop MOC → horní hranice ${fm(v)}` : `Nejvýše ${fp(L.max_above_msrp_pct)} nad MOC ${fm(msrp)} → horní hranice ${fm(v)}`;
      ceilings.push({ v, text: t });
    }
  }
  if (L.respect_product_limits) {
    const mn = pos(product.min_price);
    const mx = pos(product.max_price);
    if (mn != null) floors.push({ v: mn, text: `Ruční minimální cena produktu → spodní hranice ${fm(mn)}` });
    if (mx != null) ceilings.push({ v: mx, text: `Ruční maximální cena produktu → horní hranice ${fm(mx)}` });
  }
  const floor = floors.length ? Math.max(...floors.map((x) => x.v)) : null;
  const ceiling = ceilings.length ? Math.min(...ceilings.map((x) => x.v)) : null;
  d.floor = floor;
  d.ceiling = ceiling;
  for (const x of floors) say('floor', x.text);
  for (const x of ceilings) say('ceiling', x.text);
  if (floor != null && ceiling != null && floor > ceiling + EPS) {
    flag('limits_conflict');
    say('limits', `Konflikt limitů: spodní hranice ${fm(floor)} je nad horní hranicí ${fm(ceiling)} – platí spodní hranice`);
  }
  const within = (x) => (floor == null || x >= floor - EPS) && (ceiling == null || x <= ceiling + EPS);

  if (hold) {
    if (within(cur)) {
      say('result', `Aktuální cena ${fm(cur)} je v povolených mezích → beze změny`);
      return noChange(d, hold);
    }
    say('limits', `Aktuální cena ${fm(cur)} porušuje limity → úprava na povolenou hodnotu`);
  }

  // --- 6. omezení změny → strop → podlaha -----------------------------------------------------
  let p = target;
  let lo = -Infinity;
  let hi = Infinity;
  if (cur != null) {
    if (L.max_decrease_pct != null) lo = cur * (1 - L.max_decrease_pct / 100);
    if (L.max_increase_pct != null) hi = cur * (1 + L.max_increase_pct / 100);
    const noDown = !L.allow_decrease && cur > lo;
    const noUp = !L.allow_increase && cur < hi;
    if (!L.allow_decrease) lo = Math.max(lo, cur);
    if (!L.allow_increase) hi = Math.min(hi, cur);
    if (p < lo - EPS) {
      p = lo;
      flag('change_limited');
      say('limits', noDown ? `Snižování ceny strategie nepovoluje → ${fm(p)}` : `Omezení změny: pokles nejvýše o ${fp(L.max_decrease_pct)} → ${fm(p)}`);
    } else if (p > hi + EPS) {
      p = hi;
      flag('change_limited');
      say('limits', noUp ? `Zvyšování ceny strategie nepovoluje → ${fm(p)}` : `Omezení změny: nárůst nejvýše o ${fp(L.max_increase_pct)} → ${fm(p)}`);
    }
  }
  if (ceiling != null && p > ceiling + EPS) {
    p = ceiling;
    flag('ceiling');
    say('ceiling', `Cena snížena na horní hranici → ${fm(p)}`);
  }
  let floorApplied = false;
  if (floor != null && p < floor - EPS) {
    p = floor;
    floorApplied = true;
    flag('floor');
    say('floor', `Cena zvednuta na spodní hranici → ${fm(p)}`);
  }

  // --- 7. zaokrouhlení ------------------------------------------------------------------------
  // Kandidáti: `first` = bod podle nastaveného směru, `second` = nejbližší bod na druhé straně.
  //   - `first` se použije, pokud splní hranice (podlaha, strop), limit změny a neobrátí směr změny;
  //   - `second` (proti nastavenému směru) jen když `first` porušuje hranici nebo limit – jako SPEC krok 7
  //     („pod podlahou → nahoru“, „nad stropem → dolů“), rozšířeno o limit změny;
  //   - pak body odvozené od samotných hranic (viz `extras` níže);
  //   - jinak zůstává aktuální cena (je-li v mezích) – zaokrouhlení nesmí obrátit snížení na zdražení a naopak,
  //     ani překročit limit změny (u pásma …990 by jinak šlo až o ~1000 Kč nad povolený pokles);
  //   - když aktuální cena v mezích není, uvolňuje se od nejméně důležitého: limit změny, strop, nakonec jen
  //     podlaha (PODLAHA VŽDY VYHRÁVÁ).
  const dir = R.direction;
  const cand = priceCandidates(p, R);
  const first = roundPrice(p, R, dir);
  const second = first === cand.down ? cand.up : cand.down;
  const okFloor = (x) => floor == null || x >= floor - EPS;
  const okCeil = (x) => ceiling == null || x <= ceiling + EPS;
  // limit změny hlídáme jen tehdy, když cenu mimo limit už nevytlačila podlaha/strop
  const limitActive = p >= lo - EPS && p <= hi + EPS;
  const okLimit = (x) => !limitActive || (x >= lo - EPS && x <= hi + EPS);
  const okDir = (x) => cur == null || (p < cur - EPS ? x <= cur + EPS : p > cur + EPS ? x >= cur - EPS : true);
  const guard = (x) => okFloor(x) && okCeil(x) && okLimit(x);
  const why = (x) => (!okFloor(x) ? 'pod spodní hranicí' : !okCeil(x) ? 'nad horní hranicí' : !okLimit(x) ? 'mimo limit změny' : 'obrátilo by směr změny');
  // Body odvozené od hranic: pásmo se volí podle zaokrouhlované hodnoty (SPEC §6.6), takže u hranice pásem
  // leží nejbližší vyhovující bod v SOUSEDNÍM pásmu. Př.: podlaha 994,98, strop 1 031,82 → hodnota 1 031,82
  // je v pásmu …90 (body 990 a 1 090 – obě mimo hranice), ale bod 999 z pásma …9 vyhovuje. Bez těchto
  // kandidátů by doslovný krok 7 zvolil 1 090 = NAD stropem, přestože existuje cena v mezích.
  const extras = [];
  const addExtra = (x) => {
    if (x != null && Number.isFinite(x) && x > 0 && x !== first && x !== second && !extras.includes(x)) extras.push(x);
  };
  if (floor != null) addExtra(priceCandidates(floor, R).up);
  if (ceiling != null) addExtra(priceCandidates(ceiling, R).down);
  if (limitActive && Number.isFinite(lo) && lo > 0) addExtra(priceCandidates(lo, R).up);
  if (limitActive && Number.isFinite(hi)) addExtra(priceCandidates(hi, R).down);
  extras.sort((a, b) => Math.abs(a - p) - Math.abs(b - p) || a - b);
  const alternatives = second === first ? extras : [second, ...extras];
  let r;
  let keptReason = null; // ponechána aktuální cena, protože žádný cenový bod nesplňuje limity/směr
  let roundText = `${describeRounding(p, R, dir)} → ${fm(first)}`;
  const moved = (x) => `; ${why(first)} → ${x > first ? 'nahoru' : 'dolů'} na ${fm(x)}`;
  let alt;
  if (cur != null && Math.abs(p - cur) < CENT && within(cur)) {
    // cena po omezeních = aktuální cena → nezaokrouhlovat (jinak by vznikla změna jen kvůli zaokrouhlení)
    r = cur;
    roundText = `Cena po omezeních je rovna aktuální ceně ${fm(cur)} – bez zaokrouhlení`;
  } else if (guard(first) && okDir(first)) {
    r = first;
  } else if (!guard(first) && (alt = alternatives.find((x) => guard(x) && okDir(x))) !== undefined) {
    r = alt;
    roundText += moved(r);
  } else if (cur != null && within(cur)) {
    r = cur;
    keptReason = 'no_price_point';
    roundText += guard(first) ? '; to by obrátilo směr změny → ponechána aktuální cena' : `; ${why(first)} a jiný cenový bod limity nesplňuje → ponechána aktuální cena`;
    roundText += ` ${fm(cur)}`;
  } else {
    // aktuální cena porušuje hranice (nebo chybí): přednost má bod ve všech mezích, pak v podlaze i stropu,
    // nakonec jen nad podlahou
    const order = [first, ...alternatives];
    r = order.find(guard) ?? order.find((x) => okFloor(x) && okCeil(x));
    if (r === undefined && floor != null && ceiling != null && floor <= ceiling + EPS) {
      // Mezi spodní a horní hranicí není žádný cenový bod (např. podlaha 13 300, strop 13 400, pásmo …990).
      // Limity mají přednost před „hezkým“ zakončením (jako Disivo: limitní cena se použije nezaokrouhlená) –
      // cena v celých korunách co nejblíž cílové hodnotě, ale uvnitř [podlaha, strop].
      let x = Math.min(Math.max(Math.round(p), Math.ceil(floor - EPS)), Math.floor(ceiling + EPS));
      if (!(okFloor(x) && okCeil(x))) x = Math.min(Math.max(p, floor), ceiling);
      r = round(x, 2);
      flag('rounding_skipped');
      roundText += `; mezi spodní hranicí ${fm(floor)} a horní hranicí ${fm(ceiling)} není žádný cenový bod → nezaokrouhlená cena ${fm(r)}`;
    } else {
      if (r === undefined) r = order.find(okFloor);
      if (r === undefined) {
        r = cand.up;
        for (let i = 0; r < floor - EPS && i < 10000; i++) r = priceCandidates(r + 0.01, R).up;
      }
      if (r !== first) roundText += moved(r);
    }
  }
  say('rounding', roundText);
  const floorForcedUp = floor != null && (floorApplied || (cand.down < floor - EPS && r > p + EPS));
  if (floorForcedUp && r > hi + EPS) {
    flag('floor_over_change_limit');
    say('limits', `Spodní hranice vyžaduje cenu ${fm(r)}, to je nad povoleným limitem změny ${fm(hi)} – nutné ruční schválení`);
  }
  // Konzervativní rozšíření SPEC (zrcadlo floor_over_change_limit): pod limit změny cenu může dostat jen horní
  // hranice (krok 6: strop se uplatní po limitu změny; zaokrouhlení limit při cenách v mezích nikdy neporuší).
  // Takové snížení se nesmí schválit automaticky – ani když je menší než approval.auto_max_change_pct.
  if (cur != null && r < lo - EPS) {
    flag('ceiling_over_change_limit');
    say(
      'limits',
      !L.allow_decrease
        ? `Horní hranice vyžaduje snížení ceny na ${fm(r)}, i když strategie snižování nepovoluje – nutné ruční schválení`
        : `Horní hranice vyžaduje cenu ${fm(r)}, to je pod povoleným limitem změny ${fm(lo)} – nutné ruční schválení`
    );
  }
  // Mezi spodní a horní hranicí není žádný cenový bod (např. floor 13 300, strop 13 400, pásmo …990): podle
  // kroku 7 vyhrává podlaha a cena skončí NAD stropem. SPEC to jako konflikt neoznačuje (floor ≤ ceiling) –
  // konzervativně ho označíme limits_conflict, aby se překročení stropu nikdy neschválilo automaticky.
  if (ceiling != null && r > ceiling + EPS && !d.flags.includes('limits_conflict')) {
    flag('limits_conflict');
    say(
      'limits',
      floor != null
        ? `Mezi spodní hranicí ${fm(floor)} a horní hranicí ${fm(ceiling)} není žádný cenový bod – platí spodní hranice, cena ${fm(r)} je nad horní hranicí`
        : `Pod horní hranicí ${fm(ceiling)} není žádný kladný cenový bod – cena ${fm(r)} je nad horní hranicí`
    );
  }

  // --- 8. práh minimální změny ----------------------------------------------------------------
  if (cur != null && keptReason) {
    // zaokrouhlení nenašlo vhodný bod → aktuální cena zůstává (ne „pod prahem“ – ten by byl zavádějící)
    say('result', `Aktuální cena ${fm(cur)} zůstává beze změny`);
    return noChange(d, keptReason);
  }
  if (cur != null) {
    const diff = Math.abs(r - cur);
    const thr = Math.max(L.min_change_abs || 0, (cur * (L.min_change_pct || 0)) / 100);
    if (diff < thr - EPS && within(cur)) {
      d.new_price = r;
      say('threshold', `Změna ${fm(diff)} (${fp((diff / cur) * 100)}) je pod prahem ${fm(thr)} → beze změny`);
      return noChange(d, 'below_threshold');
    }
    if (diff < CENT) {
      say('result', `Nová cena je stejná jako aktuální (${fm(cur)}) → beze změny`);
      return noChange(d, 'same_price');
    }
  }

  // --- 9. výsledek ----------------------------------------------------------------------------
  d.action = 'change';
  d.reason = null;
  d.new_price = r;
  d.rank_after = rankOf(r, market);
  d.margin_after = marginPct(r, purchase, vat);
  if (cur != null) {
    d.change_abs = round(r - cur, 2);
    d.change_pct = round(((r - cur) / cur) * 100, 2);
  }
  if (purchase != null && net(r, vat) < purchase - EPS) {
    flag('below_cost');
    say('warning', `Pozor: nová cena ${fm(round(net(r, vat), 2))} bez DPH je pod nákupní cenou ${fm(purchase)}`);
  }
  if (A.auto_max_change_pct != null && d.change_pct != null && Math.abs(d.change_pct) > A.auto_max_change_pct + EPS) flag('big_change');

  let res = cur != null ? `Nová cena ${fm(r)} (${signed(d.change_pct, fp)}, ${signed(d.change_abs, fm)})` : `Nová cena ${fm(r)} (dosud bez ceny)`;
  if (d.margin_after != null) res += `, marže ${d.margin_before != null ? `${fp(d.margin_before)} → ` : ''}${fp(d.margin_after)}`;
  if (d.rank_after != null) res += `, pořadí ${d.rank_before != null ? `${d.rank_before} → ` : ''}${d.rank_after}`;
  say('result', res);

  // --- 10. schválení --------------------------------------------------------------------------
  if (A.auto) {
    const reasons = [];
    for (const f of BLOCKING_FLAGS) {
      if (!d.flags.includes(f)) continue;
      reasons.push(f === 'big_change' ? `velká změna (${fp(Math.abs(d.change_pct))} > ${fp(A.auto_max_change_pct)})` : FLAG_LABELS[f]);
    }
    // Nikdy automaticky nesnižovat cenu, když nelze ověřit marži.
    if (d.flags.includes('no_cost') && cur != null && r < cur) reasons.push('snížení ceny bez známé nákupní ceny');
    // Bez aktuální ceny nelze posoudit velikost změny → konzervativně ručně.
    if (cur == null) reasons.push('produkt dosud nemá cenu');
    if (!reasons.length) {
      d.auto_approve = true;
      say('approval', A.auto_max_change_pct != null ? `Automaticky schváleno (změna ${fp(Math.abs(d.change_pct))} ≤ ${fp(A.auto_max_change_pct)})` : 'Automaticky schváleno');
    } else {
      say('approval', `Nutné ruční schválení: ${reasons.join(', ')}`);
    }
  } else {
    say('approval', 'Návrh čeká na ruční schválení');
  }
  return d;
}

module.exports = {
  computePrice,
  formatMoney,
  formatPct,
  describeOffset,
  BLOCKING_FLAGS,
  FLAG_LABELS,
  REASON_LABELS,
  MARKET_MODES,
};
