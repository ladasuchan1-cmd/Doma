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

// ---------------------------------------------------------------- skrývání kontaktů (osobní údaje)

/**
 * Verze pravidel scrubContacts. Zvýšit při každém rozšíření – uložené titulky a popisy (zpracované starší verzí) je
 * pak potřeba projít znovu (např. migrace v src/db.js / pipeline podle uložené verze).
 */
const SCRUB_VERSION = 2;

const PHONE = '[telefon skryt]';
const EMAIL = '[e-mail skryt]';
const SOCIAL = '[kontakt skryt]';
const NAME = '[jméno skryto]';
const ACCOUNT = '[číslo účtu skryto]';

// Oddělovač skupin číslic v jednom řádku (mezera, nezlomitelná mezera, tečka, pomlčka, spojovník). Bez lomítka –
// „500/625/750 Wh“ nebo „160/170/180 cm“ nejsou telefony – a bez konce řádku (seznam hodnot pod sebou).
const SEP = '[ \\t\\u00a0.\\-\\u2013]';
// S lomítkem – jen tam, kde o telefonu nejsou pochyby (za předvolbou nebo slovem „tel.“).
const SEPX = '[ \\t\\u00a0.\\-\\u2013/]';
// Před číslem nesmí být písmeno/číslice (kód dílu „RTL515“), ani číslice s oddělovačem („0 275 007 543“ je číslo
// dílu Bosch), ani část adresy URL (…/p/622123456, ?id=…).
const START = '(?<![\\p{L}\\p{N}_/=?&#%@])(?<!\\p{N}[ \\t\\u00a0.\\-\\u2013])';
// Za číslem nesmí pokračovat číslice ani desetinná část, ani jednotka či měna („250 000 000 Kč“, „622 25 28 32 mm“).
const END =
  '(?!\\p{N})(?!\\.\\p{N})' +
  '(?![ \\t\\u00a0]?(?:[kK][čČcC]|CZK|czk|EUR|eur|€|,-|mm|cm|km|kg|kWh|kwh|Wh|wh|mAh|Ah|Nm|%)(?![\\p{L}]))' +
  '(?![vVwWxX×](?![\\p{L}]))';
// Předvolba ČR/SR: +420, 00420, (+420), (420).
const PREFIX = '(?:\\(\\s?(?:\\+|00)?\\s?42[01]\\s?\\)|(?:\\+|00)\\s?42[01])';
// Slova, za kterými následuje telefon (tel., telefonu, mobil, volejte, SMS, WhatsApp …) – ne „teleskopická“.
const PHONE_WORD =
  '(?<![\\p{L}])(?:tel(?:efon\\p{L}*)?|mob(?:il\\p{L}*)?|volat|volejte|zavolej\\p{L}*|kontakt\\p{L}*|sms|whats ?app|wapp|viber|signal|telegram|na čísl[oe]|č\\. ?tel)(?![\\p{L}])';

