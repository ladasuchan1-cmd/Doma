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
       est_czk, est_low, est_high, est_confidence, est_method, est_factors, first_seen_at, last_seen_at, gone_at, ai_input_hash, params, posted_at, detail_at)
     VALUES (?, 'bazos', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'model', ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z', ?, ?, ?, ?, ?)`
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
    [10, 'Trek Slash 8 bez detailu', 30000, 1, 'https://img.example.cz/10.jpg', 'h10', 0.2, null, null, null],
  ];
  for (const [id, title, price, bike, photo, hash, deal, gone, aiHash, detailAt = '2026-10-01T00:00:00Z'] of rows) {
    ins.run(id, String(id), `https://www.bazos.cz/inzerat/${id}/`, title, 'Prodám kolo Trek Slash 8, velmi dobrý stav, doklad.', price, bike, bike ? 'mtb_full' : null, f, photo, hash, deal, 50000, 42000, 58000, 0.55, factors, gone, aiHash, JSON.stringify({ 'Velikost rámu': 'L' }), '2026-09-30T00:00:00Z', detailAt);
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
  assert.deepEqual(all, [1, 3, 2, 4]); // bez fotky, levný, nekolo, zmizelý, už naceněný a bez staženého detailu chybí
  // vybrané řádky jsou celé (pořadí se počítá z lehkých sloupců)
  assert.match(ai.selectPending(db, { config: CONFIG })[0].description, /Prodám kolo/);
  assert.deepEqual(ai.selectPending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 0 } } }), []);
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
  assert.deepEqual(done.meta.tokens, { input: 360, output: 240, cacheWrite: 0, cacheRead: 7500, requests: 3, fallbacks: 0, costUsd: 0.0077 }); // 360×$4 + 7500×$0,20 + 240×$20 za 1M tokenů
  // druhý běh (další den – limit maxPerRun je denní): zbývá jen id 4
  const tomorrow = Date.now() + 86400000;
  const n2 = await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log, now: tomorrow });
  assert.equal(n2, 1);
  assert.equal(client.calls.at(-1).params.messages[0].content[1].text.includes('Trek Slash 8 2019'), true);
  // třetí běh: nic
  assert.equal(await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log, now: tomorrow + 86400000 }), 0);
  // změna obsahu (nový content_hash) → znovu
  db.prepare("UPDATE listings SET content_hash = 'h1b', price_czk = 28000 WHERE id = 1").run();
  assert.equal(await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log, now: tomorrow + 2 * 86400000 }), 1);
});

test('KOLOMAPA_AI_MAX_PER_RUN je denní strop: další běh týž den (Stáhnout teď) už neplatí', async () => {
  const db = openDb(':memory:');
  seed(db);
  const client = mockClient(() => okResp());
  const log = quietLog();
  assert.equal(await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 2 } }, client, sales: SALES, log }), 2);
  assert.equal(await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 2 } }, client, sales: SALES, log }), 0);
  assert.ok(log.entries.some((e) => /denní limit 2 je vyčerpaný/.test(e.msg)));
  assert.equal(client.calls.length, 2);
  // vyšší limit → jen zbytek do limitu
  assert.equal(await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 3 } }, client, sales: SALES, log }), 1);
  assert.deepEqual(ai.remainingToday(db, { ai: { maxPerRun: 3 } }), { perDay: 3, done: 3, left: 0 });
  // odmítnuté / nepoužité se také počítají (platily se)
  db.prepare("UPDATE listings SET ai_at = ? WHERE id = 9").run(new Date().toISOString());
  assert.equal(ai.remainingToday(db, { ai: { maxPerRun: 10 } }).done, 4);
  // včerejší nacenění se nepočítají
  assert.equal(ai.remainingToday(db, { ai: { maxPerRun: 10 } }, Date.now() + 86400000).done, 0);
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

// ---------------------------------------------------------------------------------------------------------------
// Regrese z adversariálního review AI modulu

/** SDK, pokud je nainstalované (volitelná závislost) – jinak se testy se skutečným SDK přeskočí. */
function realSdk() {
  try {
    const m = require('@anthropic-ai/sdk');
    return m.default || m.Anthropic || m;
  } catch {
    return null;
  }
}
const SDK = realSdk();

