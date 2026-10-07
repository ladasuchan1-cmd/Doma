'use strict';
// Doména „nabídka“ – nabídkový konfigurátor pro hotely, penziony a půjčovny (kola + rezervační web + správa + servis).
// Čisté funkce bez DB a HTTP; částky v Kč (celé, zaokrouhlené po položkách), procenta jako podíl 0–1.
//   validateConfig(json, interni) → { ok, errors[], config } – kontrola struktury config/nabidka.json a normalizace
//                                    procent (hodnota > 1 = procenta, ≤ 1 = podíl; rocniUrok 8 i 0.08 = 8 %).
//                                    NÁKUPNÍ CENY kol nejsou ve veřejném souboru (validace je tam zakáže) – přicházejí
//                                    z druhého, interního souboru mimo git (`interni` = { tridyKol: {id: {nakupniCena}},
//                                    modely: {slug: {nakupniCena}} }); bez něj se odvodí z prodejní ceny a prahu marže
//                                    (meta.nakupniCenyOdvozene = true). Nákupní ceny nikdy nejdou do publicResult.
//   normalizeInput(query, config) → vstup konfigurátoru { kola: {zakladni, trek, ekolo}, porizeni, web, dalsiDesign,
//                                    sprava, servis, navratnost{sezonaDni, vytizenost, cenaDen{}, platceDph}, doplnky[] }
//                                    (neznámé hodnoty → výchozí; počty 0–MAX_KOL; kalkulačka ořez na rozsahy NAVRATNOST_ROZSAHY)
//   compute(input, config)        → výsledek: kola[], porizeni{}, web{}, sprava{}, servis{}, doplnky[], souhrn{},
//                                    mnozstevni{} (stupeň, sleva, úspora, kolik kol chybí do dalšího stupně),
//                                    navratnost{} (kalkulačka „Vyplatí se to?“ – veřejná, bez nákupních cen; null bez kol),
//                                    upozorneni[], interni{} (marže, náklady, podíl partnera, varování)
//   publicResult(result)          → výsledek bez interních čísel (pro veřejnost a API bez admin session)
//   monthlyRate(trida, mesice, pronajem) → měsíční sazba pronájmu za 1 kolo (anuita + úrok ze zůstatku + marže)
// Vzorce jsou závazně v docs/NABIDKA-MODEL.md, sekce 2: zůstatková hodnota po m měsících lineárně mezi prodejní cenou a
// zustatkova36m; anuita = (nákupní − PV zůstatkové) × i / (1 − (1+i)^−m); pronájem měsíčně = R(anuita + nákupní × marzeRocni / 12);
// zkouška = R(nasobekSazby36m × sazba 36 m); ve zkoušce v ceně: web ze šablony, předplacená správa (1 konzultace/měs.),
// sezónní prohlídka a přilby. Interně: pronájem = marže nad anuitou (náklad kapitálu jako náklad), správa = cena −
// nakladySpravyHodinMesicne × nakladyKonzultaceHodina, servis = provize, doplňky = cena × (1 − naklady<Doplnek>ProcentCeny).

const PORIZENI = Object.freeze(['koupe', 'pronajem24', 'pronajem36', 'zkouska']);
const WEB = Object.freeze(['sablona', 'namiru', 'zadny']);
const SPRAVA = Object.freeze(['sami', 'predplacena']);
const SERVIS = Object.freeze(['vlastni', 'partner']);
const TRIDY = Object.freeze(['zakladni', 'trek', 'ekolo']);
const MAX_KOL = 500;

const PORIZENI_LABELS = Object.freeze({ koupe: 'Koupě', pronajem24: 'Pronájem na 24 měsíců', pronajem36: 'Pronájem na 36 měsíců', zkouska: 'Zkušební období 4 měsíce' });
const WEB_LABELS = Object.freeze({ sablona: 'Rezervační web ze šablony', namiru: 'Web na míru', zadny: 'Bez webu (jen kola)' });
const SPRAVA_LABELS = Object.freeze({ sami: 'Správu si zajistíte sami', predplacena: 'Předplacená správa' });
const SERVIS_LABELS = Object.freeze({ vlastni: 'Vlastní servis se slevou na díly', partner: 'Partnerský servis v okolí' });

const r0 = (n) => Math.round(Number(n) || 0);

// Kalkulačka návratnosti (docs/NABIDKA-MODEL.md, kap. „Kalkulačka návratnosti“): výchozí hodnoty, když config/nabidka.json
// blok `navratnost` nemá, a povolené rozsahy vstupů (mimo rozsah → ořez, nečíselné → výchozí).
const NAVRATNOST_VYCHOZI = Object.freeze({ sezonaDni: 150, vytizenost: 0.35, cenaDen: Object.freeze({ zakladni: 390, trek: 450, ekolo: 890 }), dph: 0.21 });
const NAVRATNOST_ROZSAHY = Object.freeze({ sezonaDni: [30, 365], vytizenostProcent: [5, 100], cenaDen: [0, 5000] });

// ---------------------------------------------------------------------------------------------------------
// Validace konfigurace

/**
 * Veřejný popis třídy: z `popis` vynechá věty s interními poznámkami (nákupní cena, marže, návrh, zadavatel, zůstatková),
 * které config nese pro interní čtenáře – na veřejnou stránku nepatří.
 */
function publicDescription(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/n[áa]kupn[íi] cen|mar[žz]|n[áa]vrh|zadavatel|z[ůu]statkov/i.test(sentence))
    .join(' ')
    .trim();
}

/** Procenta: 10 → 0.10; 0.1 → 0.1 (podíl); 1 → 1 (= 100 %). */
function pct(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return NaN;
  return n > 1 ? n / 100 : n;
}

function isNum(v, { min = 0 } = {}) {
  return typeof v === 'number' && Number.isFinite(v) && v >= min;
}

/**
 * Zkontroluje strukturu config/nabidka.json; vrátí normalizovanou kopii (procenta jako podíly).
 * @param {object} raw
 * @returns {{ ok: boolean, errors: string[], config: object|null }}
 */
