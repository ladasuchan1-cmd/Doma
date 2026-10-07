'use strict';
// Stránky feature „nabídka“ (konfigurátor pro hotely, penziony a půjčovny). Vstup: data z src/features/nabidka.js
// (config = validovaná konfigurace cen, input = normalizovaný vstup, result = výsledek compute() – bez `interni`, pokud
// internal=false). Výstup: Html těla stránek. Vlastní pomocné komponenty (volby s radio, karty tříd) používají jen
// třídy nab-* stylované v public/css/nabidka.css přes tokeny base.css; ostatní z components.js.
//   nabidka(data)          konfigurátor: 6 kroků v GET formuláři (6. = kalkulačka „Vyplatí se to?“) + sticky souhrn
//                          + formulář poptávky
//   summaryFragment(data)  souhrn (SSR i pro živý přepočet přes /api/v1/nabidka/spocitat → `html`), vč. bloku návratnosti
//   dekujeme(data)         rekapitulace odeslané poptávky s číslem
//   unavailable(data)      „nabídka se připravuje“ (chybí / chybná konfigurace cen)

const { html, raw, attr } = require('../html');
const c = require('../components');
const format = require('../format');
const domain = require('../../domain/nabidka');

const STEPS = ['Kola', 'Způsob pořízení', 'Web', 'Správa a servis', 'Doplňky', 'Vyplatí se to?'];
const STEP_IDS = ['krok-kola', 'krok-porizeni', 'krok-web', 'krok-sprava', 'krok-doplnky', 'krok-navratnost'];

/** Navigace kroků: odkazy na sekce formuláře (souhrn vpravo se přepočítává s každou změnou v kroku). */
function stepsNav() {
  return html`<nav aria-label="Kroky konfigurátoru"><ol class="steps nab-steps">${STEPS.map((label, i) => html`<li class="steps__item"><a class="steps__link" href="#${STEP_IDS[i]}"><span class="steps__num" aria-hidden="true">${i + 1}</span><span class="steps__label">${label}</span></a></li>`)}</ol></nav>`;
}

/** Částka v Kč (celé) → „12 900 Kč“. */
function kc(n) {
  return format.money(Math.round(Number(n) || 0) * 100);
}

function pctText(p) {
  return `${Math.round((Number(p) || 0) * 100)} %`;
}

/** „06-15“ → „15. 6.“; „2027-06-15“ → „15. 6. 2027“. */
function startText(s) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (m) return `${Number(m[2])}. ${Number(m[1])}.`;
  return format.date(s) || String(s || '');
}

/** Rozsah procent přes množstevní stupně (např. „5–10 %“); bez stupňů výchozí hodnota. */
function rozsahProcent(config, key, vychozi) {
  const vals = (config.mnozstevniSlevy || []).map((st) => (st[key] ?? vychozi)).filter((v) => typeof v === 'number');
  if (!vals.length) return pctText(vychozi);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return lo === hi ? pctText(lo) : `${Math.round(lo * 100)}–${pctText(hi)}`;
}
function kauceRozsah(config, vychozi) {
  return rozsahProcent(config, 'kauceProcent', vychozi);
}
function zalohaRozsah(config) {
  return rozsahProcent(config, 'zalohaZkouskyProcent', config.zkouska.zalohaProcent);
}
/** „; poplatek za rozjezd 7 900 Kč (od 10 kol zdarma)“ podle stupňů. */
function poplatekText(config) {
  const st = config.mnozstevniSlevy || [];
  const max = Math.max(0, ...st.map((x) => x.poplatekZkousky || 0));
  if (!max) return '';
  const zdarma = st.find((x) => !x.poplatekZkousky && x.odKol > st[0].odKol);
  return `, jednorázový poplatek za rozjezd (web, zaškolení) nejvýše ${kc(max)}${zdarma ? ` – od ${zdarma.odKol} kol zdarma` : ''}`;
}

/** Volba (radio) jako karta. */
function choice({ name, value, checked, title, text, badge: badgeText, badgeTone, meta, disabled }) {
  const id = `f-${name}-${value}`;
  return html`<label class="${checked ? 'nab-choice is-checked' : 'nab-choice'}" for="${id}">
  <input class="nab-choice__input" type="radio"${attr({ id, name, value, checked: !!checked, disabled: !!disabled })}>
  <span class="nab-choice__body">
    <span class="nab-choice__head"><strong class="nab-choice__title">${title}</strong>${badgeText ? c.badge(badgeText, badgeTone || 'info') : ''}</span>
    ${text ? html`<span class="nab-choice__text">${text}</span>` : ''}
    ${meta ? html`<span class="nab-choice__meta">${meta}</span>` : ''}
  </span>
</label>`;
}

function choiceGroup(children, { label }) {
  return html`<fieldset class="nab-choices"><legend class="visually-hidden">${label}</legend>${children}</fieldset>`;
}

// ---------------------------------------------------------------------------------------------------------
// Kroky

