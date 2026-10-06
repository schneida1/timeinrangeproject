// metrics.js — Betawise glucose analytics engine.
// Pure functions, no DOM. Runs in the browser and in Node (tests).
//
// Clinical references:
//  - Battelino T, et al. Clinical Targets for CGM Data Interpretation:
//    Recommendations From the International Consensus on Time in Range.
//    Diabetes Care 2019;42:1593–1603.
//  - Klonoff DC, et al. A Glycemia Risk Index (GRI) of Hypoglycemia and
//    Hyperglycemia for CGM Data. J Diabetes Sci Technol 2023;17:1215–1225.
//  - Bergenstal RM, et al. Glucose Management Indicator (GMI).
//    Diabetes Care 2018;41:2275–2280.

export const MGDL_PER_MMOL = 18.0182;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// Target profiles from the International Consensus on Time in Range.
export const TARGET_PROFILES = {
  standard: {
    id: 'standard',
    label: 'Type 1 / Type 2 adults',
    lo: 70, hi: 180,
    targets: { tir: 70, tbr: 4, vlow: 1, tar: 25, vhigh: 5, cv: 36 },
  },
  older: {
    id: 'older',
    label: 'Older / high-risk adults',
    lo: 70, hi: 180,
    targets: { tir: 50, tbr: 1, vlow: 1, tar: 50, vhigh: 10, cv: 36 },
  },
  pregnancy: {
    id: 'pregnancy',
    label: 'Pregnancy (Type 1)',
    lo: 63, hi: 140,
    targets: { tir: 70, tbr: 4, vlow: 1, tar: 25, vhigh: null, cv: 36 },
  },
};

export const PERIODS = [
  { id: 'overnight', label: 'Overnight', hours: '12–6 AM', from: 0, to: 6 },
  { id: 'morning', label: 'Morning', hours: '6 AM–12 PM', from: 6, to: 12 },
  { id: 'afternoon', label: 'Afternoon', hours: '12–6 PM', from: 12, to: 18 },
  { id: 'evening', label: 'Evening', hours: '6 PM–12 AM', from: 18, to: 24 },
];

export const GRI_ZONES = [
  { zone: 'A', max: 20, label: 'Lowest risk' },
  { zone: 'B', max: 40, label: 'Low risk' },
  { zone: 'C', max: 60, label: 'Moderate risk' },
  { zone: 'D', max: 80, label: 'High risk' },
  { zone: 'E', max: 100, label: 'Highest risk' },
];

const round1 = (x) => Math.round(x * 10) / 10;

export function toDisplay(mgdl, unit) {
  return unit === 'mmol' ? round1(mgdl / MGDL_PER_MMOL) : Math.round(mgdl);
}

export function minuteOfDay(t) {
  const d = new Date(t);
  return d.getHours() * 60 + d.getMinutes();
}

function hourOf(t) {
  return new Date(t).getHours();
}

export function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Normalise raw readings: drop invalid values, sort, de-duplicate timestamps.
export function cleanReadings(readings) {
  const out = readings
    .map((r) => ({ t: +new Date(r.t ?? r.time), v: Number(r.v ?? r.value) }))
    .filter((r) => Number.isFinite(r.t) && Number.isFinite(r.v) && r.v >= 20 && r.v <= 600)
    .sort((a, b) => a.t - b.t);
  const dedup = [];
  for (const r of out) {
    if (dedup.length && r.t - dedup[dedup.length - 1].t < MIN) continue;
    dedup.push(r);
  }
  return dedup;
}

// Median sampling interval in minutes (5 for Dexcom, 15 for Libre historic).
export function samplingInterval(readings) {
  if (readings.length < 2) return 5;
  const diffs = [];
  for (let i = 1; i < readings.length; i++) {
    const d = (readings[i].t - readings[i - 1].t) / MIN;
    if (d > 0 && d <= 30) diffs.push(d);
  }
  if (!diffs.length) return 5;
  diffs.sort((a, b) => a - b);
  return Math.max(1, Math.round(percentile(diffs, 0.5)));
}

// Restrict to the most recent N days (consensus recommends 14).
export function lastNDays(readings, days = 14) {
  if (!readings.length) return readings;
  const end = readings[readings.length - 1].t;
  return readings.filter((r) => r.t > end - days * DAY);
}

