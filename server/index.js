'use strict';
/**
 * ReelBlend — HTTP server.
 *
 * Zero dependencies (Node >= 18 for global fetch). Serves the static client from
 * /public, the JSON API from /server/lib/api.js, and proxies nothing: every
 * video frame comes straight from TikTok's or Facebook's own official player.
 *
 *   node server/index.js            # http://localhost:8787
 *   PORT=9000 node server/index.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const { createApi } = require('./lib/api');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

// REELBLEND_RESET=1 rebuilds the catalog from data/seed.json, discarding runtime state
if (process.env.REELBLEND_RESET === '1') {
  for (const f of ['store.json', 'store.json.tmp']) {
    try { require('fs').unlinkSync(path.join(ROOT, 'data', f)); console.log('reset: removed data/' + f); } catch {}
  }
}

const store = new Store({
  seedPath: path.join(ROOT, 'data', 'seed.json'),
  dataPath: path.join(ROOT, 'data', 'store.json'),
});

const boot = store.load();
const api = createApi(store);

function serveStatic(req, res) {
  let rel = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.join(ROOT, 'public', path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'public'))) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      // SPA fallback: unknown non-API path renders the shell
      const shell = path.join(ROOT, 'public', 'index.html');
      fs.readFile(shell, (e2, buf) => {
        if (e2) { res.writeHead(404).end('not found'); return; }
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-cache' });
        res.end(buf);
      });
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    };
    // allow the embeds to be framed only from same origin; the app itself needs
    // to be frameable by the sandbox preview proxy, so no X-Frame-Options here.
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  // A dropped socket must never crash the process: without these listeners a
  // client vanishing mid-response raises an unhandled 'error' event.
  req.on('error', () => {});
  res.on('error', () => {});

  // CORS for local tooling / curl from other origins
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('referrer-policy', 'strict-origin-when-cross-origin');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  try {
    if (req.url.startsWith('/api/')) {
      const handled = await api(req, res);
      // Guard on headersSent: the API may have already responded even when it
      // reports the route as unhandled — writing twice kills the process.
      if (!handled && !res.headersSent && !res.writableEnded) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":"not found"}');
      }
      return;
    }
    serveStatic(req, res);
  } catch (e) {
    console.error('[server] request failed:', req.method, req.url, '-', e.message);
    try {
      if (!res.headersSent && !res.writableEnded) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"internal error"}');
      } else if (!res.writableEnded) {
        res.end();
      }
    } catch { /* socket already gone */ }
  }
});

// Malformed requests (bad headers, TLS noise from scanners) are normal on the
// public internet and must not be fatal.
server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

server.listen(PORT, HOST, () => {
  const total = store.count();
  const tt = store.allVideos().filter((v) => v.platform === 'tiktok').length;
  const fb = total - tt;
  console.log(`ReelBlend running -> http://${HOST}:${PORT}`);
  console.log(`catalog: ${total} videos (${tt} tiktok / ${fb} facebook) · seeded ${boot.seeded} new`);
  console.log(`policy : embed-first — TikTok player v1 + Facebook video plugin; nothing is downloaded or re-hosted.`);
  // When running inside a hosted sandbox that exposes preview ports, print the
  // address a browser can actually reach, so the URL is always in the logs.
  const sbx = process.env.E2B_SANDBOX_ID;
  if (sbx) console.log(`public : https://${PORT}-${sbx}.e2b.app   (open via the preview panel; the host is token-gated)`);
  else console.log(`public : http://localhost:${PORT}`);
});

// A public service should survive a single unexpected error. Log loudly, keep
// serving, but bail out if errors start cascading so a supervisor can restart us.
let recentErrors = [];
function noteFatal(kind, err) {
  const now2 = Date.now();
  recentErrors = recentErrors.filter((t) => now2 - t < 60_000);
  recentErrors.push(now2);
  console.error(`[${kind}]`, err && err.stack ? err.stack : err);
  if (recentErrors.length > 20) {
    console.error('[fatal] error cascade — exiting so the supervisor can restart');
    try { store.flush(); } catch {}
    process.exit(1);
  }
}
process.on('uncaughtException', (err) => noteFatal('uncaughtException', err));
process.on('unhandledRejection', (err) => noteFatal('unhandledRejection', err));

// flush pending writes before exiting
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { store.flush(); } catch {}
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 800);
  });
}

module.exports = { server, store };
