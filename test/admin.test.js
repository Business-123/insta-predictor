'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

const PIN = '48271936';
const post = (h, path, cookie, body, headers) => h.request(path, { method: 'POST', body, cookie, headers });
const adminLogin = (h, pin = PIN) => post(h, '/api/admin/login', undefined, { pin });

// A site with the PIN set, one customer, and an admin who has already entered the PIN.
async function withAdmin(t) {
  const h = await boot(t, { adminPin: PIN });
  const user = await h.signup('ama@example.com', { name: 'Ama Mensah' });
  const login = await adminLogin(h);
  assert.equal(login.status, 200);
  return { h, user, admin: { cookie: login.cookie } };
}

test('the admin page is served at /admin and is not indexable', async t => {
  const h = await boot(t, { adminPin: PIN });
  const res = await h.request('/admin');
  assert.equal(res.status, 200);
  assert.match(res.text, /noindex/);
  assert.equal((await h.request('/admin.js')).status, 200);
});

test('the right PIN signs in with a locked-down cookie; wrong or malformed PINs do not', async t => {
  const h = await boot(t, { adminPin: PIN });
  for (const pin of ['00000000', '4827193', 'abcdefgh', null]) { // 4 misses + the real sign-in stays under the 5-per-address limit
    const res = await adminLogin(h, pin);
    assert.ok(res.status === 401, `PIN ${JSON.stringify(pin)} -> ${res.status}`);
    assert.equal(res.setCookie, null);
  }
  const ok = await adminLogin(h);
  assert.equal(ok.status, 200);
  assert.match(ok.setCookie, /^pv_admin=\d+\.[0-9a-f]{64}; HttpOnly; SameSite=Strict; Path=\/api\/admin; Max-Age=28800; Secure/);
  assert.doesNotMatch(ok.setCookie, new RegExp(PIN), 'the PIN is never in the cookie');
  assert.equal((await h.request('/api/admin/me', { cookie: ok.cookie })).status, 200);
});

test('without a valid admin cookie the whole admin API is closed, even for signed-in customers', async t => {
  const { h, user } = await withAdmin(t);
  const forged = `pv_admin=${Date.now() + 60000}.${'a'.repeat(64)}`;
  for (const path of ['/api/admin/me', '/api/admin/stats', '/api/admin/users', '/api/admin/payments', '/api/admin/audit']) {
    assert.equal((await h.request(path)).status, 401, path);
    assert.equal((await h.request(path, { cookie: user.cookie })).status, 401, `${path} with a customer session`);
    assert.equal((await h.request(path, { cookie: forged })).status, 401, `${path} with a forged cookie`);
  }
  assert.equal((await post(h, `/api/admin/users/${user.id}/tokens`, user.cookie, { amount: 99999, reason: 'self' })).status, 401);
  assert.equal(await h.balance(user.id), 0, 'a customer cannot give themselves tokens');
});

test('the portal stays disabled until ADMIN_PIN is exactly 8 digits', async t => {
  for (const adminPin of ['', '1234', '123456789', 'abcdefgh']) {
    const h = await boot(t, { adminPin });
    const res = await adminLogin(h, adminPin || '12345678');
    assert.equal(res.status, 503, `ADMIN_PIN=${JSON.stringify(adminPin)}`);
    assert.match(res.data.error, /ADMIN_PIN/);
    const forged = `pv_admin=${Date.now() + 60000}.${'0'.repeat(64)}`;
    assert.equal((await h.request('/api/admin/me', { cookie: forged })).status, 401);
  }
});

test('PIN guessing is rate limited, and a lockout also blocks the right PIN', async t => {
  const h = await boot(t, { adminPin: PIN });
  for (let i = 0; i < 5; i++) assert.equal((await adminLogin(h, '11111111')).status, 401);
  const blocked = await adminLogin(h, PIN);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.setCookie, null);
});

test('a cookie stops working when the PIN is changed, and when it expires', async t => {
  const a = await boot(t, { adminPin: PIN });
  const cookie = (await adminLogin(a)).cookie;
  assert.equal((await a.request('/api/admin/me', { cookie })).status, 200);
  const b = await boot(t, { adminPin: '99999999' }); // same cookie, different PIN
  assert.equal((await b.request('/api/admin/me', { cookie })).status, 401);
  const expired = `pv_admin=${Date.now() - 1000}.${'0'.repeat(64)}`;
  assert.equal((await a.request('/api/admin/me', { cookie: expired })).status, 401);
});

test('signing out clears the admin cookie', async t => {
  const { h, admin } = await withAdmin(t);
  const out = await post(h, '/api/admin/logout', admin.cookie, {});
  assert.equal(out.status, 200);
  assert.match(out.setCookie, /^pv_admin=; .*Max-Age=0/);
});

test('an admin can see stats, and list and search users without password hashes', async t => {
  const { h, admin } = await withAdmin(t);
  const stats = (await h.request('/api/admin/stats', { cookie: admin.cookie })).data;
  assert.equal(stats.users.total, 1);
  const all = await h.request('/api/admin/users', { cookie: admin.cookie });
  assert.equal(all.data.total, 1);
  assert.doesNotMatch(all.text, /passwordHash|scrypt/);
  const found = await h.request('/api/admin/users?q=MENSAH', { cookie: admin.cookie });
  assert.deepEqual(found.data.users.map(u => u.email), ['ama@example.com']);
  assert.equal((await h.request('/api/admin/users?q=nobody', { cookie: admin.cookie })).data.total, 0);
});