function bandPercents(values, lo, hi) {
  const n = values.length || 1;
  let vlow = 0, low = 0, inr = 0, titr = 0, high = 0, vhigh = 0;
  for (const v of values) {
    if (v < 54) vlow++;
    else if (v < lo) low++;
    else if (v <= hi) inr++;
    else if (v <= 250) high++;
    else vhigh++;
    if (v >= 70 && v <= 140) titr++;
  }
  const pct = (x) => (x / n) * 100;
  return {
    vlow: pct(vlow), low: pct(low), tir: pct(inr), high: pct(high), vhigh: pct(vhigh),
    tbr: pct(vlow + low), tar: pct(high + vhigh), titr: pct(titr),
  };
}

// Glycemia Risk Index. Uses fixed consensus bands regardless of profile.
export function glycemiaRiskIndex(values) {
  const b = bandPercents(values, 70, 180);
  const hypo = b.vlow + 0.8 * b.low;
  const hyper = b.vhigh + 0.5 * b.high;
  const gri = Math.min(100, 3 * hypo + 1.6 * hyper);
  const zone = GRI_ZONES.find((z) => gri <= z.max) || GRI_ZONES[GRI_ZONES.length - 1];
  return { gri, hypoComponent: hypo, hyperComponent: hyper, zone: zone.zone, zoneLabel: zone.label };
}

// Episodes where glucose stays below `threshold` for at least `minMinutes`.
// A gap longer than 30 minutes breaks an episode.
export function findEpisodes(readings, test, minMinutes, interval) {
  const episodes = [];
  let start = null, last = null, nadir = Infinity, peak = -Infinity;
  const close = () => {
    if (start != null) {
      const duration = (last.t - start.t) / MIN + interval;
      if (duration >= minMinutes) {
        episodes.push({ start: start.t, end: last.t, duration, nadir, peak });
      }
    }
    start = null; last = null; nadir = Infinity; peak = -Infinity;
  };
  for (const r of readings) {
    if (last && r.t - last.t > 30 * MIN) close();
    if (test(r.v)) {
      if (start == null) start = r;
      last = r;
      nadir = Math.min(nadir, r.v);
      peak = Math.max(peak, r.v);
    } else {
      close();
    }
  }
  close();
  return episodes;
}

function periodOf(t) {
  const h = hourOf(t);
  return PERIODS.find((p) => h >= p.from && h < p.to).id;
}

// Ambulatory Glucose Profile: percentiles per 15-minute slot of the day,
// smoothed over a ±30 minute window.
export function ambulatoryGlucoseProfile(readings, slotMinutes = 15, windowMinutes = 30) {
  const slots = (24 * 60) / slotMinutes;
  const bySlot = Array.from({ length: slots }, () => []);
  for (const r of readings) {
    bySlot[Math.floor(minuteOfDay(r.t) / slotMinutes) % slots].push(r.v);
  }
  const half = Math.round(windowMinutes / slotMinutes);
  const profile = [];
  for (let s = 0; s < slots; s++) {
    const vals = [];
    for (let k = -half; k <= half; k++) vals.push(...bySlot[(s + k + slots) % slots]);
    vals.sort((a, b) => a - b);
    profile.push({
      minute: s * slotMinutes,
      n: vals.length,
      p5: percentile(vals, 0.05),
      p25: percentile(vals, 0.25),
      p50: percentile(vals, 0.5),
      p75: percentile(vals, 0.75),
      p95: percentile(vals, 0.95),
    });
  }
  return profile;
}

