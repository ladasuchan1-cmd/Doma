'use strict';
// Renderer podmnožiny Markdownu + šablonování právních textů (SPEC kap. 11).
//
// Podporovaný Markdown: nadpisy #–######, odstavce (měkký konec řádku → <br>), **tučné**, *kurzíva*, `kód`,
// odkazy [text](url) a holé https:// adresy, seznamy odrážkové i číslované s vnořením o jednu úroveň,
// tabulky |…| se záhlavím, blockquote >, vodorovná čára ---, ohraničený kód ```; znaky ☐/☑ zůstávají.
// Veškerý text se escapuje (html.escape), odkazy jen http(s)/mailto/tel/relativní. Jiné HTML v textu se
// vypisuje jako text; HTML komentáře se zahazují.
//
// Šablonování (před renderem):
//   {{PARAM}}              → hodnota: řetězec/číslo (escapované), Html fragment (vloží se beze změny),
//                            { markdown, inline } (markdown se vloží jako zdroj, je-li placeholder sám na řádku,
//                            jinak text `inline`)
//   {{#X}}…{{/X}}          → obsah jen je-li X pravdivé (viz isTruthy: '', 'ne', 'false', '0', '—', '-', null, []… = nepravda);
//                            je-li X pole záznamů, obsah se opakuje pro každý záznam a jeho klíče ({ KOLO_TYP: … })
//                            dosazují a vyhodnocují podmínky uvnitř bloku (cyklus, např. řádek tabulky pro každé kolo)
//   {{^X}}…{{/X}}          → obsah jen je-li X nepravdivé
//   Značka {{#X}} / {{^X}} / {{/X}} sama na řádku „spolkne“ i svůj konec řádku, takže blok obalující celé odstavce
//   nebo řádky tabulky nezanechá prázdný řádek (tabulka zůstane celistvá); skrytý blok zmizí včetně řádků značek.
//   <!-- INTERNI: nerenderovat --> … <!-- /INTERNI -->  → vyhozeno
//   sekce „## Parametry“, „## K ověření advokátem“, „## Příloha pro advokáta…“ a úvodní rámeček
//   „> **Návrh připravený jako podklad…“ → vyhozeny (do dalšího nadpisu stejné nebo vyšší úrovně)
//   {{STORNO_TABULKA}}     → tabulka ze settings.cancellation (stornoTable), není-li hodnota zadána přímo
// Neznámý placeholder zůstane v textu jako {{NAZEV}} (escapovaný) a objeví se v `missing`.
//
// Vstup: render(markdownSource, params, { cancellation, omitHeadings, only, linkMap })
// Výstup: { html, title, headings: [{ level, id, text }], missing: [názvy] }

const { escape, isHtml } = require('./html');

