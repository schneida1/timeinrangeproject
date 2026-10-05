// demo.js — deterministic synthetic CGM traces for demo personas.
// Physiologically plausible, not real patient data. Seeded so every demo
// (and every investor walkthrough) shows the same numbers.

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

// Gamma-like absorption curve peaking at `peak` minutes.
function bump(minutesSince, peak) {
  if (minutesSince < 0) return 0;
  const x = minutesSince / peak;
  return Math.pow(x, 2) * Math.exp(2 * (1 - x));
}

export const PERSONAS = {
  sarah: {
    id: 'sarah',
    name: 'Sarah',
    blurb: 'Type 1 · 8 years · insulin pump',
    story: 'Working on overnight stability and breakfast spikes.',
    context: { diabetesType: 'Type 1', therapy: 'Insulin pump', yearsWithDiabetes: 8 },
    seed: 11,
    base: 140, noise: 9, drift: 18,
    dawn: 20,
    meals: { breakfast: [7.5, 125, 0.3], lunch: [12.5, 70, 0.35], dinner: [19, 90, 0.4] },
    nightLowChance: 0.5, nightLowDepth: 115,
    exerciseChance: 0.2, exerciseHour: 17.5, exerciseDepth: 50,
    reboundOnLow: 0.6,
    weekendShift: 10,
  },
  marcus: {
    id: 'marcus',
    name: 'Marcus',
    blurb: 'Type 2 · 3 years · oral meds, new to CGM',
    story: 'Afternoon and evening highs; very few lows.',
    context: { diabetesType: 'Type 2', therapy: 'Oral medication', yearsWithDiabetes: 3 },
    seed: 23,
    base: 132, noise: 6, drift: 14,
    dawn: 10,
    meals: { breakfast: [8, 60, 0.3], lunch: [13, 95, 0.35], dinner: [19.5, 105, 0.35] },
    nightLowChance: 0.02, nightLowDepth: 50,
    exerciseChance: 0.15, exerciseHour: 18, exerciseDepth: 20,
    reboundOnLow: 0,
    weekendShift: 22,
  },
  priya: {
    id: 'priya',
    name: 'Priya',
    blurb: 'Type 1 · newly diagnosed · injections',
    story: 'Still finding her baseline — big swings both ways.',
    context: { diabetesType: 'Type 1', therapy: 'Multiple daily injections', yearsWithDiabetes: 0, recentlyDiagnosed: true },
    seed: 37,
    base: 158, noise: 14, drift: 42,
    dawn: 25,
    meals: { breakfast: [8, 120, 0.45], lunch: [13, 100, 0.5], dinner: [19, 115, 0.5] },
    nightLowChance: 0.55, nightLowDepth: 140,
    exerciseChance: 0.35, exerciseHour: 16, exerciseDepth: 110,
    reboundOnLow: 0.8,
    weekendShift: 0,
  },
  james: {
    id: 'james',
    name: 'James',
    blurb: 'Type 1 · 15 years · closed-loop, triathlete',
    story: 'Tight control; lows show up after long training sessions.',
    context: { diabetesType: 'Type 1', therapy: 'Automated insulin delivery', yearsWithDiabetes: 15, veryActive: true },
    seed: 41,
    base: 125, noise: 6, drift: 12,
    dawn: 0,
    meals: { breakfast: [9, 70, 0.3], lunch: [12.5, 55, 0.3], dinner: [19, 65, 0.3] },
    nightLowChance: 0.06, nightLowDepth: 50,
    exerciseChance: 0.6, exerciseHour: 6.5, exerciseDepth: 75,
    reboundOnLow: 0.2,
    weekendShift: 0,
  },
};

