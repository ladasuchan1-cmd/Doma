'use strict';
// Volitelné AI nacenění (Claude) – fotka + text inzerátu + vytěžené údaje + odhad modelu + srovnatelné inzeráty
// → strukturovaný JSON (odhad, rozpětí, stav z fotky, poznámky). Jen když je nastavený ANTHROPIC_API_KEY.
//
// - SDK @anthropic-ai/sdk je volitelná závislost a načítá se až při použití.
// - Stabilní instrukce + tabulka vlastních prodejů obchodu jsou v `system` s cache_control → při více voláních
//   za běh se čtou z cache (levnější). Proměnlivá data jdou až do zprávy uživatele.
// - Model claude-opus-5-5: myšlení nelze vypnout → `thinking` se neposílá, výpočet řídí output_config.effort = 'low';
//   výstup je vynucený JSON schématem (output_config.format).
// - Při odmítnutí (bezpečnostní klasifikátory) API samo zkusí doporučený záložní model (beta server-side-fallback,
//   fallbacks: 'default'); stop_reason se kontroluje před čtením obsahu.
// - Klient jde podstrčit (testy používají napodobeninu, skutečné API se v testech nevolá).

const { nowIso, parseJson } = require('../db');
const { hash, truncate } = require('../util/text');
const pricing = require('./index');
const { BIKE_TYPES } = require('../classify');

const DEFAULT_MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const CONCURRENCY = 3;
const MAX_TOKENS = 8000;
const CONDITIONS = ['new', 'like_new', 'very_good', 'good', 'fair', 'poor', 'parts'];

/** JSON schéma odpovědi (structured outputs – bez min/max omezení, ty se hlídají v kódu). */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    estimate_czk: { type: 'integer', description: 'Realistická tržní hodnota v Kč – za kolik se kolo v ČR skutečně prodá (ne inzerovaná cena). 0, pokud nejde o kolo.' },
    low_czk: { type: 'integer', description: 'Dolní hranice realistického rozpětí v Kč.' },
    high_czk: { type: 'integer', description: 'Horní hranice realistického rozpětí v Kč.' },
    condition: { type: 'string', enum: CONDITIONS, description: 'Stav kola podle fotky a textu.' },
    condition_from_photo: { type: 'string', description: 'Krátce česky, co je vidět na fotce (stav, poškození, komponenty).' },
    notes: { type: 'string', description: 'Max. 300 znaků česky: co určuje hodnotu, varovná znamení (podezřelá cena, chybějící díly, neodpovídající fotka).' },
    is_bike: { type: 'boolean', description: 'true = inzerát nabízí celé jízdní kolo (případně rám).' },
    bike_type: { type: 'string', enum: BIKE_TYPES, description: 'Typ kola podle taxonomie Kolomapy.' },
  },
  required: ['estimate_czk', 'low_czk', 'high_czk', 'condition', 'condition_from_photo', 'notes', 'is_bike', 'bike_type'],
  additionalProperties: false,
};

const SYSTEM_INSTRUCTIONS = `Jsi zkušený odhadce použitých jízdních kol pro český obchod s koly Koloshop (prodává nová i použitá kola a vykupuje použitá kola od zákazníků, která pak prodává jako BAZAR).
Dostaneš jeden inzerát z českého bazaru (Bazoš, Sbazar, Aukro, Cyklobazar): titulek, popis, parametry webu, hlavní fotku, údaje vytěžené programem, odhad výpočetního modelu (naučeného na tisících inzerátů) a srovnatelné inzeráty.

Úkol: urči realistickou TRŽNÍ HODNOTU kola v Kč – za kolik se kolo v ČR v daném stavu skutečně prodá (ne kolik si prodávající řekl). Inzerované ceny bývají o 8–15 % vyšší než skutečné prodejní; obchod prodává použitá kola zhruba za ceny v tabulce níže.

Postup:
1. Ověř, že jde o celé kolo (nebo rám). Pokud je to díl, příslušenství, oblečení, koloběžka, motorka nebo poptávka, vrať is_bike = false a estimate_czk = 0.
2. Urči značku, model, rok a výbavu z textu; z fotky posuď skutečný stav (oděrky, rez, poškozený rám, opotřebení, chybějící díly), zda fotka odpovídá popisu a typ kola.
3. Vyjdi z ceny nového kola daného modelu a roku na českém trhu, odečti amortizaci (běžná kola ~10–12 %/rok, elektrokola rychleji – baterie stárne; prémiové dětské značky Woom, Early Rider, Kubikes, Academy drží hodnotu 50–70 %) a uprav podle stavu. Porovnej s odhadem modelu a srovnatelnými inzeráty; od modelu se odchyl jen s jasným důvodem (fotka, výbava, chybná klasifikace).
4. Rozpětí low–high má pokrýt realistické prodejní ceny (cca 80 % případů).
5. Do notes napiš max. 300 znaků česky: hlavní důvody hodnoty a varovná znamení (podezřele nízká cena bez dokladu = možná kradené, poškození, chybí baterie, rám praskl, fotka z internetu, kolo se neshoduje s popisem). condition_from_photo = krátký popis toho, co je na fotce vidět.
Odpovídej výhradně JSON podle schématu. Částky v celých Kč.

Typy kol (bike_type): mtb_hardtail, mtb_full, road, gravel, cyclocross, trekking, cross, city, kids, balance (odrážedlo), bmx, dirt, fatbike, folding, cargo, tandem, ebike_mtb, ebike_mtb_full, ebike_trekking, ebike_city, ebike_road, ebike_cargo, ebike_kids, other.
Stav (condition): new, like_new (jako nové), very_good, good, fair (opotřebené), poor (na opravu), parts (na díly).`;

