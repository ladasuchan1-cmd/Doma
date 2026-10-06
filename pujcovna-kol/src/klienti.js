'use strict';
// Klienti platformy: weby půjčoven, které si hotel/penzion založí sám průvodcem /zalozeni/:token (od 7. 10. 2026).
// Bez HTTP – volá ho feature src/features/klienti.js, server.js (načtení při startu) a tools/pozvanka.js.
//
// Data:
//   $PK_DATA/platforma.db                 pozvánky (token jen jako SHA-256, e-mail šifrovaně, rozpracovaný koncept
//                                         průvodce šifrovaně) a evidence klientů; nemaže ji noční reset dema
//   $PK_DATA/klienti/<slug>/tenant.json   konfigurace webu klienta (stejný formát jako tenants/<slug>/tenant.json)
//   $PK_DATA/klienti/<slug>/logo.*        logo (PNG/JPEG/WebP z průvodce, nebo výchozí logo.svg s kolem)
//   $PK_DATA/tenants/<slug>.db            DB klienta (stejná jako u ostatních tenantů)
//   $PK_DATA/caddy-hosty.txt              hosty všech klientů (řádek = host); hostitelský cron (deploy/vedle-mapy.sh
//                                         caddy-sync) z nich skládá blok Caddy, takže nová subdoména dostane certifikát
//                                         bez ručního zásahu
//
// Stav klienta (tenant.stav): nahled = web běží, platby jsou simulované a stránky nesou pruh „náhledový provoz“;
// ostry = bez pruhu a bez simulace; pozastaven = web vrací 503. Mění se ve správě platformy.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { loadTenant, normalizeHost, seedSettings } = require('./tenants');
const { openTenantDb, nowIso, transaction } = require('./db');
const { hashPassword } = require('./crypto/passwords');
const { isTheme } = require('./themes');

const STAVY = Object.freeze(['nahled', 'ostry', 'pozastaven']);
const STAV_LABELS = Object.freeze({ nahled: 'Náhledový provoz', ostry: 'Ostrý provoz', pozastaven: 'Pozastaveno' });
const POZVANKA_DNI = 14;
const TOKEN_BYTES = 24;
const HOSTS_FILE = 'caddy-hosty.txt';

// Subdomény, které nesmí dostat klient (technické, rezervované, témata dema).
const RESERVED = new Set([
  'www', 'outdoor', 'sport', 'family', 'admin', 'api', 'app', 'mail', 'smtp', 'imap', 'pop', 'ftp', 'ns1', 'ns2', 'mx',
  'autoconfig', 'autodiscover', 'demo', 'test', 'dev', 'stage', 'staging', 'platforma', 'zalozeni', 'static', 'cdn',
  'status', 'blog', 'shop', 'eshop', 'help', 'podpora', 'pujcovna', 'rezervace', 'kola', 'mapa', 'nabidka', 'login',
]);

