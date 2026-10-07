// Objednávky a zákazníci → součty podle PSČ. Zpracování běží v prohlížeči: z exportu e-shopu (CSV / XLSX) nebo
// z tabulky vložené ze schránky (Excel, kontingenční tabulky) se vezmou jen PSČ, obec, země, datum, částka, stav
// a počty; na server odchází jen součty podle PSČ – žádná jména, adresy ani e-maily.
// Rozpozná hotové přehledy („PSČ; počet objednávek“), kontingenční tabulky (nadpis a filtry nad tabulkou, řádky
// „Celkem“ a „Celkový součet“, dvě tabulky vedle sebe, kompaktní forma bez opakovaných popisků) a kromě objednávek
// i počty zákazníků a aktivních zákazníků. UMD: v prohlížeči `MP.objednavky`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.objednavky = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERZE = 2;
  const MAX_PSC = 20000;
  const RADKU_HLAVICKY = 60; // v kolika prvních řádcích se hledá záhlaví (nad ním bývá nadpis a filtry)

  // Sledované počty. `sloupec` = klíč v SLOUPCE, odkud se počet bere. Částka (kc) se sleduje zvlášť.
  const METRIKY = [
    { key: 'n', sloupec: 'pocet', nadpis: 'Objednávky', mn: 'objednávek', instr: 'objednávkami', kratce: 'obj.' },
    { key: 'zak', sloupec: 'zak', nadpis: 'Zákazníci', mn: 'zákazníků', instr: 'zákazníky', kratce: 'zák.' },
    { key: 'akt', sloupec: 'akt', nadpis: 'Aktivní zákazníci', mn: 'aktivních zákazníků', instr: 'aktivními zákazníky', kratce: 'akt. zák.' },
  ];
  const METRIKA = Object.fromEntries(METRIKY.map((m) => [m.key, m]));
  const KLICE_METRIK = METRIKY.map((m) => m.key);

  function fold(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
  }
  // malými písmeny, s diakritikou (na rozlišení např. slovenské Modry od moravské Modré)
  function male(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Sloupce a jejich rozpoznání podle názvu v záhlaví. Doručovací adresa má přednost před fakturační.
  const SLOUPCE = {
    psc: { re: /\b(psc|zip|zipcode|postcode|postal|postovni smerovaci)\b/, label: 'PSČ' },
    mesto: { re: /\b(mesto|obec|city|town|misto dodani|mesto dodani)\b/, label: 'Obec / město' },
    zeme: { re: /\b(zeme|stat|country|krajina)\b/, label: 'Země' },
    datum: { re: /\b(datum|date|vytvoreno|vytvorena|created|cas objednavky|datum objednavky|dne)\b/, label: 'Datum' },
    castka: { re: /\b(celkem|castka|cena|total|price|hodnota|obrat|trzba|suma|k uhrade)\b/, label: 'Částka / hodnota (Kč)' },
    pocet: { re: /\b(pocet|count|objednavek|objednavky|orders|ks)\b/, label: 'Počet objednávek' },
    zak: { re: /\b(zakaznik\w*|customers?|klient\w*)\b/, label: 'Počet zákazníků' },
    akt: { re: /\b(aktivni\w*|active)\b/, label: 'Aktivní zákazníci' },
    stav: { re: /\b(stav|status)\b/, label: 'Stav' },
    id: { re: /\b(cislo objednavky|c objednavky|objednavka|order|order id|order number|kod objednavky|doklad|cislo dokladu|id)\b/, label: 'Číslo objednávky' },
  };
  const DORUCENI = /\b(dodaci|doruc\w*|dodani|shipping|delivery|ship|prijemce)\b/;
  const FAKTURACE = /\b(fakturac\w*|billing|invoice|platce)\b/;
  const PRUMER = /\b(prumer\w*|average|avg|median|podil|procent\w*)\b/;
  const SOUCET_SLOUPEC = /^(celkovy soucet|grand total)$/; // sloupec součtu v křížové kontingenční tabulce
  const METRICKE = ['pocet', 'zak', 'akt', 'castka', 'soucet'];
  // hodnota filtru kontingenční tabulky („Země | (Vše)“) – takový řádek není záhlaví
  const FILTR = /^\((vše|vse|více položek|vice polozek|all|multiple items)\)$/i;

  // Mapování buněk záhlaví (už prošlých fold) na sloupce: { klíč: index }.
  function mapHeader(head) {
    const out = {};
    for (const [key, def] of Object.entries(SLOUPCE)) {
      let best = null;
      head.forEach((h, i) => {
        if (!h || !def.re.test(h)) return;
        if (key === 'castka' && /\b(bez dph|dph sazba|sazba|doprav\w*|postovne|sleva|kurz)\b/.test(h) && !/\bcelkem\b/.test(h)) return;
        if ((key === 'castka' || key === 'pocet' || key === 'zak' || key === 'akt') && PRUMER.test(h)) return;
        if (key === 'pocet' && /\b(polozek|kusu|ks)\b/.test(h) && !/objednav/.test(h)) return;
        if (key === 'pocet' && /\b(zakaznik\w*|customers?|klient\w*|aktivni\w*|active|hodnota|castka|cena|trzba|obrat|kc|czk)\b/.test(h)) return;
        if (key === 'pocet' && /(^c |\b(cislo|kod|number|id|stav|status)\b)/.test(h)) return; // „Číslo objednávky“, „Stav objednávky“
        if (key === 'zak' && /\b(aktivni\w*|active)\b/.test(h)) return;
        if (key === 'id' && (/\b(psc|zip|zakaznik|customer|produkt|product|polozk|item|sku|ean|pocet|hodnota|castka)\b/.test(h) || PRUMER.test(h))) return;
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
    const s = head.findIndex((h) => SOUCET_SLOUPEC.test(h || ''));
    if (s >= 0 && !Object.values(out).includes(s)) out.soucet = s;
    return out;
  }

  // ------------------------------------------------------------------ hodnoty buněk
  // Prázdná nebo „neuvedená“ hodnota (kontingenční tabulky píšou „(neuvedeno)“, „(prázdné)“).
  function jePrazdne(v) {
    if (v == null) return true;
    const f = fold(v);
    return !f || /^(neuvedeno|neuvedena|neuveden|nezadano|nevyplneno|prazdne|blank|empty|none|null|undefined|n a|nan)$/.test(f);
  }

  // PSČ → „12345“; null když to není české PSČ (česká PSČ začínají 1–7, slovenská 0, 8 a 9).
  function normPsc(v) {
    const p = pscForma(v);
    return p.forma === 'cz' ? p.kod : null;
  }

  // Tvar PSČ: cz (5 číslic, 1–7), cizi (5 číslic 0/8/9, polské NN-NNN, předpona státu), 4 (4 číslice – rakouské,
  // švýcarské, nebo české s chybějící nulou), jine (nečitelné), '' (prázdné).
  function pscForma(v) {
    if (v == null) return { forma: '', kod: '' };
    let s = typeof v === 'number' ? String(Math.round(v)) : String(v).trim();
    if (jePrazdne(s)) return { forma: '', kod: '' };
    if (/^\d{2}-\d{3}$/.test(s)) return { forma: 'cizi', kod: s.replace('-', '') };
    if (/^(sk|d|de|a|at|pl|h|hu)[\s-]+\d/i.test(s)) return { forma: 'cizi', kod: s.replace(/\D/g, '') };
    s = s.replace(/^(cz|cze|cs)[\s-]*/i, '');
    const d = s.replace(/[\s .  -]/g, '');
    if (/^\d{5}$/.test(d)) return /^[1-7]/.test(d) ? { forma: 'cz', kod: d } : { forma: 'cizi', kod: d };
    if (/^\d{4}$/.test(d)) return { forma: '4', kod: d };
    return { forma: 'jine', kod: d.slice(0, 12) };
  }

  function jeZahranicniPsc(v) {
    return pscForma(v).forma === 'cizi';
  }

  // Země prázdná nebo Česko → true.
  function jeCesko(v) {
    const f = fold(v);
    if (!f) return true;
    return /^(cz|cze|cr|ceska|cesko|czech|czechia|ceska republika)\b/.test(f) || f === '203';
  }

  // Částka / počet „1 234,50 Kč“ / „15 743 032“ / „1234.5“ / číslo → číslo (null = nečitelná).
  function normCastka(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    let s = String(v).replace(/ | /g, ' ').replace(/(kč|czk|eur|€|,-)/gi, '').trim();
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
  // řádek součtu: „Celkem“, „Praha Celkem“, „CZ Celkem“, „Celkový součet“, „Grand Total“
  const CELKEM = /(^|\s)(celkem|celkovy soucet|soucet|total|grand total|subtotal|mezisoucet)$/;
  const CELKOVY = /^(celkem|celkovy soucet|soucet|total|grand total)$/;

  const text = (v) => (v == null ? '' : String(v).trim());
  const jeCislo = (v) => normCastka(v) != null;
  const nula = () => ({ n: 0, zak: 0, akt: 0, kc: 0 });
  function pricti(t, e) {
    t.n += e.n || 0;
    t.zak += e.zak || 0;
    t.akt += e.akt || 0;
    t.kc += e.kc || 0;
    return t;
  }

  // ------------------------------------------------------------------ rozpoznání tabulek
  // Úseky řádku r: souvislé sloupce oddělené prázdným sloupcem (prázdný v záhlaví i v ~20 řádcích pod ním).
  function useky(rows, r) {
    const pod = rows.slice(r + 1, r + 21);
    const sirka = Math.max((rows[r] || []).length, ...pod.map((x) => (x ? x.length : 0)), 0);
    const out = [];
    let od = -1;
    for (let c = 0; c <= sirka; c++) {
      const pouzity = c < sirka && (text((rows[r] || [])[c]) !== '' || pod.some((x) => x && text(x[c]) !== ''));
      if (pouzity && od < 0) od = c;
      if (!pouzity && od >= 0) {
        out.push({ od, do: c - 1 });
        od = -1;
      }
    }
    return out;
  }

  // Sloupce s popisky (země, skupina, obec, PSČ…) = sloupce zleva až po první sloupec s čísly (počet, částka,
  // hodnoty křížové tabulky – roky, cenové skupiny). blok.ciselne = sloupce, kde jsou v datech čísla.
  function popiskyBloku(blok, sl) {
    const metricke = new Set(METRICKE.map((k) => sl[k]).filter((c) => c != null));
    const mista = ['mesto', 'psc', 'zeme'].map((k) => sl[k]).filter((c) => c != null);
    const out = [];
    const konec = blok.do == null ? Math.max(-1, ...metricke, ...mista) : blok.do;
    for (let c = blok.od; c <= konec; c++) {
      if (metricke.has(c)) break;
      if ([sl.id, sl.datum, sl.stav].includes(c)) continue;
      if (mista.includes(c)) {
        out.push(c);
        continue;
      }
      const nazev = String((blok.nazvy || [])[c - blok.od] || '').trim();
      if (/^\d{4}$/.test(nazev) || (blok.ciselne && blok.ciselne.has(c))) break;
      out.push(c);
    }
    return out;
  }

  // Je řádek r v úseku záhlavím tabulky? Vrací popis bloku nebo null.
  function hlavickaBloku(rows, r, usek) {
    const row = rows[r] || [];
    const bunky = [];
    for (let c = usek.od; c <= usek.do; c++) bunky.push(text(row[c]));
    const plne = bunky.filter(Boolean);
    if (plne.length < 2) return null;
    // nadpis, filtr („Obec | Praha“, „Země | (Vše)“) nebo datový řádek („Praha | 160 00 | 2 826“) není záhlaví
    if (plne.some((s) => s.length > 60 || FILTR.test(s) || (jeCislo(s) && !/^(19|20)\d\d$/.test(s)))) return null;
    const rel = mapHeader(bunky.map(fold));
    if (rel.psc == null && rel.mesto == null) return null;
    if (Object.keys(rel).length < 2) return null;
    const sl = {};
    for (const [k, i] of Object.entries(rel)) sl[k] = i + usek.od;
    // data pod záhlavím (na kontrolu, že sloupce s počty obsahují čísla)
    const data = [];
    for (let rr = r + 1; rr < Math.min(rows.length, r + 200) && data.length < 40; rr++) {
      const x = rows[rr] || [];
      let plny = false;
      for (let c = usek.od; c <= usek.do; c++) if (text(x[c]) !== '') plny = true;
      if (plny) data.push(x);
    }
    // sloupce s počty a částkami musí obsahovat čísla (jinak jde o text, např. jméno zákazníka)
    for (const k of METRICKE) {
      if (sl[k] == null) continue;
      let cisel = 0;
      let jinych = 0;
      for (const x of data) {
        const v = text(x[sl[k]]);
        if (!v || jePrazdne(v)) continue;
        if (jeCislo(v)) cisel++;
        else jinych++;
      }
      if (jinych > cisel) delete sl[k];
    }
    if (sl.psc == null && sl.mesto == null) return null;
    if (Object.keys(sl).length < 2) return null;
    // sloupec „Celkový součet“ křížové tabulky: co sčítá, napoví popisek nad tabulkou („Počet objednávek“)
    if (sl.soucet != null) {
      if (sl.pocet == null && sl.zak == null && sl.akt == null) {
        let druh = null;
        for (let rr = r - 1; rr >= Math.max(0, r - 15) && !druh; rr--) {
          for (let c = usek.od; c <= usek.do && !druh; c++) {
            const f = fold((rows[rr] || [])[c]);
            if (!f) continue;
            if (SLOUPCE.akt.re.test(f)) druh = 'akt';
            else if (SLOUPCE.zak.re.test(f)) druh = 'zak';
            else if (/\b(pocet objednavek|objednav\w*|orders?)\b/.test(f)) druh = 'pocet';
            else if (SLOUPCE.castka.re.test(f)) druh = 'castka';
          }
        }
        druh = druh || 'pocet';
        if (sl[druh] == null) sl[druh] = sl.soucet;
      }
      delete sl.soucet;
    }
    const ciselne = new Set();
    for (let c = usek.od; c <= usek.do; c++) {
      let cisel = 0;
      let jinych = 0;
      for (const x of data) {
        const v = text(x[c]);
        if (!v || jePrazdne(v)) continue;
        if (jeCislo(v)) cisel++;
        else jinych++;
      }
      if (cisel > jinych) ciselne.add(c);
    }
    const blok = { hlavicka: r, od: usek.od, do: usek.do, sloupce: sl, nazvy: bunky, ciselne };
    blok.zemeOdhad = sl.zeme != null && /\b(odhad\w*|estimat\w*|guess\w*)\b/.test(fold(bunky[sl.zeme - usek.od]));
    blok.popisky = popiskyBloku(blok, sl);
    return blok;
  }

  // Všechny tabulky (bloky) v řádcích: záhlaví se hledá v prvních ~60 řádcích, vedle sebe může být víc tabulek.
  function rozpoznat(rows) {
    const bloky = [];
    const limit = Math.min(rows.length, RADKU_HLAVICKY);
    for (let r = 0; r < limit; r++) {
      for (const u of useky(rows, r)) {
        if (bloky.some((b) => r > b.hlavicka && u.od <= b.do && u.do >= b.od)) continue; // data už nalezené tabulky
        const b = hlavickaBloku(rows, r, u);
        if (b) bloky.push(b);
      }
    }
    bloky.sort((a, b) => a.od - b.od || a.hlavicka - b.hlavicka);
    bloky.forEach((b, i) => {
      b.index = i;
      b.maPsc = b.sloupce.psc != null;
    });
    return bloky;
  }

  // Zpětně kompatibilní: první nalezená tabulka { hlavicka, sloupce, nazvy } (nazvy = celé záhlaví).
  function detectColumns(rows) {
    const b = rozpoznat(rows)[0];
    if (!b) return { hlavicka: -1, sloupce: {}, nazvy: [] };
    return { hlavicka: b.hlavicka, sloupce: b.sloupce, nazvy: (rows[b.hlavicka] || []).map((x) => String(x == null ? '' : x)) };
  }

  // Písmeno sloupce Excelu (0 → A, 26 → AA).
  function pismeno(c) {
    let s = '';
    let n = c + 1;
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  // ------------------------------------------------------------------ součty
  // Sečte řádky jedné tabulky. rows = pole řádků (pole buněk), sl = mapování sloupců (absolutní indexy).
  // opts: odRadku (první datový řádek), od / do (sloupce tabulky), popisky (sloupce s popisky), zemeOdhad.
  // Hotový přehled (sloupec s počtem, bez čísla objednávky a data) se sčítá; export po objednávkách se počítá
  // po objednávkách (řádky jedné objednávky podle čísla objednávky jednou).
  function secti(rows, sl, opts) {
    const o = opts || {};
    const start = o.odRadku == null ? 1 : o.odRadku;
    const od = o.od == null ? 0 : o.od;
    const doo = o.do == null ? Infinity : o.do;
    const pocty = METRIKY.filter((m) => sl[m.sloupec] != null).map((m) => m.key);
    const sectene = pocty.length > 0 && sl.id == null && sl.datum == null;
    const popisky = o.popisky || (sectene ? popiskyBloku({ od, nazvy: [] }, sl) : []);
    const out = {
      radku: 0,
      sectene,
      metriky: sectene ? pocty : ['n'],
      castky: false,
      maPsc: sl.psc != null,
      zaznamy: new Map(), // klíč → { zeme, forma, kod, mesto, mk, n, zak, akt, kc }
      bezAdresy: nula(),
      storno: nula(),
      soucet: nula(), // součet započtených řádků (na kontrolu s řádkem „Celkový součet“)
      celkovySoucet: null,
      skupiny: new Map(), // obec → součet všech jejích řádků (rozpad velkých měst podle PSČ)
      dukaz: new Map(), // obec → { cz, cizi } podle tvaru PSČ (pro řádky jen s názvem obce)
      od: null,
      do: null,
    };
    const cell = (row, key) => (sl[key] == null ? undefined : row[sl[key]]);
    const vBloku = (row) => {
      for (let c = od; c <= Math.min(doo, row.length - 1); c++) if (text(row[c]) !== '') return true;
      return false;
    };
    const cislo = (row, key) => {
      if (sl[key] == null) return 0;
      const v = normCastka(row[sl[key]]);
      return v != null && v > 0 ? v : 0;
    };
    const hodnoty = (row) => ({ n: Math.round(cislo(row, 'pocet')), zak: Math.round(cislo(row, 'zak')), akt: Math.round(cislo(row, 'akt')), kc: cislo(row, 'castka') });
    // řádek součtu? 'celkovy' (Celkový součet – konec tabulky) | 'dilci' (Praha Celkem, CZ Celkem) | null
    const celkem = (row) => {
      let prvni = null;
      for (let c = od; c <= Math.min(doo, row.length - 1) && prvni == null; c++) if (text(row[c]) !== '') prvni = c;
      const kandidati = sectene ? popisky.slice() : [];
      if (prvni != null && !kandidati.includes(prvni)) kandidati.unshift(prvni);
      let nalez = null;
      for (const c of kandidati) {
        const f = fold(row[c]);
        if (!f || !CELKEM.test(f)) continue;
        const ostatni = popisky.some((d) => d !== c && text(row[d]) !== '');
        if (c === prvni && CELKOVY.test(f) && !ostatni) return 'celkovy';
        nalez = 'dilci';
      }
      // v exportu po objednávkách je řádek s adresou vždy objednávka
      if (nalez && !sectene && (text(cell(row, 'psc')) || text(cell(row, 'mesto')))) return null;
      return nalez;
    };
    const plnit = sectene ? popisky.slice(0, -1) : []; // kompaktní forma: prázdný vnější popisek = jako o řádek výš
    const vnitrni = sectene && popisky.length > 1 ? popisky[popisky.length - 1] : null;
    const posledni = new Map();
    const videne = new Map(); // id objednávky → { klic, prvni, stejna, duplicitni }
    const vynechane = new Set();
    const idOf = (row) => (sl.id != null ? text(cell(row, 'id')) : '');
    const zaznamy = out.zaznamy;
    const pridej = (klic, z, e) => {
      let t = zaznamy.get(klic);
      if (!t) zaznamy.set(klic, (t = { ...z, n: 0, zak: 0, akt: 0, kc: 0 }));
      pricti(t, e);
    };
    for (let r = start; r < rows.length; r++) {
      if (!rows[r] || !vBloku(rows[r])) continue;
      const row = plnit.length ? rows[r].slice() : rows[r]; // doplňování popisků nesmí měnit vstup
      const tc = celkem(row);
      if (tc) {
        if (tc === 'celkovy') {
          out.celkovySoucet = sectene ? hodnoty(row) : null;
          break;
        }
        posledni.clear();
        continue;
      }
      let e;
      if (sectene) {
        e = hodnoty(row);
        if (!e.n && !e.zak && !e.akt) continue;
        // mezisoučet nad skupinou (popisek obce, prázdné PSČ, další řádky pokračují bez popisku obce)
        if (vnitrni != null && text(row[vnitrni]) === '' && plnit.some((c) => text(row[c]) !== '')) {
          let dalsi = null;
          for (let rr = r + 1; rr < rows.length && !dalsi; rr++) if (rows[rr] && vBloku(rows[rr])) dalsi = rows[rr];
          if (dalsi && text(dalsi[vnitrni]) !== '' && plnit.some((c) => text(row[c]) !== '' && text(dalsi[c]) === '')) continue;
        }
        for (const c of plnit) {
          if (text(row[c]) === '') {
            if (posledni.has(c)) row[c] = posledni.get(c);
          } else posledni.set(c, row[c]);
        }
      } else {
        if (sl.stav != null && STORNO.test(fold(cell(row, 'stav')))) {
          const id = idOf(row);
          if (!id || !vynechane.has(id)) {
            if (id) vynechane.add(id);
            out.storno.n++;
          }
          continue;
        }
        e = { n: 1, zak: 0, akt: 0, kc: 0 };
      }
      out.radku++;
      const zemeRaw = cell(row, 'zeme');
      const zeme = sl.zeme == null || jePrazdne(zemeRaw) ? '' : jeCesko(zemeRaw) ? 'cz' : 'cizi';
      const p = sl.psc != null ? pscForma(cell(row, 'psc')) : { forma: '', kod: '' };
      let mesto = text(cell(row, 'mesto'));
      if (jePrazdne(mesto)) mesto = '';
      const mk = fold(mesto);
      if (mk) {
        const ev = out.dukaz.get(mk) || { cz: 0, cizi: 0 };
        if (p.forma === 'cizi' || (zeme === 'cizi' && !o.zemeOdhad)) ev.cizi++;
        else if (p.forma === 'cz') ev.cz++;
        out.dukaz.set(mk, ev);
      }
      if (sectene) {
        pricti(out.soucet, e);
        if (sl.castka != null && e.kc) out.castky = true;
        if (out.maPsc && mk) {
          const g = out.skupiny.get(mk) || { nazev: mesto, ...nula() };
          pricti(g, e);
          out.skupiny.set(mk, g);
        }
      }
      if (!p.kod && !mk && zeme !== 'cizi') {
        if (!sectene) {
          const id = idOf(row);
          if (id) {
            if (videne.has(id)) continue;
            videne.set(id, { klic: null });
          }
          pricti(out.soucet, e);
        }
        pricti(out.bezAdresy, e);
        continue;
      }
      // klíč s diakritikou: slovenská „Modra“ a moravská „Modrá“ jsou různá místa
      const klic = `${zeme}|${p.forma}|${p.kod}|${male(mesto)}`;
      const z = { zeme, forma: p.forma, kod: p.kod, mesto, mk };
      if (sectene) {
        pridej(klic, z, e);
        continue;
      }
      const castka = sl.castka != null ? normCastka(cell(row, 'castka')) : null;
      const id = idOf(row);
      if (id) {
        const prev = videne.get(id);
        if (prev) {
          // další řádek téže objednávky: částka buď opakuje celkovou cenu (nepřičítat), nebo je za položku (přičíst)
          if (castka != null && prev.klic === klic) {
            if (prev.stejna && castka === prev.prvni) prev.duplicitni.push(castka);
            else {
              prev.stejna = false;
              pridej(klic, z, { kc: castka + prev.duplicitni.reduce((a, b) => a + b, 0) });
              prev.duplicitni = [];
            }
          }
          continue;
        }
        videne.set(id, { klic, prvni: castka, stejna: true, duplicitni: [] });
      }
      if (castka != null && Number.isFinite(castka)) {
        e.kc = castka;
        out.castky = true;
      }
      pridej(klic, z, e);
      pricti(out.soucet, e);
      const d = sl.datum != null ? normDatum(cell(row, 'datum')) : null;
      if (d) {
        if (!out.od || d < out.od) out.od = d;
        if (!out.do || d > out.do) out.do = d;
      }
    }
    return out;
  }

  // Dvě tabulky vedle sebe: obce (všechny, bez PSČ) + rozpad velkých měst podle PSČ. Města z rozpadu se berou
  // podle PSČ a z tabulky obcí se vynechají (jinak by se počítala dvakrát); ostatní obce se berou z tabulky obcí.
  // Vrací { souhrn, rozdily: [{ nazev, obec, psc }] (jiné filtry v tabulkách), prekryto: počet vynechaných obcí }.
  function spojit(souhrny) {
    if (souhrny.length === 1) return { souhrn: souhrny[0], rozdily: [], prekryto: 0 };
    const metriky = KLICE_METRIK.filter((k) => souhrny.every((s) => s.metriky.includes(k)));
    const castky = souhrny.every((s) => s.castky);
    const orez = (e) => ({ n: metriky.includes('n') ? e.n : 0, zak: metriky.includes('zak') ? e.zak : 0, akt: metriky.includes('akt') ? e.akt : 0, kc: castky ? e.kc : 0 });
    const out = {
      radku: 0,
      sectene: true,
      metriky,
      castky,
      maPsc: true,
      zaznamy: new Map(),
      bezAdresy: nula(),
      storno: nula(),
      soucet: nula(),
      celkovySoucet: null,
      skupiny: new Map(),
      dukaz: new Map(),
      od: null,
      do: null,
      spojeno: true,
    };
    const vloz = (z) => {
      const klic = `${z.zeme}|${z.forma}|${z.kod}|${male(z.mesto)}`;
      let t = out.zaznamy.get(klic);
      if (!t) out.zaznamy.set(klic, (t = { zeme: z.zeme, forma: z.forma, kod: z.kod, mesto: z.mesto, mk: z.mk, ...nula() }));
      pricti(t, orez(z));
    };
    const sPsc = souhrny.filter((s) => s.maPsc);
    const sObec = souhrny.filter((s) => !s.maPsc);
    const pokryte = new Map();
    for (const s of sPsc) {
      for (const [mk, g] of s.skupiny) {
        const t = pokryte.get(mk) || { nazev: g.nazev, psc: nula(), obec: null };
        pricti(t.psc, orez(g));
        pokryte.set(mk, t);
      }
      for (const z of s.zaznamy.values()) vloz(z);
      pricti(out.bezAdresy, orez(s.bezAdresy));
    }
    let prekryto = 0;
    for (const s of sObec) {
      for (const z of s.zaznamy.values()) {
        const t = z.mk && pokryte.get(z.mk);
        if (t) {
          prekryto++;
          t.obec = pricti(t.obec || nula(), orez(z));
          continue;
        }
        vloz(z);
      }
      pricti(out.bezAdresy, orez(s.bezAdresy));
    }
    const hlavni = metriky[0] || 'n';
    const rozdily = [];
    for (const t of pokryte.values()) {
      if (!t.obec) continue;
      const a = t.obec[hlavni];
      const b = t.psc[hlavni];
      if (Math.abs(a - b) > Math.max(1, 0.005 * Math.max(a, b))) rozdily.push({ nazev: t.nazev, obec: a, psc: b });
    }
    for (const s of souhrny) {
      out.radku += s.radku;
      for (const [mk, ev] of s.dukaz) {
        const t = out.dukaz.get(mk) || { cz: 0, cizi: 0 };
        t.cz += ev.cz;
        t.cizi += ev.cizi;
        out.dukaz.set(mk, t);
      }
    }
    for (const z of out.zaznamy.values()) pricti(out.soucet, z);
    pricti(out.soucet, out.bezAdresy);
    out.celkovySoucet = sObec.length === 1 && sObec[0].celkovySoucet ? orez(sObec[0].celkovySoucet) : null;
    return { souhrn: out, rozdily, prekryto };
  }

  // ------------------------------------------------------------------ přiřazení k českým PSČ
  // Velká zahraniční města a slovenská města (i ta, která mají v Česku jmenovce – Košice, Žilina, Trnava, Senec…):
  // řádek jen s názvem obce (bez PSČ a země) se pak počítá do zahraničí, ne do české vesnice stejného jména.
  const CIZI_MESTA = new Set(
    (
      // Slovensko
      'bratislava,košice,prešov,žilina,nitra,banská bystrica,trnava,trenčín,martin,poprad,prievidza,zvolen,' +
      'považská bystrica,michalovce,nové zámky,spišská nová ves,komárno,levice,humenné,bardejov,liptovský mikuláš,' +
      'piešťany,ružomberok,topoľčany,lučenec,čadca,pezinok,dubnica nad váhom,rimavská sobota,partizánske,šaľa,' +
      'dunajská streda,vranov nad topľou,hlohovec,brezno,senica,nové mesto nad váhom,malacky,snina,rožňava,' +
      'dolný kubín,senec,žiar nad hronom,púchov,kežmarok,bánovce nad bebravou,galanta,handlová,stupava,skalica,' +
      'sabinov,revúca,kysucké nové mesto,šamorín,myjava,svidník,stará ľubovňa,štúrovo,moldava nad bodvou,detva,' +
      'krupina,stropkov,veľký krtíš,sereď,nová dubnica,banská štiavnica,bytča,holíč,trebišov,vysoké tatry,svit,' +
      'šurany,želiezovce,kremnica,tvrdošín,námestovo,zlaté moravce,modra,gelnica,hriňová,sládkovičovo,' +
      'veľké kapušany,svätý jur,turzovka,krásno nad kysucou,rajec,rajecké teplice,ilava,nemšová,vrútky,vráble,' +
      'fiľakovo,hurbanovo,šahy,tornaľa,levoča,krompachy,dobšiná,jelšava,medzev,medzilaborce,sobrance,sliač,' +
      'bojnice,nováky,leopoldov,gbely,stará turá,brezová pod bradlom,trenčianske teplice,turčianske teplice,' +
      'veľký meder,veľký šariš,spišská belá,podolínec,poltár,hnúšťa,dudince,kráľovský chlmec,hanušovce nad topľou,' +
      'bernolákovo,ivanka pri dunaji,chorvátsky grob,dunajská lužná,miloslavov,rovinka,most pri bratislave,zohor,' +
      'lozorno,slovenský grob,' +
      // Rakousko
      'wien,vienna,vídeň,graz,linz,linec,salzburg,innsbruck,klagenfurt,klagenfurt am wörthersee,villach,wels,' +
      'sankt pölten,st. pölten,st.pölten,dornbirn,wiener neustadt,steyr,feldkirch,bregenz,leonding,klosterneuburg,' +
      'baden,wolfsberg,leoben,krems,krems an der donau,traun,amstetten,lustenau,kapfenberg,mödling,hallein,kufstein,' +
      'traiskirchen,schwechat,braunau am inn,stockerau,saalfelden,tulln,tulln an der donau,hohenems,' +
      'spittal an der drau,telfs,ternitz,perchtoldsdorf,bludenz,bad ischl,eisenstadt,schwaz,hall in tirol,gmunden,' +
      'wörgl,gänserndorf,korneuburg,hollabrunn,zwettl,freistadt,mistelbach,laa an der thaya,zell am see,kitzbühel,' +
      'lienz,judenburg,vöcklabruck,ried im innkreis,' +
      // Německo
      'berlin,berlín,hamburg,münchen,muenchen,munich,köln,koeln,cologne,frankfurt,frankfurt am main,stuttgart,' +
      'düsseldorf,duesseldorf,dortmund,essen,leipzig,lipsko,bremen,dresden,drážďany,hannover,nürnberg,nuernberg,' +
      'norimberk,duisburg,bochum,wuppertal,bielefeld,bonn,münster,karlsruhe,mannheim,augsburg,wiesbaden,' +
      'mönchengladbach,gelsenkirchen,braunschweig,chemnitz,kiel,aachen,halle,halle (saale),magdeburg,freiburg,' +
      'freiburg im breisgau,krefeld,lübeck,oberhausen,erfurt,mainz,rostock,kassel,hagen,saarbrücken,potsdam,' +
      'ludwigshafen,oldenburg,leverkusen,osnabrück,solingen,heidelberg,darmstadt,regensburg,řezno,paderborn,' +
      'ingolstadt,offenbach,offenbach am main,würzburg,fürth,ulm,heilbronn,pforzheim,wolfsburg,göttingen,' +
      'reutlingen,koblenz,bremerhaven,jena,erlangen,siegen,hildesheim,cottbus,zwickau,plauen,görlitz,bautzen,' +
      'zittau,passau,pasov,bayreuth,bamberg,weiden,weiden in der oberpfalz,amberg,landshut,rosenheim,' +
      'garmisch-partenkirchen,konstanz,freising,dachau,schwerin,trier,gera,weimar,kempten,memmingen,straubing,' +
      'deggendorf,meißen,meissen,pirna,radebeul,freiberg,annaberg-buchholz,' +
      // Polsko
      'warszawa,warsaw,varšava,kraków,krakow,krakov,łódź,lodz,wrocław,wroclaw,vratislav,poznań,poznan,gdańsk,gdansk,' +
      'szczecin,bydgoszcz,lublin,białystok,bialystok,katowice,katovice,gdynia,częstochowa,czestochowa,radom,toruń,' +
      'torun,sosnowiec,rzeszów,rzeszow,kielce,gliwice,olsztyn,zabrze,bielsko-biała,bielsko-biala,bytom,' +
      'zielona góra,rybnik,ruda śląska,opole,tychy,gorzów wielkopolski,elbląg,płock,dąbrowa górnicza,wałbrzych,' +
      'włocławek,tarnów,chorzów,koszalin,kalisz,legnica,grudziądz,jaworzno,słupsk,jastrzębie-zdrój,nowy sącz,' +
      'jelenia góra,siedlce,mysłowice,konin,piła,piotrków trybunalski,inowrocław,lubin,ostrów wielkopolski,' +
      'suwałki,gniezno,głogów,siemianowice śląskie,leszno,żory,zamość,pruszków,łomża,chełm,mielec,' +
      'kędzierzyn-koźle,przemyśl,stalowa wola,tczew,świdnica,będzin,racibórz,cieszyn,nysa,kłodzko,bolesławiec,' +
      'zakopane,oświęcim,żywiec,wadowice,krosno,sanok,' +
      // jinde
      'budapest,budapešť,ljubljana,zagreb,záhřeb,beograd,belgrade,bělehrad,novi sad,sarajevo,banja luka,split,' +
      'podgorica,skopje,london,londýn,paris,paříž,amsterdam,rotterdam,bruxelles,brussels,brusel,zürich,zurich,' +
      'basel,bern,genève,geneva,ženeva,milano,milan,roma,rome,řím,madrid,barcelona,stockholm,copenhagen,' +
      'københavn,kodaň,oslo,helsinki,dublin,kyiv,kiev,kyjev,lviv,moscow,moskva,new york,los angeles,toronto'
    )
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const CIZI_FOLD = new Set([...CIZI_MESTA].map(fold));

  // ------------------------------------------------------------------ obec podle názvu
  // Řádek bez PSČ se přiřadí podle názvu obce. Lidé ale píšou obce i jinak, než se úředně jmenují: se starším
  // či poštovním přívlastkem („Říčany u Prahy“, „Zábřeh na Moravě“, „Hlinsko v Čechách“), zkratkou („Frenštát p.R.“,
  // „Č. Budějovice“, „Ústí n/L“), jen částí názvu se spojovníkem („Brandýs nad Labem“, „Stará Boleslav“), s částí
  // obce („Husinec - Řež“), číslem obvodu („Sušice II“, „Tišnov 3“) nebo okresem („Kozmice okr. Benešov“). Jmenovce
  // rozliší vodítko („u Brna“ → ten nejblíž Brnu, „okr. Benešov“, „pošta Nové Strašecí“) nebo oblast („v Čechách“,
  // „na Moravě“, „ve Slezsku“); jinak se bere největší.
  const PREDLOZKY = new Set(['nad', 'pod', 'u', 'na', 'v', 've']);
  const OKRESY_MEST = new Set(['brno venkov', 'praha vychod', 'praha zapad', 'plzen jih', 'plzen sever']); // okres, ne město
  const PREVAHA = 5; // zkratka či začátek názvu sedí na víc obcí → největší, je-li aspoň 5× větší než druhá
  const MIN_ZACATEK = 2000; // „Frenštát“ → „Frenštát pod Radhoštěm“ jen u obcí od 2 000 obyvatel (ne „Jakubov“ → vesnice)
  const MAX_KM = 50; // obec podle vodítka („u Brna“) či přívlastku („nad Ohří“) nejdál 50 km od něj
  // slovenské tvary („Most pri Bratislave“, „Moravany nad Váhom“, „Výčapy-Opatovce“, „Horné Orešany“) – zahraničí
  const SLOVENSKE =
    /\b(pri|na ostrove|[a-z]+ovce|dolne|horne|nizne|vysne|dolny|horny|nizny|vysny|dolna|horna|nizna|vysna|(nad|pod) [a-z]+om|nad (nitrou|zitavou|toplou|ondavou|torysou|oravou|kysucou|bodvou|myjavou|bebravou|slanou|rimavou|rimavicou|cirochou|latoricou|parnou|rajciankou|udavou|bystricou)|pod (makytou|javorinou|tatrami)|slovensk[a-z]*|slovakia)\b/;
  // „-ovce“ jen v názvu, ne ve vodítku: „u Bílovce“ je český 2. pád Bílovce
  const jeSlovenske = (mesto) => SLOVENSKE.test(fold(mesto).replace(/\bu [a-z]+ovce\b/g, 'u'));
  // písmeno mimo českou abecedu (ľ, ô, ä, ö, ü, ß, ł, ś, ż…) – obec je v cizině; rozbité kódování („MÄ?sto“) ne
  const CIZI_PISMENO = /[^\P{L}a-záčďéěíňóřšťúůýž]/u;
  const ROZBITE_KODOVANI = /[ãäåăĺ][^\p{L}\s]/u;
  const ZEME_V_NAZVU =
    /\b(slovensk[a-z]*|slovakia|slowakei|sr|polska|poland|polen|germany|deutschland|osterreich|austria|schweiz|switzerland|nederland|netherlands|ireland|croatia|hrvatska|france|italy|italia|spain|usa|united kingdom|england)\b/;
  const CESKO_NA_KONCI = /[\s,(]*([cč]esk[aá] republi\p{L}*|[cč]esko|czech( republic)?|čr|cr|cz)\.?\)?\s*$/iu;
  const OBLASTI = [
    ['cechy', /\b(v cechach|v podkrkonosi|v krkonosich|v jizerskych horach|v orlickych horach|v podjestedi)\b/],
    ['morava', /\b(na morave|na hane|na valassku|na slovacku|v moravskem krasu)\b/],
    ['slezsko', /\b(ve slezsku|nad olsi)\b/], // Olše teče jen ve Slezsku („Bystřice nad Olší“)
  ];
  const SLEZSKO = new Set([3801, 3802, 3803, 3804, 3806, 3807, 3811]); // okresy (Bruntál … Jeseník)

  // Název obce v datech → klíč pro hledání (bez „(okres …)“, „-Město“; „, Česká republika“ ubere CESKO_NA_KONCI,
  // jiné části za čárkou posoudí podleDilu).
  function ocistitNazev(mesto) {
    return String(mesto || '')
      .replace(/\s*\([^)]*\)\s*/g, ' ')
      .replace(/\s*-\s*m[ěe]sto\s*$/i, '')
      .trim();
  }

  // Index obcí k hledání podle názvu. obce = [[název, kód okresu, lat, lon, obyvatel, PSČ, kód obce]] (data/obce.js),
  // pscData doplní jména pošt, která mezi obcemi nejsou. Jmenovci jsou seřazení od největšího.
  function indexObci(obce, pscData) {
    const vse = [];
    for (const o of obce || []) {
      if (o && o[0] && o[5]) vse.push({ nazev: String(o[0]), okres: Number(o[1]) || 0, lat: o[2], lon: o[3], pop: Number(o[4]) || 0, psc: String(o[5]) });
    }
    const znama = new Set(vse.map((z) => fold(z.nazev)));
    for (const [kod, v] of Object.entries(pscData || {})) {
      const k = v && fold(v[3]);
      if (!k || znama.has(k)) continue;
      znama.add(k);
      vse.push({ nazev: String(v[3]), okres: Number(v[2]) || 0, lat: v[0], lon: v[1], pop: 0, psc: kod });
    }
    vse.sort((a, b) => b.pop - a.pop);
    const presne = new Map();
    const casti = new Map(); // část názvu se spojovníkem („Stará Boleslav“, „Místek“) → obec
    const slova = new Map(); // slovo názvu → obce (zkratky a začátky názvů)
    const zacatky = new Map(); // první dvě písmena → obce (vodítka ve 2. pádě)
    const privlastky = new Map(); // „nad ohri“ → obce, které ho mají v názvu (kde ta řeka teče)
    const sPredlozkou = new Map(); // „roznov pod“ → obce s tímto začátkem názvu (překlep v přívlastku)
    const pridat = (m, k, z) => {
      const a = m.get(k);
      if (!a) m.set(k, [z]);
      else if (a[a.length - 1] !== z) a.push(z);
    };
    for (const z of vse) {
      const k = fold(z.nazev);
      z.tvary = [k.split(' ')];
      pridat(presne, k, z);
      const dily = z.nazev.split(/\s*-\s*/);
      for (const d of dily.length > 1 ? dily : []) {
        const dk = fold(d);
        if (dk.length < 3 || dk === 'lazne') continue; // „Lipová-lázně“
        pridat(casti, dk, z);
        z.tvary.push(dk.split(' '));
      }
      for (const t of z.tvary) {
        const i = t.findIndex((s, j) => j > 0 && PREDLOZKY.has(s));
        if (i <= 0 || i >= t.length - 1) continue;
        pridat(privlastky, t.slice(i).join(' '), z);
        pridat(sPredlozkou, t.slice(0, i + 1).join(' '), z);
      }
      for (const s of new Set(k.split(' '))) if (s.length >= 3 && !PREDLOZKY.has(s)) pridat(slova, s, z);
      pridat(zacatky, k.slice(0, 2), z);
    }
    const velka = new Set(vse.filter((z) => z.pop >= 20000).map((z) => fold(z.nazev)));
    return { vse, presne, casti, slova, zacatky, privlastky, sPredlozkou, velka };
  }

  // Starší tvar indexu – Map(fold(název) → PSČ) – se převede (bez souřadnic, jmenovce pak rozliší jen pořadí).
  const PREVEDENE = new WeakMap();
  function jakoIndex(idx) {
    if (!idx || typeof idx !== 'object') return null;
    if (idx.presne) return idx;
    let ix = PREVEDENE.get(idx);
    if (!ix) {
      const dvojice = idx instanceof Map ? [...idx.entries()] : Object.entries(idx);
      ix = indexObci(dvojice.map(([k, psc]) => [k, 0, null, null, 0, psc]), null);
      PREVEDENE.set(idx, ix);
    }
    return ix;
  }

  const CISLO_NA_KONCI = /(?:\s+[ivx]{1,4}\.?|\s*\d+\.?)$/i; // „Sušice II“, „Tišnov3“

  // Bez předpony: „obec Liptál“, „MěstoPraha“, „pošta Telč“, „p. Holešov“ (ne „Obecnice“, „Městečko“).
  function bezPredpony(s) {
    const m = /^(obec|m[ěe]sto|pošta|posta)(\s+)?/i.exec(s);
    if (m && (m[2] || /^[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]/.test(s.slice(m[0].length)))) return s.slice(m[0].length);
    return s.replace(/^p\.\s*/i, '');
  }

  // Tvary celého názvu k hledání: jak je, očištěný (bez „(okres …)“, „, Česká republika“), bez předpony, bez čísla
  // obvodu a zdvojený název jednou („HodonínHodonín“).
  function tvaryNazvu(mesto) {
    const out = [];
    const pridej = (s) => {
      s = String(s || '').replace(/\s+/g, ' ').trim();
      if (s && !out.includes(s)) out.push(s);
      return s;
    };
    pridej(mesto);
    pridej(bezPredpony(pridej(ocistitNazev(String(mesto || '').replace(CESKO_NA_KONCI, '')))));
    for (const t of [...out]) {
      pridej(t.replace(CISLO_NA_KONCI, ''));
      const pul = t.length / 2;
      if (t.length >= 6 && Number.isInteger(pul) && t.slice(0, pul).toLowerCase() === t.slice(pul).toLowerCase()) pridej(t.slice(0, pul));
      // „Veselí/Lužnicí“ = Veselí nad Lužnicí
      if (/\p{L}{3}\s*\/\s*\p{L}{3}/u.test(t)) for (const p of [' nad ', ' pod ']) pridej(t.replace(/\s*\/\s*/, p));
    }
    return out;
  }

  // Části názvu oddělené čárkou, závorkou či lomítkem, a pomlčkou, není-li to úřední název („Husinec - Řež“, „Holásky,
  // Brno“, „Hostivař (okres Hlavní město Praha)“, ale „Brumov-Bylnice“ vcelku); bez „okres“ a čísla obvodu. „n/L“ je
  // zkratka („nad Labem“), ne dvě části.
  function dilyNazvu(mesto, ix) {
    const out = [];
    const cast = (d) => {
      const okres = /^(?:okres\s+|okr\.\s*|okr\s+)/i.test(d);
      d = d.replace(/^(?:okres\s+|okr\.\s*|okr\s+)/i, '').trim();
      if (d) out.push({ t: d, okres });
    };
    const s = bezPredpony(String(mesto || '').replace(CESKO_NA_KONCI, '')).replace(/(^|[\s.])(\p{L}{1,2})\/(?=\p{L})/gu, '$1$2. ');
    for (const d of s.split(/\s*[,\/()]\s*/)) {
      if (ix && /[-–]/.test(d) && (ix.presne.has(fold(d)) || ix.casti.has(fold(d)))) cast(d);
      else d.split(/\s*[–-]\s*/).forEach(cast);
    }
    return out;
  }

  // Slova názvu se značkou zkratky: „Frenštát p.R.“ → frenstat, p…, r…; „Uh.Hradiště“ → uh…, hradiste; „n/L“ → n…, l….
  function slovaNazvu(s) {
    const out = [];
    for (const kus of String(s || '').replace(/[-–,()]+/g, ' ').match(/[^\s.\/]+[.\/]?/g) || []) {
      const slovo = kus.replace(/[.\/]$/, '');
      const f = fold(slovo).split(' ').filter(Boolean);
      const zkr = slovo !== kus || (f.length === 1 && f[0].length === 1 && f[0] !== 'u' && f[0] !== 'v');
      for (const w of f) out.push({ w, zkr });
    }
    return out;
  }

  // Vzor (slova se zkratkami) proti slovům jména obce: zkratka = začátek slova. Kratší vzor sedí, když jménu zbývá
  // jen přívlastek („Frenštát“ → „Frenštát pod Radhoštěm“).
  function sediVzor(vzor, jmeno) {
    if (!vzor.length || vzor.length > jmeno.length) return false;
    for (let i = 0; i < vzor.length; i++) {
      if (vzor[i].zkr ? !jmeno[i].startsWith(vzor[i].w) : jmeno[i] !== vzor[i].w) return false;
    }
    return vzor.length === jmeno.length || PREDLOZKY.has(jmeno[vzor.length]);
  }

  // Slovo vodítka proti slovu jména obce: zkratka, shoda, nebo 2. pád (Most → Mostu, Teplice → Teplic, Praha → Prahy,
  // České → Českých, Plzeň → Plzně, Hradec → Hradce, Havlíčkův → Havlíčkova, Dvůr → Dvora).
  function sediTvar(s, n) {
    const g = s.w;
    if (s.zkr) return n.startsWith(g);
    if (g === n) return true;
    const konec = (kmen, re) => kmen.length >= 2 && g.startsWith(kmen) && re.test(g.slice(kmen.length));
    if (konec(n, /^(a|e|i|u|y|ou)$/)) return true;
    if (n.startsWith(g) && /^[aeiy]$/.test(n.slice(g.length))) return true;
    if (konec(n.replace(/[aeiouy]+$/, ''), /^(a|e|i|u|y|ou|eho|ych)$/)) return true;
    if (konec(n.replace(/e([^aeiouy])$/, '$1'), /^(a|e|i|u|y)$/)) return true;
    if (n.endsWith('uv') && konec(n.slice(0, -2) + 'ov', /^(a|eho)$/)) return true;
    return konec(n.replace(/u([^aeiouy]+)$/, 'o$1'), /^(a|e|u)$/);
  }

  // Vodítko („Prahy“, „Brna“, „Českých Budějovic“, „Benešov“, „Praha-východ“) → největší obec, jejíž jméno sedí.
  function najdiReferenci(text, ix) {
    let slova = slovaNazvu(text).filter((s) => !/^\d+$/.test(s.w));
    while (slova.length > 1 && /^(venkov|vychod|zapad|mesto|jih|sever|okoli)$/.test(slova[slova.length - 1].w)) slova = slova.slice(0, -1);
    if (!slova.length) return null;
    if (slova.every((s) => s.zkr)) {
      // „u Rým.“ → Rýmařov: zkratka jednoho slova (aspoň 3 písmena) → největší obec s tímto začátkem, má-li převahu
      if (slova.length > 1 || slova[0].w.length < 3) return null;
      const k = ix.vse.filter((z) => z.tvary[0][0].startsWith(slova[0].w));
      return k.length && (k.length === 1 || k[0].pop >= PREVAHA * k[1].pop) ? k[0] : null;
    }
    const k = slova.map((s) => s.w).join(' ');
    if (/^(hlavni mesto )?(praha|prahy|prague)$/.test(k)) return (ix.presne.get('praha') || [])[0] || null;
    if (ix.presne.has(k)) return ix.presne.get(k)[0];
    const prvni = slova[0];
    const kandidati = prvni.zkr || prvni.w.length < 2 ? ix.vse : ix.zacatky.get(prvni.w.slice(0, 2)) || [];
    for (const z of kandidati) {
      for (const j of z.tvary) {
        if (j.length < slova.length || (j.length > slova.length && !PREDLOZKY.has(j[slova.length]))) continue;
        if (slova.every((s, i) => sediTvar(s, j[i]))) return z;
      }
    }
    return null;
  }

  // Vodítko a oblast z celého názvu (i ze závorky a za čárkou): „u Kolína“, „okr. Benešov“, „okres Kolín“,
  // „pošta Telč“; „v Čechách“, „na Moravě“, „ve Slezsku“. Vodítko se dohledá, až když je potřeba. Dosah: obec „u Y“
  // nejdál 20 km od Y (od velkého města víc – „Benešov u Prahy“ je 37 km od středu Prahy), v okrese 40 km, pošta 20 km.
  function kontextNazvu(mesto, ix) {
    const s = String(mesto || '').replace(/[()]/g, ' ');
    const f = fold(s);
    const oblast = (OBLASTI.find(([, re]) => re.test(f)) || [])[0] || null;
    const m = /(?:^|[\s,.\/-])(u\s+|okr\.\s*|okr\s+|okres\s+|pošta\s+|posta\s+)([^,]+)$/i.exec(s);
    const typ = !m ? null : /^u/i.test(m[1]) ? 'u' : /^okr/i.test(m[1]) ? 'okres' : 'posta';
    let ref;
    const kontext = {
      oblast,
      reference() {
        if (ref === undefined) ref = m ? najdiReferenci(m[2], ix) : null;
        return ref;
      },
      dosah() {
        if (typ !== 'u') return typ === 'okres' ? 40 : 20;
        return 20 + 10 * Math.log10(Math.max(ref ? ref.pop : 0, 10000) / 10000);
      },
      // „okr. Benešov“ → přímo okres Benešov (okresy se jmenují po svém městě; „Praha-západ“ ne – tam jen vzdálenost)
      okres() {
        return typ === 'okres' && !/(zapad|vychod|venkov|jih|sever)\s*$/.test(fold(m[2])) && kontext.reference() ? ref.okres : null;
      },
    };
    return kontext;
  }

  // Kandidáti z okresu, je-li uveden; null = okres uveden, ale žádná taková obec v něm není.
  function vOkrese(kandidati, kod) {
    if (!kod) return kandidati;
    const v = kandidati.filter((z) => z.okres === kod);
    return v.length ? v : null;
  }

  function vOblasti(okres, oblast) {
    const kraj = Math.floor(okres / 100);
    if (oblast === 'slezsko') return SLEZSKO.has(okres);
    if (oblast === 'morava') return kraj === 37 || kraj === 38;
    return kraj >= 31 && kraj <= 36;
  }

  function km(a, b) {
    if (a.lat == null || b.lat == null) return Infinity;
    return 111.2 * Math.hypot(a.lat - b.lat, (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180));
  }

  // Kandidát nejblíž místům (vodítko, obce se stejným přívlastkem), nejdál maxKm. Váha = obyvatelé × e^(−d / 5 km):
  // rozhoduje vzdálenost („Roztoky u Křivoklátu“: 3 km, ne 9 000 obyvatel 35 km daleko), při podobné vzdálenosti
  // velikost („Zbýšov u Brna“: 3 890 obyvatel 18 km od Brna, ne 429 obyvatel 17 km).
  function podleBlizkosti(kandidati, mista, maxKm = MAX_KM) {
    let nej = null;
    let max = 0;
    for (const z of kandidati) {
      let d = Infinity;
      for (const m of mista) if (m !== z) d = Math.min(d, km(z, m));
      const vaha = d <= maxKm ? Math.max(z.pop, 1) * Math.exp(-d / 5) : 0;
      if (vaha > max) [max, nej] = [vaha, z];
    }
    return nej;
  }

  // Levenshteinova vzdálenost nejvýš 1 (u delších přívlastků 2): „rahostem“ ~ „radhostem“, „knernou“ ~ „kneznou“.
  function podobne(a, b) {
    const limit = Math.max(a.length, b.length) >= 6 ? 2 : 1;
    if (Math.abs(a.length - b.length) > limit) return false;
    let pred = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const rad = [i];
      for (let j = 1; j <= b.length; j++) rad[j] = Math.min(pred[j] + 1, rad[j - 1] + 1, pred[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      pred = rad;
    }
    return pred[b.length] <= limit;
  }

  // Z kandidátů (seřazených od největšího) jedna obec: oblast, blízko vodítka, jinak největší. `prevaha`:
  // různá jména (zkratka, část názvu) – největší jen s převahou, jinak nic.
  function vyberObec(kandidati, kontext, prevaha) {
    let k = kandidati;
    if (k.length > 1 && kontext.okres()) k = vOkrese(k, kontext.okres()) || k;
    if (k.length > 1 && kontext.oblast) {
      const v = k.filter((z) => vOblasti(z.okres, kontext.oblast));
      if (v.length) k = v;
    }
    if (k.length === 1) return k[0];
    const ref = kontext.reference();
    const blizko = ref && podleBlizkosti(k, [ref], kontext.dosah());
    if (blizko) return blizko;
    if (!prevaha || k.every((z) => fold(z.nazev) === fold(k[0].nazev))) return k[0];
    return k[0].pop > 0 && k[0].pop >= PREVAHA * k[1].pop ? k[0] : null;
  }

  // Obec s přívlastkem, který v jejím úředním názvu není. Vodítko („u Brna“, „okr. Benešov“) → blízko něj; oblast
  // („v Čechách“, „na Moravě“) → největší v ní; „nad Ohří“ → blízko obcí, které ten přívlastek v názvu mají (řeka tam
  // teče); jinak jen jediná obec toho jména – „Staré Město pod Sněžníkem“ mezi pěti Starými Městy nehádá.
  function podlePrivlastku(kandidati, zaklad, privlastek, ix, kontext) {
    const predlozka = privlastek.split(' ')[0];
    if (/^(u|okr|okres|posta)$/.test(predlozka)) {
      const ref = kontext.reference();
      if (kontext.okres()) return (vOkrese(kandidati, kontext.okres()) || [])[0] || null;
      if (ref) return podleBlizkosti(kandidati, [ref], kontext.dosah());
      return kandidati.length === 1 ? kandidati[0] : null;
    }
    if (kontext.oblast) return kandidati.find((z) => vOblasti(z.okres, kontext.oblast)) || null;
    const sousede = ix.privlastky.get(privlastek);
    if (sousede) return podleBlizkosti(kandidati, sousede, 25);
    // jediná obec toho jména – ne však, když úřední název s touto předložkou existuje a jen nesedí („Bystřice nad Olší“
    // není Bystřice nad Pernštejnem ani žádná z Bystřic)
    return kandidati.length === 1 && !ix.sPredlozkou.has(zaklad + ' ' + predlozka) ? kandidati[0] : null;
  }

  // Přesná shoda tvaru: obec, Praha s obvodem, část velkého města („Ostrava-Poruba“, „Brno Sever“, „Liberec XXV“),
  // „Moravská Ostrava“. (Část názvu se spojovníkem – „Stará Boleslav“ – hledá podleVzoru spolu se začátky názvů.)
  function podleTvaru(k, ix, velka, kontext) {
    if (!k) return null;
    if (ix.presne.has(k)) return vyberObec(ix.presne.get(k), kontext, false);
    const mesto = (n) => (ix.presne.get(n) || [])[0] || null;
    if (/^(hlavni mesto )?(praha|prague|prag)(\s*\d.*)?$/.test(k)) return mesto('praha');
    for (const v of velka) {
      if (!k.startsWith(v + ' ')) continue;
      const zbytek = k.slice(v.length + 1);
      // „Brno-venkov“, „Praha-západ“ jsou okresy; „Most pri Bratislave“, „Teplice nad Metují“ jiné obce
      if (OKRESY_MEST.has(v + ' ' + zbytek.split(' ')[0]) || /^(okoli|pri|pod|nad|u|na|v|ve)\b/.test(zbytek)) continue;
      return mesto(v);
    }
    const s = k.split(' ');
    return s.length >= 2 && /^(moravsk|slezsk|polsk)[aeyi]$/.test(s[0]) && velka.has(s[1]) ? mesto(s[1]) : null;
  }

  // Zkratky („Frenštát p.R.“, „Uh.Hradiště“, „Brandýs n/L“, „Val. Mez.“), část názvu se spojovníkem („Stará
  // Boleslav“) a začátky názvů („Dvůr Králové“, „Frenštát“). Sedí-li víc různých obcí, jen s převahou.
  function podleVzoru(t, ix, kontext) {
    const vzor = slovaNazvu(t);
    const plna = vzor.filter((s) => !s.zkr && s.w.length >= 3 && !PREDLOZKY.has(s.w));
    let kandidati;
    if (plna.length) kandidati = ix.slova.get(plna.reduce((a, b) => (b.w.length > a.w.length ? b : a)).w) || [];
    else if (vzor.length >= 2 && vzor.every((s) => s.w.length >= 3)) kandidati = ix.vse;
    else return null;
    const shoda = kandidati.filter((z) => z.tvary.some((j) => sediVzor(vzor, j)));
    const z = shoda.length ? vyberObec(shoda, kontext, true) : null;
    // jen začátek názvu („Jakubov“ → Jakubov u Moravských Budějovic) až od MIN_ZACATEK obyvatel
    return z && (z.pop >= MIN_ZACATEK || z.tvary.some((j) => j.length === vzor.length && sediVzor(vzor, j))) ? z : null;
  }

  // „Rožnov pod Rahoštěm“, „Rychnov nad Kněřnou“ (překlep), „Nové Město nad Met“ (useknuté), „Svatý Jan pod Skalou
  // Sedlec“ (s částí obce): jediný úřední název se stejným začátkem a takovým přívlastkem.
  function sPreklepem(zaklad, privlastek, ix) {
    const [predlozka, ...zbytek] = privlastek.split(' ');
    const p = zbytek.join(' ');
    if (!PREDLOZKY.has(predlozka) || p.length < 3) return null;
    const n = zaklad.split(' ').length + 1;
    const sedi = (o) => podobne(o, p) || p.startsWith(o + ' ') || o.startsWith(p);
    const shoda = (ix.sPredlozkou.get(zaklad + ' ' + predlozka) || []).filter((z) =>
      z.tvary.some((j) => j.slice(0, n).join(' ') === zaklad + ' ' + predlozka && sedi(j.slice(n).join(' '))),
    );
    return shoda.length === 1 ? shoda[0] : null;
  }

  // Bez přívlastku: „Říčany u Prahy“ → Říčany, „Ostrov nad Ohří“, „Hlinsko v Čechách“, „Kozmice okr. Benešov“.
  // Základ musí sedět přesně (ne zkratkou), od nejdelšího: „Lhota pod Libčany u Hradce“ → Lhota pod Libčany.
  function bezPrivlastku(t, ix, kontext) {
    const re = /\s+(?:u|nad|pod|na|v|ve|okr|okres|pošta|posta)(?=[\s.]|$)/gi;
    const mista = [];
    let m;
    while ((m = re.exec(t))) mista.push(m.index);
    for (let i = mista.length - 1; i >= 0; i--) {
      const zaklad = fold(t.slice(0, mista[i]));
      const privlastek = fold(t.slice(mista[i]));
      const preklep = sPreklepem(zaklad, privlastek, ix);
      if (preklep) return preklep;
      const kandidati = ix.presne.get(zaklad) || ix.casti.get(zaklad);
      if (kandidati) return podlePrivlastku(kandidati, zaklad, privlastek, ix, kontext);
    }
    return null;
  }

  // Obce pro jednu část názvu: přesně, i bez čísla obvodu („Nová Ves I“ je úřední název, „Děčín XIX“ ne).
  function kandidatiDilu(d, ix) {
    for (;;) {
      const k = fold(d);
      if (/^(hlavni mesto )?(praha|prague|prag)$/.test(k)) return ix.presne.get('praha') || null;
      const z = ix.presne.get(k) || ix.casti.get(k);
      if (z || !CISLO_NA_KONCI.test(d)) return z || null;
      d = d.replace(CISLO_NA_KONCI, '');
    }
  }

  // Víc částí v názvu („Husinec - Řež“, „Zbraslav-Praha“, „Holásky, Brno“, „Studené 55, Jílové u Prahy“). Leží-li
  // první obec do 15 km od další, platí první (další je okolí). Jinak: velké město (první je jeho čtvrť); obec za
  // ulicí s číslem domu („Lipová 72, Modletice“); za pomlčkou další, je-li aspoň 2× větší (menší bývá částí větší:
  // „Střelná-Košťany“); jinak první („Velké Popovice, Brtnice“) – z jejích jmenovců ta nejblíž další části („Bystřice -
  // Nesvačily“). Část, která obcí není („Řež“), se přeskočí; okres je jen vodítko – „okres Beroun“ přímo okres,
  // „Praha-západ“ okolí Prahy.
  function podleDilu(mesto, ix, velka, kontext) {
    const dily = dilyNazvu(mesto, ix);
    if (dily.length < 2) return null;
    const carka = /[,()]/.test(mesto);
    const ulice = carka && /\d/.test(String(mesto).split(/[,()]/)[0]); // „Lipová 72, Modletice“
    const obce = [];
    let okres = null;
    for (let i = 0; i < dily.length; i++) {
      const dva = i + 1 < dily.length && OKRESY_MEST.has(fold(dily[i].t + ' ' + dily[i + 1].t));
      const okoli = dva || OKRESY_MEST.has(fold(dily[i].t)); // „Praha-západ“, „Praha Západ“
      if (okoli || (dily[i].okres && i > 0)) {
        const k = kandidatiDilu(okoli ? dily[i].t.split(/\s+/)[0] : dily[i].t, ix);
        if (!okres && k) okres = { z: k[0], kod: okoli ? null : k[0].okres };
        if (dva) i++;
      } else obce.push(dily[i].t);
    }
    if (!obce.length) return null;
    let prvni = kandidatiDilu(obce[0], ix);
    if (!prvni) {
      const z = najdiZaznamObce(obce[0], ix, velka); // jedna část – dál se nedělí
      prvni = z ? [z] : null;
    }
    if (prvni && okres) prvni = okres.kod ? vOkrese(prvni, okres.kod) : prvni;
    const velke = (k) => velka.has(fold(k[0].nazev));
    let dalsi = null;
    for (const d of obce.slice(1)) {
      const k = kandidatiDilu(d, ix);
      if (!k || (prvni && k[0] === prvni[0]) || (prvni && fold(k[0].nazev) === fold(prvni[0].nazev))) continue; // „Sušice - Sušice I“
      if (!dalsi || (velke(k) && !velke(dalsi))) dalsi = k;
    }
    if (!prvni) return dalsi && (carka || velke(dalsi)) ? dalsi[0] : null;
    if (!dalsi) return (okres && !okres.kod && podleBlizkosti(prvni, [okres.z], 40)) || vyberObec(prvni, kontext, false);
    const druha = dalsi[0];
    const blizko = podleBlizkosti(prvni, [druha], 15);
    if (blizko) return blizko;
    if ((velke(dalsi) && !velke(prvni)) || ulice || (!carka && druha.pop >= 2 * prvni[0].pop)) return druha;
    return podleBlizkosti(prvni, [druha]) || vyberObec(prvni, kontext, false);
  }

  // Obec podle názvu → záznam indexu ({ nazev, okres, lat, lon, pop, psc }) nebo null.
  function najdiZaznamObce(mesto, idx, velkaMesta) {
    const ix = jakoIndex(idx);
    if (!ix || !fold(mesto)) return null;
    const velka = velkaMesta || ix.velka;
    const tvary = tvaryNazvu(mesto);
    if (!tvary.length || OKRESY_MEST.has(fold(tvary[0]))) return null;
    const kontext = kontextNazvu(mesto, ix);
    const slovenske = jeSlovenske(mesto); // jen celý název, nic se z něj neodvozuje
    for (const t of slovenske ? tvary.slice(0, 2) : tvary) {
      const z = podleTvaru(fold(t), ix, velka, kontext);
      if (z) return z;
    }
    if (slovenske) return null;
    const zDilu = podleDilu(mesto, ix, velka, kontext);
    if (zDilu) return zDilu;
    for (const t of tvary) {
      const z = podleVzoru(t, ix, kontext);
      if (z) return z;
    }
    for (const t of tvary) {
      const z = bezPrivlastku(t, ix, kontext);
      if (z) return z;
    }
    return null;
  }

  // Obec podle názvu → PSČ. idx = indexObci(…) (nebo starší Map(fold(název) → PSČ)).
  function najdiObec(mesto, idx, velkaMesta) {
    const z = najdiZaznamObce(mesto, idx, velkaMesta);
    return z ? z.psc : null;
  }

  function jeCiziMesto(mesto) {
    const m = male(mesto);
    if (!m) return false;
    if ((CIZI_PISMENO.test(m) && !ROZBITE_KODOVANI.test(m)) || ZEME_V_NAZVU.test(fold(m)) || jeSlovenske(m)) return true;
    // i části názvu („Košice - Peres“, „Bratislava V“, „Martin-Priekopa“, „Divina, okres Žilina“)
    for (const t of [m, ...tvaryNazvu(mesto), ...dilyNazvu(mesto).flatMap((d) => tvaryNazvu(d.t))].map(male)) {
      if (CIZI_MESTA.has(t)) return true;
      // napsané bez diakritiky („Kosice“, „Wroclaw“)
      if (/^[\x20-\x7e]+$/.test(t) && CIZI_FOLD.has(fold(t))) return true;
    }
    return false;
  }

  // Česká PSČ, kterými může být 4místný kód (chybějící nula: „4601“ → 460 01 nebo 460 10) nebo 5místné PSČ.
  function kandidatiPsc(kod) {
    if (/^\d{5}$/.test(kod)) return [kod];
    if (/^\d{4}$/.test(kod)) return [...new Set([kod.slice(0, 3) + '0' + kod.slice(3), kod + '0'])];
    return [];
  }

  function nazevSedi(mk, obecNazev) {
    const f = fold(obecNazev);
    return Boolean(f) && (mk === f || mk.startsWith(f + ' '));
  }

  // Oprava PSČ: 4místné („1200“ → 12000) nebo PSČ u řádku se zahraniční zemí, když sedí název obce.
  function opravitPsc(z, pscData) {
    if (!pscData) return null;
    const c = kandidatiPsc(z.kod).filter((k) => /^[1-7]/.test(k) && pscData[k]);
    if (!c.length) return null;
    if (z.mk) return c.find((k) => nazevSedi(z.mk, pscData[k][3])) || null;
    const obce = new Set(c.map((k) => pscData[k][4] || pscData[k][3]));
    return obce.size === 1 ? c[0] : null;
  }

  // Přiřadí záznamy souhrnu k českým PSČ. pscData = { '12345': [lat, lon, okres, obec, kódObce] },
  // obecIndex = indexObci(obce, pscData), opts.velkaMesta = Set(fold(název)) obcí, kde se hledá i „Město-část“
  // (výchozí: obce nad 20 000 obyvatel z indexu).
  // Vrací { psc: { kod: {n, zak, akt, kc} }, zahranici, nezarazeno, opraveno, podleNazvu, neprirazene: [...] }.
  function priradit(souhrn, pscData, obecIndex, opts) {
    const o = opts || {};
    const res = { psc: {}, zahranici: nula(), nezarazeno: nula(), opraveno: nula(), podleNazvu: nula(), neprirazene: [] };
    const nepr = new Map();
    const doPsc = (kod, e) => pricti(res.psc[kod] || (res.psc[kod] = nula()), e);
    const nezarazeno = (z) => {
      pricti(res.nezarazeno, z);
      const k = z.mk || '';
      const t = nepr.get(k) || { nazev: z.mesto || (z.kod ? 'PSČ ' + z.kod : ''), ...nula() };
      pricti(t, z);
      nepr.set(k, t);
    };
    const dukazCizi = (mk) => {
      const ev = mk && souhrn.dukaz && souhrn.dukaz.get(mk);
      return Boolean(ev && ev.cizi > 0 && ev.cz === 0);
    };
    const podleNazvu = (z) => {
      if (jeCiziMesto(z.mesto) || dukazCizi(z.mk)) {
        pricti(res.zahranici, z);
        return;
      }
      const p = najdiObec(z.mesto, obecIndex, o.velkaMesta);
      if (p) {
        doPsc(p, z);
        pricti(res.podleNazvu, z);
      } else if (z.forma === '4') pricti(res.zahranici, z); // „Wien 1020“ bez země
      else nezarazeno(z);
    };
    for (const z of souhrn.zaznamy.values()) {
      if (z.forma === 'cizi') {
        pricti(res.zahranici, z);
        continue;
      }
      if (z.zeme === 'cizi') {
        // zahraniční země, ale české město s (opravitelným) českým PSČ – typicky „AT | Praha | 1200“
        const p = z.mk && !jeCiziMesto(z.mesto) ? opravitPsc(z, pscData) : null;
        if (p) {
          doPsc(p, z);
          pricti(res.opraveno, z);
        } else pricti(res.zahranici, z);
        continue;
      }
      if (z.forma === 'cz') {
        if (!pscData || pscData[z.kod]) {
          doPsc(z.kod, z);
          continue;
        }
        // neznámé PSČ (P. O. Box, nové, nebo německé v českém tvaru): podle obce, jinak nejbližší PSČ téže pošty
        if (z.mk) {
          if (jeCiziMesto(z.mesto) || dukazCizi(z.mk)) {
            pricti(res.zahranici, z);
            continue;
          }
          const p = najdiObec(z.mesto, obecIndex, o.velkaMesta);
          if (p) {
            doPsc(p, z);
            pricti(res.podleNazvu, z);
            continue;
          }
        }
        const near = Object.keys(pscData).find((k) => k.slice(0, 3) === z.kod.slice(0, 3));
        if (near && (!z.mk || nazevSedi(z.mk, pscData[near][3]))) {
          doPsc(near, z);
          continue;
        }
        nezarazeno(z);
        continue;
      }
      if (z.forma === '4') {
        const p = opravitPsc(z, pscData);
        if (p) {
          doPsc(p, z);
          pricti(res.opraveno, z);
          continue;
        }
      }
      if (z.mk) podleNazvu(z);
      else if (z.forma === '4') pricti(res.zahranici, z);
      else nezarazeno(z);
    }
    pricti(res.nezarazeno, souhrn.bezAdresy);
    if (souhrn.bezAdresy.n || souhrn.bezAdresy.zak || souhrn.bezAdresy.akt) nepr.set('', pricti(nepr.get('') || { nazev: '', ...nula() }, souhrn.bezAdresy));
    const hlavni = (souhrn.metriky && souhrn.metriky[0]) || 'n';
    res.neprirazene = [...nepr.values()].sort((a, b) => b[hlavni] - a[hlavni] || b.n - a.n).slice(0, 40);
    for (const e of Object.values(res.psc)) e.kc = Math.round(e.kc);
    return res;
  }

  // ------------------------------------------------------------------ dataset pro server
  function metrikyDatasetu(d) {
    const m = d && Array.isArray(d.metriky) ? KLICE_METRIK.filter((k) => d.metriky.includes(k)) : [];
    return m.length ? m : ['n'];
  }
  // součet metriky v datasetu
  function soucetDatasetu(d, k) {
    return d && Array.isArray(d.mista) ? d.mista.reduce((s, x) => s + (Number(x[k]) || 0), 0) : 0;
  }

  // Obálka pro uložení na server: jen součty podle PSČ.
  function dataset(prirazeno, souhrn, meta) {
    const m = meta || {};
    const metriky = souhrn.metriky && souhrn.metriky.length ? souhrn.metriky.slice() : ['n'];
    const castky = Boolean(souhrn.castky);
    const hlavni = metriky[0];
    const mista = Object.entries(prirazeno.psc)
      .filter(([psc, e]) => /^\d{5}$/.test(psc) && metriky.some((k) => e[k] > 0))
      .map(([psc, e]) => {
        const x = { psc };
        for (const k of metriky) x[k] = Math.round(e[k]);
        x.kc = castky ? Math.round(e.kc) : 0;
        return x;
      })
      .sort((a, b) => b[hlavni] - a[hlavni] || (a.psc < b.psc ? -1 : 1));
    return {
      app: 'mapa-prodejen',
      verze: VERZE,
      nazev: String(m.nazev || '').slice(0, 120),
      soubor: String(m.soubor || '').slice(0, 200),
      nahrano: m.nahrano || new Date().toISOString(),
      kdo: String(m.kdo || '').slice(0, 60),
      od: souhrn.od || null,
      do: souhrn.do || null,
      metriky,
      castky,
      objednavek: soucetDatasetu({ mista }, 'n'),
      zakazniku: soucetDatasetu({ mista }, 'zak'),
      aktivnich: soucetDatasetu({ mista }, 'akt'),
      nezarazeno: Math.round(prirazeno.nezarazeno[hlavni] || 0),
      zahranici: Math.round(prirazeno.zahranici[hlavni] || 0),
      storno: Math.round((souhrn.storno && souhrn.storno.n) || 0),
      mista,
    };
  }

  // Kontrola datasetu přijatého serverem / načteného ze souboru. Vrací { data } nebo { chyba }.
  function validovat(obj) {
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.mista)) return { chyba: 'Chybí seznam „mista“ (součty podle PSČ).' };
    if (obj.mista.length > MAX_PSC) return { chyba: 'Příliš mnoho PSČ (' + obj.mista.length + ').' };
    const metriky = metrikyDatasetu(obj);
    const mista = [];
    const seen = new Set();
    for (const x of obj.mista) {
      if (!x || typeof x !== 'object') continue;
      if (Object.keys(x).some((k) => !['psc', 'n', 'zak', 'akt', 'kc'].includes(k))) return { chyba: 'Položka obsahuje jiné údaje než PSČ, počty a částku – osobní údaje se na server neposílají.' };
      const psc = normPsc(x.psc);
      if (!psc || seen.has(psc)) continue;
      const item = { psc };
      let neco = false;
      for (const k of metriky) {
        const v = Math.round(Number(x[k]));
        item[k] = Number.isFinite(v) && v > 0 && v <= 1e7 ? v : 0;
        if (item[k] > 0) neco = true;
      }
      if (!neco) continue;
      const kc = Math.round(Number(x.kc) || 0);
      item.kc = kc > 0 && kc < 1e12 ? kc : 0;
      seen.add(psc);
      mista.push(item);
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
        metriky,
        castky: Boolean(obj.castky),
        objednavek: soucetDatasetu({ mista }, 'n'),
        zakazniku: soucetDatasetu({ mista }, 'zak'),
        aktivnich: soucetDatasetu({ mista }, 'akt'),
        nezarazeno: num(obj.nezarazeno),
        zahranici: num(obj.zahranici),
        storno: num(obj.storno),
        mista,
      },
    };
  }

  // ------------------------------------------------------------------ celé zpracování (pro náhled v aplikaci)
  // rows → tabulky → součty → (spojení dvou tabulek) → přiřazení k PSČ → dataset + kontroly.
  // opts: pscData, obecIndex, velkaMesta, volba ('spojit' | index tabulky), sloupce ({ index: mapování }), meta.
  function zpracovat(rows, opts) {
    const o = opts || {};
    const bloky = o.bloky || rozpoznat(rows);
    const slBloku = (b) => (o.sloupce && o.sloupce[b.index]) || b.sloupce;
    const pocty = (b) => METRIKY.filter((m) => slBloku(b)[m.sloupec] != null).map((m) => m.key);
    const maPsc = (b) => slBloku(b).psc != null;
    const lzeSpojit = bloky.length === 2 && bloky.some(maPsc) && bloky.some((b) => !maPsc(b)) && pocty(bloky[0]).some((k) => pocty(bloky[1]).includes(k));
    let volba = o.volba;
    if (volba === 'spojit' && !lzeSpojit) volba = 0;
    if (volba == null) volba = lzeSpojit ? 'spojit' : 0;
    if (!bloky.length) return { bloky, lzeSpojit, volba, chyba: 'Nenašel jsem záhlaví se sloupcem PSČ nebo obec.' };
    const vybrane = volba === 'spojit' ? bloky : [bloky[volba] || bloky[0]];
    const souhrny = vybrane.map((b) => {
      const sl = slBloku(b);
      const s = secti(rows, sl, { odRadku: b.hlavicka + 1, od: b.od, do: b.do, popisky: popiskyBloku(b, sl), zemeOdhad: b.zemeOdhad });
      s.blok = b.index;
      return s;
    });
    const sp = volba === 'spojit' ? spojit(souhrny) : { souhrn: souhrny[0], rozdily: [], prekryto: 0 };
    const prirazeno = priradit(sp.souhrn, o.pscData, o.obecIndex, { velkaMesta: o.velkaMesta });
    const ds = dataset(prirazeno, sp.souhrn, o.meta);
    // kontrolní součty: řádek „Celkový součet“ tabulky × součet načtených řádků
    const kontroly = [];
    const hlavni = sp.souhrn.metriky[0] || 'n';
    for (const s of souhrny) {
      if (!s.celkovySoucet) continue;
      const k = s.metriky.includes(hlavni) ? hlavni : s.metriky[0];
      kontroly.push({ blok: s.blok, metrika: k, celkem: s.celkovySoucet[k], radky: s.soucet[k], ok: Math.abs(s.celkovySoucet[k] - s.soucet[k]) < 0.5 });
    }
    if (volba === 'spojit' && sp.souhrn.celkovySoucet) {
      kontroly.push({ blok: 'spojeno', metrika: hlavni, celkem: sp.souhrn.celkovySoucet[hlavni], radky: sp.souhrn.soucet[hlavni], ok: Math.abs(sp.souhrn.celkovySoucet[hlavni] - sp.souhrn.soucet[hlavni]) < 0.5 });
    }
    return { bloky, lzeSpojit, volba, souhrny, souhrn: sp.souhrn, rozdily: sp.rozdily, prekryto: sp.prekryto, prirazeno, dataset: ds, kontroly };
  }

  // Nadpis vložené tabulky (první vyplněná buňka nad záhlavím) – výchozí popis datasetu.
  function nadpisTabulky(rows, bloky) {
    const konec = bloky && bloky.length ? Math.min(...bloky.map((b) => b.hlavicka)) : Math.min(rows.length, 5);
    for (let r = 0; r < konec; r++) {
      const v = (rows[r] || []).map(text).find(Boolean);
      if (v && !FILTR.test(v) && v.length > 3) return v.slice(0, 120);
    }
    return '';
  }

  return {
    VERZE,
    METRIKY,
    METRIKA,
    SLOUPCE,
    CIZI_MESTA,
    fold,
    mapHeader,
    rozpoznat,
    detectColumns,
    popiskyBloku,
    pismeno,
    jePrazdne,
    normPsc,
    pscForma,
    jeZahranicniPsc,
    jeCesko,
    normCastka,
    normDatum,
    secti,
    spojit,
    indexObci,
    najdiObec,
    najdiZaznamObce,
    jeCiziMesto,
    priradit,
    metrikyDatasetu,
    soucetDatasetu,
    dataset,
    validovat,
    zpracovat,
    nadpisTabulky,
  };
});