/** Načte SDK až při použití (volitelná závislost). */
function loadSdk() {
  try {
    const m = require('@anthropic-ai/sdk');
    return m.default || m.Anthropic || m;
  } catch {
    throw new Error('Pro AI nacenění spusťte v adresáři kolomapa: npm install @anthropic-ai/sdk');
  }
}

/**
 * Tabulka vlastních prodejů pro system prompt (stabilní pořadí → stabilní cache).
 * @param {object[]} sales
 */
function salesTable(sales) {
  const rows = (sales || [])
    .filter((s) => s && s.title && s.priceCzk > 0)
    .slice()
    .sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')) || String(a.title).localeCompare(String(b.title)));
  if (!rows.length) return '';
  const lines = rows.map((s) => {
    const kind = s.kind === 'bazar' ? 'BAZAR (použité, výkup od zákazníka)' : s.kind === 'provereno' ? 'PROVĚŘENO (předváděcí / půjčovní, jako nové)' : s.kind;
    return `- ${s.date || ''} | ${kind} | ${s.title}${s.size ? ` | vel. ${s.size}` : ''} | prodáno za ${Math.round(s.priceCzk).toLocaleString('cs-CZ').replace(/ /g, ' ')} Kč`;
  });
  return `\n\nSkutečné prodeje obchodu Koloshop (konečné ceny vč. DPH, 2026):\n${lines.join('\n')}`;
}

/** Celý stabilní system prompt jako blok s cache_control. */
function buildSystem(sales) {
  return [{ type: 'text', text: SYSTEM_INSTRUCTIONS + salesTable(sales), cache_control: { type: 'ephemeral' } }];
}

function fmtCzk(n) {
  return n == null ? '–' : `${Math.round(n).toLocaleString('cs-CZ').replace(/ /g, ' ')} Kč`;
}