function validateConfig(raw, interniRaw = null) {
  const errors = [];
  const need = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  if (!raw || typeof raw !== 'object') return { ok: false, errors: ['Konfigurace není objekt.'], config: null };
  const { meta, tridyKol, pronajem, zkouska, web, sprava, servis, doplnky, interni } = raw;
  need(meta && typeof meta === 'object', 'Chybí „meta“.');
  need(Array.isArray(tridyKol) && tridyKol.length === 3, '„tridyKol“ musí být pole 3 tříd (zakladni, trek, ekolo).');
  const tridy = {};
  for (const t of Array.isArray(tridyKol) ? tridyKol : []) {
    if (!t || !TRIDY.includes(t.id)) {
      errors.push(`Třída kol s neznámým id „${t && t.id}“.`);
      continue;
    }
    for (const k of ['prodejniCena', 'zustatkova36m']) need(isNum(t[k]), `tridyKol.${t.id}.${k} musí být nezáporné číslo.`);
    need(t.nakupniCena === undefined, `tridyKol.${t.id}.nakupniCena: nákupní ceny do veřejného souboru nepatří – patří jen do interního souboru mimo git (PK_NABIDKA_INTERNI).`);
    need(typeof t.nazev === 'string' && t.nazev, `tridyKol.${t.id}.nazev chybí.`);
    tridy[t.id] = { id: t.id, nazev: String(t.nazev || t.id), popis: String(t.popis || ''), popisVerejny: publicDescription(t.popis), nakupniCena: 0, prodejniCena: r0(t.prodejniCena), zustatkova36m: r0(t.zustatkova36m) };
  }
  for (const id of TRIDY) need(tridy[id], `Chybí třída kol „${id}“.`);

  // Interní soubor (mimo git): nákupní ceny tříd a konkrétních modelů. Chybí-li, odvodí se nákupní cena třídy z prodejní
  // ceny a prahu marže (interni.prahMarzeProcent) – konfigurátor funguje, interní pohled to označí.
  const modelyNakup = {};
  let nakupniZeSouboru = false;
  if (interniRaw !== null && interniRaw !== undefined) {
    need(interniRaw && typeof interniRaw === 'object' && !Array.isArray(interniRaw), 'Interní soubor cen není objekt.');
    const it = interniRaw && typeof interniRaw === 'object' ? interniRaw : {};
    if (it.tridyKol !== undefined) need(it.tridyKol && typeof it.tridyKol === 'object' && !Array.isArray(it.tridyKol), 'Interní soubor: „tridyKol“ musí být objekt {id: {nakupniCena}}.');
    for (const [id, v] of Object.entries(it.tridyKol && typeof it.tridyKol === 'object' ? it.tridyKol : {})) {
      if (!TRIDY.includes(id)) {
        errors.push(`Interní soubor: neznámá třída kol „${id}“.`);
        continue;
      }
      const cena = v && typeof v === 'object' ? v.nakupniCena : v;
      need(isNum(cena), `Interní soubor: tridyKol.${id}.nakupniCena musí být nezáporné číslo.`);
      if (isNum(cena) && tridy[id]) {
        tridy[id].nakupniCena = r0(cena);
        nakupniZeSouboru = true;
      }
    }
    if (it.modely !== undefined) need(it.modely && typeof it.modely === 'object' && !Array.isArray(it.modely), 'Interní soubor: „modely“ musí být objekt {slug: {nakupniCena}}.');
    for (const [slug, v] of Object.entries(it.modely && typeof it.modely === 'object' ? it.modely : {})) {
      const cena = v && typeof v === 'object' ? v.nakupniCena : v;
      need(/^[a-z0-9-]{1,80}$/.test(slug), `Interní soubor: neplatný slug modelu „${slug}“.`);
      need(isNum(cena), `Interní soubor: modely.${slug}.nakupniCena musí být nezáporné číslo.`);
      if (isNum(cena)) modelyNakup[slug] = r0(cena);
    }
  }

  need(pronajem && typeof pronajem === 'object', 'Chybí „pronajem“.');
  const p = pronajem || {};
  need(Array.isArray(p.mesice) && p.mesice.includes(24) && p.mesice.includes(36), 'pronajem.mesice musí obsahovat 24 a 36.');
  for (const k of ['rocniUrok', 'marzeRocni', 'kauceProcent']) need(isNum(p[k]), `pronajem.${k} musí být nezáporné číslo.`);
  need(Number.isInteger(p.minKol) && p.minKol >= 0, 'pronajem.minKol musí být celé číslo.');

  need(zkouska && typeof zkouska === 'object', 'Chybí „zkouska“.');
  const z = zkouska || {};
  need(Number.isInteger(z.mesice) && z.mesice > 0, 'zkouska.mesice musí být kladné celé číslo.');
  for (const k of ['nasobekSazby36m', 'zalohaProcent', 'kauceProcent', 'zapocetPriPokracovaniProcent', 'odkupPoZkousceProcentProdejni']) need(isNum(z[k]), `zkouska.${k} musí být nezáporné číslo.`);
  need(Number.isInteger(z.minKol) && z.minKol >= 0, 'zkouska.minKol musí být celé číslo.');
  need(Array.isArray(z.vCene), 'zkouska.vCene musí být pole textů.');

  need(web && web.sablona && web.naMiru, 'Chybí „web.sablona“ / „web.naMiru“.');
  const w = web || {};
  need(w.sablona && isNum(w.sablona.jednorazove) && isNum(w.sablona.mesicne), 'web.sablona.jednorazove / mesicne musí být čísla.');
  need(w.naMiru && isNum(w.naMiru.jednorazoveOd) && isNum(w.naMiru.mesicne), 'web.naMiru.jednorazoveOd / mesicne musí být čísla.');
  need(isNum(w.dalsiDesignJednorazove), 'web.dalsiDesignJednorazove musí být číslo.');

  need(sprava && sprava.sami && sprava.predplacena, 'Chybí „sprava.sami“ / „sprava.predplacena“.');
  const sp = sprava || {};
  need(sp.predplacena && isNum(sp.predplacena.mesicne) && isNum(sp.predplacena.konzultaceZdarmaMesicne) && isNum(sp.predplacena.dalsiKonzultaceHodina), 'sprava.predplacena.mesicne / konzultaceZdarmaMesicne / dalsiKonzultaceHodina musí být čísla.');

  need(servis && servis.vlastni && servis.partner, 'Chybí „servis.vlastni“ / „servis.partner“.');
  const sv = servis || {};
  need(sv.vlastni && isNum(sv.vlastni.slevaNaDilyProcent), 'servis.vlastni.slevaNaDilyProcent musí být číslo.');
  need(sv.partner && isNum(sv.partner.mesicneZaKolo) && isNum(sv.partner.sezonniProhlidkaZaKolo) && isNum(sv.partner.provizeProNasProcent) && isNum(sv.partner.slaHodin), 'servis.partner.* musí být čísla.');

  need(Array.isArray(doplnky), '„doplnky“ musí být pole.');
  const dop = [];
  const seen = new Set();
  for (const d of Array.isArray(doplnky) ? doplnky : []) {
    if (!d || typeof d.id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(d.id)) {
      errors.push(`Doplněk s neplatným id „${d && d.id}“ (povoleno a–z, 0–9, pomlčka).`);
      continue;
    }
    if (seen.has(d.id)) errors.push(`Doplněk „${d.id}“ je uveden dvakrát.`);
    seen.add(d.id);
    need(typeof d.nazev === 'string' && d.nazev, `doplnky.${d.id}.nazev chybí.`);
    for (const k of ['mesicneZaKolo', 'jednorazoveZaKolo', 'jednorazove']) if (d[k] !== undefined) need(isNum(d[k]), `doplnky.${d.id}.${k} musí být číslo.`);
    dop.push({ id: d.id, nazev: String(d.nazev || d.id), popis: String(d.popis || ''), mesicneZaKolo: r0(d.mesicneZaKolo), jednorazoveZaKolo: r0(d.jednorazoveZaKolo), jednorazove: r0(d.jednorazove), jenEkolo: !!d.jenEkolo });
  }

  // množstevní stupně (volitelné): čím víc kol celkem, tím vyšší sleva na kola a lepší podmínky; první stupeň = minimum
  const stupne = [];
  if (raw.mnozstevniSlevy !== undefined) {
    need(Array.isArray(raw.mnozstevniSlevy) && raw.mnozstevniSlevy.length > 0, '„mnozstevniSlevy“ musí být neprázdné pole stupňů.');
    for (const [idx, st] of (Array.isArray(raw.mnozstevniSlevy) ? raw.mnozstevniSlevy : []).entries()) {
      const lbl = `mnozstevniSlevy[${idx}]`;
      if (!st || typeof st !== 'object') {
        errors.push(`${lbl} není objekt.`);
        continue;
      }
      need(Number.isInteger(st.odKol) && st.odKol >= 1, `${lbl}.odKol musí být celé číslo ≥ 1.`);
      need(isNum(st.sleva) && pct(st.sleva) < 0.5, `${lbl}.sleva musí být 0–50 %.`);
      for (const k of ['kauceProcent', 'zalohaZkouskyProcent', 'poplatekZkousky']) if (st[k] !== undefined) need(isNum(st[k]), `${lbl}.${k} musí být nezáporné číslo.`);
      if (st.slevaKoupe !== undefined) need(isNum(st.slevaKoupe) && pct(st.slevaKoupe) < 0.5, `${lbl}.slevaKoupe musí být 0–50 %.`);
      if (st.vyhody !== undefined) need(Array.isArray(st.vyhody), `${lbl}.vyhody musí být pole textů.`);
      stupne.push({
        odKol: st.odKol,
        sleva: pct(st.sleva),
        slevaKoupe: st.slevaKoupe === undefined ? pct(st.sleva) : pct(st.slevaKoupe),
        poplatekZkousky: r0(st.poplatekZkousky),
        kauceProcent: st.kauceProcent === undefined ? null : pct(st.kauceProcent),
        zalohaZkouskyProcent: st.zalohaZkouskyProcent === undefined ? null : pct(st.zalohaZkouskyProcent),
        nazev: String(st.nazev || ''),
        vyhody: Array.isArray(st.vyhody) ? st.vyhody.map(String) : [],
      });
    }
    for (let k = 1; k < stupne.length; k++) need(stupne[k].odKol > stupne[k - 1].odKol, 'mnozstevniSlevy musí být seřazené podle odKol vzestupně (bez duplicit).');
  }
  if (!stupne.length) stupne.push({ odKol: 1, sleva: 0, slevaKoupe: 0, poplatekZkousky: 0, kauceProcent: null, zalohaZkouskyProcent: null, nazev: '', vyhody: [] });

  // kalkulačka návratnosti (volitelné): výchozí vstupy pro hosta a sazba DPH; chybí-li, platí NAVRATNOST_VYCHOZI
  let navratnost = { sezonaDni: NAVRATNOST_VYCHOZI.sezonaDni, vytizenost: NAVRATNOST_VYCHOZI.vytizenost, cenaDen: { ...NAVRATNOST_VYCHOZI.cenaDen }, dph: NAVRATNOST_VYCHOZI.dph };
  if (raw.navratnost !== undefined) {
    const nv = raw.navratnost;
    const R = NAVRATNOST_ROZSAHY;
    if (!nv || typeof nv !== 'object' || Array.isArray(nv)) errors.push('„navratnost“ musí být objekt.');
    else {
      if (nv.sezonaDni !== undefined) need(Number.isInteger(nv.sezonaDni) && nv.sezonaDni >= R.sezonaDni[0] && nv.sezonaDni <= R.sezonaDni[1], `navratnost.sezonaDni musí být celé číslo ${R.sezonaDni[0]}–${R.sezonaDni[1]}.`);
      const vyt = nv.vytizenostProcent === undefined ? NAVRATNOST_VYCHOZI.vytizenost : pct(nv.vytizenostProcent);
      if (nv.vytizenostProcent !== undefined) need(isNum(nv.vytizenostProcent) && vyt >= R.vytizenostProcent[0] / 100 && vyt <= R.vytizenostProcent[1] / 100, `navratnost.vytizenostProcent musí být ${R.vytizenostProcent[0]}–${R.vytizenostProcent[1]} %.`);
      if (nv.cenaDen !== undefined) need(nv.cenaDen && typeof nv.cenaDen === 'object' && !Array.isArray(nv.cenaDen), 'navratnost.cenaDen musí být objekt {zakladni, trek, ekolo}.');
      const cd = nv.cenaDen && typeof nv.cenaDen === 'object' ? nv.cenaDen : {};
      for (const k of Object.keys(cd)) if (!TRIDY.includes(k)) errors.push(`navratnost.cenaDen: neznámá třída kol „${k}“.`);
      for (const id of TRIDY) if (cd[id] !== undefined) need(isNum(cd[id]) && cd[id] <= R.cenaDen[1], `navratnost.cenaDen.${id} musí být číslo ${R.cenaDen[0]}–${R.cenaDen[1]} Kč.`);
      const dph = nv.dph === undefined ? NAVRATNOST_VYCHOZI.dph : pct(nv.dph);
      if (nv.dph !== undefined) need(isNum(nv.dph) && dph < 1, 'navratnost.dph musí být sazba 0–99 % (např. 0.21).');
      navratnost = {
        sezonaDni: Number.isInteger(nv.sezonaDni) ? nv.sezonaDni : NAVRATNOST_VYCHOZI.sezonaDni,
        vytizenost: Number.isFinite(vyt) ? Math.round(vyt * 100) / 100 : NAVRATNOST_VYCHOZI.vytizenost,
        cenaDen: Object.fromEntries(TRIDY.map((id) => [id, isNum(cd[id]) ? r0(cd[id]) : NAVRATNOST_VYCHOZI.cenaDen[id]])),
        dph: Number.isFinite(dph) ? dph : NAVRATNOST_VYCHOZI.dph,
      };
    }
  }

  // modelové příklady (volitelné): [{ stupen, kola: { slug modelu z kola-modely.json: počet } }]
  const priklady = [];
  if (raw.modelovePriklady !== undefined) {
    need(Array.isArray(raw.modelovePriklady), '„modelovePriklady“ musí být pole.');
    for (const [idx, pr] of (Array.isArray(raw.modelovePriklady) ? raw.modelovePriklady : []).entries()) {
      const ok = pr && typeof pr === 'object' && pr.kola && typeof pr.kola === 'object' && !Array.isArray(pr.kola);
      need(ok, `modelovePriklady[${idx}].kola musí být objekt {slug: počet}.`);
      if (!ok) continue;
      const kola = {};
      for (const [slug, n] of Object.entries(pr.kola)) {
        need(/^[a-z0-9-]{1,80}$/.test(slug), `modelovePriklady[${idx}]: neplatný slug „${slug}“.`);
        need(Number.isInteger(n) && n > 0 && n <= MAX_KOL, `modelovePriklady[${idx}].kola.${slug} musí být kladné celé číslo.`);
        kola[slug] = n;
      }
      priklady.push({ stupen: String(pr.stupen || ''), kola });
    }
  }

  // položky jen „po individuální domluvě“ (bez ceny; konfigurátor je jen vypíše), např. nabíjecí stanice pro e-kola
  if (raw.naDomluvu !== undefined) need(Array.isArray(raw.naDomluvu) && raw.naDomluvu.every((x) => typeof x === 'string' && x), '„naDomluvu“ musí být pole neprázdných textů.');
  const naDomluvu = Array.isArray(raw.naDomluvu) ? raw.naDomluvu.filter((x) => typeof x === 'string' && x).map(String) : [];

  need(interni && typeof interni === 'object', 'Chybí „interni“.');
  const i = interni || {};
  for (const k of ['prahMarzeProcent', 'nakladyHostingMesicne', 'nakladyKonzultaceHodina', 'nakladyNasazeniWebu']) need(isNum(i[k]), `interni.${k} musí být číslo.`);

  // nákupní ceny tříd: ze souboru, jinak odvozené (prodejní × (1 − práh marže)); každá třída samostatně
  const prah = pct(i.prahMarzeProcent);
  let nakupniOdvozene = false;
  for (const id of TRIDY) {
    const t = tridy[id];
    if (!t) continue;
    if (!(t.nakupniCena > 0)) {
      t.nakupniCena = r0(t.prodejniCena * (1 - (Number.isFinite(prah) ? prah : 0.2)));
      t.nakupniCenaOdvozena = true;
      nakupniOdvozene = true;
    } else t.nakupniCenaOdvozena = false;
    need(t.zustatkova36m <= t.nakupniCena, `tridyKol.${id}: zůstatková hodnota (${t.zustatkova36m}) nesmí převýšit nákupní cenu.`);
  }

  if (errors.length) return { ok: false, errors, config: null };
  const config = {
    meta: { verze: String(meta.verze ?? ''), platnostOd: String(meta.platnostOd ?? ''), zastupneCeny: !!meta.zastupneCeny, poznamka: String(meta.poznamka ?? ''), nakupniCenyOdvozene: nakupniOdvozene, nakupniCenyZeSouboru: nakupniZeSouboru },
    tridyKol: TRIDY.map((id) => tridy[id]),
    pronajem: { mesice: [24, 36], rocniUrok: pct(p.rocniUrok), marzeRocni: pct(p.marzeRocni), kauceProcent: pct(p.kauceProcent), minKol: p.minKol, servisVCene: !!p.servisVCene },
    zkouska: { mesice: z.mesice, nasobekSazby36m: Number(z.nasobekSazby36m), zalohaProcent: pct(z.zalohaProcent), kauceProcent: pct(z.kauceProcent), minKol: z.minKol, startNejpozdeji: String(z.startNejpozdeji ?? ''), zapocetPriPokracovaniProcent: pct(z.zapocetPriPokracovaniProcent), odkupPoZkousceProcentProdejni: pct(z.odkupPoZkousceProcentProdejni), vCene: z.vCene.map(String) },
    web: { sablona: { jednorazove: r0(w.sablona.jednorazove), mesicne: r0(w.sablona.mesicne) }, naMiru: { jednorazoveOd: r0(w.naMiru.jednorazoveOd), mesicne: r0(w.naMiru.mesicne) }, dalsiDesignJednorazove: r0(w.dalsiDesignJednorazove) },
    sprava: { sami: { mesicne: r0(sp.sami.mesicne) }, predplacena: { mesicne: r0(sp.predplacena.mesicne), konzultaceZdarmaMesicne: Number(sp.predplacena.konzultaceZdarmaMesicne), dalsiKonzultaceHodina: r0(sp.predplacena.dalsiKonzultaceHodina) } },
    servis: { vlastni: { slevaNaDilyProcent: pct(sv.vlastni.slevaNaDilyProcent), mesicne: r0(sv.vlastni.mesicne) }, partner: { mesicneZaKolo: r0(sv.partner.mesicneZaKolo), sezonniProhlidkaZaKolo: r0(sv.partner.sezonniProhlidkaZaKolo), provizeProNasProcent: pct(sv.partner.provizeProNasProcent), slaHodin: Number(sv.partner.slaHodin) } },
    doplnky: dop,
    mnozstevniSlevy: stupne,
    navratnost,
    modelovePriklady: priklady,
    naDomluvu,
    interni: {
      prahMarzeProcent: pct(i.prahMarzeProcent),
      nakladyHostingMesicne: r0(i.nakladyHostingMesicne),
      nakladyKonzultaceHodina: r0(i.nakladyKonzultaceHodina),
      nakladyNasazeniWebu: r0(i.nakladyNasazeniWebu),
      nakladyZaskoleniHodin: isNum(i.nakladyZaskoleniHodin) ? i.nakladyZaskoleniHodin : 0,
      nakladySpravyHodinMesicne: isNum(i.nakladySpravyHodinMesicne) ? i.nakladySpravyHodinMesicne : 1,
      // interni.naklady<Doplnek>ProcentCeny → { doplnek: podíl }
      nakladyDoplnkuProcentCeny: Object.fromEntries(Object.entries(i).filter(([k, v]) => /^naklady(.+)ProcentCeny$/.test(k) && isNum(v)).map(([k, v]) => [/^naklady(.+)ProcentCeny$/.exec(k)[1], pct(v)])),
      // nákupní ceny konkrétních modelů (slug → Kč) jen z interního souboru; nikdy do veřejného výstupu
      modelyNakup,
    },
  };
  return { ok: true, errors: [], config };
}

