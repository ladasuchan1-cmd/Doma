// Hromadný import upravené tabulky (export z mapy otevřený v Excelu nebo uložený jako CSV) zpět do stavu
// oslovení. Najde hlavičku, spáruje řádky s místy podle odkazu OSM (nebo sloupce ID), porovná buňky s tím, co
// mapa ukazuje teď, a navrhne změny. Zapisuje se až po potvrzení náhledu. Pravidla:
//  • zaškrtávací sloupce: „ano“, „ano (14. 10. 2026)“, x, 1, true → zaškrtnout (s datem z buňky, jinak dnešním),
//    „ne“, 0, false → odškrtnout; prázdná buňka nic nemění – nic se nesmaže jen proto, že buňka chybí,
//  • poznámka: neprázdná a jiná než v mapě → přepíše se; prázdná nic nemění,
//  • půjčovna (ano/ne), provozovatel, telefon, e-mail, web: když se liší od toho, co mapa ukazuje (ruční údaj,
//    nebo údaj z OSM či webu), navrhne se jako ruční údaj; prázdná buňka nic nemění. Tyhle „údaje o místě“
//    jsou zvlášť (skupina 'udaje') a aplikace je zapíše jen na výslovný souhlas: mapa se každé pondělí obnovuje,
//    takže starší export může obsahovat údaj, který se mezitím v OSM nebo na webu změnil,
//  • ostatní sloupce (název, vzdálenosti, Upravil, Upraveno, …) se jen čtou.
// Nerozpoznané hodnoty a nespárované řádky se hlásí v náhledu, nic se tiše nezahodí.
// UMD: v prohlížeči `CSM.importTabulky` (potřebuje CSM.stav), v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stav.js'));
  else { root.CSM = root.CSM || {}; root.CSM.importTabulky = factory(root.CSM.stav); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (stavLib) {
  'use strict';

  const KONTAKTY = ['provozovatel', 'telefon', 'email', 'web'];
  const POPISY = {
    ...Object.fromEntries(stavLib.STAVY.map((s) => [s.key, s.label])),
    poznamka: 'Poznámka',
    pujcovna: 'Půjčovna',
    provozovatel: 'Provozovatel',
    telefon: 'Telefon',
    email: 'E-mail',
    web: 'Web',
  };

  function norm(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  // Hlavička: normalizovaný název sloupce → klíč. Názvy odpovídají exportu tabulky i exportu všech záznamů.
  const SLOUPCE = {
    osm: 'osm',
    'odkaz osm': 'osm',
    id: 'id',
    nazev: 'nazev',
    ...Object.fromEntries(stavLib.STAVY.map((s) => [norm(s.label), s.key])),
    poznamka: 'poznamka',
    pujcovna: 'pujcovna',
    provozovatel: 'provozovatel',
    telefon: 'telefon',
    'e-mail': 'email',
    email: 'email',
    web: 'web',
  };
  const JEN_CTENI = new Set(['typ', 'obec', 'adresa', 'okres', 'kraj', 'nejblizsi cyklotrasa', 'km od trasy', 'nejblizsi skiareal', 'km od skiarealu', 'upravil', 'upraveno', 'zem. sirka', 'zem. delka']);

  // Najde řádek hlavičky v prvních 10 řádcích: musí mít sloupec OSM nebo ID a aspoň jeden sloupec, který jde načíst.
  function najdiHlavicku(radky) {
    for (let r = 0; r < Math.min(10, radky.length); r++) {
      const sloupce = {};
      const ignorovane = [];
      const jenCteni = [];
      (radky[r] || []).forEach((h, i) => {
        const n = norm(h);
        if (!n) return;
        const klic = SLOUPCE[n];
        if (klic && sloupce[klic] == null) sloupce[klic] = i;
        else if (JEN_CTENI.has(n)) jenCteni.push(String(h).trim());
        else ignorovane.push(String(h).trim());
      });
      const klic = sloupce.osm != null || sloupce.id != null;
      const zapis = Object.keys(sloupce).some((k) => k !== 'osm' && k !== 'id' && k !== 'nazev');
      if (klic && zapis) return { radek: r, sloupce, ignorovane, jenCteni };
    }
    return null;
  }

  // Id místa z odkazu OSM („https://www.openstreetmap.org/node/123“, „node/123“) nebo ze sloupce ID.
  function idZRadku(radek, sloupce) {
    if (sloupce.id != null) {
      const id = String(radek[sloupce.id] || '').trim();
      if (stavLib.isValidId(id)) return id;
    }
    if (sloupce.osm != null) {
      const m = /(?:^|\/)(node|way|relation)\/(\d+)/.exec(String(radek[sloupce.osm] || '').trim());
      if (m) return { node: 'n', way: 'w', relation: 'r' }[m[1]] + m[2];
    }
    return null;
  }

  function isoDatum(r, m, d) {
    const dt = new Date(Date.UTC(r, m - 1, d));
    return dt.getUTCFullYear() === r && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
  }

  function datumZTextu(s) {
    let m = /(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/.exec(s);
    if (m) return isoDatum(Number(m[3]), Number(m[2]), Number(m[1]));
    m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (m) return isoDatum(Number(m[1]), Number(m[2]), Number(m[3]));
    return null;
  }

  // Excel někdy datum v buňce uloží jako pořadové číslo dne (1 = 1. 1. 1900); bere se jen rozumný rozsah let.
  function excelDatum(cislo) {
    if (!(cislo > 36526 && cislo < 73051)) return null; // 1. 1. 2000 až 1. 1. 2100
    return new Date(Date.UTC(1899, 11, 30) + Math.floor(cislo) * 864e5).toISOString().slice(0, 10);
  }

  // Zaškrtávací buňka → { ano: true, datum } | { ano: false } | null (prázdná) | { neznamo: text }.
  function stavZBunky(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return null;
    const n = norm(s);
    if (/^(ne|no|n|0|false|nepravda|-)$/.test(n)) return { ano: false };
    if (/^\d{5}(\.\d+)?$/.test(s)) {
      const d = excelDatum(Number(s));
      return d ? { ano: true, datum: d } : { neznamo: s };
    }
    const datum = datumZTextu(s);
    if (/^(ano|a|yes|y|x|1|true|pravda|✓|✔)(\b|\s|\(|$)/.test(n) || datum) return { ano: true, datum };
    return { neznamo: s };
  }

  // Buňka s textem: export chrání hodnoty začínající =, +, -, @ apostrofem (aby je Excel nespustil jako vzorec).
  function textZBunky(text) {
    let s = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim();
    if (/^'[=+\-@]/.test(s)) s = s.slice(1);
    return s;
  }

  function stejne(pole, a, b) {
    const x = String(a || '').replace(/\s+/g, ' ').trim();
    const y = String(b || '').replace(/\s+/g, ' ').trim();
    if (pole === 'telefon') return x.replace(/[^\d+,]/g, '') === y.replace(/[^\d+,]/g, '');
    if (pole === 'web') return x.replace(/\/+$/, '').toLowerCase() === y.replace(/\/+$/, '').toLowerCase();
    if (pole === 'email') return x.toLowerCase() === y.toLowerCase();
    return x === y;
  }

  function pujcovnaZBunky(text) {
    const n = norm(text);
    if (!n) return null;
    if (/^(ano|a|x|1|true)$/.test(n)) return 'ano';
    if (/^(ne|n|0|false)$/.test(n)) return 'ne';
    if (n === 'podle webu') return 'ano?';
    return { neznamo: String(text).trim() };
  }

  // listy: [{ nazev, radky }] – projdou se všechny listy s hlavičkou (sešit může mít třeba list na každý kraj),
  // listy bez ní se jen vyjmenují; misto(id) → { nazev, pujcovna, provozovatel, telefon, email, web } toho, co
  // mapa ukazuje teď, nebo null; stav = současný stav oslovení; dnes = 'YYYY-MM-DD'.
  function navrhni({ listy, misto, stav, dnes }) {
    const zmeny = [];
    const nesparovane = [];
    const nerozpoznane = [];
    const prehled = [];
    const preskocene = [];
    const jenCteni = new Set();
    const ignorovane = new Set();
    const videno = new Map();
    let radku = 0;
    for (const list of listy) {
      const hlavicka = najdiHlavicku(list.radky);
      if (!hlavicka) {
        if (list.radky.some((r) => r.some((v) => String(v).trim()))) preskocene.push(list.nazev);
        continue;
      }
      hlavicka.jenCteni.forEach((x) => jenCteni.add(x));
      hlavicka.ignorovane.forEach((x) => ignorovane.add(x));
      const s = hlavicka.sloupce;
      const stat = { nazev: list.nazev, radku: 0, sparovano: 0, zmen: 0 };
      prehled.push(stat);
      for (let r = hlavicka.radek + 1; r < list.radky.length; r++) {
        const radek = list.radky[r] || [];
        if (!radek.some((v) => String(v).trim())) continue;
        radku++;
        stat.radku++;
        const kde = { list: list.nazev, radek: r + 1 };
        const nazevVSouboru = s.nazev != null ? String(radek[s.nazev] || '').trim() : '';
        const id = idZRadku(radek, s);
        const m = id ? misto(id) : null;
        if (!m) {
          nesparovane.push({ ...kde, nazev: nazevVSouboru, duvod: id ? 'místo v mapě není' : 'chybí odkaz OSM' });
          continue;
        }
        if (videno.has(id)) {
          const prvni = videno.get(id);
          nesparovane.push({ ...kde, nazev: nazevVSouboru || m.nazev, duvod: `stejné místo už je ${prvni.list === list.nazev ? '' : 'na listu „' + prvni.list + '“ '}na řádku ${prvni.radek}` });
          continue;
        }
        videno.set(id, kde);
        stat.sparovano++;
        const pred = zmeny.length;
        const r0 = stav[id] || stavLib.emptyRecord();
        const zakl = { id, ...kde, nazev: m.nazev || nazevVSouboru };
        for (const st of stavLib.STAVY) {
          if (s[st.key] == null) continue;
          const b = stavZBunky(radek[s[st.key]]);
          if (!b) continue;
          if (b.neznamo != null) {
            nerozpoznane.push({ ...kde, nazev: zakl.nazev, sloupec: st.label, hodnota: b.neznamo });
            continue;
          }
          if (b.ano && !r0[st.key]) zmeny.push({ ...zakl, skupina: 'osloveni', druh: 'stav', pole: st.key, puvodni: false, nove: true, datum: b.datum || dnes });
          else if (!b.ano && r0[st.key]) zmeny.push({ ...zakl, skupina: 'osloveni', druh: 'stav', pole: st.key, puvodni: true, nove: false });
        }
        if (s.poznamka != null) {
          const t = textZBunky(radek[s.poznamka]);
          if (t && t !== String(r0.poznamka || '').replace(/\r\n?/g, '\n').trim()) zmeny.push({ ...zakl, skupina: 'osloveni', druh: 'pole', pole: 'poznamka', puvodni: r0.poznamka || '', nove: t.slice(0, 4000) });
        }
        if (s.pujcovna != null) {
          const p = pujcovnaZBunky(radek[s.pujcovna]);
          if (p && p.neznamo != null) nerozpoznane.push({ ...kde, nazev: zakl.nazev, sloupec: 'Půjčovna', hodnota: p.neznamo });
          else if ((p === 'ano' || p === 'ne') && p !== m.pujcovna) zmeny.push({ ...zakl, skupina: 'udaje', druh: 'pole', pole: 'pujcovna', puvodni: m.pujcovna || '', nove: p });
        }
        for (const k of KONTAKTY) {
          if (s[k] == null) continue;
          const t = textZBunky(radek[s[k]]);
          if (t && !stejne(k, t, m[k])) zmeny.push({ ...zakl, skupina: 'udaje', druh: 'pole', pole: k, puvodni: m[k] || '', nove: t.slice(0, 300) });
        }
        stat.zmen += zmeny.length - pred;
      }
    }
    if (!prehled.length) {
      const prvni = listy.map((l) => l.radky.find((r) => r.some((v) => String(v).trim()))).find(Boolean) || [];
      const nalezene = prvni.map((v) => String(v).trim()).filter(Boolean);
      throw new Error('V souboru chybí sloupec „OSM“ (odkaz na místo) nebo „ID“ – bez něj nejde řádky spárovat s místy. '
        + (nalezene.length ? 'První vyplněný řádek obsahuje: ' + nalezene.slice(0, 15).join(', ') + (nalezene.length > 15 ? ', …' : '') + '.' : 'Soubor je prázdný.'));
    }
    return { listy: prehled, preskocene, radku, jenCteni: [...jenCteni], ignorovane: [...ignorovane], zmeny, nesparovane, nerozpoznane, mist: new Set(zmeny.map((z) => z.id)).size };
  }

  // Zapíše navržené změny do kopie stavu. Vrací { stav, id: [změněná místa] }.
  function pouzij(stav, zmeny, { kdo, now }) {
    const out = { ...stav };
    const ids = new Set();
    for (const z of zmeny) {
      let r = out[z.id] || stavLib.emptyRecord();
      if (z.druh === 'stav') {
        r = stavLib.toggleStav(r, z.pole, z.nove, now);
        if (z.nove && z.datum) r.datumy[z.pole] = z.datum;
      } else {
        r = stavLib.setPole(r, z.pole, z.nove, now);
      }
      if (kdo) r.kdo = String(kdo).slice(0, 60);
      if (stavLib.isEmpty(r)) delete out[z.id];
      else out[z.id] = r;
      ids.add(z.id);
    }
    return { stav: out, id: [...ids] };
  }

  // Souhrn pro náhled: [{ pole, popis, zaskrtnout, odskrtnout, zmenit }] v pořadí sloupců.
  function souhrn(zmeny) {
    const poradi = [...stavLib.STAV_KEYS, 'poznamka', 'pujcovna', ...KONTAKTY];
    return poradi.map((pole) => {
      const z = zmeny.filter((x) => x.pole === pole);
      return { pole, popis: POPISY[pole], zaskrtnout: z.filter((x) => x.druh === 'stav' && x.nove).length, odskrtnout: z.filter((x) => x.druh === 'stav' && !x.nove).length, zmenit: z.filter((x) => x.druh === 'pole').length };
    }).filter((x) => x.zaskrtnout || x.odskrtnout || x.zmenit);
  }

  return { najdiHlavicku, idZRadku, stavZBunky, textZBunky, pujcovnaZBunky, stejne, excelDatum, navrhni, pouzij, souhrn, POPISY };
});
