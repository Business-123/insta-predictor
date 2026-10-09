'use strict';
// Token purchases through the Payment Hub. Framework-agnostic: it only needs a `hub`
// client (lib/hub.js) and a `store` (lib/firebase.js in production, an in-memory one in tests).
//
// Money rules:
//  - The plan table below is the ONLY source of price/tokens. The browser sends a plan slug,
//    never an amount.
//  - Tokens are credited only after the hub confirms SUCCESS for exactly the expected amount
//    and currency, and at most once per payment (store.creditPayment is atomic + idempotent),
//    no matter how many times the webhook / return redirect / polling race each other.
const crypto = require('node:crypto');

const PLANS = Object.freeze({
  gold: { slug: 'gold', tier: 'Gold', price: 300, tokens: 1000 },
  platinum: { slug: 'platinum', tier: 'Platinum', price: 500, tokens: 2000 },
  diamond: { slug: 'diamond', tier: 'Diamond', price: 1000, tokens: 5000 },
});

function newTransactionId() { return `PVT_${Date.now().toString(36).toUpperCase()}_${crypto.randomBytes(5).toString('hex').toUpperCase()}`; }
const PENDING_STATES = ['PENDING', 'PAYMENT_INITIALIZED'];

function createPayments({ hub, store, currency = 'GHS', sessionMs = 15 * 60 * 1000, siteName = 'PREDICT_VIRTUALS', now = () => Date.now() }) {
  const toMinor = amount => Math.round(Number(amount) * 100);

  // Opens a hub checkout for one plan. `user` is the already-verified { uid, email }.
  async function initialize({ user, planSlug, returnOrigin }) {
    const plan = PLANS[String(planSlug || '').toLowerCase()];
    if (!plan) return [400, { error: 'Choose a valid plan.' }];
    if (!hub.configured) return [503, { error: 'Payments are not configured.' }];
    if (!returnOrigin) return [400, { error: 'Missing return address.' }];
    const transactionId = newTransactionId();
    const createdAt = now();
    const payment = {
      id: transactionId, userId: user.uid, email: user.email || '', planSlug: plan.slug, tier: plan.tier,
      amount: plan.price, amountMinor: toMinor(plan.price), currency, tokens: plan.tokens,
      status: 'PENDING', hubReference: null, checkoutUrl: null, returnOrigin,
      createdAt, updatedAt: createdAt, expiresAt: createdAt + sessionMs, creditedAt: null,
    };
    await store.createPayment(payment);
    try {
      const result = await hub.initialize({
        email: user.email || `${user.uid}@users.predictvirtuals.com`, amount: plan.price, currency,
        redirectUrl: `${returnOrigin}/api/payment/return`,
        metadata: { site: siteName, transactionId, userId: user.uid, purpose: 'TOKEN_PURCHASE', plan: plan.slug },
      });
      await store.updatePayment(transactionId, { status: 'PAYMENT_INITIALIZED', hubReference: result.reference, checkoutUrl: result.checkoutUrl, updatedAt: now() });
      return [201, { reference: result.reference, checkoutUrl: result.checkoutUrl, plan: { slug: plan.slug, tier: plan.tier, price: plan.price, tokens: plan.tokens } }];
    } catch (error) {
      await store.updatePayment(transactionId, { status: 'FAILED', updatedAt: now() });
      return [502, { error: `Payment initialization failed: ${error.message}` }];
    }
  }

  // Applies a confirmed hub result to a stored payment. Never trusts the browser.
  async function settle(payment, hubResult) {
    if (payment.creditedAt) return 'SUCCESS'; // already credited: nothing later may change that
    if (Math.round(Number(hubResult.amount) * 100) !== payment.amountMinor || String(hubResult.currency) !== payment.currency) {
      await store.updatePayment(payment.id, { status: 'MISMATCH', updatedAt: now() });
      return 'MISMATCH';
    }
    if (hubResult.status === 'SUCCESS') {
      const outcome = await store.creditPayment(payment.id, now()); // 'CREDITED' | 'ALREADY_CREDITED' | 'NO_PROFILE'
      return outcome === 'NO_PROFILE' ? 'PAID_UNFULFILLED' : 'SUCCESS';
    }
    if (['FAILED', 'ABANDONED'].includes(hubResult.status) && PENDING_STATES.includes(payment.status)) {
      await store.updatePayment(payment.id, { status: 'FAILED', updatedAt: now() });
      return 'FAILED';
    }
    return payment.status;
  }

  // Reconciles directly against the hub by reference, then says where the browser goes next.
  async function reconcile(hubReference) {
    const payment = await store.findByHubReference(hubReference);
    if (!payment) return [404, { error: 'Payment session was not found.' }];
    let status = payment.status;
    if (PENDING_STATES.includes(status)) {
      const verified = await hub.verify(hubReference);
      status = await settle(payment, verified);
      if (PENDING_STATES.includes(status) && payment.expiresAt <= now()) {
        await store.updatePayment(payment.id, { status: 'EXPIRED', updatedAt: now() });
        status = 'EXPIRED';
      }
    }
    const base = `${payment.returnOrigin}/deposit?reference=${encodeURIComponent(hubReference)}&plan=${encodeURIComponent(payment.planSlug)}`;
    if (status === 'SUCCESS') return [200, { status, redirect: `${base}&payment=success` }];
    if (['FAILED', 'EXPIRED'].includes(status)) return [200, { status, redirect: `${base}&payment=${status.toLowerCase()}` }];
    if (['MISMATCH', 'PAID_UNFULFILLED'].includes(status)) return [200, { status, redirect: `${base}&payment=review` }];
    return [202, { status, message: 'Payment is still being confirmed. Please wait a moment.', redirect: `${base}&payment=pending` }];
  }

  // Signed webhook from the hub: the credit path that does not depend on the browser returning.
  async function handleWebhook(event) {
    if (event.event !== 'transaction.completed') return [200, { ok: true, ignored: true }];
    const reference = String(event.reference || '');
    const transactionId = String(event.metadata?.transactionId || '');
    const payment = transactionId ? await store.getPayment(transactionId) : await store.findByHubReference(reference);
    if (!payment || payment.hubReference !== reference) return [200, { ok: true, unmatched: true }];
    const matches = event.metadata?.purpose === 'TOKEN_PURCHASE' && event.metadata?.userId === payment.userId;
    if (!matches) { console.error('[hub:webhook] event metadata did not match payment', reference); return [200, { ok: true, mismatched: true }]; }
    const status = event.status === 'SUCCESS' ? 'SUCCESS' : 'FAILED';
    const result = await settle(payment, { status, amount: event.amount, currency: event.currency });
    return [200, { ok: true, status: result }];
  }

  return { initialize, reconcile, handleWebhook, plans: PLANS };
}

module.exports = { createPayments, PLANS };
