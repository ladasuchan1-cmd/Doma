// Asistent mapy (Claude): systémový prompt a nástroje, kterými model ovládá zobrazení mapy a zjišťuje čísla z dat
// v mapě. Nástroje provádí prohlížeč (app.js); server (lib/asistent-server.js) je posílá do Claude API a drží klíč.
// Tady je i kontrola vstupu nástroje – model může poslat cokoli, aplikace provede jen platné hodnoty.
// UMD: v prohlížeči `MP.asistent`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.asistent = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const TYPY = ['prodejna', 'servis', 'pujcovna', 'bazar', 'retezec', 'firma', 'nase', 'jine'];
  const VELIKOSTI = ['velka', 'stredni', 'mala', 'mikro', 'neznama'];
  const SLUZBY = ['servis', 'ekola', 'pujcovna', 'bazar', 'eshop'];
  const SPOLUPRACE = ['vse', 'bezstavu', 'sestavem', 'rozpracovano', 'vytipovano', 'osloveno', 'volano', 'schuzka', 'partner', 'odmitl'];

  const SYSTEM = `Jsi asistent v interní aplikaci „Mapa prodejen a servisů kol“ (mapa.ksprehledy.cz). Obchodní tým v ní hledá partnery – prodejny a servisy kol, které by obsloužily naše zákazníky tam, kde žádný partner není. Uživatel píše, co chce na mapě vidět nebo zjistit; mapu ovládáš nástroji a každá změna se hned projeví v aplikaci, kterou má uživatel před sebou.

Co v aplikaci je:
- Místa: prodejny kol, servisy, půjčovny, bazary, sportovní řetězce, firmy z ARES (jen sídlo firmy), naše prodejny a ručně přidaná místa. U místa je velikost firmy, služby (servis, e-kola, půjčovna, bazar, e-shop), značky kol, kontakt a stav spolupráce (vytipováno, osloveno, voláno, schůzka, partner, nemá zájem).
- Objednávky (případně zákazníci a aktivní zákazníci) po obcích, pokud je tým nahrál. Bílé místo je obec s aspoň N objednávkami, kde v okruhu (5–50 km) není partner ani naše prodejna.
- Kandidáti na partnera mají skóre 0–100: poptávka v okolí 50, servis 20, nepokryté okolí 20, kontakt 10.
- Záložky vpravo: Místa, Partneři (kandidáti podle skóre) a Města (obce podle objednávek, bílá místa).

Jak pracovat:
- Ve zprávě uživatele je v <stav_mapy> aktuální zobrazení. Měň jen to, o co uživatel žádá; ostatní nastavení nech, ledaže by bránilo výsledku – pak to řekni.
- Čísla a seznamy (kolik, kde nejvíc, které obce či prodejny) zjišťuj nástrojem zjisti, nikdy si je nevymýšlej. Zjisti počítá s aktuální oblastí a filtry, proto je nastav dřív.
- Názvy krajů, okresů a obcí stačí přibližně; nástroj vrátí, co našel. Když nástroj vrátí chybu nebo víc možností, vyber podle souvislosti, nebo se zeptej.
- Když se něco nástroji nastavit nedá, řekni to a nabídni nejbližší možnost. Data neměníš (stav spolupráce, místa, objednávky) – to dělá uživatel v aplikaci.
- Odpovídej česky, vykej, krátce a věcně: 1–3 věty, u seznamů nejvýš 10 řádků. Napiš, co jsi na mapě změnil.`;

  // Nástroje (Claude API: name, description, input_schema). Pole jsou nepovinná, mění se jen zadaná.
  const NASTROJE = [
    {
      name: 'nastav_oblast',
      description: 'Zobrazí celou Českou republiku, jeden kraj nebo okres: přiblíží mapu a omezí na oblast seznamy, počty i nástroj zjisti. Název stačí přibližně („Jihomoravský“, „Vysočina“, „Brno-venkov“, „Praha“).',
      input_schema: {
        type: 'object',
        properties: {
          uroven: { type: 'string', enum: ['cr', 'kraj', 'okres'], description: 'cr = celá republika' },
          nazev: { type: 'string', description: 'název kraje nebo okresu; u cr se nevyplňuje' },
        },
        required: ['uroven'],
        additionalProperties: false,
      },
    },
    {
      name: 'nastav_filtry',
      description: 'Nastaví filtry míst v levém panelu. Mění se jen zadaná pole; vychozi = true nejdřív vrátí všechny filtry na výchozí (vše zobrazeno).',
      input_schema: {
        type: 'object',
        properties: {
          vychozi: { type: 'boolean', description: 'nejdřív zrušit všechny filtry' },
          typy: { type: 'array', items: { type: 'string', enum: TYPY }, description: 'typy míst, které se mají zobrazit (ostatní se skryjí): prodejna, servis, pujcovna, bazar, retezec (sportovní řetězce), firma (firmy z ARES – sídlo), nase (naše prodejny), jine (ručně přidaná)' },
          velikosti: { type: 'array', items: { type: 'string', enum: VELIKOSTI }, description: 'velikosti firem, které se mají zobrazit' },
          sluzby: { type: 'array', items: { type: 'string', enum: SLUZBY }, description: 'místo musí nabízet všechny uvedené služby (ekola = e-kola); prázdné pole = bez omezení' },
          znacka: { type: 'string', description: 'značka kol, např. „Specialized“; prázdný text = všechny značky' },
          kontakt: { type: 'string', enum: ['vse', 'jakykoli', 'email', 'telefon', 'zadny'], description: 'jakykoli = s e-mailem nebo telefonem' },
          spoluprace: { type: 'string', enum: SPOLUPRACE, description: 'stav spolupráce; rozpracovano = má stav, ale není partner ani nemá zájem; odmitl = nemá zájem' },
          hledat: { type: 'string', description: 'hledaný text (název, IČO, obec, značka); prázdný text hledání zruší' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'nastav_objednavky',
      description: 'Nastaví vrstvy objednávek a výpočet pokrytí (funguje jen, když jsou objednávky nahrané).',
      input_schema: {
        type: 'object',
        properties: {
          metrika: { type: 'string', enum: ['n', 'zak', 'akt'], description: 'co se počítá: n = objednávky, zak = zákazníci, akt = aktivní zákazníci (jen pokud jsou v nahraných datech)' },
          okruh_km: { type: 'integer', minimum: 5, maximum: 50, description: 'okruh partnera a poptávky v km (5–50, po 5)' },
          min_pocet: { type: 'integer', minimum: 1, maximum: 50, description: 'bílé místo = obec s aspoň tolika objednávkami bez partnera v okruhu' },
          bubliny: { type: 'boolean', description: 'bubliny obcí podle počtu' },
          kraje_barvou: { type: 'boolean', description: 'obarvení krajů / okresů podle počtu' },
          na_obyvatele: { type: 'boolean', description: 'obarvení na 1 000 obyvatel' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'zobraz',
      description: 'Přepne zobrazení: záložku vpravo, mapu / tabulku, barvu značek a řazení seznamů.',
      input_schema: {
        type: 'object',
        properties: {
          zalozka: { type: 'string', enum: ['mista', 'partneri', 'mesta'], description: 'mista = seznam míst, partneri = kandidáti podle skóre, mesta = obce podle objednávek' },
          pohled: { type: 'string', enum: ['mapa', 'tabulka'] },
          barva: { type: 'string', enum: ['velikost', 'typ', 'spoluprace'], description: 'podle čeho se barví značky míst' },
          mesta: { type: 'string', enum: ['podle_poctu', 'bila_mista', 'na_obyvatele'], description: 'co ukazuje záložka Města' },
          kandidati_bez_partnera: { type: 'boolean', description: 'záložka Partneři: jen kandidáti bez partnera v okruhu' },
          kandidati_se_servisem: { type: 'boolean', description: 'záložka Partneři: jen kandidáti se servisem' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'najdi',
      description: 'Najde obec, prodejnu nebo firmu (i podle IČO), přiblíží ji na mapě a otevře její detail. Vrátí, co našel, případně další možnosti.',
      input_schema: {
        type: 'object',
        properties: {
          dotaz: { type: 'string', description: 'název obce, prodejny nebo firmy, případně IČO' },
          okres: { type: 'string', description: 'okres nebo kraj, když je obcí stejného jména víc' },
        },
        required: ['dotaz'],
        additionalProperties: false,
      },
    },
    {
      name: 'zjisti',
      description: 'Vrátí čísla a seznamy pro aktuální oblast a filtry: prehled (počty míst, partnerů, objednávek), bila_mista (obce bez partnera v okruhu podle počtu objednávek), mesta (obce podle počtu objednávek), kandidati (nejlepší kandidáti na partnera podle skóre), oblasti (objednávky po krajích, v kraji po okresech).',
      input_schema: {
        type: 'object',
        properties: {
          co: { type: 'string', enum: ['prehled', 'bila_mista', 'mesta', 'kandidati', 'oblasti'] },
          pocet: { type: 'integer', minimum: 1, maximum: 30, description: 'kolik položek seznamu vrátit (výchozí 10)' },
        },
        required: ['co'],
        additionalProperties: false,
      },
    },
  ];
  const NASTROJ = Object.fromEntries(NASTROJE.map((t) => [t.name, t]));

  // Kontrola vstupu nástroje podle jeho schématu (podmnožina JSON Schema, kterou tu používáme).
  // → { ok: true, vstup } | { ok: false, chyba }
  function overVstup(nazev, vstup) {
    const t = NASTROJ[nazev];
    if (!t) return { ok: false, chyba: `Neznámý nástroj ${nazev}.` };
    if (!vstup || typeof vstup !== 'object' || Array.isArray(vstup)) return { ok: false, chyba: 'Vstup nástroje musí být objekt.' };
    const s = t.input_schema;
    for (const k of Object.keys(vstup)) if (!s.properties[k]) return { ok: false, chyba: `Neznámé pole ${k}.` };
    for (const k of s.required || []) if (vstup[k] == null) return { ok: false, chyba: `Chybí pole ${k}.` };
    for (const [k, v] of Object.entries(vstup)) {
      const p = s.properties[k];
      const chyba = overHodnotu(k, v, p);
      if (chyba) return { ok: false, chyba };
    }
    return { ok: true, vstup };
  }
  function overHodnotu(k, v, p) {
    if (p.type === 'string') {
      if (typeof v !== 'string') return `${k} musí být text.`;
      if (v.length > 200) return `${k} je příliš dlouhé.`;
      if (p.enum && !p.enum.includes(v)) return `${k} musí být jedno z: ${p.enum.join(', ')}.`;
    } else if (p.type === 'integer') {
      if (!Number.isInteger(v)) return `${k} musí být celé číslo.`;
      if ((p.minimum != null && v < p.minimum) || (p.maximum != null && v > p.maximum)) return `${k} musí být ${p.minimum}–${p.maximum}.`;
    } else if (p.type === 'boolean') {
      if (typeof v !== 'boolean') return `${k} musí být true / false.`;
    } else if (p.type === 'array') {
      if (!Array.isArray(v) || v.length > 20) return `${k} musí být seznam.`;
      for (const x of v) if (!p.items.enum.includes(x)) return `${k}: „${x}“ není jedno z: ${p.items.enum.join(', ')}.`;
    }
    return null;
  }

  return { SYSTEM, NASTROJE, NASTROJ, TYPY, VELIKOSTI, SLUZBY, SPOLUPRACE, overVstup };
});