function stepKola({ config, input, modely = [], priklady = [], internal = false }) {
  const cards = config.tridyKol.map((t) => {
    const priklady = modely.filter((m) => m.tridaNabidky === t.id);
    return html`<article class="nab-class">
  <div class="nab-class__body">
    <h3 class="nab-class__title">${t.nazev}</h3>
    <p class="nab-class__text">${t.popisVerejny || t.popis}</p>
    <p class="nab-class__price">Prodejní cena ${kc(t.prodejniCena)} / kolo</p>
    ${priklady.length ? html`<p class="nab-class__examples">Např. ${priklady.map((m, i) => html`${i ? ', ' : ''}<a href="#modely">${m.znacka} ${m.model}</a>`)}</p>` : ''}
  </div>
  ${c.field({ label: 'Počet kusů', name: t.id, type: 'number', value: input.kola[t.id], min: 0, max: domain.MAX_KOL, step: 1, inputmode: 'numeric', attrs: { 'data-nabidka-count': t.id } })}
</article>`;
  });
  const stupne = config.mnozstevniSlevy || [];
  const n = input.kola.zakladni + input.kola.trek + input.kola.ekolo;
  const vyber = stupne.length ? stupne.reduce((a, st) => (n >= st.odKol ? st : a), null) : null;
  const tiers = stupne.length > 1
    ? html`<div class="nab-tiers" data-nabidka-tiers>
  <h3 class="nab-tiers__title">Čím víc kol, tím lepší podmínky</h3>
  <ol class="nab-tiers__list">${stupne.map((st, i) => {
    const doKol = stupne[i + 1] ? stupne[i + 1].odKol - 1 : null;
    const active = vyber === st;
    const preset = { ...input, kola: { zakladni: 0, trek: 0, ekolo: st.odKol } };
    return html`<li class="${active ? 'nab-tier is-active' : 'nab-tier'}" data-od="${st.odKol}"${attr({ 'aria-current': active ? 'true' : null })}>
    <p class="nab-tier__range">${doKol ? `${st.odKol}–${doKol} kol` : `${st.odKol} a více kol`}${st.nazev ? html` <span class="nab-tier__name">${st.nazev}</span>` : ''}</p>
    <p class="nab-tier__discount">${st.sleva ? `−${pctText(st.sleva)}` : 'základní cena'}</p>
    ${st.vyhody.length ? html`<ul class="nab-tier__perks">${st.vyhody.map((v) => html`<li>${v}</li>`)}</ul>` : ''}
    <a class="nab-tier__pick" href="/nabidka?${domain.inputToQuery(preset)}#krok-kola" data-nabidka-preset="${st.odKol}">Spočítat pro ${format.plural(st.odKol, 'kolo', 'kola', 'kol')}</a>
  </li>`;
  })}</ol>
  <p class="nab-muted">Stupeň se počítá z celkového počtu kol všech tříd dohromady. Nabídku sestavujeme od ${stupne[0].odKol} kol. Tlačítkem „Spočítat“ si stupeň dosadíte do konfigurátoru (jako elektrokola) a souhrn vpravo se přepočítá.</p>
</div>`
    : '';
  return c.section({ id: 'krok-kola', eyebrow: 'Krok 1', title: 'Kolik kol a jakých', lead: `Zadejte počty kusů podle tříd – stačí ${stupne.length ? stupne[0].odKol : 1} kola. Mix tříd je běžný: základní kola pro většinu hostů, elektrokola pro náročnější výlety.`, children: html`${c.grid(cards, 3)}${tiers}${prikladyBlock({ priklady, internal })}`, variant: 'nab-step' });
}

/** Výsledek se znaménkem a slovem pro tabulku příkladů. */
function vysledekText(n, kdy) {
  return n >= 0 ? html`<strong>${kcVysledek(n)}</strong> ${kdy}` : html`<strong>ztráta ${kc(-n)}</strong> ${kdy}`;
}

/**
 * Modelové příklady pro každý stupeň (domain.modelovePriklady): kolik zaplatí hotel ve třech způsobech pořízení a jestli
 * se mu to vyplatí; s interním pohledem (jen správce platformy) i naše marže a horizont.
 */
function prikladyBlock({ priklady = [], internal = false }) {
  if (!priklady.length) return '';
  const p0 = priklady[0];
  const card = (p) => {
    const v = p.varianty;
    const rows = [
      [html`<strong>Zkouška ${v.zkouska.mesice} měsíce</strong>`, html`${kc(v.zkouska.celkem)} celkem<br><small class="nab-muted">${kc(v.zkouska.mesicne)}/měs.${v.zkouska.rozjezd ? html` + rozjezd ${kc(v.zkouska.rozjezd)}` : ''}</small>`, vysledekText(v.zkouska.vysledek, 'za zkoušku')],
      [html`<strong>Pronájem 36 měsíců</strong>`, html`${kc(v.pronajem36.mesicne)}/měs.<br><small class="nab-muted">+ web ${kc(v.pronajem36.jednorazove)} jednorázově; za 3 roky ${kc(v.pronajem36.tri)}</small>`, html`${vysledekText(v.pronajem36.vysledekDalsiRoky, 'ročně')}<br><small class="nab-muted">první rok ${kcVysledek(v.pronajem36.vysledekPrvniRok)}</small>`],
      [html`<strong>Koupě</strong>`, html`${kc(v.koupe.jednorazove)} jednorázově<br><small class="nab-muted">kola ${kc(v.koupe.kola)}${p.slevaKoupe ? ` (po slevě ${pctText(p.slevaKoupe)})` : ''} + web; pak ${kc(v.koupe.mesicne)}/měs.</small>`, v.koupe.navratnostSezon !== null ? html`vrátí se za <strong>${domain.sezonyText(v.koupe.navratnostSezon)}</strong><br><small class="nab-muted">pak ${kcVysledek(v.koupe.vysledekDalsiRoky)} ročně</small>` : html`<strong>nevrátí se</strong>`],
    ];
    const i = p.interni;
    const horizont = (x, typ) => (typ === 'zkouska' ? `${x.horizontMesice} měsíce` : typ === 'koupe' ? `kola hned, web ${x.horizontMesice} měsíců` : `${x.horizontMesice} měsíců`);
    return html`<article class="nab-example">
  <header class="nab-example__head">
    <p class="nab-example__tier">${p.stupen} · ${format.plural(p.pocet, 'kolo', 'kola', 'kol')}${p.sleva ? html` <span class="nab-example__discount">−${pctText(p.sleva)}</span>` : ''}</p>
    <ul class="nab-example__bikes">${p.kola.map((k) => html`<li>${k.pocet}× <a href="/kola/${k.slug}">${k.nazev}</a> <small class="nab-muted">${kc(k.cenaVerejna)}</small></li>`)}</ul>
  </header>
  ${c.table({ compact: true, head: ['Pořízení', 'Hotel platí', 'Vyplatí se?'], rows })}
  ${internal && i
    ? html`<div class="nab-example__internal">
    ${c.table({ compact: true, caption: html`${c.badge('Interně', 'warning')} Naše marže a horizont`, head: ['Pořízení', 'Tržby', 'Marže', 'Za'], rows: [['zkouska', 'Zkouška'], ['pronajem36', 'Pronájem 36 m'], ['koupe', 'Koupě']].map(([id, label]) => [label, { value: kc(i[id].trzby), align: 'right' }, { value: html`<strong>${kc(i[id].marze)}</strong> <small class="nab-muted">(${pctText(i[id].marzeProcent)})</small>`, align: 'right' }, horizont(i[id], id)]) })}
    <p class="nab-muted">Nákupní ceny: ${i.kola.map((k) => `${k.pocet}× ${k.nazev} ${kc(k.nakupniCena)}${k.odvozena ? ' (odhad)' : ''}`).join(', ')}. Zkouška: kola zůstávají naše (ex-demo prodej). Koupě: marže z kol jednorázově + web po dobu 36 měsíců.</p>
  </div>`
    : ''}
</article>`;
  };
  return html`<div class="nab-examples" id="priklady">
  <h3 class="nab-tiers__title">Modelové příklady se skutečnými koly</h3>
  <p class="nab-muted">Elektrokola Superior a Rock Machine za aktuální ceny výrobce (bez DPH), rezervační web ze šablony, vlastní správa a servis. „Vyplatí se?“ počítá s ${p0.sezonaDni} dny sezóny, vytížeností ${Math.round(p0.vytizenost * 100)} % a cenou ${kc(p0.cenaDen)} za den pro hosta (vč. DPH) – v kroku 6 si odhad upravíte pro vlastní nabídku. Částky bez DPH.</p>
  <div class="nab-examples__grid">${priklady.map(card)}</div>
</div>`;
}

