'use strict';
// Stránky feature home: domovská – vstup { tenant, texts, types, settings, heroImage, heroAlt, theme } (texts = efektivní
// texty z layout.siteTexts; bez nich tenant.texts); /fotografie – vstup { tenant, groups } z home.loadPhotoCredits
// (skupiny podle složek public/img/demo/* s položkami { file, title, author, license, source }). Výstup: Html tělo.

const { html } = require('../html');
const c = require('../components');
const format = require('../format');

const USP = [
  { icon: 'wrench', title: 'Servis po každém vrácení', text: 'Každé kolo projde kontrolou brzd, řazení a tlaku v pláštích, než ho půjčíme dál.' },
  { icon: 'calendar', title: 'Rezervace online za minutu', text: 'Vyberete termín, zaplatíte rezervační poplatek a kolo na vás čeká. Poplatek se započítá do nájemného.' },
  { icon: 'map', title: 'Zámek, mapa a tipy zdarma', text: 'Ke každému kolu dostanete zámek, mapu Třeboňska a doporučené výlety podle vaší kondice.' },
];

const STEPS = [
  { label: 'Vyberte termín', description: 'Datum a čas vyzvednutí i vrácení v otevírací době.' },
  { label: 'Zaplaťte rezervační poplatek', description: 'Kartou nebo QR převodem; při vrácení kola se započítá do ceny.' },
  { label: 'Vyzvedněte s dokladem', description: 'Při převzetí předložíte platný doklad totožnosti – zapíšeme jeho typ a číslo.' },
];

function home({ tenant, texts: effectiveTexts, types, settings, heroImage, heroAlt }) {
  const texts = effectiveTexts || tenant.texts || {};
  const fee = settings && settings.feeMinor ? settings.feeMinor.default : null;
  const freeHours = settings && settings.cancellation ? settings.cancellation.freeHoursBefore : null;
  return html`
${c.hero({
  title: texts.heroTitle || tenant.name,
  text: texts.heroText || '',
  accent: tenant.brand && tenant.brand.claim ? tenant.brand.claim : null,
  cta: 'Rezervovat kolo',
  ctaHref: '/rezervace',
  secondaryCta: 'Prohlédnout kola',
  secondaryHref: '/kola',
  image: heroImage,
  imageAlt: heroImage ? heroAlt || 'Krajina Třeboňska' : '',
})}

${c.section({
  variant: 'usp',
  title: 'Proč půjčovat u nás',
  children: c.grid(
    USP.map(
      (u) => html`<article class="usp">
  <div class="usp__icon">${c.icon(u.icon)}</div>
  <h3 class="usp__title">${u.title}</h3>
  <p class="usp__text">${u.text}</p>
</article>`
    ),
    3
  ),
})}

${c.section({
  id: 'kola',
  variant: 'bikes',
  title: 'Vyberte si kolo',
  lead: 'Trekové, horské a elektrokola pro dospělé, dětská kola i vozíky. Ceny platí za den; u delších výpůjček klesají.',
  children: html`
    ${types.length
      ? c.grid(
          types.map((t) => c.bikeCard(t, { price: t.from_price_minor })),
          3
        )
      : c.notice('Nabídka kol se připravuje. Spusťte prosím „npm run demo-data“, nebo přidejte typy kol v administraci.', 'info')}
    <p class="section__more">${c.button({ label: 'Všechna kola a ceník', href: '/kola', variant: 'secondary' })} ${c.button({ label: 'Ceník', href: '/cenik', variant: 'ghost' })}</p>
  `,
})}

${c.section({
  variant: 'how',
  title: 'Jak to funguje',
  lead:
    fee !== null && freeHours !== null
      ? `Rezervační poplatek ${format.money(fee)} za kolo blokuje váš termín. Při zrušení nejméně ${freeHours} hodin před začátkem ho vracíme celý; při řádném využití se započítá na nájemné.`
      : '',
  children: html`
    ${c.steps(STEPS, -1)}
    <p class="section__more">${c.button({ label: 'Začít rezervaci', href: '/rezervace', variant: 'primary', size: 'lg' })}</p>
  `,
})}

${c.section({
  variant: 'explore',
  title: 'Kam vyrazit',
  lead: 'Třeboňsko je rovinaté, protkané hrázemi rybníků a značenými cyklotrasami. Vybrali jsme pro vás 20 tipů do 25 km od půjčovny.',
  children: c.grid(
    [
      html`<article class="card card--teaser">
  <div class="card__media card__media--map" aria-hidden="true">${c.icon('map')}</div>
  <div class="card__body">
    <h3 class="card__title"><a href="/mapa">Mapa cyklotras</a></h3>
    <p class="card__text">Značené trasy v okolí Třeboně na jedné mapě – od Greenway Rožmberk po rodinné okruhy kolem rybníků. Trasy si můžete stáhnout jako GPX.</p>
    ${c.button({ label: 'Otevřít mapu', href: '/mapa', variant: 'secondary' })}
  </div>
</article>`,
      html`<article class="card card--teaser">
  <div class="card__media card__media--map" aria-hidden="true">${c.icon('pin')}</div>
  <div class="card__body">
    <h3 class="card__title"><a href="/okoli">Tipy na výlety</a></h3>
    <p class="card__text">Zámek Třeboň, rybník Svět, Schwarzenberská hrobka, Rožmberk a další místa, kam dojedete na kole za odpoledne. S vzdáleností od půjčovny.</p>
    ${c.button({ label: 'Prohlédnout tipy', href: '/okoli', variant: 'secondary' })}
  </div>
</article>`,
    ],
    2
  ),
})}

${c.section({
  variant: 'contact',
  title: 'Kde nás najdete',
  children: html`<div class="grid grid--2">
    ${c.contactCard(tenant.business, tenant.openingHours, { title: tenant.name })}
    <div class="contact-note">
      ${texts.about ? html`<p>${texts.about}</p>` : ''}
      <p>Máte dotaz k výběru kola, vozíku pro děti nebo k delšímu pronájmu? Napište nám přes <a href="/kontakt">kontaktní formulář</a>, odpovíme obvykle do druhého dne.</p>
      ${c.button({ label: 'Kontakt', href: '/kontakt', variant: 'ghost' })}
    </div>
  </div>`,
})}
`;
}

