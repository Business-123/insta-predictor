// Checkout and payment-result screens for /deposit. The server owns prices and token amounts;
// the PLANS table below is display only.
(function () {
  'use strict';
  var el = PV.el;
  var PLANS = {
    gold: { tier: 'Gold', price: 300, tokens: 1000, text: 'text-amber-300' },
    platinum: { tier: 'Platinum', price: 500, tokens: 2000, text: 'text-cyan-300' },
    diamond: { tier: 'Diamond', price: 1000, tokens: 5000, text: 'text-lime-300' }
  };
  var q = new URLSearchParams(location.search);
  var planSlug = (q.get('plan') || '').toLowerCase();
  var payment = q.get('payment');
  var reference = q.get('reference') || '';
  var card = document.getElementById('pv-card');
  var title = document.getElementById('pv-title');
  var sub = document.getElementById('pv-sub');
  var balanceValue = null;

  function box() { card.textContent = ''; var b = el('div', 'rounded-3xl border border-zinc-800 bg-zinc-950/60 p-6 text-center'); card.appendChild(b); return b; }
  function linkBtn(href, label, primary) {
    var a = el('a', primary
      ? 'mt-6 block rounded-full bg-linear-to-r from-lime-400 to-emerald-500 px-4 py-3 text-center text-sm font-semibold text-black'
      : 'mt-3 block rounded-xl border border-zinc-800 px-4 py-3 text-center text-sm font-semibold text-white hover:border-lime-500/40 hover:bg-white/5', label);
    a.href = href; return a;
  }
  function refreshBalance() {
    PV.me().then(function (u) { if (balanceValue) balanceValue.textContent = u ? PV.tokens(u.tokenBalance) : 'unavailable'; });
  }
  function balanceLine(parent) {
    var line = el('p', 'mt-4 font-mono text-sm text-zinc-400', 'Your balance: ');
    balanceValue = el('span', 'text-lime-300', '…'); line.appendChild(balanceValue); parent.appendChild(line);
    refreshBalance();
  }

  // ---- Result screens (customer is back from the hub) --------------------------------
  function showResult() {
    var b = box();
    var copy = {
      success: ['Payment received', 'Your tokens have been added.', 'text-lime-300'],
      pending: ['Confirming payment…', 'This usually takes a few seconds. Please keep this page open.', 'text-amber-300'],
      failed: ['Payment failed', 'You were not charged. You can try again whenever you like.', 'text-red-400'],
      expired: ['Payment expired', 'That checkout timed out. Start again to buy tokens.', 'text-red-400'],
      review: ['Payment under review', 'We received your payment but need to check it. Contact support and we will sort it out quickly.', 'text-amber-300'],
      error: ['Something went wrong', 'We could not confirm this payment. If you were charged, contact support with your payment reference.', 'text-red-400']
    };
    var c = copy[payment] || copy.error;
    title.textContent = c[0]; sub.textContent = c[1];
    var plan = PLANS[planSlug];
    if (plan) b.appendChild(el('p', 'font-mono text-xs font-bold tracking-widest uppercase ' + plan.text, plan.tier + ' · ' + plan.tokens.toLocaleString() + ' tokens'));
    if (reference) b.appendChild(el('p', 'mt-2 break-all font-mono text-xs text-zinc-500', 'Reference: ' + reference));
    if (payment === 'success' || payment === 'pending') balanceLine(b);
    if (payment === 'success') b.appendChild(linkBtn('/predict', 'Start predicting', true));
    else if (payment !== 'pending') b.appendChild(linkBtn('/plans', 'Back to plans', true));
    if (payment === 'pending' && reference) poll(b);
  }
  function poll(b) {
    var tries = 0;
    (function tick() {
      fetch('/api/deposit/' + encodeURIComponent(reference) + '/complete', { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (r) {
          var next = r.d && r.d.redirect && new URL(r.d.redirect, location.href).searchParams.get('payment');
          if (next && next !== 'pending') { var u = new URL(location.href); u.searchParams.set('payment', next); location.replace(u.toString()); return; }
          if (++tries < 40) setTimeout(tick, 3000); else b.appendChild(el('p', 'mt-4 text-sm text-amber-300', 'Still confirming. You can close this page; your tokens will be added automatically once the payment clears.'));
        })
        .catch(function () { if (++tries < 40) setTimeout(tick, 3000); });
    })();
  }

  // ---- Checkout screen ---------------------------------------------------------------
  function showCheckout() {
    var plan = PLANS[planSlug];
    if (!plan) {
      title.textContent = 'Choose a plan'; sub.textContent = 'Pick a token plan to continue.';
      box().appendChild(linkBtn('/plans', 'See token plans', true)); return;
    }
    title.textContent = 'Buy ' + plan.tier + ' tokens';
    sub.textContent = 'One-time payment. No subscription, no expiry.';
    var b = box();
    b.appendChild(el('p', 'font-mono text-xs font-bold tracking-widest uppercase ' + plan.text, plan.tier));
    b.appendChild(el('div', 'mt-4 text-4xl font-extrabold text-white', 'GHS ' + plan.price));
    b.appendChild(el('p', 'mt-1 text-sm text-zinc-500', 'one-time payment'));
    b.appendChild(el('div', 'mt-6 text-lg font-bold text-white', plan.tokens.toLocaleString() + ' tokens'));
    b.appendChild(el('p', 'mt-1 font-mono text-xs text-zinc-500', 'GHS ' + (plan.price / plan.tokens).toFixed(2) + ' / token'));
    balanceLine(b);
    var err = el('p', 'mt-4 hidden text-sm text-red-400'); err.setAttribute('role', 'alert');
    var btn = el('button', 'mt-6 block w-full rounded-full bg-linear-to-r from-lime-400 to-emerald-500 px-4 py-3 text-center text-sm font-semibold text-black shadow-[0_0_24px_-8px_rgba(163,230,53,0.9)]', 'Pay GHS ' + plan.price);
    btn.type = 'button';
    btn.addEventListener('click', function () {
      btn.disabled = true; err.classList.add('hidden');
      btn.textContent = ''; btn.appendChild(el('span', 'pv-spin')); btn.appendChild(document.createTextNode('Opening secure checkout…'));
      PV.api('POST', '/api/deposit/initialize', { plan: planSlug })
        .then(function (d) {
          if (!/^https?:\/\//i.test(d.checkoutUrl || '')) throw new Error('Checkout link was invalid. Please try again.');
          location.href = d.checkoutUrl;
        })
        .catch(function (e) {
          if (e.status === 401) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
          err.textContent = e.message; err.classList.remove('hidden'); btn.disabled = false; btn.textContent = 'Pay GHS ' + plan.price;
        });
    });
    b.appendChild(err); b.appendChild(btn);
    b.appendChild(linkBtn('/plans', 'Choose a different plan', false));
  }

  PV.me().then(function (user) {
    if (!user) { location.replace('/login?next=' + encodeURIComponent(location.pathname + location.search)); return; }
    if (payment) showResult(); else showCheckout();
  });
})();
