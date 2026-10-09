'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { boot } = require('./helpers');

const completed = (init, over = {}) => ({ event: 'transaction.completed', reference: init.reference, status: 'SUCCESS', amount: 300, currency: 'GHS', metadata: { site: 'PREDICT_VIRTUALS', transactionId: [...over.__store.payments.keys()][0], userId: 'u1', purpose: 'TOKEN_PURCHASE', plan: 'gold' }, ...over.patch });
const hook = (h, init, patch = {}) => h.webhook(completed(init, { __store: h.store, patch }));

test('opening a checkout needs a signed-in user, a real plan, and the price comes from the server', async t => {
  const h = await boot(t);
  assert.equal((await h.request('/api/deposit/initialize', { method: 'POST', body: { plan: 'gold' } })).status, 401);
  assert.equal((await h.buy('gold', 'forged')).status, 401);
  assert.equal((await h.buy('mythic')).status, 400);

  // A client-supplied amount/tokens is ignored: the hub is asked for the plan's real price.
  const res = await h.request('/api/deposit/initialize', { method: 'POST', body: { plan: 'gold', amount: 1, tokens: 999999 }, headers: { authorization: 'Bearer token-u1' } });
  assert.equal(res.status, 201);
  assert.match(res.data.checkoutUrl, /^https:\/\/checkout\.hub\.test\//);
  const call = h.hubServer.state.initCalls[0];
  assert.equal(call.amount, 300); assert.equal(call.currency, 'GHS'); assert.equal(call.email, 'u1@example.com');
  assert.equal(call.redirectUrl, 'https://pv.test/api/payment/return');
  assert.equal(call.metadata.purpose, 'TOKEN_PURCHASE'); assert.equal(call.metadata.userId, 'u1');
  assert.equal(h.hubServer.state.badAuth, 0, 'every hub call carried a valid x-api-key + HMAC signature');
  assert.equal(h.store.users.u1.tokenBalance, 50, 'nothing credited before payment');
});

test('a signed webhook credits the plan tokens exactly once, however often it is delivered', async t => {
  const h = await boot(t);
  const init = (await h.buy('gold')).data;
  assert.equal((await h.webhook({ event: 'transaction.completed', reference: init.reference, status: 'SUCCESS', amount: 300, currency: 'GHS' }, { sign: false })).status, 401, 'bad signature rejected');
  assert.equal(h.store.users.u1.tokenBalance, 50);

  assert.equal((await hook(h, init)).status, 200);
  assert.equal(h.store.users.u1.tokenBalance, 1050, '50 + 1,000 Gold tokens');
  await hook(h, init); await hook(h, init);
  assert.equal(h.store.users.u1.tokenBalance, 1050, 'replayed webhooks never double-credit');

  // The customer's browser also comes back: still no double credit.
  h.hubServer.state.verifyResult = () => ({ status: 'SUCCESS', amount: 300, currency: 'GHS' });
  const back = await h.request(`/api/payment/return?reference=${init.reference}`);
  assert.equal(back.status, 302);
  assert.match(back.location, /^https:\/\/pv\.test\/deposit\?reference=HUBREF_1&plan=gold&payment=success$/);
  assert.equal(h.store.users.u1.tokenBalance, 1050);
});

test('the return redirect verifies with the hub and credits when the webhook has not arrived', async t => {
  const h = await boot(t);
  const init = (await h.buy('platinum')).data;
  h.hubServer.state.verifyResult = () => ({ status: 'SUCCESS', amount: 500, currency: 'GHS' });
  const back = await h.request(`/api/payment/return?reference=${init.reference}`);
  assert.match(back.location, /payment=success/);
  assert.equal(h.store.users.u1.tokenBalance, 2050);
  // The polling endpoint agrees and is idempotent.
  const again = await h.request(`/api/deposit/${init.reference}/complete`, { method: 'POST' });
  assert.equal(again.status, 200); assert.equal(again.data.status, 'SUCCESS');
  assert.equal(h.store.users.u1.tokenBalance, 2050);
});

test('a payment that is still processing keeps the customer waiting and credits nothing', async t => {
  const h = await boot(t);
  const init = (await h.buy('gold')).data;
  h.hubServer.state.verifyResult = () => ({ status: 'PENDING', amount: 300, currency: 'GHS' });
  const poll = await h.request(`/api/deposit/${init.reference}/complete`, { method: 'POST' });
  assert.equal(poll.status, 202);
  assert.match(poll.data.redirect, /payment=pending/);
  assert.equal(h.store.users.u1.tokenBalance, 50);
});

test('wrong amount, wrong currency, failed payments and tampered metadata never credit tokens', async t => {
  const h = await boot(t);
  const init = (await h.buy('diamond')).data; // GHS 1000
  const base = { amount: 1000, currency: 'GHS' };

  h.hubServer.state.verifyResult = () => ({ status: 'SUCCESS', amount: 300, currency: 'GHS' }); // paid for a cheaper plan
  const short = await h.request(`/api/payment/return?reference=${init.reference}`);
  assert.match(short.location, /payment=review/);
  assert.equal(h.store.users.u1.tokenBalance, 50);

  const h2 = await boot(t);
  const i2 = (await h2.buy('diamond')).data;
  await hook(h2, i2, { amount: 1000, currency: 'USD' });
  assert.equal(h2.store.users.u1.tokenBalance, 50, 'currency mismatch');

  const h3 = await boot(t);
  const i3 = (await h3.buy('diamond')).data;
  await hook(h3, i3, { ...base, status: 'FAILED' });
  assert.equal(h3.store.users.u1.tokenBalance, 50, 'failed payment');
  assert.equal([...h3.store.payments.values()][0].status, 'FAILED');

  const h4 = await boot(t);
  const i4 = (await h4.buy('diamond')).data;
  const r = await hook(h4, i4, { ...base, metadata: { ...completed(i4, { __store: h4.store, patch: {} }).metadata, userId: 'someone-else' } });
  assert.equal(r.data.mismatched, true);
  assert.equal(h4.store.users.u1.tokenBalance, 50, 'metadata for a different user');
});

test('a payment for a user with no profile is flagged for review instead of vanishing', async t => {
  const h = await boot(t, { users: {} });
  const init = (await h.buy('gold')).data;
  const r = await hook(h, init, { amount: 300 });
  assert.equal(r.data.status, 'PAID_UNFULFILLED');
  assert.equal([...h.store.payments.values()][0].status, 'PAID_UNFULFILLED');
});

test('unknown references and bad input are handled safely', async t => {
  const h = await boot(t);
  assert.equal((await h.request('/api/payment/return?reference=nope_nope')).location, 'https://pv.test/deposit?payment=error');
  assert.equal((await h.request('/api/payment/return?reference=%3Cscript%3E')).location, 'https://pv.test/deposit?payment=error');
  assert.equal((await h.request('/api/deposit/NOPE_NOPE/complete', { method: 'POST' })).status, 404);
  const ignored = await h.webhook({ event: 'something.else' });
  assert.equal(ignored.data.ignored, true);
});

test('the site is served: clean URLs work, the deposit page exists, traversal is blocked', async t => {
  const h = await boot(t);
  assert.match((await h.request('/')).text, /Predict Virtuals/);
  assert.match((await h.request('/plans')).text, /Buy tokens/);
  const dep = await h.request('/deposit?plan=gold');
  assert.equal(dep.status, 200); assert.match(dep.text, /\/api\/deposit\/initialize/);
  assert.equal((await h.request('/_next/static/immutable/chunks/2icj1zm6f1b3c.css')).status, 200);
  assert.notEqual((await h.request('/..%2f..%2fserver.js')).status, 200);
  assert.equal((await h.request('/server.js')).status, 404);
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
});
