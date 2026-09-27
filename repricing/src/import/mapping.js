'use strict';
// Mapování zdrojových sloupců na kanonická pole (SPEC §5 mapping.js) a převody hodnot:
// čísla („12 990 Kč“, „12.990,-“), kódy (EAN z Excelu 8.59E+12), sazba DPH („21 %“, „high“),
// dostupnost („skladem“, „do 3 dnů“, Heureka DELIVERY_DATE), data (ISO, „25. 9. 2026 14:30“, unix, Excel).
//
// Pojmy:
//  - „plochý záznam“ = objekt s tečkovými klíči z records.js (např. `offers.offer.@shop`, `PRICE_VAT`)
//  - „kanonický záznam“ = objekt s kanonickými poli (CANONICAL) připravený pro importProducts/importOffers
//  - mapování = {fields: {kanonické: zdrojový klíč}, defaults: {kanonické: konstanta}, csv: {decimal}, attrs, price_net}

const { fold, codeKey } = require('../util/keys');
const { parseNumber, round } = require('../util/num');

/** Chyba importu srozumitelná pro uživatele (API z ní udělá HTTP 400 – viz server/http.js toHttpError). */
class ImportError extends Error {
  /**
   * @param {string} message česká zpráva
   * @param {{status?: number, code?: string, details?: *}} [opts]
   */
  constructor(message, { status = 400, code = 'IMPORT_INVALID', details } = {}) {
    super(message);
    this.name = 'ImportError';
    this.status = status;
    this.expose = status < 500;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Kanonická pole

/**
 * Kanonická pole podle druhu importu (popisky česky – používá je UI).
 * type: code | string | text | number | vat | boolean | date | availability | in_stock | delivery_days | stock_qty
 * manual: true = pole spravované v aplikaci (zámek, limity, poznámka) – nikdy se nenavrhuje automaticky,
 * z importu se zapíše jen při výslovném namapování (mapping.fields / mapping.defaults).
 */
const CANONICAL = {
  products: [
    { key: 'code', label: 'Kód (SKU / POHODA)', type: 'code', required: true, help: 'Náš jedinečný kód – podle něj se páruje a exportuje.' },
    { key: 'name', label: 'Název', type: 'string' },
    { key: 'ean', label: 'EAN / GTIN', type: 'code' },
    { key: 'mpn', label: 'Kód výrobce (MPN)', type: 'code' },
    { key: 'manufacturer', label: 'Výrobce / značka', type: 'string' },
    { key: 'category', label: 'Kategorie', type: 'string' },
    { key: 'supplier', label: 'Dodavatel', type: 'string' },
    { key: 'owner', label: 'Zodpovědná osoba', type: 'string' },
    {
      key: 'group_code',
      label: 'Skupina / model',
      type: 'code',
      help: 'Společný kód velikostí / barev jednoho modelu (nadřazený kód). Strategie s volbou „sjednotit ve skupině“ jim dá stejnou cenu.',
    },
    { key: 'purchase_price', label: 'Nákupní cena (bez DPH)', type: 'number' },
    { key: 'price', label: 'Prodejní cena (s DPH)', type: 'number' },
    { key: 'vat_rate', label: 'Sazba DPH %', type: 'vat' },
    { key: 'msrp', label: 'Doporučená cena (MOC)', type: 'number' },
    { key: 'stock', label: 'Sklad (ks)', type: 'number' },
    { key: 'sales_30', label: 'Prodeje 30 dní', type: 'number' },
    { key: 'sales_90', label: 'Prodeje 90 dní', type: 'number' },
    { key: 'active', label: 'Aktivní (1/0)', type: 'boolean' },
    { key: 'locked', label: 'Zamčeno (spravuje aplikace)', type: 'boolean', manual: true, help: 'Spravuje se v aplikaci – z importu se přepíše jen při výslovném namapování.' },
    { key: 'locked_until', label: 'Zamčeno do (spravuje aplikace)', type: 'date', manual: true, help: 'Spravuje se v aplikaci – z importu se přepíše jen při výslovném namapování.' },
    { key: 'min_price', label: 'Minimální cena (spravuje aplikace)', type: 'number', manual: true, help: 'Spravuje se v aplikaci – z importu se přepíše jen při výslovném namapování.' },
    { key: 'max_price', label: 'Maximální cena (spravuje aplikace)', type: 'number', manual: true, help: 'Spravuje se v aplikaci – z importu se přepíše jen při výslovném namapování.' },
    { key: 'note', label: 'Poznámka (spravuje aplikace)', type: 'text', manual: true, help: 'Spravuje se v aplikaci – z importu se přepíše jen při výslovném namapování.' },
  ],
  offers: [
    { key: 'competitor', label: 'Konkurent', type: 'string', required: true, help: 'Název obchodu. Když soubor obsahuje ceny jednoho obchodu, zadejte ho jako výchozí hodnotu.' },
    { key: 'price', label: 'Cena konkurenta (s DPH)', type: 'number', required: true },
    { key: 'code', label: 'Náš kód (již spárováno)', type: 'code' },
    { key: 'ean', label: 'EAN / GTIN', type: 'code' },
    { key: 'mpn', label: 'Kód výrobce (MPN)', type: 'code' },
    { key: 'ext_id', label: 'ID položky u poskytovatele', type: 'code' },
    { key: 'name', label: 'Název u konkurenta', type: 'string' },
    { key: 'shipping', label: 'Doprava (Kč)', type: 'number' },
    { key: 'availability', label: 'Dostupnost (text)', type: 'availability' },
    { key: 'in_stock', label: 'Skladem (ano/ne)', type: 'in_stock' },
    { key: 'delivery_days', label: 'Dodání (dny)', type: 'delivery_days' },
    { key: 'stock_qty', label: 'Počet kusů u konkurenta', type: 'stock_qty' },
    { key: 'url', label: 'URL nabídky', type: 'string' },
    { key: 'observed_at', label: 'Datum zjištění ceny', type: 'date' },
  ],
};

const FIELD_INDEX = {
  products: new Map(CANONICAL.products.map((f) => [f.key, f])),
  offers: new Map(CANONICAL.offers.map((f) => [f.key, f])),
};

const AVAIL_FIELDS = new Set(['availability', 'in_stock', 'delivery_days', 'stock_qty']);
const SINGLE_LINE = new Set(['name', 'manufacturer', 'category', 'supplier', 'owner', 'competitor']);

// ---------------------------------------------------------------------------------------------------------
// Aliasy pro návrh mapování. Porovnává se na fold() + bez nealfanumerických znaků („Prodejní cena s DPH“ →
// „prodejnicenasdph“). Pořadí = priorita (dřívější alias vyhrává). Položky s prefixem „~“ jsou slabé aliasy –
// použijí se jen tehdy, když pro pole nic lepšího není (např. g:id → id jako náš kód).

// Obecné identifikátory položky („ITEM_ID“, „SKU“…). V našem katalogu je to náš kód; v cenách konkurence je to
// obvykle ID položky U KONKURENTA (jeho vlastní Heureka/Zboží feed) – jako „náš kód“ by párovalo na cizí produkty
// (data-3). U nabídek proto patří k ext_id; za náš kód se berou jen ve feedu s vnořenými nabídkami (položky
// NAŠEHO katalogu s cenami více obchodů – typický výstup služby pro monitoring cen).
const GENERIC_ID_ALIASES = ['sku', 'productcode', 'itemcode', 'itemid', 'idproduktu', 'idpolozky', 'katalog', 'katalogovecislo', 'katcislo', 'catalognumber', 'articlenumber'];

const COMMON_ALIASES = {
  code: ['code', 'kod', 'kodproduktu', 'kodzbozi', 'kodpolozky', ...GENERIC_ID_ALIASES],
  ean: ['ean', 'gtin', 'gtin13', 'ean13', 'gtin14', 'gtin12', 'upc', 'gtin8', 'ean8', 'barcode', 'carovykod', 'eankod', 'eancode', 'productean'],
  mpn: ['mpn', 'productno', 'partnumber', 'partno', 'kodvyrobce', 'manufacturercode', 'manufacturerpartnumber', 'mfrpartnumber', 'vendorcode', 'cislovyrobce', 'objednacicislo'],
  name: ['name', 'nazev', 'productname', 'nazevproduktu', 'nazevzbozi', 'nazevpolozky', 'itemname', 'product', 'title', '~text'],
  // POHODA listStock: stockHeader.sellingPrice má přednost před cenami cenových hladin (stockPriceItem.stockPrice.price)
  // – proto „stockheadersellingprice“ (shoda posledních dvou segmentů) a „sellingprice“ před obecným „price“ (data-1)
  price: [
    'stockheadersellingprice', 'pricevat', 'pricewithvat', 'priceinclvat', 'priceincvat', 'pricegross', 'cenasdph', 'cenavcdph', 'cenavcetnedph', 'prodejnicenasdph',
    'prodejnicenavcdph', 'sellingprice', 'price', 'cena', 'prodejnicena', 'currentprice', 'aktualnicena', 'offerprice', 'competitorprice', 'cenakonkurence', 'cenakonkurenta',
    'cenazbozi',
  ],
  url: ['url', 'link', 'odkaz', 'producturl', 'offerurl', 'itemurl', 'weburl', 'detailurl', 'urladresa'],
};

/** Akční / zlevněná cena (Google Merchant g:sale_price, „akční cena“) – má přednost před běžnou cenou (data-7). */
const SALE_PRICE_ALIASES = new Set(['saleprice', 'akcnicena', 'cenaposleve', 'specialprice', 'discountedprice', 'akcnicenasdph', 'cenavakci']);

const ALIASES = {
  products: {
    code: [...COMMON_ALIASES.code, '~id'],
    ean: COMMON_ALIASES.ean,
    mpn: COMMON_ALIASES.mpn,
    name: COMMON_ALIASES.name,
    manufacturer: ['manufacturer', 'brand', 'vyrobce', 'znacka', 'producer', 'make', 'vendor', 'manufacturername', 'brandname', 'nazevvyrobce'],
    category: ['category', 'kategorie', 'categorytext', 'categoryname', 'categorypath', 'nazevkategorie', 'producttype', 'group', 'skupina', 'skupinazbozi', 'sekce', '~googleproductcategory'],
    supplier: ['supplier', 'dodavatel', 'suppliername', 'nazevdodavatele', 'distributor'],
    owner: ['owner', 'zodpovednaosoba', 'zodpovedny', 'odpovednaosoba', 'responsible', 'responsibleperson', 'categorymanager', 'productmanager', 'produktovymanazer', 'manager', 'spravce', 'nakupci', 'buyer'],
    purchase_price: ['purchaseprice', 'nakupnicena', 'nakupnicenabezdph', 'nakupbezdph', 'cenanakupni', 'nakup', 'cost', 'costprice', 'unitcost', 'purchasingprice', 'buyprice', 'wholesaleprice', 'nakupka'],
    price: COMMON_ALIASES.price,
    vat_rate: ['vatrate', 'vat', 'dph', 'sazbadph', 'dphsazba', 'sazbadphprodej', 'sellingratevat', 'ratevat', 'vatpercent', 'dphprocent', 'taxrate', 'tax'],
    msrp: ['msrp', 'rrp', 'moc', 'mocsdph', 'mocvcdph', 'doporucenacena', 'doporucenaprodejnicena', 'doporucenamaloobchodnicena', 'recommendedprice', 'recommendedretailprice', 'standardprice', 'listprice', 'cenikovacena'],
    stock: ['stock', 'qty', 'quantity', 'count', 'mnozstvi', 'stav', 'stavskladu', 'sklademks', 'stavzasoby', 'zasoba', 'sklad', 'pocetks', 'pocetkusu', 'stockqty', 'stockquantity', 'inventory', 'volnemnozstvi', 'skladem', '~ks'],
    sales_30: ['sales30', 'sales30d', 'sales30days', 'prodej30', 'prodej30d', 'prodej30dni', 'prodeje30', 'prodeje30d', 'prodeje30dni', 'prodano30', 'prodano30dni', 'sold30', 'sold30d', 'units30', 'prodejzamesic', 'monthlysales'],
    sales_90: ['sales90', 'sales90d', 'sales90days', 'prodej90', 'prodej90d', 'prodej90dni', 'prodeje90', 'prodeje90d', 'prodeje90dni', 'prodano90', 'prodano90dni', 'sold90', 'sold90d', 'units90', 'quarterlysales'],
    active: ['active', 'aktivni', 'isactive', 'enabled', 'zobrazovat', 'visible', 'publikovano', 'published'],
    // kód modelu / nadřazené karty (velikosti a barvy jednoho kola); `parent.code` = kód rodiče u rozložených variant
    group_code: ['groupcode', 'model', 'modelcode', 'nadrazenykod', 'parentcode', 'groupid', 'itemgroupid'],
  },
  offers: {
    competitor: [
      'competitor', 'konkurent', 'konkurence', 'competitorname', 'shop', 'shopname', 'eshop', 'eshopname', 'seller', 'sellername', 'obchod', 'nazevobchodu', 'retailer',
      'retailername', 'merchant', 'merchantname', 'store', 'storename', 'prodejce', 'domain', 'domena', 'vendorname', 'konkurentname', 'obchodname',
    ],
    price: COMMON_ALIASES.price,
    code: ['code', 'kod', 'naskod', 'ourcode', 'naskodproduktu', 'kodproduktu', 'kodzbozi', 'kodpolozky'],
    ean: COMMON_ALIASES.ean,
    mpn: COMMON_ALIASES.mpn,
    ext_id: ['extid', 'externalid', 'offerid', 'providerid', 'providerproductid', 'productid', 'idnabidky', '~id', ...GENERIC_ID_ALIASES.map((a) => '~' + a)],
    name: COMMON_ALIASES.name,
    shipping: ['shipping', 'shippingprice', 'shippingcost', 'deliveryprice', 'deliverycost', 'doprava', 'cenadopravy', 'postovne', 'postage', 'dopravacena', 'cenadoruceni'],
    availability: ['availability', 'dostupnost', 'stockstatus', 'availabilitystatus', 'stavdostupnosti', 'dostupnosttext', 'availabilitytext', 'deliverydate', 'skladem', 'instock', 'deliverydays', 'stock', 'sklad', 'stav'],
    in_stock: ['instock', 'isinstock', 'jeskladem', 'nasklade', 'available', 'isavailable'],
    delivery_days: ['deliverydays', 'dodacidoba', 'dodacidobadny', 'dnydodani', 'dobadodani', 'leadtime', 'leadtimedays', 'deliverytime'],
    stock_qty: ['stockqty', 'stockquantity', 'qty', 'quantity', 'pocetks', 'pocetkusu', 'mnozstvi', 'sklademks', 'stockcount', 'inventory'],
    url: COMMON_ALIASES.url,
    observed_at: [
      'observedat', 'scrapedat', 'crawledat', 'checkedat', 'lastchecked', 'lastseen', 'lastupdate', 'lastupdated', 'updatedat', 'updated', 'datumzjisteni', 'zjisteno',
      'datumaktualizace', 'aktualizovano', 'timestamp', 'datetime', 'datumacas', 'date', 'datum', 'cas', 'time',
    ],
  },
};

// nabídky ve feedu s vnořenými nabídkami: obecná ID položky = náš kód (viz GENERIC_ID_ALIASES)
ALIASES.offers_nested = {
  ...ALIASES.offers,
  code: [...ALIASES.offers.code, ...GENERIC_ID_ALIASES],
  ext_id: ALIASES.offers.ext_id.filter((a) => !GENERIC_ID_ALIASES.includes(a.replace(/^~/, ''))),
};

// alias → [{field, rank, weak}] pro rychlé vyhledávání
const ALIAS_INDEX = {};
for (const kind of Object.keys(ALIASES)) {
  const idx = new Map();
  for (const [field, list] of Object.entries(ALIASES[kind])) {
    list.forEach((a, rank) => {
      const weak = a.startsWith('~');
      const alias = weak ? a.slice(1) : a;
      if (!idx.has(alias)) idx.set(alias, []);
      idx.get(alias).push({ field, rank, weak });
    });
  }
  ALIAS_INDEX[kind] = idx;
}

/** Normalizace jednoho segmentu klíče: bez jmenného prefixu (g:), bez @, bez závorek („Cena (Kč)“), fold, jen [a-z0-9]. */
function normSegment(s) {
  let t = String(s);
  const colon = t.lastIndexOf(':');
  if (colon >= 0 && colon < t.length - 1) t = t.slice(colon + 1);
  const noBrackets = t.replace(/\([^)]*\)|\[[^\]]*\]/g, '');
  if (/[\p{L}\p{N}]/u.test(noBrackets)) t = noBrackets;
  return fold(t).replace(/[^a-z0-9]/g, '');
}

