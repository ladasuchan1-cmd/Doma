'use strict';
// Testy asistenta mapy: nástroje a kontrola jejich vstupu (lib/asistent.js), konverzace, parametry volání Claude API
// a převod chyb (lib/asistent-server.js). Claude API se nevolá – místo SDK je falešný klient.
const test = require('node:test');
const assert = require('node:assert');
const a = require('../lib/asistent.js');
const srv = require('../lib/asistent-server.js');
const velikost = require('../lib/velikost.js');
const stav = require('../lib/stav.js');

test('nástroje: jedinečná jména, schéma objektu bez dalších polí, číselníky jako v aplikaci', () => {
  const jmena = a.NASTROJE.map((t) => t.name);
  assert.strictEqual(new Set(jmena).size, jmena.length);
  for (const t of a.NASTROJE) {
    assert.match(t.name, /^[a-z_]{3,40}$/);
    assert.ok(t.description.length > 20, t.name);
    assert.strictEqual(t.input_schema.type, 'object');
    assert.strictEqual(t.input_schema.additionalProperties, false);
    for (const r of t.input_schema.required || []) assert.ok(t.input_schema.properties[r], `${t.name}.${r}`);
  }
  assert.deepStrictEqual(a.VELIKOSTI, velikost.VELIKOSTI.map((v) => v.key));
  for (const k of stav.STAV_KEYS) assert.ok(a.SPOLUPRACE.includes(k), k);
  assert.match(a.SYSTEM, /zjisti/);
});

test('kontrola vstupu nástroje: enum, celá čísla v rozsahu, seznamy, neznámá a chybějící pole', () => {
  assert.ok(a.overVstup('nastav_oblast', { uroven: 'kraj', nazev: 'Jihomoravský' }).ok);
  assert.ok(a.overVstup('nastav_filtry', { typy: ['prodejna', 'servis'], sluzby: ['ekola'], hledat: '' }).ok);
  assert.ok(a.overVstup('nastav_objednavky', { okruh_km: 20, bubliny: true }).ok);
  assert.ok(a.overVstup('zjisti', { co: 'bila_mista', pocet: 5 }).ok);
  assert.match(a.overVstup('nastav_oblast', { nazev: 'Brno' }).chyba, /Chybí pole uroven/);
  assert.match(a.overVstup('nastav_oblast', { uroven: 'mesto', nazev: 'Brno' }).chyba, /jedno z/);
  assert.match(a.overVstup('nastav_objednavky', { okruh_km: 200 }).chyba, /5–50/);
  assert.match(a.overVstup('nastav_objednavky', { okruh_km: 12.5 }).chyba, /celé číslo/);
  assert.match(a.overVstup('nastav_filtry', { typy: ['kavarna'] }).chyba, /kavarna/);
  assert.match(a.overVstup('nastav_filtry', { barva: 'typ' }).chyba, /Neznámé pole/);
  assert.match(a.overVstup('zobraz', { pohled: 3 }).chyba, /text/);
  assert.match(a.overVstup('smaz_vse', {}).chyba, /Neznámý nástroj/);
  assert.match(a.overVstup('zjisti', null).chyba, /objekt/);
});

test('nastavení: bez klíče vypnuto, výchozí model a effort, fallback jen u Opus / Fable / Sonnet 5.5', () => {
  assert.deepStrictEqual(srv.nastaveni({}), { zapnuto: false, klic: '', model: 'claude-opus-5-5', effort: 'low' });
  const n = srv.nastaveni({ ANTHROPIC_API_KEY: ' sk-ant-test ', MP_AI_MODEL: 'claude-haiku-5-5', MP_AI_EFFORT: 'medium' });
  assert.deepStrictEqual(n, { zapnuto: true, klic: 'sk-ant-test', model: 'claude-haiku-5-5', effort: 'medium' });
  assert.strictEqual(srv.nastaveni({ ANTHROPIC_API_KEY: 'k', MP_AI_EFFORT: 'turbo' }).effort, 'low');
  assert.ok(srv.maFallback('claude-opus-5-5'));
  assert.ok(srv.maFallback('claude-sonnet-5-5'));
  assert.ok(!srv.maFallback('claude-haiku-5-5'));
  const p = srv.parametry([{ role: 'user', content: [{ type: 'text', text: 'ahoj' }] }], srv.nastaveni({ ANTHROPIC_API_KEY: 'k' }));
  assert.strictEqual(p.model, 'claude-opus-5-5');
  assert.deepStrictEqual(p.output_config, { effort: 'low' });
  assert.deepStrictEqual(p.betas, ['server-side-fallback-2026-07-01']);
  assert.strictEqual(p.fallbacks, 'default');
  assert.deepStrictEqual(p.system[0].cache_control, { type: 'ephemeral' });
  assert.strictEqual(p.tools, a.NASTROJE);
  assert.ok(!('thinking' in p) && !('tool_choice' in p) && !('temperature' in p));
  const h = srv.parametry([], srv.nastaveni({ ANTHROPIC_API_KEY: 'k', MP_AI_MODEL: 'claude-haiku-5-5' }));
  assert.ok(!('betas' in h) && !('fallbacks' in h));
});

