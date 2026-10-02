'use strict';
// AI nacenění s podstrčeným klientem (skutečné API se nevolá): tvar požadavku, cache, odmítnutí, výběr a limity,
// přeskočení nezměněných inzerátů, přepočet výhodnosti vůči AI odhadu.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, parseJson } = require('../src/db');
const ai = require('../src/pricing/ai');

const SALES = [
  { kind: 'bazar', date: '2026-02-12', title: 'Cannondale Habit HT 2 horské kolo', size: 'L', priceCzk: 19500, costCzk: 13000 },
  { kind: 'bazar', date: '2026-06-16', title: 'Woom 3 Red 16 dětské kolo', priceCzk: 7000, costCzk: 4000 },
  { kind: 'provereno', date: '2026-02-12', title: 'Haibike Nduro 7 celoodpružené elektrokolo', size: 'L', priceCzk: 69990, costCzk: 88020 },
];
const CONFIG = { ai: { enabled: true, apiKey: 'test', model: 'claude-opus-5-5', maxPerRun: 3, minPrice: 5000 }, buyMargin: null };

function seed(db) {
  const ins = db.prepare(
    `INSERT INTO listings (id, source, source_id, url, title, description, price_czk, is_bike, bike_type, features, photo_url, content_hash, deal_ratio,
       est_czk, est_low, est_high, est_confidence, est_method, est_factors, first_seen_at, last_seen_at, gone_at, ai_input_hash, params, posted_at)
     VALUES (?, 'bazos', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model', ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', ?, ?, ?, ?)`
  );
  const f = JSON.stringify({ brand: 'Trek', brandTier: 4, model: 'Slash 8', modelYear: 2022, ageYears: 4 });
  const factors = JSON.stringify(['Trek Slash 8 – celoodpružené horské kolo', 'Podobné inzeráty (5×): medián 48 000 Kč']);
  const rows = [
    // id, title, price, isBike, photo, hash, deal, gone, aiHash
    [1, 'Trek Slash 8 2022', 30000, 1, 'https://img.example.cz/1.jpg', 'h1', 0.6, null, null],
    [2, 'Trek Slash 8 2021', 45000, 1, '//img.example.cz/2.jpg', 'h2', 0.95, null, null],
    [3, 'Trek Slash 8 2020', 40000, 1, 'https://img.example.cz/3.jpg', 'h3', 0.8, null, null],
    [4, 'Trek Slash 8 2019', 60000, 1, 'https://img.example.cz/4.jpg', 'h4', 1.3, null, null],
    [5, 'Trek Slash 8 bez fotky', 30000, 1, null, 'h5', 0.5, null, null],
    [6, 'Trek Slash 8 levný', 3000, 1, 'https://img.example.cz/6.jpg', 'h6', 0.1, null, null],
    [7, 'Helma Trek', 9000, 0, 'https://img.example.cz/7.jpg', 'h7', null, null, null],
    [8, 'Trek Slash 8 prodáno', 30000, 1, 'https://img.example.cz/8.jpg', 'h8', 0.4, '2026-10-02T00:00:00Z', null],
    [9, 'Trek Slash 8 už naceněný', 30000, 1, 'https://img.example.cz/9.jpg', 'h9', 0.3, null, 'h9'],
  ];
  for (const [id, title, price, bike, photo, hash, deal, gone, aiHash] of rows) {
    ins.run(id, String(id), `https://www.bazos.cz/inzerat/${id}/`, title, 'Prodám kolo Trek Slash 8, velmi dobrý stav, doklad.', price, bike, bike ? 'mtb_full' : null, f, photo, hash, deal, 50000, 42000, 58000, 0.55, factors, gone, aiHash, JSON.stringify({ 'Velikost rámu': 'L' }), '2026-09-30T00:00:00Z');
  }
}

function mockClient(responder) {
  const calls = [];
  return {
    calls,
    beta: {
      messages: {
        create: async (params, opts) => {
          calls.push({ params, opts });
          return responder(params, calls.length);
        },
      },
    },
  };
}

const answer = (o = {}) => ({
  estimate_czk: 48000,
  low_czk: 42000,
  high_czk: 54000,
  condition: 'very_good',
  condition_from_photo: 'Kolo čisté, drobné oděrky na rámu.',
  notes: 'Populární enduro, hodnotu drží; cena odpovídá stavu.',
  is_bike: true,
  bike_type: 'mtb_full',
  ...o,
});
const okResp = (obj = answer(), extra = {}) => ({
  id: 'msg_test',
  model: 'claude-opus-5-5',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(obj) }],
  usage: { input_tokens: 120, output_tokens: 80, cache_creation_input_tokens: 0, cache_read_input_tokens: 2500 },
  ...extra,
});
const quietLog = () => {
  const entries = [];
  const rec = (level) => (msg, meta) => entries.push({ level, msg, meta });
  return { entries, info: rec('info'), warn: rec('warn'), debug: rec('debug'), error: rec('error') };
};

