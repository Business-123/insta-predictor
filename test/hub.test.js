'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

const completed = (h, init, userId, patch = {}) => ({ event: 'transaction.completed', reference: init.reference, status: 'SUCCESS', amount: 300, currency: 'GHS', metadata: { site: 'PREDICT_VIRTUALS', transactionId: h.store && h.lastPaymentId(), userId, purpose: 'TOKEN_PURCHASE', plan: 'gold' }, ...patch });
// The id our server generated for the newest payment (the hub echoes it back in metadata).
const withIds = h => { h.lastPaymentId = () => JSON.parse(require('node:fs').readFileSync(h.file, 'utf8')).payments.at(-1).id; return h; };
const hook = (h, init, userId, patch = {}) => h.webhook(completed(h, init, userId, patch));
const stored = h => JSON.parse(require('node:fs').readFileSync(h.file, 'utf8')).payments;

test('opening a checkout needs a signed-in user, a real plan, and the price comes from the server', async t => {
  const h = withIds(await boot(t)); const u1 = await h.signup();
  assert.equal((await h.request('/api/deposit/initialize', { method: 'POST', body: { plan: 'gold' } })).status, 401);
  assert.equal((await h.buy('pv_session=forged')).status, 401);
  assert.equal((await h.buy(u1.cookie, 'mythic')).status, 400);

  // A client-supplied amount/tokens is ignored: the hub is asked for the plan's real price.
  const res = await h.request('/api/deposit/initialize', { method: 'POST', body: { plan: 'gold', amount: 1, tokens: 999999 }, cookie: u1.cookie });
  assert.equal(res.status, 201);
  assert.match(res.data.checkoutUrl, /^https:\/\/checkout\.hub\.test\//);
  const call = h.hubServer.state.initCalls[0];
  assert.equal(call.amount, 300); assert.equal(call.currency, 'GHS'); assert.equal(call.email, 'u1@example.com');
  assert.equal(call.redirectUrl, 'https://pv.test/api/payment/return');
  assert.equal(call.metadata.purpose, 'TOKEN_PURCHASE'); assert.equal(call.metadata.userId, u1.id);
  assert.equal(h.hubServer.state.badAuth, 0, 'every hub call carried a valid x-api-key + HMAC signature');
  assert.equal(await h.balance(u1.id), 0, 'nothing credited before payment');
});

test('a signed webhook credits the plan tokens exactly once, however often it is delivered', async t => {
  const h = withIds(await boot(t)); const u1 = await h.signup();
  const init = (await h.buy(u1.cookie, 'gold')).data;
  assert.equal((await h.webhook({ event: 'transaction.completed', reference: init.reference, status: 'SUCCESS', amount: 300, currency: 'GHS' }, { sign: false })).status, 401, 'bad signature rejected');
  assert.equal(await h.balance(u1.id), 0);

  assert.equal((await hook(h, init, u1.id)).status, 200);
  assert.equal(await h.balance(u1.id), 1000, '1,000 Gold tokens');
  await hook(h, init, u1.id); await hook(h, init, u1.id);
  assert.equal(await h.balance(u1.id), 1000, 'replayed webhooks never double-credit');

  // The customer's browser also comes back: still no double credit.
  h.hubServer.state.verifyResult = () => ({ status: 'SUCCESS', amount: 300, currency: 'GHS' });
  const back = await h.request(`/api/payment/return?reference=${init.reference}`);
  assert.equal(back.status, 302);
  assert.match(back.location, /^https:\/\/pv\.test\/deposit\?reference=HUBREF_1&plan=gold&payment=success$/);
  assert.equal(await h.balance(u1.id), 1000);
});

test('the return redirect verifies with the hub and credits when the webhook has not arrived', async t => {
  const h = await boot(t); const u1 = await h.signup();
  const init = (await h.buy(u1.cookie, 'platinum')).data;
  h.hubServer.state.verifyResult = () => ({ status: 'SUCCESS', amount: 500, currency: 'GHS' });
  const back = await h.request(`/api/payment/return?reference=${init.reference}`);
  assert.match(back.location, /payment=success/);
  assert.equal(await h.balance(u1.id), 2000);
  // The polling endpoint agrees and is idempotent.
  const again = await h.request(`/api/deposit/${init.reference}/complete`, { method: 'POST' });
  assert.equal(again.status, 200); assert.equal(again.data.status, 'SUCCESS');
  assert.equal(await h.balance(u1.id), 2000);
  // And the balance the browser sees through its own session is the same.
  assert.equal((await h.request('/api/auth/me', { cookie: u1.cookie })).data.user.tokenBalance, 2000);
});

test('a payment that is still processing keeps the customer waiting and credits nothing', async t => {
  const h = await boot(t); const u1 = await h.signup();
  const init = (await h.buy(u1.cookie, 'gold')).data;
  h.hubServer.state.verifyResult = () => ({ status: 'PENDING', amount: 300, currency: 'GHS' });
  const poll = await h.request(`/api/deposit/${init.reference}/complete`, { method: 'POST' });
  assert.equal(poll.status, 202);
  assert.match(poll.data.redirect, /payment=pending/);
  assert.equal(await h.balance(u1.id), 0);
});

test('wrong amount, wrong currency, failed payments and tampered metadata never credit tokens', async t => {
  const h = withIds(await boot(t)); const u1 = await h.signup();
  const init = (await h.buy(u1.cookie, 'diamond')).data; // GHS 1000
  const base = { amount: 1000, currency: 'GHS' };

  h.hubServer.state.verifyResult = () => ({ status: 'SUCCESS', amount: 300, currency: 'GHS' }); // paid for a cheaper plan
  const short = await h.request(`/api/payment/return?reference=${init.reference}`);
  assert.match(short.location, /payment=review/);
  assert.equal(await h.balance(u1.id), 0);

  const h2 = withIds(await boot(t)); const a2 = await h2.signup();
  const i2 = (await h2.buy(a2.cookie, 'diamond')).data;
  await hook(h2, i2, a2.id, { amount: 1000, currency: 'USD' });
  assert.equal(await h2.balance(a2.id), 0, 'currency mismatch');

  const h3 = withIds(await boot(t)); const a3 = await h3.signup();
  const i3 = (await h3.buy(a3.cookie, 'diamond')).data;
  await hook(h3, i3, a3.id, { ...base, status: 'FAILED' });
  assert.equal(await h3.balance(a3.id), 0, 'failed payment');
  assert.equal(stored(h3)[0].status, 'FAILED');

  const h4 = withIds(await boot(t)); const a4 = await h4.signup();
  const i4 = (await h4.buy(a4.cookie, 'diamond')).data;
  const r = await hook(h4, i4, 'someone-else', base);
  assert.equal(r.data.mismatched, true);
  assert.equal(await h4.balance(a4.id), 0, 'metadata for a different user');
});

test('a payment for a user that no longer exists is flagged for review instead of vanishing', async t => {
  const h = withIds(await boot(t)); const u1 = await h.signup();
  const init = (await h.buy(u1.cookie, 'gold')).data;
  const outcome = await h.store.creditPayment(stored(h)[0].id, Date.now()); // sanity: a real user is credited
  assert.equal(outcome, 'CREDITED');
  await h.store.createPayment({ id: 'ORPHAN_1', userId: 'usr_gone', tokens: 5, status: 'PENDING', hubReference: null });
  assert.equal(await h.store.creditPayment('ORPHAN_1', Date.now()), 'NO_PROFILE');
  assert.equal((await h.store.getPayment('ORPHAN_1')).status, 'PAID_UNFULFILLED');
  assert.ok(init.reference);
});

test('unknown references and bad input are handled safely', async t => {
  const h = await boot(t);
  assert.equal((await h.request('/api/payment/return?reference=nope_nope')).location, 'https://pv.test/deposit?payment=error');
  assert.equal((await h.request('/api/payment/return?reference=%3Cscript%3E')).location, 'https://pv.test/deposit?payment=error');
  assert.equal((await h.request('/api/deposit/NOPE_NOPE/complete', { method: 'POST' })).status, 404);
  const ignored = await h.webhook({ event: 'something.else' });
  assert.equal(ignored.data.ignored, true);
});

test('the site is served: it opens on sign-in, pages load without any third-party script, traversal is blocked', async t => {
  const h = await boot(t);
  for (const p of ['/', '/index.html', '/login']) assert.match((await h.request(p)).text, /Welcome back/, `${p} is the sign-in page`);
  assert.match((await h.request('/signup')).text, /Create your account/);
  assert.match((await h.request('/plans')).text, /Buy tokens/);
  const dep = await h.request('/deposit?plan=gold');
  assert.equal(dep.status, 200); assert.match(dep.text, /deposit\.js/);
  assert.match((await h.request('/deposit.js')).text, /\/api\/deposit\/initialize/);
  for (const p of ['/login', '/signup', '/plans', '/deposit']) {
    const page = (await h.request(p)).text;
    assert.doesNotMatch(page, /firebase|gstatic|googleapis/i, `${p} has no Firebase`);
    assert.doesNotMatch(page, /<script(?![^>]*\bsrc=)/i, `${p} has no inline script (CSP-safe)`);
  }
  assert.match((await h.request('/login')).headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal((await h.request('/_next/static/immutable/chunks/2icj1zm6f1b3c.css')).status, 200);
  assert.notEqual((await h.request('/..%2f..%2fserver.js')).status, 200);
  assert.equal((await h.request('/server.js')).status, 404);
  assert.equal((await h.request('/data/data.json')).status, 404, 'the data file is never served');
  assert.equal((await h.request('/api/health')).data.hubConfigured, true);
});

test('static files are gzip-compressed for browsers that accept it, with safe headers', async t => {
  const h = await boot(t);
  const css = '/_next/static/immutable/chunks/2icj1zm6f1b3c.css';
  const plain = await fetch(h.base + css, { headers: { 'accept-encoding': 'identity' } });
  const zipped = await fetch(h.base + css, { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(zipped.status, 200);
  assert.equal(zipped.headers.get('content-encoding'), 'gzip');
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal((await zipped.text()), (await plain.text()), 'decompressed bytes are identical');
  assert.equal(zipped.headers.get('x-content-type-options'), 'nosniff');
  assert.match(zipped.headers.get('cache-control'), /immutable/);
  const font = await fetch(h.base + '/_next/static/immutable/media/7d817b4c03b0c5f1-s.2jyz_zw3a8jit.woff2', { headers: { 'accept-encoding': 'gzip' } });
  assert.equal(font.headers.get('content-encoding'), null, 'already-compressed fonts are not re-compressed');
  assert.equal((await fetch(h.base + '/app.js')).headers.get('cache-control'), 'no-cache', 'our own scripts are always revalidated');
});