/** Jedna položka attribution: náhled, popis, autor, licence (odkaz), zdroj (odkaz). */
function creditRow(group, it) {
  const src = `${group.src}/${it.file}`;
  const lic = it.license;
  return [
    html`<a class="credits__thumb-link" href="${src}" rel="noopener"><img class="credits__thumb" src="${src}" alt="" loading="lazy" width="120" height="80"></a>`,
    html`<span class="credits__title">${it.title}</span>${it.original && it.original !== it.title ? html`<br><span class="credits__original">${it.original}</span>` : ''}`,
    it.author || '–',
    lic ? html`${lic.url ? html`<a href="${lic.url}" rel="license noopener">${lic.name}</a>` : lic.name}${lic.note ? html`<br><span class="credits__note">${lic.note}</span>` : ''}` : '–',
    it.source ? html`<a href="${it.source}" rel="noopener">${/wikimedia\.org/.test(it.source) ? 'Wikimedia Commons' : /flickr\.com/.test(it.source) ? 'Flickr' : 'zdroj'}</a>` : '–',
  ];
}

/** Stránka /fotografie – autoři a licence fotografií (CC BY attribution). */
function fotografie({ tenant, groups }) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return html`
${c.section({
  variant: 'page-head',
  title: 'Fotografie: autoři a licence',
  titleTag: 'h1',
  lead: `Fotografie na webu ${tenant.name} pocházejí z Wikimedia Commons a jsou zveřejněné pod svobodnými licencemi Creative Commons (CC0, CC BY). Licence CC BY vyžaduje uvedení autora a licence – zde je přehled všech ${total} použitých snímků. Fotografie jsou ilustrační; úpravy se omezují na zmenšení, ořez a barevné ladění přes CSS daného designu.`,
})}
${c.section({
  variant: 'credits',
  children: html`
    ${groups.length
      ? groups.map(
          (g) => html`<div class="credits__group" id="${g.dir}">
    ${c.table({ caption: g.label, head: ['Náhled', 'Popis', 'Autor', 'Licence', 'Zdroj'], rows: g.items.map((it) => creditRow(g, it)) })}
  </div>`
        )
      : c.notice('Seznam fotografií se nepodařilo načíst (chybí public/img/demo/*/ATTRIBUTION.md).', 'warning')}
    <p class="credits__footnote">Obrázky zajímavostí na stránkách <a href="/okoli">Tipy na výlety</a> a v <a href="/mapa">mapě</a> uvádějí autora a licenci přímo u každého snímku. Mapové podklady © <a href="https://www.openstreetmap.org/copyright" rel="noopener">přispěvatelé OpenStreetMap</a>, <a href="https://www.cyclosm.org/" rel="noopener">CyclOSM</a>. Logo a ilustrace jsou vlastním dílem provozovatele.</p>
  `,
})}
`;
}

module.exports = { home, fotografie, USP, STEPS };