function dayKey(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function dailySummaries(readings, lo = 70, hi = 180) {
  const days = new Map();
  for (const r of readings) {
    const k = dayKey(r.t);
    if (!days.has(k)) days.set(k, []);
    days.get(k).push(r);
  }
  return [...days.entries()].map(([date, rs]) => {
    const vals = rs.map((r) => r.v);
    const b = bandPercents(vals, lo, hi);
    const dow = new Date(rs[0].t).getDay();
    return {
      date, dow, n: rs.length, readings: rs,
      mean: vals.reduce((a, b) => a + b, 0) / vals.length,
      tir: b.tir, tbr: b.tbr, tar: b.tar,
      min: Math.min(...vals), max: Math.max(...vals),
    };
  });
}

// Core metric bundle for a set of readings.
export function computeMetrics(rawReadings, profileId = 'standard') {
  const profile = TARGET_PROFILES[profileId] || TARGET_PROFILES.standard;
  const readings = cleanReadings(rawReadings);
  if (readings.length < 12) return null;

  const interval = samplingInterval(readings);
  const values = readings.map((r) => r.v);
  const n = values.length;
  const mean = values.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n - 1));
  const cv = (sd / mean) * 100;
  const gmi = 3.31 + 0.02392 * mean;

  const first = readings[0].t;
  const last = readings[n - 1].t;
  const spanDays = (last - first + interval * MIN) / DAY;
  const expected = (spanDays * DAY) / (interval * MIN);
  const activePercent = Math.min(100, (n / Math.max(1, expected)) * 100);

  const bands = bandPercents(values, profile.lo, profile.hi);
  const gri = glycemiaRiskIndex(values);

  const hypoEvents = findEpisodes(readings, (v) => v < 70, 15, interval);
  const severeHypoEvents = findEpisodes(readings, (v) => v < 54, 15, interval);
  const prolongedHighs = findEpisodes(readings, (v) => v > 250, 120, interval);

  const periods = {};
  for (const p of PERIODS) {
    const pv = readings.filter((r) => periodOf(r.t) === p.id).map((r) => r.v);
    const pb = bandPercents(pv, profile.lo, profile.hi);
    periods[p.id] = {
      ...p,
      n: pv.length,
      share: pv.length / n,
      mean: pv.length ? pv.reduce((a, b) => a + b, 0) / pv.length : NaN,
      tir: pb.tir, tbr: pb.tbr, tar: pb.tar, vlow: pb.vlow, vhigh: pb.vhigh,
    };
  }

  const t = profile.targets;
  const checks = [
    { key: 'tir', label: 'Time in Range', value: bands.tir, target: t.tir, dir: 'above' },
    { key: 'tbr', label: 'Time Below Range', value: bands.tbr, target: t.tbr, dir: 'below' },
    { key: 'vlow', label: 'Very Low (<54)', value: bands.vlow, target: t.vlow, dir: 'below' },
    { key: 'tar', label: 'Time Above Range', value: bands.tar, target: t.tar, dir: 'below' },
    { key: 'vhigh', label: 'Very High (>250)', value: bands.vhigh, target: t.vhigh, dir: 'below' },
    { key: 'cv', label: 'Variability (CV)', value: cv, target: t.cv, dir: 'below', unit: '%' },
  ]
    .filter((c) => c.target != null)
    .map((c) => ({ ...c, met: c.dir === 'above' ? c.value >= c.target : c.value <= c.target }));

  return {
    profile,
    readings,
    n,
    interval,
    first, last,
    spanDays,
    activePercent,
    sufficient: spanDays >= 10 && activePercent >= 70,
    mean, sd, cv, gmi,
    ...bands,
    gri,
    hypoEvents,
    severeHypoEvents,
    prolongedHighs,
    periods,
    checks,
    targetsMet: checks.filter((c) => c.met).length,
    agp: ambulatoryGlucoseProfile(readings),
    days: dailySummaries(readings, profile.lo, profile.hi),
  };
}

// ---------------------------------------------------------------------------
// Pattern detection. Each pattern carries a severity (safety first), a plain
// language explanation, and an estimated impact so the app can pick the one
// highest-leverage focus for the week.

function medianInWindow(agp, fromMin, toMin) {
  const vals = agp.filter((s) => s.minute >= fromMin && s.minute < toMin).map((s) => s.p50);
  if (!vals.length) return NaN;
  vals.sort((a, b) => a - b);
  return percentile(vals, 0.5);
}

const MEALS = [
  { id: 'breakfast', label: 'breakfast', from: 6, to: 11 },
  { id: 'lunch', label: 'lunch', from: 11, to: 15 },
  { id: 'dinner', label: 'dinner', from: 17, to: 22 },
];

