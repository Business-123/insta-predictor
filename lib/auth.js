'use strict';
// Passwords, cookies and input checks for the site's own sign-in (no third-party auth service).
const crypto = require('node:crypto');

const COOKIE = 'pv_session';
const SESSION_MS = 24 * 60 * 60 * 1000;            // browser-session sign-in: valid for a day
const REMEMBER_MS = 30 * 24 * 60 * 60 * 1000;      // "Keep me signed in": 30 days

const scrypt = (password, salt) => new Promise((resolve, reject) => crypto.scrypt(password, salt, 64, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await scrypt(password, salt)).toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(String(password), Buffer.from(saltHex, 'hex'));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
// Used when the email is unknown, so "no such account" costs the same time as "wrong password".
let decoy; const decoyHash = () => (decoy ||= hashPassword('decoy-password'));
const burnTime = async password => { await verifyPassword(password, await decoyHash()); };

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('='); if (i < 1) continue;
    try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore a malformed cookie */ }
  }
  return out;
}
const sessionToken = req => parseCookies(req)[COOKIE] || '';
function sessionCookie(token, { secure, maxAgeMs }) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/${maxAgeMs ? `; Max-Age=${Math.floor(maxAgeMs / 1000)}` : ''}${secure ? '; Secure' : ''}`;
}
const clearCookie = ({ secure }) => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure ? '; Secure' : ''}`;

const EMAIL = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
function validateSignup(p) {
  const name = String(p.name || '').trim().replace(/\s+/g, ' ');
  const email = String(p.email || '').trim().toLowerCase();
  const username = String(p.username || '').trim();
  const momo = String(p.momo || '').replace(/[\s-]/g, '');
  const password = String(p.password ?? '');
  if (name.length < 2 || name.length > 80) return { error: 'Enter your full name.' };
  if (!EMAIL.test(email) || email.length > 120) return { error: "That email address doesn't look right." };
  if (username && !/^[A-Za-z0-9_.-]{2,30}$/.test(username)) return { error: 'Username can use letters, numbers, dots, dashes and underscores (2 to 30 characters).' };
  if (!/^\+?\d{9,15}$/.test(momo)) return { error: 'Enter your SportyBet mobile number, for example 054XXXXXXX.' };
  if (password.length < 6) return { error: 'Password should be at least 6 characters.' };
  if (password.length > 200) return { error: 'Password is too long.' };
  if (password !== String(p.confirmPassword ?? '')) return { error: "Passwords don't match." };
  const referredBy = /^[A-Za-z0-9_-]{1,64}$/.test(String(p.ref || '')) ? String(p.ref) : null;
  return { value: { name, email, username: username || null, momo, password, referredBy } };
}

// Counts attempts per key inside a sliding window (login guesses, sign-up spam).
function createLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    hit(key) { const t = now(); const list = (hits.get(key) || []).filter(x => x > t - windowMs); list.push(t); hits.set(key, list); if (hits.size > 5000) for (const [k, v] of hits) if (!v.some(x => x > t - windowMs)) hits.delete(k); return list.length > limit; },
    clear(key) { hits.delete(key); },
  };
}

module.exports = { COOKIE, SESSION_MS, REMEMBER_MS, hashPassword, verifyPassword, burnTime, sessionToken, sessionCookie, clearCookie, validateSignup, createLimiter };
