// coach.js — Betawise AI coach endpoint (Netlify Functions v2).
//
// Unlike a generic proxy, the client never chooses the model, prompt, or token
// budget. It sends a de-identified metric summary (no raw readings, no
// timestamps, no identifiers) plus, for chat, the conversation so far.
//
//   POST /api/coach  { mode: "insights", summary }
//     -> JSON { summary, focus, wins, doctorQuestions }
//   POST /api/coach  { mode: "chat", summary, messages: [{role, content}] }
//     -> text/plain stream of the coach's reply
import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const MAX_MESSAGES = 24;
const MAX_CHARS = 2000;

let anthropic;
const client = () => (anthropic ??= new Anthropic());

// ---------------------------------------------------------------------------
// Safety: deterministic triage that never depends on the model.

const EMERGENCY = /(pass(ed|ing)? out|unconscious|unresponsive|seiz(ure|ing)|can'?t wake|won'?t wake|glucagon|confus(ed|ion) and low|vomiting.*(ketone|high)|ketone.*(high|large|moderate)|\bdka\b|chest pain|trouble breathing)/i;
const CRISIS = /(suicid|kill myself|end my life|want to die|self[- ]harm|hurt myself|overdose on insulin|take all my insulin)/i;
const DOSING = /(how (much|many) (units|insulin)|what dose|change my (basal|bolus|dose|ratio)|insulin[- ]to[- ]carb ratio should|correction factor should)/i;

const EMERGENCY_REPLY =
  "This sounds like it could be an emergency. If someone is unconscious, having a seizure, or can't safely swallow, call 911 (or your local emergency number) now and use glucagon if it's available. If you have high ketones, vomiting, or trouble breathing, contact your care team's urgent line or go to the emergency room right away. I'm not able to help in an emergency, so please reach out to people who can. I'll be here afterward.";

const CRISIS_REPLY =
  "I'm really glad you told me. You deserve support right now from a real person. In the US you can call or text 988 (Suicide & Crisis Lifeline) any time, or text HOME to 741741. If you're in immediate danger, call 911. Diabetes burnout is real and heavy, and you don't have to carry it alone. Would you like to talk about what's been going on?";

export function triage(text) {
  if (CRISIS.test(text)) return { kind: 'crisis', reply: CRISIS_REPLY };
  if (EMERGENCY.test(text)) return { kind: 'emergency', reply: EMERGENCY_REPLY };
  if (DOSING.test(text)) return { kind: 'dosing' };
  return null;
}

// ---------------------------------------------------------------------------
// Light per-instance rate limit (best effort; pair with Netlify rate limiting).

const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), windowMs = 10 * 60 * 1000, limit = 40;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > limit;
}

// ---------------------------------------------------------------------------
// Input validation — only whitelisted, bounded fields reach the prompt.

const num = (x, lo, hi) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : null);
const str = (x, max = 120) => (typeof x === 'string' ? x.slice(0, max).replace(/[<>]/g, '') : undefined);

