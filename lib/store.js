'use strict';
// Local data store, the same approach as the Phantom Cards site: one JSON file on disk, loaded
// into memory at start and written back after every change (temp file + rename, so a crash can
// never leave a half-written file). Holds users, login sessions and token payments.
//
// Everything runs in one Node process and every method below is synchronous inside, so each
// operation (including crediting tokens) is atomic without any locking. On Railway, point
// DATA_FILE at a mounted volume (e.g. /data/predict-virtuals.json) or the file is lost on redeploy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const sha256 = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const normalizeEmail = email => String(email || '').trim().toLowerCase();

function createStore({ file, now = Date.now } = {}) {
  if (!file) throw new Error('createStore needs a data file path.');
  let db = { version: 1, users: [], sessions: [], payments: [] };
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    db = { ...db, ...loaded };
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  function save() {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  save(); // fail fast at boot if the location is not writable

  const clone = value => (value ? structuredClone(value) : null);
  const userBy = test => db.users.find(test) || null;
  const pruneSessions = () => { const t = now(); db.sessions = db.sessions.filter(s => s.expiresAt > t); };

  return {
    file,

    // ---- Users --------------------------------------------------------------------------
    async createUser({ name, email, username, momo, passwordHash, referredBy }) {
      email = normalizeEmail(email);
      if (userBy(u => u.email === email)) { const e = new Error('Email already registered.'); e.code = 'EMAIL_TAKEN'; throw e; }
      const user = {
        id: `usr_${crypto.randomBytes(9).toString('hex')}`, name, email, username: username || null, momo,
        referredBy: referredBy || null, passwordHash, tokenBalance: 0, role: 'user', banned: false, createdAt: now(),
      };
      db.users.push(user); save();
      return clone(user);
    },
    async findUserByEmail(email) { return clone(userBy(u => u.email === normalizeEmail(email))); },
    async findUserById(id) { return clone(userBy(u => u.id === id)); },
    async setPasswordHash(userId, passwordHash) {
      const user = userBy(u => u.id === userId); if (!user) return false;
      user.passwordHash = passwordHash;
      db.sessions = db.sessions.filter(s => s.userId !== userId); // a new password signs out every device
      save(); return true;
    },

    // ---- Sessions (only a hash of the token is stored) -----------------------------------
    async createSession(userId, ttlMs) {
      pruneSessions();
      const token = crypto.randomBytes(32).toString('hex');
      db.sessions.push({ tokenHash: sha256(token), userId, createdAt: now(), expiresAt: now() + ttlMs });
      save();
      return token;
    },
    async userForSession(token) {
      if (!token) return null;
      const tokenHash = sha256(token); const t = now();
      const session = db.sessions.find(s => s.tokenHash === tokenHash && s.expiresAt > t);
      const user = session && userBy(u => u.id === session.userId);
      return user && !user.banned ? clone(user) : null;
    },
    async deleteSession(token) {
      if (!token) return;
      const tokenHash = sha256(token); const before = db.sessions.length;
      db.sessions = db.sessions.filter(s => s.tokenHash !== tokenHash);
      if (db.sessions.length !== before) save();
    },

    // ---- Token payments (interface used by lib/payments.js) ------------------------------
    async createPayment(payment) {
      if (db.payments.some(p => p.id === payment.id)) throw new Error('Duplicate payment id.');
      db.payments.push({ ...payment }); save();
    },
    async getPayment(id) { return clone(db.payments.find(p => p.id === id)); },
    async findByHubReference(reference) { return clone(db.payments.find(p => p.hubReference === reference)); },
    async updatePayment(id, patch) {
      const payment = db.payments.find(p => p.id === id); if (!payment) throw new Error('Payment record not found.');
      Object.assign(payment, patch); save();
    },
    // Atomic and idempotent: the first caller credits, every later caller is a no-op.
    async creditPayment(id, at) {
      const payment = db.payments.find(p => p.id === id);
      if (!payment) throw new Error('Payment record vanished.');
      if (payment.creditedAt) return 'ALREADY_CREDITED';
      const user = userBy(u => u.id === payment.userId);
      if (!user) { Object.assign(payment, { status: 'PAID_UNFULFILLED', updatedAt: at }); save(); return 'NO_PROFILE'; }
      user.tokenBalance += payment.tokens;
      Object.assign(payment, { status: 'SUCCESS', creditedAt: at, updatedAt: at });
      save(); return 'CREDITED';
    },
  };
}

module.exports = { createStore, normalizeEmail };
