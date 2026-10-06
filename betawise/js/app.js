// app.js — Betawise app controller.
import {
  computeMetrics, detectPatterns, opportunities, projectedBenefit, aiSummary,
  TARGET_PROFILES, toDisplay, lastNDays,
} from './metrics.js';
import { PERSONAS, generateTrace } from './demo.js';
import { parseCgmCsv, parseTimestamp } from './parse.js';
import { agpChart, bindAgpHover, dailyStrip, trendChart, griGauge } from './charts.js';

// ---------------------------------------------------------------------------
// Utilities

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name, cls = 'icon') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const pct = (x, d = 0) => `${(Math.round(x * 10 ** d) / 10 ** d).toFixed(d)}%`;
const DAY = 864e5;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`bw:${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`bw:${key}`, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  },
  clear() {
    try { Object.keys(localStorage).filter((k) => k.startsWith('bw:')).forEach((k) => localStorage.removeItem(k)); } catch { /* ignore */ }
  },
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

const tooltip = {
  el: null,
  show(ev, html) {
    this.el ??= $('#tooltip');
    this.el.innerHTML = html;
    this.el.hidden = false;
    const w = this.el.offsetWidth, h = this.el.offsetHeight;
    const x = Math.min(window.innerWidth - w - 8, ev.clientX + 14);
    const y = Math.max(8, ev.clientY - h - 12);
    this.el.style.left = `${x}px`;
    this.el.style.top = `${y}px`;
  },
  hide() { if (this.el) this.el.hidden = true; },
};

// ---------------------------------------------------------------------------
// State

const state = {
  readings: null,
  source: store.get('source', null),
  persona: store.get('persona', null),
  unit: store.get('unit', 'mgdl'),
  profile: store.get('profile', 'standard'),
  theme: store.get('theme', null),
  context: store.get('context', {}),
  snapshots: store.get('snapshots', []),
  commitments: store.get('commitments', []),
  insight: store.get('insight', null),
  chat: [],
  metrics: null,
  patterns: [],
  view: 'overview',
};

function loadSavedReadings() {
  const saved = store.get('readings', null);
  if (state.persona && PERSONAS[state.persona]) {
    state.readings = generateTrace(state.persona);
  } else if (Array.isArray(saved) && saved.length) {
    state.readings = saved.map(([t, v]) => ({ t, v }));
  }
}

function recompute() {
  if (!state.readings) { state.metrics = null; state.patterns = []; return; }
  state.metrics = computeMetrics(lastNDays(state.readings, 14), state.profile);
  state.patterns = detectPatterns(state.metrics);
}

function contextForAI() {
  const base = state.persona ? PERSONAS[state.persona].context : {};
  return { ...base, ...Object.fromEntries(Object.entries(state.context).filter(([, v]) => v !== '' && v != null)) };
}

function setData(readings, { source, persona = null }) {
  state.readings = readings;
  state.source = source;
  state.persona = persona;
  state.insight = null;
  state.chat = [];
  store.set('source', source);
  store.set('persona', persona);
  store.set('insight', null);
  if (persona) {
    store.set('readings', null);
  } else {
    // Compact storage: [t, v] pairs, last 90 days.
    const end = readings[readings.length - 1]?.t ?? 0;
    store.set('readings', readings.filter((r) => r.t > end - 90 * DAY).map((r) => [r.t, r.v]));
  }
  recompute();
  if (state.metrics) recordSnapshot();
  go(location.hash.slice(1) && location.hash.slice(1) !== 'onboard' ? location.hash.slice(1) : 'overview');
}

function recordSnapshot() {
  const m = state.metrics;
  const key = state.persona ? `demo:${state.persona}` : 'me';
  const date = new Date(m.last).toISOString().slice(0, 10);
  state.snapshots = state.snapshots.filter((s) => !(s.key === key && s.date === date));
  state.snapshots.push({ key, date, tir: m.tir, tbr: m.tbr, tar: m.tar, gmi: m.gmi, cv: m.cv, gri: m.gri.gri });
  state.snapshots.sort((a, b) => a.date.localeCompare(b.date));
  store.set('snapshots', state.snapshots.filter((s) => !s.key.startsWith('demo:')));
}

// Demo history: weekly snapshots showing a member's trajectory since joining.
function demoHistory(personaId, m) {
  const out = [];
  for (let k = 7; k >= 1; k--) {
    const lift = k * 2.1;
    const tir = Math.max(5, m.tir - lift);
    const tbr = Math.min(30, m.tbr + k * 0.45);
    out.push({
      key: `demo:${personaId}`,
      date: new Date(m.last - k * 7 * DAY).toISOString().slice(0, 10),
      tir, tbr, tar: Math.max(0, 100 - tir - tbr), gmi: m.gmi + 0.8 * (lift / 10), cv: m.cv + k * 0.6,
      gri: Math.min(100, m.gri.gri + k * 2.4), sample: true,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Theme & units

function applyTheme() {
  if (state.theme) document.documentElement.dataset.theme = state.theme;
  else delete document.documentElement.dataset.theme;
  const dark = state.theme ? state.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  $('#theme-toggle use').setAttribute('href', dark ? '#i-sun' : '#i-moon');
}

function unitLabel() { return state.unit === 'mmol' ? 'mmol/L' : 'mg/dL'; }
function g(v) { return toDisplay(v, state.unit); }

// ---------------------------------------------------------------------------
// Navigation

const TITLES = { overview: 'Overview', patterns: 'Patterns', coach: 'Coach', report: 'Clinic report', progress: 'Progress', settings: 'Settings', onboard: 'Get started' };
const NEEDS_DATA = new Set(['overview', 'patterns', 'coach', 'report', 'progress']);

function go(view) {
  if (!TITLES[view]) view = 'overview';
  if (NEEDS_DATA.has(view) && !state.metrics) view = 'onboard';
  state.view = view;
  if (location.hash.slice(1) !== view) history.replaceState(null, '', `#${view}`);
  $$('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== view; });
  $$('[data-nav]').forEach((b) => {
    if (b.dataset.nav === view) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $('#view-title').textContent = TITLES[view];
  document.title = `${TITLES[view]} · Betawise`;
  renderSourcePill();
  const renderers = { overview: renderOverview, patterns: renderPatterns, coach: renderCoach, report: renderReport, progress: renderProgress, settings: renderSettings, onboard: renderOnboard };
  renderers[view]?.();
  window.scrollTo({ top: 0 });
}

function renderSourcePill() {
  const pill = $('#source-pill');
  pill.hidden = !state.metrics;
  if (!state.metrics) return;
  const days = Math.round(state.metrics.spanDays);
  $('#source-label').textContent = `${state.source} · ${days} days`;
}

// ---------------------------------------------------------------------------
// Onboarding

function renderOnboard() {
  $('#persona-grid').innerHTML = Object.values(PERSONAS).map((p) => `
    <button class="persona" type="button" data-persona="${p.id}">
      <span class="p-name">${esc(p.name)}</span>
      <span class="p-meta">${esc(p.blurb)}</span>
      <span class="small ink-2">${esc(p.story)}</span>
    </button>`).join('');
}

async function handleFile(file) {
  const status = $('#upload-status');
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) { status.textContent = 'That file is too large (25 MB max).'; return; }
  status.textContent = `Reading ${file.name}…`;
  try {
    const text = await file.text();
    const { readings, source, unit } = parseCgmCsv(text);
    if (readings.length < 100) throw new Error('Fewer than 100 glucose readings were found. Is this a CGM export?');
    if (unit === 'mmol') { state.unit = 'mmol'; store.set('unit', 'mmol'); syncUnitButtons(); }
    setData(readings, { source });
    toast(`Loaded ${readings.length.toLocaleString()} readings from ${source}`);
  } catch (err) {
    status.textContent = err.message;
  }
}

async function connectDexcom() {
  const status = $('#dexcom-status');
  status.textContent = 'Checking…';
  try {
    const res = await fetch('/api/dexcom/status');
    const s = await res.json();
    if (!s.configured) {
      status.textContent = 'Dexcom connection is not enabled on this deployment yet. Upload a Clarity CSV instead.';
      return;
    }
    location.href = '/api/dexcom/login';
  } catch {
    status.textContent = 'Could not reach the server. Upload a Clarity CSV instead.';
  }
}

async function loadDexcom() {
  toast('Pulling your last 14 days from Dexcom…');
  try {
    const res = await fetch('/api/dexcom/egvs');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Dexcom error');
    const readings = data.readings.map((r) => ({ t: parseTimestamp(r.t), v: r.v })).filter((r) => r.t);
    setData(readings, { source: 'Dexcom' });
    store.set('dexcom', true);
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------------------
// Shared fragments

const SEV = {
  urgent: { label: 'Safety first', badge: 'badge-bad', icon: 'alert' },
  high: { label: 'High priority', badge: 'badge-bad', icon: 'alert' },
  moderate: { label: 'Worth working on', badge: 'badge-warn', icon: 'info' },
  low: { label: 'Good to know', badge: 'badge-info', icon: 'info' },
  positive: { label: 'Working well', badge: 'badge-ok', icon: 'star' },
};

function patternHTML(p) {
  const s = SEV[p.severity];
  return `<article class="pattern sev-${p.severity}">
    <div class="p-icon">${icon(s.icon)}</div>
    <div>
      <span class="badge ${s.badge}">${icon(s.icon)}${s.label}</span>
      <h3>${esc(p.title)}</h3>
      <p>${esc(p.detail)}</p>
      <details class="why"><summary>Why it matters</summary><p>${esc(p.why)}</p></details>
    </div>
  </article>`;
}

function bandsHTML(m) {
  const t = m.profile.targets;
  const loLbl = `<${g(m.profile.lo)}`;
  const bands = [
    { k: 'vhigh', label: `Very high (>${g(250)})`, v: m.vhigh, goal: t.vhigh != null ? `<${t.vhigh}%` : '' },
    { k: 'high', label: `High (${g(m.profile.hi + 1)}–${g(250)})`, v: m.high, goal: t.tar != null ? `<${t.tar}% total` : '' },
    { k: 'tir', label: `In range (${g(m.profile.lo)}–${g(m.profile.hi)})`, v: m.tir, goal: `>${t.tir}%` },
    { k: 'low', label: `Low (${g(54)}–${g(m.profile.lo - 1)})`, v: m.low, goal: `<${t.tbr}% total` },
    { k: 'vlow', label: `Very low (<${g(54)})`, v: m.vlow, goal: `<${t.vlow}%` },
  ];
  const stack = [...bands].reverse().map((b) => `<div class="bg-${b.k}" style="flex:${Math.max(b.v, 0.4)}" title="${esc(b.label)}: ${pct(b.v, 1)}"></div>`).join('');
  return `<div class="tir-stack" role="img" aria-label="Time in ranges: ${bands.map((b) => `${b.label} ${pct(b.v, 1)}`).join(', ')}">${stack}</div>
    <div class="tir-rows">${bands.map((b) => `<div class="tir-row"><i class="bg-${b.k}"></i><span>${esc(b.label)}</span><span class="val">${pct(b.v, 1)}</span><span class="goal">${esc(b.goal)}</span></div>`).join('')}</div>
    <p class="xs muted" style="margin-top:8px">Units ${unitLabel()} · ${esc(loLbl)} counts as below range · targets: ${esc(m.profile.label)}</p>`;
}

function checklistHTML(m) {
  return `<div class="checklist">${m.checks.map((c) => `
    <div class="check ${c.met ? 'met' : 'miss'}">${icon(c.met ? 'check' : 'x')}
      <span>${esc(c.label)}</span><span class="v">${pct(c.value, 1)}</span>
      <span class="t">${c.dir === 'above' ? '>' : c.key === 'cv' ? '≤' : '<'}${c.target}%</span></div>`).join('')}</div>`;
}

function topFocus() {
  return state.patterns.find((p) => p.severity !== 'positive') || null;
}

// ---------------------------------------------------------------------------
// Overview

function renderOverview() {
  const m = state.metrics;
  const focus = topFocus();
  const opp = opportunities(m)[0];
  const benefit = projectedBenefit(opp?.gain || 0);
  const committed = state.commitments.find((c) => c.patternId === focus?.id && Date.now() - c.at < 7 * DAY);
  const strength = state.patterns.find((p) => p.severity === 'positive');
  const el = $('[data-view="overview"]');

  el.innerHTML = `
    ${!m.sufficient ? `<div class="privacy-note" style="background:var(--warn-soft)">${icon('alert')}<span><strong>Limited data.</strong> Consensus guidelines recommend at least 10–14 days with 70%+ sensor wear. You have ${m.spanDays.toFixed(1)} days at ${Math.round(m.activePercent)}% — treat these numbers as early signals.</span></div>` : ''}
    ${state.persona ? `<div class="privacy-note">${icon('info')}<span class="note-row"><span>Sample member <strong>${esc(PERSONAS[state.persona].name)}</strong> · simulated data</span><button class="btn btn-secondary btn-sm" data-action="new-data" type="button">Use my data</button></span></div>` : ''}

    <div class="grid" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)" data-responsive>
      <div class="card focus-card">
        <p class="eyebrow">Your focus this week</p>
        ${focus ? `
          <h2>${esc(focus.title)}</h2>
          <p>${esc(focus.detail)}</p>` : `
          <h2>You're hitting your targets.</h2>
          <p>Nothing is flagged. Stretch goal: raise time in tight range (70–140) above ${pct(m.titr)}.</p>`}
        <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:18px">
          <button class="btn btn-secondary" data-action="ask-focus" type="button">${icon('chat')}Plan it with the coach</button>
          ${focus ? `<button class="btn btn-secondary" data-action="commit" type="button" ${committed ? 'disabled' : ''}>${icon('check')}${committed ? 'Committed this week' : 'Commit'}</button>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div><div class="card-title">Glycemia Risk Index</div><div class="card-sub">Overall risk from lows and highs · lower is better</div></div></div>
        <div style="display:flex;align-items:baseline;gap:12px"><span class="big-number">${Math.round(m.gri.gri)}</span><span class="badge badge-brand">Zone ${m.gri.zone} · ${esc(m.gri.zoneLabel)}</span></div>
        ${griGauge(m.gri)}
        <p class="xs muted" style="margin-top:12px">From lows ${Math.round(3 * m.gri.hypoComponent)} · from highs ${Math.round(1.6 * m.gri.hyperComponent)}</p>
      </div>
    </div>

    <div class="grid grid-4">
      ${kpi('Time in range', pct(m.tir), '', m.tir >= m.profile.targets.tir ? ['ok', 'On target'] : ['warn', `Goal >${m.profile.targets.tir}%`])}
      ${kpi('GMI (est. A1C)', m.gmi.toFixed(1), '%', m.gmi < 7 ? ['ok', 'Under 7%'] : ['warn', 'Goal <7% for most'])}
      ${kpi('Average glucose', g(m.mean), unitLabel(), null, `SD ${g(m.sd)}`)}
      ${kpi('Lows per week', (m.hypoEvents.length / Math.max(1, m.spanDays / 7)).toFixed(1), '', m.hypoEvents.length ? ['warn', `${m.severeHypoEvents.length} below ${g(54)}`] : ['ok', 'None detected'])}
    </div>

    <div class="grid" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr)" data-responsive>
      <div class="card">
        <div class="card-head"><div><div class="card-title">Your typical day</div><div class="card-sub">${Math.round(m.spanDays)} days layered into one 24 hours (AGP)</div></div></div>
        <div id="agp-wrap"></div>
        <div class="legend"><span><i style="background:var(--brand-strong);height:3px"></i>Median</span><span><i style="background:var(--brand);opacity:.45"></i>Middle 50% of days</span><span><i style="background:var(--brand);opacity:.18"></i>90% of days</span><span><i style="background:var(--g-tir);opacity:.25"></i>Target range</span></div>
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">Time in ranges</div><div class="card-sub">International Consensus categories</div></div></div>
        ${bandsHTML(m)}
      </div>
    </div>

    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><div class="card-title">Where your biggest gains are</div><div class="card-sub">If each part of the day matched your best (${esc((strength?.title?.split(' is ')[0] || 'best period').toLowerCase())})</div></div></div>
        ${opportunities(m).map((o) => `<div class="opportunity"><span class="opp-label"><strong>${esc(o.label)}</strong><span class="muted xs">${pct(o.tir)} in range now</span></span><span class="tabular opp-gain"><strong>+${o.gain.toFixed(1)}</strong><span class="muted xs">pts</span></span><div class="opp-bar"><div style="width:${Math.min(100, (o.gain / Math.max(1, opp.gain)) * 100)}%"></div></div></div>`).join('')}
        ${opp && opp.gain >= 1 ? `<p class="small ink-2" style="margin-top:14px">Fixing ${esc(opp.label.toLowerCase())}s alone ≈ <strong>+${opp.gain.toFixed(1)} pts</strong> time in range and <strong>−${benefit.gmiDrop.toFixed(1)}%</strong> GMI.</p>` : ''}
      </div>
      <div class="card">
        <div class="card-head"><div><div class="card-title">Consensus targets</div><div class="card-sub">${m.targetsMet} of ${m.checks.length} met · ${esc(m.profile.label)}</div></div><button class="btn btn-ghost btn-sm" data-nav-to="settings" type="button">Change</button></div>
        ${checklistHTML(m)}
      </div>
    </div>`;
  drawAgp($('#agp-wrap'), 260);
}

// Render the AGP at the container's pixel width so text stays legible at every size.
function drawAgp(wrap, height) {
  const m = state.metrics;
  wrap.innerHTML = agpChart(m.agp, { lo: m.profile.lo, hi: m.profile.hi, unit: state.unit, height, width: wrap.clientWidth || 720 });
  bindAgpHover(wrap, m.agp, state.unit, tooltip);
}

function kpi(label, value, unit, status, foot) {
  const b = status ? `<span class="badge badge-${status[0]}">${icon(status[0] === 'ok' ? 'check' : 'info')}${esc(status[1])}</span>` : `<span class="muted">${esc(foot || '')}</span>`;
  return `<div class="card kpi"><div class="k-label">${esc(label)}</div><div class="k-value">${esc(value)}<small>${esc(unit)}</small></div><div class="k-foot">${b}</div></div>`;
}

// ---------------------------------------------------------------------------
// Patterns

function renderPatterns() {
  const m = state.metrics;
  const el = $('[data-view="patterns"]');
  const periods = Object.values(m.periods);
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><div><div class="card-title">What Betawise found</div><div class="card-sub">Detected automatically from ${m.n.toLocaleString()} readings, ranked safety-first</div></div></div>
      ${state.patterns.length ? state.patterns.map(patternHTML).join('') : '<p class="muted">No notable patterns. Nice work.</p>'}
    </div>
    <div class="grid grid-4">
      ${periods.map((p) => `<div class="card period-card">
        <div class="period-head"><strong>${esc(p.label)}</strong><span class="muted xs">${esc(p.hours)}</span></div>
        <div class="p-big">${pct(p.tir)}</div>
        <div class="mini-stack" role="img" aria-label="${esc(p.label)}: ${pct(p.tbr, 1)} below, ${pct(p.tir)} in range, ${pct(p.tar)} above">
          <div class="bg-low" style="flex:${Math.max(p.tbr, 0.3)}"></div><div class="bg-tir" style="flex:${Math.max(p.tir, 0.3)}"></div><div class="bg-high" style="flex:${Math.max(p.tar, 0.3)}"></div>
        </div>
        <div class="period-stats xs tabular"><span>Low <b>${pct(p.tbr, 1)}</b></span><span>High <b>${pct(p.tar)}</b></span><span>Avg <b>${g(p.mean)}</b></span></div>
      </div>`).join('')}
    </div>
    <div class="card">
      <div class="card-head"><div><div class="card-title">Day by day</div><div class="card-sub">Shaded band is your target range · red dots are lows</div></div></div>
      <div class="strips" id="day-strips">${fullDays(m).slice(-7).map(dayCell).join('')}</div>
      ${fullDays(m).length > 7 ? `<button class="btn btn-ghost btn-sm" data-action="all-days" type="button" style="margin-top:10px">Show all ${fullDays(m).length} days</button>` : ''}
    </div>`;
}

// Days with under half a day of sensor data (e.g. today so far) would show misleading percentages.
function fullDays(m) {
  return m.days.filter((d) => d.n * m.interval >= 12 * 60);
}

function dayCell(d) {
  const date = new Date(`${d.date}T12:00:00`);
  const label = date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
  return `<div class="strip-cell"><div class="d"><span>${esc(label)}</span><span class="tabular">${pct(d.tir)}</span></div>${dailyStrip(d, { lo: state.metrics.profile.lo, hi: state.metrics.profile.hi })}</div>`;
}

// ---------------------------------------------------------------------------
// Coach

const SUGGESTIONS = [
  'What should I focus on first?',
  'Why do I keep going low overnight?',
  'How do I flatten my breakfast spike?',
  "I'm burnt out. How do people keep going?",
  'Help me prep for my endo appointment',
];

function renderCoach() {
  renderInsight();
  renderChat();
  const sug = $('#suggestions');
  sug.innerHTML = state.chat.length ? '' : SUGGESTIONS.map((s) => `<button type="button" data-suggest="${esc(s)}">${esc(s)}</button>`).join('');
}

function renderInsight() {
  const body = $('#insight-body');
  const ins = state.insight;
  if (!ins) return;
  if (ins.loading) {
    body.innerHTML = '<div class="skeleton" style="width:90%"></div><div class="skeleton" style="width:75%;margin-top:10px"></div><div class="skeleton" style="width:82%;margin-top:10px"></div><p class="xs muted" style="margin-top:12px">Reading your patterns…</p>';
    return;
  }
  if (ins.error) { body.innerHTML = `<p class="badge badge-bad">${icon('alert')}${esc(ins.error)}</p>`; return; }
  body.innerHTML = `
    <p>${esc(ins.summary)}</p>
    <h3>This week's focus</h3>
    <p><strong>${esc(ins.focus?.title)}</strong> — ${esc(ins.focus?.why)}</p>
    <ul style="margin-top:8px">${(ins.focus?.experiments || []).map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
    ${ins.wins?.length ? `<h3>What's working</h3><ul>${ins.wins.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
    <h3>Ask your care team</h3>
    <ol>${(ins.doctorQuestions || []).map((q) => `<li>${esc(q)}</li>`).join('')}</ol>
    <p class="xs muted" style="margin-top:14px">AI-generated from summary statistics only. Not medical advice.</p>`;
}

async function generateInsight() {
  const btn = $('#insight-btn');
  btn.disabled = true;
  state.insight = { loading: true };
  renderInsight();
  try {
    const res = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'insights', summary: aiSummary(state.metrics, state.patterns, contextForAI()) }),
    });
    const data = await res.json().catch(() => ({ error: { message: 'The coach is unavailable right now.' } }));
    if (!res.ok || data.error) throw new Error(data.error?.message || 'The coach is unavailable right now.');
    state.insight = data;
    store.set('insight', data);
  } catch (err) {
    state.insight = { error: err.message };
  }
  btn.disabled = false;
  btn.lastChild.textContent = 'Regenerate';
  renderInsight();
}

function renderChat() {
  const log = $('#chat-log');
  const greeting = state.persona
    ? `Hey ${PERSONAS[state.persona].name}! I've looked over your last two weeks. What's on your mind?`
    : "Hi! I've looked over your last two weeks of data. I've lived this too — the highs, the lows, the days nothing makes sense. What's on your mind?";
  const msgs = [{ role: 'assistant', content: greeting }, ...state.chat];
  log.innerHTML = '';
  for (const msg of msgs) log.appendChild(bubble(msg.role, msg.content, msg.safety));
  log.scrollTop = log.scrollHeight;
}

function bubble(role, text, safety) {
  const div = document.createElement('div');
  div.className = `msg ${role === 'user' ? 'msg-user' : 'msg-ai'}${safety ? ' safety' : ''}`;
  div.textContent = text;
  return div;
}

async function sendChat(text) {
  text = text.trim();
  if (!text || sendChat.busy) return;
  sendChat.busy = true;
  $('#suggestions').innerHTML = '';
  const input = $('#chat-input');
  input.value = '';
  state.chat.push({ role: 'user', content: text });
  const log = $('#chat-log');
  log.appendChild(bubble('user', text));
  const reply = bubble('assistant', '');
  reply.innerHTML = '<span class="typing"><i></i><i></i><i></i></span>';
  log.appendChild(reply);
  log.scrollTop = log.scrollHeight;
  $('#chat-send').disabled = true;

  let full = '';
  try {
    const res = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'chat', summary: aiSummary(state.metrics, state.patterns, contextForAI()), messages: state.chat }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error?.message || 'The coach is unavailable right now.');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      full += decoder.decode(value, { stream: true });
      reply.textContent = full;
      log.scrollTop = log.scrollHeight;
    }
    const safety = /call 911|988/.test(full) && full.length < 700;
    if (safety) reply.classList.add('safety');
    state.chat.push({ role: 'assistant', content: full, safety });
  } catch (err) {
    reply.textContent = `${err.message} You can still explore your patterns and report while offline.`;
    state.chat.pop();
  }
  $('#chat-send').disabled = false;
  sendChat.busy = false;
}

// ---------------------------------------------------------------------------
// Clinic report

function renderReport() {
  const m = state.metrics;
  const el = $('[data-view="report"]');
  const fmtD = (t) => new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const flagged = state.patterns.filter((p) => p.severity !== 'positive');
  const questions = state.insight?.doctorQuestions || flagged.slice(0, 3).map((p) => `What changes could address: ${p.title.toLowerCase()}?`);
  const t = m.profile.targets;
  const rows = [
    ['Time in range', `${g(m.profile.lo)}–${g(m.profile.hi)} ${unitLabel()}`, pct(m.tir, 1), `>${t.tir}%`],
    ['Time in tight range', `${g(70)}–${g(140)} ${unitLabel()}`, pct(m.titr, 1), '—'],
    ['Time below range', `<${g(m.profile.lo)}`, pct(m.tbr, 1), `<${t.tbr}%`],
    ['  Very low', `<${g(54)}`, pct(m.vlow, 1), `<${t.vlow}%`],
    ['Time above range', `>${g(m.profile.hi)}`, pct(m.tar, 1), `<${t.tar}%`],
    ['  Very high', `>${g(250)}`, pct(m.vhigh, 1), t.vhigh != null ? `<${t.vhigh}%` : '—'],
    ['Mean glucose', '', `${g(m.mean)} ${unitLabel()}`, '—'],
    ['GMI', '', `${m.gmi.toFixed(1)}%`, '—'],
    ['Coefficient of variation', '', pct(m.cv, 1), `≤${t.cv}%`],
    ['Glycemia Risk Index', '', `${Math.round(m.gri.gri)} (zone ${m.gri.zone})`, 'lower is better'],
    ['Hypoglycemia episodes ≥15 min', '', `${m.hypoEvents.length} (${m.severeHypoEvents.length} <${g(54)})`, '—'],
  ];
  el.innerHTML = `
    <div class="no-print" style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-primary" data-action="print" type="button">${icon('print')}Print or save as PDF</button>
      <p class="small muted">A one-page summary in the format clinicians already use. Bring it to your next appointment.</p>
    </div>
    <div class="card report">
      <div class="report-head">
        <div><h2>CGM Summary Report</h2><div class="small">${fmtD(m.first)} – ${fmtD(m.last)} · ${m.spanDays.toFixed(0)} days · sensor active ${Math.round(m.activePercent)}%</div></div>
        <div class="small" style="text-align:right"><strong>Betawise</strong><br>Targets: ${esc(m.profile.label)}<br>Generated ${fmtD(Date.now())}</div>
      </div>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px" data-responsive>
        <div>
          <h3>Glucose statistics</h3>
          <div class="table-wrap"><table class="table"><thead><tr><th>Metric</th><th>Range</th><th class="num">Result</th><th class="num">Goal</th></tr></thead>
          <tbody>${rows.map((r) => `<tr><td>${esc(r[0])}</td><td class="small">${esc(r[1])}</td><td class="num"><strong>${esc(r[2])}</strong></td><td class="num small">${esc(r[3])}</td></tr>`).join('')}</tbody></table></div>
        </div>
        <div>
          <h3>Time in ranges</h3>
          ${bandsHTML(m)}
          <h3>Patterns detected</h3>
          ${flagged.length ? `<ul style="margin:0;padding-left:18px">${flagged.map((p) => `<li><strong>${esc(p.title)}.</strong> ${esc(p.detail)}</li>`).join('')}</ul>` : '<p>None flagged.</p>'}
        </div>
      </div>
      <h3>Ambulatory glucose profile</h3>
      <div id="report-agp"></div>
      <h3>Daily glucose profiles</h3>
      <div class="strips">${fullDays(m).map(dayCell).join('')}</div>
      <h3>Patient's questions</h3>
      <ol style="margin:0;padding-left:18px">${questions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>
      <p class="xs muted" style="margin-top:16px">Metrics follow the International Consensus on Time in Range (Battelino et al., Diabetes Care 2019) and the Glycemia Risk Index (Klonoff et al., JDST 2023). Patterns are generated algorithmically for discussion and are not a diagnosis. Betawise is not a medical device.</p>
    </div>`;
  drawAgp($('#report-agp'), 220);
}

// ---------------------------------------------------------------------------
// Progress

function renderProgress() {
  const m = state.metrics;
  const key = state.persona ? `demo:${state.persona}` : 'me';
  let snaps = state.snapshots.filter((s) => s.key === key);
  if (state.persona) snaps = [...demoHistory(state.persona, m), ...snaps];
  const entries = snaps.map((s) => ({ ...s, label: new Date(`${s.date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }));
  const first = entries[0], last = entries[entries.length - 1];
  const delta = entries.length > 1 ? last.tir - first.tir : 0;
  const commits = state.commitments.filter((c) => c.key === key).slice(-6).reverse();
  const el = $('[data-view="progress"]');
  el.innerHTML = `
    ${state.persona ? `<div class="privacy-note">${icon('info')}<span>Sample history for ${esc(PERSONAS[state.persona].name)}, showing what eight weeks of progress tracking looks like.</span></div>` : ''}
    <div class="grid grid-3">
      ${kpi('Time in range now', pct(last.tir), '', null, `${entries.length} snapshot${entries.length === 1 ? '' : 's'}`)}
      ${kpi('Change since first snapshot', `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`, 'pts', entries.length > 1 ? (delta >= 0 ? ['ok', 'Improving'] : ['warn', 'Slipping — that happens']) : null, 'Add more data over time')}
      ${kpi('GRI now', Math.round(last.gri), '', null, entries.length > 1 ? `was ${Math.round(first.gri)}` : '')}
    </div>
    <div class="card">
      <div class="card-head"><div><div class="card-title">Time in range over time</div><div class="card-sub">A snapshot is saved each time you load new data. Lows shown in red.</div></div></div>
      ${entries.length > 1 ? trendChart(entries, { target: m.profile.targets.tir }) + `<div class="legend"><span><i class="bg-tir"></i>Time in range</span><span><i class="bg-vlow"></i>Time below range</span><span><i style="border-top:2px dashed var(--muted);height:0;border-radius:0"></i>Goal</span></div>` : '<p class="muted small">Load fresh data next week to start your trend line.</p>'}
    </div>
    <div class="card">
      <div class="card-head"><div><div class="card-title">Weekly commitments</div><div class="card-sub">Small, specific focuses beat big resolutions.</div></div></div>
      ${commits.length ? commits.map((c) => `<div class="opportunity"><span>${icon('check')} <strong>${esc(c.title)}</strong></span><span class="muted small">${new Date(c.at).toLocaleDateString()}</span></div>`).join('') : '<p class="muted small">Commit to your weekly focus from the Overview to start a streak.</p>'}
    </div>`;
}

// ---------------------------------------------------------------------------
// Settings

function renderSettings() {
  const c = state.context;
  const el = $('[data-view="settings"]');
  el.innerHTML = `
    <div class="grid grid-2">
      <div class="card">
        <div class="card-head"><div><div class="card-title">Targets</div><div class="card-sub">Based on the International Consensus on Time in Range</div></div></div>
        <div class="field"><label for="set-profile">Target profile</label>
          <select id="set-profile" class="input">${Object.values(TARGET_PROFILES).map((p) => `<option value="${p.id}" ${p.id === state.profile ? 'selected' : ''}>${esc(p.label)} (${p.lo}–${p.hi} mg/dL, TIR >${p.targets.tir}%)</option>`).join('')}</select>
        </div>
        <p class="xs muted" style="margin-top:8px">Ask your care team which targets fit you. Older adults and people at high risk of lows often use less strict goals.</p>
      </div>
      <form class="card" id="context-form">
        <div class="card-head"><div><div class="card-title">About you</div><div class="card-sub">Optional. Helps the coach personalize advice. Stored on this device.</div></div></div>
        <div class="grid grid-2" style="gap:12px">
          <div class="field"><label for="ctx-type">Diabetes type</label><select id="ctx-type" name="diabetesType" class="input">${['', 'Type 1', 'Type 2', 'LADA', 'Gestational', 'Prediabetes', 'Other'].map((o) => `<option ${c.diabetesType === o ? 'selected' : ''} value="${o}">${o || 'Prefer not to say'}</option>`).join('')}</select></div>
          <div class="field"><label for="ctx-therapy">Therapy</label><select id="ctx-therapy" name="therapy" class="input">${['', 'Automated insulin delivery', 'Insulin pump', 'Multiple daily injections', 'Basal insulin only', 'Oral medication', 'GLP-1 medication', 'Lifestyle only'].map((o) => `<option ${c.therapy === o ? 'selected' : ''} value="${o}">${o || 'Prefer not to say'}</option>`).join('')}</select></div>
        </div>
        <div class="field" style="margin-top:12px"><label for="ctx-goal">Your goal in your own words</label><input id="ctx-goal" name="goal" class="input" maxlength="200" value="${esc(c.goal || '')}" placeholder="e.g. Sleep through the night without lows"></div>
        <div class="field" style="margin-top:12px"><label for="ctx-notes">Anything else?</label><textarea id="ctx-notes" name="notes" class="input" rows="2" maxlength="400" placeholder="e.g. Training for a half marathon; night shifts on weekends">${esc(c.notes || '')}</textarea></div>
        <div style="margin-top:12px"><button class="btn btn-primary btn-sm" type="submit">Save</button></div>
      </form>
    </div>
    <div class="card">
      <div class="card-head"><div><div class="card-title">Your data</div><div class="card-sub">Everything is stored in this browser only.</div></div></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn btn-secondary btn-sm" data-action="new-data" type="button">${icon('upload')}Load different data</button>
        ${state.metrics ? `<button class="btn btn-secondary btn-sm" data-action="export" type="button">Export my data (JSON)</button>` : ''}
        ${store.get('dexcom', false) ? `<button class="btn btn-secondary btn-sm" data-action="dexcom-refresh" type="button">Refresh from Dexcom</button><button class="btn btn-ghost btn-sm" data-action="dexcom-logout" type="button">Disconnect Dexcom</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-action="clear" type="button" style="color:var(--bad)">Delete all my data</button>
      </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// Events

function syncUnitButtons() {
  $$('[data-unit]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.unit === state.unit)));
}

function bindEvents() {
  document.addEventListener('click', async (ev) => {
    const nav = ev.target.closest('[data-nav], [data-nav-to]');
    if (nav) { go(nav.dataset.nav || nav.dataset.navTo); return; }

    const persona = ev.target.closest('[data-persona]');
    if (persona) {
      const id = persona.dataset.persona;
      setData(generateTrace(id), { source: `Sample: ${PERSONAS[id].name}`, persona: id });
      return;
    }

    const unit = ev.target.closest('[data-unit]');
    if (unit) {
      state.unit = unit.dataset.unit; store.set('unit', state.unit); syncUnitButtons(); go(state.view); return;
    }

    const sug = ev.target.closest('[data-suggest]');
    if (sug) { sendChat(sug.dataset.suggest); return; }

    const action = ev.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'new-data') go('onboard');
    if (action === 'all-days') {
      $('#day-strips').innerHTML = fullDays(state.metrics).map(dayCell).join('');
      ev.target.closest('button').remove();
    }
    if (action === 'print') window.print();
    if (action === 'ask-focus') {
      go('coach');
      const f = topFocus();
      sendChat(f ? `My focus this week is "${f.title}". Can you help me make a simple plan for it?` : "I'm hitting my targets. What would you work on next?");
    }
    if (action === 'commit') {
      const f = topFocus();
      state.commitments.push({ key: state.persona ? `demo:${state.persona}` : 'me', patternId: f.id, title: f.title, at: Date.now() });
      store.set('commitments', state.commitments);
      toast('Committed. We will check in on it in your progress tab.');
      renderOverview();
    }
    if (action === 'export') {
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), source: state.source, readings: state.readings, snapshots: state.snapshots, context: state.context }, null, 1)], { type: 'application/json' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'betawise-export.json' });
      a.click();
      URL.revokeObjectURL(a.href);
    }
    if (action === 'clear') {
      if (!confirm('Delete all Betawise data stored in this browser? This cannot be undone.')) return;
      if (store.get('dexcom', false)) await fetch('/api/dexcom/logout', { method: 'POST' }).catch(() => {});
      store.clear();
      location.hash = '';
      location.reload();
    }
    if (action === 'dexcom-refresh') loadDexcom();
    if (action === 'dexcom-logout') {
      await fetch('/api/dexcom/logout', { method: 'POST' }).catch(() => {});
      store.set('dexcom', false);
      toast('Disconnected from Dexcom');
      renderSettings();
    }
  });

  document.addEventListener('change', (ev) => {
    if (ev.target.id === 'set-profile') {
      state.profile = ev.target.value; store.set('profile', state.profile); recompute(); toast('Targets updated');
    }
    if (ev.target.id === 'file-input') handleFile(ev.target.files[0]);
  });

  document.addEventListener('submit', (ev) => {
    if (ev.target.id === 'context-form') {
      ev.preventDefault();
      state.context = Object.fromEntries(new FormData(ev.target));
      store.set('context', state.context);
      toast('Saved');
    }
    if (ev.target.id === 'chat-form') { ev.preventDefault(); sendChat($('#chat-input').value); }
  });

  $('#chat-input').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); sendChat(ev.target.value); }
  });
  $('#insight-btn').addEventListener('click', generateInsight);
  $('#dexcom-connect').addEventListener('click', connectDexcom);
  $('#source-pill').addEventListener('click', () => go('settings'));
  $('#theme-toggle').addEventListener('click', () => {
    const dark = state.theme ? state.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    state.theme = dark ? 'light' : 'dark';
    store.set('theme', state.theme);
    applyTheme();
  });

  const dz = $('#dropzone');
  dz.addEventListener('dragover', (ev) => { ev.preventDefault(); dz.classList.add('is-over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('is-over'));
  dz.addEventListener('drop', (ev) => { ev.preventDefault(); dz.classList.remove('is-over'); handleFile(ev.dataTransfer.files[0]); });

  window.addEventListener('hashchange', () => {
    const v = location.hash.slice(1);
    if (v && v !== state.view && TITLES[v]) go(v);
  });
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.view === 'overview' && $('#agp-wrap')) drawAgp($('#agp-wrap'), 260);
      if (state.view === 'report' && $('#report-agp')) drawAgp($('#report-agp'), 220);
    }, 150);
  });
  window.addEventListener('beforeprint', () => { if (state.metrics && state.view !== 'report') go('report'); });
}

// ---------------------------------------------------------------------------
// Boot

function boot() {
  applyTheme();
  syncUnitButtons();
  bindEvents();
  const hash = location.hash.slice(1);
  if (hash === 'dexcom=connected') { history.replaceState(null, '', '#overview'); loadDexcom(); }
  if (hash === 'dexcom=error') { history.replaceState(null, '', '#onboard'); toast('Dexcom connection failed. Please try again.'); }
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo && PERSONAS[demo]) {
    setData(generateTrace(demo), { source: `Sample: ${PERSONAS[demo].name}`, persona: demo });
    return;
  }
  loadSavedReadings();
  recompute();
  go(location.hash.slice(1) || 'overview');
}

boot();
