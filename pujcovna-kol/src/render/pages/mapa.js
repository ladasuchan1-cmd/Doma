'use strict';
// Stránky feature „mapa“ (SPEC kap. 12): /mapa (statický SVG náhled + boční panel tras + kontejner Leaflet mapy, data přes
// data-* atributy a /api/v1/okoli.json) a /okoli (karty 20 tipů přes komponentu poiCard, filtr typu, attribution).
// Vstupy jsou prostá data ze src/features/mapa.js; výstup { title, description, body, jsonLd }. Žádný inline JS/CSS –
// SVG náhled používá jen třídy (styly v public/css/mapa.css) a presentační atributy.

const { html, raw, attr } = require('../html');
const c = require('../components');
const format = require('../format');
const geo = require('../../geo');

const PREVIEW_W = 800;
const PREVIEW_H = 600;
const PREVIEW_TOL_M = 250; // 1 px náhledu ≈ 60 m; hrubší zjednodušení drží HTML stránky malé

/** Statický náhled okolí: trasy (polyline podle sítě), zajímavosti a půjčovna v ekvidistantní projekci. */
function previewSvg({ okoli, routes, pois, rental }) {
  if (!okoli || !okoli.center) return '';
  const { lat: cLat, lon: cLon } = okoli.center;
  const R = Number(okoli.radiusKm) || 25;
  const kmPerPx = (2 * R) / PREVIEW_H;
  const cos = Math.cos((cLat * Math.PI) / 180) || 1e-6;
  const x = (lon) => Math.round(PREVIEW_W / 2 + ((lon - cLon) * 111.32 * cos) / kmPerPx);
  const y = (lat) => Math.round(PREVIEW_H / 2 - ((lat - cLat) * 111.32) / kmPerPx);
  const inView = (px, py) => px >= -20 && px <= PREVIEW_W + 20 && py >= -20 && py <= PREVIEW_H + 20;
  const lines = [];
  for (const r of routes) {
    for (const seg of r.geom || []) {
      const simplified = geo.simplify(
        seg.map(([lat, lon]) => [lon, lat]),
        PREVIEW_TOL_M
      );
      const pts = simplified.map(([lon, lat]) => [x(lon), y(lat)]).filter(([px, py]) => inView(px, py));
      if (pts.length < 2) continue;
      lines.push(html`<polyline class="map-preview__route map-preview__route--${r.net}" points="${pts.map((p) => p.join(',')).join(' ')}" fill="none" stroke-linejoin="round" stroke-linecap="round"/>`);
    }
  }
  const dots = pois.map((p) => html`<circle class="map-preview__poi" cx="${x(p.lon)}" cy="${y(p.lat)}" r="5"><title>${p.name}</title></circle>`);
  const radiusPx = Math.round(R / kmPerPx);
  return html`<svg class="map-preview__svg" viewBox="0 0 ${PREVIEW_W} ${PREVIEW_H}" role="img" aria-labelledby="map-preview-title" preserveAspectRatio="xMidYMid slice">
  <title id="map-preview-title">Náhled okolí půjčovny: ${routes.length} tras a ${pois.length} zajímavostí v okruhu ${R} km</title>
  <rect class="map-preview__bg" width="${PREVIEW_W}" height="${PREVIEW_H}"/>
  <circle class="map-preview__radius" cx="${PREVIEW_W / 2}" cy="${PREVIEW_H / 2}" r="${radiusPx}" fill="none" stroke-dasharray="6 6"/>
  <g class="map-preview__routes">${lines}</g>
  <g class="map-preview__pois">${dots}</g>
  <g class="map-preview__rental" transform="translate(${x(rental.lon)},${y(rental.lat)})"><circle r="11" class="map-preview__rental-ring"/><circle r="6" class="map-preview__rental-dot"/><title>${rental.name}</title></g>
</svg>`;
}

