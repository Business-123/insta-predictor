'use strict';
// Payment Hub client. Same contract Phantom Cards uses:
//   - every call TO the hub carries x-api-key and x-signature (HMAC-SHA512 of the exact raw
//     JSON body, or '' for GET, keyed with the merchant api secret);
//   - every webhook FROM the hub carries x-hub-signature (HMAC-SHA512 of the raw body, keyed
//     with the same secret).
const crypto = require('node:crypto');

// The hub serves its merchant API under /api/v1. HUB_BASE_URL may be the bare origin or
// already carry the suffix; both resolve to the same base.
function hubApiBase(value) {
  const base = String(value || '').trim().replace(/\/+$/, '');
  if (!base) return '';
  return /\/api\/v1$/.test(base) ? base : `${base}/api/v1`;
}
function hubSignature(secret, raw) { return crypto.createHmac('sha512', secret).update(raw).digest('hex'); }
function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function createHub({ baseUrl, apiKey, apiSecret, timeoutMs = 10000 } = {}) {
  const base = hubApiBase(baseUrl);
  const configured = Boolean(base && apiKey && apiSecret);
  async function call(method, urlPath, payload) {
    if (!configured) throw new Error('Hub payment service is not configured.');
    const raw = method === 'GET' ? '' : JSON.stringify(payload || {});
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'x-signature': hubSignature(apiSecret, raw) },
      body: method === 'GET' ? undefined : raw,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.status) throw new Error(result.message || 'Hub request failed.');
    return result.data;
  }
  return {
    configured,
    initialize: payload => call('POST', '/transaction/initialize', payload), // -> { reference, checkoutUrl }
    verify: reference => call('GET', `/transaction/verify/${encodeURIComponent(reference)}`), // -> { status, amount, currency }
    verifyWebhookSignature(rawBody, signatureHeader) {
      if (!apiSecret || !signatureHeader) return false;
      return safeEqual(signatureHeader, hubSignature(apiSecret, rawBody));
    },
  };
}

module.exports = { createHub, hubApiBase, hubSignature, safeEqual };
