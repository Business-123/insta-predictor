'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { createHub, hubSignature } = require('../lib/hub');
const { createApp } = require('../server');

const SECRET = 'test-hub-secret';
const KEY = 'test-hub-key';

// In-memory stand-in for lib/firebase.js with the same atomic/idempotent credit semantics.
function memoryStore(users = {}) {
  const payments = new Map();
  return {
    users, payments,
    async createPayment(p) { payments.set(p.id, { ...p }); },
    async getPayment(id) { return payments.has(id) ? { ...payments.get(id) } : null; },
    async findByHubReference(ref) { for (const p of payments.values()) if (p.hubReference === ref) return { ...p }; return null; },
    async updatePayment(id, patch) { Object.assign(payments.get(id), patch); },
    async creditPayment(id, at) {
      const p = payments.get(id);
      if (p.creditedAt) return 'ALREADY_CREDITED';
      const u = users[p.userId];
      if (!u) { Object.assign(p, { status: 'PAID_UNFULFILLED', updatedAt: at }); return 'NO_PROFILE'; }
      u.tokenBalance += p.tokens; Object.assign(p, { status: 'SUCCESS', creditedAt: at, updatedAt: at });
      return 'CREDITED';
    },
  };
}

// A tiny fake Payment Hub that enforces the real auth contract (x-api-key + HMAC x-signature).
async function fakeHub() {
  const state = { initCalls: [], verifyResult: null, badAuth: 0, seq: 0 };
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString();
    const ok = req.headers['x-api-key'] === KEY && req.headers['x-signature'] === hubSignature(SECRET, raw);
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (!ok) { state.badAuth++; return send(401, { status: false, message: 'bad signature' }); }
    if (req.method === 'POST' && req.url === '/api/v1/transaction/initialize') {
      const body = JSON.parse(raw); state.initCalls.push(body);
      const reference = `HUBREF_${++state.seq}`;
      return send(201, { status: true, data: { reference, checkoutUrl: `https://checkout.hub.test/${reference}` } });
    }
    const m = /^\/api\/v1\/transaction\/verify\/(.+)$/.exec(req.url);
    if (req.method === 'GET' && m) return send(200, { status: true, data: state.verifyResult(decodeURIComponent(m[1])) });
    send(404, { status: false, message: 'nope' });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { state, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(r => server.close(r)) };
}

async function boot(t, { users = { u1: { tokenBalance: 50 } } } = {}) {
  const hubServer = await fakeHub();
  const store = memoryStore(users);
  const hub = createHub({ baseUrl: hubServer.url, apiKey: KEY, apiSecret: SECRET });
  const verifyIdToken = async token => { if (token === 'token-u1') return { uid: 'u1', email: 'u1@example.com' }; if (token === 'token-u2') return { uid: 'u2', email: 'u2@example.com' }; throw new Error('bad token'); };
  const handler = createApp({ hub, store, verifyIdToken, appBaseUrl: 'https://pv.test' });
  const app = http.createServer(handler);
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => app.close(r)); await hubServer.close(); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (path, { method = 'GET', body, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch {}
    return { status: res.status, data, text, location: res.headers.get('location') };
  };
  const buy = (plan = 'gold', token = 'token-u1') => request('/api/deposit/initialize', { method: 'POST', body: { plan }, headers: { authorization: `Bearer ${token}` } });
  // A webhook exactly as the hub signs it.
  const webhook = (event, { sign = true } = {}) => {
    const raw = JSON.stringify(event);
    return request('/api/webhooks/hub', { method: 'POST', raw, headers: sign ? { 'x-hub-signature': hubSignature(SECRET, raw) } : { 'x-hub-signature': 'deadbeef' } });
  };
  return { base, request, buy, webhook, store, hubServer };
}

module.exports = { boot, SECRET, KEY, crypto };
