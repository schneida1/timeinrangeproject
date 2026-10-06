// charts.js — dependency-free SVG renderers. Colors come from CSS custom
// properties so light/dark themes and print all work without re-rendering.
import { toDisplay } from './metrics.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const fmtHour = (min) => {
  const h = Math.floor(min / 60) % 24;
  if (h === 0) return '12a';
  if (h === 12) return '12p';
  return h < 12 ? `${h}a` : `${h - 12}p`;
};

export function fmtClock(min) {
  const h = Math.floor(min / 60) % 24, mm = String(min % 60).padStart(2, '0');
  return `${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'AM' : 'PM'}`;
}

// Ambulatory Glucose Profile with 5–95 and 25–75 percentile bands and median.
export function agpChart(agp, { lo = 70, hi = 180, unit = 'mgdl', height = 260, width = 720 } = {}) {
  const W = Math.max(320, Math.min(960, Math.round(width))), H = height, pad = { t: 14, r: 44, b: 26, l: 12 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const yMax = 350;
  const x = (min) => pad.l + (min / 1440) * cw;
  const y = (v) => pad.t + ch - (Math.min(yMax, Math.max(40, v)) - 40) / (yMax - 40) * ch;
  const pts = [...agp, { ...agp[0], minute: 1440 }];
  const line = (key) => pts.map((s, i) => `${i ? 'L' : 'M'}${x(s.minute).toFixed(1)},${y(s[key]).toFixed(1)}`).join('');
  const band = (a, b) => line(a) + pts.slice().reverse().map((s) => `L${x(s.minute).toFixed(1)},${y(s[b]).toFixed(1)}`).join('') + 'Z';

  const gridVals = [54, lo, hi, 250];
  const grid = gridVals.map((v) => `
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="viz-grid${v === lo || v === hi ? ' viz-grid-strong' : ''}"/>
    ${v === 54 && y(54) - y(lo) < 14 ? '' : `<text x="${W - pad.r + 6}" y="${y(v) + 4}" class="viz-axis">${toDisplay(v, unit)}</text>`}`).join('');
  const xTicks = (W < 520 ? [0, 360, 720, 1080, 1440] : [0, 180, 360, 540, 720, 900, 1080, 1260, 1440]).map((m) =>
    `<text x="${x(m)}" y="${H - 6}" text-anchor="middle" class="viz-axis">${fmtHour(m)}</text>`).join('');

  return `<svg viewBox="0 0 ${W} ${H}" class="viz agp" role="img" aria-label="Ambulatory glucose profile: median and percentile bands across a typical day" data-chart="agp">
    <rect x="${pad.l}" y="${y(hi)}" width="${cw}" height="${y(lo) - y(hi)}" class="viz-target"/>
    ${grid}
    <path d="${band('p95', 'p5')}" class="viz-band-outer"/>
    <path d="${band('p75', 'p25')}" class="viz-band-inner"/>
    <path d="${line('p50')}" class="viz-median"/>
    ${xTicks}
    <line class="viz-crosshair" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ch}" style="display:none"/>
    <circle class="viz-dot" r="5" style="display:none"/>
    <rect class="viz-hit" x="${pad.l}" y="${pad.t}" width="${cw}" height="${ch}" fill="transparent"
      data-pad-l="${pad.l}" data-cw="${cw}" data-w="${W}"/>
  </svg>`;
}

// Attach crosshair + tooltip to an AGP chart.
export function bindAgpHover(container, agp, unit, tooltip) {
  const svg = container.querySelector('svg[data-chart="agp"]');
  if (!svg) return;
  const hit = svg.querySelector('.viz-hit');
  const cross = svg.querySelector('.viz-crosshair');
  const dot = svg.querySelector('.viz-dot');
  const W = +hit.dataset.w, padL = +hit.dataset.padL, cw = +hit.dataset.cw;
  const H = svg.viewBox.baseVal.height, padT = 14, ch = H - 14 - 26;
  const y = (v) => padT + ch - (Math.min(350, Math.max(40, v)) - 40) / 310 * ch;
  const u = unit === 'mmol' ? 'mmol/L' : 'mg/dL';
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const px = ((ev.clientX - rect.left) / rect.width) * W;
    const idx = Math.max(0, Math.min(agp.length - 1, Math.round(((px - padL) / cw) * agp.length)));
    const s = agp[idx];
    const cx = padL + (s.minute / 1440) * cw;
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.display = '';
    dot.setAttribute('cx', cx); dot.setAttribute('cy', y(s.p50)); dot.style.display = '';
    tooltip.show(ev, `<strong>${fmtClock(s.minute)}</strong>
      <div class="tt-row"><span>Median</span><b>${toDisplay(s.p50, unit)} ${u}</b></div>
      <div class="tt-row"><span>Middle 50%</span><b>${toDisplay(s.p25, unit)}–${toDisplay(s.p75, unit)}</b></div>
      <div class="tt-row"><span>90% of days</span><b>${toDisplay(s.p5, unit)}–${toDisplay(s.p95, unit)}</b></div>`);
  };
  const leave = () => { cross.style.display = 'none'; dot.style.display = 'none'; tooltip.hide(); };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerleave', leave);
}