// ---------------------------------------------------------------------------------------------------------
// Vstup

function countOf(v) {
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  const n = Number.parseInt(String(s ?? '').trim(), 10);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(MAX_KOL, n);
}

function pick(v, allowed, fallback) {
  const s = Array.isArray(v) ? v[v.length - 1] : v;
  return allowed.includes(s) ? s : fallback;
}

/** Číslo z formuláře (i s desetinnou čárkou) zaokrouhlené na celé a ořezané na [min, max]; prázdné / nečíselné → fallback. */
function numberIn(v, [min, max], fallback) {
  const s = String((Array.isArray(v) ? v[v.length - 1] : v) ?? '').trim().replace(',', '.');
  const n = s === '' ? NaN : Number(s);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Výchozí vstupy kalkulačky návratnosti z konfigurace (bez bloku `navratnost` z NAVRATNOST_VYCHOZI). */
function navratnostVychozi(config) {
  return (config && config.navratnost) || NAVRATNOST_VYCHOZI;
}

/**
 * Normalizuje vstup z query / formuláře. doplnky: pole hodnot nebo řetězec „pojisteni,gps“ (i opakovaně).
 * @param {object} query  { zakladni, trek, ekolo, porizeni, web, dalsiDesign, sprava, servis, doplnky }
 * @param {object} config validovaná konfigurace (pro seznam doplňků)
 */
function normalizeInput(query = {}, config) {
  const known = new Set((config && config.doplnky ? config.doplnky : []).map((d) => d.id));
  const rawDop = query.doplnky === undefined || query.doplnky === null ? [] : Array.isArray(query.doplnky) ? query.doplnky : [query.doplnky];
  const doplnky = [];
  for (const chunk of rawDop) for (const id of String(chunk).split(',')) {
    const t = id.trim();
    if (known.has(t) && !doplnky.includes(t)) doplnky.push(t);
  }
  const dd = Array.isArray(query.dalsiDesign) ? query.dalsiDesign[0] : query.dalsiDesign;
  const nv = navratnostVychozi(config);
  const R = NAVRATNOST_ROZSAHY;
  const np = Array.isArray(query.neplatce) ? query.neplatce[query.neplatce.length - 1] : query.neplatce;
  const navratnost = {
    sezonaDni: numberIn(query.sezona, R.sezonaDni, nv.sezonaDni),
    vytizenost: numberIn(query.vytizenost, R.vytizenostProcent, Math.round(nv.vytizenost * 100)) / 100,
    cenaDen: Object.fromEntries(TRIDY.map((id) => [id, numberIn(query[`cena_${id}`], R.cenaDen, nv.cenaDen[id])])),
    platceDph: !(np === '1' || np === 'on' || np === true),
  };
  return {
    kola: { zakladni: countOf(query.zakladni), trek: countOf(query.trek), ekolo: countOf(query.ekolo) },
    porizeni: pick(query.porizeni, PORIZENI, 'zkouska'),
    web: pick(query.web, WEB, 'sablona'),
    dalsiDesign: dd === '1' || dd === 'on' || dd === true,
    sprava: pick(query.sprava, SPRAVA, 'sami'),
    servis: pick(query.servis, SERVIS, 'vlastni'),
    navratnost,
    doplnky,
  };
}

/** Vstup → query string (pro odkazy, tisk, uložení). */
function inputToQuery(input) {
  const q = new URLSearchParams();
  for (const id of TRIDY) q.set(id, String(input.kola[id] || 0));
  q.set('porizeni', input.porizeni);
  q.set('web', input.web);
  if (input.dalsiDesign) q.set('dalsiDesign', '1');
  q.set('sprava', input.sprava);
  q.set('servis', input.servis);
  // kalkulačka návratnosti – vždy před doplnky (doplnky zůstávají poslední)
  const nv = input.navratnost;
  if (nv) {
    q.set('sezona', String(nv.sezonaDni));
    q.set('vytizenost', String(Math.round(nv.vytizenost * 100)));
    for (const id of TRIDY) q.set(`cena_${id}`, String(nv.cenaDen[id]));
    if (!nv.platceDph) q.set('neplatce', '1');
  }
  if (input.doplnky.length) q.set('doplnky', input.doplnky.join(','));
  return q.toString();
}

// ---------------------------------------------------------------------------------------------------------
// Výpočty (docs/NABIDKA-MODEL.md, sekce 2 – závazné vzorce)

/** Anuita: splátka jistiny `principal` na n měsíců při roční sazbě `rocni` (měsíční úročení). */
function annuity(principal, rocni, n) {
  if (!(n > 0)) return 0;
  const r = rocni / 12;
  if (r <= 0) return principal / n;
  return (principal * r) / (1 - (1 + r) ** -n);
}

/** Zůstatková hodnota kola po `mesice` měsících: lineárně mezi prodejní cenou a zustatkova36m (pro 36 = zustatkova36m). */
function zustatkova(trida, mesice) {
  return trida.zustatkova36m + ((trida.prodejniCena - trida.zustatkova36m) * (36 - mesice)) / 36;
}

/**
 * Měsíční sazba pronájmu za 1 kolo dané třídy na `mesice` měsíců. Vrací { celkem, anuita, marze, zustatkova } v Kč
 * (celkem zaokrouhleno; anuita = (nákupní − PV zůstatkové) × i / (1 − (1+i)^−m) = anuita(nákupní − zůstatková) + zůstatková × i).
 */
function monthlyRate(trida, mesice, pronajem) {
  const zust = zustatkova(trida, mesice);
  const i = pronajem.rocniUrok / 12;
  const anuita = i > 0 ? ((trida.nakupniCena - zust / (1 + i) ** mesice) * i) / (1 - (1 + i) ** -mesice) : (trida.nakupniCena - zust) / mesice;
  const marze = (trida.nakupniCena * pronajem.marzeRocni) / 12;
  return { celkem: r0(anuita + marze), anuita, marze, zustatkova: zust };
}

function sum(list, key) {
  return list.reduce((a, x) => a + (Number(x[key]) || 0), 0);
}

/** Interní náklad doplňku jako podíl ceny (interni.naklady<Id>ProcentCeny; bez klíče 0,8). */
function doplnekNakladPodil(interni, id) {
  const norm = (x) => String(x).toLowerCase().replace(/[^a-z0-9]/g, '');
  const want = norm(id);
  for (const [k, v] of Object.entries(interni.nakladyDoplnkuProcentCeny || {})) if (norm(k) === want) return v;
  return 0.8;
}

/**
 * Hlavní výpočet.
 * @param {object} input  z normalizeInput
 * @param {object} config z validateConfig
 */
function compute(input, config) {
  const upozorneni = [];
  const tridyById = Object.fromEntries(config.tridyKol.map((t) => [t.id, t]));
  // veřejná část (kola[]) bez nákupních cen – ty jen v interni.kola / interni.nakupniCelkem
  const kola = TRIDY.filter((id) => input.kola[id] > 0).map((id) => ({ id, nazev: tridyById[id].nazev, pocet: input.kola[id], prodejniCena: tridyById[id].prodejniCena, prodejniCelkem: tridyById[id].prodejniCena * input.kola[id] }));
  const kolaInterni = kola.map((k) => ({ id: k.id, pocet: k.pocet, nakupniCena: tridyById[k.id].nakupniCena, nakupniCelkem: tridyById[k.id].nakupniCena * k.pocet, odvozena: !!tridyById[k.id].nakupniCenaOdvozena }));
  const pocetKol = sum(kola, 'pocet');
  const pocetEkol = input.kola.ekolo;
  const prodejniCelkem = sum(kola, 'prodejniCelkem');
  const nakupniCelkem = sum(kolaInterni, 'nakupniCelkem');
  if (pocetKol === 0) upozorneni.push({ kod: 'zadna-kola', text: 'Zadejte prosím počet kol alespoň v jedné třídě.' });
  const stupen = stupenPro(config, pocetKol);
  const slevaPorizeni = input.porizeni === 'koupe' ? stupen.slevaKoupe : stupen.sleva;
  const faktor = 1 - slevaPorizeni;
  const minimum = config.mnozstevniSlevy[0].odKol;
  if (pocetKol > 0 && pocetKol < minimum) upozorneni.push({ kod: 'min-kol', text: `Nabídku sestavujeme od ${minimum} kol; přidejte prosím ještě ${minimum - pocetKol} ${minimum - pocetKol === 1 ? 'kolo' : 'kola'}.` });
  const podMinimem = pocetKol > 0 && pocetKol < minimum;
  const isZkouska = input.porizeni === 'zkouska';
  const horizon = isZkouska ? config.zkouska.mesice : input.porizeni === 'pronajem24' ? 24 : 36;
  const roky = Math.ceil(horizon / 12);

  // interní položky: { id, label, trzby, naklady, perioda: 'jednorazove'|'mesicne'|'rocne', partner?, poznamka? } – částky za periodu
  const ip = [];
  const porizeni = { typ: input.porizeni, label: PORIZENI_LABELS[input.porizeni], mesice: null, jednorazove: 0, mesicne: 0, kauce: 0, odkupNaKonci: 0, radky: [] };
  let zkouska = null;

  // sleva na kola v Kč (bez slevy − se slevou) za periodu pořízení: koupě jednorázově, pronájem a zkouška měsíčně
  let slevaKc = 0;
  if (input.porizeni === 'koupe') {
    porizeni.radky = kola.map((k) => {
      const zaKolo = r0(k.prodejniCena * faktor);
      slevaKc += (k.prodejniCena - zaKolo) * k.pocet;
      return { label: `${k.pocet}× ${k.nazev}`, hodnota: zaKolo * k.pocet, zaKolo, zaKoloBezSlevy: k.prodejniCena };
    });
    porizeni.jednorazove = sum(porizeni.radky, 'hodnota');
    ip.push({ id: 'kola', label: `Kola – prodejní minus nákupní cena${slevaPorizeni ? ` (po slevě ${Math.round(slevaPorizeni * 100)} %)` : ''}`, trzby: porizeni.jednorazove, naklady: nakupniCelkem, perioda: 'jednorazove' });
  } else if (!isZkouska) {
    const mesice = horizon;
    porizeni.mesice = mesice;
    let marzeMes = 0;
    let bezSlevyMes = 0;
    for (const k of kola) {
      const rate = monthlyRate(tridyById[k.id], mesice, config.pronajem);
      const zaKolo = r0(rate.celkem * faktor);
      const mes = zaKolo * k.pocet;
      slevaKc += (rate.celkem - zaKolo) * k.pocet;
      porizeni.mesicne += mes;
      porizeni.odkupNaKonci += r0(rate.zustatkova) * k.pocet;
      porizeni.radky.push({ label: `${k.pocet}× ${k.nazev}`, hodnota: mes, zaKolo, zaKoloBezSlevy: rate.celkem, zustatkova: r0(rate.zustatkova) });
      marzeMes += rate.marze * k.pocet;
      bezSlevyMes += rate.celkem * k.pocet;
    }
    porizeni.kauceProcent = stupen.kauceProcent ?? config.pronajem.kauceProcent;
    porizeni.kauce = r0(prodejniCelkem * porizeni.kauceProcent);
    porizeni.minKol = config.pronajem.minKol;
    if (!podMinimem && pocetKol > 0 && pocetKol < config.pronajem.minKol) upozorneni.push({ kod: 'min-kol', text: `Pronájem nabízíme od ${config.pronajem.minKol} kol; pro menší počet zvolte koupi nebo nám napište.` });
    ip.push({ id: 'kola', label: `Pronájem kol (${mesice} měsíců) – marže nad anuitou${stupen.sleva ? ` (po slevě ${Math.round(stupen.sleva * 100)} %)` : ''}`, trzby: porizeni.mesicne, naklady: bezSlevyMes - r0(marzeMes), perioda: 'mesicne', poznamka: `anuita včetně nákladu kapitálu ${Math.round(config.pronajem.rocniUrok * 1000) / 10} % p. a. je počítána jako náklad` });
  } else {
    const z = config.zkouska;
    porizeni.mesice = z.mesice;
    for (const k of kola) {
      const rate36 = monthlyRate(tridyById[k.id], 36, config.pronajem);
      const bezSlevy = r0(rate36.celkem * z.nasobekSazby36m);
      const zaKolo = r0(rate36.celkem * z.nasobekSazby36m * faktor);
      const mes = zaKolo * k.pocet;
      slevaKc += (bezSlevy - zaKolo) * k.pocet;
      porizeni.mesicne += mes;
      porizeni.radky.push({ label: `${k.pocet}× ${k.nazev}`, hodnota: mes, zaKolo, zaKoloBezSlevy: bezSlevy });
    }
    const celkem = porizeni.mesicne * z.mesice;
    const zalohaProcent = stupen.zalohaZkouskyProcent ?? z.zalohaProcent;
    const kauceProcent = stupen.kauceProcent ?? z.kauceProcent;
    const rozjezd = stupen.poplatekZkousky || 0;
    porizeni.jednorazove = rozjezd;
    zkouska = { mesice: z.mesice, mesicne: porizeni.mesicne, celkem, rozjezd, zaloha: r0(celkem * zalohaProcent), zalohaProcent, kauce: r0(prodejniCelkem * kauceProcent), kauceProcent, zapocet: r0(celkem * z.zapocetPriPokracovaniProcent), zapocetProcent: z.zapocetPriPokracovaniProcent, odkup: r0(prodejniCelkem * z.odkupPoZkousceProcentProdejni), odkupProcent: z.odkupPoZkousceProcentProdejni, startNejpozdeji: z.startNejpozdeji, vCene: z.vCene, minKol: z.minKol };
    porizeni.kauce = zkouska.kauce;
    porizeni.kauceProcent = kauceProcent;
    porizeni.minKol = z.minKol;
    if (!podMinimem && pocetKol > 0 && pocetKol < z.minKol) upozorneni.push({ kod: 'min-kol', text: `Zkušební období nabízíme od ${z.minKol} kol; pro menší počet zvolte koupi nebo nám napište.` });
  }
  const dalsi = config.mnozstevniSlevy.find((st) => st.odKol > pocetKol) || null;
  const mnozstevni = {
    stupne: config.mnozstevniSlevy,
    aktualni: pocetKol >= minimum ? stupen : null,
    sleva: slevaPorizeni,
    slevaKc: r0(slevaKc),
    slevaPerioda: input.porizeni === 'koupe' ? 'jednorazove' : 'mesicne',
    dalsi: dalsi && pocetKol > 0 ? { odKol: dalsi.odKol, sleva: input.porizeni === 'koupe' ? dalsi.slevaKoupe : dalsi.sleva, poplatekZkousky: dalsi.poplatekZkousky, chybi: dalsi.odKol - pocetKol, nazev: dalsi.nazev, vyhody: dalsi.vyhody } : null,
  };

  // web – ve zkoušce šablona (1 design) v ceně
  const webOut = { typ: input.web, label: WEB_LABELS[input.web], jednorazove: 0, mesicne: 0, od: false, vCeneZkousky: false, dalsiDesign: 0, poznamka: '' };
  if (input.web === 'sablona') {
    if (isZkouska) {
      webOut.vCeneZkousky = true;
      webOut.poznamka = 'Rezervační web ze šablony je po dobu zkoušky v ceně.';
    } else {
      webOut.jednorazove = config.web.sablona.jednorazove;
      webOut.mesicne = config.web.sablona.mesicne;
      ip.push({ id: 'web', label: 'Web ze šablony – nasazení', trzby: webOut.jednorazove, naklady: config.interni.nakladyNasazeniWebu, perioda: 'jednorazove' });
      ip.push({ id: 'web-provoz', label: 'Provoz webu (hosting)', trzby: webOut.mesicne, naklady: config.interni.nakladyHostingMesicne, perioda: 'mesicne' });
    }
    if (input.dalsiDesign) {
      webOut.dalsiDesign = config.web.dalsiDesignJednorazove;
      webOut.jednorazove += webOut.dalsiDesign;
      ip.push({ id: 'web-design', label: 'Další design webu', trzby: webOut.dalsiDesign, naklady: 0, perioda: 'jednorazove' });
    }
  } else if (input.web === 'namiru') {
    webOut.jednorazove = config.web.naMiru.jednorazoveOd;
    webOut.mesicne = config.web.naMiru.mesicne;
    webOut.od = true;
    webOut.poznamka = 'Cena na míru je orientační „od“ – upřesníme po konzultaci.';
    ip.push({ id: 'web', label: 'Web na míru (cena „od“)', trzby: webOut.jednorazove, naklady: config.interni.nakladyNasazeniWebu, perioda: 'jednorazove' });
    ip.push({ id: 'web-provoz', label: 'Provoz webu (hosting)', trzby: webOut.mesicne, naklady: config.interni.nakladyHostingMesicne, perioda: 'mesicne' });
  }

  // správa – ve zkoušce 1 konzultace/měsíc v ceně (předplacená správa se účtuje až po zkoušce)
  const spravaOut = { typ: input.sprava, label: SPRAVA_LABELS[input.sprava], mesicne: 0, vCeneZkousky: false, poznamka: '' };
  if (input.sprava === 'predplacena') {
    const sp = config.sprava.predplacena;
    spravaOut.konzultaceZdarma = sp.konzultaceZdarmaMesicne;
    spravaOut.dalsiKonzultaceHodina = sp.dalsiKonzultaceHodina;
    if (isZkouska) {
      spravaOut.vCeneZkousky = true;
      spravaOut.poznamka = `Po dobu zkoušky v ceně (1 konzultace měsíčně); poté ${sp.mesicne} Kč měsíčně.`;
    } else {
      spravaOut.mesicne = sp.mesicne;
      spravaOut.poznamka = `V ceně ${sp.konzultaceZdarmaMesicne} konzultace měsíčně, každá další ${sp.dalsiKonzultaceHodina} Kč/hod.`;
      ip.push({ id: 'sprava', label: 'Předplacená správa', trzby: sp.mesicne, naklady: r0(config.interni.nakladyKonzultaceHodina * config.interni.nakladySpravyHodinMesicne), perioda: 'mesicne', poznamka: `${config.interni.nakladySpravyHodinMesicne} h × ${config.interni.nakladyKonzultaceHodina} Kč` });
    }
  } else {
    spravaOut.mesicne = config.sprava.sami.mesicne;
    spravaOut.poznamka = 'Rezervace, ceník a obsah spravujete sami v administraci; zaškolení je součástí nasazení.';
  }

  // servis – paušál partnera se účtuje vždy; sezónní prohlídka ve zkoušce v ceně
  const servisOut = { typ: input.servis, label: SERVIS_LABELS[input.servis], mesicne: 0, rocne: 0, prohlidkaVCeneZkousky: false, poznamka: '' };
  const pa = config.servis.partner;
  const provize = pa.provizeProNasProcent;
  const prohlidkaRocne = pa.sezonniProhlidkaZaKolo * pocetKol;
  if (input.servis === 'partner') {
    servisOut.mesicne = pa.mesicneZaKolo * pocetKol;
    servisOut.rocne = isZkouska ? 0 : prohlidkaRocne;
    servisOut.prohlidkaVCeneZkousky = isZkouska;
    servisOut.slaHodin = pa.slaHodin;
    servisOut.poznamka = `${pa.mesicneZaKolo} Kč/kolo měsíčně + sezónní prohlídka ${pa.sezonniProhlidkaZaKolo} Kč/kolo ročně${isZkouska ? ' (ve zkoušce v ceně)' : ''}; opravy do ${pa.slaHodin} h.`;
    ip.push({ id: 'servis', label: 'Partnerský servis – naše provize', trzby: servisOut.mesicne, naklady: r0(servisOut.mesicne * (1 - provize)), partner: r0(servisOut.mesicne * (1 - provize)), perioda: 'mesicne' });
    if (servisOut.rocne) ip.push({ id: 'servis-rocne', label: 'Sezónní prohlídky – naše provize', trzby: servisOut.rocne, naklady: r0(servisOut.rocne * (1 - provize)), partner: r0(servisOut.rocne * (1 - provize)), perioda: 'rocne' });
  } else {
    servisOut.mesicne = config.servis.vlastni.mesicne;
    servisOut.slevaNaDily = config.servis.vlastni.slevaNaDilyProcent;
    servisOut.poznamka = `Servisujete sami; náhradní díly od nás se slevou ${Math.round(config.servis.vlastni.slevaNaDilyProcent * 100)} %.`;
  }

  // doplňky – přilby a zámky ve zkoušce v ceně (zkouska.vCene)
  const doplnky = [];
  let prilbyVCene = 0;
  for (const id of input.doplnky) {
    const d = config.doplnky.find((x) => x.id === id);
    if (!d) continue;
    if (d.jenEkolo && pocetEkol === 0) {
      upozorneni.push({ kod: 'jen-ekolo', text: `Doplněk „${d.nazev}“ je jen pro elektrokola – přidejte e-kola, nebo ho odeberte.` });
      continue;
    }
    const n = d.jenEkolo ? pocetEkol : pocetKol;
    const jednorazove = d.jednorazove + d.jednorazoveZaKolo * n;
    const mesicne = d.mesicneZaKolo * n;
    const vCeneZkousky = isZkouska && /prilb/i.test(d.id);
    if (vCeneZkousky) prilbyVCene = jednorazove;
    doplnky.push({ id: d.id, nazev: d.nazev, jednorazove: vCeneZkousky ? 0 : jednorazove, mesicne: vCeneZkousky ? 0 : mesicne, pocet: n, jenEkolo: d.jenEkolo, vCeneZkousky });
    if (!vCeneZkousky) {
      const podil = doplnekNakladPodil(config.interni, d.id);
      if (jednorazove) ip.push({ id: `doplnek-${d.id}`, label: `${d.nazev} (jednorázově)`, trzby: jednorazove, naklady: r0(jednorazove * podil), perioda: 'jednorazove' });
      if (mesicne) ip.push({ id: `doplnek-${d.id}-mes`, label: `${d.nazev} (měsíčně)`, trzby: mesicne, naklady: r0(mesicne * podil), perioda: 'mesicne' });
    }
  }

  // zkouška interně: tržby = zkušební nájem; náklady = nasazení webu + zaškolení + měsíčně (konzultace + hosting) + prohlídka
  // partnerovi + přilby; započet při pokračování snižuje marži (uvedeno zvlášť)
  if (zkouska) {
    const ci = config.interni;
    const nakladyZkousky = ci.nakladyNasazeniWebu + ci.nakladyZaskoleniHodin * ci.nakladyKonzultaceHodina + zkouska.mesice * (ci.nakladyKonzultaceHodina + ci.nakladyHostingMesicne) + r0(prohlidkaRocne * (1 - provize)) + r0(prilbyVCene * doplnekNakladPodil(ci, 'prilby'));
    ip.push({ id: 'kola', label: `Zkušební období (${zkouska.mesice} měsíce) – nájem${zkouska.rozjezd ? ' a poplatek za rozjezd' : ''} minus náklady rozjezdu`, trzby: zkouska.celkem + zkouska.rozjezd, naklady: nakladyZkousky, perioda: 'jednorazove', poznamka: `náklady: web, zaškolení, konzultace, hosting, prohlídka partnera, přilby; při pokračování se dále započte ${zkouska.zapocet} Kč; kola zůstávají naše (ex-demo ≈ ${Math.round(zkouska.odkupProcent * 100)} % prodejní ceny)` });
    if (prohlidkaRocne) ip.push({ id: 'servis-rocne', label: 'Sezónní prohlídka v ceně zkoušky – podíl partnera', trzby: 0, naklady: 0, partner: r0(prohlidkaRocne * (1 - provize)), perioda: 'jednorazove' });
  }

  // souhrn
  const jednorazove = porizeni.jednorazove + webOut.jednorazove + sum(doplnky, 'jednorazove');
  const mesicne = porizeni.mesicne + webOut.mesicne + spravaOut.mesicne + servisOut.mesicne + sum(doplnky, 'mesicne');
  const rocne = servisOut.rocne;
  const total = (m) => jednorazove + mesicne * m + rocne * Math.ceil(m / 12);
  const horizonty = [];
  if (isZkouska) horizonty.push({ id: 'zkouska', label: `Celkem za zkoušku (${zkouska.mesice} měsíce)`, mesice: zkouska.mesice, castka: total(zkouska.mesice) });
  else if (input.porizeni === 'pronajem24') horizonty.push({ id: 'rok', label: 'Celkem za 1 rok', mesice: 12, castka: total(12) }, { id: 'doba', label: 'Celkem za 24 měsíců', mesice: 24, castka: total(24) });
  else horizonty.push({ id: 'rok', label: 'Celkem za 1 rok', mesice: 12, castka: total(12) }, { id: 'tri', label: 'Celkem za 3 roky', mesice: 36, castka: total(36) });
  const souhrn = { pocetKol, pocetEkol, prodejniCelkem, jednorazove, mesicne, rocne, kauce: porizeni.kauce, odkupNaKonci: porizeni.odkupNaKonci, horizonty };
  const navratnost = computeNavratnost({ input, config, kola, porizeni, zkouska, souhrn });

  // interní za horizont
  let trzby = 0;
  let naklady = 0;
  let partner = 0;
  const polozky = ip.map((p) => {
    const nasobek = p.perioda === 'mesicne' ? horizon : p.perioda === 'rocne' ? roky : 1;
    const t = r0(p.trzby * nasobek);
    const n = r0(p.naklady * nasobek);
    trzby += t;
    naklady += n;
    partner += r0((p.partner || 0) * nasobek);
    return { id: p.id, label: p.label, trzby: t, naklady: n, marze: t - n, marzeProcent: t > 0 ? (t - n) / t : 0, poznamka: p.poznamka || '', perioda: p.perioda === 'mesicne' ? 'měsíčně' : p.perioda === 'rocne' ? 'ročně' : 'jednorázově', zaPeriodu: r0(p.trzby) };
  }).filter((p) => p.trzby || p.naklady);
  const marze = trzby - naklady;
  const marzeProcent = trzby > 0 ? marze / trzby : 0;
  const varovani = [];
  if (pocetKol > 0 && marzeProcent < config.interni.prahMarzeProcent) varovani.push(`Celková marže ${Math.round(marzeProcent * 100)} % je pod prahem ${Math.round(config.interni.prahMarzeProcent * 100)} % – kombinaci nelze takto nabídnout.`);
  for (const p of polozky) if (p.trzby > 0 && p.marze < 0) varovani.push(`Položka „${p.label}“ je ztrátová (${p.marze} Kč).`);
  if (input.web === 'namiru') varovani.push('Web na míru: marže počítána z ceny „od“ – skutečná cena po konzultaci.');
  if (zkouska) varovani.push(`Zkouška: při pokračování pronájmem se započte ${zkouska.zapocet} Kč (snižuje marži na ${marze - zkouska.zapocet} Kč); zisk stojí na ex-demo prodeji vrácených kol za ≈ ${Math.round(zkouska.odkupProcent * 100)} % prodejní ceny.`);
  if (config.meta.nakupniCenyOdvozene && pocetKol > 0) varovani.push('Nákupní ceny kol nejsou nastaveny (chybí interní soubor cen) – počítá se s odhadem prodejní cena × (1 − práh marže).');
  const interni = { horizontMesice: horizon, trzby, naklady, marze, marzeProcent, prahMarzeProcent: config.interni.prahMarzeProcent, podilPartnera: partner, polozky, varovani, kola: kolaInterni, nakupniCelkem, nakupniCenyOdvozene: !!config.meta.nakupniCenyOdvozene, nakladyZkousky: zkouska ? ip.find((p) => p.id === 'kola').naklady : null };

  return { vstup: input, meta: config.meta, kola, porizeni, zkouska, mnozstevni, web: webOut, sprava: spravaOut, servis: servisOut, doplnky, souhrn, navratnost, upozorneni, interni };
}

const kcFmt = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 0 });
/** „48 300 Kč“ (nezlomitelné mezery jako format.money). */
function kcText(n) {
  return `${kcFmt.format(Math.round(Number(n) || 0))}\u00a0Kč`;
}