/** Tvary klíče pro porovnání s aliasy: celý klíč, poslední dva segmenty, poslední segment. */
function keyForms(key) {
  const segs = [];
  for (const raw of String(key).split('.')) {
    if (raw === '#text') continue;
    const n = normSegment(raw);
    if (n) segs.push(n);
  }
  if (!segs.length) return null;
  const last = segs[segs.length - 1];
  return {
    full: segs.join(''),
    last2: segs.length >= 2 ? segs[segs.length - 2] + last : null,
    last,
    depth: segs.length,
  };
}

function kindOf(kind) {
  if (kind !== 'products' && kind !== 'offers') throw new ImportError(`Neznámý druh importu „${kind}“ (očekáváno products nebo offers).`);
  return kind;
}

/**
 * Navrhne mapování podle názvů sloupců / klíčů.
 * Každý kanonický sloupec dostane nejvýše jeden zdrojový klíč a každý zdrojový klíč nejvýše jedno pole.
 * Pořadí: přesný kanonický název > shoda celého klíče > posledních dvou segmentů (`SHOP.@name` → shopname)
 * > posledního segmentu (`offers.offer.price` → price); při shodě rozhoduje priorita aliasu a mělčí klíč.
 * Pole spravovaná aplikací (locked, min_price, …) se nenavrhují nikdy.
 * @param {string[]} headers
 * @param {'products'|'offers'} kind
 * @param {{exclude?: Iterable<string>, excludeHeaders?: Iterable<string>, nested?: boolean}} [opts] pole / klíče, které už
 *   jsou obsazené; nested = nabídky jsou vnořené v položkách (obecné ID položky pak = náš kód, jinak ID u poskytovatele)
 * @returns {{fields: Object<string, string>}}
 */