test('adjusting tokens changes the balance, needs a reason, cannot go negative, and is logged', async t => {
  const { h, admin, user } = await withAdmin(t);
  const url = `/api/admin/users/${user.id}/tokens`;
  assert.equal((await post(h, url, admin.cookie, { amount: 500 })).status, 400, 'reason required');
  assert.equal((await post(h, url, admin.cookie, { amount: 1.5, reason: 'x' })).status, 400);
  assert.equal((await post(h, url, admin.cookie, { amount: 0, reason: 'x' })).status, 400);
  assert.equal((await post(h, url, admin.cookie, { amount: -1, reason: 'x' })).status, 400, 'cannot go below zero');
  const ok = await post(h, url, admin.cookie, { amount: 500, reason: 'Paid by MoMo, hub missed it' });
  assert.equal(ok.status, 200); assert.equal(ok.data.user.tokenBalance, 500);
  assert.equal((await post(h, url, admin.cookie, { amount: -200, reason: 'refund' })).data.user.tokenBalance, 300);
  assert.equal(await h.balance(user.id), 300);
  const log = (await h.request('/api/admin/audit', { cookie: admin.cookie })).data.entries;
  assert.equal(log.length, 2);
  assert.equal(log[0].action, 'tokens.adjust'); assert.equal(log[0].targetEmail, 'ama@example.com');
  assert.match(log[0].detail, /-200.*refund/);
});

test('suspending signs the user out at once and blocks sign-in; restoring lets them back in', async t => {
  const { h, admin, user } = await withAdmin(t);
  assert.ok((await h.request('/api/auth/me', { cookie: user.cookie })).data.user);
  const ban = await post(h, `/api/admin/users/${user.id}/ban`, admin.cookie, { banned: true });
  assert.equal(ban.data.user.banned, true);
  assert.equal((await h.request('/api/auth/me', { cookie: user.cookie })).data.user, null);
  const login = () => h.request('/api/auth/login', { method: 'POST', body: { email: 'ama@example.com', password: 'secret123' } });
  assert.equal((await login()).status, 403);
  await post(h, `/api/admin/users/${user.id}/ban`, admin.cookie, { banned: false });
  assert.equal((await login()).status, 200);
});

test('resetting a password lets the user sign in with the new one and signs out old sessions', async t => {
  const { h, admin, user } = await withAdmin(t);
  const url = `/api/admin/users/${user.id}/password`;
  assert.equal((await post(h, url, admin.cookie, { password: '123' })).status, 400);
  assert.equal((await post(h, url, admin.cookie, { password: 'brandnew1' })).status, 200);
  assert.equal((await h.request('/api/auth/me', { cookie: user.cookie })).data.user, null);
  const login = body => h.request('/api/auth/login', { method: 'POST', body });
  assert.equal((await login({ email: 'ama@example.com', password: 'secret123' })).status, 401);
  assert.equal((await login({ email: 'ama@example.com', password: 'brandnew1' })).status, 200);
  const log = (await h.request('/api/admin/audit', { cookie: admin.cookie })).data.entries;
  assert.equal(log[0].action, 'user.password_reset');
  assert.doesNotMatch(JSON.stringify(log), /brandnew1/, 'the new password is never logged');
});

test('payments list shows purchases, filters by status, and stats count them', async t => {
  const { h, admin, user } = await withAdmin(t);
  assert.equal((await h.buy(user.cookie, 'gold')).status, 201);
  const list = await h.request('/api/admin/payments', { cookie: admin.cookie });
  assert.equal(list.data.total, 1);
  assert.equal(list.data.payments[0].tier, 'Gold');
  assert.equal(list.data.payments[0].status, 'PAYMENT_INITIALIZED');
  assert.equal((await h.request('/api/admin/payments?status=SUCCESS', { cookie: admin.cookie })).data.total, 0);
  assert.equal((await h.request('/api/admin/payments?status=payment_initialized', { cookie: admin.cookie })).data.total, 1);
  const stats = (await h.request('/api/admin/stats', { cookie: admin.cookie })).data;
  assert.equal(stats.payments.pending, 1); assert.equal(stats.payments.successful, 0);
});

test('admin requests from another website are refused', async t => {
  const { h, admin, user } = await withAdmin(t);
  const evil = { origin: 'https://evil.example' };
  assert.equal((await post(h, `/api/admin/users/${user.id}/tokens`, admin.cookie, { amount: 10, reason: 'x' }, evil)).status, 403);
  assert.equal((await post(h, '/api/admin/login', undefined, { pin: PIN }, evil)).status, 403);
  assert.equal(await h.balance(user.id), 0);
});

test('unknown users give 404', async t => {
  const { h, admin } = await withAdmin(t);
  assert.equal((await post(h, '/api/admin/users/usr_nope/ban', admin.cookie, { banned: true })).status, 404);
});