const KATEGORIE_MODELU = { ebike: 'Elektrokolo', kids: 'Dětské kolo', trek: 'Trekové kolo', mtb: 'Horské kolo', city: 'Městské kolo', gravel: 'Gravel' };

/**
 * Konkrétní modely (nástřel flotily) z config/kola-modely.json – jen veřejné údaje: název, kategorie, doporučená cena
 * výrobce vč. DPH (a běžná cena, je-li vyšší), velikosti, odkaz na výrobce a na detail v demu půjčovny.
 */
function modelySection({ modely = [], modelyMeta = {} }) {
  if (!modely.length) return '';
  const rows = modely.map((m) => [
    html`<strong>${m.znacka} ${m.model}</strong><br><small class="nab-muted">${KATEGORIE_MODELU[m.kategorie] || m.kategorie || ''}${m.tridaNabidky ? html` · třída „${(modelyMeta.tridy && modelyMeta.tridy[m.tridaNabidky]) || m.tridaNabidky}“` : ''}</small>`,
    { value: html`${kc(m.cenaVerejna)}${m.cenaKatalogova > m.cenaVerejna ? html` <small class="nab-muted">(běžně ${kc(m.cenaKatalogova)})</small>` : ''}`, align: 'right' },
    (m.velikosti || []).join(', '),
    html`<a href="/kola/${m.slug}">v půjčovně</a>${m.url ? html` · <a href="${m.url}" rel="noopener nofollow" target="_blank">u výrobce</a>` : ''}`,
  ]);
  return c.section({
    id: 'modely',
    eyebrow: 'Příklady',
    title: 'Konkrétní modely, které flotilu tvoří',
    lead: 'Nástřel kol pro první sezónu: doporučené prodejní ceny výrobce včetně DPH podle jeho webu (ke dni stažení), pro orientaci – konfigurátor počítá s třídami výše. Fotky v demu jsou ilustrační.',
    children: html`${c.table({ compact: true, head: ['Model', 'Cena výrobce vč. DPH', 'Velikosti', 'Odkazy'], rows })}${modelyMeta.stazeno ? html`<p class="nab-muted">Ceny staženy ${format.date(modelyMeta.stazeno) || modelyMeta.stazeno} z webu výrobce; mohou se měnit.</p>` : ''}`,
    variant: 'nab-step',
  });
}

function stepPorizeni({ config, input }) {
  const z = config.zkouska;
  const items = [
    choice({ name: 'porizeni', value: 'zkouska', checked: input.porizeni === 'zkouska', title: 'Zkušební období 4 měsíce', badge: 'bez dlouhého závazku', badgeTone: 'success', text: `Vyzkoušíte si celý provoz na jednu sezónu. Platíte ${z.mesice} měsíční splátky, záloha ${zalohaRozsah(config)} předem podle počtu kol${poplatekText(config)}. Po skončení kola vrátíte, odkoupíte za ${pctText(z.odkupPoZkousceProcentProdejni)} prodejní ceny, nebo přejdete na pronájem – započteme ${pctText(z.zapocetPriPokracovaniProcent)} zaplaceného.`, meta: `V ceně: ${z.vCene.join(', ')}.${z.startNejpozdeji ? ` Start nejpozději ${startText(z.startNejpozdeji)} – aby zkouška pokryla sezónu.` : ''}` }),
    choice({ name: 'porizeni', value: 'pronajem36', checked: input.porizeni === 'pronajem36', title: 'Pronájem na 36 měsíců', text: `Nejnižší měsíční splátka, kola po celou dobu servisujeme my${config.pronajem.servisVCene ? ' (servis v ceně)' : ''}. Vratná kauce ${kauceRozsah(config, config.pronajem.kauceProcent)} prodejní ceny podle počtu kol, od ${config.pronajem.minKol} kol.` }),
    choice({ name: 'porizeni', value: 'pronajem24', checked: input.porizeni === 'pronajem24', title: 'Pronájem na 24 měsíců', text: `Kratší závazek, po dvou sezónách obměna za nové modely. Vratná kauce ${kauceRozsah(config, config.pronajem.kauceProcent)} prodejní ceny podle počtu kol, od ${config.pronajem.minKol} kol.` }),
    choice({ name: 'porizeni', value: 'koupe', checked: input.porizeni === 'koupe', title: 'Koupě', text: `Kola jsou od začátku vaše – nejnižší celkové náklady při provozu delším než tři sezóny. Bez kauce${config.mnozstevniSlevy && config.mnozstevniSlevy[0].odKol > 1 ? `, od ${config.mnozstevniSlevy[0].odKol} kol` : ''}; množstevní sleva podle počtu kol.` }),
  ];
  return c.section({ id: 'krok-porizeni', eyebrow: 'Krok 2', title: 'Jak kola pořídíte', lead: 'Zkušební období je nejčastější první krok: bez dlouhého závazku zjistíte, kolik kol hosté skutečně využijí.', children: choiceGroup(items, { label: 'Způsob pořízení' }), variant: 'nab-step' });
}

