import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeMetrics, glycemiaRiskIndex, findEpisodes, detectPatterns, cleanReadings, samplingInterval, percentile, projectedBenefit, aiSummary,
} from '../betawise/js/metrics.js';
import { generateTrace, PERSONAS } from '../betawise/js/demo.js';

const START = new Date('2026-09-01T00:00:00').getTime();
const series = (fn, days = 14, step = 5) =>
  Array.from({ length: (days * 1440) / step }, (_, i) => ({ t: START + i * step * 60000, v: fn(i, (i * step) % 1440) }));

test('flat in-range trace is 100% TIR with zero risk', () => {
  const m = computeMetrics(series(() => 120));
  assert.equal(Math.round(m.tir), 100);
  assert.equal(m.tbr, 0);
  assert.equal(m.gri.gri, 0);
  assert.equal(m.gri.zone, 'A');
  assert.ok(Math.abs(m.gmi - (3.31 + 0.02392 * 120)) < 1e-9);
  assert.ok(m.sufficient);
  assert.equal(m.interval, 5);
});

test('band percentages use consensus cut-points', () => {
  // 10 values cycling through each band: 2 vlow, 2 low, 2 tir, 2 high, 2 vhigh
  const vals = [50, 50, 60, 60, 120, 120, 200, 200, 300, 300];
  const m = computeMetrics(series((i) => vals[i % 10], 3));
  assert.equal(Math.round(m.vlow), 20);
  assert.equal(Math.round(m.low), 20);
  assert.equal(Math.round(m.tbr), 40);
  assert.equal(Math.round(m.tir), 20);
  assert.equal(Math.round(m.tar), 40);
  assert.equal(Math.round(m.vhigh), 20);
});

test('GRI formula matches Klonoff 2023', () => {
  // VLow 2%, Low 3%, High 10%, VHigh 5%
  const vals = [...Array(2).fill(50), ...Array(3).fill(65), ...Array(80).fill(120), ...Array(10).fill(200), ...Array(5).fill(300)];
  const r = glycemiaRiskIndex(vals);
  const expected = 3.0 * 2 + 2.4 * 3 + 1.6 * 5 + 0.8 * 10;
  assert.ok(Math.abs(r.gri - expected) < 1e-9, `${r.gri} vs ${expected}`);
  assert.equal(r.zone, 'B');
});

test('hypo episodes require 15 minutes and break on gaps', () => {
  const rs = [100, 65, 65, 65, 100, 65, 100].map((v, i) => ({ t: START + i * 5 * 60000, v }));
  const eps = findEpisodes(rs, (v) => v < 70, 15, 5);
  assert.equal(eps.length, 1);
  assert.equal(eps[0].duration, 15);
});

test('cleanReadings drops invalid values and duplicates', () => {
  const rs = cleanReadings([{ t: START, v: 100 }, { t: START + 1000, v: 101 }, { t: START + 300000, v: 'x' }, { t: START + 600000, v: 700 }, { t: START + 900000, v: 110 }]);
  assert.deepEqual(rs.map((r) => r.v), [100, 110]);
});

test('sampling interval detects Libre 15-minute data', () => {
  assert.equal(samplingInterval(series(() => 100, 2, 15)), 15);
});

test('percentile interpolates', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
});

test('overnight lows are flagged urgent and ranked first', () => {
  const m = computeMetrics(series((i, minute) => (minute >= 120 && minute < 180 ? 60 : 130)));
  const p = detectPatterns(m);
  assert.equal(p[0].id, 'nocturnal-hypo');
  assert.equal(p[0].severity, 'urgent');
});

test('dawn phenomenon is detected from the AGP', () => {
  const m = computeMetrics(series((i, minute) => (minute < 180 ? 110 : minute < 480 ? 110 + ((minute - 180) / 300) * 60 : 170)));
  assert.ok(detectPatterns(m).some((p) => p.id === 'dawn'));
});

test('projected benefit is zero for zero gain and grows with gain', () => {
  assert.equal(projectedBenefit(0).gmiDrop, 0);
  assert.ok(projectedBenefit(10).retinopathyHazardReduction > projectedBenefit(5).retinopathyHazardReduction);
});

test('AI summary contains no raw readings or timestamps', () => {
  const m = computeMetrics(generateTrace('sarah', { endTime: START + 14 * 864e5 }));
  const s = JSON.stringify(aiSummary(m, detectPatterns(m)));
  assert.ok(!s.includes('"readings"'));
  assert.ok(!/\d{13}/.test(s), 'no epoch timestamps');
});

test('every demo persona is deterministic and produces sufficient data', () => {
  for (const id of Object.keys(PERSONAS)) {
    const a = generateTrace(id, { endTime: START + 14 * 864e5 });
    const b = generateTrace(id, { endTime: START + 14 * 864e5 });
    assert.deepEqual(a, b);
    const m = computeMetrics(a);
    assert.ok(m.sufficient, id);
    assert.ok(m.tir > 20 && m.tir < 98, `${id} TIR ${m.tir}`);
  }
});
