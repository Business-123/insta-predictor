'use strict';
// Predict Virtuals: serves the site, runs its own accounts, and handles Payment Hub token purchases.
// Data lives in one local JSON file (see lib/store.js), the same approach as the Phantom Cards site.
//
//   POST /api/auth/signup | /api/auth/login | /api/auth/logout     cookie sessions
//   GET  /api/auth/me                                              current user + token balance
//   GET  /api/config                                               public settings (support link)
//   POST /api/deposit/initialize      (signed in) { plan }  -> { checkoutUrl }
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
const { createStore } = require('./lib/store');
const auth = require('./lib/auth');

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

// Pages only load their own scripts, styles and fonts, and only talk to this server.
const PAGE_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'self'";

function createApp({ hub, store, siteDir = path.join(__dirname, 'www.predictvirtuals.com'), appBaseUrl = '', currency = 'GHS', supportUrl = '', now = Date.now }) {
  const payments = createPayments({ hub, store, currency, now });
  const originOf = req => {
    if (appBaseUrl) return appBaseUrl.replace(/\/+$/, '');
    const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    return `${proto}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  };
  const isSecure = req => originOf(req).startsWith('https:');
  const clientIp = req => String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  // Browsers attach Origin to cross-site POSTs; refuse any that is not this site.
  const sameOrigin = req => {
    const origin = req.headers.origin; if (!origin) return true;
    try { const host = new URL(origin).host; return host === (req.headers['x-forwarded-host'] || req.headers.host) || (appBaseUrl && host === new URL(appBaseUrl).host); } catch { return false; }
  };
  const json = (res, status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(JSON.stringify(data)); };
  const readRaw = async req => { const chunks = []; let size = 0; for await (const c of req) { size += c.length; if (size > 64 * 1024) throw new Error('Body too large'); chunks.push(c); } return Buffer.concat(chunks); };
  const readJson = async req => {
    if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) { const e = new Error('Unsupported content type.'); e.status = 415; throw e; }
    const text = (await readRaw(req)).toString();
    try { const v = JSON.parse(text || '{}'); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* fall through */ }
    const e = new Error('Invalid request.'); e.status = 400; throw e;
  };
  const publicUser = u => ({ id: u.id, name: u.name, email: u.email, username: u.username, tokenBalance: u.tokenBalance });
  const currentUser = req => store.userForSession(auth.sessionToken(req));

  // Light per-user throttle on opening checkouts (stops a script from spamming the hub).
  const buckets = new Map();
  const throttled = uid => {
    const t = now(); const b = buckets.get(uid) || { n: 0, reset: t + 10 * 60 * 1000 };
    if (b.reset <= t) { b.n = 0; b.reset = t + 10 * 60 * 1000; }
    b.n += 1; buckets.set(uid, b); return b.n > 10;
  };
  const loginLimiter = auth.createLimiter({ limit: 8, windowMs: 15 * 60 * 1000, now });
  const signupLimiter = auth.createLimiter({ limit: 10, windowMs: 60 * 60 * 1000, now });

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || rel === '/index' || rel === '/index.html') rel = '/login.html'; // no landing page: the site opens on sign-in
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
        ...(ext === '.html' ? { 'content-security-policy': PAGE_CSP, 'referrer-policy': 'same-origin' } : {}),
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
      if (req.method === 'GET' && pathname === '/api/config') return json(res, 200, { supportUrl: /^https?:\/\//i.test(supportUrl) ? supportUrl : '' });

      // ---- Accounts -------------------------------------------------------------------
      if (req.method === 'GET' && pathname === '/api/auth/me') {
        const user = await currentUser(req);
        return json(res, 200, { user: user ? publicUser(user) : null });
      }
      if (req.method === 'POST' && pathname.startsWith('/api/auth/')) {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Request blocked.' });
        const secure = isSecure(req);

        if (pathname === '/api/auth/signup') {
          const ip = clientIp(req);
          if (signupLimiter.hit(ip)) return json(res, 429, { error: 'Too many sign-ups from this connection. Please try again later.' });
          const checked = auth.validateSignup(await readJson(req));
          if (checked.error) return json(res, 400, { error: checked.error });
          const { password, ...profile } = checked.value;
          let user;
          try { user = await store.createUser({ ...profile, passwordHash: await auth.hashPassword(password) }); }
          catch (error) { if (error.code === 'EMAIL_TAKEN') return json(res, 409, { error: 'An account with this email already exists.' }); throw error; }
          const token = await store.createSession(user.id, auth.REMEMBER_MS);
          return json(res, 201, { user: publicUser(user) }, { 'set-cookie': auth.sessionCookie(token, { secure, maxAgeMs: auth.REMEMBER_MS }) });
        }

        if (pathname === '/api/auth/login') {
          const p = await readJson(req);
          const email = String(p.email || '').trim().toLowerCase(); const password = String(p.password ?? '');
          const key = `${clientIp(req)}|${email}`;
          if (loginLimiter.hit(key)) return json(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
          const user = email ? await store.findUserByEmail(email) : null;
          if (!user) { await auth.burnTime(password); return json(res, 401, { error: 'Incorrect email or password.' }); }
          if (!await auth.verifyPassword(password, user.passwordHash)) return json(res, 401, { error: 'Incorrect email or password.' });
          if (user.banned) return json(res, 403, { error: 'This account has been suspended. Contact support if you think this is a mistake.' });
          loginLimiter.clear(key);
          const remember = p.remember === true;
          const ttl = remember ? auth.REMEMBER_MS : auth.SESSION_MS;
          const token = await store.createSession(user.id, ttl);
          return json(res, 200, { user: publicUser(user) }, { 'set-cookie': auth.sessionCookie(token, { secure, maxAgeMs: remember ? ttl : 0 }) });
        }

        if (pathname === '/api/auth/logout') {
          await store.deleteSession(auth.sessionToken(req));
          return json(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie({ secure }) });
        }
        return json(res, 404, { error: 'Not found.' });
      }

      // ---- Token purchases ------------------------------------------------------------
      if (req.method === 'POST' && pathname === '/api/deposit/initialize') {
        if (!sameOrigin(req)) return json(res, 403, { error: 'Request blocked.' });
        const user = await currentUser(req);
        if (!user) return json(res, 401, { error: 'Please sign in to buy tokens.' });
        if (throttled(user.id)) return json(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
        const p = await readJson(req);
        // Where the customer's browser comes back to. Our own origin only; never a client-chosen host.
        const [status, body] = await payments.initialize({ user: { uid: user.id, email: user.email }, planSlug: p.plan, returnOrigin: originOf(req) });
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
      if (error.status && error.status < 500) return json(res, error.status, { error: error.message });
      console.error('[server:error]', pathname, error);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Please try again.' });
    }
  };
}

if (require.main === module) {
  loadEnvFile();
  const production = process.env.NODE_ENV === 'production' || Boolean(process.env.RAILWAY_ENVIRONMENT);
  const dataFile = process.env.DATA_FILE || path.join(__dirname, 'data', 'predict-virtuals.json');
  const store = createStore({ file: dataFile });
  console.log(`Data file: ${dataFile}`);
  if (production && !process.env.DATA_FILE) console.warn('[env:warning] DATA_FILE is not set: accounts and payments will be lost on every redeploy. Mount a volume and set DATA_FILE=/data/predict-virtuals.json.');
  const hub = createHub({ baseUrl: process.env.HUB_BASE_URL, apiKey: process.env.HUB_API_KEY, apiSecret: process.env.HUB_API_SECRET });
  if (!hub.configured) console.warn('[env:warning] HUB_BASE_URL / HUB_API_KEY / HUB_API_SECRET are not fully set: checkout is disabled.');
  // Without APP_BASE_URL the return address is derived from request headers. Set it in production.
  const appBaseUrl = process.env.APP_BASE_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '');
  if (production && !appBaseUrl) console.warn('[env:warning] APP_BASE_URL is not set: set it to your public https address.');
  const handler = createApp({ hub, store, appBaseUrl, currency: process.env.PAYMENT_CURRENCY || 'GHS', supportUrl: process.env.SUPPORT_URL || '' });
  const port = Number(process.env.PORT || 3000);
  const server = http.createServer(handler);
  server.keepAliveTimeout = 65 * 1000; // longer than Railway's proxy idle timeout, avoids sporadic 502s
  server.headersTimeout = 70 * 1000;
  server.listen(port, '0.0.0.0', () => console.log(`Predict Virtuals listening on :${port}${appBaseUrl ? ` (${appBaseUrl})` : ''}`));
  // Railway sends SIGTERM on each redeploy: finish in-flight payments, then exit.
  process.on('SIGTERM', () => { console.log('SIGTERM: shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
}

module.exports = { createApp };
