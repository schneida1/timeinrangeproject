# The Time in Range Project + Betawise

Static site for **The Time in Range Project** (nonprofit diabetes peer mentorship) and **Betawise**, its CGM coaching app.

```
/                     Nonprofit site (index, about, how-it-works, apply, donate, …)
/betawise/            Betawise product landing page
/betawise/app.html    The Betawise app
/betawise/investors.html  Investor brief
netlify/functions/    Serverless API: AI coach (/api/coach), Dexcom OAuth (/api/dexcom/*)
tests/                Unit tests for the analytics engine, CSV parsers, and coach safety layer
```

## Betawise at a glance

- **Analytics engine** (`betawise/js/metrics.js`) — pure, tested functions implementing the International
  Consensus on Time in Range (Battelino 2019), the Glycemia Risk Index (Klonoff 2023), GMI (Bergenstal 2018),
  an Ambulatory Glucose Profile, hypoglycemia episode detection, and safety-first pattern detection.
- **Privacy** — readings are parsed and analyzed in the browser and stored only in `localStorage`. The AI coach
  receives a de-identified summary (`aiSummary`) — never raw readings, timestamps, or identifiers.
- **AI coach** (`netlify/functions/coach.js`) — server-owned prompts, model, and token limits (the client cannot
  send arbitrary prompts). Structured JSON weekly insights and a streaming peer-coach chat. Emergency, crisis, and
  dosing questions are triaged deterministically before any model call.
- **Demo personas** (`betawise/js/demo.js`) — seeded synthetic 14-day CGM traces so every feature works without
  real data. Link straight to one with `app.html?demo=sarah` (also `marcus`, `priya`, `james`).

## Run locally

```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm run dev   # http://localhost:8888/betawise/
npm test
```

Without `ANTHROPIC_API_KEY`, everything except the AI coach works (safety triage still responds).

## Deploy (Netlify)

`netlify.toml` publishes the repo root and bundles `netlify/functions`. Set these environment variables:

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | AI coach |
| `DEXCOM_CLIENT_ID`, `DEXCOM_CLIENT_SECRET` | Dexcom developer app credentials (optional) |
| `DEXCOM_REDIRECT_URI` | `https://<your-domain>/api/dexcom/callback` |
| `DEXCOM_ENV` | `sandbox` (default) or `production` |

Betawise is an educational tool, not a medical device, and does not provide dosing advice.