/** Legenda sítí. */
function legend(networks) {
  return html`<ul class="map-legend" aria-label="Legenda">${Object.entries(networks).map(
    ([key, n]) => html`<li class="map-legend__item"><span class="map-legend__swatch map-legend__swatch--${key}" aria-hidden="true"></span>${n.label}</li>`
  )}<li class="map-legend__item"><span class="map-legend__swatch map-legend__swatch--poi" aria-hidden="true"></span>Zajímavost</li><li class="map-legend__item"><span class="map-legend__swatch map-legend__swatch--rental" aria-hidden="true"></span>Půjčovna</li></ul>`;
}

/** Boční panel: filtr sítí (GET formulář funguje bez JS) + seznam tras s odkazy GPX. */
function routePanel({ routes, networks, filter }) {
  const counts = {};
  for (const r of routes) counts[r.net] = (counts[r.net] || 0) + 1;
  const shown = filter ? routes.filter((r) => filter.has(r.net)) : routes;
  return html`<aside class="map-panel" aria-label="Trasy v okolí">
  <form class="map-filter" method="get" action="/mapa" data-network-filter>
    <fieldset class="map-filter__set">
      <legend class="map-filter__legend">Sítě tras</legend>
      ${Object.entries(networks).map(
        ([key, n]) => html`<label class="map-filter__option"><input type="checkbox" name="sit" value="${key}"${attr({ checked: !filter || filter.has(key), disabled: !counts[key] })}> <span class="map-legend__swatch map-legend__swatch--${key}" aria-hidden="true"></span>${n.label} <span class="map-filter__count">(${counts[key] || 0})</span></label>`
      )}
    </fieldset>
    <noscript><button class="btn btn--secondary btn--sm" type="submit">Filtrovat</button></noscript>
  </form>
  <p class="map-panel__summary" data-route-count>${format.plural(shown.length, 'trasa', 'trasy', 'tras')} v okruhu</p>
  <ol class="route-list" data-route-list>
    ${shown.map(
      (r) => html`<li class="route-list__item" data-route-id="${r.id}" data-network="${r.net}">
      <a class="route-list__name" href="#trasa-${r.id}" data-route-focus="${r.id}"><span class="map-legend__swatch map-legend__swatch--${r.net}" aria-hidden="true"></span>${r.ref ? html`<strong class="route-list__ref">${r.ref}</strong> ` : ''}${r.nazev}</a>
      <span class="route-list__meta">${format.km(r.delkaKm)}${r.delkaCelkemKm && r.delkaCelkemKm > r.delkaKm + 0.5 ? html` z ${format.km(r.delkaCelkemKm)}` : ''} · ${r.netLabel}${r.elevation && r.elevation.up !== undefined ? html` · ↑ ${format.number(r.elevation.up)} m` : ''}</span>
      <a class="route-list__gpx" href="${r.gpxHref}" download>Stáhnout GPX</a>
    </li>`
    )}
  </ol>
  ${!shown.length ? c.notice('Pro zvolené sítě tu žádná trasa není.', 'info') : ''}
</aside>`;
}