/** Podíl → celá procenta zaokrouhlená nahoru (bez chyby plovoucí čárky: 0,21 → 21, ne 22). */
function procentNahoru(podil) {
  return Math.ceil(Math.round(podil * 1e6) / 1e4);
}

/** „1 sezónu“, „2,4 sezóny“, „3 sezóny“, „6 sezón“ (desetinná čísla genitivem jednotného čísla). */
function sezonyText(n) {
  const txt = String(n).replace('.', ',');
  if (!Number.isInteger(n)) return `${txt}\u00a0sezóny`;
  return `${txt}\u00a0${n === 1 ? 'sezónu' : n >= 2 && n <= 4 ? 'sezóny' : 'sezón'}`;
}

/**
 * Kalkulačka návratnosti „Vyplatí se to?“ (docs/NABIDKA-MODEL.md, kap. 9). Veřejná: pracuje jen s cenami pro klienta
 * (souhrn, porizeni.radky[].zaKolo) a odhadem sezóny – žádné nákupní ceny ani interní čísla. Bez kol null.
 * Částky celé Kč; tržba za den se zaokrouhlí na celé Kč, výpůjční dny třídy na celé dny.
 */
function computeNavratnost({ input, config, kola, porizeni, zkouska, souhrn }) {
  if (!souhrn.pocetKol) return null;
  const vychozi = navratnostVychozi(config);
  const nv = input.navratnost || { sezonaDni: vychozi.sezonaDni, vytizenost: vychozi.vytizenost, cenaDen: { ...vychozi.cenaDen }, platceDph: true };
  const dph = Number.isFinite(vychozi.dph) ? vychozi.dph : NAVRATNOST_VYCHOZI.dph;
  const platce = nv.platceDph !== false;
  const faktorVydaju = platce ? 1 : 1 + dph; // neplátce si DPH z našich cen neodečte
  const isZkouska = !!zkouska;
  const isKoupe = porizeni.typ === 'koupe';
  const dny = isZkouska ? Math.min(nv.sezonaDni, zkouska.mesice * 30) : nv.sezonaDni;
  const vyt = nv.vytizenost;
  const vytText = `${Math.round(vyt * 100)} %`;

  const tridy = kola.map((k, idx) => {
    const cenaDen = nv.cenaDen[k.id];
    const trzbaDen = r0(platce ? cenaDen / (1 + dph) : cenaDen);
    const vypujcniDny = r0(k.pocet * dny * vyt);
    const radek = porizeni.radky[idx] || { zaKolo: 0 };
    const zaObdobi = isKoupe ? radek.zaKolo : isZkouska ? radek.zaKolo * zkouska.mesice : radek.zaKolo * 12;
    const vydajNaKolo = r0(zaObdobi * faktorVydaju);
    const dnyNaKolo = r0(dny * vyt);
    const vypujcekNaZaplaceni = trzbaDen > 0 ? Math.ceil(vydajNaKolo / trzbaDen) : null;
    return {
      id: k.id,
      nazev: k.nazev,
      pocet: k.pocet,
      cenaDen,
      trzbaDen,
      vypujcniDny,
      trzby: vypujcniDny * trzbaDen,
      vydajNaKolo,
      dnyNaKolo,
      vypujcekNaZaplaceni,
      vydelaNaKolo: dnyNaKolo * trzbaDen - vydajNaKolo,
      sezonNaZaplaceni: vypujcekNaZaplaceni !== null && dnyNaKolo > 0 ? Math.round((vypujcekNaZaplaceni / dnyNaKolo) * 10) / 10 : null,
    };
  });
  const vypujcniDny = tridy.reduce((a, t) => a + t.vypujcniDny, 0);
  const trzby = tridy.reduce((a, t) => a + t.trzby, 0);
  const provozRok = r0((12 * souhrn.mesicne + souhrn.rocne) * faktorVydaju);
  const vydajePrvniRok = isZkouska ? r0(souhrn.horizonty[0].castka * faktorVydaju) : r0((souhrn.jednorazove + 12 * souhrn.mesicne + souhrn.rocne) * faktorVydaju);
  const vysledekPrvniRok = trzby - vydajePrvniRok;
  const vydajeDalsiRoky = isZkouska ? null : provozRok;
  const trzbyDalsiRoky = isZkouska ? null : trzby;
  const vysledekDalsiRoky = isZkouska ? null : trzby - provozRok;

  // bod zvratu: výpůjční dny celkem, které při průměrné tržbě za den (vážené počty kol) pokryjí výdaje prvního roku / zkoušky
  const prumernaTrzbaDen = tridy.reduce((a, t) => a + t.pocet * t.trzbaDen, 0) / souhrn.pocetKol;
  const kapacita = souhrn.pocetKol * dny;
  let bodZvratu = null;
  if (prumernaTrzbaDen > 0 && kapacita > 0) {
    const bzDny = Math.ceil(vydajePrvniRok / prumernaTrzbaDen);
    bodZvratu = { vypujcniDny: bzDny, vytizenost: bzDny / kapacita, kapacitaDni: kapacita, dosazitelny: bzDny <= kapacita };
  }

  // koupě: za kolik sezón se vrátí jednorázová investice z ročního výsledku provozu
  let navratnostSezon = null;
  let navratnostText = null;
  if (isKoupe) {
    const jednorazove = r0(souhrn.jednorazove * faktorVydaju);
    const rocniPrebytek = trzby - provozRok;
    if (rocniPrebytek > 0) {
      navratnostSezon = Math.round((jednorazove / rocniPrebytek) * 10) / 10;
      navratnostText = `Investice ${kcText(jednorazove)} se vrátí za ${sezonyText(navratnostSezon)}.`;
    } else navratnostText = `Při ${vytText} vytíženosti tržby nepokryjí ani roční provoz – investice ${kcText(jednorazove)} se nevrátí.`;
  }

  const zisk = (bz) => (bz && bz.dosazitelny ? `zisk začíná od ${procentNahoru(bz.vytizenost)} % vytíženosti` : 'výdaje nepokryje ani plná vytíženost');
  let veta;
  let poznamkaDalsiRoky = null;
  if (isZkouska) {
    const obdobi = `za zkoušku (${zkouska.mesice} měsíce, ${dny} dní sezóny)`;
    veta = vysledekPrvniRok >= 0 ? `Při ${vytText} vytíženosti vyděláte ${obdobi} ${kcText(vysledekPrvniRok)}.` : `Při ${vytText} vytíženosti vychází zkouška se ztrátou ${kcText(-vysledekPrvniRok)} ${obdobi.replace('za zkoušku ', '')}; ${zisk(bodZvratu)}.`;
    poznamkaDalsiRoky = 'Další roky u zkoušky nepočítáme – po zkoušce se rozhodnete podle skutečné vytíženosti (pronájem, odkup, nebo vrácení kol).';
  } else {
    const dalsi = vysledekDalsiRoky >= 0 ? `od druhého roku ${kcText(vysledekDalsiRoky)} ročně` : `od druhého roku ztráta ${kcText(-vysledekDalsiRoky)} ročně`;
    veta = vysledekPrvniRok >= 0
      ? `Při ${vytText} vytíženosti vyděláte za první rok ${kcText(vysledekPrvniRok)}, ${dalsi}.`
      : `Při ${vytText} vytíženosti vychází první rok se ztrátou ${kcText(-vysledekPrvniRok)}; ${zisk(bodZvratu)}${vysledekDalsiRoky >= 0 ? `. Od druhého roku vyděláte ${kcText(vysledekDalsiRoky)} ročně` : `, ${dalsi}`}.`;
  }

  return {
    typ: porizeni.typ,
    vstupy: { sezonaDni: nv.sezonaDni, vytizenost: vyt, cenaDen: { ...nv.cenaDen }, platceDph: platce, dph, dnyPokryte: dny },
    cenyVcetneDph: !platce,
    tridy,
    vypujcniDny,
    trzby,
    vydajePrvniRok,
    vysledekPrvniRok,
    trzbyDalsiRoky,
    vydajeDalsiRoky,
    vysledekDalsiRoky,
    prumernaTrzbaDen: Math.round(prumernaTrzbaDen * 100) / 100,
    bodZvratu,
    navratnostSezon,
    navratnostText,
    veta,
    poznamkaDalsiRoky,
  };
}

