// dev-server.js — local development server, no dependencies.
// Serves the static site and runs the same Netlify functions used in production.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run dev
//   open http://localhost:8888/betawise/

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import coach from './netlify/functions/coach.js';
import dexcom from './netlify/functions/dexcom.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8888;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

async function toRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
  });
}

async function send(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  const setCookie = response.headers.getSetCookie?.();
  if (setCookie?.length) headers['set-cookie'] = setCookie;
  res.writeHead(response.status, headers);
  if (response.body) Readable.fromWeb(response.body).pipe(res);
  else res.end();
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === '/api/coach') return send(res, await coach(await toRequest(req), { ip: req.socket.remoteAddress }));
    if (url.pathname.startsWith('/api/dexcom/')) return send(res, await dexcom(await toRequest(req)));

    let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!file.startsWith(root) || file.includes(`${path.sep}node_modules`) || file.includes(`${path.sep}.git`)) {
      res.writeHead(403); return res.end();
    }
    const stat = await fs.stat(file).catch(() => null);
    if (stat?.isDirectory()) file = path.join(file, 'index.html');
    const data = await fs.readFile(file).catch(() => null);
    if (!data) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    console.error(err);
    res.writeHead(500); res.end('Server error');
  }
}).listen(PORT, () => console.log(`Time in Range Project running at http://localhost:${PORT}/betawise/`));