function photoUrlOf(row) {
  let u = String(row.photo_url || '').trim();
  if (!u) return null;
  if (u.startsWith('//')) u = `https:${u}`;
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

/** Text zprávy uživatele s daty inzerátu. */
function buildUserText(row, { model } = {}) {
  const f = parseJson(row.features, {});
  const params = parseJson(row.params, {});
  const factors = parseJson(row.est_factors, []);
  const L = [];
  L.push(`Inzerát (zdroj: ${row.source || '?'}${row.category_src ? `, kategorie: ${row.category_src}` : ''})`);
  L.push(`Titulek: ${row.title}`);
  L.push(`Inzerovaná cena: ${row.price_czk != null ? fmtCzk(row.price_czk) : `neuvedena${row.price_note ? ` (${row.price_note})` : ''}`}`);
  if (row.location_text) L.push(`Lokalita: ${row.location_text}`);
  const pk = Object.entries(params || {});
  if (pk.length) L.push(`Parametry webu: ${pk.map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('; ')}`);
  L.push('Popis:');
  L.push(`"""${truncate(String(row.description || '(bez popisu)'), 3500)}"""`);
  const ex = [];
  if (f.brand) ex.push(`značka ${f.brand}${f.brandTier ? ` (cenová třída ${f.brandTier}/5)` : ''}`);
  if (f.model) ex.push(`model ${f.model}`);
  if (row.bike_type) ex.push(`typ ${row.bike_type}`);
  if (f.modelYear) ex.push(`rok ${f.modelYear} (stáří ${f.ageYears} let)`);
  else if (f.vintageYear) ex.push(`retro, rok ${f.vintageYear}`);
  if (f.wheelSize) ex.push(`kola ${f.wheelSize}"`);
  if (f.frameSize) ex.push(`rám ${f.frameSize}${f.frameSizeRaw && f.frameSizeRaw !== f.frameSize ? ` (${f.frameSizeRaw})` : ''}`);
  if (f.material) ex.push(`materiál ${f.material}`);
  if (f.suspension) ex.push(`odpružení ${f.suspension}`);
  if (f.groupset) ex.push(`sada ${f.groupset}`);
  if (f.isEbike) ex.push(`e-kolo${f.motor ? `, motor ${f.motor}` : ''}${f.batteryWh ? `, baterie ${f.batteryWh} Wh` : ''}`);
  if (f.condition) ex.push(`stav z textu ${f.condition}`);
  if (f.originalPriceCzk) ex.push(`původní cena ${fmtCzk(f.originalPriceCzk)}`);
  if (f.hasReceipt === true) ex.push('doklad o koupi ano');
  if (f.hasReceipt === false) ex.push('bez dokladu');
  if (f.warranty === true) ex.push('v záruce');
  if (f.isShop) ex.push('prodává obchod');
  if (f.isFrameOnly) ex.push('jen rám');
  if (f.isMulti) ex.push('více kol v inzerátu');
  L.push(`Vytěžené údaje: ${ex.length ? ex.join('; ') : '–'}`);
  if (f.warnings?.length) L.push(`Varování programu: ${f.warnings.join('; ')}`);
  if (row.est_czk) {
    L.push(`Odhad výpočetního modelu (skutečná prodejní cena): ${fmtCzk(row.est_czk)} (rozpětí ${fmtCzk(row.est_low)}–${fmtCzk(row.est_high)}, jistota ${row.est_confidence ?? '?'}, metoda ${row.est_method || '?'})`);
    if (factors.length) L.push(`Vysvětlení modelu:\n${factors.map((x) => `- ${x}`).join('\n')}`);
  }
  const comps = model ? pricing.comparables(model, row, 8) : [];
  if (comps.length) {
    L.push(`Srovnatelné inzeráty (inzerované ceny):\n${comps.map((c) => `- ${c.title} – ${fmtCzk(c.price)}${c.sold ? ' (zmizel – asi prodáno)' : ''}`).join('\n')}`);
  }
  L.push('Urči tržní hodnotu podle instrukcí a vrať JSON.');
  return L.join('\n');
}

/**
 * Sestaví parametry požadavku na Messages API.
 * @returns {object}
 */
function buildRequest(row, { config, sales, model, withImage = true } = {}) {
  const content = [];
  const photo = withImage ? photoUrlOf(row) : null;
  if (photo) content.push({ type: 'image', source: { type: 'url', url: photo } });
  content.push({ type: 'text', text: buildUserText(row, { model }) });
  return {
    model: config?.ai?.model || DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: buildSystem(sales),
    output_config: { effort: 'low', format: { type: 'json_schema', schema: RESPONSE_SCHEMA } },
    messages: [{ role: 'user', content }],
  };
}

/** Kontrola a úprava odpovědi modelu. Vrací null, když je nepoužitelná. */
function sanitize(out) {
  if (!out || typeof out !== 'object') return null;
  const isBike = out.is_bike !== false;
  const num = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);
  let est = num(out.estimate_czk);
  let low = num(out.low_czk);
  let high = num(out.high_czk);
  if (isBike) {
    if (!(est > 0) || est > 2000000) return null;
    if (!(low > 0) || low > est) low = Math.round(est * 0.85);
    if (!(high > 0) || high < est) high = Math.round(est * 1.15);
  } else {
    est = null;
    low = null;
    high = null;
  }
  const condition = CONDITIONS.includes(out.condition) ? out.condition : null;
  const photo = String(out.condition_from_photo || '').trim();
  let notes = String(out.notes || '').trim();
  if (!isBike) notes = `Podle AI nejde o kolo: ${notes}`;
  if (photo) notes = `${notes}${notes ? ' | ' : ''}Foto: ${photo}`;
  return { isBike, est, low, high, condition, notes: truncate(notes, 600), bikeType: BIKE_TYPES.includes(out.bike_type) ? out.bike_type : null };
}