/** Výsledek bez interních čísel. */
function publicResult(result) {
  if (!result) return result;
  const { interni, ...rest } = result;
  // meta bez příznaků o interním souboru (veřejnost nemá vědět ani to, zda existuje)
  if (rest.meta) {
    const { nakupniCenyOdvozene, nakupniCenyZeSouboru, ...meta } = rest.meta;
    rest.meta = meta;
  }
  return rest;
}

/**
 * Interní tabulka konkrétních modelů (jen pro admin pohled): veřejná cena s DPH → bez DPH, nákupní cena z interního
 * souboru, marže. Modely bez nákupní ceny v souboru mají nakupniCena null.
 * @param {Array<{slug, znacka, model, cenaVerejna}>} modely  z config/kola-modely.json
 * @param {object} config  z validateConfig
 * @param {number} dph  sazba DPH (0.21)
 */
function modelyInterni(modely, config, dph = 0.21) {
  const nakup = (config && config.interni && config.interni.modelyNakup) || {};
  return (Array.isArray(modely) ? modely : []).map((m) => {
    const bezDph = r0(Number(m.cenaVerejna || 0) / (1 + dph));
    const n = Object.prototype.hasOwnProperty.call(nakup, m.slug) ? nakup[m.slug] : null;
    const marze = n === null ? null : bezDph - n;
    return { slug: m.slug, nazev: `${m.znacka || ''} ${m.model || ''}`.trim(), tridaNabidky: m.tridaNabidky || null, cenaVerejna: r0(m.cenaVerejna), cenaBezDph: bezDph, nakupniCena: n, marze, marzeProcent: marze === null || bezDph <= 0 ? null : marze / bezDph };
  });
}