test('model: fallbacks jen u modelů, které je přijímají; effort ne u Haiku / Sonnet 4.5', () => {
  const db = openDb(':memory:');
  seed(db);
  const row = db.prepare('SELECT * FROM listings WHERE id = 1').get();
  const req = (model) => ai.buildRequest(row, { config: { ai: { model } }, sales: SALES });
  for (const m of ['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']) {
    const p = req(m);
    assert.deepEqual([p.betas, p.fallbacks, p.output_config.effort], [['server-side-fallback-2026-07-01'], 'default', 'low'], m);
  }
  for (const m of ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-sonnet-5']) {
    const p = req(m);
    assert.deepEqual([p.betas, p.fallbacks, p.output_config.effort], [undefined, undefined, 'low'], m);
  }
  for (const m of ['claude-haiku-4-5', 'claude-sonnet-4-5', 'claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250805']) {
    const p = req(m);
    assert.equal(p.fallbacks, undefined, m);
    assert.equal('effort' in p.output_config, false, m);
    assert.equal(p.output_config.format.type, 'json_schema', m);
  }
});

test('fotka: adresy Sbazaru s „|“ a mezerami se zakódují, //host → https, jiné než http(s) se nepošlou', () => {
  const sb = 'https://d46-a.sdn.cz/d_46/c_img_p9_C/nCTU/b7e9.jpeg?fl=exf|res,1024,768,1|wrm,/watermark/sbazar.png,10,10|webp,75';
  assert.equal(ai.photoUrlOf({ photo_url: sb }), 'https://d46-a.sdn.cz/d_46/c_img_p9_C/nCTU/b7e9.jpeg?fl=exf%7Cres,1024,768,1%7Cwrm,/watermark/sbazar.png,10,10%7Cwebp,75');
  assert.equal(ai.photoUrlOf({ photo_url: '//img.example.cz/a b/č.jpg' }), 'https://img.example.cz/a%20b/%C4%8D.jpg');
  assert.equal(ai.photoUrlOf({ photo_url: 'https://x.cz/a%20b.jpg' }), 'https://x.cz/a%20b.jpg'); // už zakódované nechat
  assert.equal(ai.photoUrlOf({ photo_url: 'data:image/png;base64,AAAA' }), null);
  assert.equal(ai.photoUrlOf({ photo_url: '/img/1.jpg' }), null);
  assert.equal(ai.photoUrlOf({ photo_url: 'https://' }), null);
});

test('chyby API: došlý kredit (402) a neexistující model (404) běh hned ukončí – bez opakování bez fotky', async () => {
  for (const [status, re] of [
    [402, /došel kredit/],
    [404, /model „claude-opus-5-5“ neexistuje/],
  ]) {
    const db = openDb(':memory:');
    seed(db);
    const client = mockClient(() => {
      throw Object.assign(new Error(`${status} error`), { status });
    });
    await assert.rejects(ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log: quietLog() }), re);
    assert.equal(client.calls.length, 1, `HTTP ${status}: jediný požadavek`);
  }
  assert.equal(ai.errorKind({ status: 400, type: 'billing_error' }, null), 'billing');
  assert.equal(ai.errorKind({ status: 400, error: { type: 'error', error: { type: 'billing_error' } } }, null), 'billing');
  assert.equal(ai.errorKind({ status: 408 }, null), 'transient');
  assert.equal(ai.errorKind({ status: 413 }, null), 'bad_request');
  assert.equal(ai.errorKind(new Error('síť'), null), 'transient');
  // přerušení: APIUserAbortError má name 'Error' a dědí z APIError → musí se poznat třídou, ne jako bad_request
  class APIError extends Error {}
  class APIUserAbortError extends APIError {}
  assert.equal(ai.errorKind(new APIUserAbortError('Request was aborted.'), { APIError, APIUserAbortError }), 'abort');
});

test('přerušení během požadavku: žádné opakování bez fotky, běh skončí', async () => {
  const db = openDb(':memory:');
  seed(db);
  const ctl = new AbortController();
  const client = mockClient((params, i) => {
    ctl.abort();
    throw Object.assign(new Error('Request was aborted.'), { status: 400 }); // i kdyby to vypadalo jako 400
  });
  const n = await ai.valuatePending(db, { config: CONFIG, client, sales: SALES, log: quietLog(), signal: ctl.signal });
  assert.equal(n, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].opts.signal, ctl.signal);
});