function stepWeb({ config, input }) {
  const w = config.web;
  const items = [
    choice({ name: 'web', value: 'sablona', checked: input.web === 'sablona', title: 'Rezervační web ze šablony', text: `Hotový rezervační web s online platbami, správou a výdejem – vyberete si jeden ze tří designů (${html`<a href="/design">ukázky</a>`}) a doplníte logo, texty a fotky. Z vašeho webu na něj povede odkaz nebo tlačítko „Půjčit kolo“. Nasazení do týdne.`, meta: `${kc(w.sablona.jednorazove)} jednorázově + ${kc(w.sablona.mesicne)} měsíčně${input.porizeni === 'zkouska' ? ' · ve zkušebním období v ceně' : ''}` }),
    choice({ name: 'web', value: 'namiru', checked: input.web === 'namiru', title: 'Web na míru', text: 'Vlastní design, vlastní doména a úpravy podle vašeho ubytování. Rezervace kol běží samostatně – na váš stávající web jen přidáte odkaz nebo tlačítko „Půjčit kolo“, žádné propojení systémů.', meta: `od ${kc(w.naMiru.jednorazoveOd)} jednorázově + ${kc(w.naMiru.mesicne)} měsíčně` }),
    choice({ name: 'web', value: 'zadny', checked: input.web === 'zadny', title: 'Bez webu – jen kola', text: 'Kola půjčujete ručně na recepci bez online rezervací.' }),
  ];
  return c.section({
    id: 'krok-web',
    eyebrow: 'Krok 3',
    title: 'Rezervační web',
    lead: 'Hosté si kola rezervují sami, zaplatí rezervační poplatek a recepce jen vydává. Tři designy si prohlédněte na stránce Design.',
    children: html`${choiceGroup(items, { label: 'Web' })}
${c.field({ label: html`Chci i druhý design webu (např. pro sezónu) – ${kc(w.dalsiDesignJednorazove)} jednorázově`, name: 'dalsiDesign', type: 'checkbox', value: '1', checked: input.dalsiDesign, hint: 'Platí jen pro web ze šablony.' })}`,
    variant: 'nab-step',
  });
}

function stepSprava({ config, input }) {
  const sp = config.sprava.predplacena;
  const sv = config.servis;
  const sprava = [
    choice({ name: 'sprava', value: 'sami', checked: input.sprava === 'sami', title: 'Správu si zajistíte sami', text: 'Rezervace, ceník, kola a texty spravujete v administraci; zaškolení obsluhy je součástí nasazení.', meta: kc(config.sprava.sami.mesicne) + ' měsíčně' }),
    choice({ name: 'sprava', value: 'predplacena', checked: input.sprava === 'predplacena', title: 'Předplacená správa', text: `Spravujeme ceník, sezóny a obsah za vás; ${sp.konzultaceZdarmaMesicne}× měsíčně konzultace v ceně, další ${kc(sp.dalsiKonzultaceHodina)}/hod.`, meta: `${kc(sp.mesicne)} měsíčně` }),
  ];
  const servis = [
    choice({ name: 'servis', value: 'vlastni', checked: input.servis === 'vlastni', title: 'Vlastní servis', text: `Kola servisuje vaše údržba; náhradní díly od nás se slevou ${pctText(sv.vlastni.slevaNaDilyProcent)}.`, meta: kc(sv.vlastni.mesicne) + ' měsíčně' }),
    choice({ name: 'servis', value: 'partner', checked: input.servis === 'partner', title: 'Partnerský servis v okolí', text: `Smluvní servis ve vašem okolí: pravidelná péče, opravy do ${sv.partner.slaHodin} hodin a sezónní prohlídka.`, meta: `${kc(sv.partner.mesicneZaKolo)} / kolo měsíčně + ${kc(sv.partner.sezonniProhlidkaZaKolo)} / kolo ročně` }),
  ];
  return c.section({
    id: 'krok-sprava',
    eyebrow: 'Krok 4',
    title: 'Správa a servis',
    children: html`<h3 class="nab-subtitle">Správa webu a rezervací</h3>${choiceGroup(sprava, { label: 'Správa' })}<h3 class="nab-subtitle">Servis kol</h3>${choiceGroup(servis, { label: 'Servis' })}`,
    variant: 'nab-step',
  });
}

function stepDoplnky({ config, input }) {
  const n = input.kola.zakladni + input.kola.trek + input.kola.ekolo;
  const items = config.doplnky.map((d) => {
    const parts = [];
    if (d.jednorazove) parts.push(`${kc(d.jednorazove)} jednorázově`);
    if (d.jednorazoveZaKolo) parts.push(`${kc(d.jednorazoveZaKolo)} / kolo jednorázově`);
    if (d.mesicneZaKolo) parts.push(`${kc(d.mesicneZaKolo)} / kolo měsíčně`);
    const unavailable = d.jenEkolo && input.kola.ekolo === 0;
    return c.field({
      label: html`${d.nazev}${d.jenEkolo ? html` ${c.badge('jen e-kola', 'info')}` : ''}`,
      name: 'doplnky',
      type: 'checkbox',
      value: d.id,
      checked: input.doplnky.includes(d.id),
      disabled: unavailable,
      id: `f-doplnky-${d.id}`,
      hint: `${parts.join(' + ') || 'v ceně'}${unavailable ? ' · dostupné po přidání elektrokol' : ''}`,
      attrs: { 'data-nabidka-jen-ekolo': d.jenEkolo ? '1' : null },
    });
  });
  const domluva = config.naDomluvu || [];
  return c.section({ id: 'krok-doplnky', eyebrow: 'Krok 5', title: 'Doplňky', lead: n ? `Ceny za kolo se počítají pro ${format.plural(n, 'kolo', 'kola', 'kol')} z kroku 1.` : 'Ceny za kolo se počítají podle počtu kol z kroku 1.', children: html`<div class="nab-addons">${items}</div>${domluva.length ? html`<div class="nab-domluva"><h3 class="nab-subtitle">Po individuální domluvě</h3><ul class="nab-list nab-list--bullets">${domluva.map((t) => html`<li>${t}</li>`)}</ul></div>` : ''}`, variant: 'nab-step' });
}

