// Jednoduché inline SVG grafy: seznam pruhů, skládaný pruh (pozice), čárový graf historie cen, sparkline.
// Barvy řad: CSS proměnné --s1 … --s8 (kategorická paleta, světlý i tmavý režim), naše cena = --series-us.
// Čisté výpočty (niceTicks, stepPoints, valueAt) jsou exportované kvůli testům.

import { h, svg, mount } from './dom.js';
import { money, shortDate, dateTime, percent, int, NBSP } from './format.js';

export const SERIES_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)', 'var(--s7)', 'var(--s8)'];

/** „Hezké“ hodnoty os: niceTicks(0, 97, 5) → [0, 20, 40, 60, 80, 100]. */
export function niceTicks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) {
    const pad = Math.abs(min) * 0.05 || 1;
    min -= pad;
    max += pad;
  }
  if (min > max) [min, max] = [max, min];
  const span = max - min;
  let step = 10 ** Math.floor(Math.log10(span / count));
  const err = (count / span) * step;
  if (err <= 0.15) step *= 10;
  else if (err <= 0.35) step *= 5;
  else if (err <= 0.75) step *= 2;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const out = [];
  for (let v = start; v <= end + step / 2; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/** Lineární škála. */
export function scale(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return (v) => r0 + (v - d0) * k;
}

/** Hodnota schodovité řady v čase t (poslední bod s t_i ≤ t), jinak null. */
export function valueAt(points, t) {
  let v = null;
  for (const p of points) {
    if (p.t <= t) v = p.v;
    else break;
  }
  return v;
}

/** Body schodovité čáry (cena platí do další změny) protažené do času `end`. */
export function stepPoints(points, end) {
  const out = [];
  points.forEach((p, i) => {
    if (i > 0) out.push({ t: p.t, v: points[i - 1].v });
    out.push({ t: p.t, v: p.v });
  });
  if (points.length && end != null && end > points[points.length - 1].t) out.push({ t: end, v: points[points.length - 1].v });
  return out;
}

// ------------------------------------------------------------------ seznam vodorovných pruhů

/**
 * Vodorovné pruhy (štítek | pruh | hodnota). Pruhy jsou SVG s procentní šířkou → responzivní.
 * @param {{label: any, value: number, display?: string, href?: string, title?: string}[]} items
 * @param {{max?: number, format?: (v: number) => string, color?: string, ariaLabel?: string}} [o]
 */
export function barList(items, o = {}) {
  const max = o.max ?? Math.max(0, ...items.map((i) => Number(i.value) || 0));
  const fmt = o.format || ((v) => int(v));
  return h(
    'div',
    { class: 'barlist', role: 'list', 'aria-label': o.ariaLabel },
    items.map((it) => {
      const v = Number(it.value) || 0;
      const pct = max > 0 ? Math.max(0, Math.min(100, (v / max) * 100)) : 0;
      const label = it.href ? h('a', { href: it.href }, it.label) : it.label;
      return h(
        'div',
        { class: 'barlist-row', role: 'listitem', title: it.title },
        h('div', { class: 'barlist-label' }, label),
        h(
          'div',
          { class: 'barlist-bar' },
          svg(
            'svg',
            { width: '100%', height: '12', 'aria-hidden': 'true', preserveAspectRatio: 'none' },
            svg('rect', { x: '0', y: '0', width: '100%', height: '12', rx: '3', class: 'bar-track' }),
            pct > 0 ? svg('rect', { x: '0', y: '0', width: pct.toFixed(2) + '%', height: '12', rx: '3', style: { fill: it.color || o.color || 'var(--s1)' } }) : null
          )
        ),
        h('div', { class: 'barlist-value num' }, it.display ?? fmt(v))
      );
    })
  );
}

// ------------------------------------------------------------------ skládaný pruh

/**
 * 100% skládaný pruh s legendou (např. rozložení pozic).
 * @param {{key: string, label: string, value: number, color: string, href?: string}[]} segments
 */
export function stackedBar(segments, o = {}) {
  const total = segments.reduce((s, x) => s + (Number(x.value) || 0), 0);
  let x = 0;
  const rects = [];
  for (const s of segments) {
    const v = Number(s.value) || 0;
    if (!v || !total) continue;
    const w = (v / total) * 100;
    const r = svg('rect', {
      x: x.toFixed(3) + '%',
      y: '0',
      width: w.toFixed(3) + '%',
      height: String(o.height || 22),
      class: 'stack-seg',
      style: { fill: s.color },
    });
    r.appendChild(svg('title', null, `${s.label}: ${int(v)} (${percent((v / total) * 100)})`));
    rects.push(r);
    x += w;
  }
  const bar = svg(
    'svg',
    { class: 'stackbar', width: '100%', height: String(o.height || 22), role: 'img', 'aria-label': o.ariaLabel || 'Rozložení', preserveAspectRatio: 'none' },
    total ? rects : svg('rect', { x: '0', y: '0', width: '100%', height: String(o.height || 22), class: 'bar-track' })
  );
  const legend = h(
    'ul',
    { class: 'legend legend-stack' },
    segments.map((s) => {
      const v = Number(s.value) || 0;
      const inner = [
        h('span', { class: 'swatch', style: { background: s.color }, 'aria-hidden': 'true' }),
        h('span', { class: 'legend-label' }, s.label),
        h('span', { class: 'legend-value num' }, int(v)),
        h('span', { class: 'legend-pct num' }, total ? percent((v / total) * 100, 0) : '–'),
      ];
      return h('li', null, s.href ? h('a', { href: s.href, class: 'legend-link' }, inner) : inner);
    })
  );
  return h('div', { class: 'stack-wrap' }, bar, legend);
}

// ------------------------------------------------------------------ sparkline

export function sparkline(values, o = {}) {
  const vals = values.filter((v) => Number.isFinite(v));
  const w = o.width || 96;
  const hh = o.height || 28;
  if (vals.length < 2) return svg('svg', { class: 'spark', width: w, height: hh, 'aria-hidden': 'true' });
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const x = scale(0, vals.length - 1, 2, w - 4);
  const y = scale(min, max === min ? min + 1 : max, hh - 4, 4);
  const pts = vals.map((v, i) => x(i).toFixed(1) + ',' + y(v).toFixed(1)).join(' ');
  const last = vals[vals.length - 1];
  return svg(
    'svg',
    { class: 'spark', width: w, height: hh, viewBox: `0 0 ${w} ${hh}`, role: 'img', 'aria-label': o.ariaLabel || 'Vývoj' },
    svg('polyline', { points: pts, fill: 'none', style: { stroke: o.color || 'var(--s1)' }, 'stroke-width': '1.5', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }),
    svg('circle', { cx: x(vals.length - 1).toFixed(1), cy: y(last).toFixed(1), r: '2.5', style: { fill: o.color || 'var(--s1)' } })
  );
}

// ------------------------------------------------------------------ čárový graf

/**
 * Čárový (schodovitý) graf vývoje cen s tooltipem, legendou (přepínání řad) a responzivní šířkou.
 * @param {{series: {id: string, name: string, color: string, points: {t: number, v: number}[], width?: number, dash?: string, us?: boolean}[],
 *          height?: number, from?: number, to?: number, yFormat?: Function, ariaLabel?: string}} o
 */
export function lineChart(o) {
  const height = o.height || 260;
  const yFormat = o.yFormat || ((v) => money(v));
  const hidden = new Set(o.hidden || []);
  const plot = h('div', { class: 'chart-plot', style: { height: height + 'px' } });
  const tip = h('div', { class: 'chart-tip', hidden: true, role: 'status', 'aria-live': 'off' });
  const legend = h('div', { class: 'legend legend-lines' });
  const wrap = h('div', { class: 'chart' }, plot, tip, legend);
  const series = o.series.filter((s) => s.points && s.points.length);
  let lastWidth = 0;

  function renderLegend() {
    mount(
      legend,
      series.map((s) =>
        h(
          'button',
          {
            type: 'button',
            class: ['legend-item', hidden.has(s.id) ? 'is-off' : null],
            'aria-pressed': hidden.has(s.id) ? 'false' : 'true',
            title: hidden.has(s.id) ? 'Zobrazit řadu' : 'Skrýt řadu',
            onClick: () => {
              if (hidden.has(s.id)) hidden.delete(s.id);
              else hidden.add(s.id);
              renderLegend();
              draw(lastWidth);
            },
          },
          h('span', { class: ['swatch-line', s.us ? 'is-us' : null], style: { background: s.color }, 'aria-hidden': 'true' }),
          h('span', null, s.name)
        )
      )
    );
  }

  function draw(width) {
    if (!width) return;
    lastWidth = width;
    const vis = series.filter((s) => !hidden.has(s.id));
    const allT = series.flatMap((s) => s.points.map((p) => p.t));
    const from = o.from ?? Math.min(...allT);
    const to = o.to ?? Math.max(...allT, Date.now());
    const vals = vis.flatMap((s) => s.points.map((p) => p.v));
    if (!vals.length) {
      mount(plot, h('div', { class: 'chart-empty' }, 'Žádná zobrazená řada'));
      return;
    }
    const ticks = niceTicks(Math.min(...vals), Math.max(...vals), height > 200 ? 5 : 3);
    const y0 = ticks[0];
    const y1 = ticks[ticks.length - 1];
    const labelW = Math.max(...ticks.map((t) => yFormat(t).length)) * 6.6 + 10;
    const m = { l: Math.min(96, labelW), r: 14, t: 10, b: 26 };
    const X = scale(from, to, m.l, width - m.r);
    const Y = scale(y0, y1, height - m.b, m.t);
    const nodes = [];
    for (const t of ticks) {
      nodes.push(svg('line', { x1: m.l, x2: width - m.r, y1: Y(t), y2: Y(t), class: 'grid' }));
      nodes.push(svg('text', { x: m.l - 8, y: Y(t) + 4, class: 'axis-label', 'text-anchor': 'end' }, yFormat(t)));
    }
    // osa X – denní dělení
    const day = 86400000;
    const span = to - from;
    const nX = Math.max(2, Math.floor((width - m.l - m.r) / 90));
    const stepDays = Math.max(1, Math.ceil(span / day / nX));
    const first = Math.ceil(from / day) * day;
    for (let t = first; t <= to; t += stepDays * day) {
      nodes.push(svg('text', { x: X(t), y: height - 8, class: 'axis-label', 'text-anchor': 'middle' }, shortDate(t)));
    }
    nodes.push(svg('line', { x1: m.l, x2: width - m.r, y1: height - m.b, y2: height - m.b, class: 'baseline' }));
    // řady – naše cena vykreslená jako poslední (nahoře)
    const ordered = [...vis].sort((a, b) => (a.us ? 1 : 0) - (b.us ? 1 : 0));
    for (const s of ordered) {
      const pts = stepPoints(s.points.filter((p) => p.t <= to), to);
      if (!pts.length) continue;
      const d = pts.map((p, i) => (i ? 'L' : 'M') + X(Math.max(from, p.t)).toFixed(1) + ' ' + Y(p.v).toFixed(1)).join('');
      nodes.push(
        svg('path', {
          d,
          fill: 'none',
          class: ['series', s.us ? 'series-us' : null].filter(Boolean).join(' '),
          style: { stroke: s.color },
          'stroke-width': s.width || (s.us ? 2.5 : 1.75),
          'stroke-dasharray': s.dash || null,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round',
        })
      );
      const lp = s.points[s.points.length - 1];
      nodes.push(svg('circle', { cx: X(to).toFixed(1), cy: Y(lp.v).toFixed(1), r: s.us ? 4.5 : 3.5, class: 'end-dot', style: { fill: s.color } }));
    }
    const cursor = svg('line', { x1: 0, x2: 0, y1: m.t, y2: height - m.b, class: 'cursor', visibility: 'hidden' });
    const hoverDots = svg('g', { class: 'hover-dots' });
    const overlay = svg('rect', { x: m.l, y: m.t, width: Math.max(0, width - m.l - m.r), height: Math.max(0, height - m.t - m.b), fill: 'transparent', class: 'overlay' });
    const root = svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': o.ariaLabel || 'Graf vývoje cen' }, nodes, cursor, hoverDots, overlay);

    const move = (e) => {
      const rect = root.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const t = from + ((px - m.l) / (width - m.l - m.r)) * (to - from);
      if (t < from || t > to) return leave();
      cursor.setAttribute('x1', px);
      cursor.setAttribute('x2', px);
      cursor.setAttribute('visibility', 'visible');
      const rows = vis
        .map((s) => ({ s, v: valueAt(s.points, t) }))
        .filter((r) => r.v != null)
        .sort((a, b) => a.v - b.v);
      mount(hoverDots, rows.map((r) => svg('circle', { cx: px, cy: Y(r.v), r: r.s.us ? 4.5 : 3.5, class: 'end-dot', style: { fill: r.s.color } })));
      mount(
        tip,
        h('div', { class: 'chart-tip-date' }, dateTime(t)),
        rows.length
          ? h('table', null, rows.map((r) => h('tr', { class: r.s.us ? 'is-us' : null }, h('td', null, h('span', { class: 'swatch', style: { background: r.s.color } })), h('td', null, r.s.name), h('td', { class: 'num' }, yFormat(r.v)))))
          : h('div', { class: 'muted' }, 'Bez dat')
      );
      tip.hidden = false;
      const tw = tip.offsetWidth || 180;
      const left = px + 14 + tw > width ? px - tw - 14 : px + 14;
      tip.style.left = Math.max(0, left) + 'px';
      tip.style.top = m.t + 'px';
    };
    const leave = () => {
      cursor.setAttribute('visibility', 'hidden');
      mount(hoverDots);
      tip.hidden = true;
    };
    overlay.addEventListener('pointermove', move);
    overlay.addEventListener('pointerleave', leave);
    mount(plot, root);
  }

  if (!series.length) {
    mount(plot, h('div', { class: 'chart-empty' }, o.emptyText || 'Zatím žádná historie cen'));
    return wrap;
  }
  renderLegend();
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w && Math.abs(w - lastWidth) > 2) draw(w);
    });
    ro.observe(plot);
  } else {
    setTimeout(() => draw(plot.clientWidth || 600), 0);
  }
  return wrap;
}

