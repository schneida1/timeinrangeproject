import { test } from 'node:test';
import assert from 'node:assert/strict';
import coach, { triage, sanitizeSummary } from '../netlify/functions/coach.js';

test('emergency and crisis messages get deterministic replies', () => {
  assert.equal(triage('my husband passed out and is low').kind, 'emergency');
  assert.equal(triage('I want to kill myself').kind, 'crisis');
  assert.equal(triage('how many units should I take for pizza').kind, 'dosing');
  assert.equal(triage('what is a good TIR?'), null);
});

test('summary sanitizer clamps numbers and drops unknown fields', () => {
  const s = sanitizeSummary({ tir: 140, tbr: -3, profile: 'evil', secret: 'x', context: { notes: '<script>'.repeat(200) } });
  assert.equal(s.tir, 100);
  assert.equal(s.tbr, 0);
  assert.equal(s.profile, 'standard');
  assert.equal(s.secret, undefined);
  assert.ok(!s.context.notes.includes('<'));
  assert.ok(s.context.notes.length <= 400);
});

const post = (body) => new Request('http://x/api/coach', { method: 'POST', body: JSON.stringify(body) });

test('crisis reply is returned without calling the model', async () => {
  const res = await coach(post({ mode: 'chat', messages: [{ role: 'user', content: 'I want to end my life' }] }), { ip: 't1' });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /988/);
});

test('rejects unknown modes and malformed conversations', async () => {
  assert.equal((await coach(post({ mode: 'raw' }), { ip: 't2' })).status, 400);
  assert.equal((await coach(post({ mode: 'chat', messages: [{ role: 'assistant', content: 'hi' }] }), { ip: 't2' })).status, 400);
  assert.equal((await coach(new Request('http://x', { method: 'GET' }), { ip: 't2' })).status, 405);
});