/** Krok 6: kalkulačka návratnosti – odhad sezóny, vytíženosti a cen pro hosta (GET parametry sezona, vytizenost, cena_*, neplatce). */
function stepNavratnost({ config, input }) {
  const R = domain.NAVRATNOST_ROZSAHY;
  const vychozi = config.navratnost || domain.NAVRATNOST_VYCHOZI;
  const nv = input.navratnost || { sezonaDni: vychozi.sezonaDni, vytizenost: vychozi.vytizenost, cenaDen: vychozi.cenaDen, platceDph: true };
  const ceny = config.tridyKol.map((t) => {
    const pocet = input.kola[t.id] || 0;
    return c.field({
      label: html`Cena pro hosta za den – ${t.nazev}`,
      name: `cena_${t.id}`,
      type: 'number',
      value: nv.cenaDen[t.id],
      min: R.cenaDen[0],
      max: R.cenaDen[1],
      step: 10,
      inputmode: 'numeric',
      hint: pocet ? `Kč vč. DPH · ve flotile ${format.plural(pocet, 'kolo', 'kola', 'kol')} této třídy` : 'Kč vč. DPH · tuto třídu zatím nemáte (0 kusů), do výpočtu nevstupuje',
      attrs: { 'data-nabidka-cena': t.id },
    });
  });
  return c.section({
    id: 'krok-navratnost',
    eyebrow: 'Krok 6',
    title: 'Vyplatí se to?',
    lead: 'Odhadněte sezónu, vytíženost a ceny půjčovného – souhrn ukáže, za kolik výpůjček se kola zaplatí a kolik vyděláte. Je to odhad pro rozhodnutí, ne slib: skutečnost záleží na počasí, hostech a cenách.',
    children: html`<div class="nab-roi-inputs">
  ${c.field({ label: 'Délka sezóny (dní)', name: 'sezona', type: 'number', value: nv.sezonaDni, min: R.sezonaDni[0], max: R.sezonaDni[1], step: 1, inputmode: 'numeric', hint: `Kolik dní v roce kola půjčujete (${R.sezonaDni[0]}–${R.sezonaDni[1]}); typicky duben–říjen ≈ 150–210.` })}
  ${c.field({ label: 'Průměrná vytíženost kol (%)', name: 'vytizenost', type: 'number', value: Math.round(nv.vytizenost * 100), min: R.vytizenostProcent[0], max: R.vytizenostProcent[1], step: 1, inputmode: 'numeric', hint: 'Kolik procent dní sezóny je průměrné kolo půjčené; 30–40 % je u ubytování běžný začátek.' })}
</div>
<h3 class="nab-subtitle">Cena půjčovného pro hosta</h3>
<div class="nab-roi-inputs">${ceny}</div>
${c.field({ label: 'Nejsme plátci DPH', name: 'neplatce', type: 'checkbox', value: '1', checked: !nv.platceDph, hint: 'Plátce: počítáme tržby bez DPH a naše ceny bez DPH. Neplátce: tržby celé, naše ceny včetně 21 % DPH (nemůžete si ji odečíst).' })}`,
    variant: 'nab-step',
  });
}

// ---------------------------------------------------------------------------------------------------------
// Souhrn

/** Kč se znaménkem pro výsledek (zisk „+12 000 Kč“, ztráta „−12 000 Kč“). */
function kcVysledek(n) {
  return n > 0 ? `+${kc(n)}` : kc(n);
}

/**
 * Verdikt „Vyplatí se to?“ nahoře v souhrnu: jedna věta ano/ne a jedno číslo, které rozhodne (výdělek za zkoušku, za rok,
 * nebo za kolik sezón se vrátí koupě) + kolik vytíženosti stačí. Podrobný rozpis je níž (navratnostBlock).
 */
function verdiktBlock(result) {
  const n = result.navratnost;
  if (!n) return '';
  let ok;
  let titulek;
  let cislo;
  if (n.typ === 'zkouska') {
    ok = n.vysledekPrvniRok >= 0;
    titulek = ok ? 'Ano, vyplatí se' : 'Takhle se zkouška nevyplatí';
    cislo = ok ? html`Za zkoušku vyděláte <strong>${kc(n.vysledekPrvniRok)}</strong>` : html`Za zkoušku ztráta <strong>${kc(-n.vysledekPrvniRok)}</strong>`;
  } else if (n.typ === 'koupe') {
    ok = n.navratnostSezon !== null;
    titulek = ok ? 'Ano, vyplatí se' : 'Takhle se koupě nevyplatí';
    cislo = ok ? html`Kola se zaplatí za <strong>${domain.sezonyText(n.navratnostSezon)}</strong>, pak ${kcVysledek(n.vysledekDalsiRoky)} ročně` : html`Tržby nepokryjí ani roční provoz`;
  } else {
    ok = n.vysledekPrvniRok >= 0 || n.vysledekDalsiRoky >= 0;
    titulek = n.vysledekPrvniRok >= 0 ? 'Ano, vyplatí se' : n.vysledekDalsiRoky >= 0 ? 'Vyplatí se od druhého roku' : 'Takhle se pronájem nevyplatí';
    cislo = html`První rok <strong>${kcVysledek(n.vysledekPrvniRok)}</strong>, další roky <strong>${kcVysledek(n.vysledekDalsiRoky)}</strong> ročně`;
  }
  const bz = n.bodZvratu;
  return html`<div class="${ok ? 'nab-verdikt' : 'nab-verdikt is-loss'}" data-nabidka-verdikt>
  <p class="nab-verdikt__title">${titulek}</p>
  <p class="nab-verdikt__value">${cislo}</p>
  <p class="nab-verdikt__note">${bz && bz.dosazitelny ? `Stačí ${domain.procentNahoru(bz.vytizenost)} % vytíženosti – odhad počítá s ${Math.round(n.vstupy.vytizenost * 100)} %.` : `Odhad: ${Math.round(n.vstupy.vytizenost * 100)} % vytíženost, ${n.vstupy.sezonaDni} dní sezóny.`} <a href="#krok-navratnost">Upravit odhad</a></p>
</div>`;
}

