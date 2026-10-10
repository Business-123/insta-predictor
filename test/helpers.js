'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createHub, hubSignature } = require('../lib/hub');
const { createStore } = require('../lib/store');
const { createApp } = require('../server');

const SECRET = 'test-hub-secret';
const KEY = 'test-hub-key';

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

// Boots the whole app against a real store in a temp folder. Pass `dir` to reuse a data folder (restart tests).
async function boot(t, { dir, appBaseUrl = 'https://pv.test', supportUrl = '' } = {}) {
  const hubServer = await fakeHub();
  const dataDir = dir || fs.mkdtempSync(path.join(os.tmpdir(), 'pv-test-'));
  const file = path.join(dataDir, 'data.json');
  const store = createStore({ file });
  const hub = createHub({ baseUrl: hubServer.url, apiKey: KEY, apiSecret: SECRET });
  const handler = createApp({ hub, store, appBaseUrl, supportUrl });
  const app = http.createServer(handler);
  await new Promise(r => app.listen(0, '127.0.0.1', r));
  t.after(async () => { await new Promise(r => app.close(r)); await hubServer.close(); if (!dir) fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${app.address().port}`;
  const request = async (urlPath, { method = 'GET', body, headers = {}, raw, cookie } = {}) => {
    const res = await fetch(base + urlPath, { method, redirect: 'manual', headers: { ...(body !== undefined || raw ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined) });
    const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch {}
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, data, text, location: res.headers.get('location'), setCookie, cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers };
  };
  // Creates an account through the real sign-up route and returns what tests need: { id, email, cookie }.
  const signup = async (email = 'u1@example.com', extra = {}) => {
    const res = await request('/api/auth/signup', { method: 'POST', body: { name: 'Test User', email, momo: '0541234567', password: 'secret123', confirmPassword: 'secret123', ...extra } });
    if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${res.text}`);
    return { id: res.data.user.id, email, cookie: res.cookie };
  };
  const balance = async id => (await store.findUserById(id))?.tokenBalance;
  const buy = (cookie, plan = 'gold') => request('/api/deposit/initialize', { method: 'POST', body: { plan }, cookie });
  // A webhook exactly as the hub signs it.
  const webhook = (event, { sign = true } = {}) => {
    const raw = JSON.stringify(event);
    return request('/api/webhooks/hub', { method: 'POST', raw, headers: { 'x-hub-signature': sign ? hubSignature(SECRET, raw) : 'deadbeef' } });
  };
  return { base, request, signup, balance, buy, webhook, store, hubServer, dataDir, file };
}

module.exports = { boot, SECRET, KEY, crypto };