// Detect sharp rises (≥60 mg/dL within 2 hours) inside each meal window.
export function mealRises(m) {
  const result = {};
  for (const meal of MEALS) {
    let daysWith = 0, daysObserved = 0, riseSum = 0, peakSum = 0;
    for (const day of m.days) {
      const win = day.readings.filter((r) => {
        const h = hourOf(r.t);
        return h >= meal.from && h < meal.to;
      });
      if (win.length < 6) continue;
      daysObserved++;
      let best = 0, bestPeak = 0;
      let j = 0;
      // Sliding window: largest rise from any trough to a later point ≤2h after.
      const minDeque = [];
      for (let i = 0; i < win.length; i++) {
        while (j < i && win[i].t - win[j].t > 2 * HOUR) {
          if (minDeque.length && minDeque[0] === j) minDeque.shift();
          j++;
        }
        const rise = minDeque.length ? win[i].v - win[minDeque[0]].v : 0;
        if (rise > best) { best = rise; bestPeak = win[i].v; }
        while (minDeque.length && win[minDeque[minDeque.length - 1]].v >= win[i].v) minDeque.pop();
        minDeque.push(i);
      }
      if (best >= 60) { daysWith++; riseSum += best; peakSum += bestPeak; }
    }
    result[meal.id] = {
      ...meal,
      daysObserved,
      daysWith,
      frequency: daysObserved ? daysWith / daysObserved : 0,
      avgRise: daysWith ? riseSum / daysWith : 0,
      avgPeak: daysWith ? peakSum / daysWith : 0,
    };
  }
  return result;
}