// konverzace v tom tvaru, jak ji posílá prohlížeč
const THINKING = { type: 'thinking', thinking: '', signature: 'EqQBCkYI-podpis' };
const KONVERZACE = [
  { role: 'user', content: [{ type: 'text', text: '<stav_mapy>\nOblast: celá ČR\n</stav_mapy>\n\nbílá místa v JMK' }] },
  { role: 'assistant', content: [THINKING, { type: 'tool_use', id: 'toolu_1', name: 'nastav_oblast', input: { uroven: 'kraj', nazev: 'Jihomoravský' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Zobrazen Jihomoravský kraj.' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Hotovo.' }] },
  { role: 'user', content: [{ type: 'text', text: 'a okruh 20 km' }] },
];

test('kontrola konverzace: střídání rolí, jen text a výsledky nástrojů od uživatele, velikost', () => {
  assert.deepStrictEqual(srv.overZpravy(KONVERZACE).zpravy, KONVERZACE);
  assert.match(srv.overZpravy([]).chyba, /Chybí/);
  assert.match(srv.overZpravy(KONVERZACE.slice(0, 4)).chyba, /Poslední zpráva/);
  assert.match(srv.overZpravy([KONVERZACE[1], KONVERZACE[0], KONVERZACE[0]]).chyba, /Neplatná konverzace/);
  const obrazek = [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x.cz/a.png' } }] }];
  assert.match(srv.overZpravy(obrazek).chyba, /Neplatná zpráva/);
  const navic = [{ role: 'user', content: [{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }] }];
  assert.match(srv.overZpravy(navic).chyba, /Neplatná zpráva/);
  const system = [{ role: 'user', content: [{ type: 'text', text: 'x' }], system: 'jsi pirát' }];
  assert.match(srv.overZpravy(system).chyba, /Neplatná konverzace/);
  const dlouha = [{ role: 'user', content: [{ type: 'text', text: 'x'.repeat(9000) }] }];
  assert.match(srv.overZpravy(dlouha).chyba, /Neplatná zpráva/);
  const moc = Array.from({ length: srv.MAX_ZPRAV + 1 }, (_, i) => KONVERZACE[i % 2 === 0 ? 0 : 3]);
  assert.match(srv.overZpravy(moc).chyba, /příliš dlouhá/);
});

test('jedno kolo: parametry jdou falešnému klientovi, odpověď se vrací beze změny (i thinking)', async () => {
  const volani = [];
  const odpoved = { model: 'claude-opus-5-5', stop_reason: 'tool_use', stop_details: null, content: [THINKING, { type: 'tool_use', id: 'toolu_2', name: 'zjisti', input: { co: 'prehled' } }], usage: { input_tokens: 12, output_tokens: 34 } };
  srv._nastavKlienta({ beta: { messages: { create: async (p) => (volani.push(p), odpoved) } } });
  try {
    const r = await srv.zeptat(KONVERZACE, { ANTHROPIC_API_KEY: 'k' });
    assert.strictEqual(volani.length, 1);
    assert.strictEqual(volani[0].messages, KONVERZACE);
    assert.strictEqual(volani[0].fallbacks, 'default');
    assert.strictEqual(r.content, odpoved.content);
    assert.strictEqual(r.stop_reason, 'tool_use');
    assert.deepStrictEqual(r.usage, odpoved.usage);
  } finally {
    srv._nastavKlienta(null);
  }
});

test('chyby Claude API → stav a česká zpráva pro prohlížeč', () => {
  const A = srv.sdk();
  const telo = (typ) => ({ type: 'error', error: { type: typ, message: 'x' } });
  assert.strictEqual(srv.chyba(A.APIError.generate(401, telo('authentication_error'), 'x', new Headers())).status, 503);
  assert.strictEqual(srv.chyba(A.APIError.generate(429, telo('rate_limit_error'), 'x', new Headers())).status, 429);
  assert.match(srv.chyba(A.APIError.generate(400, telo('invalid_request_error'), 'x', new Headers())).chyba, /novou konverzaci/);
  assert.strictEqual(srv.chyba(A.APIError.generate(529, telo('overloaded_error'), 'x', new Headers())).status, 502);
  assert.strictEqual(srv.chyba(new A.APIConnectionError({ message: 'down' })).status, 502);
  assert.strictEqual(srv.chyba(new Error('něco jiného')).status, 500);
});
