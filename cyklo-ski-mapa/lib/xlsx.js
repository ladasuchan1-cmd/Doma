// Čtení XLSX bez knihoven: rozbalí ZIP (central directory, metody 0 a 8) a listy převede na pole řádků (sdílené
// i inline řetězce, čísla, logické hodnoty). Rozbalení DEFLATE dodá volající – v prohlížeči DecompressionStream,
// v Node zlib – takže knihovna běží v obou a dá se testovat. Excel píše XML strojově a jednotně, proto stačí
// regulární výrazy na prvky row/c/v/t místo plného XML parseru. UMD: v prohlížeči `CSM.xlsx`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.CSM = root.CSM || {}; root.CSM.xlsx = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MAX_SOUBOR = 64 * 1024 * 1024; // rozbalená část nad 64 MB se nečte (ochrana proti „zip bombě“)
  const MAX_RADKU = 200000;

  function u16(b, o) {
    return b[o] | (b[o + 1] << 8);
  }
  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  // Obsah ZIPu podle central directory: jméno → { metoda, offset, komprimovano, velikost }.
  function obsahZipu(bytes) {
    let konec = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
      if (u32(bytes, i) === 0x06054b50) {
        konec = i;
        break;
      }
    }
    if (konec < 0) throw new Error('Soubor není tabulka Excelu (XLSX) – chybí konec archivu ZIP.');
    const pocet = u16(bytes, konec + 10);
    let p = u32(bytes, konec + 16);
    const dec = new TextDecoder('utf-8');
    const out = new Map();
    for (let i = 0; i < pocet; i++) {
      if (u32(bytes, p) !== 0x02014b50) throw new Error('Poškozený soubor XLSX (seznam souborů v archivu).');
      const delkaJmena = u16(bytes, p + 28);
      out.set(dec.decode(bytes.subarray(p + 46, p + 46 + delkaJmena)), {
        metoda: u16(bytes, p + 10),
        komprimovano: u32(bytes, p + 20),
        velikost: u32(bytes, p + 24),
        offset: u32(bytes, p + 42),
      });
      p += 46 + delkaJmena + u16(bytes, p + 30) + u16(bytes, p + 32);
    }
    return out;
  }

  async function vybal(bytes, z, inflateRaw) {
    if (z.velikost > MAX_SOUBOR) throw new Error('Část souboru XLSX je příliš velká.');
    if (u32(bytes, z.offset) !== 0x04034b50) throw new Error('Poškozený soubor XLSX (hlavička souboru v archivu).');
    const start = z.offset + 30 + u16(bytes, z.offset + 26) + u16(bytes, z.offset + 28);
    const data = bytes.subarray(start, start + z.komprimovano);
    if (z.metoda === 0) return data;
    if (z.metoda !== 8) throw new Error('Nepodporovaná komprese v souboru XLSX (metoda ' + z.metoda + ').');
    const out = await inflateRaw(data);
    return out instanceof Uint8Array ? out : new Uint8Array(out);
  }

  function dekoduj(s) {
    return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_m, e) => {
      if (e === 'amp') return '&';
      if (e === 'lt') return '<';
      if (e === 'gt') return '>';
      if (e === 'quot') return '"';
      if (e === 'apos') return "'";
      const kod = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return kod > 0 && kod <= 0x10ffff ? String.fromCodePoint(kod) : '';
    });
  }

  function atributy(tag) {
    const out = {};
    for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) out[m[1]] = dekoduj(m[2]);
    return out;
  }

  // Text všech <t> v úseku (sdílený řetězec, inline řetězec, formátovaný text s <r>); fonetické nápovědy <rPh> pryč.
  function texty(xml) {
    let s = '';
    const bezFonetiky = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
    for (const m of bezFonetiky.matchAll(/<(?:\w+:)?t\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?t>)/g)) if (m[1]) s += dekoduj(m[1]);
    return s;
  }

  function sdileneRetezce(xml) {
    const out = [];
    for (const m of xml.matchAll(/<(?:\w+:)?si\b[^>]*?(?:\/>|>([\s\S]*?)<\/(?:\w+:)?si>)/g)) out.push(m[1] ? texty(m[1]) : '');
    return out;
  }

  // 'AB12' → 27 (index sloupce od nuly)
  function indexSloupce(ref) {
    let n = 0;
    for (const ch of ref) {
      const c = ch.charCodeAt(0);
      if (c < 65 || c > 90) break;
      n = n * 26 + (c - 64);
    }
    return n - 1;
  }

  function radkyListu(xml, sdilene) {
    const radky = [];
    for (const rm of xml.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
      const ra = atributy(rm[1]);
      const index = ra.r ? Number(ra.r) - 1 : radky.length;
      if (!(index >= 0 && index < MAX_RADKU)) throw new Error('List má příliš mnoho řádků.');
      const radek = [];
      let dalsi = 0;
      for (const cm of (rm[2] || '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        const a = atributy(cm[1]);
        const i = a.r ? indexSloupce(a.r) : dalsi;
        if (i < 0 || i > 16383) continue;
        dalsi = i + 1;
        const obsah = cm[2] || '';
        const v = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(obsah);
        let hodnota = '';
        if (a.t === 's') hodnota = v ? sdilene[Number(v[1])] || '' : '';
        else if (a.t === 'inlineStr') hodnota = texty(obsah);
        else if (a.t === 'b') hodnota = v ? (v[1].trim() === '1' ? 'TRUE' : 'FALSE') : '';
        else hodnota = v ? dekoduj(v[1]) : '';
        radek[i] = hodnota;
      }
      for (let k = 0; k < radek.length; k++) if (radek[k] === undefined) radek[k] = '';
      radky[index] = radek;
    }
    for (let k = 0; k < radky.length; k++) if (!radky[k]) radky[k] = [];
    return radky;
  }

  // bytes: Uint8Array | ArrayBuffer souboru .xlsx; inflateRaw(Uint8Array) → Uint8Array | Promise<Uint8Array>.
  // Vrací listy v pořadí sešitu: [{ nazev, radky: string[][] }].
  async function nactiXlsx(bytes, inflateRaw) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const zip = obsahZipu(b);
    const dec = new TextDecoder('utf-8');
    const cti = async (jmeno) => {
      const z = zip.get(jmeno);
      return z ? dec.decode(await vybal(b, z, inflateRaw)) : null;
    };
    const sesit = await cti('xl/workbook.xml');
    if (sesit == null) throw new Error('Soubor není tabulka Excelu (chybí xl/workbook.xml).');
    const cile = {};
    for (const m of ((await cti('xl/_rels/workbook.xml.rels')) || '').matchAll(/<(?:\w+:)?Relationship\b([^>]*?)\/?>/g)) {
      const a = atributy(m[1]);
      if (a.Id && a.Target) cile[a.Id] = a.Target;
    }
    const sdilene = sdileneRetezce((await cti('xl/sharedStrings.xml')) || '');
    const listy = [];
    for (const m of sesit.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/?>/g)) {
      const a = atributy(m[1]);
      const rid = Object.entries(a).find(([k]) => /(^|:)id$/.test(k) && k !== 'sheetId');
      const cil = rid && cile[rid[1]];
      if (!cil) continue;
      const cesta = cil.startsWith('/') ? cil.slice(1) : 'xl/' + cil.replace(/^\.\//, '');
      const xml = await cti(cesta);
      if (xml != null) listy.push({ nazev: a.name || '', radky: radkyListu(xml, sdilene) });
    }
    if (!listy.length) throw new Error('V souboru Excelu není žádný list.');
    return listy;
  }

  return { nactiXlsx, indexSloupce, _radkyListu: radkyListu, _sdileneRetezce: sdileneRetezce };
});
