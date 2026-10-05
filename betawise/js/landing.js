// landing.js — renders a live product preview from the same engine the app uses.
import { computeMetrics, detectPatterns } from './metrics.js';
import { generateTrace } from './demo.js';
import { agpChart } from './charts.js';

const m = computeMetrics(generateTrace('sarah'));
const agp = document.getElementById('hero-agp');
if (m && agp) {
  const focus = detectPatterns(m).find((p) => p.severity !== 'positive');
  if (focus) {
    document.getElementById('hero-focus-title').textContent = focus.title;
    document.getElementById('hero-focus-detail').textContent = focus.detail;
  }
  agp.innerHTML = agpChart(m.agp, { height: 200, width: Math.max(360, agp.clientWidth) });
  const bands = [['vlow', m.vlow], ['low', m.low], ['tir', m.tir], ['high', m.high], ['vhigh', m.vhigh]];
  document.getElementById('hero-bands').innerHTML = `
    <div class="tir-stack" style="height:18px" role="img" aria-label="Time in range ${Math.round(m.tir)} percent">
      ${bands.map(([k, v]) => `<div class="bg-${k}" style="flex:${Math.max(v, 0.4)}"></div>`).join('')}
    </div>
    <div class="legend"><span><i class="bg-tir"></i>${Math.round(m.tir)}% in range</span><span><i class="bg-low"></i>${m.tbr.toFixed(1)}% low</span><span><i class="bg-high"></i>${Math.round(m.tar)}% high</span><span class="muted">GRI ${Math.round(m.gri.gri)} · zone ${m.gri.zone}</span></div>`;
}