// Ilustrační fotky (CC BY, public/img/demo/kola, atribuce v ATTRIBUTION.md tamtéž) pro modely z config/kola-modely.json.
const FOTKY = Object.freeze({
  'haibike-alltrail-1.jpg': { author: 'Tony Hisgett', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Cube_Mountain_ebike_(50198895002).jpg' },
  'cube-touring-hybrid-1.jpg': { author: 'MIKI Yoshihito', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:Electric_assisted_bicycle_in_Japan_5358337867_4aa32aa34e_z.jpg' },
  'woom-4-1.jpg': { author: 'MIKI Yoshihito', license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0', sourceUrl: 'https://commons.wikimedia.org/wiki/File:CADILLAC_kids_bike._(14563341987).jpg' },
});

// Výchozí logo klienta bez vlastního loga: jednoduché kolo (vlastní kresba, barví se přes currentColor tématu).
const DEFAULT_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
<circle cx="20" cy="52" r="14"/><circle cx="60" cy="52" r="14"/><path d="M20 52 L32 28 L50 28 L60 52"/><path d="M32 28 L42 52 L50 28"/><path d="M28 22 H38"/><path d="M50 28 L46 18 H54"/>
</svg>
`;

// ---------------------------------------------------------------------------------------------------------
// Pomocníci

/** Text → slug: bez diakritiky, malá písmena, a–z/0–9 a pomlčky. */
function slugify(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

/** Platná subdoména klienta: 3–30 znaků, začíná písmenem, a–z/0–9/pomlčka (ne na konci ani dvě za sebou), není rezervovaná. */
function isValidSlug(slug) {
  const s = String(slug || '');
  return /^[a-z][a-z0-9-]{1,28}[a-z0-9]$/.test(s) && !s.includes('--') && !RESERVED.has(s);
}

const STOP_WORDS = new Set(['hotel', 'penzion', 'pension', 'apartmany', 'apartmany', 'chata', 'kemp', 'camp', 'resort', 'pujcovna', 'kol', 'sro', 's-r-o', 'a-s', 'spol']);

/**
 * Návrh subdomény: ze stávajícího webu klienta (utridubu.cz → utridubu, jak bylo dohodnuto), jinak z názvu bez slov
 * hotel/penzion… a bez pomlček („Hotel U Tří dubů“ → utridubu).
 */
function suggestSlug({ web, nazev } = {}) {
  if (web) {
    let host = String(web).trim().toLowerCase();
    try {
      host = new URL(/^[a-z]+:\/\//.test(host) ? host : `https://${host}`).hostname;
    } catch {
      host = '';
    }
    const labels = host.replace(/^www\./, '').split('.').filter(Boolean);
    if (labels.length >= 2) {
      const cand = slugify(labels[0]);
      if (isValidSlug(cand)) return cand;
    }
  }
  const words = slugify(nazev).split('-').filter((w) => w && !STOP_WORDS.has(w));
  const joined = words.join('');
  if (isValidSlug(joined)) return joined;
  const dashed = words.join('-').slice(0, 30).replace(/-+$/, '');
  return isValidSlug(dashed) ? dashed : '';
}