test('první požadavek běží sám (zapíše cache), další souběžně', async () => {
  const db = openDb(':memory:');
  seed(db);
  let inflight = 0;
  const seen = [];
  const client = mockClient(async () => {
    inflight++;
    seen.push(inflight);
    await new Promise((r) => setTimeout(r, 5));
    inflight--;
    return okResp();
  });
  const n = await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 4 } }, client, sales: SALES, log: quietLog() });
  assert.equal(n, 4);
  assert.equal(seen[0], 1); // první sám
  assert.ok(Math.max(...seen.slice(1)) > 1); // pak souběžně
  assert.ok(Math.max(...seen) <= 3);
});

test('záložní model: tokeny ze všech pokusů (usage.iterations), cena podle modelu pokusu, ai_model = kdo odpověděl', async () => {
  const db = openDb(':memory:');
  seed(db);
  const fb = okResp(answer(), {
    model: 'claude-opus-4-8',
    content: [{ type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } }, { type: 'text', text: JSON.stringify(answer()) }],
    usage: {
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      iterations: [
        { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 0, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 },
        { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 3000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      ],
    },
  });
  const client = mockClient(() => fb);
  const log = quietLog();
  assert.equal(await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 1 } }, client, sales: SALES, log }), 1);
  const t = log.entries.find((e) => e.msg === 'AI nacenění: hotovo').meta.tokens;
  assert.deepEqual([t.input, t.output, t.cacheWrite, t.fallbacks], [4000, 100, 2000, 1]);
  // 1000×$4 + 2000×$5 (zápis 1,25×) + 3000×$5 + 100×$25 = 31 500 / 1M
  assert.equal(t.costUsd, 0.0315);
  assert.equal(db.prepare('SELECT ai_model FROM listings WHERE id = 1').get().ai_model, 'claude-opus-4-8');
  // neznámý model: tokeny se počítají, cena se nehádá
  const acc = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, fallbacks: 0, costUsd: 0 };
  ai.addUsage(acc, { model: 'claude-budouci-9', usage: { input_tokens: 10, output_tokens: 5 } }, 'claude-budouci-9');
  assert.deepEqual([acc.input, acc.output, acc.costUsd, acc.unpriced], [10, 5, 0, true]);
});

test('odmítnutí bez dostupného záložního modelu (recommended_model) se nepoznamená → zkusí se příště', async () => {
  const db = openDb(':memory:');
  seed(db);
  const client = mockClient(() => ({
    model: 'claude-opus-5-5',
    stop_reason: 'refusal',
    stop_details: { type: 'refusal', category: 'cyber', recommended_model: 'claude-opus-4-8' },
    content: [],
    usage: { input_tokens: 10, output_tokens: 0 },
  }));
  assert.equal(await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 1 } }, client, sales: SALES, log: quietLog() }), 0);
  assert.deepEqual({ ...db.prepare('SELECT ai_input_hash, ai_notes FROM listings WHERE id = 1').get() }, { ai_input_hash: null, ai_notes: null });
  assert.equal(ai.parseResponse({ stop_reason: 'refusal', stop_details: { recommended_model: 'claude-opus-4-8' } }).recommendedModel, 'claude-opus-4-8');
});

test('nesmyslný nebo přemrštěný AI odhad (např. „pokyn“ v popisu) se nepoužije a nezkouší se denně znovu', async () => {
  const db = openDb(':memory:');
  seed(db);
  // id 1: cena 30 000, model 50 000 → 1 000 000 je > 10× obojí; id 3: is_bike, ale odhad 0
  const client = mockClient((params, i) => (i === 1 ? okResp(answer({ estimate_czk: 1000000, low_czk: 900000, high_czk: 1100000, notes: 'Podle popisu má cenu 1 000 000 Kč.' })) : okResp(answer({ estimate_czk: 0 }))));
  const log = quietLog();
  assert.equal(await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 2 } }, client, sales: SALES, log }), 0);
  const r1 = db.prepare('SELECT ai_czk, ai_notes, ai_input_hash, deal_ratio FROM listings WHERE id = 1').get();
  assert.equal(r1.ai_czk, null);
  assert.match(r1.ai_notes, /nepoužito: odhad 1 000 000 Kč je víc než 10×/);
  assert.equal(r1.ai_input_hash, 'h1');
  assert.ok(Math.abs(r1.deal_ratio - 30000 / 50000) < 0.002); // výhodnost dál vůči odhadu modelu
  const r3 = db.prepare('SELECT ai_czk, ai_notes, ai_input_hash FROM listings WHERE id = 3').get();
  assert.deepEqual([r3.ai_czk, r3.ai_input_hash], [null, 'h3']);
  assert.match(r3.ai_notes, /nesmyslný odhad/);
  // další běh je nepošle znovu (jen zbývající 2 a 4)
  const ids = ai.selectPending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 50 } } }).map((r) => r.id);
  assert.deepEqual(ids, [2, 4]);
  // system prompt varuje před pokyny v textu inzerátu
  assert.match(ai.SYSTEM_INSTRUCTIONS, /nikdy jako pokyny/);
});