/** Vertikální sloupcový histogram (např. rozložení změn v %) – responzivní. */
export function histogram(values, o = {}) {
  const bins = o.bins || [-20, -15, -10, -5, -2, 0, 2, 5, 10, 15, 20];
  const counts = new Array(bins.length + 1).fill(0);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    let i = bins.findIndex((b) => v < b);
    if (i < 0) i = bins.length;
    counts[i] += 1;
  }
  const labels = counts.map((_, i) => (i === 0 ? '< ' + bins[0] : i === bins.length ? '≥ ' + bins[bins.length - 1] : bins[i - 1] + ' až ' + bins[i]));
  const max = Math.max(1, ...counts);
  const height = o.height || 120;
  const cols = counts.map((c, i) => {
    const hp = (c / max) * 100;
    const zero = bins.indexOf(0);
    const neg = zero >= 0 && i <= zero;
    return h(
      'div',
      { class: 'histo-col', title: labels[i] + ' %: ' + int(c) },
      h('div', { class: 'histo-val num' }, c ? int(c) : ''),
      h('div', { class: 'histo-bar-wrap', style: { height: height + 'px' } }, h('div', { class: ['histo-bar', neg ? 'is-neg' : 'is-pos'], style: { height: hp.toFixed(1) + '%' } })),
      h('div', { class: 'histo-label' }, labels[i].replace(/ /g, NBSP))
    );
  });
  return h('div', { class: 'histo', role: 'img', 'aria-label': o.ariaLabel || 'Rozložení změn' }, cols);
}