/** /mapa */
function mapa({ tenant, okoli, routes, pois, networks, filter, tiles, rental, focusPoi, demo }) {
  const hasData = !!okoli;
  const lead = hasData
    ? `${format.plural(routes.length, 'značená trasa', 'značené trasy', 'značených tras')} a ${format.plural(pois.length, 'tip', 'tipy', 'tipů')} na výlet v okruhu ${okoli.radiusKm} km od půjčovny. Klikněte na trasu v seznamu, stáhněte si GPX do navigace, nebo si prohlédněte zajímavosti.`
    : 'Mapa okolí se připravuje. Data tras a zajímavostí sestavuje nástroj tools/build-okoli.js.';
  const apiAttrs = {
    'data-map': true,
    'data-api': '/api/v1/okoli.json',
    'data-center-lat': rental.lat,
    'data-center-lon': rental.lon,
    'data-radius': okoli ? okoli.radiusKm : 25,
    'data-tiles': tiles.provider,
    'data-mapy-key': tiles.mapyKey || null,
    'data-focus-poi': focusPoi || null,
  };
  return {
    title: 'Mapa cyklotras a výletů',
    description: `Interaktivní mapa značených cyklotras a ${pois.length || 20} tipů na výlet v okolí půjčovny ${tenant.name}. GPX ke stažení, navigace do Mapy.cz.`,
    body: html`
${c.section({ variant: 'page-head', title: 'Mapa cyklotras a výletů', titleTag: 'h1', lead })}
${c.section({
  variant: 'map',
  children: html`<div class="map-layout">
    ${routePanel({ routes, networks, filter })}
    <div class="map-stage"${attr(apiAttrs)}>
      <div class="map-preview" data-map-preview>
        ${hasData ? previewSvg({ okoli, routes, pois, rental }) : html`<div class="map-preview__empty">${c.icon('map')}</div>`}
        <div class="map-preview__overlay">
          <p class="map-preview__hint">Mapové dlaždice se načítají ze serverů třetí strany (${tiles.provider === 'mapy' ? 'Mapy.cz' : 'OpenStreetMap France – CyclOSM'}). Načtou se až po vašem kliknutí.</p>
          ${c.button({ label: 'Načíst mapu', variant: 'primary', size: 'lg', attrs: { 'data-map-load': true } })}
          <noscript><p class="map-preview__noscript">Interaktivní mapa vyžaduje JavaScript. Trasy si můžete stáhnout jako GPX ze seznamu a tipy na výlety najdete na stránce <a href="/okoli">Výlety</a>.</p></noscript>
        </div>
      </div>
      <div class="map-canvas" id="mapa-canvas" hidden aria-label="Interaktivní mapa okolí" role="region" tabindex="0"></div>
      <p class="map-attribution">Mapový podklad: ${tiles.provider === 'mapy' ? html`<a href="https://api.mapy.cz/copyright" rel="noopener">Mapy.cz</a> – © Seznam.cz, a.s. a další; ` : ''}<a href="https://www.openstreetmap.org/copyright" rel="noopener">© přispěvatelé OpenStreetMap</a>, <a href="https://www.cyclosm.org/" rel="noopener">CyclOSM</a>. Data tras: OpenStreetMap (ODbL). Zajímavosti: Wikidata, Wikipedie (CC BY-SA), Wikimedia Commons.</p>
      ${legend(networks)}
    </div>
  </div>`,
})}
${hasData && pois.length
  ? c.section({
      variant: 'tips',
      title: 'Nejbližší tipy na výlet',
      lead: 'Výběr z dvaceti zajímavostí seřazených podle vzdálenosti od půjčovny. Kompletní seznam s filtrem najdete na stránce Výlety.',
      children: html`${c.grid(
        pois.slice(0, 6).map((p) => c.poiCard({ ...p, href: `/mapa?poi=${encodeURIComponent(p.id)}`, mapHref: p.mapyUrl })),
        3
      )}
      <p class="section__more">${c.button({ label: 'Všechny tipy na výlety', href: '/okoli', variant: 'secondary' })}</p>`,
    })
  : ''}
${c.section({
  variant: 'map-info',
  children: html`<div class="grid grid--2">
    <div class="rule-card">
      <h2 class="rule-card__title">Jak s mapou pracovat</h2>
      <p>Klikněte na trasu v seznamu a mapa ji přiblíží. Tlačítko <strong>Stáhnout GPX</strong> uloží trasu pro navigaci v telefonu nebo cyklopočítači (formát GPX 1.1). U každé zajímavosti najdete odkaz na Wikipedii a tlačítko „Navigovat v Mapy.cz“.</p>
      <p>Trasy jsou ořezány na okruh ${okoli ? okoli.radiusKm : 25} km; u dálkových tras je uvedena i celková délka.${demo ? ' V demo verzi je výškový profil vypnutý (bez klíče Mapy.cz).' : ''}</p>
    </div>
    <div class="rule-card">
      <h2 class="rule-card__title">Začněte u nás</h2>
      <p>${rental.name}${rental.address ? html`, ${rental.address}` : ''}. Ke každému kolu půjčujeme zámek a tištěnou mapu Třeboňska.</p>
      <p>${c.button({ label: 'Rezervovat kolo', href: '/rezervace', variant: 'primary' })} ${rental.mapyUrl ? c.button({ label: 'Navigovat k půjčovně', href: rental.mapyUrl, variant: 'ghost', attrs: { rel: 'noopener', target: '_blank' } }) : ''}</p>
    </div>
  </div>`,
})}
`,
  };
}

