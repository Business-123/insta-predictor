// Shared browser code for the sign-in, sign-up and plans pages. Talks only to this site's own API.
(function () {
  'use strict';
  var $ = function (selector, root) { return (root || document).querySelector(selector); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function tokens(n) { return (Number(n) || 0).toLocaleString() + ' tokens'; }

  var PV = window.PV = {
    supportUrl: '',
    // JSON request helper: resolves with the parsed body, rejects with an Error carrying the server's message.
    api: function (method, url, body) {
      return fetch(url, { method: method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
        .then(function (r) {
          return r.json().catch(function () { return {}; }).then(function (d) {
            if (!r.ok) { var e = new Error(d.error || 'Something went wrong. Please try again.'); e.status = r.status; throw e; }
            return d;
          });
        }, function () { throw new Error('Network error — check your connection and try again.'); });
    },
    me: function () { return PV.api('GET', '/api/auth/me').then(function (d) { return d.user; }, function () { return null; }); },
    // Only same-site paths are allowed as a post-sign-in destination (no "//evil.com").
    next: function () { var n = new URLSearchParams(location.search).get('next'); return n && /^\/(?![\/\\])/.test(n) ? n : '/plans'; },
    signOut: function () { return PV.api('POST', '/api/auth/logout', {}).catch(function () {}).then(function () { location.replace('/login'); }); },
    tokens: tokens, el: el
  };

  // ---- Support link (set SUPPORT_URL on the server to show it) ----------------------------
  PV.api('GET', '/api/config').then(function (c) {
    if (!c.supportUrl) return;
    PV.supportUrl = c.supportUrl;
    var fab = $('#support-fab'), link = $('#support-link'), foot = $('#footer-support');
    if (fab && link) { link.href = c.supportUrl; fab.classList.remove('hidden'); fab.classList.add('flex'); }
    if (foot) { foot.href = c.supportUrl; foot.classList.remove('hidden'); }
  }).catch(function () {});

  function showError(message) { var p = $('#form-error'); if (!p) return; p.textContent = message || ''; p.classList.toggle('hidden', !message); }
  function bindPasswordToggles(form) {
    var show = false;
    form.querySelectorAll('[data-toggle-password]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        show = !show;
        form.querySelectorAll('input[name=password], input[name=confirmPassword]').forEach(function (i) { i.type = show ? 'text' : 'password'; });
        form.querySelectorAll('[data-toggle-password]').forEach(function (b) { b.setAttribute('aria-label', show ? 'Hide password' : 'Show password'); });
      });
    });
  }
  function carryParams(link) { if (link && location.search) link.href = link.getAttribute('href') + location.search; }

  // ---- Sign in ----------------------------------------------------------------------------
  var loginForm = $('#login-form');
  if (loginForm) {
    PV.me().then(function (user) { if (user) location.replace(PV.next()); });
    bindPasswordToggles(loginForm); carryParams($('#to-signup'));
    var forgot = $('#forgot-link');
    forgot.addEventListener('click', function (e) {
      e.preventDefault();
      var note = $('#forgot-note'); note.classList.remove('hidden');
      if (PV.supportUrl && !note.querySelector('a')) { var a = el('a', 'underline', 'Open support'); a.href = PV.supportUrl; a.target = '_blank'; a.rel = 'noopener noreferrer'; note.appendChild(document.createTextNode(' ')); note.appendChild(a); }
    });
    loginForm.addEventListener('submit', function (e) {
      e.preventDefault(); showError('');
      var fd = new FormData(loginForm), btn = loginForm.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Signing in…';
      PV.api('POST', '/api/auth/login', { email: String(fd.get('email') || '').trim(), password: String(fd.get('password') || ''), remember: fd.get('remember') === 'on' })
        .then(function () { location.replace(PV.next()); })
        .catch(function (err) { showError(err.message); btn.disabled = false; btn.textContent = 'Sign in'; });
    });
  }

  // ---- Create account ---------------------------------------------------------------------
  var signupForm = $('#signup-form');
  if (signupForm) {
    PV.me().then(function (user) { if (user) location.replace(PV.next()); });
    bindPasswordToggles(signupForm); carryParams($('#to-login'));
    var ref = new URLSearchParams(location.search).get('ref') || '';
    if (/^[A-Za-z0-9_-]{1,64}$/.test(ref)) { $('#ref-code').textContent = ref; $('#ref-banner').classList.remove('hidden'); } else { ref = ''; }
    var human = false, check = $('#human-check'), submit = $('#signup-submit');
    check.addEventListener('click', function () {
      human = !human;
      check.setAttribute('aria-pressed', String(human));
      check.className = 'mt-2 flex w-full items-center gap-3 rounded-xl border px-4 py-3.5 text-left transition-colors ' + (human ? 'border-lime-500/40 bg-lime-500/5' : 'border-zinc-800 bg-zinc-900/60 hover:border-zinc-700');
      $('#human-box').className = 'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border transition-colors ' + (human ? 'border-lime-400 bg-lime-400 text-black' : 'border-zinc-600');
      $('#human-tick').classList.toggle('hidden', !human);
      $('#human-label').textContent = human ? "Verified — you're human" : "Verify you're human";
      submit.disabled = !human;
    });
    signupForm.addEventListener('submit', function (e) {
      e.preventDefault(); showError('');
      var fd = new FormData(signupForm);
      var body = { ref: ref };
      ['name', 'email', 'username', 'momo', 'password', 'confirmPassword'].forEach(function (k) { body[k] = String(fd.get(k) || ''); });
      if (body.password !== body.confirmPassword) { showError("Passwords don't match."); return; }
      submit.disabled = true; submit.textContent = 'Creating account…';
      PV.api('POST', '/api/auth/signup', body)
        .then(function () { $('#form-ok').classList.remove('hidden'); setTimeout(function () { location.replace(PV.next()); }, 900); })
        .catch(function (err) { showError(err.message); submit.disabled = !human; submit.textContent = 'Create account'; });
    });
  }

  // ---- Plans ------------------------------------------------------------------------------
  var userArea = $('#user-area');
  if (userArea) {
    PV.me().then(function (user) {
      userArea.textContent = '';
      var buyCta = 'mt-6 block rounded-full bg-linear-to-r from-lime-400 to-emerald-500 px-4 py-3 text-center text-sm font-semibold text-black shadow-[0_0_24px_-8px_rgba(163,230,53,0.9)] transition-all hover:-translate-y-0.5 hover:shadow-[0_0_32px_-6px_rgba(163,230,53,1)]';
      document.querySelectorAll('[data-plan]').forEach(function (a) {
        if (!user) return;
        a.href = '/deposit?plan=' + a.getAttribute('data-plan'); a.className = buyCta; a.textContent = 'Buy ' + a.getAttribute('data-tier');
      });
      if (!user) {
        var login = el('a', 'rounded-lg border border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:border-lime-500/40 hover:text-lime-300', 'Sign in'); login.href = '/login';
        var join = el('a', 'whitespace-nowrap rounded-full bg-linear-to-r from-lime-400 to-emerald-500 px-2.5 py-1.5 text-xs font-semibold text-black', 'Join free'); join.href = '/signup';
        userArea.appendChild(login); userArea.appendChild(join); return;
      }
      userArea.appendChild(el('span', 'whitespace-nowrap font-mono text-xs ' + (user.tokenBalance ? 'text-lime-300' : 'text-amber-300'), tokens(user.tokenBalance)));
      var out = el('button', 'rounded-lg border border-zinc-800 px-3 py-1.5 font-mono text-xs text-zinc-300 transition-colors hover:border-lime-500/40 hover:text-lime-300', 'Sign out'); out.type = 'button';
      out.addEventListener('click', PV.signOut); userArea.appendChild(out);
      var line = $('#balance-line'), value = $('#balance-value');
      value.textContent = tokens(user.tokenBalance); value.className = user.tokenBalance ? 'text-lime-300' : 'text-amber-300'; line.classList.remove('hidden');
    });
  }
})();