function suggestMapping(headers, kind, opts = {}) {
  kindOf(kind);
  const index = ALIAS_INDEX[kind === 'offers' && opts.nested ? 'offers_nested' : kind];
  const fieldIndex = FIELD_INDEX[kind];
  const excluded = new Set(opts.exclude || []);
  const excludedHeaders = new Set(opts.excludeHeaders || []);
  const cands = [];
  const list = Array.isArray(headers) ? headers : [];
  for (let hi = 0; hi < list.length; hi++) {
    const h = list[hi];
    if (h == null || excludedHeaders.has(h)) continue;
    const forms = keyForms(h);
    if (!forms) continue;
    const best = new Map(); // field → [tier, rank]
    const consider = (field, tier, rank) => {
      const f = fieldIndex.get(field);
      if (!f || f.manual || excluded.has(field)) return;
      const cur = best.get(field);
      if (!cur || tier < cur[0] || (tier === cur[0] && rank < cur[1])) best.set(field, [tier, rank]);
    };
    // přesný kanonický název (např. JSON s kanonickými klíči) má vždy přednost
    if (fieldIndex.has(h)) consider(h, 0, 0);
    const tiers = [
      [forms.full, 1],
      [forms.last2, 2],
      [forms.last, 3],
    ];
    for (const [form, tier] of tiers) {
      if (!form) continue;
      const hits = index.get(form);
      if (!hits) continue;
      for (const hit of hits) consider(hit.field, hit.weak ? tier + 10 : tier, hit.rank);
    }
    for (const [field, [tier, rank]] of best) cands.push({ field, header: h, tier, rank, depth: forms.depth, hi });
  }
  cands.sort((a, b) => a.tier - b.tier || a.rank - b.rank || a.depth - b.depth || a.hi - b.hi);
  const fields = {};
  const usedHeaders = new Set();
  for (const c of cands) {
    if (fields[c.field] !== undefined || usedHeaders.has(c.header)) continue;
    fields[c.field] = c.header;
    usedHeaders.add(c.header);
  }
  // stabilní pořadí podle CANONICAL
  const ordered = {};
  for (const f of CANONICAL[kind]) if (fields[f.key] !== undefined) ordered[f.key] = fields[f.key];
  return { fields: ordered };
}

// ---------------------------------------------------------------------------------------------------------
// Převody hodnot

function isEmpty(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

const ZERO_WIDTH = /[​-‍⁠﻿]/g;
const SCI_RE = /^[+-]?\d+(?:[.,]\d+)?e\+?\d+$/i;

/**
 * Identifikátor (kód, EAN, MPN, ID) jako text: čísla z Excelu bez exponentu a bez „.0“, ořezané mezery.
 * @returns {string|null}
 */
function normalizeCode(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return Math.abs(v) >= 1e21 ? BigInt(v).toString() : String(v);
    return String(v);
  }
  if (typeof v === 'boolean') return null;
  let s = String(v).replace(ZERO_WIDTH, '').trim();
  if (!s) return null;
  if (SCI_RE.test(s)) {
    const n = Number(s.replace(',', '.'));
    if (Number.isFinite(n) && Math.abs(n) < 1e21) s = BigInt(Math.round(n)).toString();
  } else if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, '');
  return s;
}