test('požadavek: model, fallback beta, JSON schéma, effort low, bez thinking, cache v system, fotka jako URL', () => {
  const db = openDb(':memory:');
  seed(db);
  const row = db.prepare('SELECT * FROM listings WHERE id = 2').get();
  const p = ai.buildRequest(row, { config: CONFIG, sales: SALES });
  assert.equal(p.model, 'claude-opus-5-5');
  assert.deepEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p.fallbacks, 'default');
  assert.equal(p.thinking, undefined);
  assert.equal(p.output_config.effort, 'low');
  assert.equal(p.output_config.format.type, 'json_schema');
  const schema = p.output_config.format.schema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required.slice().sort(), ['bike_type', 'condition', 'condition_from_photo', 'estimate_czk', 'high_czk', 'is_bike', 'low_czk', 'notes'].sort());
  assert.ok(schema.properties.bike_type.enum.includes('ebike_mtb_full'));
  assert.deepEqual(schema.properties.condition.enum, ['new', 'like_new', 'very_good', 'good', 'fair', 'poor', 'parts']);
  assert.equal(p.system.length, 1);
  assert.deepEqual(p.system[0].cache_control, { type: 'ephemeral' });
  assert.match(p.system[0].text, /Woom 3 Red 16 dětské kolo/);
  assert.match(p.system[0].text, /prodáno za 19 500 Kč/);
  const content = p.messages[0].content;
  assert.deepEqual(content[0], { type: 'image', source: { type: 'url', url: 'https://img.example.cz/2.jpg' } });
  const text = content[1].text;
  assert.match(text, /Titulek: Trek Slash 8 2021/);
  assert.match(text, /Inzerovaná cena: 45 000 Kč/);
  assert.match(text, /Velikost rámu: L/);
  assert.match(text, /Odhad výpočetního modelu .*50 000 Kč/);
  assert.match(text, /Podobné inzeráty \(5×\)/);
  // system prompt je pro všechny inzeráty stejný (stabilní cache), liší se jen zpráva
  const p2 = ai.buildRequest(db.prepare('SELECT * FROM listings WHERE id = 3').get(), { config: CONFIG, sales: SALES });
  assert.equal(p2.system[0].text, p.system[0].text);
  assert.notEqual(p2.messages[0].content[1].text, text);
  // výchozí model
  assert.equal(ai.buildRequest(row, { config: { ai: {} } }).model, 'claude-opus-5-5');
});

test('výběr: aktivní kola s fotkou, cena ≥ minPrice, změněný obsah; nejdřív výhodné; limit maxPerRun', () => {
  const db = openDb(':memory:');
  seed(db);
  const ids = ai.selectPending(db, { config: CONFIG }).map((r) => r.id);
  assert.deepEqual(ids, [1, 3, 2]); // podle deal_ratio; 4 se nevejde do limitu 3
  const all = ai.selectPending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 50 } } }).map((r) => r.id);
  assert.deepEqual(all, [1, 3, 2, 4]); // bez fotky, levný, nekolo, zmizelý a už naceněný chybí
});

test('valuatePending uloží ai_*, přepočte výhodnost a podruhé nezměněné inzeráty přeskočí', async () => {
  const db = openDb(':memory:');
  seed(db);
  const client = mockClient(() => okResp());
  const log = quietLog();
  const n = await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log, model: { buyRatio: 0.65 } });
  assert.equal(n, 3);
  assert.equal(client.calls.length, 3);
  const r = db.prepare('SELECT * FROM listings WHERE id = 1').get();
  assert.equal(r.ai_czk, 48000);
  assert.equal(r.ai_low, 42000);
  assert.equal(r.ai_high, 54000);
  assert.equal(r.ai_condition, 'very_good');
  assert.match(r.ai_notes, /Populární enduro/);
  assert.match(r.ai_notes, /Foto: Kolo čisté/);
  assert.equal(r.ai_model, 'claude-opus-5-5');
  assert.ok(r.ai_at);
  assert.equal(r.ai_input_hash, 'h1');
  assert.equal(r.est_czk, 50000); // odhad modelu zůstává
  assert.ok(Math.abs(r.deal_ratio - 30000 / 48000) < 0.002); // výhodnost vůči AI
  assert.equal(r.max_buy_czk, 31000);
  // spotřeba tokenů v logu
  const done = log.entries.find((e) => e.msg === 'AI nacenění: hotovo');
  assert.deepEqual(done.meta.tokens, { input: 360, output: 240, cacheWrite: 0, cacheRead: 7500, requests: 3 });
  // druhý běh: zbývá jen id 4
  const n2 = await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log });
  assert.equal(n2, 1);
  assert.equal(client.calls.at(-1).params.messages[0].content[1].text.includes('Trek Slash 8 2019'), true);
  // třetí běh: nic
  assert.equal(await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log }), 0);
  // změna obsahu (nový content_hash) → znovu
  db.prepare("UPDATE listings SET content_hash = 'h1b', price_czk = 28000 WHERE id = 1").run();
  assert.equal(await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log }), 1);
});

