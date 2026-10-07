// Objednávky z e-shopu → počty podle PSČ. Zpracování běží v prohlížeči: z exportu (CSV / XLSX) se vezmou jen
// PSČ, obec, země, datum, částka a stav; na server odchází jen součty podle PSČ – žádná jména, adresy ani e-maily.
// Rozpozná i soubor, který už je sečtený („PSČ; počet objednávek“). UMD: v prohlížeči `MP.objednavky`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.objednavky = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERZE = 1;
  const MAX_PSC = 20000;

  function fold(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }

  // Sloupce a jejich rozpoznání podle názvu v hlavičce. Doručovací adresa má přednost před fakturační.
  const SLOUPCE = {
    psc: { re: /\b(psc|zip|zipcode|postcode|postal|postovni smerovaci)\b/, label: 'PSČ' },
    mesto: { re: /\b(mesto|obec|city|town|misto dodani|mesto dodani)\b/, label: 'Obec / město' },
    zeme: { re: /\b(zeme|stat|country|krajina)\b/, label: 'Země' },
    datum: { re: /\b(datum|date|vytvoreno|vytvorena|created|cas objednavky|datum objednavky|dne)\b/, label: 'Datum' },
    castka: { re: /\b(celkem|castka|cena|total|price|hodnota|obrat|trzba|suma|k uhrade)\b/, label: 'Částka' },
    pocet: { re: /\b(pocet|count|objednavek|orders|ks)\b/, label: 'Počet objednávek' },
    stav: { re: /\b(stav|status)\b/, label: 'Stav' },
    id: { re: /\b(cislo objednavky|c objednavky|objednavka|order|order id|order number|kod objednavky|doklad|cislo dokladu|id)\b/, label: 'Číslo objednávky' },
  };
  const DORUCENI = /\b(dodaci|doruc\w*|dodani|shipping|delivery|ship|prijemce)\b/;
  const FAKTURACE = /\b(fakturac\w*|billing|invoice|platce)\b/;

  // Index řádku s hlavičkou (první řádek, kde se pozná PSČ nebo obec) a mapování sloupců.
  function detectColumns(rows) {
    const limit = Math.min(rows.length, 15);
    for (let r = 0; r < limit; r++) {
      const head = (rows[r] || []).map(fold);
      const map = mapHeader(head);
      if (map.psc != null || map.mesto != null) return { hlavicka: r, sloupce: map, nazvy: rows[r].map((x) => String(x == null ? '' : x)) };
    }
    return { hlavicka: -1, sloupce: {}, nazvy: [] };
  }

  function mapHeader(head) {
    const out = {};
    for (const [key, def] of Object.entries(SLOUPCE)) {
      let best = null;
      head.forEach((h, i) => {
        if (!h || !def.re.test(h)) return;
        if (key === 'castka' && /\b(bez dph|dph sazba|sazba|doprav\w*|postovne|sleva|kurz)\b/.test(h) && !/\bcelkem\b/.test(h)) return;
        if (key === 'pocet' && /\b(polozek|kusu|ks)\b/.test(h) && !/objednav/.test(h)) return;
        if (key === 'id' && (/\b(psc|zip|zakaznik|customer|produkt|product|polozk|item|sku|ean)\b/.test(h))) return;
        if (key === 'mesto' && /\b(vydejni|vydej|pobock)\b/.test(h)) return;
        if (key === 'datum' && /\b(splatnost|dodani|expedice|zaplaceni|uhrady)\b/.test(h)) return;
        let score = 1;
        if (DORUCENI.test(h)) score += 2;
        if (FAKTURACE.test(h)) score -= 1;
        if (key === 'castka' && /\b(celkem|s dph|vc dph|vcetne dph|total)\b/.test(h)) score += 1;
        if (key === 'id' && /\b(cislo|number|kod)\b/.test(h)) score += 1;
        if (h === key || h === fold(def.label)) score += 1;
        if (!best || score > best.score) best = { i, score };
      });
      if (best) out[key] = best.i;
    }
    // „Počet objednávek“ obsahuje slovo objednávek → nesmí být zároveň číslem objednávky
    if (out.id != null && out.id === out.pocet) delete out.id;
    if (out.castka != null && out.castka === out.pocet) delete out.castka;
    return out;
  }

  // PSČ → „12345“; null když to není české PSČ (česká PSČ začínají 1–7, slovenská 0, 8 a 9).
  function normPsc(v) {
    if (v == null) return null;
    let s = String(v).trim();
    if (typeof v === 'number') s = String(Math.round(v));
    s = s.replace(/^(cz|cz-|cze)\s*/i, '').replace(/[\s .-]/g, '');
    if (!/^\d{5}$/.test(s)) return null;
    return /^[1-7]/.test(s) ? s : null;
  }

  function jeZahranicniPsc(v) {
    const s = String(v == null ? '' : v).replace(/[\s ]/g, '');
    return /^\d{5}$/.test(s) && /^[089]/.test(s);
  }

  // Země prázdná nebo Česko → true.
  function jeCesko(v) {
    const f = fold(v);
    if (!f) return true;
    return /^(cz|cze|cr|ceska|cesko|czech|czechia|ceska republika)\b/.test(f) || f === '203';
  }

  // Částka „1 234,50 Kč“ / „1234.5“ / číslo → číslo (null = nečitelná).
  function normCastka(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).replace(/ /g, ' ').replace(/(kč|czk|eur|€|,-)/gi, '').trim();
    s = s.replace(/\s+/g, '');
    if (/^-?\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
    else if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, '');
    else s = s.replace(',', '.');
    if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }

  // Datum → „YYYY-MM-DD“ (ISO, „14.03.2025“, „14. 3. 2025 10:22“, sériové číslo Excelu).
  function normDatum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') {
      if (v > 20000 && v < 80000) {
        const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
        return d.toISOString().slice(0, 10);
      }
      return null;
    }
    const s = String(v).trim();
    let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
    if (m) return iso(m[1], m[2], m[3]);
    m = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s);
    if (m) return iso(m[3], m[2], m[1]);
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s); // US m/d/yyyy z některých exportů
    if (m) return iso(m[3], m[1], m[2]);
    return null;
  }

  function iso(y, mo, d) {
    const Y = Number(y);
    const M = Number(mo);
    const D = Number(d);
    if (Y < 2000 || Y > 2100 || M < 1 || M > 12 || D < 1 || D > 31) return null;
    return `${Y}-${String(M).padStart(2, '0')}-${String(D).padStart(2, '0')}`;
  }

  const STORNO = /storn|zrusen|cancel|vracen|refund|nevyzvednut|nezaplacen|odmitnut|smazan/;

  // Sečte řádky exportu podle PSČ. rows = pole řádků (pole buněk), sl = mapování sloupců (index).
  // Řádky jedné objednávky (export po položkách) se počítají jednou podle čísla objednávky.
  function secti(rows, sl, opts) {
    const o = opts || {};
    const start = o.odRadku == null ? 1 : o.odRadku;
    const out = { radku: 0, objednavek: 0, psc: {}, mesta: {}, zahranici: 0, storno: 0, bezAdresy: 0, od: null, do: null, castky: false, sectene: false };
    const cell = (row, key) => (sl[key] == null ? undefined : row[sl[key]]);
    const sectene = sl.pocet != null && sl.id == null && sl.datum == null;
    out.sectene = sectene;
    const videne = new Map(); // id objednávky → { klic, castka, stejna }
    const vynechane = new Set(); // id objednávek už započtených jako storno / zahraničí (export po položkách)
    const idOf = (row) => (sl.id != null ? String(cell(row, 'id') == null ? '' : cell(row, 'id')).trim() : '');
    const vynech = (row, co) => {
      const id = idOf(row);
      if (id) {
        if (vynechane.has(id)) return;
        vynechane.add(id);
      }
      out[co]++;
    };
    for (let r = start; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.some((c) => c != null && String(c).trim() !== '')) continue;
      out.radku++;
      if (sl.stav != null && STORNO.test(fold(cell(row, 'stav')))) {
        vynech(row, 'storno');
        continue;
      }
      const rawPsc = cell(row, 'psc');
      if ((sl.zeme != null && !jeCesko(cell(row, 'zeme'))) || jeZahranicniPsc(rawPsc)) {
        vynech(row, 'zahranici');
        continue;
      }
      const psc = normPsc(rawPsc);
      const mesto = String(cell(row, 'mesto') == null ? '' : cell(row, 'mesto')).trim();
      let n = 1;
      if (sectene) {
        const p = normCastka(cell(row, 'pocet'));
        if (p == null || p <= 0) continue;
        n = Math.round(p);
      }
      const castka = sl.castka != null ? normCastka(cell(row, 'castka')) : null;
      const klic = psc ? 'p' + psc : mesto ? 'm' + fold(mesto) : null;
      if (!klic) {
        out.bezAdresy += n;
        continue;
      }
      const id = idOf(row);
      if (id) {
        const prev = videne.get(id);
        if (prev) {
          // další řádek téže objednávky: částka buď opakuje celkovou cenu (nepřičítat), nebo je za položku (přičíst)
          if (castka != null && prev.klic === klic) {
            if (prev.stejna && castka === prev.prvni) prev.duplicitni.push(castka);
            else {
              prev.stejna = false;
              pridej(out, klic, mesto, 0, castka + prev.duplicitni.reduce((a, b) => a + b, 0));
              prev.duplicitni = [];
            }
          }
          continue;
        }
        videne.set(id, { klic, prvni: castka, stejna: true, duplicitni: [] });
      }
      pridej(out, klic, mesto, n, castka);
      out.objednavek += n;
      const d = sl.datum != null ? normDatum(cell(row, 'datum')) : null;
      if (d) {
        if (!out.od || d < out.od) out.od = d;
        if (!out.do || d > out.do) out.do = d;
      }
    }
    return out;
  }

  function pridej(out, klic, mesto, n, castka) {
    const tgt = klic[0] === 'p' ? out.psc : out.mesta;
    const k = klic.slice(1);
    let e = tgt[k];
    if (!e) {
      e = tgt[k] = { n: 0, kc: 0 };
      if (klic[0] === 'm') e.nazev = mesto;
    }
    e.n += n;
    if (castka != null && Number.isFinite(castka)) {
      e.kc += castka;
      out.castky = true;
    }
  }

  // Obce bez PSČ → PSČ podle názvu (index fold(název obce) → PSČ). Vrací konečné součty { psc: { n, kc } } a co nešlo.
  function priradit(souhrn, pscData, obecKPsc) {
    const out = {};
    let nezarazeno = 0;
    let neznamePsc = 0;
    const add = (psc, e) => {
      const t = out[psc] || (out[psc] = { n: 0, kc: 0 });
      t.n += e.n;
      t.kc += e.kc || 0;
    };
    for (const [psc, e] of Object.entries(souhrn.psc)) {
      if (pscData && !pscData[psc]) {
        // neznámé PSČ (např. P. O. Box nebo nové) – zkusit první tři číslice (stejná pošta / okolí)
        const near = pscData && Object.keys(pscData).find((k) => k.slice(0, 3) === psc.slice(0, 3));
        if (near) add(near, e);
        else {
          neznamePsc += e.n;
          nezarazeno += e.n;
        }
        continue;
      }
      add(psc, e);
    }
    for (const [k, e] of Object.entries(souhrn.mesta)) {
      const psc = obecKPsc && (obecKPsc.get ? obecKPsc.get(k) : obecKPsc[k]);
      if (psc) add(psc, e);
      else nezarazeno += e.n;
    }
    for (const e of Object.values(out)) e.kc = Math.round(e.kc);
    return { psc: out, nezarazeno, neznamePsc };
  }

  // Obálka pro uložení na server: jen součty podle PSČ.
  function dataset(prirazeno, souhrn, meta) {
    const m = meta || {};
    const mista = Object.entries(prirazeno.psc)
      .filter(([psc, e]) => /^\d{5}$/.test(psc) && e.n > 0)
      .map(([psc, e]) => ({ psc, n: e.n, kc: souhrn.castky ? e.kc : 0 }))
      .sort((a, b) => b.n - a.n);
    return {
      app: 'mapa-prodejen',
      verze: VERZE,
      nazev: String(m.nazev || '').slice(0, 120),
      soubor: String(m.soubor || '').slice(0, 200),
      nahrano: m.nahrano || new Date().toISOString(),
      kdo: String(m.kdo || '').slice(0, 60),
      od: souhrn.od || null,
      do: souhrn.do || null,
      objednavek: mista.reduce((s, x) => s + x.n, 0),
      castky: Boolean(souhrn.castky),
      nezarazeno: prirazeno.nezarazeno + souhrn.bezAdresy,
      zahranici: souhrn.zahranici,
      storno: souhrn.storno,
      mista,
    };
  }

  // Kontrola datasetu přijatého serverem / načteného ze souboru. Vrací { data } nebo { chyba }.
  function validovat(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.mista)) return { chyba: 'Chybí seznam „mista“ (součty podle PSČ).' };
    if (obj.mista.length > MAX_PSC) return { chyba: 'Příliš mnoho PSČ (' + obj.mista.length + ').' };
    const mista = [];
    const seen = new Set();
    for (const x of obj.mista) {
      if (!x || typeof x !== 'object') continue;
      const psc = normPsc(x.psc);
      const n = Math.round(Number(x.n));
      const kc = Math.round(Number(x.kc) || 0);
      if (!psc || !Number.isFinite(n) || n <= 0 || n > 1e7 || seen.has(psc)) continue;
      if (Object.keys(x).some((k) => !['psc', 'n', 'kc'].includes(k))) return { chyba: 'Položka obsahuje jiné údaje než PSČ, počet a částku – osobní údaje se na server neposílají.' };
      seen.add(psc);
      mista.push({ psc, n, kc: kc > 0 && kc < 1e12 ? kc : 0 });
    }
    const date = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.round(Number(v)) : 0);
    return {
      data: {
        app: 'mapa-prodejen',
        verze: VERZE,
        nazev: String(obj.nazev || '').slice(0, 120),
        soubor: String(obj.soubor || '').slice(0, 200),
        nahrano: typeof obj.nahrano === 'string' && !Number.isNaN(Date.parse(obj.nahrano)) ? obj.nahrano : new Date().toISOString(),
        kdo: String(obj.kdo || '').slice(0, 60),
        od: date(obj.od),
        do: date(obj.do),
        objednavek: mista.reduce((s, x) => s + x.n, 0),
        castky: Boolean(obj.castky),
        nezarazeno: num(obj.nezarazeno),
        zahranici: num(obj.zahranici),
        storno: num(obj.storno),
        mista,
      },
    };
  }

  return { VERZE, SLOUPCE, fold, detectColumns, mapHeader, normPsc, jeCesko, normCastka, normDatum, secti, priradit, dataset, validovat };
});