/** Blok „Vyplatí se to?“ v souhrnu (result.navratnost z compute; bez kol nic). */
function navratnostBlock(result) {
  const n = result.navratnost;
  if (!n) return '';
  const zk = n.typ === 'zkouska';
  const rows = [];
  rows.push([zk ? `Tržby za zkoušku (${n.vstupy.dnyPokryte} dní sezóny)` : 'Tržby za sezónu', html`${kc(n.trzby)}<small class="nab-muted">${format.plural(n.vypujcniDny, 'výpůjční den', 'výpůjční dny', 'výpůjčních dní')}</small>`]);
  rows.push([zk ? 'Náklady zkoušky (celá cena)' : 'Náklady prvního roku', kc(n.vydajePrvniRok)]);
  rows.push({ label: zk ? 'Výsledek zkoušky' : 'Výsledek prvního roku', value: kcVysledek(n.vysledekPrvniRok), strong: true });
  if (!zk && n.vysledekDalsiRoky !== null) rows.push(['Další roky (ročně)', html`${kcVysledek(n.vysledekDalsiRoky)}<small class="nab-muted">tržby ${kc(n.trzbyDalsiRoky)} − náklady ${kc(n.vydajeDalsiRoky)}</small>`]);
  if (n.bodZvratu) {
    rows.push([zk ? 'Bod zvratu zkoušky' : 'Bod zvratu prvního roku', n.bodZvratu.dosazitelny
      ? html`${format.plural(n.bodZvratu.vypujcniDny, 'výpůjční den', 'výpůjční dny', 'výpůjčních dní')}<small class="nab-muted">${domain.procentNahoru(n.bodZvratu.vytizenost)} % vytíženosti</small>`
      : html`${format.plural(n.bodZvratu.vypujcniDny, 'výpůjční den', 'výpůjční dny', 'výpůjčních dní')}<small class="nab-muted">víc, než sezóna dovolí (${format.plural(n.bodZvratu.kapacitaDni, 'den', 'dny', 'dní')})</small>`]);
  }
  for (const t of n.tridy) {
    let text;
    if (t.vypujcekNaZaplaceni === null) text = 'cena pro hosta je 0 Kč – nezaplatí se';
    else if (t.vydelaNaKolo >= 0) text = `se zaplatí za ${format.plural(t.vypujcekNaZaplaceni, 'výpůjčku', 'výpůjčky', 'výpůjček')}, pak vydělá ${kc(t.vydelaNaKolo)} za ${zk ? 'zkoušku' : 'sezónu'}`;
    else text = `se zaplatí za ${format.plural(t.vypujcekNaZaplaceni, 'výpůjčku', 'výpůjčky', 'výpůjček')}${t.sezonNaZaplaceni !== null ? ` (≈ ${domain.sezonyText(t.sezonNaZaplaceni)})` : ''}; za ${zk ? 'zkoušku' : 'sezónu'} utrží ${kc(t.dnyNaKolo * t.trzbaDen)}`;
    rows.push([`1 kolo – ${t.nazev}`, text]);
  }
  if (n.navratnostText) rows.push(['Návratnost koupě', n.navratnostText]);
  return html`<section class="nab-roi" aria-label="Vyplatí se to?" data-nabidka-navratnost>
  <h3 class="nab-summary__subtitle">Vyplatí se to? Rozpis odhadu</h3>
  <p class="${n.vysledekPrvniRok >= 0 ? 'nab-roi__lead' : 'nab-roi__lead is-loss'}">${n.veta}</p>
  ${c.summary(rows)}
  ${n.poznamkaDalsiRoky ? html`<p class="nab-muted nab-roi__note">${n.poznamkaDalsiRoky}</p>` : ''}
  <p class="nab-roi__note">Odhad pro rozhodnutí, ne slib (${n.vstupy.sezonaDni} dní sezóny, vytíženost ${Math.round(n.vstupy.vytizenost * 100)} %, ceny z kroku 6). ${n.cenyVcetneDph ? 'Neplátce DPH: tržby celé, naše ceny včetně DPH.' : 'Částky bez DPH.'} Bez nákladů na vlastní obsluhu a bez provize platební brány.</p>
</section>`;
}

function internalBlock(result, config) {
  const i = result.interni;
  if (!i) return '';
  return html`<section class="nab-internal" aria-label="Interní pohled">
  <h3 class="nab-internal__title">${c.badge('Interně', 'warning')} Naše marže <small class="nab-internal__note">(jen pro přihlášené správce, za ${i.horizontMesice} měsíců)</small></h3>
  ${c.summary([
    ['Tržby', kc(i.trzby)],
    ['Náklady', kc(i.naklady)],
    ['Podíl partnera (servis)', kc(i.podilPartnera)],
    { label: `Marže (${pctText(i.marzeProcent)}, práh ${pctText(i.prahMarzeProcent)})`, value: kc(i.marze), strong: true },
  ])}
  ${c.table({ compact: true, head: ['Položka', 'Tržby', 'Náklady', 'Marže'], rows: i.polozky.map((p) => [html`${p.label}<br><small class="nab-muted">${p.perioda}${p.poznamka ? html` · ${p.poznamka}` : ''}</small>`, { value: kc(p.trzby), align: 'right' }, { value: kc(p.naklady), align: 'right' }, { value: html`${kc(p.marze)} <small class="nab-muted">(${pctText(p.marzeProcent)})</small>`, align: 'right' }]) })}
  ${i.kola && i.kola.length ? c.table({ compact: true, caption: 'Nákupní ceny tříd (interní soubor)', head: ['Třída', 'Kusů', 'Nákupní / kolo', 'Celkem'], rows: i.kola.map((k) => [k.id, String(k.pocet), { value: html`${kc(k.nakupniCena)}${k.odvozena ? html` <small class="nab-muted">(odhad)</small>` : k.zdroj === 'flotila' ? html` <small class="nab-muted">(průměr flotily)</small>` : ''}`, align: 'right' }, { value: kc(k.nakupniCelkem), align: 'right' }]) }) : ''}
  ${i.modely && i.modely.length ? c.table({ compact: true, caption: 'Konkrétní modely: veřejná cena výrobce (bez DPH) vs. nákupní cena z interního souboru', head: ['Model', 'Bez DPH', 'Nákupní', 'Marže'], rows: i.modely.map((m) => [html`${m.nazev}${m.tridaNabidky ? html` <small class="nab-muted">(${m.tridaNabidky})</small>` : ''}`, { value: kc(m.cenaBezDph), align: 'right' }, { value: m.nakupniCena === null ? html`<span class="nab-muted">není v souboru</span>` : kc(m.nakupniCena), align: 'right' }, { value: m.marze === null ? '–' : html`${kc(m.marze)} <small class="nab-muted">(${pctText(m.marzeProcent)})</small>`, align: 'right' }]) }) : ''}
  ${i.varovani.map((v) => c.notice(v, 'warning'))}
  ${config && config.meta ? html`<p class="nab-muted nab-internal__meta">Ceník verze ${config.meta.verze}${config.meta.poznamka ? html` · ${config.meta.poznamka}` : ''}</p>` : ''}
</section>`;
}

/**
 * Souhrn nabídky. data: { result, internal, config, actions = true }. Vrací Html (vkládá se do <aside data-nabidka-summary>
 * a jako `html` v odpovědi API).
 */
