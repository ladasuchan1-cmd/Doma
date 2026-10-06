'use strict';
// Kontrola kontrastu tokenů témat podle WCAG 2.x (SPEC kap. 7, akceptační kritérium 1).
//   node tools/check-contrast.js [--min 4.5] [--quiet]
// Načte proměnné z public/base.css (:root) a z každého public/themes/*.css ([data-theme="…"]), vyřeší var() odkazy
// a spočítá kontrast dvojic text/bg, text-muted/bg, on-primary/primary, on-accent/accent, text/surface.
// Pod 4,5:1 skončí s exit 1. Další dvojice (text/surface-2, text-muted/surface, link/bg, text/bg-elevated) jen vypíše.
// Podporované barvy: #rgb, #rrggbb, rgb()/rgba() s neprůhledností 1, named white/black.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE_CSS = path.join(ROOT, 'public', 'base.css');
const THEMES_DIR = path.join(ROOT, 'public', 'themes');

const REQUIRED_PAIRS = [
  ['text', 'bg'],
  ['text-muted', 'bg'],
  ['on-primary', 'primary'],
  ['on-accent', 'accent'],
  ['text', 'surface'],
];
const INFO_PAIRS = [
  ['text', 'surface-2'],
  ['text-muted', 'surface'],
  ['link', 'bg'],
  ['text', 'bg-elevated'],
];

/** Vytáhne deklarace --x: y; z bloků, jejichž selektor vyhovuje predikátu. */
function extractVars(css, selectorMatches) {
  const vars = {};
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(noComments))) {
    const selector = m[1].trim();
    if (!selectorMatches(selector)) continue;
    const decls = m[2];
    const dre = /--([a-zA-Z0-9_-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = dre.exec(decls))) vars[d[1]] = d[2].trim();
  }
  return vars;
}

function resolveVar(vars, name, depth = 0) {
  const raw = vars[name];
  if (raw === undefined || depth > 10) return null;
  const ref = /^var\(--([a-zA-Z0-9_-]+)(?:\s*,\s*([^)]+))?\)$/.exec(raw.trim());
  if (ref) {
    const inner = resolveVar(vars, ref[1], depth + 1);
    return inner !== null ? inner : ref[2] ? ref[2].trim() : null;
  }
  return raw;
}

function parseColor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (v === 'white' || v === '#fff' || v === '#ffffff') return [255, 255, 255];
  if (v === 'black') return [0, 0, 0];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return m[1].split('').map((c) => parseInt(c + c, 16));
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) {
    if (m[2] && parseInt(m[2], 16) !== 255) return null;
    return [m[1].slice(0, 2), m[1].slice(2, 4), m[1].slice(4, 6)].map((h) => parseInt(h, 16));
  }
  m = /^rgba?\(\s*(\d+)\s*[, ]\s*(\d+)\s*[, ]\s*(\d+)\s*(?:[,/]\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) !== 1) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  return null;
}

function luminance([r, g, b]) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Kontrastní poměr WCAG (1–21). */
function contrastRatio(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Zkontroluje jednu sadu proměnných; vrací { results[], failures[] }. */
function checkVars(vars, { min = 4.5 } = {}) {
  const results = [];
  const failures = [];
  const evaluate = (pair, required) => {
    const [fgName, bgName] = pair;
    const fgRaw = resolveVar(vars, fgName);
    const bgRaw = resolveVar(vars, bgName);
    const fg = parseColor(fgRaw);
    const bg = parseColor(bgRaw);
    if (!fg || !bg) {
      const r = { pair: `${fgName}/${bgName}`, ratio: null, ok: !required, note: `nelze vyhodnotit (${fgRaw ?? 'chybí'} / ${bgRaw ?? 'chybí'})`, required };
      results.push(r);
      if (required) failures.push(r);
      return;
    }
    const ratio = contrastRatio(fg, bg);
    const r = { pair: `${fgName}/${bgName}`, ratio, ok: ratio >= min, fg: fgRaw, bg: bgRaw, required };
    results.push(r);
    if (required && !r.ok) failures.push(r);
  };
  for (const p of REQUIRED_PAIRS) evaluate(p, true);
  for (const p of INFO_PAIRS) evaluate(p, false);
  return { results, failures };
}

function loadThemeVars(baseCss, themeCss, themeName) {
  const base = extractVars(baseCss, (s) => s === ':root' || s.split(',').some((x) => x.trim() === ':root'));
  const theme = extractVars(themeCss, (s) => s.split(',').some((x) => x.trim() === `[data-theme='${themeName}']` || x.trim() === `[data-theme="${themeName}"]`));
  return { ...base, ...theme };
}

function main(argv) {
  const minIdx = argv.indexOf('--min');
  const min = minIdx >= 0 ? Number(argv[minIdx + 1]) : 4.5;
  const quiet = argv.includes('--quiet');
  const baseCss = fs.readFileSync(BASE_CSS, 'utf8');
  const sets = [{ name: 'base (bez tématu)', vars: extractVars(baseCss, (s) => s === ':root') }];
  for (const file of fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith('.css')).sort()) {
    const name = path.basename(file, '.css');
    sets.push({ name, vars: loadThemeVars(baseCss, fs.readFileSync(path.join(THEMES_DIR, file), 'utf8'), name) });
  }
  let failed = 0;
  for (const set of sets) {
    const { results, failures } = checkVars(set.vars, { min });
    if (!quiet) {
      console.log(`\n${set.name}`);
      for (const r of results) {
        const mark = r.ratio === null ? '??' : r.ok ? 'OK' : 'FAIL';
        const ratio = r.ratio === null ? r.note : `${r.ratio.toFixed(2)}:1  (${r.fg} na ${r.bg})`;
        console.log(`  ${mark.padEnd(4)} ${r.pair.padEnd(20)} ${ratio}${r.required ? '' : '  [informativní]'}`);
      }
    }
    failed += failures.length;
    if (failures.length) console.error(`Téma „${set.name}“: ${failures.length} dvojic pod ${min}:1 → ${failures.map((f) => f.pair).join(', ')}`);
  }
  if (failed) {
    console.error(`\nKontrast: ${failed} selhání.`);
    process.exit(1);
  }
  console.log(`\nKontrast v pořádku (minimum ${min}:1, ${sets.length} sad).`);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { extractVars, resolveVar, parseColor, luminance, contrastRatio, checkVars, loadThemeVars, REQUIRED_PAIRS, INFO_PAIRS };
