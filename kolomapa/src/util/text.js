'use strict';
// Textové pomocníky: odstranění diakritiky, dekódování HTML entit, HTML → text, parsování cen a dat.

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  bdquo: '„', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', sbquo: '‚', laquo: '«', raquo: '»',
  deg: '°', times: '×', euro: '€', copy: '©', reg: '®', trade: '™', shy: '', zwnj: '', zwj: '',
};

/** Dekóduje HTML entity (&amp; &#353; &#x161; &nbsp; …). */
function decodeEntities(s) {
  if (s == null) return '';
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v != null ? v : m;
  });
}

/** HTML fragment → prostý text (zachová konce řádků z <br>, </p>, </li>, </div>). */
function htmlToText(html) {
  if (html == null) return '';
  let s = String(html)
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|h[1-6])(\s[^>]*)?>/gi, '\n')
    .replace(/<\/li\s*>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** Odstraní diakritiku a převede na malá písmena („Ústí nad Labem“ → „usti nad labem“). */
function fold(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Klíč pro porovnávání: bez diakritiky, jen písmena/číslice oddělené jednou mezerou. */
function keyOf(s) {
  return fold(s)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Najde cenu v Kč v textu („12 500 Kč“, „12.500,-“, „12 tis.“, „12k“). Vrací číslo nebo null.
 * Text bez číslic („Dohodou“, „V textu“, „Nabídněte“) → null.
 */
function parseCzk(s) {
  if (s == null) return null;
  if (typeof s === 'number') return Number.isFinite(s) && s > 0 ? Math.round(s) : null;
  const t = decodeEntities(String(s)).replace(/ /g, ' ').trim();
  if (!t) return null;
  // „12 tis.“, „45k“ – ale ne „170 000 Kč“ (K následované písmenem)
  let m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:tis\.?|tisíc|k)(?![a-záčďéěíňóřšťúůýž])/i);
  if (m) {
    const n = Number(m[1].replace(',', '.')) * 1000;
    return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
  }
  m = t.match(/\d{1,3}(?:[ . ]\d{3})+(?:,\d{1,2})?|\d+(?:,\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0].replace(/[ . ]/g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** Datum „2.10. 2026“ / „2. 10. 2026“ / „02.10.2026“ → ISO „2026-10-02“ (nebo null). */
function parseCzDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** PSČ z textu („393 01“, „39301“) → „39301“ nebo null. */
function parsePsc(s) {
  if (!s) return null;
  const m = String(s).match(/\b([1-7]\d{2})\s?(\d{2})\b/);
  return m ? m[1] + m[2] : null;
}

/** Krátký stabilní otisk řetězce (FNV-1a 32 bit, hex). */
function hash(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Zkrátí text na max. n znaků (na hranici slova) a přidá „…“. */
function truncate(s, n) {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const sp = cut.lastIndexOf(' ');
  return (sp > n * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + '…';
}

module.exports = { decodeEntities, htmlToText, fold, keyOf, parseCzk, parseCzDate, parsePsc, hash, truncate };
