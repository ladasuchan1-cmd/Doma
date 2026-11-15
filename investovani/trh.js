// Tržní data pro Investiční školu: kurz, průběh ceny a hledání titulů.
//
// Zdroj je veřejné rozhraní Yahoo Finance (bez klíče, neoficiální – může se změnit nebo přestat odpovídat).
// Všechno, co zbytek aplikace potřebuje, je objekt se třemi funkcemi (graf, kurz, hledej); jiný zdroj dat
// = jiná implementace téhož tvaru (viz `vytvor({ trh })` v server.js a testy).
// Odchází jen zkratka titulu, žádné údaje o uživateli.
'use strict';

const ROZSAHY = { '1d': ['1d', '5m', 60], '5d': ['5d', '30m', 300], '1mo': ['1mo', '1d', 1800], '6mo': ['6mo', '1d', 1800], '1y': ['1y', '1d', 1800] };
const SYM = /^[A-Z0-9][A-Z0-9.\-=^]{0,14}$/;
const platnySym = (s) => typeof s === 'string' && SYM.test(s);

function chyba(kod, zprava) { return Object.assign(new Error(zprava || kod), { kod }); }

function yahoo(opts = {}) {
  const stahni = opts.fetch || fetch;
  const ted = opts.ted || (() => Date.now());
  const cache = new Map();

  async function json(url) {
    let r;
    try { r = await stahni(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; investicni-skola)', Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }); }
    catch (e) { throw chyba('nedostupne', 'Zdroj cen neodpověděl.'); }
    if (r.status === 404) throw chyba('neznamy', 'Takový titul zdroj cen nezná.');
    if (r.status === 429) throw chyba('limit', 'Zdroj cen dočasně omezil počet dotazů.');
    if (!r.ok) throw chyba('nedostupne', 'Zdroj cen vrátil chybu ' + r.status + '.');
    try { return await r.json(); } catch (e) { throw chyba('nedostupne', 'Zdroj cen vrátil nečitelnou odpověď.'); }
  }

  // S mezipamětí: stejný dotaz jde ven nejvýš jednou za `ttl` sekund; když zdroj spadne, vrátí se poslední známá
  // data označená `stare: true` (nedostatek dat nesmí vyprázdnit přehled).
  async function sCache(klic, ttl, nacti) {
    const z = cache.get(klic), t = ted();
    if (z && z.data && t - z.kdy < ttl * 1000) return z.data;
    if (z && z.beh) return z.beh;
    const beh = nacti().then((data) => { cache.set(klic, { kdy: ted(), data }); return data; }, (e) => {
      if (z && z.data && e.kod !== 'neznamy') { cache.set(klic, { kdy: z.kdy, data: z.data }); return Object.assign({}, z.data, { stare: true }); }
      cache.delete(klic); throw e;
    });
    cache.set(klic, { kdy: z ? z.kdy : 0, data: z && z.data, beh });
    if (cache.size > 400) for (const [k, v] of cache) if (!v.beh && t - v.kdy > 3600 * 1000) cache.delete(k);
    return beh;
  }

  function graf(sym, rozsah = '1d') {
    if (!platnySym(sym)) return Promise.reject(chyba('neznamy', 'Neplatná zkratka titulu.'));
    const def = ROZSAHY[rozsah];
    if (!def) return Promise.reject(chyba('neznamy', 'Neznámý rozsah grafu.'));
    return sCache(sym + '|' + rozsah, def[2], async () => {
      const j = await json(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${def[0]}&interval=${def[1]}`);
      const r = j && j.chart && j.chart.result && j.chart.result[0];
      if (!r || !r.meta || typeof r.meta.regularMarketPrice !== 'number') throw chyba('neznamy', 'Pro tento titul zdroj cen nemá kurz.');
      const m = r.meta, ts = r.timestamp || [], c = (r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close) || [];
      const body = [];
      for (let i = 0; i < ts.length; i++) if (typeof c[i] === 'number' && isFinite(c[i])) body.push([ts[i], Math.round(c[i] * 10000) / 10000]);
      const obd = (m.currentTradingPeriod && m.currentTradingPeriod.regular) || {};
      return {
        sym, rozsah,
        nazev: m.longName || m.shortName || sym, burza: m.fullExchangeName || m.exchangeName || '', mena: m.currency || '', typ: m.instrumentType || '',
        cena: m.regularMarketPrice, cas: m.regularMarketTime || 0,
        predchozi: rozsah === '1d' ? (m.previousClose || m.chartPreviousClose || null) : (m.chartPreviousClose || null),
        denMin: m.regularMarketDayLow || null, denMax: m.regularMarketDayHigh || null,
        rokMin: m.fiftyTwoWeekLow || null, rokMax: m.fiftyTwoWeekHigh || null,
        obchodOd: obd.start || null, obchodDo: obd.end || null,
        body,
      };
    });
  }

  // Kurz = dnešní graf bez bodů, s řídkou křivkou pro náhled.
  async function kurz(sym) {
    const g = await graf(sym, '1d');
    const krok = Math.max(1, Math.ceil(g.body.length / 40));
    const nahled = g.body.filter((_, i) => i % krok === 0 || i === g.body.length - 1).map((b) => b[1]);
    const { body, rozsah, ...k } = g;
    return Object.assign(k, { nahled, zmena: g.predchozi ? g.cena / g.predchozi - 1 : null });
  }

  function hledej(q) {
    const dotaz = String(q || '').trim().slice(0, 40);
    if (dotaz.length < 2) return Promise.resolve([]);
    return sCache('hledej|' + dotaz.toLowerCase(), 3600, async () => {
      const j = await json(`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(dotaz)}&quotesCount=10&newsCount=0`);
      return ((j && j.quotes) || [])
        .filter((x) => x && platnySym(x.symbol) && (x.quoteType === 'EQUITY' || x.quoteType === 'ETF'))
        .slice(0, 8)
        .map((x) => ({ sym: x.symbol, nazev: x.longname || x.shortname || x.symbol, burza: x.exchDisp || '', typ: x.quoteType }));
    });
  }

  return { graf, kurz, hledej };
}

module.exports = { yahoo, platnySym, ROZSAHY };