function summaryFragment({ result, internal, config, actions = true, detailsOpen = !actions }) {
  const s = result.souhrn;
  const z = result.zkouska;
  const meta = result.meta || (config && config.meta) || {};
  const rows = [];
  rows.push(['Kola', result.kola.length ? html`<ul class="nab-list">${result.kola.map((k) => html`<li>${k.pocet}× ${k.nazev}</li>`)}</ul>` : html`<span class="nab-muted">zatím žádná</span>`]);
  rows.push(['Pořízení', html`${result.porizeni.label}${result.porizeni.radky.length && result.porizeni.mesicne ? html`<br><small class="nab-muted">${result.porizeni.radky.map((r) => `${r.label}: ${kc(r.zaKolo)}/měs.`).join(' · ')}</small>` : ''}`]);
  rows.push(['Web', html`${result.web.label}${result.web.vCeneZkousky ? html` ${c.badge('v ceně zkoušky', 'success')}` : ''}${result.web.dalsiDesign ? html`<br><small class="nab-muted">+ další design ${kc(result.web.dalsiDesign)}</small>` : ''}`]);
  rows.push(['Správa', html`${result.sprava.label}${result.sprava.vCeneZkousky ? html` ${c.badge('v ceně zkoušky', 'success')}` : ''}${result.sprava.poznamka ? html`<br><small class="nab-muted">${result.sprava.poznamka}</small>` : ''}`]);
  rows.push(['Servis', html`${result.servis.label}${result.servis.prohlidkaVCeneZkousky ? html` ${c.badge('prohlídka v ceně zkoušky', 'success')}` : ''}${result.servis.poznamka ? html`<br><small class="nab-muted">${result.servis.poznamka}</small>` : ''}`]);
  if (result.doplnky.length) rows.push(['Doplňky', html`<ul class="nab-list">${result.doplnky.map((d) => html`<li>${d.nazev}${d.vCeneZkousky ? html` ${c.badge('v ceně zkoušky', 'success')}` : ''}</li>`)}</ul>`]);

  const totals = [];
  totals.push(['Jednorázově', kc(s.jednorazove)]);
  totals.push([z ? `Měsíčně (${z.mesice} měsíce)` : 'Měsíčně', kc(s.mesicne)]);
  if (s.rocne) totals.push(['Ročně (sezónní prohlídky)', kc(s.rocne)]);
  const mn = result.mnozstevni;
  if (mn && mn.slevaKc) totals.push([`Množstevní sleva ${pctText(mn.sleva)}${mn.aktualni && mn.aktualni.nazev ? ` (${mn.aktualni.nazev})` : ''} – už započtena`, `−${kc(mn.slevaKc)}${mn.slevaPerioda === 'mesicne' ? ' / měs.' : ''}`]);
  if (z && z.rozjezd) totals.push(['z toho poplatek za rozjezd zkoušky', kc(z.rozjezd)]);
  if (s.kauce) totals.push(['Vratná kauce', kc(s.kauce)]);
  if (s.odkupNaKonci) totals.push([`Odkup kol na konci (volitelný, za zůstatkovou cenu)`, kc(s.odkupNaKonci)]);
  for (const h of s.horizonty) totals.push({ label: h.label, value: kc(h.castka), strong: true });

  return html`<div class="nab-summary__inner">
  <h2 class="nab-summary__title">Vaše nabídka ${meta.zastupneCeny ? c.badge('ukázkové ceny', 'warning') : ''}</h2>
  ${result.upozorneni.map((u) => c.notice(u.text, u.kod === 'zadna-kola' ? 'info' : 'warning'))}
  ${verdiktBlock(result)}
  ${c.summary(totals)}
  ${mn && mn.dalsi && !result.upozorneni.some((u) => u.kod === 'min-kol') ? html`<p class="nab-summary__upsell">Přidejte ještě <strong>${mn.dalsi.chybi} ${mn.dalsi.chybi === 1 ? 'kolo' : mn.dalsi.chybi < 5 ? 'kola' : 'kol'}</strong> a dostanete${mn.dalsi.sleva ? ` slevu ${pctText(mn.dalsi.sleva)}` : ' lepší podmínky'}${mn.dalsi.nazev ? ` (stupeň ${mn.dalsi.nazev})` : ''}.</p>` : ''}
  <details class="nab-summary__details"${attr({ open: !!detailsOpen })}><summary>Co nabídka obsahuje</summary>${c.summary(rows)}</details>
  ${z
    ? html`<div class="nab-summary__next">
    <h3 class="nab-summary__subtitle">A co po zkoušce?</h3>
    <ul class="nab-list nab-list--bullets">
      ${z.rozjezd ? html`<li>Jednorázový poplatek za rozjezd (web, zaškolení, nastavení) ${kc(z.rozjezd)}.</li>` : ''}
      <li>Za kola zaplatíte ${kc(z.celkem)}: záloha ${kc(z.zaloha)} (${pctText(z.zalohaProcent)}) při podpisu, zbytek do 30 dnů.</li>
      <li>Pokud pokračujete pronájmem, započteme <strong>${kc(z.zapocet)}</strong> (${pctText(z.zapocetProcent)} zaplaceného).</li>
      <li>Odkup kol po zkoušce za <strong>${kc(z.odkup)}</strong> (${pctText(z.odkupProcent)} prodejní ceny).</li>
      <li>Nebo kola jednoduše vrátíte – bez dalších závazků.</li>
      ${z.vCene.length ? html`<li>V ceně zkoušky: ${z.vCene.join(', ')}.</li>` : ''}
      ${z.startNejpozdeji ? html`<li>Start nejpozději ${startText(z.startNejpozdeji)}</li>` : ''}
    </ul>
  </div>`
    : ''}
  ${navratnostBlock(result)}
  <p class="nab-summary__note">Ceny jsou orientační, bez DPH${meta.platnostOd ? html`, platnost od ${format.date(meta.platnostOd)}` : ''}. Závaznou nabídku připravíme po konzultaci.</p>
  ${actions
    ? html`<div class="nab-summary__actions">
    ${c.button({ label: 'Vytisknout nabídku', variant: 'secondary', type: 'button', attrs: { 'data-nabidka-print': true } })}
    ${c.button({ label: 'Odeslat poptávku', variant: 'primary', href: '#poptavka' })}
  </div>`
    : ''}
  ${internal ? internalBlock(result, config) : ''}
</div>`;
}

// ---------------------------------------------------------------------------------------------------------
// Poptávka