/** Text: ořezaný, prázdný → null; single = sjednotit vnitřní bílé znaky do jedné mezery. */
function normalizeText(v, single = true) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') return null;
  let s = String(v).replace(ZERO_WIDTH, '');
  s = single ? s.replace(/\s+/g, ' ').trim() : s.trim();
  return s || null;
}

const TRUE_WORDS = new Set(['1', 'true', 't', 'yes', 'y', 'ano', 'a', 'x', 'aktivni', 'active', 'on', 'ok', 'zapnuto', 'enabled', 'pravda']);
const FALSE_WORDS = new Set(['0', 'false', 'f', 'no', 'n', 'ne', 'neaktivni', 'inactive', 'off', 'vypnuto', 'disabled', 'nepravda']);

/** 1 / 0 / null z „ano“, „ne“, true, 1, „aktivní“ … */
function parseBool(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? (v !== 0 ? 1 : 0) : null;
  const s = fold(v);
  if (!s) return null;
  if (TRUE_WORDS.has(s)) return 1;
  if (FALSE_WORDS.has(s)) return 0;
  return null;
}

// Sazby DPH v ČR od 1. 1. 2024: základní 21 %, snížená 12 % (dřívější „třetí“ sazba 10 % byla sloučena do 12 %).
// POHODA v XML používá slova high / low / third / none.
const VAT_WORDS = new Map([
  ['high', 21], ['zakladni', 21], ['standard', 21], ['basic', 21],
  ['low', 12], ['snizena', 12], ['prvnisnizena', 12], ['reduced', 12], ['third', 12], ['druhasnizena', 12],
  ['none', 0], ['nulova', 0], ['zero', 0], ['osvobozeno', 0], ['bezdph', 0],
]);

/** Sazba DPH v %: „21 %“ → 21, 0.21 → 21, „high“ → 21, „low“ → 12, „none“ → 0. */
function parseVat(v) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') {
    const w = fold(v).replace(/[^a-z]/g, '');
    if (w && VAT_WORDS.has(w)) return VAT_WORDS.get(w);
  }
  let n = parseNumber(v);
  if (n == null) return null;
  if (n > 0 && n < 1) n = n * 100; // procentní buňka z Excelu (0,21)
  n = round(n, 2);
  if (n < 0 || n > 100) return null;
  return n;
}

// --- datum a čas (místní čas bez zóny = Europe/Prague) --------------------------------------------------

const TZ = 'Europe/Prague';
let dtf = null;
const offsetCache = new Map();

function tzOffsetMs(utcMs) {
  const hourKey = Math.floor(utcMs / 3600000);
  const cached = offsetCache.get(hourKey);
  if (cached !== undefined) return cached;
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  }
  const p = {};
  for (const part of dtf.formatToParts(new Date(hourKey * 3600000))) p[part.type] = part.value;
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  const off = asUtc - hourKey * 3600000;
  if (offsetCache.size > 5000) offsetCache.clear();
  offsetCache.set(hourKey, off);
  return off;
}

/** Místní čas v Praze → ms UTC (správně přes letní/zimní čas). */
function pragueToUtc(y, mo, d, h = 0, mi = 0, s = 0, ms = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  const off = tzOffsetMs(guess);
  let t = guess - off;
  const off2 = tzOffsetMs(t);
  if (off2 !== off) t = guess - off2;
  return t;
}

function validYmd(y, mo, d, h = 0, mi = 0, s = 0) {
  if (y < 1970 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function msToIso(ms) {
  if (!Number.isFinite(ms)) return null;
  const y = new Date(ms).getUTCFullYear();
  if (y < 1970 || y > 2100) return null;
  return new Date(ms).toISOString();
}

function excelSerialToIso(serial) {
  const days = Math.floor(serial);
  const frac = serial - days;
  const base = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(base);
  const secs = Math.round(frac * 86400);
  return msToIso(pragueToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(secs / 3600), Math.floor((secs % 3600) / 60), secs % 60));
}

function numberToIso(n) {
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e11 && n < 1e14) return msToIso(Math.round(n)); // unix ms
  if (n >= 1e8 && n < 1e11) return msToIso(Math.round(n * 1000)); // unix s
  if (n >= 20000 && n < 80000) return excelSerialToIso(n); // Excel sériové číslo (1954–2119)
  return null;
}

const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const CZ_RE = /^(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;
const SLASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/;

/**
 * Datum/čas → ISO UTC. Přijímá ISO (bez zóny = čas v Praze), „25.9.2026“, „25. 9. 2026 14:30[:15]“, „25/09/2026“ (d/m/r),
 * unix sekundy/ms (číslo i text), Excel sériové číslo, Date, RFC 2822 („Thu, 25 Sep 2026 10:00:00 GMT“).
 * @returns {string|null}
 */
function parseDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (v instanceof Date) return msToIso(v.getTime());
  if (typeof v === 'number') return numberToIso(v);
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return numberToIso(Number(s));
  let m = ISO_RE.exec(s);
  if (m) {
    const [y, mo, d, h = 0, mi = 0, sec = 0] = [m[1], m[2], m[3], m[4], m[5], m[6]].map((x) => (x == null ? undefined : Number(x)));
    if (!validYmd(y, mo, d, h, mi, sec)) return null;
    const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
    if (m[8]) {
      const zone = m[8].toUpperCase();
      let offMin = 0;
      if (zone !== 'Z') {
        const sign = zone[0] === '-' ? -1 : 1;
        const digits = zone.slice(1).replace(':', '');
        offMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || 0));
      }
      return msToIso(Date.UTC(y, mo - 1, d, h, mi, sec, ms) - offMin * 60000);
    }
    return msToIso(pragueToUtc(y, mo, d, h, mi, sec, ms));
  }
  m = CZ_RE.exec(s) || SLASH_RE.exec(s);
  if (m) {
    const d = Number(m[1]);
    const mo = Number(m[2]);
    const y = Number(m[3]);
    const h = m[4] ? Number(m[4]) : 0;
    const mi = m[5] ? Number(m[5]) : 0;
    const sec = m[6] ? Number(m[6]) : 0;
    if (!validYmd(y, mo, d, h, mi, sec)) return null;
    return msToIso(pragueToUtc(y, mo, d, h, mi, sec));
  }
  if (/[a-z]{3}/i.test(s)) {
    const t = Date.parse(s);
    if (Number.isFinite(t)) return msToIso(t);
  }
  return null;
}

// --- dostupnost -------------------------------------------------------------------------------------------