const PHONE_RX = [
  // klíčové slovo + číslo v jakémkoli seskupení („tel. 77 71 23 456“, „mobil: 777/123/456“), i s předvolbou
  [
    new RegExp(`(${PHONE_WORD}[^\\p{N}\\n+(]{0,25}?)((?:${PREFIX}${SEPX}*|42[01]${SEPX}?(?=[2-9]))?(?:0(?=9))?[2-9](?:${SEPX}?\\p{N}){8})${END}`, 'giu'),
    `$1${PHONE}`,
  ],
  // předvolba + 9 číslic v jakémkoli seskupení („+420 777 12 34 56“, „(+420) 777123456“, „00421 905 123 456“)
  [new RegExp(`(?<!\\p{N})${PREFIX}${SEPX}*\\p{N}(?:${SEPX}?\\p{N}){8}(?!\\p{N})`, 'gu'), PHONE],
  // předvolba bez „+“: odkazy WhatsApp (wa.me/420777123456) a „420 777 123 456“
  [new RegExp(`(?<!\\p{N})42[01](?:[2-9]\\p{N}{8}|${SEP}[2-9]\\p{N}{2}${SEP}\\p{N}{3}${SEP}\\p{N}{3})${END}`, 'gu'), PHONE],
];
// Čísla bez klíčového slova – jen obvyklá seskupení a předčíslí podle číslovacího plánu ČR: pevné linky 2xx, 31x–59x,
// mobily 601–608, 702–705, 72x–79x, ostatní 91x–99x („622 25 28 32“ ani „/p/622123456“ telefon nejsou).
const MOBILE = '(?:60[1-8]|7(?:0[2-5]|[2-9]\\d))';
const PHONE3 = '(?:2\\d{2}|[3-5][1-9]\\d|60[1-8]|7(?:0[2-5]|[2-9]\\d)|9[1-9]\\d)';
// … a nesmí pokračovat další trojicí – výčet „480 500 520 540 mm“ nebo stránkování „591 592 593 594“ není telefon.
const NO_MORE = `(?!${SEP}\\d{3}(?!\\p{N}))`;
const PHONE_BARE_RX = [
  // dvě mobilní čísla hned za sebou („777 123 456 602 111 222“) – jednotlivě by se blokovala kontrolou okolí
  [new RegExp(`${START}${MOBILE}${SEP}\\d{3}${SEP}\\d{3}${SEP}${MOBILE}${SEP}\\d{3}${SEP}\\d{3}${END}${NO_MORE}`, 'gu'), `${PHONE} ${PHONE}`],
  // 777 123 456, 777-123-456, 224 123 456 (pevná linka)
  [new RegExp(`${START}${PHONE3}${SEP}\\d{3}${SEP}\\d{3}${END}${NO_MORE}`, 'gu'), PHONE],
  // 777 12 34 56, 604 11 22 33 (stejný oddělovač)
  [new RegExp(`${START}${PHONE3}(${SEP})\\d{2}\\1\\d{2}\\1\\d{2}${END}`, 'gu'), PHONE],
  // 777 123456, 777123 456 (mobil)
  [new RegExp(`${START}${MOBILE}${SEP}\\d{6}${END}`, 'gu'), PHONE],
  [new RegExp(`${START}${MOBILE}\\d{3}${SEP}\\d{3}${END}${NO_MORE}`, 'gu'), PHONE],
  // 777123456 (mobil; číslo inzerátu 224568683 zůstane)
  [new RegExp(`${START}${MOBILE}\\d{6}${END}`, 'gu'), PHONE],
  // 7 7 7 1 2 3 4 5 6 (rozepsané po číslicích)
  [new RegExp(`${START}[67](?:[ .\\-]\\d){8}(?![ .\\-]?\\p{N})`, 'gu'), PHONE],
  // slovenské 0905 123 456 / 0905123456
  [new RegExp(`${START}09\\d{2}${SEP}?\\d{3}${SEP}?\\d{3}${END}`, 'gu'), PHONE],
];

const EMAIL_LOCAL = '(?<![\\p{L}\\p{N}._%+\\-])[\\p{L}\\p{N}._%+\\-]+';
const EMAIL_DOMAIN = '[\\p{L}\\p{N}\\-]+';
const MAIL_PROVIDERS = '(?:seznam|gmail|email|centrum|post|volny|atlas|icloud|outlook|hotmail|yahoo|tiscali|azet|zoznam|proton(?:mail)?)';
// Zástupné „zavináče“ a „tečky“: (at) [at] {at} <at> (zavináč) „ at “ „ zavináč “ / (dot) [tečka] „ tečka “ „ . “
const OBF_AT = '(?:\\s?[([{<]\\s?(?:at|zavin[aá][cč])\\s?[)\\]}>]\\s?|\\s(?:at|zavin[aá][cč])\\s)';
const OBF_DOT = '(?:\\s?[([{<]\\s?(?:dot|te[cč]ka)\\s?[)\\]}>]\\s?|\\s(?:dot|te[cč]ka)\\s|\\s?\\.\\s?)';
const OBF_TLD = '(?:cz|sk|com|eu|net|org|info|de|at|pl|hu|uk|io|me|biz)';
const EMAIL_RX = [
  // jan.novak@seznam.cz, jiří@seznam.cz, jan.novak @ seznam.cz
  new RegExp(`${EMAIL_LOCAL}\\s?@\\s?${EMAIL_DOMAIN}(?:\\.${EMAIL_DOMAIN})*\\.\\p{L}{2,}(?![\\p{L}\\p{N}])`, 'giu'),
  // jan.novak@seznam (bez domény nejvyšší úrovně)
  new RegExp(`${EMAIL_LOCAL}\\s?@\\s?${MAIL_PROVIDERS}(?![\\p{L}\\p{N}.])`, 'giu'),
  // jan.novak(at)seznam.cz, jan.novak [zavináč] seznam tečka cz, jan.novak (at) gmail
  new RegExp(
    `${EMAIL_LOCAL}${OBF_AT}(?:${EMAIL_DOMAIN}(?:${OBF_DOT}${EMAIL_DOMAIN})*?${OBF_DOT}${OBF_TLD}|${MAIL_PROVIDERS})(?![\\p{L}\\p{N}])`,
    'giu'
  ),
];