/** JSON-LD seznam turistických cílů. */
function okoliJsonLd(pois, baseUrl) {
  return {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Tipy na výlety v okolí půjčovny',
    url: `${baseUrl}/okoli`,
    numberOfItems: pois.length,
    itemListElement: pois.map((p, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      item: {
        '@type': 'TouristAttraction',
        name: p.name,
        description: p.summary,
        url: p.wikipediaUrl || undefined,
        geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lon },
        image: p.image ? `${baseUrl}${p.image.src}` : undefined,
      },
    })),
  };
}

/** /okoli */
function okoli({ tenant, okoli: data, pois, allCount, types, typ, rental, baseUrl }) {
  const hasData = !!data;
  const lead = hasData
    ? `${format.plural(allCount, 'tip', 'tipy', 'tipů')} na výlet do ${data.radiusKm} km od půjčovny, seřazené podle vzdálenosti. U každého najdete krátký popis z Wikipedie, fotku s uvedením autora a licence a odkaz pro navigaci.`
    : 'Tipy na výlety se připravují.';
  return {
    title: 'Tipy na výlety',
    description: `Zámky, rybníky, rozhledny a přírodní rezervace v okolí půjčovny ${tenant.name}: ${allCount || 20} tipů na výlet na kole s mapou a GPX.`,
    jsonLd: hasData && pois.length ? okoliJsonLd(pois, baseUrl) : null,
    body: html`
${c.section({ variant: 'page-head', title: 'Tipy na výlety', titleTag: 'h1', lead })}
${hasData
  ? c.section({
      variant: 'okoli',
      children: html`<div class="okoli-filter">
      <nav class="okoli-filter__types" aria-label="Filtr podle typu">
        <a class="${typ ? 'okoli-filter__type' : 'okoli-filter__type is-active'}" href="/okoli"${attr({ 'aria-current': typ ? null : 'page' })}>Vše <span class="okoli-filter__count">${allCount}</span></a>
        ${types.map((t) => html`<a class="${typ === t.key ? 'okoli-filter__type is-active' : 'okoli-filter__type'}" href="/okoli?typ=${encodeURIComponent(t.key)}"${attr({ 'aria-current': typ === t.key ? 'page' : null })}>${t.label} <span class="okoli-filter__count">${t.count}</span></a>`)}
      </nav>
      <p class="okoli-filter__map">${c.button({ label: 'Zobrazit na mapě', href: '/mapa', variant: 'secondary', size: 'sm' })}</p>
    </div>
    ${pois.length
      ? c.grid(
          pois.map((p) => c.poiCard({ ...p, href: `/mapa?poi=${encodeURIComponent(p.id)}`, mapHref: p.mapyUrl })),
          3
        )
      : c.notice('Zvolenému typu neodpovídá žádný tip.', 'info')}
    <p class="okoli-sources">Popisy: úvod článků na <a href="https://cs.wikipedia.org/" rel="noopener">české Wikipedii</a> (CC BY-SA 4.0), data: <a href="https://www.wikidata.org/" rel="noopener">Wikidata</a> (CC0), fotografie: <a href="https://commons.wikimedia.org/" rel="noopener">Wikimedia Commons</a> – autor a licence jsou uvedeny u každého obrázku. Vzdálenosti jsou vzdušnou čarou od půjčovny (${rental.address || rental.name}).</p>`,
    })
  : c.section({ variant: 'okoli', children: c.notice('Data zajímavostí zatím nejsou k dispozici. Spusťte npm run build-okoli.', 'info') })}
`,
  };
}

module.exports = { mapa, okoli, previewSvg, routePanel, legend, okoliJsonLd, raw };
