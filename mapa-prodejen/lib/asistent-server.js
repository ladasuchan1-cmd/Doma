'use strict';
// Asistent mapy na serveru: konverzace z prohlížeče → Claude API (Messages) s pevným systémovým promptem
// a nástroji mapy (lib/asistent.js). Nástroje provádí prohlížeč (mění zobrazení, počítá souhrny z dat v mapě);
// server drží klíč API, kontroluje konverzaci a vrací odpověď modelu beze změny – i bloky thinking, které musí
// prohlížeč poslat v další zprávě zpátky tak, jak přišly.
// Nastavení (proměnné prostředí): ANTHROPIC_API_KEY (bez něj je asistent vypnutý), MP_AI_MODEL (výchozí
// claude-opus-5-5), MP_AI_EFFORT (výchozí low – stačí na ovládání mapy a je nejrychlejší).
const { NASTROJE, SYSTEM } = require('./asistent.js');

const MAX_ZPRAV = 80;
const MAX_BAJTU = 400 * 1024;
const MAX_TOKENU = 8000;
const EFFORTY = ['low', 'medium', 'high', 'xhigh', 'max'];

let Anthropic = null; // SDK se načte až při prvním dotazu
let klient = null;
let klientKlic = '';
let testKlient = null;

function nastaveni(env) {
  const e = env || process.env;
  const klic = String(e.ANTHROPIC_API_KEY || '').trim();
  const model = String(e.MP_AI_MODEL || '').trim() || 'claude-opus-5-5';
  const effort = EFFORTY.includes(e.MP_AI_EFFORT) ? e.MP_AI_EFFORT : 'low';
  return { zapnuto: Boolean(klic) || Boolean(testKlient), klic, model, effort };
}

// Server-side fallback („default“ – při odmítnutí bezpečnostním filtrem odpoví doporučený model) umí Opus, Fable
// a Sonnet 5.5; Haiku ho nemá.
function maFallback(model) {
  return /^claude-(opus|fable|mythos)-/.test(model) || model === 'claude-sonnet-5-5';
}

// Konverzace z prohlížeče: střídá se uživatel a asistent, začíná i končí uživatelem. Uživatel posílá jen text
// a výsledky nástrojů; odpovědi asistenta jsou bloky tak, jak je vrátilo API. → { zpravy } | { chyba }
function overZpravy(messages) {
  if (!Array.isArray(messages) || !messages.length) return { chyba: 'Chybí zprávy.' };
  if (messages.length > MAX_ZPRAV || Buffer.byteLength(JSON.stringify(messages)) > MAX_BAJTU) {
    return { chyba: 'Konverzace je příliš dlouhá – začněte novou.' };
  }
  if (messages.length % 2 === 0) return { chyba: 'Poslední zpráva musí být od uživatele.' };
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = i % 2 === 0 ? 'user' : 'assistant';
    if (!m || typeof m !== 'object' || m.role !== role || Object.keys(m).some((k) => k !== 'role' && k !== 'content')) {
      return { chyba: 'Neplatná konverzace – začněte novou.' };
    }
    if (!Array.isArray(m.content) || !m.content.length) return { chyba: 'Neplatná konverzace – začněte novou.' };
    if (role === 'assistant') continue;
    for (const b of m.content) {
      if (!b || typeof b !== 'object') return { chyba: 'Neplatná zpráva.' };
      const klice = Object.keys(b);
      if (b.type === 'text' && typeof b.text === 'string' && b.text.length <= 8000 && klice.length === 2) continue;
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string' && typeof b.content === 'string' && b.content.length <= 30000
        && (b.is_error === undefined || typeof b.is_error === 'boolean') && klice.every((k) => ['type', 'tool_use_id', 'content', 'is_error'].includes(k))) continue;
      return { chyba: 'Neplatná zpráva.' };
    }
  }
  return { zpravy: messages };
}

function sdk() {
  if (!Anthropic) Anthropic = require('@anthropic-ai/sdk').default;
  return Anthropic;
}

function dejKlienta(klic) {
  if (testKlient) return testKlient;
  if (klient && klientKlic === klic) return klient;
  const A = sdk();
  klient = new A({ apiKey: klic, maxRetries: 1, timeout: 45000 }); // za Cloudflare musí odpověď přijít do 100 s
  klientKlic = klic;
  return klient;
}

// Parametry jednoho volání Messages API.
function parametry(messages, n) {
  const p = {
    model: n.model,
    max_tokens: MAX_TOKENU,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }], // nástroje + prompt jdou z cache
    tools: NASTROJE,
    messages,
    output_config: { effort: n.effort },
  };
  if (maFallback(n.model)) {
    p.betas = ['server-side-fallback-2026-07-01'];
    p.fallbacks = 'default';
  }
  return p;
}

// Jedno kolo konverzace. Vrací obsah odpovědi beze změny (prohlížeč ho připojí ke konverzaci).
async function zeptat(messages, env) {
  const n = nastaveni(env);
  const r = await dejKlienta(n.klic).beta.messages.create(parametry(messages, n));
  return { content: r.content, stop_reason: r.stop_reason, stop_details: r.stop_details || null, model: r.model, usage: r.usage || null };
}

// Chyba volání → { status, chyba } pro prohlížeč (bez podrobností konverzace).
function chyba(err) {
  const A = Anthropic;
  if (A) {
    if (err instanceof A.AuthenticationError || err instanceof A.PermissionDeniedError) {
      return { status: 503, chyba: 'Klíč Claude API je neplatný nebo nemá oprávnění – zkontrolujte ANTHROPIC_API_KEY na serveru.' };
    }
    if (err instanceof A.RateLimitError) return { status: 429, chyba: 'Claude API je teď vytížené (limit dotazů) – zkuste to za chvíli.' };
    if (err instanceof A.BadRequestError) return { status: 400, chyba: 'Claude API konverzaci odmítlo – začněte novou konverzaci.' };
    if (err instanceof A.APIConnectionError) return { status: 502, chyba: 'Claude API neodpovídá – zkuste to za chvíli.' };
    if (err instanceof A.APIError) return { status: 502, chyba: `Chyba Claude API (${err.status || 'bez kódu'}) – zkuste to za chvíli.` };
  }
  return { status: 500, chyba: 'Asistent selhal – zkuste to znovu.' };
}

// Jen pro testy: místo SDK falešný klient s beta.messages.create(params).
function _nastavKlienta(k) {
  testKlient = k;
}

module.exports = { nastaveni, maFallback, overZpravy, parametry, zeptat, chyba, sdk, _nastavKlienta, MAX_ZPRAV };