// Generate `days` of readings every `interval` minutes, ending at `endTime`.
export function generateTrace(personaId, { days = 14, interval = 5, endTime = Date.now() } = {}) {
  const p = PERSONAS[personaId];
  if (!p) throw new Error(`Unknown persona ${personaId}`);
  const rand = mulberry32(p.seed);

  const end = new Date(endTime);
  end.setMinutes(Math.floor(end.getMinutes() / interval) * interval, 0, 0);
  const startDay = new Date(end);
  startDay.setHours(0, 0, 0, 0);
  startDay.setDate(startDay.getDate() - days + 1);

  // Pre-plan daily events.
  const plan = [];
  for (let d = 0; d < days; d++) {
    const dayStart = new Date(startDay);
    dayStart.setDate(dayStart.getDate() + d);
    const dow = dayStart.getDay();
    const weekend = dow === 0 || dow === 6;
    const events = [];
    for (const [, [hour, size, jitter]] of Object.entries(p.meals)) {
      const h = hour + (weekend ? 1 : 0) + gauss(rand) * 0.6;
      const s = size * (1 + gauss(rand) * jitter) + (weekend ? p.weekendShift : 0);
      events.push({ kind: 'meal', at: h * 60, size: Math.max(10, s), peak: 55 + rand() * 35 });
    }
    if (rand() < p.nightLowChance) {
      events.push({ kind: 'low', at: (1 + rand() * 4) * 60, size: p.nightLowDepth * (0.7 + rand() * 0.6), dur: 70 + rand() * 80 });
    }
    if (rand() < p.exerciseChance) {
      events.push({ kind: 'low', at: (p.exerciseHour + gauss(rand) * 0.7) * 60, size: p.exerciseDepth * (0.6 + rand() * 0.8), dur: 80 + rand() * 60 });
    }
    plan.push({ dayStart: +dayStart, events, dayBias: gauss(rand) * p.drift * 0.6 });
  }

  const readings = [];
  let ar = 0;
  const startTs = +startDay;
  for (let t = startTs; t <= +end; t += interval * 60000) {
    const dIdx = Math.floor((t - startTs) / 864e5);
    const day = plan[Math.min(dIdx, plan.length - 1)];
    const minute = (t - day.dayStart) / 60000;
    let g = p.base + day.dayBias;
    // Dawn phenomenon: smooth rise 3–8 AM, fades by noon.
    if (minute > 180 && minute < 720) {
      const x = minute < 480 ? (minute - 180) / 300 : 1 - (minute - 480) / 240;
      g += p.dawn * Math.max(0, x);
    }
    let lowNow = false;
    // Include previous day's events late in the evening (overlap at midnight).
    const prev = plan[dIdx - 1];
    const evs = [...day.events.map((e) => ({ ...e, rel: minute - e.at })),
      ...(prev ? prev.events.map((e) => ({ ...e, rel: minute + 1440 - e.at })) : [])];
    for (const e of evs) {
      if (e.kind === 'meal') {
        g += e.size * bump(e.rel, e.peak) * (e.rel < 300 ? 1 : 0);
      } else if (e.kind === 'low' && e.rel >= 0 && e.rel < e.dur + 120) {
        const phase = e.rel / e.dur;
        if (phase <= 1) {
          g -= e.size * Math.sin(Math.PI * Math.min(1, phase * 1.2) / 2);
          lowNow = true;
        } else {
          // Recovery, with optional over-treatment rebound.
          const rec = (e.rel - e.dur) / 120;
          g -= e.size * Math.max(0, 1 - rec * 2.2);
          if (p.reboundOnLow && ((e.at * 7) % 10) / 10 < p.reboundOnLow) {
            g += 95 * Math.sin(Math.PI * Math.min(1, rec));
          }
        }
      }
    }
    ar = 0.94 * ar + gauss(rand) * (lowNow ? 1 : p.drift * 0.22);
    g += ar + gauss(rand) * p.noise * 0.4;
    readings.push({ t, v: Math.round(Math.min(400, Math.max(40, g))) });
  }
  // Sensor gaps: drop ~2% of readings in short runs for realism.
  return readings.filter((_, i) => Math.floor(i / 6) % 50 !== 17);
}
