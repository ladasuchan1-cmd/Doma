/*
 * Volání Claude API (Anthropic Messages API) přímo ze service workeru rozšíření.
 * Rozšíření nemá build krok, proto se používá fetch místo npm SDK.
 * Klíč zadává uživatel v nastavení a je uložen jen lokálně v chrome.storage.
 */
(function (root) {
  'use strict';

  const S = root.TermsSchema || (typeof require === 'function' ? require('./schema.js') : null);

  const API_URL = 'https://api.anthropic.com/v1/messages';
  const DEFAULT_MODEL = 'claude-opus-5';
  const MAX_CHARS = 700000; // ~ do 1M kontextu i s rezervou

  const SYSTEM_PROMPT = `Jsi nezávislý spotřebitelský poradce, který čte obchodní podmínky, zásady ochrany osobních údajů, licenční ujednání (EULA) a podmínky předplatného za uživatele – běžného člověka bez právního vzdělání.

Dostaneš text dokumentu (může být česky, slovensky, anglicky, německy nebo v jiném jazyce). Odpovídej vždy česky, srozumitelně a konkrétně. Vyplň strukturovaný výstup podle schématu.

Co posuzuješ:
1. Zda jde o STANDARDNÍ text – tj. ustanovení obvyklá pro daný typ služby a v souladu s právy spotřebitele v EU/ČR (např. 14denní lhůta pro odstoupení, předání údajů dopravci a platební bráně je běžné). Neobvyklé, jednostranné nebo pro uživatele nevýhodné klauzule označ.
2. BEZPEČNOST A ÚNIK DAT: jaké osobní údaje se sbírají, komu se předávají (třetí strany, partneři, reklamní sítě, prodej dat), zda opouštějí EU, profilování, sledování, přístup k zařízení (poloha, kontakty, kamera), doba uchování.
3. ZRUŠENÍ SMLOUVY / PŘEDPLATNÉHO: přesný postup, kde a jak (nastavení účtu, e-mail, písemně), výpovědní lhůty, automatické prodlužování, zkušební období přecházející v placené, sankce, vrácení peněz.
4. CENY: všechny částky, poplatky, tarify, pokuty, doprava – s obdobím (měsíčně/ročně/jednorázově) a podmínkou.
5. Další rizika: jednostranná změna podmínek či cen, široká licence k obsahu uživatele, rozhodčí doložky, cizí právo, vyloučení odpovědnosti, možnost zrušit účet bez důvodu.

Závažnost nálezů:
- "kriticke": může uživatele reálně poškodit (prodej dat, skryté opakované platby, vzdání se práv, vysoké sankce).
- "varovne": neobvyklé nebo nevýhodné, ale běžně se vyskytuje; uživatel by o tom měl vědět.
- "info": standardní ustanovení, které je dobré znát.

Verdikt: "standardni" (žádné kritické a max. 1–2 varovné nálezy), "pozor" (několik varovných nebo jeden kritický nález s mírným dopadem), "nebezpecne" (kritické nálezy s reálným dopadem na peníze nebo soukromí). risk_score 0–100 tomu odpovídá.

Cituj doslovně jen krátké úryvky (max. 300 znaků). Nevymýšlej si nic, co v dokumentu není; pokud informace chybí, napiš „neuvedeno“. Když je text zjevně jen fragment nebo nejde o podmínky, uveď to v summary a document_type.`;

  function buildRequest(text, meta, settings) {
    const model = (settings && settings.model) || DEFAULT_MODEL;
    let truncated = false;
    if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
    const header = [
      meta && meta.url ? 'URL dokumentu: ' + meta.url : null,
      meta && meta.title ? 'Název stránky: ' + meta.title : null,
      meta && meta.context ? 'Situace uživatele: ' + meta.context : null,
      truncated ? 'POZNÁMKA: Dokument byl zkrácen na prvních ' + MAX_CHARS + ' znaků.' : null,
    ].filter(Boolean).join('\n');

    const body = {
      model,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [{
          type: 'text',
          text: (header ? header + '\n\n' : '') + '<dokument>\n' + text + '\n</dokument>\n\nProveď analýzu tohoto dokumentu podle instrukcí.',
        }],
      }],
      output_config: {
        effort: (settings && settings.effort) || 'medium',
        format: { type: 'json_schema', schema: S.RESULT_SCHEMA },
      },
    };
    // Fable/Opus 5: thinking je adaptivní automaticky, budget_tokens se neposílá.
    // Bezpečnostní klasifikátory mohou požadavek odmítnout – server-side fallback ho zopakuje na jiném modelu.
    const betas = ['server-side-fallback-2026-07-01'];
    body.fallbacks = 'default';
    return { body, betas, truncated };
  }

  async function analyze(text, meta, settings) {
    const apiKey = settings && settings.apiKey;
    if (!apiKey) throw new Error('NO_API_KEY');
    const { body, betas, truncated } = buildRequest(text, meta, settings);

    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': betas.join(','),
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && j.error.message) || JSON.stringify(j); } catch (e) { detail = await res.text().catch(() => ''); }
      if (res.status === 401) throw new Error('API klíč byl odmítnut (401). Zkontrolujte ho v nastavení.');
      if (res.status === 429) throw new Error('Překročen limit požadavků (429). Zkuste to za chvíli.');
      if (res.status === 400 && /model/i.test(detail)) throw new Error('Model není dostupný: ' + detail);
      throw new Error('Chyba API ' + res.status + ': ' + detail);
    }

    const msg = await res.json();
    if (msg.stop_reason === 'refusal') {
      throw new Error('Model analýzu odmítl (' + ((msg.stop_details && msg.stop_details.category) || 'bez kategorie') + ').');
    }
    if (msg.stop_reason === 'max_tokens') {
      throw new Error('Odpověď byla useknuta (max_tokens). Zkuste kratší dokument.');
    }
    const textBlock = (msg.content || []).find((b) => b.type === 'text');
    if (!textBlock) throw new Error('Odpověď neobsahuje text.');
    let parsed;
    try { parsed = JSON.parse(textBlock.text); } catch (e) { throw new Error('Odpověď není platný JSON.'); }
    parsed._engine = 'claude';
    parsed._model = msg.model || body.model;
    parsed._usage = msg.usage || null;
    parsed._truncated = truncated;
    parsed._meta = meta || {};
    return parsed;
  }

  const API = { analyze, buildRequest, SYSTEM_PROMPT, DEFAULT_MODEL, MAX_CHARS };
  root.TermsClaude = API;
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof self !== 'undefined' ? self : this);