/**
 * Modelové příklady pro každý množstevní stupeň (config.modelovePriklady = [{ stupen, kola: { slug: pocet } }]) nad
 * skutečnými modely z config/kola-modely.json. Prodejní cena modelu = veřejná cena výrobce bez DPH, zůstatková po 36 m
 * stejným podílem jako třída e-kol, nákupní cena z interního souboru (chybí-li, odhad jako u tříd). Pro výpočet se modely
 * příkladu sloučí do jedné „třídy“ s váženým průměrem cen a pustí se stejný compute() jako v konfigurátoru (výpočet je
 * v cenách kol lineární – rozdíl proti součtu po modelech je jen v zaokrouhlení na celé Kč za kolo). Varianty: zkouška,
 * pronájem 36 m a koupě; vždy s webem ze šablony, vlastní správou a servisem, bez doplňků, návratnost s výchozím odhadem
 * z config.navratnost. Vrací pole { stupen, odKol, nazevStupne, pocet, kola[], varianty{}, interni{} } – `interni`
 * (marže, nákupní ceny) volající u veřejného výstupu odstraní (verejnePriklady).
 */
function modelovePriklady(config, modely, { dph } = {}) {
  const defs = Array.isArray(config && config.modelovePriklady) ? config.modelovePriklady : [];
  if (!defs.length) return [];
  const bySlug = Object.fromEntries((Array.isArray(modely) ? modely : []).map((m) => [m.slug, m]));
  const ek = config.tridyKol.find((t) => t.id === 'ekolo');
  const zustPodil = ek && ek.prodejniCena > 0 ? ek.zustatkova36m / ek.prodejniCena : 0.3;
  const prah = config.interni.prahMarzeProcent;
  const nakup = config.interni.modelyNakup || {};
  const sazba = Number.isFinite(dph) ? dph : (config.navratnost && config.navratnost.dph) || NAVRATNOST_VYCHOZI.dph;
  const out = [];
  for (const p of defs) {
    const radky = [];
    for (const [slug, pocet] of Object.entries(p.kola || {})) {
      const m = bySlug[slug];
      if (!m || !(pocet > 0)) continue;
      const prodejni = r0(Number(m.cenaVerejna || 0) / (1 + sazba));
      const zeSouboru = Object.prototype.hasOwnProperty.call(nakup, slug);
      radky.push({ slug, nazev: `${m.znacka || ''} ${m.model || ''}`.trim(), pocet, cenaVerejna: r0(m.cenaVerejna), prodejni, nakupni: zeSouboru ? nakup[slug] : r0(prodejni * (1 - prah)), odvozena: !zeSouboru, zustatkova36m: r0(prodejni * zustPodil) });
    }
    const pocet = sum(radky, 'pocet');
    if (!pocet) continue;
    const prumer = (k) => r0(radky.reduce((a, r) => a + r[k] * r.pocet, 0) / pocet);
    const odvozene = radky.some((r) => r.odvozena);
    const trida = { ...ek, nazev: 'Elektrokola z příkladu', prodejniCena: prumer('prodejni'), nakupniCena: prumer('nakupni'), zustatkova36m: prumer('zustatkova36m'), nakupniCenaOdvozena: odvozene };
    const cfg = { ...config, tridyKol: config.tridyKol.map((t) => (t.id === 'ekolo' ? trida : t)), meta: { ...config.meta, nakupniCenyOdvozene: odvozene } };
    const stupen = stupenPro(config, pocet);
    const varianty = {};
    const interni = { nakupniOdvozene: odvozene, kola: radky.map((r) => ({ slug: r.slug, nazev: r.nazev, pocet: r.pocet, nakupniCena: r.nakupni, odvozena: r.odvozena })) };
    for (const porizeni of ['zkouska', 'pronajem36', 'koupe']) {
      const res = compute(normalizeInput({ ekolo: String(pocet), porizeni }, cfg), cfg);
      const n = res.navratnost;
      const s = res.souhrn;
      if (porizeni === 'zkouska') {
        varianty.zkouska = { mesice: res.zkouska.mesice, mesicne: s.mesicne, celkem: s.horizonty[0].castka, rozjezd: res.zkouska.rozjezd, kauce: s.kauce, vysledek: n.vysledekPrvniRok, trzby: n.trzby };
      } else if (porizeni === 'pronajem36') {
        varianty.pronajem36 = { mesicne: s.mesicne, jednorazove: s.jednorazove, rok: s.horizonty[0].castka, tri: s.horizonty[1].castka, kauce: s.kauce, vysledekPrvniRok: n.vysledekPrvniRok, vysledekDalsiRoky: n.vysledekDalsiRoky, trzby: n.trzby };
      } else {
        varianty.koupe = { kola: res.porizeni.jednorazove, jednorazove: s.jednorazove, mesicne: s.mesicne, navratnostSezon: n.navratnostSezon, vysledekDalsiRoky: n.vysledekDalsiRoky, trzby: n.trzby };
      }
      interni[porizeni] = { horizontMesice: res.interni.horizontMesice, trzby: res.interni.trzby, naklady: res.interni.naklady, marze: res.interni.marze, marzeProcent: res.interni.marzeProcent, nakupniCelkem: res.interni.nakupniCelkem };
    }
    out.push({
      stupen: stupen.nazev || String(stupen.odKol),
      odKol: stupen.odKol,
      sleva: stupen.sleva,
      slevaKoupe: stupen.slevaKoupe,
      pocet,
      kola: radky.map((r) => ({ slug: r.slug, nazev: r.nazev, pocet: r.pocet, cenaVerejna: r.cenaVerejna })),
      cenaDen: (cfg.navratnost || NAVRATNOST_VYCHOZI).cenaDen.ekolo,
      sezonaDni: (cfg.navratnost || NAVRATNOST_VYCHOZI).sezonaDni,
      vytizenost: (cfg.navratnost || NAVRATNOST_VYCHOZI).vytizenost,
      varianty,
      interni,
    });
  }
  return out;
}

