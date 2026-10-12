'use strict';
// Admin portal. Everything from the server is rendered with textContent (never innerHTML),
// because names, emails and usernames are typed by customers.
(() => {
  const app = document.getElementById('app');
  const nav = document.getElementById('nav');
  const who = document.getElementById('who');
  const dlg = document.getElementById('dlg');

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let data = null; try { data = await res.json(); } catch { /* not json */ }
    if (!res.ok) { const e = new Error((data && data.error) || `Request failed (${res.status})`); e.status = res.status; throw e; }
    return data;
  }
  const num = n => Number(n || 0).toLocaleString();
  const date = t => (t ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
  const msg = (kind, text) => h('div', { class: `msg ${kind === 'err' ? 'err' : 'okm'}`, role: kind === 'err' ? 'alert' : 'status' }, text);
  const debounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  const STATUS_PILL = { SUCCESS: 'ok', PENDING: 'wait', PAYMENT_INITIALIZED: 'wait', FAILED: 'bad', EXPIRED: 'bad', MISMATCH: 'bad', PAID_UNFULFILLED: 'bad' };
  const statusPill = s => h('span', { class: `pill ${STATUS_PILL[s] || ''}` }, String(s || '').replace(/_/g, ' ').toLowerCase());

  // ---- Sign in (one 8-digit PIN) -----------------------------------------------------------
  function showSignedOut(message) {
    nav.classList.add('hidden'); who.classList.add('hidden'); app.replaceChildren();
    const err = h('div', { class: 'hidden' });
    const pin = h('input', { class: 'pin', type: 'password', name: 'pin', inputmode: 'numeric', pattern: '[0-9]{8}', maxlength: '8', minlength: '8', autocomplete: 'off', required: true, placeholder: '••••••••', 'aria-label': '8-digit admin PIN' });
    const btn = h('button', { class: 'btn primary', type: 'submit', disabled: true }, 'Enter');
    pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 8); btn.disabled = pin.value.length !== 8; });
    const form = h('form', {
      onsubmit: async e => {
        e.preventDefault(); btn.disabled = true; err.className = 'hidden';
        try { await api('/api/admin/login', { method: 'POST', body: { pin: pin.value } }); await boot(); }
        catch (ex) { err.replaceChildren(msg('err', ex.message)); err.className = ''; pin.value = ''; pin.focus(); }
      },
    }, err, h('label', {}, 'Admin PIN', pin), btn);
    app.append(h('div', { class: 'login card' }, h('h1', {}, 'Admin'), h('p', { class: 'sub' }, message || 'Enter the 8-digit admin PIN.'), form));
    pin.focus();
  }
  async function signOut() { try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch { /* ignore */ } showSignedOut(); }

  // ---- Shell --------------------------------------------------------------------------------
  const VIEWS = { overview: ['Overview', renderOverview], users: ['Users', renderUsers], payments: ['Payments', renderPayments], activity: ['Activity log', renderActivity] };
  let current = 'overview';
  function go(view) {
    current = view;
    nav.replaceChildren(...Object.entries(VIEWS).map(([key, [label]]) => h('button', { class: key === view ? 'on' : '', onclick: () => go(key) }, label)));
    app.replaceChildren(h('div', { class: 'empty' }, 'Loading…'));
    VIEWS[view][1]().catch(handleError);
  }
  function handleError(ex) {
    if (ex.status === 401) return showSignedOut('Your session ended. Enter the PIN again.');
    app.replaceChildren(msg('err', ex.message));
  }
  function table(headers, rows, emptyText) {
    if (!rows.length) return h('div', { class: 'card empty' }, emptyText);
    return h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, headers.map(x => h('th', { class: x.num ? 'num' : '' }, x.label)))),
      h('tbody', {}, rows)));
  }

  // ---- Overview -----------------------------------------------------------------------------
  async function renderOverview() {
    const s = await api('/api/admin/stats');
    const stat = (k, v, n, warn) => h('div', { class: `card stat${warn ? ' warn' : ''}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), n && h('div', { class: 'n' }, n));
    app.replaceChildren(
      h('h1', {}, 'Overview'), h('p', { class: 'sub' }, 'A snapshot of accounts, tokens and payments.'),
      h('div', { class: 'grid' },
        stat('Users', num(s.users.total), `${num(s.users.newThisWeek)} new in the last 7 days`),
        stat('Revenue', `${s.payments.currency} ${num(s.payments.revenue)}`, `${num(s.payments.successful)} successful payments`),
        stat('Tokens sold', num(s.tokens.sold), `${num(s.tokens.inCirculation)} currently held by users`),
        stat('Pending payments', num(s.payments.pending), 'Waiting on the hub'),
        stat('Needs review', num(s.payments.needsReview), 'Amount mismatch or unfulfilled', s.payments.needsReview > 0),
        stat('Suspended', num(s.users.banned), 'Accounts that cannot sign in')),
      s.payments.needsReview > 0 && h('button', { class: 'btn', onclick: () => { payFilter = ''; go('payments'); } }, 'Open payments'));
  }

  // ---- Users --------------------------------------------------------------------------------
  let userQuery = ''; let users = []; let usersTotal = 0; let usersBody;
  async function loadUsers() { const r = await api(`/api/admin/users?q=${encodeURIComponent(userQuery)}`); users = r.users; usersTotal = r.total; }
  function userRows() {
    return users.map(u => h('tr', {},
      h('td', {}, h('div', {}, u.name), h('div', { class: 'm' }, u.email), u.username && h('div', { class: 'm' }, `@${u.username}`)),
      h('td', {}, u.momo),
      h('td', { class: 'num' }, num(u.tokenBalance)),
      h('td', {}, h('span', { class: 'm' }, date(u.createdAt))),
      h('td', {}, u.banned ? h('span', { class: 'pill bad' }, 'suspended') : h('span', { class: 'pill ok' }, 'active')),
      h('td', {}, h('button', { class: 'btn', onclick: () => openUser(u.id) }, 'Manage'))));
  }
  function drawUsers() {
    usersBody.replaceChildren(
      table([{ label: 'User' }, { label: 'SportyBet no.' }, { label: 'Tokens', num: true }, { label: 'Joined' }, { label: 'Status' }, { label: '' }], userRows(), userQuery ? 'No users match that search.' : 'No users yet.'),
      usersTotal > users.length && h('p', { class: 'note' }, `Showing the newest ${users.length} of ${num(usersTotal)}. Search to narrow it down.`));
  }
  async function renderUsers() {
    usersBody = h('div');
    const search = h('input', { type: 'search', placeholder: 'Search name, email, username, phone or ID…', value: userQuery, 'aria-label': 'Search users',
      oninput: debounce(async e => { userQuery = e.target.value.trim(); try { await loadUsers(); drawUsers(); } catch (ex) { handleError(ex); } }) });
    await loadUsers();
    app.replaceChildren(h('h1', {}, 'Users'), h('p', { class: 'sub' }, 'Suspend accounts, adjust tokens and reset passwords.'), h('div', { class: 'bar' }, search), usersBody);
    drawUsers();
  }

  function openUser(id) {
    const u = users.find(x => x.id === id); if (!u) return;
    const status = h('div');
    const flash = (kind, text) => { status.replaceChildren(msg(kind, text)); };
    const refresh = async okText => { try { await loadUsers(); drawUsers(); openUser(id); const s = dlg.querySelector('[data-status]'); if (s) s.replaceChildren(msg('ok', okText)); } catch (ex) { flash('err', ex.message); } };
    status.setAttribute('data-status', '');

    const amount = h('input', { type: 'number', step: '1', required: true, placeholder: 'e.g. 500 or -200', 'aria-label': 'Token change' });
    const reason = h('input', { type: 'text', maxlength: '200', required: true, placeholder: 'Reason (saved in the activity log)', 'aria-label': 'Reason' });
    const tokenForm = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      const n = Number(amount.value);
      if (!window.confirm(`${n > 0 ? 'Add' : 'Remove'} ${num(Math.abs(n))} tokens ${n > 0 ? 'to' : 'from'} ${u.name}?`)) return;
      try { await api(`/api/admin/users/${encodeURIComponent(u.id)}/tokens`, { method: 'POST', body: { amount: n, reason: reason.value } }); await refresh('Token balance updated.'); }
      catch (ex) { flash('err', ex.message); }
    } }, h('div', { class: 'row' }, amount, reason), h('div', {}, h('button', { class: 'btn primary', type: 'submit' }, 'Apply change')));

    const pw = h('input', { type: 'text', minlength: '6', maxlength: '200', required: true, autocomplete: 'off', placeholder: 'New password (min 6 characters)', 'aria-label': 'New password' });
    const pwForm = h('form', { class: 'stack', onsubmit: async e => {
      e.preventDefault();
      if (!window.confirm(`Set a new password for ${u.name}? They will be signed out everywhere.`)) return;
      try { await api(`/api/admin/users/${encodeURIComponent(u.id)}/password`, { method: 'POST', body: { password: pw.value } }); pw.value = ''; flash('ok', 'Password changed. Send it to the customer privately.'); }
      catch (ex) { flash('err', ex.message); }
    } }, pw, h('div', {}, h('button', { class: 'btn', type: 'submit' }, 'Set password')));

    const banBtn = h('button', { class: `btn${u.banned ? '' : ' danger'}`, onclick: async () => {
      if (!window.confirm(u.banned ? `Restore access for ${u.name}?` : `Suspend ${u.name}? They will be signed out and unable to sign in.`)) return;
      try { await api(`/api/admin/users/${encodeURIComponent(u.id)}/ban`, { method: 'POST', body: { banned: !u.banned } }); await refresh(u.banned ? 'Account restored.' : 'Account suspended.'); }
      catch (ex) { flash('err', ex.message); }
    } }, u.banned ? 'Restore account' : 'Suspend account');

    dlg.replaceChildren(h('div', { class: 'dlg' },
      h('div', { class: 'row', style: 'align-items:center;justify-content:space-between;flex-wrap:nowrap' }, h('h2', {}, u.name), h('button', { class: 'btn', style: 'flex:0 0 auto', onclick: () => dlg.close() }, 'Close')),
      h('dl', {}, h('dt', {}, 'Email'), h('dd', {}, u.email), h('dt', {}, 'Username'), h('dd', {}, u.username || '—'), h('dt', {}, 'SportyBet no.'), h('dd', {}, u.momo),
        h('dt', {}, 'Tokens'), h('dd', {}, num(u.tokenBalance)), h('dt', {}, 'Joined'), h('dd', {}, date(u.createdAt)), h('dt', {}, 'Referred by'), h('dd', {}, u.referredBy || '—'), h('dt', {}, 'User ID'), h('dd', {}, u.id)),
      status,
      h('section', {}, h('h3', {}, 'Adjust tokens'), tokenForm),
      h('section', {}, h('h3', {}, 'Reset password'), pwForm),
      h('section', {}, h('h3', {}, 'Account access'), banBtn)));
    if (!dlg.open) dlg.showModal();
  }
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  // ---- Payments -----------------------------------------------------------------------------
  let payFilter = ''; let payQuery = '';
  async function renderPayments() {
    const body = h('div');
    const load = async () => {
      const r = await api(`/api/admin/payments?status=${encodeURIComponent(payFilter)}&q=${encodeURIComponent(payQuery)}`);
      body.replaceChildren(
        table([{ label: 'Date' }, { label: 'Customer' }, { label: 'Plan' }, { label: 'Amount', num: true }, { label: 'Tokens', num: true }, { label: 'Status' }, { label: 'Reference' }],
          r.payments.map(p => h('tr', {}, h('td', {}, h('span', { class: 'm' }, date(p.createdAt))), h('td', {}, p.email), h('td', {}, p.tier),
            h('td', { class: 'num' }, `${p.currency} ${num(p.amount)}`), h('td', { class: 'num' }, num(p.tokens)), h('td', {}, statusPill(p.status)), h('td', { class: 'mono' }, p.hubReference || p.id))),
          'No payments match.'),
        r.total > r.payments.length && h('p', { class: 'note' }, `Showing the newest ${r.payments.length} of ${num(r.total)}.`),
        h('p', { class: 'note' }, 'Payments are credited automatically when the hub confirms them. "Mismatch" and "paid unfulfilled" need a manual look: check the hub, then add tokens from the Users tab if the customer really paid.'));
    };
    const select = h('select', { 'aria-label': 'Filter by status', onchange: e => { payFilter = e.target.value; load().catch(handleError); } },
      ...[['', 'All statuses'], ['SUCCESS', 'Successful'], ['PENDING', 'Pending'], ['PAYMENT_INITIALIZED', 'Checkout opened'], ['FAILED', 'Failed'], ['EXPIRED', 'Expired'], ['MISMATCH', 'Mismatch'], ['PAID_UNFULFILLED', 'Paid, unfulfilled']].map(([v, l]) => h('option', { value: v, selected: v === payFilter }, l)));
    const search = h('input', { type: 'search', placeholder: 'Search email, plan or reference…', value: payQuery, 'aria-label': 'Search payments', oninput: debounce(e => { payQuery = e.target.value.trim(); load().catch(handleError); }) });
    app.replaceChildren(h('h1', {}, 'Payments'), h('p', { class: 'sub' }, 'Every checkout and what happened to it.'), h('div', { class: 'bar' }, search, select), body);
    await load();
  }

  // ---- Activity log -------------------------------------------------------------------------
  const ACTIONS = { 'user.ban': 'Suspended', 'user.unban': 'Restored', 'tokens.adjust': 'Tokens adjusted', 'user.password_reset': 'Password reset' };
  async function renderActivity() {
    const { entries } = await api('/api/admin/audit');
    app.replaceChildren(h('h1', {}, 'Activity log'), h('p', { class: 'sub' }, 'Every change made from this portal. The newest 100 entries.'),
      table([{ label: 'When' }, { label: 'Action' }, { label: 'Customer' }, { label: 'Details' }],
        entries.map(x => h('tr', {}, h('td', {}, h('span', { class: 'm' }, date(x.at))), h('td', {}, ACTIONS[x.action] || x.action), h('td', {}, x.targetEmail || '—'), h('td', {}, x.detail || ''))),
        'No admin actions yet.'));
  }

  // ---- Start --------------------------------------------------------------------------------
  async function boot() {
    try {
      await api('/api/admin/me');
      who.replaceChildren(h('button', { class: 'btn', onclick: signOut }, 'Sign out'));
      nav.classList.remove('hidden'); who.classList.remove('hidden');
      go(current);
    } catch (ex) {
      if (ex.status === 401) return showSignedOut();
      app.replaceChildren(msg('err', ex.message));
    }
  }
  boot();
})();
