'use strict';
// Predict Virtuals: serves the static site and the Payment Hub token-purchase API.
//
//   POST /api/deposit/initialize      (Bearer Firebase ID token) { plan, returnOrigin } -> { checkoutUrl }
//   GET  /api/payment/return?reference=...      hub sends the customer's browser here after paying
//   POST /api/deposit/:reference/complete       the deposit page polls this while a payment confirms
//   POST /api/webhooks/hub                      signed server-to-server confirmation from the hub
//   GET  /api/health
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHub } = require('./lib/hub');
const { createPayments } = require('./lib/payments');

function loadEnvFile(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };

// Text assets worth compressing (Railway does not compress for you).
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest', '.txt']);

function createApp({ hub, store, verifyIdToken, siteDir = path.join(__dirname, 'www.predictvirtuals.com'), appBaseUrl = '', currency = 'GHS', now = Date.now }) {
  const payments = createPayments({ hub, store, currency, now });
  const originOf = req => {
    if (appBaseUrl) return appBaseUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  };
  const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
  const readRaw = async req => { const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new Error('Body too large'); chunks.push(c); } return Buffer.concat(chunks); };

  // Light per-user throttle on opening checkouts (stops a script from spamming the hub).
  const buckets = new Map();
  const throttled = uid => {
    const t = now(); const b = buckets.get(uid) || { n: 0, reset: t + 10 * 60 * 1000 };
    if (b.reset <= t) { b.n = 0; b.reset = t + 10 * 60 * 1000; }
    b.n += 1; buckets.set(uid, b); return b.n > 10;
  };

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/') rel = '/index.html';
    else if (!path.extname(rel)) rel = `${rel.replace(/\/+$/, '')}.html`; // /plans -> /plans.html
    const file = path.normalize(path.join(siteDir, rel));
    if (!file.startsWith(siteDir + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('Not found'); }
      const immutable = rel.startsWith('/_next/static/immutable/');
      const ext = path.extname(file);
      const gzip = COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        'x-content-type-options': 'nosniff',
        vary: 'Accept-Encoding',
        ...(gzip ? { 'content-encoding': 'gzip' } : { 'content-length': stat.size }),
      });
      if (req.method === 'HEAD') return res.end();
      const stream = fs.createReadStream(file);
      stream.on('error', () => res.destroy());
      if (gzip) stream.pipe(zlib.createGzip()).pipe(res); else stream.pipe(res);
    });
  }

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://local');
    const { pathname } = url;
    try {
      if (req.method === 'GET' && pathname === '/api/health') return json(res, 200, { ok: true, hubConfigured: hub.configured });  // Railway health check: must stay a cheap 200

      if (req.method === 'POST' && pathname === '/api/deposit/initialize') {
        const match = /^Bearer (.+)$/.exec(String(req.headers.authorization || ''));
        if (!match) return json(res, 401, { error: 'Please sign in to buy tokens.' });
        let user; try { user = await verifyIdToken(match[1]); } catch { return json(res, 401, { error: 'Your session has expired. Please sign in again.' }); }
        if (throttled(user.uid)) return json(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
        let p; try { p = JSON.parse((await readRaw(req)).toString() || '{}'); } catch { return json(res, 400, { error: 'Invalid request.' }); }
        // Where the customer's browser comes back to. Our own origin only; never a client-chosen host.
        const [status, body] = await payments.initialize({ user, planSlug: p.plan, returnOrigin: originOf(req) });
        return json(res, status, body);
      }

      if (req.method === 'GET' && pathname === '/api/payment/return') {
        const reference = String(url.searchParams.get('reference') || '');
        const origin = originOf(req);
        let destination = `${origin}/deposit?payment=error`;
        if (/^[A-Za-z0-9_-]{4,160}$/.test(reference)) {
          try { const [, result] = await payments.reconcile(reference); if (result.redirect) destination = result.redirect; }
          catch (error) { console.error('[payment:return:error]', reference, error.message || error); }
        }
        res.writeHead(302, { location: destination, 'cache-control': 'no-store' });
        return res.end();
      }

      const complete = /^\/api\/deposit\/([^/]+)\/complete$/.exec(pathname);
      if (req.method === 'POST' && complete) {
        const reference = decodeURIComponent(complete[1]);
        if (!/^[A-Za-z0-9_-]{4,160}$/.test(reference)) return json(res, 400, { error: 'Invalid reference.' });
        try { const [status, body] = await payments.reconcile(reference); return json(res, status, body); }
        catch (error) { return json(res, 502, { error: error.message || 'Payment verification failed.' }); }
      }

      if (req.method === 'POST' && pathname === '/api/webhooks/hub') {
        const raw = await readRaw(req);
        if (!hub.verifyWebhookSignature(raw, req.headers['x-hub-signature'])) return json(res, 401, { error: 'Invalid hub signature.' });
        let event; try { event = JSON.parse(raw.toString() || '{}'); } catch { return json(res, 400, { error: 'Malformed webhook payload.' }); }
        const [status, body] = await payments.handleWebhook(event);
        return json(res, status, body);
      }

      if (pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found.' });
      if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req, res, pathname);
      res.writeHead(405); res.end();
    } catch (error) {
      console.error('[server:error]', pathname, error);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  };
}

if (require.main === module) {
  loadEnvFile();
  const production = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
  const { createFirebase } = require('./lib/firebase');
  const firebase = createFirebase();
  const hub = createHub({ baseUrl: process.env.HUB_BASE_URL, apiKey: process.env.HUB_API_KEY, apiSecret: process.env.HUB_API_SECRET });
  if (!hub.configured) console.warn('[env:warning] HUB_BASE_URL / HUB_API_KEY / HUB_API_SECRET are not fully set: checkout is disabled.');
  if (production && !process.env.FIREBASE_SERVICE_ACCOUNT && !process.env.GOOGLE_APPLICATION_CREDENTIALS) console.warn('[env:warning] FIREBASE_SERVICE_ACCOUNT is not set: sign-in checks and token credits will fail.');
  // Without APP_BASE_URL the return address is derived from request headers. Set it in production.
  const appBaseUrl = process.env.APP_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  if (production && !appBaseUrl) console.warn('[env:warning] APP_BASE_URL is not set: set it to your public https address.');
  const handler = createApp({ hub, store: firebase.store, verifyIdToken: firebase.verifyIdToken, appBaseUrl, currency: process.env.PAYMENT_CURRENCY || 'GHS' });
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65 * 1000; // longer than Railway's proxy idle timeout, avoids sporadic 502s
  server.headersTimeout = 70 * 1000;
  server.listen(port, '0.0.0.0', () => console.log(`Predict Virtuals listening on :${port}${appBaseUrl ? ` (${appBaseUrl})` : ''}`));
  // Railway sends SIGTERM on each redeploy: finish in-flight payments, then exit.
  process.on('SIGTERM', () => { console.log('SIGTERM: shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
}

module.exports = { createApp };
