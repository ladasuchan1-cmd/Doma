// Geometrie bez závislostí – WKT parser, zjednodušení linií (Douglas–Peucker), bod v polygonu,
// vzdálenosti a mřížkový index úseček. Souřadnice uvnitř knihovny jsou [lon, lat] (jako GeoJSON).
// Soubor je UMD: v prohlížeči vytvoří `MP.geo`, v Node se načte přes require().
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.MP = root.MP || {}; root.MP.geo = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEG = Math.PI / 180;
  const M_PER_DEG = 111320; // metrů na stupeň zeměpisné šířky

  // ------------------------------------------------------------------ WKT
  function stripParens(s) {
    s = s.trim();
    if (s.startsWith('(') && s.endsWith(')')) return s.slice(1, -1).trim();
    return s;
  }

  // Rozdělí řetězec čárkami na nulté úrovni závorek.
  function splitTop(s) {
    const out = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '(') depth++;
      else if (c === ')') depth--;
      else if (c === ',' && depth === 0) {
        out.push(s.slice(start, i));
        start = i + 1;
      }
    }
    out.push(s.slice(start));
    return out.map((x) => x.trim()).filter(Boolean);
  }

  function parseCoord(s) {
    const parts = s.trim().split(/\s+/);
    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
    return [lon, lat];
  }

  function parseCoordList(s) {
    const out = [];
    for (const part of s.split(',')) {
      const c = parseCoord(part);
      if (c) out.push(c);
    }
    return out;
  }

  function parseInto(s, out) {
    const m = /^\s*([A-Za-z]+)\s*(?:ZM|Z|M)?\s*/.exec(s);
    if (!m) return;
    const type = m[1].toUpperCase();
    let body = s.slice(m[0].length).trim();
    if (!body || body.toUpperCase() === 'EMPTY') return;
    body = stripParens(body);
    switch (type) {
      case 'POINT': {
        const c = parseCoord(body);
        if (c) out.points.push(c);
        break;
      }
      case 'LINESTRING': {
        const l = parseCoordList(body);
        if (l.length) out.lines.push(l);
        break;
      }
      case 'POLYGON': {
        const rings = splitTop(body).map((r) => parseCoordList(stripParens(r))).filter((r) => r.length >= 3);
        if (rings.length) out.polygons.push(rings);
        break;
      }
      case 'MULTIPOINT':
        for (const p of splitTop(body)) {
          const c = parseCoord(stripParens(p));
          if (c) out.points.push(c);
        }
        break;
      case 'MULTILINESTRING':
        for (const l of splitTop(body)) {
          const line = parseCoordList(stripParens(l));
          if (line.length) out.lines.push(line);
        }
        break;
      case 'MULTIPOLYGON':
        for (const p of splitTop(body)) {
          const rings = splitTop(stripParens(p)).map((r) => parseCoordList(stripParens(r))).filter((r) => r.length >= 3);
          if (rings.length) out.polygons.push(rings);
        }
        break;
      case 'GEOMETRYCOLLECTION':
        for (const g of splitTop(body)) parseInto(g, out);
        break;
      default:
        break;
    }
  }

  // Vrátí { points: [[lon,lat]], lines: [[[lon,lat],…]], polygons: [[ring,…]] }.
  function parseWkt(wkt) {
    const out = { points: [], lines: [], polygons: [] };
    if (typeof wkt === 'string' && wkt.trim()) parseInto(wkt, out);
    return out;
  }

  // ------------------------------------------------------------- vzdálenosti
  function haversineM(lat1, lon1, lat2, lon2) {
    const dLat = (lat2 - lat1) * DEG;
    const dLon = (lon2 - lon1) * DEG;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
  }

  // Délka lomené čáry [lon,lat] v km.
  function lineLengthKm(coords) {
    let m = 0;
    for (let i = 1; i < coords.length; i++) m += haversineM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    return m / 1000;
  }

  // Vzdálenost bodu od úsečky v rovině (jednotky vstupu).
  function segDistPlane(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    let t = 0;
    const len2 = dx * dx + dy * dy;
    if (len2 > 0) t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const x = ax + t * dx;
    const y = ay + t * dy;
    return Math.hypot(px - x, py - y);
  }

  // Vzdálenost bodu (lon,lat) od úsečky v metrech (ekvirektangulární aproximace – pro ČR dostatečná).
  function distToSegmentM(lon, lat, lon1, lat1, lon2, lat2) {
    const cos = Math.cos(lat * DEG);
    return segDistPlane(lon * cos, lat, lon1 * cos, lat1, lon2 * cos, lat2) * M_PER_DEG;
  }

  // ------------------------------------------------------- zjednodušení linie
  // Douglas–Peucker, tolerance v metrech; iterativně (dlouhé trasy, žádná rekurze).
  function simplify(points, tolM) {
    const n = points.length;
    if (n <= 2 || !(tolM > 0)) return points.slice();
    const tol = tolM / M_PER_DEG;
    const cos = Math.cos(points[Math.floor(n / 2)][1] * DEG);
    const keep = new Uint8Array(n);
    keep[0] = 1;
    keep[n - 1] = 1;
    const stack = [[0, n - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      if (b - a < 2) continue;
      const ax = points[a][0] * cos;
      const ay = points[a][1];
      const bx = points[b][0] * cos;
      const by = points[b][1];
      let maxD = -1;
      let idx = -1;
      for (let i = a + 1; i < b; i++) {
        const d = segDistPlane(points[i][0] * cos, points[i][1], ax, ay, bx, by);
        if (d > maxD) {
          maxD = d;
          idx = i;
        }
      }
      if (maxD > tol) {
        keep[idx] = 1;
        stack.push([a, idx], [idx, b]);
      }
    }
    const out = [];
    for (let i = 0; i < n; i++) if (keep[i]) out.push(points[i]);
    return out;
  }

  // Zaokrouhlení souřadnic (výchozí 5 míst ≈ 1 m) – šetří místo ve výstupních souborech.
  function round(v, places) {
    const f = 10 ** (places == null ? 5 : places);
    return Math.round(v * f) / f;
  }

  // --------------------------------------------------------- bod v polygonu
  function pointInRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0];
      const yi = ring[i][1];
      const xj = ring[j][0];
      const yj = ring[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // rings[0] je vnější obvod, další jsou díry.
  function pointInPolygon(x, y, rings) {
    if (!rings.length || !pointInRing(x, y, rings[0])) return false;
    for (let k = 1; k < rings.length; k++) if (pointInRing(x, y, rings[k])) return false;
    return true;
  }

  // GeoJSON geometrie Polygon / MultiPolygon.
  function pointInGeometry(x, y, geometry) {
    if (!geometry) return false;
    if (geometry.type === 'Polygon') return pointInPolygon(x, y, geometry.coordinates);
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.some((poly) => pointInPolygon(x, y, poly));
    return false;
  }

  // ------------------------------------------------------------------- bbox
  // bbox = [minLon, minLat, maxLon, maxLat]
  function bboxOf(coords, acc) {
    const b = acc || [Infinity, Infinity, -Infinity, -Infinity];
    for (const c of coords) {
      if (c[0] < b[0]) b[0] = c[0];
      if (c[1] < b[1]) b[1] = c[1];
      if (c[0] > b[2]) b[2] = c[0];
      if (c[1] > b[3]) b[3] = c[1];
    }
    return b;
  }

  function bboxOfGeometry(geometry) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    const walk = (c) => {
      if (typeof c[0] === 'number') bboxOf([c], b);
      else for (const x of c) walk(x);
    };
    if (geometry && geometry.coordinates) walk(geometry.coordinates);
    return b;
  }

  function bboxContains(b, x, y) {
    return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  }

  // Těžiště: pro polygon plošně vážené těžiště vnějšího obvodu, jinak průměr bodů.
  function centroid(parsed) {
    if (parsed.polygons.length) {
      const ring = parsed.polygons.reduce((best, p) => (p[0].length > (best ? best[0].length : 0) ? p : best), null)[0];
      let area = 0;
      let cx = 0;
      let cy = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        area += f;
        cx += (ring[j][0] + ring[i][0]) * f;
        cy += (ring[j][1] + ring[i][1]) * f;
      }
      if (Math.abs(area) > 1e-12) return [cx / (3 * area), cy / (3 * area)];
      return average(ring);
    }
    if (parsed.lines.length) return average(parsed.lines.flat());
    if (parsed.points.length) return average(parsed.points);
    return null;
  }

  function average(pts) {
    if (!pts.length) return null;
    let x = 0;
    let y = 0;
    for (const p of pts) {
      x += p[0];
      y += p[1];
    }
    return [x / pts.length, y / pts.length];
  }

  // ------------------------------------------------------- mřížkový index
  // Index úseček do čtvercové mřížky (velikost buňky ve stupních) pro rychlé hledání nejbližších linií.
  class SegmentGrid {
    constructor(cell) {
      this.cell = cell || 0.02;
      this.cells = new Map();
      this.count = 0;
    }

    key(ix, iy) {
      return ix * 1000003 + iy;
    }

    // coords: [[lon,lat],…]; ref: libovolný identifikátor linie
    addLine(coords, ref) {
      const cell = this.cell;
      for (let i = 0; i < coords.length - 1; i++) {
        const x1 = coords[i][0];
        const y1 = coords[i][1];
        const x2 = coords[i + 1][0];
        const y2 = coords[i + 1][1];
        const seg = { x1, y1, x2, y2, ref };
        const ix0 = Math.floor(Math.min(x1, x2) / cell);
        const ix1 = Math.floor(Math.max(x1, x2) / cell);
        const iy0 = Math.floor(Math.min(y1, y2) / cell);
        const iy1 = Math.floor(Math.max(y1, y2) / cell);
        for (let ix = ix0; ix <= ix1; ix++) {
          for (let iy = iy0; iy <= iy1; iy++) {
            const k = this.key(ix, iy);
            let arr = this.cells.get(k);
            if (!arr) {
              arr = [];
              this.cells.set(k, arr);
            }
            arr.push(seg);
          }
        }
        this.count++;
      }
    }

    // Vrátí Map(ref → nejmenší vzdálenost v m) pro všechny linie do maxM od bodu.
    within(lon, lat, maxM) {
      const cos = Math.cos(lat * DEG) || 1e-9;
      const dLat = maxM / M_PER_DEG;
      const dLon = maxM / (M_PER_DEG * cos);
      const cell = this.cell;
      const ix0 = Math.floor((lon - dLon) / cell);
      const ix1 = Math.floor((lon + dLon) / cell);
      const iy0 = Math.floor((lat - dLat) / cell);
      const iy1 = Math.floor((lat + dLat) / cell);
      const px = lon * cos;
      const best = new Map();
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const arr = this.cells.get(this.key(ix, iy));
          if (!arr) continue;
          for (const s of arr) {
            const d = segDistPlane(px, lat, s.x1 * cos, s.y1, s.x2 * cos, s.y2) * M_PER_DEG;
            if (d > maxM) continue;
            const prev = best.get(s.ref);
            if (prev === undefined || d < prev) best.set(s.ref, d);
          }
        }
      }
      return best;
    }

    // Nejbližší linie do maxM: { ref, dist } nebo null.
    nearest(lon, lat, maxM) {
      let bestRef = null;
      let bestD = Infinity;
      for (const [ref, d] of this.within(lon, lat, maxM)) {
        if (d < bestD) {
          bestD = d;
          bestRef = ref;
        }
      }
      return bestRef === null ? null : { ref: bestRef, dist: bestD };
    }
  }

  // Převod [lon,lat] → [lat,lon] (Leaflet) se zaokrouhlením.
  function toLatLng(coords, places) {
    return coords.map((c) => [round(c[1], places), round(c[0], places)]);
  }

  return {
    parseWkt,
    haversineM,
    lineLengthKm,
    distToSegmentM,
    simplify,
    round,
    pointInRing,
    pointInPolygon,
    pointInGeometry,
    bboxOf,
    bboxOfGeometry,
    bboxContains,
    centroid,
    SegmentGrid,
    toLatLng,
  };
});
