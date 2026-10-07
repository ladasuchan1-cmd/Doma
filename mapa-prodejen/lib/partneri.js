// Hledání partnerů: poptávka (objednávky podle PSČ) v okolí každé prodejny/servisu, pokrytí stávajícími partnery
// a vlastními pobočkami, skóre kandidáta (0–100, se složkami, aby bylo vidět „proč“) a „bílá místa“ – obce s mnoha
// objednávkami bez partnera v dosahu. Bez závislostí; UMD: v prohlížeči `MP.partneri`, v Node require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.partneri = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEG = Math.PI / 180;

  // Vzdálenost dvou bodů v km (haversine).
  function km(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Mřížka bodů {lat, lon, …} pro rychlé hledání v okruhu (buňka ≈ 0,1° ≈ 7–11 km).
  function mrizka(body, cell) {
    const c = cell || 0.1;
    const map = new Map();
    for (const b of body) {
      const k = Math.floor(b.lat / c) + ':' + Math.floor(b.lon / c);
      let arr = map.get(k);
      if (!arr) map.set(k, (arr = []));
      arr.push(b);
    }
    // body do r km: pole [bod, km] seřazené podle vzdálenosti
    function okruh(lat, lon, r) {
      const dLat = r / 111.2;
      const dLon = r / (111.2 * Math.max(0.2, Math.cos(lat * DEG)));
      const out = [];
      for (let i = Math.floor((lat - dLat) / c); i <= Math.floor((lat + dLat) / c); i++) {
        for (let j = Math.floor((lon - dLon) / c); j <= Math.floor((lon + dLon) / c); j++) {
          const arr = map.get(i + ':' + j);
          if (!arr) continue;
          for (const b of arr) {
            const d = km(lat, lon, b.lat, b.lon);
            if (d <= r) out.push([b, d]);
          }
        }
      }
      return out.sort((a, b) => a[1] - b[1]);
    }
    // nejbližší bod do maxKm (nebo null)
    function nejblizsi(lat, lon, maxKm) {
      const arr = okruh(lat, lon, maxKm);
      return arr.length ? arr[0] : null;
    }
    return { okruh, nejblizsi, size: body.length };
  }

  // Poptávka v okolí: součet objednávek (a částek) z PSČ bodů do r km. body = [{lat, lon, n, kc}]
  function poptavka(lat, lon, grid, r) {
    let n = 0;
    let kc = 0;
    for (const [b] of grid.okruh(lat, lon, r)) {
      n += b.n;
      kc += b.kc || 0;
    }
    return { n, kc };
  }

  // Skóre kandidáta 0–100 se složkami:
  //   poptávka v okolí (0–50, odmocninově vůči nejvyšší poptávce mezi kandidáty – ať jedno velké město nepřebije vše),
  //   servis (ano 20 / neznámo 8 / ne 0), nepokryté okolí (0–20 podle vzdálenosti k nejbližšímu partnerovi či
  //   pobočce), kontakt (e-mail 6, telefon 4).
  function skore(c) {
    const x = c || {};
    const slozky = [];
    const maxN = Math.max(1, x.maxPoptavka || 0);
    const pop = Math.round(50 * Math.sqrt(Math.min(1, (x.poptavka || 0) / maxN)));
    slozky.push({ key: 'poptavka', label: 'Objednávky v okolí', body: pop, max: 50 });
    const sv = x.servis === true ? 20 : x.servis === false ? 0 : 8;
    slozky.push({ key: 'servis', label: x.servis === true ? 'Dělá servis' : x.servis === false ? 'Servis nedělá' : 'Servis neznámý', body: sv, max: 20 });
    let pok = 20;
    if (x.partnerKm != null && x.radiusKm) pok = Math.round(20 * Math.min(1, x.partnerKm / x.radiusKm));
    slozky.push({ key: 'pokryti', label: x.partnerKm == null ? 'V okolí žádný partner' : 'Nejbližší partner ' + x.partnerKm.toFixed(1).replace('.', ',') + ' km', body: pok, max: 20 });
    const kon = (x.email ? 6 : 0) + (x.telefon ? 4 : 0);
    slozky.push({ key: 'kontakt', label: x.email && x.telefon ? 'E-mail i telefon' : x.email ? 'Jen e-mail' : x.telefon ? 'Jen telefon' : 'Bez kontaktu', body: kon, max: 10 });
    const body = slozky.reduce((s, k) => s + k.body, 0);
    return { body, slozky };
  }

  // Klíč obce z PSČ záznamu: kód obce RÚIAN, u starších dat název + okres.
  function obecKey(p) {
    return p[4] ? String(p[4]) : p[3] + '|' + p[2];
  }

  // Obce z PSČ bodů: sečte objednávky podle obce, poloha = vážený průměr PSČ bodů.
  // psc = { '12345': [lat, lon, okres, obec, kódObce] }, mista = [{psc, n, kc}]
  function obce(mista, psc) {
    const by = new Map();
    let nezname = 0;
    for (const x of mista || []) {
      const p = psc && psc[x.psc];
      if (!p) {
        nezname += x.n;
        continue;
      }
      const key = obecKey(p);
      let o = by.get(key);
      if (!o) by.set(key, (o = { key, kod: p[4] || null, nazev: p[3], okres: p[2], lat: 0, lon: 0, n: 0, kc: 0, psc: [] }));
      o.lat += p[0] * x.n;
      o.lon += p[1] * x.n;
      o.n += x.n;
      o.kc += x.kc || 0;
      o.psc.push(x.psc);
    }
    const out = [...by.values()];
    for (const o of out) {
      o.lat = Math.round((o.lat / o.n) * 1e4) / 1e4;
      o.lon = Math.round((o.lon / o.n) * 1e4) / 1e4;
    }
    out.sort((a, b) => b.n - a.n);
    return { obce: out, nezname };
  }

  // Bílá místa: obce s aspoň minN objednávkami, kde do r km není partner ani vlastní pobočka.
  function bilaMista(obceArr, krytiGrid, r, minN) {
    const out = [];
    for (const o of obceArr) {
      if (o.n < (minN || 1)) continue;
      const nb = krytiGrid && krytiGrid.size ? krytiGrid.nejblizsi(o.lat, o.lon, r) : null;
      if (nb) continue;
      out.push(o);
    }
    return out;
  }

  return { km, mrizka, poptavka, skore, obecKey, obce, bilaMista };
});
