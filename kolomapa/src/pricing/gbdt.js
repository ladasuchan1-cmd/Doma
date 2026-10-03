'use strict';
// Gradient boosting regresních stromů bez závislostí (histogramový, jako LightGBM v malém): hodnoty příznaků se
// rozdělí do ≤ MAX_BINS košů podle kvantilů, strom roste po úrovních a dělení se hledá v histogramech součtů
// gradientů. Ztráta Huberova (robustní vůči nesmyslným cenám). Chybějící hodnota (NaN) má vlastní koš 0.
// Použití v nacenění: druhý stupeň nad lineárním modelem – učí se jeho zbytkovou chybu z kombinací vlastností
// (stáří × třída značky, e-kolo × baterie × stáří, shoda se srovnatelnými …), které lineární model nezachytí.

const MAX_BINS = 32;

/** Deterministický generátor (mulberry32) – stejná data → stejný model. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Hranice košů jednoho příznaku (kvantily bez duplicit). */
function binEdges(values) {
  const v = [];
  for (const x of values) if (Number.isFinite(x)) v.push(x);
  if (!v.length) return [];
  v.sort((a, b) => a - b);
  const uniq = [];
  for (const x of v) if (!uniq.length || uniq[uniq.length - 1] !== x) uniq.push(x);
  if (uniq.length <= MAX_BINS - 1) return uniq.slice(0, -1).map((x, i) => (x + uniq[i + 1]) / 2);
  const edges = [];
  for (let k = 1; k < MAX_BINS - 1; k++) {
    const e = v[Math.floor((k * v.length) / (MAX_BINS - 1))];
    if (!edges.length || e > edges[edges.length - 1]) edges.push(e);
  }
  return edges;
}