// One small sparkline per day, shaded target band, lows/highs colored.
export function dailyStrip(day, { lo = 70, hi = 180 } = {}) {
  const W = 160, H = 54, pad = 3;
  const start = new Date(day.readings[0].t); start.setHours(0, 0, 0, 0);
  const x = (t) => pad + ((t - +start) / 864e5) * (W - 2 * pad);
  const y = (v) => pad + (H - 2 * pad) * (1 - (Math.min(350, Math.max(40, v)) - 40) / 310);
  let d = '', prev = null;
  for (const r of day.readings) {
    const cmd = !prev || r.t - prev.t > 30 * 60000 ? 'M' : 'L';
    d += `${cmd}${x(r.t).toFixed(1)},${y(r.v).toFixed(1)}`;
    prev = r;
  }
  const lows = day.readings.filter((r) => r.v < lo).map((r) => `<circle cx="${x(r.t).toFixed(1)}" cy="${y(r.v).toFixed(1)}" r="1.6" class="viz-low-dot"/>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" class="viz strip" role="img" aria-label="Glucose trace">
    <rect x="0" y="${y(hi)}" width="${W}" height="${y(lo) - y(hi)}" class="viz-target"/>
    <path d="${d}" class="viz-trace"/>${lows}</svg>`;
}

// Line chart of saved TIR snapshots over time.
export function trendChart(entries, { target = 70, width = 720 } = {}) {
  const W = Math.max(320, Math.min(960, Math.round(width))), H = 220, pad = { t: 14, r: 16, b: 26, l: 36 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const n = entries.length;
  const x = (i) => pad.l + (n === 1 ? cw / 2 : (i / (n - 1)) * cw);
  const y = (v) => pad.t + ch - (v / 100) * ch;
  const grid = [0, 25, 50, 75, 100].map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(v)}" y2="${y(v)}" class="viz-grid"/><text x="${pad.l - 6}" y="${y(v) + 4}" text-anchor="end" class="viz-axis">${v}%</text>`).join('');
  const path = (k) => entries.map((e, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(e[k]).toFixed(1)}`).join('');
  const every = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(W / 90))));
  const labels = entries.map((e, i) => ((i % every === 0 && n - 1 - i >= every) || i === n - 1)
    ? `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" class="viz-axis">${esc(e.label)}</text>` : '').join('');
  const dots = entries.map((e, i) => `<circle cx="${x(i)}" cy="${y(e.tir)}" r="4.5" class="viz-point" data-i="${i}"><title>${esc(e.label)}: ${Math.round(e.tir)}% in range, ${e.tbr.toFixed(1)}% below</title></circle>`).join('');
  const last = entries[n - 1];
  return `<svg viewBox="0 0 ${W} ${H}" class="viz trend" role="img" aria-label="Time in range over time">
    ${grid}
    <line x1="${pad.l}" x2="${W - pad.r}" y1="${y(target)}" y2="${y(target)}" class="viz-goal"/>
    <text x="${pad.l + 6}" y="${y(target) - 6}" class="viz-axis">Goal ${target}%</text>
    <path d="${path('tbr')}" class="viz-line-low"/>
    <path d="${path('tir')}" class="viz-line-tir"/>
    ${dots}
    <text x="${x(n - 1) - 8}" y="${y(last.tir) - 10}" text-anchor="end" class="viz-label">${Math.round(last.tir)}%</text>
    ${labels}
  </svg>`;
}

// GRI gauge: 0–100 bar split into five zones with a marker.
export function griGauge(gri) {
  const zones = ['A', 'B', 'C', 'D', 'E'];
  const segs = zones.map((z, i) => `<div class="gri-seg gri-${z.toLowerCase()}${gri.zone === z ? ' is-active' : ''}"><span>${z}</span></div>`).join('');
  return `<div class="gri-gauge" role="img" aria-label="Glycemia Risk Index ${Math.round(gri.gri)}, zone ${gri.zone}">
    <div class="gri-track">${segs}</div>
    <div class="gri-marker" style="left:${Math.min(100, gri.gri)}%"></div>
  </div>`;
}
