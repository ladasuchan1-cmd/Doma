/*
 * Extrakce čitelného textu z HTML – dvě cesty:
 *   - fromDocument(doc): v content skriptu, používá DOM (odstraní navigaci, skripty, patičky…)
 *   - fromHtml(html):    ve service workeru, kde DOMParser není – regexová konverze HTML → text.
 */
(function (root) {
  'use strict';

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'NAV', 'HEADER', 'FOOTER', 'ASIDE', 'BUTTON', 'SELECT', 'OPTION', 'INPUT', 'TEXTAREA']);
  const BLOCK_TAGS = new Set(['P', 'DIV', 'LI', 'TR', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BR', 'SECTION', 'ARTICLE', 'BLOCKQUOTE', 'PRE', 'DL', 'DT', 'DD', 'UL', 'OL', 'TABLE']);

  function cleanWhitespace(s) {
    return s
      .replace(/ /g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/ *\n */g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function pickMainRoot(doc) {
    const candidates = [
      doc.querySelector('main'),
      doc.querySelector('article'),
      doc.querySelector('[role="main"]'),
      doc.querySelector('#content, #main, .content, .main-content, .terms, .legal, .page-content'),
    ].filter(Boolean);
    let best = doc.body;
    let bestLen = (doc.body && doc.body.innerText ? doc.body.innerText.length : 0) * 0.5; // hlavní blok musí mít aspoň polovinu textu
    for (const c of candidates) {
      const len = (c.innerText || '').length;
      if (len > bestLen) { best = c; bestLen = len; }
    }
    return best || doc.body;
  }

  function walk(node, parts) {
    if (!node) return;
    if (node.nodeType === 3) { parts.push(node.nodeValue); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName;
    if (SKIP_TAGS.has(tag)) return;
    const style = node.ownerDocument && node.ownerDocument.defaultView ? node.ownerDocument.defaultView.getComputedStyle(node) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return;
    if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
    const block = BLOCK_TAGS.has(tag);
    if (block) parts.push('\n');
    if (/^H[1-6]$/.test(tag)) parts.push('\n## ');
    for (const child of node.childNodes) walk(child, parts);
    if (block) parts.push('\n');
  }

  function fromDocument(doc, opts) {
    const root = (opts && opts.root) || pickMainRoot(doc);
    const parts = [];
    walk(root, parts);
    return cleanWhitespace(parts.join(''));
  }

  const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', ndash: '–', mdash: '—', euro: '€', copy: '©', reg: '®',
    laquo: '«', raquo: '»', bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', middot: '·', deg: '°', sect: '§', para: '¶', trade: '™', pound: '£', yen: '¥',
    aacute: 'á', Aacute: 'Á', eacute: 'é', Eacute: 'É', iacute: 'í', Iacute: 'Í', oacute: 'ó', Oacute: 'Ó', uacute: 'ú', Uacute: 'Ú', yacute: 'ý', Yacute: 'Ý',
    ecaron: 'ě', Ecaron: 'Ě', scaron: 'š', Scaron: 'Š', ccaron: 'č', Ccaron: 'Č', rcaron: 'ř', Rcaron: 'Ř', zcaron: 'ž', Zcaron: 'Ž', dcaron: 'ď', Dcaron: 'Ď', tcaron: 'ť', Tcaron: 'Ť', ncaron: 'ň', Ncaron: 'Ň', uring: 'ů', Uring: 'Ů',
    auml: 'ä', Auml: 'Ä', ouml: 'ö', Ouml: 'Ö', uuml: 'ü', Uuml: 'Ü', szlig: 'ß', lstrok: 'ł', Lstrok: 'Ł', ocirc: 'ô', acirc: 'â', agrave: 'à', egrave: 'è', ccedil: 'ç', ntilde: 'ñ',
  };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e] !== undefined ? ENTITIES[e] : (ENTITIES[e.toLowerCase()] !== undefined ? ENTITIES[e.toLowerCase()] : m);
    });
  }

  function fromHtml(html) {
    let s = String(html || '');
    s = s.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|noscript|template|svg|iframe|nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
    // Zkus vybrat <main> nebo <article>, když nese většinu obsahu.
    const mainMatch = s.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
    if (mainMatch && mainMatch[2].length > s.length * 0.3) s = mainMatch[2];
    s = s.replace(/<h[1-6]\b[^>]*>/gi, '\n## ');
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|section|article|blockquote|dd|dt|table|ul|ol|pre)>/gi, '\n');
    s = s.replace(/<br\s*\/?>/gi, '\n');
    s = s.replace(/<[^>]+>/g, ' ');
    s = decodeEntities(s);
    return cleanWhitespace(s);
  }

  function titleFromHtml(html) {
    const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return m ? cleanWhitespace(decodeEntities(m[1].replace(/<[^>]+>/g, ' '))) : '';
  }

  // Jednoduchý stabilní hash textu (FNV-1a) pro cache.
  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0') + '-' + str.length.toString(16);
  }

  const API = { fromDocument, fromHtml, titleFromHtml, cleanWhitespace, hash, decodeEntities };
  root.TermsExtract = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