/** Modelové příklady bez interních čísel (pro veřejnost). */
function verejnePriklady(priklady) {
  return (priklady || []).map(({ interni, ...rest }) => rest);
}

/** Množstevní stupeň pro počet kol: nejvyšší stupeň s odKol ≤ pocet (pod minimem první stupeň). */
function stupenPro(config, pocet) {
  const stupne = config.mnozstevniSlevy;
  let st = stupne[0];
  for (const x of stupne) if (pocet >= x.odKol) st = x;
  return st;
}

/** Doplňky dostupné pro vstup (jenEkolo jen s e-koly). */
function availableDoplnky(config, input) {
  return config.doplnky.filter((d) => !d.jenEkolo || (input && input.kola.ekolo > 0));
}

module.exports = {
  zustatkova,
  publicDescription,
  PORIZENI,
  WEB,
  SPRAVA,
  SERVIS,
  TRIDY,
  MAX_KOL,
  NAVRATNOST_VYCHOZI,
  NAVRATNOST_ROZSAHY,
  PORIZENI_LABELS,
  WEB_LABELS,
  SPRAVA_LABELS,
  SERVIS_LABELS,
  validateConfig,
  normalizeInput,
  inputToQuery,
  annuity,
  monthlyRate,
  compute,
  publicResult,
  sezonyText,
  procentNahoru,
  modelyInterni,
  modelovePriklady,
  verejnePriklady,
  stupenPro,
  availableDoplnky,
  pct,
};