export function detectPatterns(m) {
  if (!m) return [];
  const patterns = [];
  const nightHypos = m.hypoEvents.filter((e) => hourOf(e.start) < 6);
  const weeks = Math.max(1, m.spanDays / 7);
  const periods = Object.values(m.periods).filter((p) => p.n > 0);
  const best = periods.reduce((a, b) => (b.tir > a.tir ? b : a), periods[0]);

  if (m.vlow >= 1 || m.severeHypoEvents.length >= 2) {
    patterns.push({
      id: 'level2-hypo',
      severity: 'urgent',
      title: 'Frequent very low readings',
      detail: `${round1(m.vlow)}% of readings were below 54 mg/dL (${m.severeHypoEvents.length} episodes of 15+ min). The consensus goal is under 1%.`,
      why: 'Level 2 lows carry the highest short-term risk and erode hypo awareness over time.',
      metric: { name: 'Very low time', value: m.vlow, unit: '%' },
      impactLabel: `Cut ${round1(m.vlow)} pts of very-low time`,
      score: 1000 + m.vlow * 50,
    });
  }

  if (m.periods.overnight.tbr > 4 || nightHypos.length >= 2) {
    patterns.push({
      id: 'nocturnal-hypo',
      severity: 'urgent',
      title: 'Overnight lows',
      detail: `${nightHypos.length} low episode${nightHypos.length === 1 ? '' : 's'} started between midnight and 6 AM; ${round1(m.periods.overnight.tbr)}% of overnight time was below range.`,
      why: 'Nighttime lows can go unnoticed while asleep. Bring this to your care team — evening insulin, bedtime snacks, and late exercise are common factors.',
      metric: { name: 'Overnight time below', value: m.periods.overnight.tbr, unit: '%' },
      impactLabel: `${nightHypos.length} overnight lows to prevent`,
      score: 900 + nightHypos.length * 20 + m.periods.overnight.tbr * 10,
    });
  } else if (m.tbr > m.profile.targets.tbr) {
    const worst = periods.reduce((a, b) => (b.tbr > a.tbr ? b : a), periods[0]);
    patterns.push({
      id: 'hypo',
      severity: 'high',
      title: `Lows cluster in the ${worst.label.toLowerCase()}`,
      detail: `Overall time below range is ${round1(m.tbr)}% (goal under ${m.profile.targets.tbr}%). The ${worst.label.toLowerCase()} is the hot spot at ${round1(worst.tbr)}%.`,
      why: 'Reducing lows comes before chasing highs — it is safer and often makes highs easier to fix (fewer rebound spikes).',
      metric: { name: 'Time below range', value: m.tbr, unit: '%' },
      impactLabel: `Cut ${round1(m.tbr - m.profile.targets.tbr)} pts of low time`,
      score: 800 + (m.tbr - m.profile.targets.tbr) * 30,
    });
  }

  // Rebound highs: a low followed by >180 within 2 hours.
  let rebounds = 0;
  for (const e of m.hypoEvents) {
    const after = m.readings.filter((r) => r.t > e.end && r.t <= e.end + 2 * HOUR);
    if (after.some((r) => r.v > 180)) rebounds++;
  }
  if (rebounds >= 2 && rebounds / Math.max(1, m.hypoEvents.length) >= 0.3) {
    patterns.push({
      id: 'rebound',
      severity: 'moderate',
      title: 'Rebound highs after lows',
      detail: `${rebounds} of ${m.hypoEvents.length} lows were followed by a spike above 180 mg/dL within 2 hours.`,
      why: 'Often a sign of over-treating lows. The "15-15 rule" (15 g fast carbs, recheck in 15 min) helps avoid the rollercoaster.',
      metric: { name: 'Rebound highs', value: rebounds, unit: '' },
      impactLabel: `${rebounds} rollercoaster cycles`,
      score: 400 + rebounds * 15,
    });
  }

  // Dawn phenomenon: median rises ≥20 mg/dL from 3 AM to 7–8 AM without night lows.
  const at3 = medianInWindow(m.agp, 150, 240);
  const at7 = medianInWindow(m.agp, 390, 480);
  if (at7 - at3 >= 20 && m.periods.overnight.tbr < 4) {
    patterns.push({
      id: 'dawn',
      severity: 'moderate',
      title: 'Early-morning rise (dawn phenomenon)',
      detail: `Your typical glucose climbs about ${Math.round(at7 - at3)} mg/dL between 3 AM and 7 AM, before breakfast.`,
      why: 'Morning hormones raise glucose before you wake. Your care team can look at basal timing or medication — it is a very fixable pattern.',
      metric: { name: 'Pre-breakfast rise', value: at7 - at3, unit: 'mg/dL' },
      impactLabel: `~${Math.round(at7 - at3)} mg/dL pre-breakfast rise`,
      score: 300 + (at7 - at3) * 2,
    });
  }

  // Meal-time rises.
  const rises = mealRises(m);
  const worstMeal = Object.values(rises).reduce((a, b) => (b.frequency * b.avgRise > a.frequency * a.avgRise ? b : a));
  if (worstMeal.frequency >= 0.4) {
    patterns.push({
      id: `meal-${worstMeal.id}`,
      severity: 'moderate',
      title: `Spikes after ${worstMeal.label}`,
      detail: `On ${worstMeal.daysWith} of ${worstMeal.daysObserved} days glucose rose ${Math.round(worstMeal.avgRise)} mg/dL or more within two hours around ${worstMeal.label}, peaking near ${Math.round(worstMeal.avgPeak)}.`,
      why: 'Meal composition (protein and fiber first), insulin timing, and a 10–15 minute walk after eating are the highest-yield levers for post-meal spikes.',
      metric: { name: `${worstMeal.label} spike days`, value: worstMeal.frequency * 100, unit: '%' },
      impactLabel: `${worstMeal.daysWith} spike days at ${worstMeal.label}`,
      score: 200 + worstMeal.frequency * worstMeal.avgRise,
    });
  }

  const prolongedPerWeek = m.prolongedHighs.length / weeks;
  if (prolongedPerWeek >= 1) {
    patterns.push({
      id: 'prolonged-high',
      severity: 'high',
      title: 'Long stretches above 250',
      detail: `${m.prolongedHighs.length} episode${m.prolongedHighs.length === 1 ? '' : 's'} of 2+ hours above 250 mg/dL (~${round1(prolongedPerWeek)} per week).`,
      why: 'Extended very high glucose raises ketone risk for people on insulin. A correction plan agreed with your care team keeps these short.',
      metric: { name: 'Prolonged highs / week', value: prolongedPerWeek, unit: '' },
      impactLabel: `${m.prolongedHighs.length} long highs`,
      score: 500 + prolongedPerWeek * 30,
    });
  }

  if (m.cv > 36) {
    patterns.push({
      id: 'variability',
      severity: 'moderate',
      title: 'High day-to-day variability',
      detail: `Your coefficient of variation is ${round1(m.cv)}% (stable is 36% or lower).`,
      why: 'High variability makes both lows and highs more likely. Consistent meal timing and composition are the usual first step.',
      metric: { name: 'CV', value: m.cv, unit: '%' },
      impactLabel: `CV ${round1(m.cv)}% → 36%`,
      score: 150 + (m.cv - 36) * 10,
    });
  }

  // Weekday vs weekend.
  const fullDays = m.days.filter((d) => d.n * m.interval >= 12 * 60);
  const wk = fullDays.filter((d) => d.dow > 0 && d.dow < 6);
  const we = fullDays.filter((d) => d.dow === 0 || d.dow === 6);
  if (wk.length >= 3 && we.length >= 2) {
    const a = wk.reduce((s, d) => s + d.tir, 0) / wk.length;
    const b = we.reduce((s, d) => s + d.tir, 0) / we.length;
    if (Math.abs(a - b) >= 10) {
      const worse = a < b ? 'weekdays' : 'weekends';
      patterns.push({
        id: 'weekend',
        severity: 'low',
        title: `${worse[0].toUpperCase() + worse.slice(1)} are harder`,
        detail: `Time in range averages ${Math.round(a)}% on weekdays and ${Math.round(b)}% on weekends.`,
        why: `Routine changes matter. Think about what is different on ${worse} — sleep, meals, activity, alcohol.`,
        metric: { name: 'TIR gap', value: Math.abs(a - b), unit: 'pts' },
        impactLabel: `${Math.round(Math.abs(a - b))} pt gap`,
        score: 100 + Math.abs(a - b),
      });
    }
  }

  // Positive reinforcement: strongest period.
  if (best && best.tir >= 70) {
    patterns.push({
      id: 'strength',
      severity: 'positive',
      title: `${best.label} is your strongest stretch`,
      detail: `${Math.round(best.tir)}% in range ${best.hours}. Whatever you do then is working.`,
      why: 'Look at what is different about that part of your day and see what can carry over.',
      metric: { name: `${best.label} TIR`, value: best.tir, unit: '%' },
      impactLabel: 'Keep it up',
      score: 0,
    });
  }

  return patterns.sort((a, b) => b.score - a.score);
}