test('odmítnutí a useknutá odpověď', async () => {
  const db = openDb(':memory:');
  seed(db);
  const client = mockClient((params, i) =>
    i === 1
      ? { model: 'claude-opus-5-5', stop_reason: 'refusal', stop_details: { type: 'refusal', category: null }, content: [], usage: { input_tokens: 10, output_tokens: 0 } }
      : i === 2
        ? okResp(answer(), { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"estimate_czk": 4' }] })
        : okResp()
  );
  const n = await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log: quietLog() });
  assert.equal(n, 1);
  const refused = db.prepare('SELECT ai_czk, ai_notes, ai_input_hash FROM listings WHERE id = 1').get();
  assert.equal(refused.ai_czk, null);
  assert.match(refused.ai_notes, /odmítnuto/);
  assert.equal(refused.ai_input_hash, 'h1'); // nezkoušet znovu, dokud se inzerát nezmění
  const cut = db.prepare('SELECT ai_czk, ai_input_hash FROM listings WHERE id = 3').get();
  assert.deepEqual([cut.ai_czk, cut.ai_input_hash], [null, null]); // zkusí se příště
  assert.deepEqual(ai.parseResponse({ stop_reason: 'refusal', content: [] }), { refused: true, category: null });
  assert.ok(ai.parseResponse({ stop_reason: 'max_tokens', content: [] }).error);
});

test('nepoužitelná fotka (400) → zopakovat bez obrázku; nekolo podle AI', async () => {
  const db = openDb(':memory:');
  seed(db);
  const client = mockClient((params) => {
    if (params.messages[0].content.some((b) => b.type === 'image')) throw Object.assign(new Error('Could not process image'), { status: 400 });
    return okResp(answer({ is_bike: false, estimate_czk: 0, low_czk: 0, high_czk: 0, notes: 'Na fotce je jen rám s vidlicí.' }));
  });
  const n = await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 1 } }, client, sales: SALES, log: quietLog() });
  assert.equal(n, 1);
  assert.equal(client.calls.length, 2);
  const r = db.prepare('SELECT ai_czk, ai_notes FROM listings WHERE id = 1').get();
  assert.equal(r.ai_czk, null);
  assert.match(r.ai_notes, /^Podle AI nejde o kolo/);
});

test('chyby API: neplatný klíč → výjimka, rate limit → konec běhu bez pádu (typové třídy SDK)', async () => {
  class APIError extends Error {}
  class AuthenticationError extends APIError {}
  class RateLimitError extends APIError {}
  const sdk = { APIError, AuthenticationError, RateLimitError };
  const db = openDb(':memory:');
  seed(db);
  const authClient = mockClient(() => {
    throw new AuthenticationError('invalid x-api-key');
  });
  await assert.rejects(ai.valuatePending(db, { config: CONFIG, client: authClient, sdk, sales: SALES, log: quietLog() }), /ANTHROPIC_API_KEY/);
  let calls = 0;
  const rateClient = mockClient(() => {
    calls++;
    if (calls === 1) return okResp();
    throw new RateLimitError('rate limited');
  });
  const log = quietLog();
  const n = await ai.valuatePending(db, { config: CONFIG, client: rateClient, sdk, sales: SALES, log });
  assert.equal(n, 1);
  assert.ok(log.entries.some((e) => e.level === 'warn' && /rate limit/.test(e.msg)));
  assert.equal(ai.errorKind(Object.assign(new Error('x'), { status: 529 }), null), 'transient');
  assert.equal(ai.errorKind(Object.assign(new Error('x'), { status: 429 }), null), 'rate');
});

test('vypnuté AI nic nedělá; chybějící SDK → srozumitelná česká chyba', async () => {
  const db = openDb(':memory:');
  seed(db);
  assert.equal(await ai.valuatePending(db, { config: { ai: { enabled: false } } }), 0);
  let installed = true;
  try {
    require.resolve('@anthropic-ai/sdk');
  } catch {
    installed = false;
  }
  if (!installed) {
    assert.throws(() => ai.loadSdk(), { message: 'Pro AI nacenění spusťte v adresáři kolomapa: npm install @anthropic-ai/sdk' });
    await assert.rejects(ai.valuatePending(db, { config: CONFIG, sales: SALES }), /npm install @anthropic-ai\/sdk/);
  }
});

test('kontrola hodnot z AI', () => {
  assert.equal(ai.sanitize(answer({ estimate_czk: 0 })), null);
  const v = ai.sanitize(answer({ low_czk: 60000, high_czk: 10 }));
  assert.equal(v.low, Math.round(48000 * 0.85));
  assert.equal(v.high, Math.round(48000 * 1.15));
  assert.equal(ai.sanitize(answer({ condition: 'skvělý' })).condition, null);
  assert.ok(ai.sanitize(answer({ notes: 'x'.repeat(2000) })).notes.length <= 601);
  const parsed = ai.parseResponse(okResp(answer(), { content: [{ type: 'fallback', from: { model: 'a' }, to: { model: 'b' } }, { type: 'text', text: JSON.stringify(answer()) }] }));
  assert.equal(parsed.data.estimate_czk, 48000);
  assert.equal(parseJson(JSON.stringify(ai.RESPONSE_SCHEMA)).type, 'object');
});
