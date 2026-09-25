// Model importu – kanonická pole (SPEC §3.1, §3.3), sestavení mapování, typ souboru,
// popisky statistik a ukázky volání API (curl). Čistý modul bez DOM.

/** Kanonická pole podle druhu importu. required = povinné (lze nahradit výchozí hodnotou). */
export const CANONICAL = {
  products: [
    { key: 'code', label: 'Kód (SKU / POHODA)', required: true, help: 'Náš jedinečný kód – podle něj se páruje a exportuje.' },
    { key: 'name', label: 'Název' },
    { key: 'ean', label: 'EAN / GTIN' },
    { key: 'mpn', label: 'Kód výrobce (MPN)' },
    { key: 'manufacturer', label: 'Výrobce / značka' },
    { key: 'category', label: 'Kategorie' },
    { key: 'supplier', label: 'Dodavatel' },
    { key: 'owner', label: 'Zodpovědná osoba' },
    { key: 'purchase_price', label: 'Nákupní cena (bez DPH)', type: 'number' },
    { key: 'price', label: 'Prodejní cena (s DPH)', type: 'number' },
    { key: 'vat_rate', label: 'Sazba DPH %', type: 'number' },
    { key: 'msrp', label: 'Doporučená cena (MOC)', type: 'number' },
    { key: 'stock', label: 'Sklad (ks)', type: 'number' },
    { key: 'sales_30', label: 'Prodeje 30 dní', type: 'number' },
    { key: 'sales_90', label: 'Prodeje 90 dní', type: 'number' },
    { key: 'active', label: 'Aktivní (1/0)' },
  ],
  offers: [
    { key: 'competitor', label: 'Konkurent', required: true, help: 'Název obchodu. Když soubor obsahuje ceny jednoho obchodu, zadejte ho jako výchozí hodnotu.' },
    { key: 'price', label: 'Cena konkurenta (s DPH)', required: true, type: 'number' },
    { key: 'code', label: 'Náš kód (již spárováno)' },
    { key: 'ean', label: 'EAN / GTIN' },
    { key: 'mpn', label: 'Kód výrobce (MPN)' },
    { key: 'ext_id', label: 'ID položky u poskytovatele' },
    { key: 'name', label: 'Název u konkurenta' },
    { key: 'shipping', label: 'Doprava (Kč)', type: 'number' },
    { key: 'availability', label: 'Dostupnost (text)' },
    { key: 'in_stock', label: 'Skladem (ano/ne)' },
    { key: 'delivery_days', label: 'Dodání (dny)', type: 'number' },
    { key: 'stock_qty', label: 'Počet kusů u konkurenta', type: 'number' },
    { key: 'url', label: 'URL nabídky' },
    { key: 'observed_at', label: 'Datum zjištění ceny' },
  ],
};