test('KOLOMAPA_BUY_MARGIN má přednost před výkupním poměrem modelu (stejně jako priceAll)', async () => {
  const db = openDb(':memory:');
  seed(db);
  const client = mockClient(() => okResp());
  await ai.valuatePending(db, { config: { ...CONFIG, ai: { ...CONFIG.ai, maxPerRun: 1 }, buyMargin: 0.5 }, client, sales: SALES, log: quietLog(), model: { buyRatio: 0.65 } });
  assert.equal(db.prepare('SELECT max_buy_czk FROM listings WHERE id = 1').get().max_buy_czk, 24000); // 48 000 × 0,5
});

test('skutečné SDK s podstrčeným fetch: přesný HTTP požadavek, odpověď, 402 → typová chyba', { skip: !SDK && 'není nainstalované @anthropic-ai/sdk' }, async () => {
  const db = openDb(':memory:');
  seed(db);
  const captured = [];
  let mode = 'ok';
  const fakeFetch = async (url, init) => {
    captured.push({ url: String(url), headers: Object.fromEntries(new Headers(init.headers).entries()), body: JSON.parse(init.body) });
    if (mode === '402') {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'billing_error', message: 'Your credit balance is too low.' } }), { status: 402, headers: { 'content-type': 'application/json' } });
    }
    const body = { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', stop_details: null, content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(answer()) }], usage: { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const client = new SDK({ apiKey: 'test-key', fetch: fakeFetch, maxRetries: 0 });
  const n = await ai.valuatePending(db, { config: { ai: { ...CONFIG.ai, maxPerRun: 1 } }, client, sdk: SDK, sales: SALES, log: quietLog() });
  assert.equal(n, 1);
  const { url, headers, body } = captured[0];
  assert.equal(url, 'https://api.anthropic.com/v1/messages?beta=true');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(headers['x-api-key'], 'test-key');
  assert.deepEqual(Object.keys(body).sort(), ['fallbacks', 'max_tokens', 'messages', 'model', 'output_config', 'system']);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.schema.additionalProperties, false);
  assert.deepEqual(body.messages[0].content[0], { type: 'image', source: { type: 'url', url: 'https://img.example.cz/1.jpg' } });
  assert.equal(db.prepare('SELECT ai_czk FROM listings WHERE id = 1').get().ai_czk, 48000);
  // 402 přes skutečné SDK → typová chyba → konec běhu s českou hláškou, žádné opakování bez fotky
  mode = '402';
  captured.length = 0;
  await assert.rejects(ai.valuatePending(db, { config: CONFIG, client, sdk: SDK, sales: SALES, log: quietLog() }), /došel kredit/);
  assert.equal(captured.length, 1);
  const ctl = new AbortController();
  ctl.abort();
  const err = await client.beta.messages.create(ai.buildRequest(db.prepare('SELECT * FROM listings WHERE id = 2').get(), { config: CONFIG }), { signal: ctl.signal }).catch((e) => e);
  assert.equal(ai.errorKind(err, SDK), 'abort');
});

test('JSON schéma odpovědi splňuje omezení structured outputs', () => {
  const walk = (s, path) => {
    for (const k of ['minimum', 'maximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'exclusiveMinimum', 'exclusiveMaximum']) {
      assert.equal(k in s, false, `${path}: nepodporované ${k}`);
    }
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, `${path}: additionalProperties`);
      for (const r of s.required || []) assert.ok(r in s.properties, `${path}: required ${r}`);
      assert.deepEqual(Object.keys(s.properties).sort(), (s.required || []).slice().sort(), `${path}: všechny vlastnosti povinné`);
      for (const [k, v] of Object.entries(s.properties)) walk(v, `${path}.${k}`);
    }
    if (s.enum) assert.ok(s.enum.length && s.enum.every((x) => typeof x === 'string'), `${path}: enum`);
  };
  walk(ai.RESPONSE_SCHEMA, '$');
});