export function sanitizeSummary(s = {}) {
  const periods = {};
  for (const k of ['overnight', 'morning', 'afternoon', 'evening']) {
    const p = s.periods?.[k] || {};
    periods[k] = { tir: num(p.tir, 0, 100), tbr: num(p.tbr, 0, 100), tar: num(p.tar, 0, 100) };
  }
  const ctx = s.context || {};
  return {
    profile: ['standard', 'older', 'pregnancy'].includes(s.profile) ? s.profile : 'standard',
    days: num(s.days, 0, 90), activePercent: num(s.activePercent, 0, 100),
    tir: num(s.tir, 0, 100), titr: num(s.titr, 0, 100), tbr: num(s.tbr, 0, 100), vlow: num(s.vlow, 0, 100),
    tar: num(s.tar, 0, 100), vhigh: num(s.vhigh, 0, 100),
    mean: num(s.mean, 20, 600), gmi: num(s.gmi, 4, 15), cv: num(s.cv, 0, 100),
    gri: num(s.gri, 0, 100), griZone: ['A', 'B', 'C', 'D', 'E'].includes(s.griZone) ? s.griZone : null,
    hypoEventsPerWeek: num(s.hypoEventsPerWeek, 0, 100),
    periods,
    patterns: (Array.isArray(s.patterns) ? s.patterns : []).slice(0, 10).map((p) => ({
      id: str(p.id, 40), severity: str(p.severity, 20), title: str(p.title, 120), detail: str(p.detail, 300),
    })),
    context: {
      diabetesType: str(ctx.diabetesType, 40),
      therapy: str(ctx.therapy, 60),
      yearsWithDiabetes: num(ctx.yearsWithDiabetes, 0, 90),
      recentlyDiagnosed: ctx.recentlyDiagnosed === true || undefined,
      veryActive: ctx.veryActive === true || undefined,
      goal: str(ctx.goal, 200),
      notes: str(ctx.notes, 400),
    },
  };
}

function sanitizeMessages(messages) {
  if (!Array.isArray(messages)) return null;
  const out = messages.slice(-MAX_MESSAGES)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }));
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

// ---------------------------------------------------------------------------
// Prompts.

const SAFETY_RULES = `Safety rules (non-negotiable):
- You are not a clinician and Betawise is not a medical device. Never recommend specific insulin or medication doses, ratios, correction factors, or pump settings, and never tell someone to start, stop, or change a medication. When those questions come up, explain what the data suggests and frame it as a question to bring to their care team.
- Lows come first. If time below range or very-low time is above target, address that before anything about highs.
- If someone describes symptoms of a severe low, DKA, or a mental-health crisis, tell them to contact emergency services or their care team immediately.
- Only cite numbers that appear in the data below. Do not invent statistics.`;

function dataBlock(s) {
  return `<cgm_summary>\n${JSON.stringify(s, null, 1)}\n</cgm_summary>

Field guide: tir = % time 70–180 mg/dL (63–140 for pregnancy profile); titr = % time 70–140; tbr = % below range; vlow = % below 54; tar = % above range; vhigh = % above 250; gmi = estimated A1C (%); cv = coefficient of variation (%); gri = Glycemia Risk Index 0–100 (zone A best … E worst). Consensus targets (standard adults): TIR >70, TBR <4, vlow <1, TAR <25, vhigh <5, CV ≤36. Older/high-risk: TIR >50, TBR <1. Patterns were detected deterministically by Betawise; trust them.`;
}

const INSIGHTS_SYSTEM = `You are Betawise, a CGM coach that turns 14 days of glucose data into one clear, achievable next step. Write like a seasoned certified diabetes educator who also lives with diabetes: warm, specific, plain language (8th-grade reading level), zero shame.

${SAFETY_RULES}

Produce:
- summary: 2–3 sentences on what the numbers mean for daily life. Lead with something genuinely positive if one exists.
- focus: the single highest-impact area for the next 7 days. Pick the top-priority detected pattern unless the data clearly argues otherwise. Give a short title, one sentence on why it matters, and 2–3 concrete behavior experiments (things to try or observe, not dosing changes).
- wins: 1–3 short things going well.
- doctorQuestions: 3 specific questions for their next appointment, each under 20 words, grounded in the data.`;

const INSIGHTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'focus', 'wins', 'doctorQuestions'],
  properties: {
    summary: { type: 'string' },
    focus: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'why', 'experiments'],
      properties: {
        title: { type: 'string' },
        why: { type: 'string' },
        experiments: { type: 'array', items: { type: 'string' } },
      },
    },
    wins: { type: 'array', items: { type: 'string' } },
    doctorQuestions: { type: 'array', items: { type: 'string' } },
  },
};