// Opportunity sizing: how many points of overall TIR you could gain if each
// period performed like your best period. Grounded, conservative, explainable.
export function opportunities(m) {
  if (!m) return [];
  const periods = Object.values(m.periods).filter((p) => p.n > 0);
  const bestTir = Math.max(...periods.map((p) => p.tir));
  return periods
    .map((p) => ({
      id: p.id,
      label: p.label,
      hours: p.hours,
      tir: p.tir,
      gain: Math.max(0, (bestTir - p.tir) * p.share),
    }))
    .sort((a, b) => b.gain - a.gain);
}

// Projected clinical upside of a TIR gain. Beck et al., Diabetes Care 2019:
// each 10-pt decrease in TIR → 64% higher hazard of retinopathy progression and
// 40% higher hazard of microalbuminuria. We report the association, not a promise.
export function projectedBenefit(tirGain) {
  const tens = tirGain / 10;
  return {
    tirGain,
    // Approximate GMI change: ~0.8% A1C per 10% TIR (Vigersky & McMahon 2019).
    gmiDrop: 0.8 * tens,
    retinopathyHazardReduction: (1 - 1 / Math.pow(1.64, tens)) * 100,
    microalbuminuriaHazardReduction: (1 - 1 / Math.pow(1.4, tens)) * 100,
  };
}

// Compact, de-identified summary sent to the AI coach. No raw readings,
// no timestamps, no identifiers ever leave the device.
export function aiSummary(m, patterns, profileContext = {}) {
  const r = (x) => Math.round(x * 10) / 10;
  return {
    profile: m.profile.id,
    days: r(m.spanDays),
    activePercent: Math.round(m.activePercent),
    tir: r(m.tir), titr: r(m.titr), tbr: r(m.tbr), vlow: r(m.vlow), tar: r(m.tar), vhigh: r(m.vhigh),
    mean: Math.round(m.mean), gmi: r(m.gmi), cv: r(m.cv),
    gri: r(m.gri.gri), griZone: m.gri.zone,
    hypoEventsPerWeek: r(m.hypoEvents.length / Math.max(1, m.spanDays / 7)),
    periods: Object.fromEntries(
      Object.values(m.periods).map((p) => [p.id, { tir: r(p.tir), tbr: r(p.tbr), tar: r(p.tar) }])
    ),
    patterns: patterns.map((p) => ({ id: p.id, severity: p.severity, title: p.title, detail: p.detail })),
    context: profileContext,
  };
}