/** Text odpovědi → objekt (po kontrole stop_reason). */
function parseResponse(resp) {
  if (!resp) return { error: 'prázdná odpověď' };
  if (resp.stop_reason === 'refusal') return { refused: true, category: resp.stop_details?.category ?? null };
  if (resp.stop_reason === 'max_tokens') return { error: 'odpověď byla useknuta (max_tokens)' };
  const text = (resp.content || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) return { error: 'odpověď neobsahuje text' };
  try {
    return { data: JSON.parse(text) };
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return { data: JSON.parse(m[0]) };
      } catch {
        // spadne níž
      }
    }
    return { error: 'odpověď není platný JSON' };
  }
}

/** Druh chyby API → rozhodnutí (typové třídy SDK; u podstrčeného klienta podle HTTP stavu). */
function errorKind(e, sdk) {
  if (e && (e.name === 'AbortError' || e.name === 'APIUserAbortError')) return 'abort';
  if (sdk) {
    if (sdk.AuthenticationError && e instanceof sdk.AuthenticationError) return 'auth';
    if (sdk.PermissionDeniedError && e instanceof sdk.PermissionDeniedError) return 'auth';
    if (sdk.RateLimitError && e instanceof sdk.RateLimitError) return 'rate';
    if (sdk.BadRequestError && e instanceof sdk.BadRequestError) return 'bad_request';
    if (sdk.NotFoundError && e instanceof sdk.NotFoundError) return 'bad_request';
    if (sdk.APIConnectionError && e instanceof sdk.APIConnectionError) return 'transient';
    if (sdk.InternalServerError && e instanceof sdk.InternalServerError) return 'transient';
    if (sdk.APIError && e instanceof sdk.APIError) return e.status === 529 || e.status >= 500 ? 'transient' : 'bad_request';
  }
  const st = e?.status;
  if (st === 401 || st === 403) return 'auth';
  if (st === 429) return 'rate';
  if (st === 400 || st === 404 || st === 413 || st === 422) return 'bad_request';
  return 'transient';
}

function contentHashOf(row) {
  if (row.content_hash) return row.content_hash;
  return hash([row.title, row.price_czk, row.description, JSON.stringify(parseJson(row.params, {}) || {})].join('\u0001'));
}

/**
 * Vybere inzeráty k AI nacenění: aktivní kola s fotkou a cenou ≥ minPrice, jejichž obsah se od posledního AI
 * nacenění změnil; nejdřív potenciálně výhodné (nízký deal_ratio) a čerstvé.
 */
function selectPending(db, { config, now = Date.now() } = {}) {
  const minPrice = config?.ai?.minPrice ?? 5000;
  const limit = config?.ai?.maxPerRun ?? 150;
  const rows = db
    .prepare(
      `SELECT * FROM listings
       WHERE gone_at IS NULL AND is_bike = 1 AND photo_url IS NOT NULL AND photo_url <> ''
         AND price_czk IS NOT NULL AND price_czk >= ?
         AND (ai_input_hash IS NULL OR content_hash IS NULL OR ai_input_hash <> content_hash)
       LIMIT 20000`
    )
    .all(minPrice);
  const prio = (r) => {
    const deal = r.deal_ratio ?? 1.2;
    const t = Date.parse(r.posted_at || r.first_seen_at || '') || 0;
    const days = t ? (now - t) / 86400000 : 30;
    const fresh = days <= 2 ? 0.15 : days <= 7 ? 0.08 : days <= 30 ? 0.03 : 0;
    const conf = r.est_confidence ?? 0.3;
    return deal - fresh - 0.05 * conf;
  };
  return rows
    .map((r) => [prio(r), r])
    .sort((a, b) => a[0] - b[0] || b[1].id - a[1].id)
    .slice(0, Math.max(0, limit))
    .map((x) => x[1]);
}

/**
 * AI nacenění inzerátů, které ho potřebují. Ukládá ai_* (+ ai_model, ai_at, ai_input_hash) a přepočítá deal_ratio
 * a max_buy_czk vůči AI odhadu.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{config: object, log?: object, signal?: AbortSignal, model?: object, client?: object, sdk?: object, sales?: object[]}} o
 * @returns {Promise<number>} počet uložených AI nacenění
 */