function inquiryForm({ csrf, values, errors, query }) {
  const v = values || {};
  const e = errors || {};
  return c.section({
    id: 'poptavka',
    variant: 'nab-inquiry',
    title: 'Odeslat poptávku',
    lead: 'Pošleme vám závaznou nabídku na míru a domluvíme termín konzultace. Sestavená konfigurace se odešle s poptávkou.',
    children: html`${Object.keys(e).length ? c.notice('Formulář obsahuje chyby – zkontrolujte prosím označená pole.', 'danger') : ''}
${e.konfigurace ? c.notice(e.konfigurace, 'warning') : ''}
${c.form({
      action: '/nabidka/poptavka',
      method: 'post',
      csrf,
      attrs: { class: 'form nab-inquiry__form', 'data-nabidka-inquiry': true },
      children: [
        html`<input type="hidden" name="konfigurace" value="${query || ''}" data-nabidka-konfigurace>`,
        html`<div class="nab-inquiry__grid">`,
        c.field({ label: 'Název ubytování / půjčovny', name: 'nazev', type: 'text', value: v.nazev, required: true, error: e.nazev, autocomplete: 'organization', maxlength: 120 }),
        c.field({ label: 'Obec', name: 'obec', type: 'text', value: v.obec, required: true, error: e.obec, autocomplete: 'address-level2', maxlength: 80 }),
        c.field({ label: 'Kontaktní osoba', name: 'osoba', type: 'text', value: v.osoba, required: true, error: e.osoba, autocomplete: 'name', maxlength: 100 }),
        c.field({ label: 'E-mail', name: 'email', type: 'email', value: v.email, required: true, error: e.email, autocomplete: 'email', maxlength: 200 }),
        c.field({ label: 'Telefon', name: 'telefon', type: 'tel', value: v.telefon, error: e.telefon, autocomplete: 'tel', hint: 'Nepovinné – pokud chcete, abychom zavolali.', maxlength: 40 }),
        html`</div>`,
        c.field({ label: 'Poznámka', name: 'poznamka', type: 'textarea', value: v.poznamka, error: e.poznamka, rows: 4, maxlength: 2000, hint: 'Kdy chcete začít, kolik máte pokojů, zda už kola půjčujete…' }),
        html`<div class="hp" aria-hidden="true"><label for="f-web_hp">Web</label><input id="f-web_hp" type="text" name="web_hp" tabindex="-1" autocomplete="off"></div>`,
        c.field({ label: html`Beru na vědomí, že uvedené údaje použijete jen k přípravě nabídky podle <a href="/soukromi">zásad ochrany osobních údajů</a>.`, name: 'souhlas', type: 'checkbox', value: '1', checked: v.souhlas, required: true, error: e.souhlas }),
      ],
      submit: 'Odeslat poptávku',
    })}`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// Stránky

/** Konfigurátor. data: { tenant, config, input, result, internal, csrf, values, errors, query } */
function nabidka({ config, input, result, internal, csrf, values, errors, query, modely = [], modelyMeta = {}, priklady = [] }) {
  return html`
${c.section({
    variant: 'page-head',
    eyebrow: 'Pro hotely, penziony a půjčovny',
    title: 'Kola pro vaše hosty – s rezervačním webem, správou a servisem',
    titleTag: 'h1',
    lead: 'Sestavte si nabídku v šesti krocích. Souhrn se přepočítává průběžně; na konci pošlete poptávku a my se ozveme se závaznou nabídkou.',
    children: html`${config.meta.zastupneCeny ? c.notice('Konfigurátor zatím počítá s ukázkovými cenami – slouží k představě o struktuře nabídky, ne jako závazný ceník.', 'warning') : ''}${stepsNav()}`,
  })}
<div class="container nab-layout">
  <form class="nab-form" method="get" action="/nabidka" data-nabidka-form>
    ${stepKola({ config, input, modely, priklady, internal })}
    ${stepPorizeni({ config, input })}
    ${stepWeb({ config, input })}
    ${stepSprava({ config, input })}
    ${stepDoplnky({ config, input })}
    ${stepNavratnost({ config, input })}
    <div class="nab-form__actions" data-nabidka-nojs>${c.button({ label: 'Přepočítat nabídku', type: 'submit', variant: 'secondary' })}<p class="nab-muted">Bez JavaScriptu se souhrn přepočítá tímto tlačítkem.</p></div>
  </form>
  <aside class="nab-summary" data-nabidka-summary aria-live="polite" aria-label="Souhrn nabídky">${summaryFragment({ result, internal, config })}</aside>
</div>
${modelySection({ modely, modelyMeta })}
${inquiryForm({ csrf, values, errors, query })}
`;
}

/** Děkujeme. data: { tenant, number, createdAt, nazev, obec, result, query, cenik } */
function dekujeme({ number, createdAt, nazev, obec, result, query, cenik }) {
  return html`
${c.section({
    variant: 'page-head',
    title: 'Děkujeme za poptávku',
    titleTag: 'h1',
    lead: 'Poptávku jsme přijali a ozveme se obvykle do dvou pracovních dnů se závaznou nabídkou a návrhem termínu konzultace.',
    children: c.steps(['Konfigurace', 'Poptávka', 'Hotovo'], 2, { links: false }),
  })}
${c.section({
    variant: 'nab-thanks',
    children: html`<div class="nab-thanks">
  <div class="nab-thanks__main">
    ${c.summary([
      ['Číslo poptávky', html`<strong class="nab-number">${number || ''}</strong>`],
      ['Přijato', createdAt ? format.dateTime(createdAt) : ''],
      nazev ? ['Ubytování / půjčovna', html`${nazev}${obec ? html`, ${obec}` : ''}`] : null,
      cenik && cenik.verze ? ['Ceník', html`verze ${cenik.verze}${cenik.zastupneCeny ? html` ${c.badge('ukázkové ceny', 'warning')}` : ''}`] : null,
    ].filter(Boolean))}
    <h2 class="nab-subtitle">Co bude dál</h2>
    <ol class="nab-list nab-list--numbered">
      <li>Projdeme vaši konfiguraci a ověříme dostupnost kol v požadovaném termínu.</li>
      <li>Pošleme závaznou nabídku s harmonogramem nasazení webu a zaškolení.</li>
      <li>Domluvíme konzultaci – online nebo u vás.</li>
    </ol>
    <p>${query ? html`<a class="btn btn--secondary" href="/nabidka?${query}">Upravit konfiguraci</a> ` : ''}<a class="btn btn--ghost" href="/">Zpět na web</a></p>
  </div>
  <aside class="nab-summary nab-summary--static" aria-label="Rekapitulace nabídky">${result ? summaryFragment({ result, internal: false, actions: false }) : c.notice('Rekapitulace není k dispozici.', 'info')}</aside>
</div>`,
  })}
`;
}

/** „Nabídka se připravuje“. */
function unavailable() {
  return html`
${c.section({ variant: 'page-head', eyebrow: 'Pro hotely, penziony a půjčovny', title: 'Kola pro vaše hosty', titleTag: 'h1', lead: 'Kola, rezervační web, správa a servis v jednom balíčku – koupě, pronájem nebo zkušební období.' })}
${c.section({ children: html`${c.notice('Nabídka se připravuje – ceník konfigurátoru právě aktualizujeme. Zkuste to prosím za chvíli, nebo nám napište přes kontaktní formulář.', 'info', { title: 'Nabídka se připravuje' })}<p class="nab-form__actions">${c.button({ label: 'Napsat nám', href: '/kontakt', variant: 'primary' })}</p>` })}
`;
}

module.exports = { nabidka, summaryFragment, dekujeme, unavailable, STEPS, kc, choice, startText, raw };
