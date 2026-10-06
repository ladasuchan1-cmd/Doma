'use strict';
// Progresivní JS feature „mapa“ (/mapa): Leaflet mapa z public/vendor se inicializuje až po kliknutí na „Načíst mapu“
// (nebo při scrollu do viewportu, pokud návštěvník už dříve souhlasil – localStorage pk-map-autoload). Data bere
// z GET /api/v1/okoli.json (trasy, zajímavosti, půjčovna, podklad). Bez knihoven kromě Leafletu, bez inline kódu;
// veškerý obsah popupů se skládá přes DOM (textContent), ne přes innerHTML s daty.
// Podklad: CyclOSM (bez klíče) nebo Mapy.cz outdoor (data-mapy-key); při chybě dlaždic CyclOSM (např. CSP) přepne na
// OpenTopoMap a zobrazí upozornění. Barvy sítí odpovídají ../cyklo-ski-mapa/app.js a public/css/mapa.css.
(function () {
  var root = document.querySelector('[data-map]');
  if (!root) return;

  var FALLBACK_NETWORKS = {
    icn: { color: '#d9480f', weight: 4, label: 'Mezinárodní (EuroVelo)' },
    ncn: { color: '#d9480f', weight: 3, label: 'Dálkové' },
    rcn: { color: '#d9480f', weight: 2.5, label: 'Regionální' },
    lcn: { color: '#d9480f', weight: 2, label: 'Místní' },
    cyklostezka: { color: '#c2410c', weight: 3, label: 'Cyklostezky' },
    mtb: { color: '#7c3aed', weight: 2.5, label: 'MTB' },
  };
  var OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">přispěvatelé OpenStreetMap</a>';
  var BASES = {
    cyclosm: { label: 'CyclOSM', url: 'https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', maxZoom: 19, attribution: '<a href="https://www.cyclosm.org" rel="noopener" target="_blank">CyclOSM</a> | ' + OSM_ATTR },
    opentopomap: { label: 'OpenTopoMap', url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', maxZoom: 17, attribution: '<a href="https://opentopomap.org" rel="noopener" target="_blank">OpenTopoMap</a> (CC-BY-SA) | ' + OSM_ATTR },
    mapy: { label: 'Mapy.cz outdoor', url: 'https://api.mapy.cz/v1/maptiles/outdoor/256/{z}/{x}/{y}?apikey={key}', maxZoom: 19, attribution: '<a href="https://api.mapy.cz/copyright" rel="noopener" target="_blank">&copy; Seznam.cz a.s. a další</a> | ' + OSM_ATTR },
  };

  var cfg = {
    api: root.getAttribute('data-api') || '/api/v1/okoli.json',
    lat: Number(root.getAttribute('data-center-lat')),
    lon: Number(root.getAttribute('data-center-lon')),
    radius: Number(root.getAttribute('data-radius')) || 25,
    tiles: root.getAttribute('data-tiles') || 'cyclosm',
    mapyKey: root.getAttribute('data-mapy-key') || '',
    focusPoi: root.getAttribute('data-focus-poi') || '',
  };
  var preview = root.querySelector('[data-map-preview]');
  var canvas = root.querySelector('.map-canvas');
  var loadBtn = root.querySelector('[data-map-load]');
  var panel = document.querySelector('.map-panel');
  var filterForm = document.querySelector('[data-network-filter]');
  var list = document.querySelector('[data-route-list]');
  var countEl = document.querySelector('[data-route-count]');

  var state = { map: null, data: null, networks: FALLBACK_NETWORKS, routeLayers: {}, netGroups: {}, poiMarkers: {}, activeRoute: null, baseLayer: null, baseKey: null, promise: null, fellBack: false, logo: null };

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function fmtKm(n) {
    n = Number(n);
    if (!isFinite(n)) return '';
    if (n < 1) return Math.round(n * 1000) + ' m';
    return n.toLocaleString('cs-CZ', { maximumFractionDigits: 1 }) + ' km';
  }

  function plural(n, one, few, many) {
    return n + ' ' + (n === 1 ? one : n >= 2 && n <= 4 ? few : many);
  }

  // ------------------------------------------------------------------ panel (funguje i před načtením mapy)
  function checkedNetworks() {
    var out = {};
    if (!filterForm) return null;
    var inputs = filterForm.querySelectorAll('input[name="sit"]');
    for (var i = 0; i < inputs.length; i++) if (inputs[i].checked) out[inputs[i].value] = true;
    return out;
  }

  function applyListFilter() {
    if (!list) return;
    var nets = checkedNetworks();
    var items = list.querySelectorAll('[data-route-id]');
    var shown = 0;
    for (var i = 0; i < items.length; i++) {
      var ok = !nets || nets[items[i].getAttribute('data-network')];
      items[i].hidden = !ok;
      if (ok) shown++;
    }
    if (countEl) countEl.textContent = plural(shown, 'trasa', 'trasy', 'tras') + ' v okruhu';
  }

  function applyMapFilter() {
    if (!state.map) return;
    var nets = checkedNetworks();
    Object.keys(state.netGroups).forEach(function (net) {
      var group = state.netGroups[net];
      var want = !nets || nets[net];
      if (want && !state.map.hasLayer(group)) group.addTo(state.map);
      if (!want && state.map.hasLayer(group)) state.map.removeLayer(group);
    });
  }

  if (filterForm) {
    filterForm.addEventListener('change', function () {
      applyListFilter();
      applyMapFilter();
    });
    filterForm.addEventListener('submit', function (e) {
      e.preventDefault();
    });
  }

  if (list) {
    list.addEventListener('click', function (e) {
      var a = e.target.closest ? e.target.closest('[data-route-focus]') : null;
      if (!a) return;
      e.preventDefault();
      var id = a.getAttribute('data-route-focus');
      ensureMap().then(function () {
        focusRoute(id, false);
      });
    });
  }

  // ------------------------------------------------------------------ načtení mapy
  function rememberConsent() {
    try {
      localStorage.setItem('pk-map-autoload', '1');
    } catch (e) {
      /* soukromý režim apod. */
    }
  }

  function hasConsent() {
    try {
      return localStorage.getItem('pk-map-autoload') === '1';
    } catch (e) {
      return false;
    }
  }

  if (loadBtn) {
    loadBtn.addEventListener('click', function () {
      rememberConsent();
      ensureMap();
    });
  }
  if (hasConsent() && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(
      function (entries) {
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isIntersecting) {
            io.disconnect();
            ensureMap();
            return;
          }
        }
      },
      { threshold: 0.2 }
    );
    io.observe(root);
  }
  // příchod z karty zajímavosti (/okoli → „název“) = záměr vidět ji na mapě
  if (cfg.focusPoi) ensureMap();

  function ensureMap() {
    if (state.promise) return state.promise;
    if (typeof L === 'undefined') {
      showNotice('Mapovou knihovnu se nepodařilo načíst. Zkuste stránku obnovit.', 'danger');
      state.promise = Promise.resolve();
      return state.promise;
    }
    if (loadBtn) {
      loadBtn.disabled = true;
      loadBtn.querySelector('.btn__label').textContent = 'Načítám…';
    }
    state.promise = fetch(cfg.api, { credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(initMap)
      .catch(function (err) {
        showNotice('Data mapy se nepodařilo načíst (' + err.message + '). Trasy si můžete stáhnout jako GPX ze seznamu.', 'danger');
        if (loadBtn) {
          loadBtn.disabled = false;
          loadBtn.querySelector('.btn__label').textContent = 'Zkusit znovu';
        }
        state.promise = null;
      });
    return state.promise;
  }

  function showNotice(text, tone) {
    var old = root.querySelector('.map-notice');
    if (old) old.remove();
    var n = el('div', 'notice notice--' + (tone || 'info') + ' map-notice', text);
    n.setAttribute('role', tone === 'danger' ? 'alert' : 'status');
    root.insertBefore(n, canvas.nextSibling);
  }

  // ------------------------------------------------------------------ podklad
  function makeBase(key) {
    var def = BASES[key] || BASES.cyclosm;
    var url = def.url.replace('{key}', encodeURIComponent(cfg.mapyKey));
    return L.tileLayer(url, { maxZoom: def.maxZoom, attribution: def.attribution, crossOrigin: 'anonymous' });
  }

  function setBase(key) {
    if (!state.map) return;
    if (state.baseLayer) state.map.removeLayer(state.baseLayer);
    state.baseKey = key;
    state.baseLayer = makeBase(key).addTo(state.map);
    state.baseLayer.bringToBack();
    var errors = 0;
    state.baseLayer.on('tileerror', function () {
      errors++;
      if (errors >= 2 && key === 'cyclosm' && !state.fellBack) {
        state.fellBack = true;
        setBase('opentopomap');
        syncBaseRadios('opentopomap');
        showNotice('Podklad CyclOSM se nepodařilo načíst (nejspíš ho blokuje bezpečnostní politika stránky). Zobrazen je OpenTopoMap.', 'info');
      }
    });
    if (state.logo) {
      state.map.removeControl(state.logo);
      state.logo = null;
    }
    if (key === 'mapy') {
      var Logo = L.Control.extend({
        onAdd: function () {
          var box = el('div', 'mapy-logo');
          var a = el('a');
          a.href = 'https://mapy.cz/';
          a.target = '_blank';
          a.rel = 'noopener';
          var img = el('img');
          img.src = 'https://api.mapy.cz/img/api/logo.svg';
          img.alt = 'Mapy.cz';
          a.appendChild(img);
          box.appendChild(a);
          L.DomEvent.disableClickPropagation(box);
          return box;
        },
      });
      state.logo = new Logo({ position: 'bottomleft' }).addTo(state.map);
    }
  }

  function syncBaseRadios(key) {
    var radios = document.querySelectorAll('input[name="podklad"]');
    for (var i = 0; i < radios.length; i++) radios[i].checked = radios[i].value === key;
  }

  function buildBaseSwitch() {
    if (!panel) return;
    var keys = cfg.mapyKey ? ['mapy', 'cyclosm', 'opentopomap'] : ['cyclosm', 'opentopomap'];
    var box = el('fieldset', 'map-filter__set map-base');
    box.appendChild(el('legend', 'map-filter__legend', 'Podklad'));
    keys.forEach(function (key) {
      var label = el('label', 'map-filter__option');
      var input = el('input');
      input.type = 'radio';
      input.name = 'podklad';
      input.value = key;
      input.checked = key === state.baseKey;
      input.addEventListener('change', function () {
        if (input.checked) setBase(key);
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(' ' + BASES[key].label));
      box.appendChild(label);
    });
    var wrap = el('div', 'map-filter');
    wrap.appendChild(box);
    panel.insertBefore(wrap, panel.firstChild);
  }

  // ------------------------------------------------------------------ mapa
  function initMap(data) {
    state.data = data;
    state.networks = data.networks || FALLBACK_NETWORKS;
    if (preview) preview.hidden = true;
    canvas.hidden = false;

    var center = data.center && isFinite(data.center.lat) ? [data.center.lat, data.center.lon] : [cfg.lat, cfg.lon];
    var map = L.map(canvas, { preferCanvas: true, zoomControl: true, attributionControl: true, worldCopyJump: false });
    state.map = map;
    map.attributionControl.setPrefix('<a href="https://leafletjs.com" rel="noopener" target="_blank">Leaflet</a>');
    var initialBase = cfg.tiles === 'mapy' && cfg.mapyKey ? 'mapy' : 'cyclosm';
    setBase(initialBase);
    buildBaseSwitch();

    var radiusKm = Number(data.radiusKm) || cfg.radius;
    L.circle(center, { radius: radiusKm * 1000, color: '#555', weight: 1, dashArray: '4 6', fill: false, interactive: false }).addTo(map);

    // trasy po sítích
    var renderer = L.canvas({ padding: 0.5 });
    (data.routes || []).forEach(function (route) {
      var net = state.networks[route.net] ? route.net : 'lcn';
      var style = state.networks[net] || FALLBACK_NETWORKS.lcn;
      if (!state.netGroups[net]) state.netGroups[net] = L.layerGroup();
      var line = L.polyline(route.geom, {
        renderer: renderer,
        color: route.color || style.color,
        weight: route.weight || style.weight,
        opacity: 0.85,
        dashArray: net === 'cyklostezka' ? '8 6' : null,
      });
      var label = (route.ref ? route.ref + ' ' : '') + route.nazev + ' · ' + fmtKm(route.delkaKm);
      line.bindTooltip(label, { sticky: true, className: 'route-tooltip' });
      line.on('click', function () {
        focusRoute(route.id, true);
      });
      line.pkRoute = route;
      state.routeLayers[route.id] = line;
      state.netGroups[net].addLayer(line);
    });
    Object.keys(state.netGroups).forEach(function (net) {
      state.netGroups[net].addTo(map);
    });
    applyMapFilter();

    // zajímavosti
    (data.pois || []).forEach(function (poi) {
      var marker = L.marker([poi.lat, poi.lon], {
        icon: L.divIcon({ className: '', html: '<span class="poi-marker"></span>', iconSize: [18, 18], iconAnchor: [9, 9], popupAnchor: [0, -10] }),
        title: poi.name,
        alt: poi.name,
        keyboard: true,
      });
      marker.bindPopup(popupFor(poi), { maxWidth: 320 });
      marker.on('popupopen', function () {
        var icon = marker.getElement && marker.getElement();
        if (icon && icon.firstChild) icon.firstChild.classList.add('is-active');
      });
      marker.on('popupclose', function () {
        var icon = marker.getElement && marker.getElement();
        if (icon && icon.firstChild) icon.firstChild.classList.remove('is-active');
      });
      state.poiMarkers[poi.id] = marker;
      marker.addTo(map);
    });

    // půjčovna
    var rental = data.rental || {};
    if (isFinite(rental.lat)) {
      var rentalMarker = L.marker([rental.lat, rental.lon], {
        icon: L.divIcon({ className: '', html: '<span class="rental-marker"><svg class="icon" aria-hidden="true" width="18" height="18"><use href="/img/icons.svg#bike"></use></svg></span>', iconSize: [30, 30], iconAnchor: [15, 15], popupAnchor: [0, -16] }),
        title: rental.name || 'Půjčovna',
        alt: rental.name || 'Půjčovna',
        zIndexOffset: 1000,
      });
      var box = el('div', 'poi-popup');
      box.appendChild(el('h3', 'poi-popup__title', rental.name || 'Půjčovna kol'));
      if (rental.address) box.appendChild(el('p', 'poi-popup__meta', rental.address));
      var links = el('p', 'poi-popup__links');
      links.appendChild(link('/rezervace', 'Rezervovat kolo', false));
      if (rental.mapyUrl) links.appendChild(link(rental.mapyUrl, 'Navigovat v Mapy.cz', true));
      box.appendChild(links);
      rentalMarker.bindPopup(box);
      rentalMarker.addTo(map);
    }

    map.fitBounds(L.latLng(center).toBounds(radiusKm * 2 * 1000), { padding: [10, 10] });

    if (cfg.focusPoi && state.poiMarkers[cfg.focusPoi]) {
      var m = state.poiMarkers[cfg.focusPoi];
      map.setView(m.getLatLng(), 14);
      m.openPopup();
    }
    canvas.focus({ preventScroll: true });
  }

  function link(href, text, external) {
    var a = el('a', null, text);
    a.href = href;
    if (external) {
      a.target = '_blank';
      a.rel = 'noopener';
    }
    return a;
  }

  function popupFor(poi) {
    var box = el('div', 'poi-popup');
    if (poi.image && poi.image.src) {
      var img = el('img', 'poi-popup__img');
      img.src = poi.image.src;
      img.alt = poi.image.alt || poi.name;
      img.width = 400;
      img.height = 300;
      img.loading = 'lazy';
      box.appendChild(img);
    }
    box.appendChild(el('h3', 'poi-popup__title', poi.name));
    box.appendChild(el('p', 'poi-popup__meta', (poi.type ? poi.type + ' · ' : '') + fmtKm(poi.distanceKm) + ' od půjčovny'));
    if (poi.summary) box.appendChild(el('p', 'poi-popup__text', poi.summary));
    var links = el('p', 'poi-popup__links');
    if (poi.wikipediaUrl) links.appendChild(link(poi.wikipediaUrl, 'Wikipedie', true));
    if (poi.mapyUrl) links.appendChild(link(poi.mapyUrl, 'Navigovat v Mapy.cz', true));
    if (poi.nearRouteId && state.routeLayers[poi.nearRouteId]) {
      var r = el('a', null, 'Nejbližší trasa');
      r.href = '#trasa-' + poi.nearRouteId;
      r.addEventListener('click', function (e) {
        e.preventDefault();
        focusRoute(poi.nearRouteId, false);
      });
      links.appendChild(r);
    }
    box.appendChild(links);
    if (poi.image && (poi.image.author || poi.image.license)) {
      var attr = el('p', 'poi-popup__attribution', 'Foto: ');
      if (poi.image.sourceUrl) attr.appendChild(link(poi.image.sourceUrl, poi.image.author || 'Wikimedia Commons', true));
      else attr.appendChild(document.createTextNode(poi.image.author || ''));
      if (poi.image.license) {
        attr.appendChild(document.createTextNode(', '));
        if (poi.image.licenseUrl) attr.appendChild(link(poi.image.licenseUrl, poi.image.license, true));
        else attr.appendChild(document.createTextNode(poi.image.license));
      }
      box.appendChild(attr);
    }
    return box;
  }

  function focusRoute(id, fromMap) {
    var line = state.routeLayers[id];
    if (!line || !state.map) return;
    if (state.activeRoute && state.activeRoute !== line) {
      var prev = state.activeRoute.pkRoute;
      state.activeRoute.setStyle({ weight: prev.weight || 2, opacity: 0.85 });
    }
    state.activeRoute = line;
    line.setStyle({ weight: (line.pkRoute.weight || 2) + 3, opacity: 1 });
    line.bringToFront();
    var net = line.pkRoute.net;
    if (state.netGroups[net] && !state.map.hasLayer(state.netGroups[net])) {
      state.netGroups[net].addTo(state.map);
      var input = filterForm && filterForm.querySelector('input[name="sit"][value="' + net + '"]');
      if (input) input.checked = true;
      applyListFilter();
    }
    if (!fromMap) state.map.fitBounds(line.getBounds(), { padding: [30, 30] });
    var r = line.pkRoute;
    var box = el('div', 'poi-popup');
    box.appendChild(el('h3', 'poi-popup__title', (r.ref ? r.ref + ' · ' : '') + r.nazev));
    var meta = fmtKm(r.delkaKm) + (r.delkaCelkemKm && r.delkaCelkemKm > r.delkaKm + 0.5 ? ' z ' + fmtKm(r.delkaCelkemKm) : '') + (r.netLabel ? ' · ' + r.netLabel : '') + (r.elevation && isFinite(r.elevation.up) ? ' · ↑ ' + r.elevation.up + ' m' : '');
    box.appendChild(el('p', 'poi-popup__meta', meta));
    var links = el('p', 'poi-popup__links');
    var gpx = link(r.gpxHref || '/mapa/gpx/' + encodeURIComponent(r.id) + '.gpx', 'Stáhnout GPX', false);
    gpx.setAttribute('download', '');
    links.appendChild(gpx);
    box.appendChild(links);
    L.popup({ maxWidth: 300 }).setLatLng(line.getBounds().getCenter()).setContent(box).openOn(state.map);

    if (list) {
      var items = list.querySelectorAll('[data-route-id]');
      for (var i = 0; i < items.length; i++) {
        var active = items[i].getAttribute('data-route-id') === id;
        items[i].classList.toggle('is-active', active);
        if (active && items[i].scrollIntoView) items[i].scrollIntoView({ block: 'nearest' });
      }
    }
  }

  applyListFilter();
})();