const EXT_TYPES = {
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  txt: 'text/plain',
  json: 'application/json',
  xml: 'application/xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** Content-Type souboru: z File.type, jinak podle přípony. */
export function guessContentType(name, type) {
  if (type) return type;
  const ext = String(name || '').toLowerCase().split('.').pop();
  return EXT_TYPES[ext] || 'application/octet-stream';
}

/** Formát podle přípony (jen pro zobrazení). */
export function formatFromName(name) {
  const ext = String(name || '').toLowerCase().split('.').pop();
  return ['csv', 'tsv', 'txt'].includes(ext) ? 'csv' : ['json', 'xml', 'xlsx'].includes(ext) ? ext : null;
}

function clean(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (v == null || v === '') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Sestaví objekt mapování pro API ze stavu průvodce.
 * @param {{format?, item_path?, fields?, defaults?, csv?: {delimiter?, decimal?, encoding?, header_row?}, encoding?, price_net?, attrs?}} st
 */
export function buildMapping(st = {}) {
  const m = {};
  if (st.format && st.format !== 'auto') m.format = st.format;
  if (st.item_path) m.item_path = st.item_path;
  if (st.offers_path) m.offers_path = st.offers_path;
  const fields = clean(st.fields);
  if (Object.keys(fields).length) m.fields = fields;
  const defaults = clean(st.defaults);
  if (Object.keys(defaults).length) m.defaults = defaults;
  const csv = clean(st.csv);
  if (csv.header_row != null) csv.header_row = Number(csv.header_row) || 1;
  if (Object.keys(csv).length) m.csv = csv;
  if (st.encoding) m.encoding = st.encoding;
  if (st.price_net) m.price_net = true;
  if (st.attrs === 'none') m.attrs = 'none';
  return m;
}

/** Chybí povinná kanonická pole (nenamapovaná a bez výchozí hodnoty)? */
export function missingRequired(kind, fields = {}, defaults = {}) {
  const list = CANONICAL[kind] || [];
  return list
    .filter((f) => f.required)
    .filter((f) => !fields[f.key] && (defaults[f.key] == null || defaults[f.key] === ''))
    .filter((f) => !(kind === 'offers' && f.key === 'code' && (fields.ean || fields.mpn || fields.ext_id)))
    .map((f) => f.label);
}

/** Pro nabídky je potřeba aspoň jeden párovací klíč. */
export function hasMatchKey(kind, fields = {}) {
  if (kind !== 'offers') return true;
  return Boolean(fields.code || fields.ean || fields.mpn || fields.ext_id || fields.name);
}

/** Popisky statistik importu. */
export const STAT_LABELS = {
  received: 'Přijato záznamů',
  created: 'Nově založeno',
  updated: 'Aktualizováno',
  unchanged: 'Beze změny',
  deactivated: 'Deaktivováno',
  matched: 'Spárováno',
  unmatched: 'Nespárováno',
  ambiguous: 'Nejednoznačné',
  stale: 'Zastaralé (ignorováno)',
  duplicates: 'Duplicity',
  removed: 'Odstraněno',
  competitors_created: 'Noví konkurenti',
  errors: 'Chyby',
};

/** Statistiky → seznam {key, label, value} ve stabilním pořadí; chyby jako počet. */
export function statsList(stats) {
  if (!stats || typeof stats !== 'object') return [];
  const out = [];
  for (const key of Object.keys(STAT_LABELS)) {
    if (!(key in stats)) continue;
    const v = stats[key];
    out.push({ key, label: STAT_LABELS[key], value: Array.isArray(v) ? v.length : v });
  }
  return out;
}

/** Ukázky volání API pro posílání dat (curl). */
export function curlExamples(origin, base = '/api/v1') {
  const api = origin.replace(/\/+$/, '') + base;
  const csvMapping = { fields: { ean: 'EAN', competitor: 'Obchod', price: 'Cena s DPH' }, csv: { decimal: ',' } };
  return [
    {
      id: 'offers-json',
      title: 'Ceny konkurence – JSON',
      text: 'Nejjednodušší varianta: pole nabídek v kanonických polích. Párování podle našeho kódu, EAN nebo MPN. Parametr replace=competitors smaže staré nabídky konkurentů, kteří jsou v dávce.',
      code: [
        `curl -X POST "${api}/import/offers?replace=competitors" \\`,
        '  -H "Authorization: Bearer $CENOTVORBA_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        "  --data-binary '{\"items\": [",
        '    {"ean": "8592842012345", "competitor": "VeloMarket.cz", "price": 18990,',
        '     "shipping": 0, "availability": "skladem", "url": "https://velomarket.example/trek-marlin-7"},',
        '    {"code": "TRK-MAR7-M", "competitor": "KoloExpres.cz", "price": 19490, "in_stock": false}',
        "  ]}'",
      ].join('\n'),
    },
    {
      id: 'offers-xml',
      title: 'Ceny konkurence – XML soubor',
      text: 'Libovolné XML (např. export z nástroje na sběr cen). Opakující se element se najde automaticky, mapování polí se převezme z uloženého zdroje (source=ID).',
      code: [
        `curl -X POST "${api}/import/offers?source=2" \\`,
        '  -H "Authorization: Bearer $CENOTVORBA_TOKEN" \\',
        '  -H "Content-Type: application/xml" \\',
        '  --data-binary @konkurence.xml',
        '',
        '# konkurence.xml',
        '<offers>',
        '  <offer>',
        '    <ean>8592842012345</ean>',
        '    <shop>VeloMarket.cz</shop>',
        '    <price>18990</price>',
        '    <delivery>0</delivery>',
        '  </offer>',
        '</offers>',
      ].join('\n'),
    },
    {
      id: 'offers-csv',
      title: 'Ceny konkurence – CSV s vlastním mapováním',
      text: 'CSV z Excelu (středník, desetinná čárka, windows-1250). Mapování lze poslat přímo v parametru mapping (URL-kódovaný JSON) nebo odkazem na uložený zdroj (source=ID). dry_run=1 data jen ověří bez zápisu.',
      code: [
        '# mapping = ' + JSON.stringify(csvMapping),
        `curl -X POST "${api}/import/offers?dry_run=1&mapping=${encodeURIComponent(JSON.stringify(csvMapping))}" \\`,
        '  -H "Authorization: Bearer $CENOTVORBA_TOKEN" \\',
        '  -H "Content-Type: text/csv" \\',
        '  --data-binary @ceny.csv',
      ].join('\n'),
    },
    {
      id: 'products-csv',
      title: 'Katalog produktů z POHODY – CSV',
      text: 'Pravidelný export skladových zásob (kód, název, nákupní a prodejní cena, sklad). deactivate_missing=1 deaktivuje produkty, které v souboru chybí.',
      code: [
        `curl -X POST "${api}/import/products?source=1&deactivate_missing=1" \\`,
        '  -H "Authorization: Bearer $CENOTVORBA_TOKEN" \\',
        '  -H "Content-Type: text/csv; charset=windows-1250" \\',
        '  --data-binary @zasoby.csv',
      ].join('\n'),
    },
    {
      id: 'products-json',
      title: 'Katalog produktů – JSON',
      text: 'Neznámé sloupce (např. N, sezona, imprese_30) se uloží jako atributy a lze podle nich tvořit segmenty.',
      code: [
        `curl -X POST "${api}/import/products" \\`,
        '  -H "Authorization: Bearer $CENOTVORBA_TOKEN" \\',
        '  -H "Content-Type: application/json" \\',
        "  --data-binary '[{\"code\": \"TRK-MAR7-M\", \"name\": \"Trek Marlin 7 Gen 3, M\", \"purchase_price\": 14200,",
        "                  \"price\": 21990, \"msrp\": 21990, \"stock\": 3, \"N\": \"N2\", \"sezona\": \"2026\"}]'",
      ].join('\n'),
    },
    {
      id: 'run',
      title: 'Spustit přecenění a stáhnout změny',
      text: 'Po importu lze přecenění spustit přes API. Schválené změny si admin stáhne feedem a potvrdí (ack).',
      code: [
        `curl -X POST "${api}/runs" -H "Authorization: Bearer $CENOTVORBA_TOKEN" \\`,
        '  -H "Content-Type: application/json" --data-binary \'{}\'',
        '',
        `curl "${api}/export/changes.json" -H "Authorization: Bearer $CENOTVORBA_TOKEN"`,
      ].join('\n'),
    },
  ];
}