const IN_STOCK_WORDS = new Set([
  'ano', 'a', 'yes', 'y', 'true', 't', 'skladem', 'in stock', 'instock', 'in_stock', 'available', 'na sklade', 'je skladem', 'ihned', 'ihned k odeslani',
  'k odeslani ihned', 'expedujeme ihned', 'dostupne', 'dostupny', 'dostupne ihned', 'k dispozici', 'na prodejne', 'in store', 'instore', 'limited availability',
  'limitedavailability', 'onlineonly', 'online only', 'instoreonly',
]);
const OUT_OF_STOCK_WORDS = new Set([
  'ne', 'n', 'no', 'false', 'f', 'neni skladem', 'neni na sklade', 'vyprodano', 'vyprodane', 'vyprodany', 'out of stock', 'outofstock', 'out_of_stock', 'na dotaz',
  'nedostupne', 'nedostupny', 'preorder', 'pre-order', 'pre order', 'predobjednavka', 'na objednavku', 'ukonceno', 'ukoncena vyroba', 'doprodano', 'sold out',
  'soldout', 'unavailable', 'not available', 'discontinued', 'backorder', 'back order', 'na ceste', 'docasne vyprodano', 'momentalne nedostupne', 'nelze objednat',
  'neni k dispozici', 'neni dostupne', 'nedodavame',
]);

/** Druh zdrojového sloupce dostupnosti podle názvu: bool (skladem ano/ne), qty (počet kusů), days (dny dodání). */
function availabilityHint(sourceKey) {
  if (sourceKey == null) return null;
  const forms = keyForms(sourceKey);
  if (!forms) return null;
  const k = forms.last;
  if (/^(instock|isinstock|skladem|jeskladem|nasklade|available|isavailable|dostupne|dostupny|dostupnost01)$/.test(k)) return 'bool';
  if (/^(stock|stockqty|stockquantity|qty|quantity|pocet|pocetks|pocetkusu|mnozstvi|sklad|sklademks|stavskladu|stockcount|inventory|ks|count|kusu)$/.test(k)) return 'qty';
  if (/^(deliverydate|deliverydays|dodacidoba\w*|dnydodani|dobadodani|leadtime\w*|deliverytime|delivery)$/.test(k)) return 'days';
  return null;
}

const DAY_MS = 86400000;
const UNKNOWN = Object.freeze({ in_stock: null, delivery_days: null });
const MAX_AVAIL_TEXT = 200;

function fromDays(d) {
  if (!Number.isFinite(d)) return { in_stock: null, delivery_days: null };
  const days = Math.max(0, d);
  return { in_stock: days <= 0 ? 1 : 0, delivery_days: days };
}

function fromNumber(n, hint) {
  if (!Number.isFinite(n)) return { in_stock: null, delivery_days: null };
  if (hint === 'bool' || hint === 'qty') return n > 0 ? { in_stock: 1, delivery_days: 0 } : { in_stock: 0, delivery_days: null };
  return fromDays(n);
}

/**
 * Dostupnost → {in_stock: 1|0|null, delivery_days: number|null}.
 * - true / „ano“ / „skladem“ / „in stock“ / „available“ / „na skladě“ → 1 (0 dní)
 * - false / „ne“ / „není skladem“ / „vyprodáno“ / „out of stock“ / „na dotaz“ / „preorder“ / „předobjednávka“ → 0
 * - číslo nebo „do 3 dnů“, „3 dny“, „2–5 dní“ (bere se horní mez), „1 týden“, „48 hodin“, datum dodání = dny dodání;
 *   0 dní (Heureka DELIVERY_DATE 0) = skladem
 * - „1“/„0“ jako ano/ne jen u sloupce typu ano/ne (hint 'bool', např. `in_stock`, `skladem`); jinak je číslo počet dní
 *   (výjimka podle SPEC: samotné „1“ bez nápovědy = skladem)
 * - hint 'qty' (počet kusů, např. `stock_qty`): > 0 → skladem, 0 → není skladem
 * @param {*} v
 * @param {{hint?: 'bool'|'qty'|'days'|null, field?: string, now?: Date|string}} [opts] field = název zdrojového sloupce (odvodí hint)
 */