const CHAT_SYSTEM = `You are the Betawise peer coach: someone who has lived with diabetes for years and trained as a diabetes educator. You talk like a knowledgeable friend — empathetic, practical, honest, never preachy. Keep replies to about 3–6 sentences unless the person asks for more. Use plain text (short bullet lists with "- " are fine; no headings, no markdown tables). Reference their actual patterns when it helps. Ask one good follow-up question when it moves things forward. If they would benefit from a human, mention that The Time in Range Project offers free one-on-one peer mentors.

${SAFETY_RULES}`;

// ---------------------------------------------------------------------------

const json = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });

function textStream(text) {
  return new Response(text, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

async function insights(summary) {
  const response = await client().beta.messages.create({
    model: MODEL,
    max_tokens: 4000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system: INSIGHTS_SYSTEM,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: INSIGHTS_SCHEMA } },
    messages: [{ role: 'user', content: `${dataBlock(summary)}\n\nCreate my weekly insight.` }],
  });
  if (response.stop_reason === 'refusal') {
    return json({ error: { message: 'The coach could not generate insights for this data. Please try again.' } }, 422);
  }
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  try {
    return json(JSON.parse(text));
  } catch {
    return json({ error: { message: 'The coach returned an unexpected format. Please try again.' } }, 502);
  }
}

function chat(summary, messages, flag) {
  const system = [
    { type: 'text', text: CHAT_SYSTEM },
    { type: 'text', text: dataBlock(summary) },
  ];
  if (flag?.kind === 'dosing') {
    system.push({ type: 'text', text: 'The latest message asks about dosing. Do not give numbers. Explain what the data shows and help them prepare the question for their care team.' });
  }

  const stream = client().beta.messages.stream({
    model: MODEL,
    max_tokens: 2000,
    betas: [FALLBACK_BETA],
    fallbacks: 'default',
    system,
    output_config: { effort: 'low' },
    messages,
  });

  const encoder = new TextEncoder();
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        }
        const final = await stream.finalMessage();
        if (final.stop_reason === 'refusal') {
          controller.enqueue(encoder.encode("\n\nI can't help with that one — but I'm happy to talk through your numbers or anything else on your mind."));
        }
      } catch (err) {
        console.error('coach stream error', err);
        controller.enqueue(encoder.encode('\n\n[Connection to the coach was interrupted. Please try again.]'));
      }
      controller.close();
    },
    cancel() { stream.abort(); },
  });
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } });
}

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: { message: 'Method not allowed' } }, 405);
  const ip = context?.ip || req.headers.get('x-forwarded-for') || 'local';
  if (rateLimited(ip)) return json({ error: { message: 'Too many requests. Please wait a few minutes.' } }, 429);

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: { message: 'Invalid JSON' } }, 400);
  }
  const summary = sanitizeSummary(body.summary);
  const notConfigured = () => json({ error: { message: 'The AI coach is not configured on this server yet.' } }, 503);

  try {
    if (body.mode === 'insights') return process.env.ANTHROPIC_API_KEY ? await insights(summary) : notConfigured();
    if (body.mode === 'chat') {
      const messages = sanitizeMessages(body.messages);
      if (!messages) return json({ error: { message: 'Conversation must end with a user message.' } }, 400);
      const flag = triage(messages[messages.length - 1].content);
      if (flag?.reply) return textStream(flag.reply);
      return process.env.ANTHROPIC_API_KEY ? chat(summary, messages, flag) : notConfigured();
    }
    return json({ error: { message: 'Unknown mode' } }, 400);
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) return json({ error: { message: 'The coach is busy. Please try again shortly.' } }, 429);
    if (err instanceof Anthropic.APIError) {
      console.error('Anthropic API error', err.status, err.message);
      return json({ error: { message: 'The coach is temporarily unavailable.' } }, 502);
    }
    console.error('coach error', err);
    return json({ error: { message: 'Unexpected error.' } }, 500);
  }
};

export const config = { path: '/api/coach' };