/** IČO: 8 číslic s kontrolní číslicí (mod 11). */
function isValidIco(ico) {
  const s = String(ico || '').replace(/\s+/g, '');
  if (!/^\d{8}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * (8 - i);
  return (11 - (sum % 11)) % 10 === Number(s[7]);
}

/** Souřadnice z textu „49.0035, 14.7708“, odkazu Mapy.cz (?x=lon&y=lat) nebo Google Map (@lat,lon). Vrací { lat, lon } | null. */
function parseLocation(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let lat;
  let lon;
  const mapy = /[?&]y=(-?\d+(?:\.\d+)?)/.exec(t) && /[?&]x=(-?\d+(?:\.\d+)?)/.exec(t);
  if (/mapy\.(cz|com)/i.test(t) && mapy) {
    lat = Number(/[?&]y=(-?\d+(?:\.\d+)?)/.exec(t)[1]);
    lon = Number(/[?&]x=(-?\d+(?:\.\d+)?)/.exec(t)[1]);
  } else {
    const g = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(t);
    const plain = /^(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)$/.exec(t.replace(/[NE°]/gi, '').trim());
    if (g) {
      lat = Number(g[1]);
      lon = Number(g[2]);
    } else if (plain) {
      lat = Number(plain[1].replace(',', '.'));
      lon = Number(plain[2].replace(',', '.'));
    }
  }
  // jen Česko a okolí (ochrana proti prohozeným souřadnicím)
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < 47 || lat > 52 || lon < 11 || lon > 20) return null;
  return { lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function writeFileAtomic(file, data, mode) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------
// Platformní DB (pozvánky, klienti)

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pozvanky (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  email_enc TEXT,
  nazev TEXT,
  poznamka TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  tenant_slug TEXT,
  draft_enc TEXT,
  draft_updated_at TEXT
);
CREATE TABLE IF NOT EXISTS klienti (
  slug TEXT PRIMARY KEY,
  nazev TEXT NOT NULL,
  host TEXT NOT NULL,
  stav TEXT NOT NULL,
  email_enc TEXT,
  pozvanka_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  akce TEXT NOT NULL,
  detail TEXT,
  ip_hash TEXT
);
`;

/** Otevře $PK_DATA/platforma.db (WAL) a založí tabulky. */
function openPlatformDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'platforma.db'));
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec(SCHEMA);
  return db;
}

function audit(pdb, akce, detail = {}, ipHash = null) {
  pdb.prepare('INSERT INTO audit(at, akce, detail, ip_hash) VALUES (?, ?, ?, ?)').run(nowIso(), akce, JSON.stringify(detail), ipHash);
}

/**
 * Nová pozvánka do průvodce. Token se vrací jen jednou (v DB je jen jeho SHA-256).
 * @returns {{ id: number, token: string, expiresAt: string }}
 */
function createInvite(pdb, { email, nazev = '', poznamka = '', dni = POZVANKA_DNI, fieldCrypto, now = Date.now() }) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + Math.max(1, Math.min(60, Number(dni) || POZVANKA_DNI)) * 86400000).toISOString();
  const r = pdb
    .prepare('INSERT INTO pozvanky(token_hash, email_enc, nazev, poznamka, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(hashToken(token), email ? fieldCrypto.enc(String(email).trim().toLowerCase()) : null, String(nazev || '').slice(0, 120), String(poznamka || '').slice(0, 500), createdAt, expiresAt);
  return { id: Number(r.lastInsertRowid), token, expiresAt };
}

/** Stav pozvánky: platna | vyprsela | pouzita | zrusena. */
function inviteStatus(row, now = Date.now()) {
  if (!row) return null;
  if (row.revoked_at) return 'zrusena';
  if (row.used_at) return 'pouzita';
  if (Date.parse(row.expires_at) <= now) return 'vyprsela';
  return 'platna';
}

/** Pozvánka podle tokenu z odkazu (nebo null). Token se porovnává přes otisk – v DB není. */
function findInvite(pdb, token) {
  if (!token || typeof token !== 'string' || token.length < 20 || token.length > 100 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return pdb.prepare('SELECT * FROM pozvanky WHERE token_hash = ?').get(hashToken(token)) || null;
}

function loadDraft(row, fieldCrypto) {
  if (!row || !row.draft_enc) return {};
  try {
    return JSON.parse(fieldCrypto.dec(row.draft_enc)) || {};
  } catch {
    return {};
  }
}

function saveDraft(pdb, id, draft, fieldCrypto) {
  pdb.prepare('UPDATE pozvanky SET draft_enc = ?, draft_updated_at = ? WHERE id = ?').run(fieldCrypto.enc(JSON.stringify(draft)), nowIso(), id);
}

function revokeInvite(pdb, id) {
  return pdb.prepare('UPDATE pozvanky SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL').run(nowIso(), Number(id)).changes > 0;
}

function decOrEmpty(fieldCrypto, v) {
  if (!v) return '';
  try {
    return fieldCrypto.dec(v);
  } catch {
    return '';
  }
}

/** Pozvánky pro správu platformy (nejnovější první, e-mail dešifrovaný). */
function listInvites(pdb, fieldCrypto, { limit = 100, now = Date.now() } = {}) {
  return pdb
    .prepare('SELECT * FROM pozvanky ORDER BY id DESC LIMIT ?')
    .all(limit)
    .map((r) => ({ id: r.id, email: decOrEmpty(fieldCrypto, r.email_enc), nazev: r.nazev, poznamka: r.poznamka, createdAt: r.created_at, expiresAt: r.expires_at, usedAt: r.used_at, tenantSlug: r.tenant_slug, rozpracovano: !!r.draft_enc && !r.used_at, stav: inviteStatus(r, now) }));
}

function listClients(pdb, fieldCrypto) {
  return pdb
    .prepare('SELECT * FROM klienti ORDER BY created_at DESC')
    .all()
    .map((r) => ({ slug: r.slug, nazev: r.nazev, host: r.host, stav: r.stav, email: decOrEmpty(fieldCrypto, r.email_enc), createdAt: r.created_at, updatedAt: r.updated_at }));
}

// ---------------------------------------------------------------------------------------------------------
// Weby klientů na disku

/** Je tenant klientský (založený průvodcem)? */
function isClientTenant(tenant) {
  return !!(tenant && tenant.klient);
}

/** Načte weby klientů z $PK_DATA/klienti. Poškozený klient server nezastaví – vrátí se v `errors`. */
function loadClientTenants(klientiDir) {
  const tenants = [];
  const errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(klientiDir, { withFileTypes: true });
  } catch {
    return { tenants, errors };
  }
  for (const ent of entries) {
    if (!ent.isDirectory() || !fs.existsSync(path.join(klientiDir, ent.name, 'tenant.json'))) continue;
    try {
      const t = loadTenant(path.join(klientiDir, ent.name));
      t.klient = true;
      t.stav = STAVY.includes(t.stav) ? t.stav : 'nahled';
      tenants.push(t);
    } catch (e) {
      errors.push({ slug: ent.name, error: e.message });
    }
  }
  return { tenants, errors };
}

/** Zapíše $PK_DATA/caddy-hosty.txt – hosty všech klientů (i pozastavených: certifikát zůstane, web vrací 503). */
function writeCaddyHosts(dataDir, tenants) {
  const hosts = [];
  for (const t of tenants) if (isClientTenant(t)) for (const h of t.hosts) if (/^[a-z0-9.-]+$/.test(h) && h.includes('.')) hosts.push(h);
  const text = `# Hosty webů klientů (generuje aplikace, čte deploy/vedle-mapy.sh caddy-sync). Neupravovat ručně.\n${[...new Set(hosts)].sort().join('\n')}\n`;
  fs.mkdirSync(dataDir, { recursive: true });
  writeFileAtomic(path.join(dataDir, HOSTS_FILE), text);
  return hosts;
}

/** Je subdoména volná (není klient, není host žádného tenanta, není rezervovaná)? */
function isSlugFree({ slug, tenants, pdb, domena }) {
  if (!isValidSlug(slug)) return false;
  const host = `${slug}.${domena}`;
  if (tenants.some((t) => t.slug === slug || t.hosts.includes(host))) return false;
  if (pdb.prepare('SELECT 1 FROM klienti WHERE slug = ?').get(slug)) return false;
  return true;
}

const LOGO_TYPES = Object.freeze({ png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' });

/** Typ obrázku podle prvních bajtů (PNG, JPEG, WebP) → přípona, nebo null. SVG ani nic jiného nepřijímáme. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** Den jako ["HH:MM","HH:MM"] nebo null (zavřeno). */
function hoursPair(od, d) {
  return /^\d{2}:\d{2}$/.test(od || '') && /^\d{2}:\d{2}$/.test(d || '') && od < d ? [od, d] : null;
}

/**
 * Sestaví tenant.json klienta z konceptu průvodce.
 * @param {{slug, draft, platformTenant, domena, logoFile: string|null, today: string}} p
 */
function buildTenantJson({ slug, draft, platformTenant, domena, logoFile, today }) {
  const p = draft.provozovna || {};
  const v = draft.vzhled || {};
  const prov = draft.provoz || {};
  const pl = (platformTenant && platformTenant.legal) || {};
  const host = `${slug}.${domena}`;
  const weekday = hoursPair(prov.vsedniOd, prov.vsedniDo);
  const weekend = hoursPair(prov.vikendOd, prov.vikendDo);
  const s = (platformTenant && platformTenant.settings) || {};
  return {
    slug,
    name: p.nazev,
    hosts: [host],
    stav: 'nahled',
    themeDefault: isTheme(v.design) ? v.design : 'outdoor',
    themeByHost: {},
    brand: { logo: logoFile ? `/tenant/${logoFile}` : '/tenant/logo.svg', claim: v.claim || '', primary: null },
    business: {
      legalName: p.firma || p.nazev,
      ico: p.ico,
      dic: p.platceDph ? p.dic : '',
      vatPayer: !!p.platceDph,
      address: p.sidlo,
      email: p.email,
      phone: p.telefon,
      premises: p.provozovna || p.sidlo,
      representative: p.zastupce || '',
      iban: p.iban || '',
      accountNumber: p.ucet || '',
      bankName: p.banka || '',
      web: p.web || '',
    },
    location: draft.adresa && draft.adresa.poloha ? { ...draft.adresa.poloha, radiusKm: 25 } : null,
    openingHours: { mon: weekday, tue: weekday, wed: weekday, thu: weekday, fri: weekday, sat: weekend, sun: weekend },
    settings: {
      feeMinor: { default: Math.round(Number(prov.poplatek || 300) * 100), ebike: Math.round(Number(prov.poplatekEkolo || 500) * 100) },
      cancellation: { freeHoursBefore: 48 },
      bufferMinutes: 60,
      transferExpiryHours: 48,
      preauthMaxDays: 7,
      idDocRetentionDays: s.idDocRetentionDays ?? 30,
      reservationRetentionDays: s.reservationRetentionDays ?? 90,
      contractRetentionYears: s.contractRetentionYears ?? 3,
      logRetentionDays: s.logRetentionDays ?? 365,
      gateway: 'mock',
      bankMatcher: 'fio-mock',
      docMode: 'A',
      acceptedIdDocs: 'občanský průkaz, cestovní pas nebo řidičský průkaz',
      lateReturnFlatMinor: 30000,
      cleaningFlatMinor: 30000,
    },
    legal: {
      version: '1.0',
      effectiveFrom: today,
      operatorName: pl.operatorName || '',
      operatorIco: pl.operatorIco || '',
      operatorAddress: pl.operatorAddress || '',
      operatorEmail: pl.operatorEmail || '',
      operatorIncidentContact: pl.operatorIncidentContact || '',
      operatorRepresentative: pl.operatorRepresentative || '',
      operatorRegister: pl.operatorRegister || '',
      operatorPrivacyContact: pl.operatorPrivacyContact || '',
      processors: Array.isArray(pl.processors) ? pl.processors : [],
      platformDomain: domena,
    },
    texts: {
      heroTitle: v.nadpis || `Půjčte si kolo – ${p.nazev}`,
      heroText: v.text || 'Elektrokola i dětská kola pro naše hosty. Rezervujte online, kolo vás bude čekat připravené.',
      about: v.about || '',
    },
    zalozeno: { at: new Date().toISOString(), pozvanka: draft.pozvankaId || null },
  };
}

/** Rozdělí počet kusů do velikostí (prostřední velikosti dřív: M, L, S, XL…). */
function distributeSizes(sizes, count) {
  const list = Array.isArray(sizes) && sizes.length ? sizes : ['M'];
  const mid = (list.length - 1) / 2;
  const order = list.map((s, i) => [s, Math.abs(i - mid) + i * 0.01]).sort((a, b) => a[1] - b[1]).map((x) => x[0]);
  const out = [];
  for (let i = 0; i < count; i++) out.push(order[i % order.length]);
  return out;
}

const round10 = (n) => Math.max(10, Math.round(n / 10) * 10);

/**
 * Typy kol, kusy, ceník a příslušenství klienta z vybraných modelů (config/kola-modely.json – jen veřejné údaje).
 * @param {object} db DB klienta
 * @param {{ modely: object[], volby: Array<{slug, pocet, cenaDen}>, fee: {default, ebike} (haléře), fieldCrypto }} p
 * @returns {{ typy: number, kusy: number }}
 */
function seedBikes(db, { modely, volby, fee }) {
  let typy = 0;
  let kusy = 0;
  const bySlug = new Map(modely.map((m) => [m.slug, m]));
  const insType = db.prepare(
    `INSERT INTO bike_types(slug, name, category, description, photos, sizes, specs, deposit_minor, fee_minor, value_minor, active, sort)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );
  const insRule = db.prepare('INSERT INTO price_rules(bike_type_id, season_id, unit, from_qty, price_minor) VALUES (?, NULL, ?, ?, ?)');
  const insBike = db.prepare("INSERT INTO bikes(bike_type_id, inventory_code, size, frame_no_enc, status, note) VALUES (?, ?, ?, NULL, 'available', NULL)");
  const usedCodes = new Set();
  volby.forEach((v, idx) => {
    const m = bySlug.get(v.slug);
    if (!m || !(v.pocet > 0)) return;
    const pk = m.pujcovna || {};
    const baseDay = Array.isArray(pk.den) && pk.den[0] ? pk.den[0] : v.cenaDen;
    const ratio = baseDay ? v.cenaDen / baseDay : 1;
    const day = (Array.isArray(pk.den) && pk.den.length === 4 ? pk.den : [baseDay, baseDay, baseDay, baseDay]).map((x) => round10(x * ratio));
    day[0] = v.cenaDen;
    const foto = m.foto && FOTKY[m.foto.soubor] ? [{ src: `/img/demo/kola/${m.foto.soubor}`, alt: m.foto.alt || m.nazev, ...FOTKY[m.foto.soubor] }] : [];
    const vyska = Object.entries(m.vyskaJezdce || {}).map(([k, val]) => `${k} ${val}`).join(' · ');
    const specs = { ...(m.specs || {}), ...(vyska ? { 'Doporučená výška jezdce': vyska } : {}) };
    const category = ['mtb', 'trek', 'ebike', 'kids', 'gravel', 'city'].includes(m.kategorie) ? m.kategorie : 'trek';
    const feeMinor = category === 'ebike' ? fee.ebike : fee.default;
    const r = insType.run(m.slug, m.nazev || `${m.znacka} ${m.model}`, category, m.popis || '', JSON.stringify(foto), JSON.stringify(m.velikosti || ['M']), JSON.stringify(specs), Math.round((pk.kauce || 5000) * 100), feeMinor, Math.round((m.cenaVerejna || 0) * 100), idx + 1);
    const typeId = Number(r.lastInsertRowid);
    typy++;
    [1, 2, 4, 7].forEach((q, i) => insRule.run(typeId, 'day', q, day[i] * 100));
    insRule.run(typeId, 'hour', 1, round10((pk.hodina || baseDay / 4) * ratio) * 100);
    insRule.run(typeId, 'halfday', 1, round10((pk.pulden || baseDay * 0.7) * ratio) * 100);
    let code = String(pk.kod || m.slug.replace(/[^a-z]/g, '').slice(0, 3) || 'KOL').toUpperCase().slice(0, 4);
    while (usedCodes.has(code)) code = `${code.slice(0, 3)}${usedCodes.size}`;
    usedCodes.add(code);
    distributeSizes(m.velikosti, Math.min(50, v.pocet)).forEach((size, i) => {
      insBike.run(typeId, `${code}-${String(i + 1).padStart(2, '0')}`, size);
      kusy++;
    });
  });
  const insAcc = db.prepare('INSERT INTO accessories(slug, name, price_minor, stock, active) VALUES (?, ?, ?, ?, 1) ON CONFLICT(slug) DO NOTHING');
  insAcc.run('prilba', 'Cyklistická přilba', 5000, Math.max(2, kusy));
  insAcc.run('zamek', 'Zámek', 0, Math.max(2, kusy));
  return { typy, kusy };
}

/**
 * Založí web klienta z hotového konceptu průvodce: soubory, DB (nastavení, správce, kola), registrace do běžící
 * aplikace (app.tenants / app.dbs), evidence v platformní DB, caddy-hosty.txt, použití pozvánky. Vrací tenanta.
 * Selže-li cokoli před registrací, složka a DB se uklidí.
 * @param {{ app: object, invite: object, draft: object, modely: object[], logo?: {buf: Buffer, ext: string}|null, ipHash?: string }} p
 */
function createClient({ app, invite, draft, modely, logo = null, ipHash = null }) {
  const { config, tenants, dbs, fieldCrypto } = app;
  const pdb = app.platformDb;
  const slug = draft.adresa && draft.adresa.slug;
  const domena = config.klientiDomena;
  if (!isSlugFree({ slug, tenants, pdb, domena })) throw new Error('Subdoména už není volná.');
  const platformTenant = tenants.find((t) => t.slug === 'demo') || tenants.find((t) => !isClientTenant(t)) || null;
  const dir = path.join(config.klientiDir, slug);
  if (fs.existsSync(dir)) throw new Error('Složka klienta už existuje.');
  const dbFile = path.join(config.dataDir, 'tenants', `${slug}.db`);
  if (fs.existsSync(dbFile)) throw new Error('Databáze klienta už existuje.');
  fs.mkdirSync(dir, { recursive: true, mode: 0o750 });
  let db = null;
  try {
    let logoFile = null;
    if (logo && logo.buf && LOGO_TYPES[logo.ext]) {
      logoFile = `logo.${logo.ext}`;
      fs.writeFileSync(path.join(dir, logoFile), logo.buf);
    }
    fs.writeFileSync(path.join(dir, 'logo.svg'), DEFAULT_LOGO_SVG);
    const json = buildTenantJson({ slug, draft: { ...draft, pozvankaId: invite.id }, platformTenant, domena, logoFile, today: nowIso().slice(0, 10) });
    writeFileAtomic(path.join(dir, 'tenant.json'), `${JSON.stringify(json, null, 2)}\n`);
    const tenant = loadTenant(dir);
    tenant.klient = true;
    tenant.stav = 'nahled';
    db = openTenantDb(slug, config.dataDir);
    const ucet = draft.ucet || {};
    let seeded;
    transaction(db, () => {
      seedSettings(db, tenant);
      db.prepare("INSERT INTO users(email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'owner', ?)").run(String(ucet.email).trim().toLowerCase(), ucet.jmeno || 'Správce', ucet.passwordHash, nowIso());
      seeded = seedBikes(db, { modely, volby: (draft.kola && draft.kola.volby) || [], fee: json.settings.feeMinor });
    });
    // registrace do běžící aplikace (od teď ji server obsluhuje) + evidence + hosty pro Caddy
    tenants.push(tenant);
    dbs.set(slug, db);
    const now = nowIso();
    pdb.prepare('INSERT INTO klienti(slug, nazev, host, stav, email_enc, pozvanka_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(slug, tenant.name, tenant.hosts[0], 'nahled', ucet.email ? fieldCrypto.enc(String(ucet.email).trim().toLowerCase()) : null, invite.id, now, now);
    pdb.prepare('UPDATE pozvanky SET used_at = ?, tenant_slug = ?, draft_enc = NULL WHERE id = ?').run(now, slug, invite.id);
    audit(pdb, 'klient.zalozen', { slug, pozvanka: invite.id, typy: seeded.typy, kusy: seeded.kusy }, ipHash);
    writeCaddyHosts(config.dataDir, tenants);
    return { tenant, seeded };
  } catch (e) {
    if (db) {
      try {
        db.close();
      } catch {
        /* nic */
      }
      for (const f of [dbFile, `${dbFile}-wal`, `${dbFile}-shm`]) fs.rmSync(f, { force: true });
    }
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

/** Změna stavu klienta (nahled / ostry / pozastaven): tenant.json, běžící tenant, evidence. */
function setClientState(app, slug, stav, ipHash = null) {
  if (!STAVY.includes(stav)) throw new Error('Neznámý stav.');
  const tenant = app.tenants.find((t) => t.slug === slug && isClientTenant(t));
  if (!tenant) return false;
  const file = path.join(tenant.dir, 'tenant.json');
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json.stav = stav;
  writeFileAtomic(file, `${JSON.stringify(json, null, 2)}\n`);
  tenant.stav = stav;
  app.platformDb.prepare('UPDATE klienti SET stav = ?, updated_at = ? WHERE slug = ?').run(stav, nowIso(), slug);
  audit(app.platformDb, 'klient.stav', { slug, stav }, ipHash);
  return true;
}

module.exports = {
  STAVY,
  STAV_LABELS,
  RESERVED,
  POZVANKA_DNI,
  LOGO_TYPES,
  HOSTS_FILE,
  slugify,
  isValidSlug,
  suggestSlug,
  isValidIco,
  parseLocation,
  hashToken,
  openPlatformDb,
  audit,
  createInvite,
  inviteStatus,
  findInvite,
  loadDraft,
  saveDraft,
  revokeInvite,
  listInvites,
  listClients,
  isClientTenant,
  loadClientTenants,
  writeCaddyHosts,
  isSlugFree,
  sniffImage,
  buildTenantJson,
  distributeSizes,
  seedBikes,
  createClient,
  setClientState,
  normalizeHost,
};