function normalizeAvailability(v, opts = {}) {
  const hint = opts.hint !== undefined ? opts.hint : availabilityHint(opts.field);
  if (v === undefined || v === null) return { ...UNKNOWN };
  if (typeof v === 'boolean') return v ? { in_stock: 1, delivery_days: 0 } : { in_stock: 0, delivery_days: null };
  if (typeof v === 'number') return fromNumber(v, hint);
  if (typeof v !== 'string') return { ...UNKNOWN };
  let raw = v.trim();
  if (!raw) return { ...UNKNOWN };
  // Text dostupnosti je krátký; dlouhé hodnoty z cizích feedů ořízneme dřív, než se na ně pustí regulární výrazy
  // (dlouhá řada číslic by jinak blokovala server na desítky sekund – security-3).
  if (raw.length > MAX_AVAIL_TEXT) raw = raw.slice(0, MAX_AVAIL_TEXT);
  let s = fold(raw)
    .replace(/^https?:\/\/(www\.)?schema\.org\//, '')
    .replace(/[_]+/g, ' ')
    .replace(/[!.]+$/, '')
    .trim();
  if (/^[+-]?\d+(?:[.,]\d+)?$/.test(s)) {
    const n = Number(s.replace(',', '.'));
    if (!hint && n === 1) return { in_stock: 1, delivery_days: 0 };
    return fromNumber(n, hint);
  }
  if (IN_STOCK_WORDS.has(s) || IN_STOCK_WORDS.has(s.replace(/\s+/g, ''))) return { in_stock: 1, delivery_days: 0 };
  if (OUT_OF_STOCK_WORDS.has(s) || OUT_OF_STOCK_WORDS.has(s.replace(/\s+/g, ''))) return { in_stock: 0, delivery_days: null };
  const compact = s.replace(/\s+/g, '');
  // zápory dřív než „skladem…“ („není skladem“, „nemáme skladem“)
  if (
    /^(neni|nemame|nejsou|not|no)\b/.test(s) ||
    /vyprodan|out ?of ?stock|nedostupn|sold ?out|na dotaz|predobjedn|pre-?order|backorder|predprodej|u dodavatele|na objednavku/.test(s)
  ) {
    const days = daysFromText(s, opts.now);
    return { in_stock: 0, delivery_days: days != null && days > 0 ? days : null };
  }
  if (/^skladem/.test(s) || /^in ?stock/.test(s) || compact.startsWith('instock')) {
    // „Skladem 0 ks“ / „skladem: 0 kusů“ = není skladem (data-16)
    const qty = /^(?:skladem|in ?stock)\s*[:(]?\s*(\d{1,7})\s*(?:ks|kus|kusu|kusy|pcs|x)?\b/.exec(s);
    if (qty && Number(qty[1]) === 0) return { in_stock: 0, delivery_days: null };
    if (/dodavatel|supplier|externi/.test(s)) {
      const days = daysFromText(s, opts.now);
      return { in_stock: 0, delivery_days: days != null && days > 0 ? days : null };
    }
    return { in_stock: 1, delivery_days: 0 };
  }
  const days = daysFromText(s, opts.now);
  if (days != null) return fromDays(days);
  return { ...UNKNOWN };
}

function daysFromText(s, now) {
  // Počty číslic jsou omezené a číslo nesmí navazovat na další číslici ((?<!\d)) – jinak regulární výraz na dlouhé
  // řadě číslic zkouší každou pozici se vším zpětným hledáním (kvadratická doba – security-3).
  let m = /(?<!\d)(\d{1,4})\s*(?:-|–|—|az|to)\s*(\d{1,4})\s*(?:prac(?:ovnich|\.)?\s*)?(dnu|dni|dny|den|days?|d|tydnu|tydny|tyden|tydne|weeks?|hodin|hod|h|hours?)\b/.exec(s);
  if (m) return unitDays(Math.max(Number(m[1]), Number(m[2])), m[3]);
  m = /(?<!\d)(\d{1,4}(?:[.,]\d{1,3})?)\s*(?:prac(?:ovnich|ovni|\.)?\s*)?(dnu|dni|dny|den|days?|d|tydnu|tydny|tyden|tydne|weeks?|hodin|hodiny|hod|h|hours?)\b/.exec(s);
  if (m) return unitDays(Number(m[1].replace(',', '.')), m[2]);
  if (/\b(zitra|tomorrow)\b/.test(s)) return 1;
  if (/\b(dnes|today)\b/.test(s)) return 0;
  const iso = parseDate(s);
  if (iso) {
    const nowMs = now ? new Date(now).getTime() : Date.now();
    return Math.max(0, Math.ceil((Date.parse(iso) - nowMs) / DAY_MS));
  }
  return null;
}

function unitDays(n, unit) {
  if (!Number.isFinite(n)) return null;
  if (/^(tydnu|tydny|tyden|tydne|week|weeks)$/.test(unit)) return n * 7;
  if (/^(hodin|hodiny|hod|h|hour|hours)$/.test(unit)) return Math.ceil(n / 24);
  return n;
}

// ---------------------------------------------------------------------------------------------------------
// Kompilace mapování a aplikace na záznam

/** Mapování může přijít jako JSON text (query parametr) nebo null. */
function normalizeMappingArg(mapping) {
  if (mapping == null || mapping === '') return {};
  if (typeof mapping === 'string') {
    try {
      const m = JSON.parse(mapping);
      if (m && typeof m === 'object' && !Array.isArray(m)) return m;
    } catch {
      /* níže */
    }
    throw new ImportError('Mapování není platný JSON objekt.');
  }
  if (typeof mapping !== 'object' || Array.isArray(mapping)) throw new ImportError('Mapování musí být objekt.');
  return mapping;
}

/**
 * Připraví mapování pro opakované použití (jednou na import, ne na řádek).
 * Výslovné mapping.fields vyhrávají; zbylá pole doplní návrh (suggestMapping) nad `headers`, pokud není mapping.suggest === false.
 * `mapping.fields[pole] = null | ''` znamená „nemapovat“ (a pole se ani nenavrhuje).
 * Zdrojový klíč, který v hlavičkách není, se zkusí najít bez ohledu na velikost písmen / diakritiku.
 * @param {object} mapping
 * @param {string[]} headers
 * @param {'products'|'offers'} kind
 * @param {{format?: string|null, delimiter?: string|null, nested?: boolean}} [ctx] rozpoznaný formát vstupu (čtení čísel:
 *   v XML/JSON je tečka vždy desetinná, v CSV s oddělovačem „;“ je desetinná čárka), oddělovač CSV a vnořené nabídky
 */
function compileMapping(mapping, headers, kind, ctx = {}) {
  kindOf(kind);
  const m = normalizeMappingArg(mapping);
  const hdrs = Array.isArray(headers) ? headers : [];
  const headerSet = new Set(hdrs);
  const fieldIndex = FIELD_INDEX[kind];
  const fields = {};
  const missing = [];
  const unknownFields = [];
  const disabled = new Set();
  const explicit = m.fields && typeof m.fields === 'object' ? m.fields : {};
  let normIndex = null;
  const resolveHeader = (key) => {
    if (headerSet.has(key) || !hdrs.length) return key;
    if (!normIndex) {
      normIndex = new Map();
      for (const h of hdrs) {
        const lk = String(h).toLowerCase();
        if (!normIndex.has(lk)) normIndex.set(lk, h);
        const f = keyForms(h);
        if (f && !normIndex.has('\u0000' + f.full)) normIndex.set('\u0000' + f.full, h);
      }
    }
    const lower = normIndex.get(String(key).toLowerCase());
    if (lower !== undefined) return lower;
    const f = keyForms(key);
    const byNorm = f ? normIndex.get('\u0000' + f.full) : undefined;
    if (byNorm !== undefined) return byNorm;
    missing.push(key);
    return key;
  };
  for (const [canon, src] of Object.entries(explicit)) {
    if (!fieldIndex.has(canon)) {
      unknownFields.push(canon);
      continue;
    }
    if (src === null || src === '' || src === false) {
      disabled.add(canon);
      continue;
    }
    if (Array.isArray(src)) {
      const list = src.filter((x) => typeof x === 'string' && x !== '').map(resolveHeader);
      if (list.length) fields[canon] = list;
      else disabled.add(canon);
    } else fields[canon] = resolveHeader(String(src));
  }
  const used = new Set();
  for (const v of Object.values(fields)) for (const k of Array.isArray(v) ? v : [v]) used.add(k);
  if (m.suggest !== false) {
    const sug = suggestMapping(hdrs, kind, { exclude: [...Object.keys(fields), ...disabled], excludeHeaders: used, nested: !!ctx.nested }).fields;
    for (const [canon, h] of Object.entries(sug)) {
      fields[canon] = h;
      used.add(h);
    }
    // Akční cena (g:sale_price) je cena, za kterou se skutečně prodává → přednost před běžnou (prázdná = běžná cena)
    if (typeof sug.price === 'string' && explicit.price === undefined) {
      const sale = hdrs.find((h) => !used.has(h) && SALE_PRICE_ALIASES.has(keyForms(h)?.last));
      if (sale) {
        fields.price = [sale, sug.price];
        used.add(sale);
      }
    }
  }
  const defaults = {};
  const defs = m.defaults && typeof m.defaults === 'object' ? m.defaults : {};
  for (const [canon, v] of Object.entries(defs)) {
    if (!fieldIndex.has(canon)) {
      unknownFields.push(canon);
      continue;
    }
    if (isEmpty(v)) continue;
    defaults[canon] = v;
  }
  let attrsMode = 'all';
  if (m.attrs === 'none' || m.attrs === false) attrsMode = 'none';
  else if (Array.isArray(m.attrs)) attrsMode = new Set(m.attrs.map(String));
  const decimal = m.csv && (m.csv.decimal === ',' || m.csv.decimal === '.') ? m.csv.decimal : m.decimal === ',' || m.decimal === '.' ? m.decimal : undefined;
  // Čtení čísel podle formátu (money-11, data-10): XML/JSON (xsd:double) – tečka je vždy desetinná („1299.000“ = 1299);
  // CSV s oddělovačem „;“ (český Excel/POHODA) – čárka je vždy desetinná („123,456“ = 123,456).
  const format = ctx.format || null;
  const numberOpts = {
    decimal,
    dotThousands: !(format === 'xml' || format === 'json'),
    commaThousands: !(format === 'csv' && ctx.delimiter === ';'),
  };
  // pořadí polí podle CANONICAL (dostupnost se skládá až na konci)
  const order = CANONICAL[kind].map((f) => f.key).filter((k) => fields[k] !== undefined || defaults[k] !== undefined);
  return {
    kind,
    fields,
    defaults,
    used,
    order,
    decimal,
    numberOpts,
    format,
    attrsMode,
    attrsMaxLength: Number(m.attrs_max_length) > 0 ? Number(m.attrs_max_length) : 1000,
    priceNet: m.price_net === true || m.price_net === 1 || m.price_net === 'true' || m.price_net === '1',
    missing,
    unknownFields,
  };
}

/** Zdrojový klíč, ze kterého getValue hodnotu skutečně vzal (u výčtu první neprázdný). */
function getValueKey(flat, src) {
  if (!Array.isArray(src)) return src;
  for (const k of src) if (!isEmpty(flat[k])) return k;
  return src.find((k) => flat[k] !== undefined) ?? src[0];
}

function getValue(flat, src) {
  if (Array.isArray(src)) {
    let firstDefined;
    for (const k of src) {
      const v = flat[k];
      if (!isEmpty(v)) return v;
      if (firstDefined === undefined && v !== undefined) firstDefined = v;
    }
    return firstDefined;
  }
  return flat[src];
}

function describe(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > 60 ? s.slice(0, 57) + '…' : s;
}

/**
 * Doprava s více hodnotami (Google Merchant: opakované g:shipping pro více zemí → „99 CZK|149 CZK“): vezme hodnotu pro
 * CZ (sousední klíč `…country`), jinak nejnižší (data-7).
 */
function pickShipping(rec, srcKey, v) {
  if (typeof v !== 'string' || !v.includes('|')) return v;
  const parts = v.split('|').map((x) => x.trim());
  const base = srcKey && srcKey.includes('.') ? srcKey.slice(0, srcKey.lastIndexOf('.')) : null;
  const country = base != null ? rec[`${base}.country`] : undefined;
  if (typeof country === 'string') {
    const cs = country.split('|').map((x) => x.trim().toUpperCase());
    const i = cs.indexOf('CZ');
    if (i >= 0 && i < parts.length && parts[i] !== '') return parts[i];
  }
  let best = null;
  for (const p of parts) {
    if (/^(zdarma|free)$/i.test(fold(p))) return '0';
    const n = parseNumber(p);
    if (n != null && (best == null || n < best.n)) best = { n, p };
  }
  return best ? best.p : v;
}

function coerce(field, v, cm, errors) {
  const label = field.label;
  switch (field.type) {
    case 'code':
      return normalizeCode(v);
    case 'string':
      return normalizeText(v, SINGLE_LINE.has(field.key));
    case 'text':
      return normalizeText(v, false);
    case 'number': {
      if (isEmpty(v)) return null;
      // doprava „zdarma“ = 0 Kč (jinak by se ponechala stará placená doprava – data-16)
      if (field.key === 'shipping' && typeof v === 'string' && /^\s*(zdarma|free|gratis|doprava zdarma|free shipping|0\s*,-)\s*$/i.test(fold(v))) return 0;
      const n = parseNumber(v, cm.numberOpts || { decimal: cm.decimal });
      if (n == null) {
        errors.push(`Pole „${label}“: hodnota „${describe(v)}“ není číslo`);
        return undefined;
      }
      return n;
    }
    case 'vat': {
      if (isEmpty(v)) return null;
      const n = parseVat(v);
      if (n == null) {
        errors.push(`Pole „${label}“: neplatná sazba DPH „${describe(v)}“`);
        return undefined;
      }
      return n;
    }
    case 'boolean': {
      if (isEmpty(v)) return null;
      const b = parseBool(v);
      if (b == null) {
        errors.push(`Pole „${label}“: hodnota „${describe(v)}“ není ano/ne`);
        return undefined;
      }
      return b;
    }
    case 'date': {
      if (isEmpty(v)) return null;
      const d = parseDate(v);
      if (d == null) {
        errors.push(`Pole „${label}“: neplatné datum „${describe(v)}“`);
        return undefined;
      }
      return d;
    }
    default:
      return v;
  }
}

/**
 * Hodnota pro attrs: čísla zůstávají, text celý číselný → číslo (kromě úvodních nul typu „0123“), prázdné → null.
 * Číslo se čte STEJNĚ jako kanonická pole (numberOpts – „1.500“ v CSV = 1500 všude, ne 1,5 v atributech; data-10).
 */
function attrValue(v, maxLength, numberOpts) {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object') return undefined;
  const s = String(v).trim();
  if (!s) return null;
  if (s.length > maxLength) return undefined; // dlouhé texty (popisy, HTML) do atributů nepatří
  if (/^-?\d+(?:[.,]\d+)?$/.test(s) && !/^-?0\d/.test(s)) {
    const n = numberOpts ? parseNumber(s, numberOpts) : Number(s.replace(',', '.'));
    if (n != null && Number.isFinite(n) && Math.abs(n) < 1e15) return n;
  }
  return s;
}

/**
 * Sestaví kanonický záznam z plochého záznamu.
 * - `value` je null, když záznam nelze použít (chybí kód / konkurent / cena / párovací klíč); `errors` pak obsahují důvod.
 * - Nepovinné pole s neplatnou hodnotou se vynechá (uložená hodnota se nepřepíše) a do `errors` se přidá varování –
 *   `value` přitom zůstane (řádek se naimportuje bez toho pole).
 * - Klíč, který v záznamu vůbec není (chybí element v XML/JSON), = pole se nemění; prázdná buňka = null (smazat).
 * - Produkty: nenamapované klíče → `attrs` (null = smazat atribut), pokud mapping.attrs !== 'none'.
 * - Nabídky: dostupnost → `in_stock` + `delivery_days` (+ `stock_qty`), viz normalizeAvailability.
 * - mapping.price_net → záznam dostane `price_is_net: true`; na hrubou cenu převede importér (DPH produktu / výchozí).
 * @param {object} flat plochý záznam
 * @param {object} mapping
 * @param {'products'|'offers'} kind
 * @param {{compiled?: object, now?: Date|string, offersPath?: string|null}} [ctx] compiled = výsledek compileMapping (jinak se
 *   sestaví z klíčů záznamu); offersPath = cesta rozložených potomků z extractRecords (jejich prefixované klíče nejdou do attrs)
 * @returns {{value: object|null, errors: string[]}}
 */
function applyMapping(flat, mapping, kind, ctx = {}) {
  const cm = ctx.compiled || compileMapping(mapping, Object.keys(flat || {}), kind, { format: ctx.format, delimiter: ctx.delimiter });
  const rec = flat && typeof flat === 'object' ? flat : {};
  const fieldIndex = FIELD_INDEX[cm.kind];
  const out = {};
  const errors = [];
  const invalid = new Set();
  let avail = null;
  for (const key of cm.order) {
    const field = fieldIndex.get(key);
    const src = cm.fields[key];
    let v;
    let present = false;
    if (src !== undefined) {
      v = getValue(rec, src);
      present = v !== undefined;
    }
    let srcKey = Array.isArray(src) ? src[0] : src;
    if (isEmpty(v) && cm.defaults[key] !== undefined) {
      v = cm.defaults[key];
      present = true;
      srcKey = null;
    }
    if (!present) continue;
    if (AVAIL_FIELDS.has(key)) {
      if (!avail) avail = {};
      avail[key] = { v, srcKey };
      continue;
    }
    if (key === 'shipping' && srcKey != null) v = pickShipping(rec, getValueKey(rec, src), v);
    const c = coerce(field, v, cm, errors);
    if (c !== undefined) out[key] = c;
    else invalid.add(key);
  }

  if (cm.kind === 'offers') {
    if (avail) applyAvailability(out, avail, cm, errors, ctx.now);
    if (cm.priceNet) out.price_is_net = true;
    const fatal = [];
    if (!out.competitor) fatal.push('Chybí konkurent (namapujte sloupec nebo zadejte výchozí hodnotu)');
    if (invalid.has('price')) fatal.push(`Neplatná cena „${describe(getValue(rec, cm.fields.price) ?? cm.defaults.price)}“`);
    else if (out.price === undefined || out.price === null) fatal.push('Chybí cena');
    else if (!(out.price > 0) || !Number.isFinite(out.price)) fatal.push(`Neplatná cena „${out.price}“ (musí být kladné číslo)`);
    if (!out.code && !out.ean && !out.mpn && !out.ext_id && !out.name) fatal.push('Chybí párovací klíč (náš kód, EAN, MPN, ID položky nebo název)');
    if (fatal.length) {
      const rest = invalid.has('price') ? errors.filter((e) => !e.startsWith(`Pole „${fieldIndex.get('price').label}“`)) : errors;
      // konkurent chybného řádku – import pak u něj nemaže „chybějící“ nabídky (replace; data-9)
      return { value: null, errors: [...fatal, ...rest], competitor: out.competitor ?? null };
    }
    return { value: out, errors };
  }

  // produkty
  if (!codeKey(out.code)) return { value: null, errors: ['Chybí kód produktu', ...errors] };
  if (cm.priceNet) out.price_is_net = true;
  // Základ DPH podle záznamu (POHODA: <stk:sellingPrice payVAT="false"> = cena BEZ DPH, <stk:purchasingPrice payVAT="true">
  // = nákup S DPH). Sousední klíč `<zdroj>.@payVAT`; převod udělá importProducts s DPH záznamu (money-10, data-1).
  const netFields = [];
  for (const f of ['price', 'msrp', 'purchase_price']) {
    const src = cm.fields[f];
    if (src === undefined || out[f] == null) continue;
    const key = getValueKey(rec, src);
    const pv = key != null ? rec[`${key}.@payVAT`] ?? rec[`${key}.@payvat`] : undefined;
    const b = pv === undefined ? null : parseBool(pv);
    if (b == null) continue;
    if (f === 'purchase_price') out.purchase_is_gross = b === 1;
    else if (b === 0) netFields.push(f);
  }
  if (netFields.length) out.price_net_fields = netFields;
  if (cm.attrsMode !== 'none') {
    let attrs = null;
    // u rozložených variant jsou klíče potomka i s prefixem (`VARIANTS.CODE`) – duplicitu do attrs nedávat
    const skipPrefix = ctx.offersPath ? ctx.offersPath + '.' : null;
    for (const k of Object.keys(rec)) {
      if (cm.used.has(k)) continue;
      if (skipPrefix && k.startsWith(skipPrefix)) continue;
      if (cm.attrsMode !== 'all' && !cm.attrsMode.has(k)) continue;
      const av = attrValue(rec[k], cm.attrsMaxLength, cm.numberOpts);
      if (av === undefined) continue;
      if (!attrs) attrs = {};
      attrs[k] = av;
    }
    if (attrs) out.attrs = attrs;
  }
  return { value: out, errors };
}

function applyAvailability(out, avail, cm, errors, now) {
  let inStock = null;
  let days = null;
  let known = false;
  if (avail.availability) {
    const { v, srcKey } = avail.availability;
    const r = normalizeAvailability(v, { field: srcKey, now });
    known = true;
    if (r.in_stock == null && !isEmpty(v)) errors.push(`Pole „Dostupnost“: nerozpoznaná hodnota „${describe(v)}“`);
    inStock = r.in_stock;
    days = r.delivery_days;
  }
  if (avail.in_stock) {
    const { v } = avail.in_stock;
    const r = normalizeAvailability(v, { hint: 'bool', now });
    known = true;
    if (r.in_stock == null && !isEmpty(v)) errors.push(`Pole „Skladem“: nerozpoznaná hodnota „${describe(v)}“`);
    if (r.in_stock != null) {
      inStock = r.in_stock;
      if (days == null && r.in_stock === 1) days = 0;
    }
  }
  if (avail.delivery_days) {
    const { v } = avail.delivery_days;
    known = true;
    let d = null;
    if (!isEmpty(v)) {
      d = typeof v === 'number' ? v : parseNumber(v);
      if (d == null) d = normalizeAvailability(v, { hint: 'days', now }).delivery_days;
      if (d == null) errors.push(`Pole „Dodání (dny)“: nerozpoznaná hodnota „${describe(v)}“`);
    }
    if (d != null) {
      days = Math.max(0, d);
      if (inStock == null) inStock = days <= 0 ? 1 : 0;
    }
  }
  if (avail.stock_qty) {
    const { v } = avail.stock_qty;
    known = true;
    let q = null;
    if (!isEmpty(v)) {
      q = parseNumber(v);
      if (q == null) errors.push(`Pole „Počet kusů u konkurenta“: hodnota „${describe(v)}“ není číslo`);
    }
    if (q != null) {
      out.stock_qty = q;
      if (q > 0) {
        inStock = 1;
        if (days == null || days > 0) days = 0;
      } else if (inStock == null) inStock = 0;
    }
  }
  if (known) {
    out.in_stock = inStock;
    out.delivery_days = days;
  }
}

/**
 * Sběr chyb do stats.errors: nejvýše `max` položek {row, message[, warning]}; když je chyb víc, poslední položka
 * je souhrn „… a dalších N“ (row: null). S `onError` se chyby místo toho předávají volajícímu (runImport je slučuje).
 * @param {object[]} list cílové pole (stats.errors)
 * @param {((row: number|null, message: string, extra?: object) => void)|undefined} onError
 */
function errorCollector(list, onError, max = 100) {
  let total = 0;
  return {
    add(row, message, extra) {
      total++;
      if (onError) {
        onError(row, message, extra);
        return;
      }
      if (list.length < max) list.push(extra ? { row, message, ...extra } : { row, message });
    },
    get total() {
      return total;
    },
    finish() {
      if (!onError && total > list.length && list.length >= max) {
        list[max - 1] = { row: null, message: `… a dalších ${total - (max - 1)} chyb a varování (zobrazeno prvních ${max - 1})` };
      }
    },
  };
}

/** Druh importu → seznam kanonických klíčů. */
function canonicalKeys(kind) {
  return CANONICAL[kindOf(kind)].map((f) => f.key);
}

module.exports = {
  CANONICAL,
  ALIASES,
  ImportError,
  suggestMapping,
  compileMapping,
  applyMapping,
  normalizeMappingArg,
  normalizeAvailability,
  availabilityHint,
  parseDate,
  parseBool,
  parseVat,
  normalizeCode,
  normalizeText,
  attrValue,
  canonicalKeys,
  errorCollector,
  keyForms,
  pragueToUtc,
  isEmpty,
};