async function valuatePending(db, { config, log, signal, model, client, sdk, sales } = {}) {
  if (!config?.ai?.enabled && !client) return 0;
  let api = client;
  let SDK = sdk || null;
  if (!api) {
    SDK = loadSdk();
    api = new SDK({ apiKey: config.ai.apiKey, maxRetries: 3, timeout: 180000 });
  }
  const shopSales = sales || pricing.loadSales(db);
  const todo = selectPending(db, { config });
  if (!todo.length) return 0;
  log?.info?.(`AI nacenění: ${todo.length} inzerátů`, { model: config?.ai?.model || DEFAULT_MODEL });
  const buyRatio = model?.buyRatio ?? pricing.buyRatioFrom(shopSales, config);
  const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, requests: 0 };
  const stats = { saved: 0, refused: 0, errors: 0, skipped: 0 };
  const upd = db.prepare(
    'UPDATE listings SET ai_czk = ?, ai_low = ?, ai_high = ?, ai_condition = ?, ai_notes = ?, ai_model = ?, ai_at = ?, ai_input_hash = ? WHERE id = ?'
  );
  let stop = null;
  let stopKind = null;
  let consecutiveErrors = 0;
  let next = 0;

  const call = async (params) => {
    usage.requests++;
    const resp = await api.beta.messages.create(params, signal ? { signal } : undefined);
    const u = resp?.usage || {};
    usage.input += u.input_tokens || 0;
    usage.output += u.output_tokens || 0;
    usage.cacheWrite += u.cache_creation_input_tokens || 0;
    usage.cacheRead += u.cache_read_input_tokens || 0;
    return resp;
  };

  const one = async (row) => {
    const hashNow = contentHashOf(row);
    let params = buildRequest(row, { config, sales: shopSales, model });
    let resp;
    try {
      resp = await call(params);
    } catch (e) {
      const kind = errorKind(e, SDK);
      if (kind === 'bad_request' && params.messages[0].content.some((b) => b.type === 'image')) {
        // nejčastěji nedostupná fotka → zkusit bez ní
        params = buildRequest(row, { config, sales: shopSales, model, withImage: false });
        resp = await call(params);
      } else throw e;
    }
    const parsed = parseResponse(resp);
    if (parsed.refused) {
      stats.refused++;
      // stejné zadání by bylo odmítnuto znovu → poznamenat a nezkoušet, dokud se inzerát nezmění
      upd.run(null, null, null, null, `AI nacenění odmítnuto${parsed.category ? ` (${parsed.category})` : ''}`, resp.model || params.model, nowIso(), hashNow, row.id);
      return;
    }
    if (parsed.error) {
      stats.errors++;
      log?.warn?.('AI nacenění: nepoužitelná odpověď', { id: row.id, error: parsed.error });
      return;
    }
    const v = sanitize(parsed.data);
    if (!v) {
      stats.errors++;
      log?.warn?.('AI nacenění: nesmyslné hodnoty', { id: row.id });
      return;
    }
    upd.run(v.est, v.low, v.high, v.condition, v.notes, resp.model || params.model, nowIso(), hashNow, row.id);
    // výhodnost a výkupní cena vůči AI odhadu (aktuální = ai_input_hash odpovídá content_hash)
    if (row.content_hash === hashNow) pricing.refreshDeal(db, row.id, { buyRatio, config });
    stats.saved++;
  };

  const worker = async () => {
    while (!stop && !signal?.aborted) {
      const i = next++;
      if (i >= todo.length) return;
      try {
        await one(todo[i]);
        consecutiveErrors = 0;
      } catch (e) {
        const kind = errorKind(e, SDK);
        if (kind === 'abort' || signal?.aborted) return;
        if (kind === 'auth') {
          stopKind = kind;
          stop = new Error('AI nacenění: neplatný nebo nepovolený ANTHROPIC_API_KEY');
          return;
        }
        if (kind === 'rate') {
          stopKind = kind;
          stop = new Error('AI nacenění: překročen limit API (rate limit) – zbytek se nacení příště');
          return;
        }
        stats.errors++;
        consecutiveErrors++;
        log?.warn?.('AI nacenění selhalo', { id: todo[i].id, error: e.message });
        if (consecutiveErrors >= 5) {
          stopKind = 'errors';
          stop = new Error(`AI nacenění: ${consecutiveErrors} chyb po sobě, končím (${e.message})`);
          return;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, worker));
  log?.info?.('AI nacenění: hotovo', { ...stats, tokens: usage });
  if (stop) {
    if (stopKind === 'auth' && stats.saved === 0) throw stop;
    log?.warn?.(stop.message);
  }
  return stats.saved;
}

module.exports = {
  valuatePending,
  selectPending,
  buildRequest,
  buildSystem,
  buildUserText,
  parseResponse,
  sanitize,
  errorKind,
  loadSdk,
  RESPONSE_SCHEMA,
  SYSTEM_INSTRUCTIONS,
  DEFAULT_MODEL,
  FALLBACK_BETA,
};
