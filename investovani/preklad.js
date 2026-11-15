// Překladač pro Investiční školu: tip, příspěvek, reklamu nebo zprávu převede do pár vět, kterým rozumí laik,
// a řekne, kdo to říká, co je fakt a co odhad a co to znamená pro uživatelova pravidla.
//
// Pokyn pro model je jediný a žije ve stránce (index.html, blok <script type="text/plain" id="pPokyn">):
// verze na claude.ai ho posílá přes schopnost `sample`, server ho odsud čte a volá Claude API
// (oficiální knihovna @anthropic-ai/sdk, klíč v ANTHROPIC_API_KEY). Bez klíče překladač na serveru neběží.
'use strict';

const MODEL = 'claude-opus-5-5';
const MAX_ZNAKU = 40000; // delší materiál se neořezává mlčky – uživatel dostane výzvu vložit jen podstatnou část

function chyba(kod, zprava) { return Object.assign(new Error(zprava || kod), { kod }); }

function vytahniPokyn(html) {
  const m = /<script type="text\/plain" id="pPokyn">([\s\S]*?)<\/script>/.exec(String(html || ''));
  if (!m || !m[1].trim()) throw new Error('Ve stránce chybí pokyn pro překladač (blok pPokyn).');
  return m[1].trim();
}

// Text ze stažené stránky: bez skriptů, stylů a značek.
function textZeStranky(html) {
  return String(html || '')
    .replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16) || 32))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d) || 32))
    .replace(/[ \t\r\f\v]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Zpráva pro model: co je dnes, co server ví o cenách, a materiál jasně oddělený od pokynů.
function sestavZpravu({ material, zdroj, kontext }) {
  const casti = [];
  if (kontext) casti.push('<kontext>\n' + kontext + '\n</kontext>');
  if (zdroj) casti.push('<zdroj>' + zdroj + '</zdroj>');
  casti.push('<material>\n' + material + '\n</material>');
  return casti.join('\n\n');
}

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DRUHY = ['fakt', 'odhad', 'názor', 'slib'];

// Odpověď modelu → pevný tvar pro stránku. Čte tolerantně (JSON může být v kódovém bloku nebo za úvodní větou).
function ctiOdpoved(odpoved) {
  const s = String(odpoved || '');
  let j = null;
  for (const kandidat of [s, (/```(?:json)?\s*([\s\S]*?)```/.exec(s) || [])[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)]) {
    if (!kandidat) continue;
    try { j = JSON.parse(kandidat); break; } catch (e) { /* další kandidát */ }
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw chyba('necitelna_odpoved', 'Model nevrátil čitelný výsledek.');
  const pole = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
  const vysledek = {
    jednou_vetou: text(j.jednou_vetou, 400),
    lidsky: text(j.lidsky, 1500),
    pojmy: pole(j.pojmy, 8).map((p) => ({ pojem: text(p && p.pojem, 80), vyznam: text(p && p.vyznam, 400) })).filter((p) => p.pojem && p.vyznam),
    kdo_to_rika: text(j.kdo_to_rika, 800),
    tvrzeni: pole(j.tvrzeni, 6).map((t) => ({ text: text(t && t.text, 400), druh: DRUHY.includes(t && t.druh) ? t.druh : 'odhad', poznamka: text(t && t.poznamka, 500) })).filter((t) => t.text),
    muj_pohled: text(j.muj_pohled, 1500),
    co_s_tim: text(j.co_s_tim, 800),
    pozor: pole(j.pozor, 4).map((p) => text(p, 300)).filter(Boolean),
  };
  if (!vysledek.lidsky && !vysledek.jednou_vetou) throw chyba('necitelna_odpoved', 'Model nevrátil shrnutí.');
  return vysledek;
}

function prekladac(opts = {}) {
  const klic = opts.apiKey !== undefined ? opts.apiKey : process.env.ANTHROPIC_API_KEY;
  let klient = opts.klient || null;
  const dostupny = () => !!(klient || klic);

  async function preloz({ pokyn, material, zdroj, kontext }) {
    if (!dostupny()) throw chyba('bez_klice', 'Na serveru není klíč ke Claude API.');
    if (!material || !material.trim()) throw chyba('prazdne', 'Není co překládat.');
    if (material.length > MAX_ZNAKU) throw chyba('moc_dlouhe', 'Text je příliš dlouhý.');
    const sdk = require('@anthropic-ai/sdk');
    const Anthropic = sdk.Anthropic || sdk.default || sdk;
    if (!klient) klient = new Anthropic({ apiKey: klic });
    let r;
    try {
      r = await klient.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        // Když bezpečnostní filtr hlavní model zastaví, požadavek doběhne na záložním modelu místo odmítnutí.
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        system: pokyn,
        messages: [{ role: 'user', content: sestavZpravu({ material, zdroj, kontext }) }],
      });
    } catch (e) {
      if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw chyba('spatny_klic', 'Klíč ke Claude API není platný.');
      if (e instanceof Anthropic.RateLimitError) throw chyba('pretizeno', 'Claude API teď omezuje počet dotazů.');
      if (e instanceof Anthropic.BadRequestError) throw chyba('spatny_pozadavek', e.message);
      if (e instanceof Anthropic.APIConnectionError) throw chyba('nedostupne', 'Claude API neodpovědělo.');
      if (e instanceof Anthropic.APIError) throw chyba('nedostupne', 'Claude API vrátilo chybu ' + e.status + '.');
      throw e;
    }
    if (r.stop_reason === 'refusal') throw chyba('odmitnuto', 'Model tenhle text odmítl zpracovat.');
    if (r.stop_reason === 'max_tokens') throw chyba('necitelna_odpoved', 'Odpověď se nevešla.');
    const odpoved = r.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { vysledek: ctiOdpoved(odpoved), model: r.model };
  }

  return { dostupny, preloz };
}

module.exports = { prekladac, vytahniPokyn, textZeStranky, sestavZpravu, ctiOdpoved, MAX_ZNAKU, MODEL };