// Odkazy na profily a chaty (WhatsApp, Telegram, Messenger, Facebook, Instagram …) – vedou přímo na osobu.
const SOCIAL_RX = [
  new RegExp(
    '(?<![\\p{L}\\p{N}_.\\-/@])(?:https?://)?(?:[\\p{L}\\p{N}\\-]+\\.)*' +
      '(?:wa\\.me|whatsapp\\.com|t\\.me|telegram\\.(?:me|org)|m\\.me|messenger\\.com|facebook\\.com|fb\\.com|fb\\.me|instagram\\.com|instagr\\.am|tiktok\\.com|twitter\\.com|linkedin\\.com)' +
      // cesta za doménou; interpunkce na konci věty („…/jannovak, nebo“) do odkazu nepatří
      '/(?:[^\\s<>"\'\\])]*[^\\s<>"\'\\]).,;:!?])?',
    'giu'
  ),
  /\b(?:whatsapp|viber|tg|skype):\/{0,2}[^\s<>"']*[^\s<>"'.,;:!?]/gi,
  // @prezdivka (Instagram, Telegram …) – e-maily už jsou v tu chvíli skryté
  /(?<![\p{L}\p{N}_.\-/@])@[\p{L}_][\p{L}\p{N}_]{2,}(?:\.[\p{L}\p{N}_]+)*/gu,
];

// Rodné číslo (i v DIČ fyzické osoby), IBAN a číslo účtu u slova „účet“.
const RC_RX = /(?<![\p{N}/])(\d{2})([0-35-8]\d)([0-3]\d)\s?\/\s?(\d{4})(?![\p{N}/])/gu;
// DIČ za slovem „DIČ“ vždy (u fyzické osoby = rodné číslo), samotné „CZ“ + 10 číslic jen jako platné rodné číslo
const DIC_RX = /((?<![\p{L}\p{N}])DI[ČC](?![\p{L}\p{N}])\s*[:.]?\s*)(?:CZ|SK)?\s?\d{8,10}(?!\p{N})/gu;
const DIC_PERSON_RX = /(?<![\p{L}\p{N}])(CZ|SK)\s?(\d{10})(?!\p{N})/gu;
const IBAN_RX = /(?<![\p{L}\p{N}])(?:CZ|SK)\d{2}(?:[ \u00a0]?\d{4}){5}(?!\p{N})/gu;
const ACCOUNT_RX =
  /((?<![\p{L}])(?:č\.\s?ú\.?|č\.\s?účtu|bankovní\s+spojení|bank\.\s?spoj\.?|(?:bankovní\s+)?účet|účtu|ucet|uctu)(?![\p{L}])[^\p{N}\n]{0,15}?)((?:\d{1,6}\s?-\s?)?\d{2,10}\s?\/\s?\d{4})(?!\p{N})/giu;
// IČO / IČ (u živnostníka vede přímo na jméno a adresu v ARES)
const ICO_RX = /((?<![\p{L}\p{N}])I[ČC]O?(?![\p{L}\p{N}])\s*[:.]?\s*)(\d{3}[ \u00a0]?\d{2}[ \u00a0]?\d{3}|\d{8})(?!\p{N})/gu;

/** Platné rodné číslo (10 číslic, dělitelné 11, nebo zbytek 10 a poslední číslice 0)? */
function isBirthNumber(digits) {
  if (!/^\d{10}$/.test(digits)) return false;
  const r = Number(digits.slice(0, 9)) % 11;
  return Number(digits) % 11 === 0 || (r === 10 && digits[9] === '0');
}

// Jména: za skrytým telefonem / e-mailem na konci řádku („volejte 777 12 34 56 Novák“), „pan Novák“, „S pozdravem
// Jan Novák“, „Jméno: Jan“. Běžná slova s velkým písmenem a velká města nejsou jména.
const NOT_NAMES = new Set(
  (
    'děkuji dekuji díky diky dík prodám prodam prodávám prodavam kolo kola cena kč kc pouze jen nebo volejte volat pište piste ' +
    'sms tel telefon mobil osobní osobni odběr odber možnost moznost info více vice dohoda sleva stav nové nove nový novy ' +
    'zdravím zdravim dobrý dobry den prosím prosim ideálně idealne nejlépe nejlepe kdykoliv kdykoli večer vecer ráno rano ' +
    'whatsapp viber messenger signal telegram email mail cz sk ' +
    'praha brno ostrava plzeň plzen olomouc liberec zlín zlin pardubice kladno jihlava opava most teplice karviná karvina ' +
    'havířov havirov chomutov děčín decin tábor tabor třebíč trebic znojmo kolín kolin příbram pribram písek pisek'
  ).split(' ')
);
const NAME_WORD = '\\p{Lu}\\p{Ll}+(?:-\\p{Lu}\\p{Ll}+)?';
const NAME_RX = [
  // za skrytým kontaktem: „[telefon skryt] Novák“, „[telefon skryt] - Petr Novák.“
  new RegExp(
    `(\\[(?:telefon|e-mail) skryt\\][ \\t]*[-\\u2013,/]?[ \\t]*)(${NAME_WORD}(?:[ \\t]+${NAME_WORD})?)(?=[ \\t]*(?:[.,;!)]|\\r?\\n|$))`,
    'gmu'
  ),
  // „pan Novák“, „paní Nováková“, „sl. Nováková“
  new RegExp(`((?<![\\p{L}])(?:[Pp]an|[Pp]aní|[Pp]í|[Ss]lečna|[Ss]l\\.)[ \\t]+)(${NAME_WORD}(?:[ \\t]+${NAME_WORD})?)`, 'gu'),
  // „S pozdravem Jan Novák“, „Jméno: Jan“, „Kontaktní osoba: Jan Novák“
  new RegExp(
    `((?<![\\p{L}])(?:[Ss] pozdravem[ \\t]*,?\\s*|(?:[Jj]méno|[Kk]ontaktní osoba|[Pp]rodávající|[Pp]rodejce)[ \\t]*:[ \\t]*))(${NAME_WORD}(?:[ \\t]+${NAME_WORD})?)`,
    'gu'
  ),
];

function replaceName(m, lead, name) {
  const words = name.split(/[ \t]+/);
  if (NOT_NAMES.has(fold(words[0]))) return m;
  // druhé slovo, které není jméno („[telefon skryt] Petr Děkuji“), ponechat
  if (words.length > 1 && NOT_NAMES.has(fold(words[1]))) return `${lead}${NAME} ${words.slice(1).join(' ')}`;
  return `${lead}${NAME}`;
}

/**
 * Skryje kontakty a osobní údaje, které prodávající napsali do titulku či popisu inzerátu – repozitář i statická mapa
 * můžou být veřejné. Skrývá:
 *  - telefony: s předvolbou (+420, 00420, (+420), 420… v odkazech WhatsApp) v jakémkoli seskupení, za slovy
 *    tel./mobil/volejte/SMS/WhatsApp v jakémkoli seskupení, jinak obvyklá seskupení (777 123 456, 777 12 34 56,
 *    777 123456, 777123456, 7 7 7 1 2 3 4 5 6, slovenské 0905 123 456),
 *  - e-maily (i s diakritikou, „ @ “, (at), [zavináč], „ tečka “),
 *  - odkazy na WhatsApp, Telegram, Messenger, Facebook, Instagram … a @přezdívky,
 *  - rodná čísla, DIČ fyzických osob, IČO, IBAN a čísla účtů u slova „účet“,
 *  - jména u kontaktu („777 12 34 56 Novák“, „pan Novák“, „S pozdravem Jan Novák“, „Jméno: Jan“).
 * Ceny („150 000 Kč“, „250 000 000 Kč“), roky, čísla inzerátů (224568683), PSČ, rozměry a výbava („500/625/750 Wh“,
 * „160/170/180 cm“, „622 25 28 32 mm“), čísla dílů („0 275 007 543“) a odkazy na výrobce zůstanou.
 * Funkce je idempotentní (skrytý text se dalším voláním nezmění).
 * @param {string|null|undefined} s
 * @returns {string|null|undefined}
 */
function scrubContacts(s) {
  if (s == null) return s;
  let t = String(s);
  for (const rx of SOCIAL_RX) t = t.replace(rx, SOCIAL);
  for (const rx of EMAIL_RX) t = t.replace(rx, EMAIL);
  t = t
    .replace(IBAN_RX, ACCOUNT)
    .replace(ACCOUNT_RX, `$1${ACCOUNT}`)
    .replace(RC_RX, (m, y, mo, d, x) => (isBirthNumber(y + mo + d + x) ? '[rodné číslo skryto]' : m))
    .replace(DIC_RX, '$1[DIČ skryto]')
    .replace(DIC_PERSON_RX, (m, cc, digits) => (isBirthNumber(digits) ? `${cc}[DIČ skryto]` : m))
    .replace(ICO_RX, '$1[IČO skryto]');
  for (const [rx, to] of PHONE_RX) t = t.replace(rx, to);
  for (const [rx, to] of PHONE_BARE_RX) t = t.replace(rx, to);
  for (const rx of NAME_RX) t = t.replace(rx, replaceName);
  return t;
}

module.exports = { decodeEntities, htmlToText, fold, keyOf, parseCzk, parseCzDate, parsePsc, hash, truncate, scrubContacts, SCRUB_VERSION };
