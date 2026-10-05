// dexcom.js — Dexcom OAuth + EGV proxy (Netlify Functions v2).
//
// The client secret and refresh token never touch the browser: the refresh
// token lives in an HttpOnly, Secure, SameSite=Lax cookie scoped to /api/dexcom.
//
// Env: DEXCOM_CLIENT_ID, DEXCOM_CLIENT_SECRET, DEXCOM_REDIRECT_URI,
//      DEXCOM_ENV=sandbox|production (default sandbox)
//
//   GET  /api/dexcom/login     -> 302 to Dexcom consent screen
//   GET  /api/dexcom/callback  -> exchanges code, sets cookie, 302 to app
//   GET  /api/dexcom/egvs      -> { readings: [{ t, v }] } (last 14 days)
//   GET  /api/dexcom/status    -> { configured, connected }
//   POST /api/dexcom/logout    -> clears cookie

const APP_PATH = '/betawise/app.html';
const COOKIE = 'bw_dx';
const STATE_COOKIE = 'bw_dx_state';

const base = () => (process.env.DEXCOM_ENV === 'production' ? 'https://api.dexcom.com' : 'https://sandbox-api.dexcom.com');
const configured = () => Boolean(process.env.DEXCOM_CLIENT_ID && process.env.DEXCOM_CLIENT_SECRET && process.env.DEXCOM_REDIRECT_URI);

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/api/dexcom; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function token(params) {
  const res = await fetch(`${base()}/v2/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.DEXCOM_CLIENT_ID,
      client_secret: process.env.DEXCOM_CLIENT_SECRET,
      redirect_uri: process.env.DEXCOM_REDIRECT_URI,
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`Dexcom token error ${res.status}`);
  return res.json();
}

const fmt = (d) => d.toISOString().slice(0, 19);
const json = (body, status = 200, headers = {}) =>
  Response.json(body, { status, headers: { 'Cache-Control': 'no-store', ...headers } });

export default async (req) => {
  const url = new URL(req.url);
  const action = url.pathname.split('/').pop();

  if (action === 'status') {
    return json({ configured: configured(), connected: Boolean(cookies(req)[COOKIE]) });
  }
  if (!configured()) return json({ error: { message: 'Dexcom integration is not configured on this server.' } }, 503);

  if (action === 'login' && req.method === 'GET') {
    const state = crypto.randomUUID();
    const auth = new URL(`${base()}/v2/oauth2/login`);
    auth.search = new URLSearchParams({
      client_id: process.env.DEXCOM_CLIENT_ID,
      redirect_uri: process.env.DEXCOM_REDIRECT_URI,
      response_type: 'code',
      scope: 'offline_access',
      state,
    });
    return new Response(null, { status: 302, headers: { Location: auth.toString(), 'Set-Cookie': setCookie(STATE_COOKIE, state, 600) } });
  }

  if (action === 'callback' && req.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state || state !== cookies(req)[STATE_COOKIE]) {
      return Response.redirect(new URL(`${APP_PATH}#dexcom=error`, url.origin), 302);
    }
    try {
      const t = await token({ code, grant_type: 'authorization_code' });
      const headers = new Headers({ Location: `${APP_PATH}#dexcom=connected` });
      headers.append('Set-Cookie', setCookie(COOKIE, t.refresh_token, 60 * 60 * 24 * 90));
      headers.append('Set-Cookie', setCookie(STATE_COOKIE, '', 0));
      return new Response(null, { status: 302, headers });
    } catch (err) {
      console.error(err);
      return Response.redirect(new URL(`${APP_PATH}#dexcom=error`, url.origin), 302);
    }
  }

  if (action === 'egvs' && req.method === 'GET') {
    const refresh = cookies(req)[COOKIE];
    if (!refresh) return json({ error: { message: 'Not connected to Dexcom.' } }, 401);
    let t;
    try {
      t = await token({ refresh_token: refresh, grant_type: 'refresh_token' });
    } catch {
      return json({ error: { message: 'Dexcom session expired. Please reconnect.' } }, 401, { 'Set-Cookie': setCookie(COOKIE, '', 0) });
    }
    const end = new Date();
    const start = new Date(end - 14 * 864e5);
    const res = await fetch(`${base()}/v3/users/self/egvs?startDate=${fmt(start)}&endDate=${fmt(end)}`, {
      headers: { Authorization: `Bearer ${t.access_token}` },
    });
    if (!res.ok) return json({ error: { message: `Dexcom returned ${res.status}` } }, 502);
    const data = await res.json();
    // displayTime is the device's local clock — what time-of-day analysis needs.
    const readings = (data.records || [])
      .filter((r) => Number.isFinite(r.value))
      .map((r) => ({ t: r.displayTime || r.systemTime, v: r.value }));
    return json({ readings }, 200, { 'Set-Cookie': setCookie(COOKIE, t.refresh_token || refresh, 60 * 60 * 24 * 90) });
  }

  if (action === 'logout' && req.method === 'POST') {
    return json({ ok: true }, 200, { 'Set-Cookie': setCookie(COOKIE, '', 0) });
  }

  return json({ error: { message: 'Not found' } }, 404);
};

export const config = { path: '/api/dexcom/*' };