const SENT = '\u0001'; // ohraničení zástupného znaku (slotu) – přežije escapování i inline parser
const INTERNAL_HEADINGS = [/^parametry\b/i, /^k ověření advokátem/i, /^příloha pro advokáta/i];
const PLACEHOLDER_RE = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;
const FALSY_TEXT = new Set(['', 'ne', 'false', '0', '—', '–', '-', 'no', 'null', 'undefined']);
const SAFE_URL_RE = /^(https?:\/\/|mailto:|tel:|\/(?!\/)|#)/i;

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

/** Pravdivost hodnoty parametru pro {{#X}} / {{^X}}. */
function isTruthy(value) {
  if (value === null || value === undefined || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'object') return true;
  return !FALSY_TEXT.has(String(value).trim().toLowerCase());
}

/** URL-slug z textu nadpisu (bez diakritiky). */
function slugify(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'sekce';
}

/** Odstraní z textu nadpisu inline značky (pro slug / title). */
function plainText(text) {
  return String(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\*([^*]*)\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

function headingLevel(line) {
  const m = /^(#{1,6})\s+\S/.exec(line);
  return m ? m[1].length : 0;
}

function headingText(line) {
  return line.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim();
}

// ---------------------------------------------------------------------------------------------------------
// Šablonování

/**
 * Vyhodí bloky <!-- INTERNI … --> … <!-- /INTERNI --> a ostatní HTML komentáře. Značky INTERNI platí jen samy na
 * začátku řádku – zmínka značky uvnitř textu (např. v `kódu` v tabulce Parametry) blok neukončí.
 */
function stripComments(src) {
  return String(src)
    .replace(/(^|\n)[ \t]*<!--\s*INTERNI\b[^>\n]*-->[ \t]*(?:\n[\s\S]*?)?\n[ \t]*<!--\s*\/INTERNI\s*-->[ \t]*(?=\n|$)/g, '$1')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Vyhodí interní sekce (Parametry, K ověření advokátem, Příloha pro advokáta, volitelně další podle
 * `omitHeadings`) včetně obsahu až po další nadpis stejné nebo vyšší úrovně, a úvodní rámeček „Návrh připravený…“.
 * @param {string} src
 * @param {{omitHeadings?: (RegExp|string)[]}} [opts]
 */
function stripInternal(src, opts = {}) {
  const matchers = [...INTERNAL_HEADINGS, ...(opts.omitHeadings || []).map((m) => (m instanceof RegExp ? m : new RegExp('^' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')))];
  const lines = String(src).split('\n');
  const out = [];
  let skipLevel = 0;
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) inFence = !inFence;
    const level = inFence ? 0 : headingLevel(line);
    if (skipLevel) {
      if (level && level <= skipLevel) skipLevel = 0;
      else continue;
    }
    if (level) {
      const text = plainText(headingText(line));
      if (matchers.some((re) => re.test(text))) {
        skipLevel = level;
        continue;
      }
    }
    // úvodní rámeček „Návrh připravený jako podklad…“ (celý blockquote)
    if (!inFence && /^\s{0,3}>\s*\*\*Návrh připravený/i.test(line)) {
      while (i + 1 < lines.length && /^\s{0,3}>/.test(lines[i + 1])) i++;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Najde uzavírací značku {{/NAME}} k otevírací na pozici `from` (počítá vnoření stejného jména). */
function findClose(src, name, from) {
  const open = new RegExp(`\\{\\{[#^]${name}\\}\\}`, 'g');
  const close = new RegExp(`\\{\\{/${name}\\}\\}`, 'g');
  let depth = 1;
  let pos = from;
  while (depth > 0) {
    close.lastIndex = pos;
    const c = close.exec(src);
    if (!c) return null;
    open.lastIndex = pos;
    let o = open.exec(src);
    while (o && o.index < c.index) {
      depth++;
      o = open.exec(src);
    }
    depth--;
    pos = c.index + c[0].length;
    if (depth === 0) return { start: c.index, end: pos };
  }
  return null;
}

const HIDDEN = '\u0002';

/** Založí slot (hodnota se dosadí až do výsledného HTML – text escapovaně, raw beze změny) a vrátí jeho značku. */
function slotRef(slots, kind, value) {
  return `${SENT}${slots.push({ kind, value }) - 1}${SENT}`;
}

/**
 * Dosadí hodnoty jednoho záznamu cyklu do těla bloku: skalární hodnoty přes sloty (zůstanou escapované a nevykládají
 * se jako markdown), objekty a pole ponechá vnořeným blokům / globálnímu dosazení.
 */
function bindItem(inner, item, slots) {
  return inner.replace(PLACEHOLDER_RE, (all, name) => {
    if (!Object.hasOwn(item, name)) return all;
    const v = item[name];
    if (v === null || v === undefined) return '';
    if (isHtml(v)) return slotRef(slots, 'raw', String(v));
    if (typeof v === 'object') return all;
    return slotRef(slots, 'text', String(v));
  });
}

/**
 * Vyhodnotí bloky {{#X}}…{{/X}} a {{^X}}…{{/X}}; {{#X}} nad polem záznamů je cyklus. Značky samy na řádku spolknou
 * svůj konec řádku (viz hlavička). `slots` sbírá hodnoty dosazené v cyklech (sdílí se se substitute()).
 */
function applyConditionals(src, params, slots = []) {
  const openRe = /\{\{([#^])([A-Z][A-Z0-9_]*)\}\}/g;
  let out = '';
  let pos = 0;
  for (;;) {
    openRe.lastIndex = pos;
    const m = openRe.exec(src);
    if (!m) break;
    const tagEnd = m.index + m[0].length;
    const close = findClose(src, m[2], tagEnd);
    if (!close) {
      // neuzavřený blok → značku ponecháme jako text
      out += src.slice(pos, tagEnd);
      pos = tagEnd;
      continue;
    }
    const openAlone = (m.index === 0 || src[m.index - 1] === '\n') && src[tagEnd] === '\n';
    const closeAlone = src[close.start - 1] === '\n' && (close.end === src.length || src[close.end] === '\n');
    out += src.slice(pos, m.index);
    const inner = src.slice(openAlone ? tagEnd + 1 : tagEnd, close.start);
    const value = params[m[2]];
    const show = m[1] === '#' ? isTruthy(value) : !isTruthy(value);
    if (!show) {
      out += HIDDEN; // značka skrytého bloku – řádek, který zbyl prázdný, se pak smaže
      pos = close.end;
      continue;
    }
    if (m[1] === '#' && Array.isArray(value)) {
      // blok pokrývající celé řádky (např. {{#KOLA}}| … |{{/KOLA}}) se opakuje po řádcích, blok uvnitř věty plynule
      const lineBlock = (m.index === 0 || src[m.index - 1] === '\n') && (close.end === src.length || src[close.end] === '\n');
      const sep = lineBlock && !inner.endsWith('\n') ? '\n' : '';
      out += value.map((item) => applyConditionals(bindItem(inner, item && typeof item === 'object' ? item : {}, slots), { ...params, ...(item && typeof item === 'object' ? item : {}) }, slots)).join(sep);
    } else {
      out += applyConditionals(inner, params, slots);
    }
    // zobrazený blok se značkami na samostatných řádcích nezanechá za uzavírací značkou prázdný řádek
    pos = openAlone && closeAlone && src[close.end] === '\n' ? close.end + 1 : close.end;
  }
  return out + src.slice(pos);
}

/** Smaže řádky, které zbyly prázdné po skrytém bloku (např. podmíněný řádek tabulky), jinak značku jen odstraní. */
function dropHiddenLines(src) {
  if (!src.includes(HIDDEN)) return src;
  return src
    .split('\n')
    .filter((line) => !(line.includes(HIDDEN) && !line.replace(new RegExp(HIDDEN, 'g'), '').trim()))
    .map((line) => line.replace(new RegExp(HIDDEN, 'g'), ''))
    .join('\n');
}

/**
 * Dosadí parametry: textové hodnoty nahradí sloty (dosadí se escapované až po renderu), markdown hodnoty
 * se vloží do zdroje. Vrací { source, slots, missing }.
 */
function substitute(src, params, slots = []) {
  const missing = [];
  const lines = src.split('\n');
  const out = lines.map((line) => {
    const whole = /^\s*\{\{([A-Z][A-Z0-9_]*)\}\}\s*$/.exec(line);
    if (whole && Object.hasOwn(params, whole[1])) {
      const v = params[whole[1]];
      if (v && typeof v === 'object' && !isHtml(v) && typeof v.markdown === 'string') return v.markdown;
    }
    return line.replace(PLACEHOLDER_RE, (all, name) => {
      if (!Object.hasOwn(params, name)) {
        if (!missing.includes(name)) missing.push(name);
        return all;
      }
      const v = params[name];
      if (v === null || v === undefined) return '';
      if (isHtml(v)) return slotRef(slots, 'raw', String(v));
      if (Array.isArray(v)) return slotRef(slots, 'text', v.map((x) => (x && typeof x === 'object' ? '' : String(x))).filter(Boolean).join(', '));
      if (typeof v === 'object') {
        if (typeof v.html === 'string') return slotRef(slots, 'raw', v.html);
        if (typeof v.inline === 'string') return slotRef(slots, 'text', v.inline);
        if (typeof v.markdown === 'string') return slotRef(slots, 'text', plainText(v.markdown));
        return slotRef(slots, 'text', String(v));
      }
      return slotRef(slots, 'text', String(v));
    });
  });
  return { source: out.join('\n'), slots, missing };
}

/** Celé šablonování bez renderu (komentáře, interní sekce, podmínky a cykly, dosazení). */
function applyTemplate(src, params = {}, opts = {}) {
  const slots = [];
  let s = stripComments(src);
  s = stripInternal(s, opts);
  s = dropHiddenLines(applyConditionals(s, params, slots));
  return substitute(s, params, slots);
}

/** Nahradí sloty ve výsledném HTML (text escapovaně, raw beze změny). */
function fillSlots(html, slots) {
  return html.replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (all, idx) => {
    const slot = slots[Number(idx)];
    if (!slot) return '';
    return slot.kind === 'raw' ? slot.value : escape(slot.value);
  });
}

/** Sloty v prostém textu (pro slug / title / kontrolu URL). */
function resolveSlotsText(text, slots) {
  return String(text).replace(new RegExp(`${SENT}(\\d+)${SENT}`, 'g'), (all, idx) => {
    const slot = slots[Number(idx)];
    return slot ? (slot.kind === 'raw' ? slot.value.replace(/<[^>]*>/g, '') : slot.value) : '';
  });
}

// ---------------------------------------------------------------------------------------------------------
// Storno tabulka

/**
 * Storno tabulka ze settings.cancellation (dvouřádková, SPEC kap. 0 bod 2).
 * Vrací { markdown, inline } – markdown se vloží, je-li {{STORNO_TABULKA}} sám na řádku, jinak text inline.
 */
function stornoTable(cancellation = {}) {
  const h = Number(cancellation.freeHoursBefore);
  const hours = Number.isFinite(h) && h > 0 ? h : 48;
  const markdown = [
    '| Zrušení nám dojde | Vrátíme z rezervačního poplatku za zrušené kolo | Ponecháme si |',
    '|---|---|---|',
    `| nejméně ${hours} hodin před začátkem nájmu | 100 % | 0 % |`,
    `| méně než ${hours} hodin před začátkem nájmu, nebo kola nevyzvednete | 0 % | 100 % (poplatek propadá) |`,
  ].join('\n');
  const inline = `zrušení nejméně ${hours} hodin před začátkem nájmu: vrátíme celý rezervační poplatek · později nebo při nevyzvednutí kol: poplatek propadá`;
  return { markdown, inline, hours };
}

// ---------------------------------------------------------------------------------------------------------
// Výřez sekcí

/**
 * Vrátí markdown jen vybraných sekcí druhé úrovně (## …), jejichž text nadpisu odpovídá některému vzoru,
 * včetně obsahu až po další nadpis úrovně ≤ 2. Hodí se pro /reklamace (OP čl. 12–13).
 * @param {string} src
 * @param {(RegExp|string)[]} matchers
 */
function extractSections(src, matchers) {
  const res = matchers.map((m) => (m instanceof RegExp ? m : new RegExp('^' + m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))));
  const lines = String(src).split('\n');
  const out = [];
  let keep = false;
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const level = inFence ? 0 : headingLevel(line);
    if (level && level <= 2) {
      const text = plainText(headingText(line));
      keep = res.some((re) => re.test(text));
    }
    if (keep) out.push(line);
  }
  return out.join('\n').trim() + '\n';
}

// ---------------------------------------------------------------------------------------------------------
// Inline parser

const ESCAPABLE = new Set(['\\', '`', '*', '_', '{', '}', '[', ']', '(', ')', '#', '+', '-', '.', '!', '|', '>', '<']);
const AUTOLINK_RE = /^https?:\/\/[^\s<>()[\]"'`]+/i;

function safeHref(url, ctx) {
  let raw = resolveSlotsText(url, ctx.slots).trim();
  // odkazy na sousední šablony (.md) → veřejné cesty, nebo bez odkazu
  const md = /^([a-z0-9-]+\.md)(#.*)?$/i.exec(raw);
  if (md) {
    const mapped = ctx.linkMap && ctx.linkMap[md[1].toLowerCase()];
    if (!mapped) return null;
    raw = mapped + (md[2] || '');
  }
  if (/^\.\.?\//.test(raw)) return null; // relativní cesty do repozitáře nemají na webu smysl
  if (!SAFE_URL_RE.test(raw)) return null;
  return raw;
}

function trimAutolink(url) {
  let u = url;
  let trailing = '';
  while (u.length && /[.,;:!?)]$/.test(u)) {
    // závorka patří k URL, jen je-li uvnitř otevřená
    if (u.endsWith(')') && (u.match(/\(/g) || []).length >= (u.match(/\)/g) || []).length) break;
    trailing = u[u.length - 1] + trailing;
    u = u.slice(0, -1);
  }
  return { url: u, trailing };
}

/** Inline render: text → HTML (escapovaný). */
function inline(text, ctx) {
  let out = '';
  let plain = '';
  const flush = () => {
    if (plain) out += escape(plain);
    plain = '';
  };
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < n && ESCAPABLE.has(text[i + 1])) {
      plain += text[i + 1];
      i += 2;
      continue;
    }
    if (ch === '`') {
      const end = text.indexOf('`', i + 1);
      if (end > i) {
        flush();
        out += `<code>${escape(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }
    if (text.startsWith('**', i)) {
      let end = text.indexOf('**', i + 2);
      // „**tučné *s kurzívou***“ – u trojité hvězdičky patří první k vnořené kurzívě, je-li uvnitř nespárovaná
      if (end > i + 2 && text[end + 2] === '*') {
        const singles = (text.slice(i + 2, end).replace(/\*\*/g, '').match(/\*/g) || []).length;
        if (singles % 2 === 1) end += 1;
      }
      if (end > i + 2) {
        flush();
        out += `<strong>${inline(text.slice(i + 2, end), ctx)}</strong>`;
        i = end + 2;
        continue;
      }
    }
    if (ch === '*' && i + 1 < n && !/\s/.test(text[i + 1])) {
      let end = text.indexOf('*', i + 1);
      while (end > 0 && /\s/.test(text[end - 1])) end = text.indexOf('*', end + 1);
      if (end > i + 1) {
        flush();
        out += `<em>${inline(text.slice(i + 1, end), ctx)}</em>`;
        i = end + 1;
        continue;
      }
    }
    if (ch === '[') {
      const link = parseLink(text, i);
      if (link) {
        flush();
        const href = safeHref(link.url, ctx);
        const label = inline(link.text, ctx);
        out += href ? `<a href="${escape(href)}"${/^https?:/i.test(href) ? ' rel="noopener"' : ''}>${label}</a>` : label;
        i = link.end;
        continue;
      }
    }
    if ((ch === 'h' || ch === 'H') && (i === 0 || /[\s(>„"']/.test(text[i - 1]))) {
      const m = AUTOLINK_RE.exec(text.slice(i));
      if (m) {
        const { url, trailing } = trimAutolink(m[0]);
        flush();
        const href = resolveSlotsText(url, ctx.slots);
        out += `<a href="${escape(href)}" rel="noopener">${escape(href)}</a>`;
        plain += trailing;
        i += m[0].length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  flush();
  return out;
}

/** [text](url) – text může obsahovat vnořené hranaté závorky o jednu úroveň. */
function parseLink(text, start) {
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || text[i + 1] !== '(') return null;
  const label = text.slice(start + 1, i);
  let j = i + 2;
  let pdepth = 1;
  for (; j < text.length; j++) {
    if (text[j] === '(') pdepth++;
    else if (text[j] === ')') {
      pdepth--;
      if (pdepth === 0) break;
    }
    if (/\s/.test(text[j]) && !/\s"/.test(text.slice(j, j + 2))) return null;
  }
  if (pdepth !== 0) return null;
  let url = text.slice(i + 2, j);
  const title = /^(\S+)\s+"[^"]*"$/.exec(url);
  if (title) url = title[1];
  return { text: label, url, end: j + 1 };
}

// ---------------------------------------------------------------------------------------------------------
// Blokový parser

const HR_RE = /^\s{0,3}(-{3,}|\*{3,}|_{3,})\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const FENCE_RE = /^\s*```/;

function isTableStart(lines, i) {
  return lines[i].includes('|') && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]) && lines[i + 1].includes('-');
}

function startsBlock(lines, i) {
  const line = lines[i];
  return !line.trim() || FENCE_RE.test(line) || HR_RE.test(line) || headingLevel(line) > 0 || /^\s{0,3}>/.test(line) || LIST_RE.test(line) || isTableStart(lines, i);
}

function splitCells(line) {
  const cells = [];
  let cur = '';
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '\\' && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (ch === '`') inCode = !inCode;
    if (ch === '|' && !inCode) {
      cells.push(cur);
      cur = '';
    } else cur += ch;
  }
  cells.push(cur);
  if (cells.length && !cells[0].trim() && /^\s*\|/.test(line)) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim() && /\|\s*$/.test(line)) cells.pop();
  return cells.map((c) => c.trim());
}

function renderTable(rows, ctx) {
  const head = splitCells(rows[0]);
  const cols = head.length;
  const body = rows.slice(2).map((r) => {
    const cells = splitCells(r);
    while (cells.length < cols) cells.push('');
    return cells.slice(0, cols);
  });
  const hasHead = head.some((c) => c.trim());
  let html = '<div class="table-wrap"><table class="table">';
  if (hasHead) html += `<thead><tr>${head.map((c) => `<th scope="col">${inline(c, ctx)}</th>`).join('')}</tr></thead>`;
  html += `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return html;
}

function renderList(items, ctx) {
  if (!items.length) return '';
  const ordered = items[0].ordered;
  const start = ordered ? Number.parseInt(items[0].marker, 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  const attrs = ordered && start !== 1 ? ` start="${start}"` : '';
  return `<${tag}${attrs}>${items.map((it) => `<li>${inline(it.text, ctx)}${renderList(it.children, ctx)}</li>`).join('')}</${tag}>`;
}

function parseList(lines, i) {
  const first = LIST_RE.exec(lines[i]);
  const base = first[1].length;
  const items = [];
  let j = i;
  for (; j < lines.length; j++) {
    const line = lines[j];
    if (!line.trim()) {
      // volný seznam: prázdný řádek následovaný další položkou se stejným odsazením
      let k = j + 1;
      while (k < lines.length && !lines[k].trim()) k++;
      if (k < lines.length && LIST_RE.test(lines[k]) && LIST_RE.exec(lines[k])[1].length <= base) continue;
      break;
    }
    const m = LIST_RE.exec(line);
    if (m) {
      const indent = m[1].length;
      const item = { marker: m[2], ordered: /\d/.test(m[2]), text: m[3], children: [] };
      if (indent <= base || !items.length) {
        if (indent < base) break;
        items.push(item);
      } else {
        items[items.length - 1].children.push(item);
      }
      continue;
    }
    if (/^\s+\S/.test(line) && items.length) {
      const last = items[items.length - 1];
      const target = last.children.length ? last.children[last.children.length - 1] : last;
      target.text += ' ' + line.trim();
      continue;
    }
    break;
  }
  return { html: renderList(items, ctx0(lines)), end: j, items };
}

// ctx se do parseList předává přes closure níže – tato pomocná funkce jen zabrání use-before-define varování
function ctx0() {
  return parseList.ctx;
}

function parseBlocks(lines, ctx) {
  parseList.ctx = ctx;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (FENCE_RE.test(line)) {
      const code = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    const level = headingLevel(line);
    if (level) {
      const text = headingText(line);
      const plain = plainText(resolveSlotsText(text, ctx.slots));
      let id = slugify(plain);
      if (ctx.ids.has(id)) {
        let k = 2;
        while (ctx.ids.has(`${id}-${k}`)) k++;
        id = `${id}-${k}`;
      }
      ctx.ids.add(id);
      ctx.headings.push({ level, id, text: plain });
      if (level === 1 && !ctx.title) ctx.title = plain;
      out.push(`<h${level} id="${id}">${inline(text, ctx)}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const inner = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) inner.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      out.push(`<blockquote>${parseBlocks(inner, ctx)}</blockquote>`);
      continue;
    }
    if (isTableStart(lines, i)) {
      const rows = [lines[i], lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|') && !headingLevel(lines[i])) rows.push(lines[i++]);
      out.push(renderTable(rows, ctx));
      continue;
    }
    if (LIST_RE.test(line)) {
      const { html, end } = parseList(lines, i);
      out.push(html);
      i = end;
      continue;
    }
    // odstavec
    const para = [line];
    i++;
    while (i < lines.length && !startsBlock(lines, i)) para.push(lines[i++]);
    const text = para.map((l) => l.trim()).join('\n');
    if (resolveSlotsText(text, ctx.slots).trim()) out.push(`<p>${para.map((l) => inline(l.trim(), ctx)).join('<br>')}</p>`);
  }
  return out.join('\n');
}

/** Čistý Markdown → HTML (bez šablonování). Vrací { html, headings, title }. */
function renderMarkdown(src, opts = {}) {
  const ctx = { slots: opts.slots || [], ids: new Set(), headings: [], title: null, linkMap: opts.linkMap || {} };
  const html = parseBlocks(String(src).replace(/\r\n?/g, '\n').split('\n'), ctx);
  return { html, headings: ctx.headings, title: ctx.title };
}

/**
 * Šablonování + render.
 * @param {string} src markdown šablona
 * @param {object} params slovník parametrů
 * @param {{cancellation?: object, omitHeadings?: (RegExp|string)[], only?: (RegExp|string)[], linkMap?: object}} [opts]
 */
function render(src, params = {}, opts = {}) {
  const p = { ...params };
  if (!Object.hasOwn(p, 'STORNO_TABULKA') && opts.cancellation) p.STORNO_TABULKA = stornoTable(opts.cancellation);
  if (p.STORNO_TABULKA && typeof p.STORNO_TABULKA === 'object' && !isHtml(p.STORNO_TABULKA) && !p.STORNO_TABULKA.markdown && p.STORNO_TABULKA.freeHoursBefore !== undefined) {
    p.STORNO_TABULKA = stornoTable(p.STORNO_TABULKA);
  }
  let source = String(src).replace(/\r\n?/g, '\n');
  if (opts.only && opts.only.length) source = extractSections(stripComments(source), opts.only);
  const t = applyTemplate(source, p, opts);
  const r = renderMarkdown(t.source, { slots: t.slots, linkMap: opts.linkMap });
  return { html: fillSlots(r.html, t.slots), headings: r.headings, title: r.title, missing: t.missing };
}

/** Posbírá názvy všech placeholderů {{X}}, {{#X}}, {{^X}} ze zdroje (bez uzavíracích značek). */
function collectPlaceholders(src) {
  const names = new Set();
  for (const m of String(src).matchAll(/\{\{([#^]?)([A-Z][A-Z0-9_]*)\}\}/g)) names.add(m[2]);
  return [...names].sort();
}

module.exports = {
  render,
  renderMarkdown,
  applyTemplate,
  applyConditionals,
  stripInternal,
  stripComments,
  substitute,
  fillSlots,
  stornoTable,
  extractSections,
  collectPlaceholders,
  isTruthy,
  slugify,
  plainText,
  INTERNAL_HEADINGS,
};