/** Koš hodnoty: 0 = chybí, 1 + počet hranic < x. */
function binOf(edges, x) {
  if (!Number.isFinite(x)) return 0;
  let lo = 0;
  let hi = edges.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (x > edges[mid]) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/**
 * Naučí boosting.
 * @param {number[][]} X řádky příznaků (NaN = chybí)
 * @param {number[]} y cíl (zbytková chyba v log ceně)
 * @param {{trees?: number, depth?: number, lr?: number, minLeaf?: number, subsample?: number, l2?: number,
 *          delta?: number, seed?: number, weights?: number[]}} [o]
 */
function fitBoost(X, y, o = {}) {
  const { trees = 250, depth = 4, lr = 0.05, minLeaf = 40, subsample = 0.8, l2 = 5, delta = 0.4, seed = 7 } = o;
  const n = X.length;
  const p = n ? X[0].length : 0;
  const w = o.weights ? Float64Array.from(o.weights) : new Float64Array(n).fill(1);
  const edges = [];
  const bins = [];
  for (let j = 0; j < p; j++) {
    const col = new Float64Array(n);
    for (let i = 0; i < n; i++) col[i] = X[i][j];
    const e = binEdges(col);
    edges.push(e);
    const b = new Uint8Array(n);
    for (let i = 0; i < n; i++) b[i] = binOf(e, col[i]);
    bins.push(b);
  }
  const nb = MAX_BINS + 1;
  const F = new Float64Array(n);
  const g = new Float64Array(n);
  const node = new Int32Array(n);
  const rand = rng(seed);
  const model = { edges, trees: [], lr };
  for (let t = 0; t < trees; t++) {
    for (let i = 0; i < n; i++) {
      const r = y[i] - F[i];
      g[i] = r > delta ? delta : r < -delta ? -delta : r;
    }
    // řádky stromu (podvzorek)
    const rows = [];
    for (let i = 0; i < n; i++) if (rand() < subsample) rows.push(i);
    const nodes = [{ leaf: true, value: 0 }];
    let level = [0];
    for (const i of rows) node[i] = 0;
    for (let d = 0; d < depth && level.length; d++) {
      const stats = new Map(); // uzel → {G, W, hist}
      for (const id of level) stats.set(id, { G: 0, W: 0, n: 0, hG: new Float64Array(p * nb), hW: new Float64Array(p * nb), hN: new Int32Array(p * nb) });
      for (const i of rows) {
        const s = stats.get(node[i]);
        if (!s) continue;
        const gi = g[i] * w[i];
        s.G += gi;
        s.W += w[i];
        s.n++;
        for (let j = 0; j < p; j++) {
          const k = j * nb + bins[j][i];
          s.hG[k] += gi;
          s.hW[k] += w[i];
          s.hN[k]++;
        }
      }
      const next = [];
      for (const id of level) {
        const s = stats.get(id);
        nodes[id].value = s.W > 0 ? s.G / (s.W + l2) : 0;
        if (s.n < 2 * minLeaf) continue;
        const base = (s.G * s.G) / (s.W + l2);
        let best = null;
        for (let j = 0; j < p; j++) {
          // chybějící hodnoty (koš 0) zkusit vlevo i vpravo
          for (const missLeft of [true, false]) {
            let GL = missLeft ? s.hG[j * nb] : 0;
            let WL = missLeft ? s.hW[j * nb] : 0;
            let NL = missLeft ? s.hN[j * nb] : 0;
            for (let b = 1; b < nb - 1; b++) {
              const k = j * nb + b;
              GL += s.hG[k];
              WL += s.hW[k];
              NL += s.hN[k];
              const NR = s.n - NL;
              if (NL < minLeaf || NR < minLeaf) continue;
              const GR = s.G - GL;
              const WR = s.W - WL;
              const gain = (GL * GL) / (WL + l2) + (GR * GR) / (WR + l2) - base;
              if (gain > 1e-9 && (!best || gain > best.gain)) best = { gain, j, b, missLeft };
            }
            if (!s.hN[j * nb]) break; // bez chybějících hodnot je druhý průchod stejný
          }
        }
        if (!best) continue;
        const left = nodes.length;
        nodes.push({ leaf: true, value: 0 }, { leaf: true, value: 0 });
        Object.assign(nodes[id], { leaf: false, f: best.j, b: best.b, missLeft: best.missLeft, left, right: left + 1 });
        next.push(left, left + 1);
      }
      for (const i of rows) {
        const nd = nodes[node[i]];
        if (nd.leaf) continue;
        const bi = bins[nd.f][i];
        node[i] = (bi === 0 ? nd.missLeft : bi <= nd.b) ? nd.left : nd.right;
      }
      level = next;
    }
    // hodnoty listů v poslední úrovni
    if (level.length) {
      const acc = new Map(level.map((id) => [id, [0, 0]]));
      for (const i of rows) {
        const a = acc.get(node[i]);
        if (a) {
          a[0] += g[i] * w[i];
          a[1] += w[i];
        }
      }
      for (const [id, [G, W]] of acc) nodes[id].value = W > 0 ? G / (W + l2) : 0;
    }
    const tree = nodes.map((nd) => (nd.leaf ? { v: nd.value * lr } : { f: nd.f, b: nd.b, m: nd.missLeft ? 1 : 0, l: nd.left, r: nd.right }));
    model.trees.push(tree);
    // aktualizace předpovědí všech řádků
    for (let i = 0; i < n; i++) {
      let k = 0;
      for (;;) {
        const nd = tree[k];
        if (nd.v !== undefined) {
          F[i] += nd.v;
          break;
        }
        const bi = bins[nd.f][i];
        k = (bi === 0 ? nd.m === 1 : bi <= nd.b) ? nd.l : nd.r;
      }
    }
  }
  return model;
}

/** Předpověď pro jeden řádek příznaků. */
function predictBoost(model, x) {
  if (!model || !model.trees.length) return 0;
  const b = model.edges.map((e, j) => binOf(e, x[j]));
  let s = 0;
  for (const tree of model.trees) {
    let k = 0;
    for (;;) {
      const nd = tree[k];
      if (nd.v !== undefined) {
        s += nd.v;
        break;
      }
      const bi = b[nd.f];
      k = (bi === 0 ? nd.m === 1 : bi <= nd.b) ? nd.l : nd.r;
    }
  }
  return s;
}

module.exports = { fitBoost, predictBoost, binEdges, binOf, MAX_BINS };
