'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { boot } = require('./helpers');

const login = (h, email, password, extra = {}) => h.request('/api/auth/login', { method: 'POST', body: { email, password, ...extra } });

test('sign-up creates an account, signs the person in, and never stores or returns the password', async t => {
  const h = await boot(t);
  const res = await h.request('/api/auth/signup', { method: 'POST', body: { name: ' Ama  Mensah ', email: 'Ama@Example.COM', username: 'ama_m', momo: '054 123 4567', password: 'secret123', confirmPassword: 'secret123', ref: 'PARTNER1' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.data.user, { id: res.data.user.id, name: 'Ama Mensah', email: 'ama@example.com', username: 'ama_m', tokenBalance: 0 });
  assert.match(res.setCookie, /^pv_session=[0-9a-f]{64}; HttpOnly; SameSite=Lax; Path=\//);
  assert.match(res.setCookie, /Max-Age=2592000/, 'sign-up keeps you signed in for 30 days');
  assert.match(res.setCookie, /Secure/, 'Secure flag on an https site');

  const me = await h.request('/api/auth/me', { cookie: res.cookie });
  assert.equal(me.data.user.email, 'ama@example.com');

  const file = fs.readFileSync(h.file, 'utf8');
  assert.doesNotMatch(file, /secret123/, 'the password is not on disk');
  assert.match(file, /"passwordHash":"scrypt\$/, 'it is stored as a salted scrypt hash');
  assert.doesNotMatch(file, new RegExp(res.cookie.split('=')[1]), 'only a hash of the session token is stored');
  assert.equal(JSON.parse(file).users[0].referredBy, 'PARTNER1');
  assert.equal(JSON.stringify(res.data).includes('passwordHash'), false);
});

test('sign-up rejects bad input and duplicate emails', async t => {
  const h = await boot(t);
  const good = { name: 'Kofi', email: 'k@example.com', momo: '0541234567', password: 'secret123', confirmPassword: 'secret123' };
  const post = body => h.request('/api/auth/signup', { method: 'POST', body: { ...good, ...body } });
  assert.equal((await post({ name: '' })).status, 400);
  assert.equal((await post({ email: 'not-an-email' })).status, 400);
  assert.equal((await post({ momo: '12' })).status, 400);
  assert.equal((await post({ username: 'bad name!' })).status, 400);
  assert.equal((await post({ password: '123', confirmPassword: '123' })).status, 400);
  assert.match((await post({ confirmPassword: 'different' })).data.error, /match/);
  assert.equal((await post({})).status, 201);
  const dup = await post({ email: 'K@EXAMPLE.com' });
  assert.equal(dup.status, 409);
  assert.match(dup.data.error, /already exists/);
});

test('sign-in works with the right password only, and a session cookie is required for protected routes', async t => {
  const h = await boot(t); const u1 = await h.signup('u1@example.com');
  assert.equal((await login(h, 'u1@example.com', 'wrong')).status, 401);
  assert.equal((await login(h, 'nobody@example.com', 'secret123')).status, 401);
  assert.equal((await login(h, 'nobody@example.com', 'secret123')).data.error, (await login(h, 'u1@example.com', 'wrong')).data.error, 'same message either way');
  const ok = await login(h, 'U1@Example.com', 'secret123');
  assert.equal(ok.status, 200);
  assert.doesNotMatch(ok.setCookie, /Max-Age/, 'without "keep me signed in" it is a browser-session cookie');
  assert.equal((await h.request('/api/auth/me')).data.user, null);
  assert.equal((await h.request('/api/auth/me', { cookie: ok.cookie })).data.user.id, u1.id);
  const kept = await login(h, 'u1@example.com', 'secret123', { remember: true });
  assert.match(kept.setCookie, /Max-Age=2592000/);
});

test('signing out ends the session on the server, not just in the browser', async t => {
  const h = await boot(t); const u1 = await h.signup();
  assert.equal((await h.request('/api/auth/me', { cookie: u1.cookie })).data.user.email, 'u1@example.com');
  const out = await h.request('/api/auth/logout', { method: 'POST', body: {}, cookie: u1.cookie });
  assert.equal(out.status, 200); assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await h.request('/api/auth/me', { cookie: u1.cookie })).data.user, null, 'the old cookie is dead');
  assert.equal((await h.buy(u1.cookie)).status, 401);
});

test('accounts and sessions survive a server restart (they live in the data file)', async t => {
  const first = await boot(t);
  const u1 = await first.signup('keep@example.com');
  const second = await boot(t, { dir: first.dataDir });
  const me = await second.request('/api/auth/me', { cookie: u1.cookie });
  assert.equal(me.data.user.email, 'keep@example.com');
  assert.equal((await login(second, 'keep@example.com', 'secret123')).status, 200);
  fs.rmSync(first.dataDir, { recursive: true, force: true });
});

test('a suspended account cannot sign in and an existing session stops working', async t => {
  const h = await boot(t); const u1 = await h.signup();
  const data = JSON.parse(fs.readFileSync(h.file, 'utf8')); data.users[0].banned = true; fs.writeFileSync(h.file, JSON.stringify(data));
  const restarted = await boot(t, { dir: h.dataDir });
  const res = await login(restarted, 'u1@example.com', 'secret123');
  assert.equal(res.status, 403); assert.match(res.data.error, /suspended/);
  assert.equal((await restarted.request('/api/auth/me', { cookie: u1.cookie })).data.user, null);
  fs.rmSync(h.dataDir, { recursive: true, force: true });
});

test('guessing passwords is rate-limited per address and email', async t => {
  const h = await boot(t); await h.signup();
  for (let i = 0; i < 8; i++) assert.equal((await login(h, 'u1@example.com', `guess${i}`)).status, 401);
  assert.equal((await login(h, 'u1@example.com', 'secret123')).status, 429, 'even the right password is refused while locked out');
  assert.equal((await login(h, 'other@example.com', 'x')).status, 401, 'other emails are unaffected');
});

test('cross-site and non-JSON posts are refused, and the cookie is not Secure on plain http', async t => {
  const h = await boot(t, { appBaseUrl: '' });
  const evil = await h.request('/api/auth/signup', { method: 'POST', body: { name: 'x' }, headers: { origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  const form = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
  assert.equal(form.status, 415);
  const u1 = await h.signup();
  assert.equal(u1.cookie.startsWith('pv_session='), true);
  const res = await h.request('/api/auth/login', { method: 'POST', body: { email: 'u1@example.com', password: 'secret123' }, headers: { origin: h.base } });
  assert.equal(res.status, 200); assert.doesNotMatch(res.setCookie, /Secure/);
});

test('the support link is only exposed when it is a real web address', async t => {
  assert.equal((await (await boot(t)).request('/api/config')).data.supportUrl, '');
  assert.equal((await (await boot(t, { supportUrl: 'https://wa.me/233500000000' })).request('/api/config')).data.supportUrl, 'https://wa.me/233500000000');
  assert.equal((await (await boot(t, { supportUrl: 'javascript:alert(1)' })).request('/api/config')).data.supportUrl, '');
});
