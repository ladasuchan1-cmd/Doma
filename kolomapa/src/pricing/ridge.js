'use strict';
// Robustní lineární regrese bez závislostí: hřebenová (ridge) regrese s individuální penalizací každého příznaku,
// řídká matice (CSR) a Huberovy váhy přes IRLS. Soustavu (XᵀWX + Λ)β = XᵀWy řeší předpodmíněné sdružené
// gradienty (CG) – stačí násobení maticí, takže i tisíce příznaků (značky, slova z titulků) jsou otázkou desetin sekundy.

/**
 * Řídká matice po řádcích.
 * @param {Array<Array<[number, number]>>} rows pro každý řádek pole [index příznaku, hodnota]
 * @param {number} p počet příznaků
 */
function toCsr(rows, p) {
  let nnz = 0;
  for (const r of rows) nnz += r.length;
  const ptr = new Int32Array(rows.length + 1);
  const idx = new Int32Array(nnz);
  const val = new Float64Array(nnz);
  let k = 0;
  for (let i = 0; i < rows.length; i++) {
    ptr[i] = k;
    for (const [j, v] of rows[i]) {
      idx[k] = j;
      val[k] = v;
      k++;
    }
  }
  ptr[rows.length] = k;
  return { n: rows.length, p, ptr, idx, val };
}

function predictCsr(X, beta) {
  const out = new Float64Array(X.n);
  for (let i = 0; i < X.n; i++) {
    let s = 0;
    for (let k = X.ptr[i]; k < X.ptr[i + 1]; k++) s += X.val[k] * beta[X.idx[k]];
    out[i] = s;
  }
  return out;
}

/** Vážená ridge regrese: min Σ wᵢ(yᵢ − xᵢβ)² + Σ λⱼβⱼ². */
function solveRidge(X, y, w, lambda, { beta0 = null, maxIter = 400, tol = 1e-7 } = {}) {
  const { n, p, ptr, idx, val } = X;
  const b = new Float64Array(p);
  const diag = new Float64Array(p);
  for (let i = 0; i < n; i++) {
    const wi = w[i];
    if (!wi) continue;
    for (let k = ptr[i]; k < ptr[i + 1]; k++) {
      b[idx[k]] += wi * val[k] * y[i];
      diag[idx[k]] += wi * val[k] * val[k];
    }
  }
  for (let j = 0; j < p; j++) diag[j] += lambda[j];
  const tmp = new Float64Array(n);
  const Av = (v, out) => {
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = ptr[i]; k < ptr[i + 1]; k++) s += val[k] * v[idx[k]];
      tmp[i] = s * w[i];
    }
    out.fill(0);
    for (let i = 0; i < n; i++) {
      const t = tmp[i];
      if (!t) continue;
      for (let k = ptr[i]; k < ptr[i + 1]; k++) out[idx[k]] += val[k] * t;
    }
    for (let j = 0; j < p; j++) out[j] += lambda[j] * v[j];
  };
  const x = beta0 ? Float64Array.from(beta0) : new Float64Array(p);
  const r = new Float64Array(p);
  const Ax = new Float64Array(p);
  Av(x, Ax);
  for (let j = 0; j < p; j++) r[j] = b[j] - Ax[j];
  const z = new Float64Array(p);
  for (let j = 0; j < p; j++) z[j] = diag[j] > 0 ? r[j] / diag[j] : r[j];
  const d = Float64Array.from(z);
  let rz = 0;
  for (let j = 0; j < p; j++) rz += r[j] * z[j];
  let bnorm = 0;
  for (let j = 0; j < p; j++) bnorm += b[j] * b[j];
  bnorm = Math.sqrt(bnorm) || 1;
  const Ad = new Float64Array(p);
  let it = 0;
  for (; it < maxIter; it++) {
    let rn = 0;
    for (let j = 0; j < p; j++) rn += r[j] * r[j];
    if (Math.sqrt(rn) / bnorm < tol) break;
    Av(d, Ad);
    let dAd = 0;
    for (let j = 0; j < p; j++) dAd += d[j] * Ad[j];
    if (!(dAd > 0)) break;
    const alpha = rz / dAd;
    for (let j = 0; j < p; j++) {
      x[j] += alpha * d[j];
      r[j] -= alpha * Ad[j];
    }
    for (let j = 0; j < p; j++) z[j] = diag[j] > 0 ? r[j] / diag[j] : r[j];
    let rz2 = 0;
    for (let j = 0; j < p; j++) rz2 += r[j] * z[j];
    const beta = rz2 / rz;
    rz = rz2;
    for (let j = 0; j < p; j++) d[j] = z[j] + beta * d[j];
  }
  return { beta: x, iterations: it };
}

function median(a) {
  const s = Array.from(a).sort((x, y) => x - y);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Robustní (Huberova) ridge regrese přes IRLS.
 * @param {object} X CSR matice (toCsr)
 * @param {Float64Array|number[]} y cíl (log ceny)
 * @param {Float64Array|number[]} w0 základní váhy řádků
 * @param {Float64Array|number[]} lambda penalizace příznaků
 * @param {{iterations?: number, c?: number}} [o] c = Huberova konstanta v násobcích robustní směrodatné odchylky
 * @returns {{beta: Float64Array, sigma: number, weights: Float64Array, resid: Float64Array}}
 */
function huberRidge(X, y, w0, lambda, { iterations = 6, c = 1.345 } = {}) {
  const n = X.n;
  let w = Float64Array.from(w0);
  let fit = solveRidge(X, y, w, lambda);
  let sigma = 1;
  let resid = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    const pred = predictCsr(X, fit.beta);
    for (let i = 0; i < n; i++) resid[i] = y[i] - pred[i];
    const absr = [];
    for (let i = 0; i < n; i++) if (w0[i] > 0) absr.push(Math.abs(resid[i]));
    sigma = 1.4826 * median(absr) || 1e-3;
    const k = c * sigma;
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.abs(resid[i]);
      w[i] = w0[i] * (a <= k ? 1 : k / a);
    }
    fit = solveRidge(X, y, w, lambda, { beta0: fit.beta, maxIter: 250 });
  }
  const pred = predictCsr(X, fit.beta);
  for (let i = 0; i < n; i++) resid[i] = y[i] - pred[i];
  return { beta: fit.beta, sigma, weights: w, resid };
}

module.exports = { toCsr, predictCsr, solveRidge, huberRidge, median };
