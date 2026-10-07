// CSV – parser podle RFC 4180 (uvozovky, zdvojené uvozovky, nové řádky v poli) a serializace
// pro export do Excelu (středník, CRLF, BOM). UMD: v prohlížeči `MP.csv`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.csv = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Vrátí pole řádků (pole polí řetězců). Oddělovač se detekuje z hlavičky (`,` nebo `;` nebo tab), lze vynutit.
  function parse(text, sep) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    if (!sep) sep = detectSeparator(text);
    const rows = [];
    let row = [];
    let field = '';
    let i = 0;
    const n = text.length;
    let inQuotes = false;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i++;
          continue;
        }
        field += c;
        i++;
        continue;
      }
      // uvozovky otevírají pole jen na jeho začátku; uprostřed jsou obyčejný znak (5" kolo, text vložený z Excelu)
      if (c === '"' && field === '') {
        inQuotes = true;
        i++;
        continue;
      }
      if (c === sep) {
        row.push(field);
        field = '';
        i++;
        continue;
      }
      if (c === '\r') {
        i++;
        continue;
      }
      if (c === '\n') {
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
        i++;
        continue;
      }
      field += c;
      i++;
    }
    if (field.length || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  // Podle prvních řádků (nad tabulkou vloženou z Excelu může být nadpis bez oddělovačů): vyhraje znak, který je
  // na nejvíc řádcích; při shodě tabulátor (z Excelu), pak středník, pak čárka (bývá i v číslech a textu).
  function detectSeparator(text) {
    const lines = text.split('\n', 40).filter((l) => l.trim() !== '');
    const counts = ['\t', ';', ','].map((sep) => [sep, lines.filter((l) => l.includes(sep)).length]);
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ',';
  }

  // Řádky jako objekty podle hlavičky.
  function parseObjects(text, sep) {
    const rows = parse(text, sep);
    if (!rows.length) return [];
    const head = rows[0].map((h) => h.replace(/^\?/, '').trim());
    const out = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (row.length === 1 && row[0] === '') continue;
      const o = {};
      for (let c = 0; c < head.length; c++) o[head[c]] = row[c] == null ? '' : row[c];
      out.push(o);
    }
    return out;
  }

  function escapeField(v, sep) {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@]/.test(s)) s = "'" + s; // ochrana před vzorci v Excelu
    if (s.includes('"') || s.includes(sep) || s.includes('\n') || s.includes('\r')) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // rows: pole polí; vrací text s BOM a CRLF (Excel v českém prostředí očekává středník).
  function serialize(rows, opts) {
    const sep = (opts && opts.sep) || ';';
    const bom = opts && opts.bom === false ? '' : '﻿';
    return bom + rows.map((r) => r.map((v) => escapeField(v, sep)).join(sep)).join('\r\n') + '\r\n';
  }

  return { parse, parseObjects, serialize, detectSeparator, escapeField };
});
