// Sada jednoduchých čárových ikon (24×24, stroke = currentColor). Vlastní kresba.
import { svg } from './dom.js';

// Ozubené kolo generované výpočtem (8 zubů).
function gearPath() {
  const teeth = 8;
  const rOut = 10;
  const rIn = 7.6;
  const pts = [];
  for (let i = 0; i < teeth; i++) {
    const a0 = (i / teeth) * Math.PI * 2;
    const w = (Math.PI * 2) / teeth;
    const angles = [a0 - w * 0.18, a0 + w * 0.18, a0 + w * 0.32, a0 + w * 0.68];
    const radii = [rOut, rOut, rIn, rIn];
    angles.forEach((a, j) => pts.push([12 + radii[j] * Math.cos(a), 12 + radii[j] * Math.sin(a)]));
  }
  return 'M' + pts.map((p) => p[0].toFixed(2) + ' ' + p[1].toFixed(2)).join('L') + 'Z';
}

const P = (d) => ['path', { d }];
const C = (cx, cy, r) => ['circle', { cx, cy, r }];
const R = (x, y, w, hgt, rx = 2) => ['rect', { x, y, width: w, height: hgt, rx }];

export const ICONS = {
  dashboard: [R(3, 3, 7, 9, 1.5), R(14, 3, 7, 5, 1.5), R(14, 12, 7, 9, 1.5), R(3, 16, 7, 5, 1.5)],
  box: [P('M21 8l-9-5-9 5v8l9 5 9-5z'), P('M3 8l9 5 9-5'), P('M12 13v8')],
  tag: [P('M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z'), C(7.5, 7.5, 1.2)],
  sliders: [P('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6')],
  layers: [P('M12 2l10 5-10 5L2 7z'), P('M2 17l10 5 10-5'), P('M2 12l10 5 10-5')],
  store: [P('M3 9l1.6-5h14.8L21 9'), P('M3 9h18v1.5a3 3 0 0 1-6 0 3 3 0 0 1-6 0 3 3 0 0 1-6 0z'), P('M5 13v8h14v-8'), P('M10 21v-5h4v5')],
  upload: [P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), P('M17 8l-5-5-5 5'), P('M12 3v12')],
  download: [P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'), P('M7 10l5 5 5-5'), P('M12 15V3')],
  settings: [P(gearPath()), C(12, 12, 3)],
  play: [['path', { d: 'M7 4.5v15l12.5-7.5z', fill: 'currentColor' }]],
  menu: [P('M3 6h18M3 12h18M3 18h18')],
  x: [P('M18 6L6 18M6 6l12 12')],
  'chevron-down': [P('M6 9l6 6 6-6')],
  'chevron-up': [P('M6 15l6-6 6 6')],
  'chevron-right': [P('M9 6l6 6-6 6')],
  'chevron-left': [P('M15 6l-6 6 6 6')],
  'arrow-up': [P('M12 19V5M5 12l7-7 7 7')],
  'arrow-down': [P('M12 5v14M19 12l-7 7-7-7')],
  'arrow-right': [P('M5 12h14M12 5l7 7-7 7')],
  search: [C(11, 11, 7), P('M21 21l-4.3-4.3')],
  lock: [R(5, 11, 14, 10), P('M8 11V7a4 4 0 0 1 8 0v4')],
  unlock: [R(5, 11, 14, 10), P('M8 11V7a4 4 0 0 1 7.8-1.2')],
  external: [P('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'), P('M15 3h6v6'), P('M10 14L21 3')],
  copy: [R(9, 9, 12, 12), P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')],
  check: [P('M20 6L9 17l-5-5')],
  trash: [P('M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6')],
  edit: [P('M12 20h9'), P('M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z')],
  plus: [P('M12 5v14M5 12h14')],
  minus: [P('M5 12h14')],
  info: [C(12, 12, 10), P('M12 16v-4M12 8h.01')],
  alert: [P('M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'), P('M12 9v4M12 17h.01')],
  'alert-circle': [C(12, 12, 10), P('M12 8v4M12 16h.01')],
  refresh: [P('M21 12a9 9 0 1 1-2.64-6.36'), P('M21 3v6h-6')],
  file: [P('M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'), P('M14 2v6h6')],
  link: [P('M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7'), P('M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7')],
  logout: [P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'), P('M16 17l5-5-5-5'), P('M21 12H9')],
  moon: [P('M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z')],
  sun: [C(12, 12, 4), P('M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4')],
  monitor: [R(2, 3, 20, 14), P('M8 21h8M12 17v4')],
  grip: [C(9, 6, 1), C(15, 6, 1), C(9, 12, 1), C(15, 12, 1), C(9, 18, 1), C(15, 18, 1)],
  key: [C(7.5, 15.5, 4.5), P('M10.7 12.3L21 2M16 7l3 3M18 5l2 2')],
  send: [P('M22 2L11 13'), P('M22 2l-7 20-4-9-9-4z')],
  zap: [P('M13 2L3 14h9l-1 8 10-12h-9z')],
  filter: [P('M22 3H2l8 9.5V19l4 2v-8.5z')],
  clock: [C(12, 12, 10), P('M12 7v5l3 2')],
  chart: [P('M3 3v18h18'), P('M8 17v-6M13 17V7M18 17v-3')],
  code: [P('M16 18l6-6-6-6M8 6l-6 6 6 6')],
  eye: [P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'), C(12, 12, 3)],
  user: [C(12, 8, 4), P('M4 21v-1a7 7 0 0 1 14 0v1')],
  target: [C(12, 12, 10), C(12, 12, 6), C(12, 12, 2)],
  more: [C(5, 12, 1), C(12, 12, 1), C(19, 12, 1)],
  duplicate: [R(8, 8, 13, 13), P('M4 16V5a1 1 0 0 1 1-1h11')],
  inbox: [P('M22 12h-6l-2 3h-4l-2-3H2'), P('M5.5 5.1L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z')],
};

/**
 * SVG ikona. Dekorativní (aria-hidden), pokud není zadán title.
 * @param {string} name
 * @param {{size?: number, title?: string, class?: string}} [opts]
 */
export function icon(name, opts = {}) {
  const def = ICONS[name] || ICONS.info;
  const size = opts.size || 16;
  const attrs = {
    class: ['icon', opts.class].filter(Boolean).join(' '),
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': opts.stroke || 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  };
  if (opts.title) attrs.role = 'img';
  else attrs['aria-hidden'] = 'true';
  const children = def.map(([tag, a]) => svg(tag, a));
  if (opts.title) children.unshift(svg('title', null, opts.title));
  return svg('svg', attrs, children);
}

/** Logo aplikace (graf s tečkou). */
export function brandMark(cls = 'brand-mark') {
  return svg(
    'svg',
    { class: cls, viewBox: '0 0 32 32', 'aria-hidden': 'true', focusable: 'false' },
    svg('rect', { width: 32, height: 32, rx: 8, fill: '#2466cc' }),
    svg('path', { d: 'M7 21.5l6-6.5 4.5 4 7.5-9', fill: 'none', stroke: '#fff', 'stroke-width': 2.6, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    svg('circle', { cx: 25, cy: 10, r: 2.6, fill: '#f5a524' })
  );
}
