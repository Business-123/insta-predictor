'use strict';
// Production store + auth, backed by the same Firebase project the website already uses
// (predict-virtuals). Uses the Admin SDK, so it bypasses Firestore security rules: make sure
// your rules do NOT let browsers read or write the `hubPayments` collection (see README).
const admin = require('firebase-admin');

const PAYMENTS = 'hubPayments';
const USERS = 'users';

function initAdmin() {
  if (admin.apps.length) return admin.app();
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const options = { projectId: process.env.FIREBASE_PROJECT_ID || 'predict-virtuals' };
  if (raw) {
    // Accept plain JSON or base64-encoded JSON (easier to paste into hosting dashboards).
    const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    options.credential = admin.credential.cert(JSON.parse(text));
  } // else: Application Default Credentials (GOOGLE_APPLICATION_CREDENTIALS, or a Google Cloud runtime)
  return admin.initializeApp(options);
}

function createFirebase() {
  initAdmin();
  const db = admin.firestore();
  const payments = db.collection(PAYMENTS);
  return {
    // Verifies the Firebase ID token the browser sends as `Authorization: Bearer <token>`.
    async verifyIdToken(token) {
      const decoded = await admin.auth().verifyIdToken(token);
      return { uid: decoded.uid, email: decoded.email || '' };
    },
    store: {
      async createPayment(payment) { await payments.doc(payment.id).create(payment); },
      async getPayment(id) { const snap = await payments.doc(id).get(); return snap.exists ? snap.data() : null; },
      async findByHubReference(reference) {
        const snap = await payments.where('hubReference', '==', reference).limit(1).get();
        return snap.empty ? null : snap.docs[0].data();
      },
      async updatePayment(id, patch) { await payments.doc(id).set(patch, { merge: true }); },
      // Atomic and idempotent: the first caller credits, every later caller is a no-op.
      async creditPayment(id, at) {
        return db.runTransaction(async tx => {
          const paymentRef = payments.doc(id);
          const payment = (await tx.get(paymentRef)).data();
          if (!payment) throw new Error('Payment record vanished.');
          if (payment.creditedAt) return 'ALREADY_CREDITED';
          const userRef = db.collection(USERS).doc(payment.userId);
          const user = await tx.get(userRef);
          if (!user.exists) { tx.set(paymentRef, { status: 'PAID_UNFULFILLED', updatedAt: at }, { merge: true }); return 'NO_PROFILE'; }
          tx.update(userRef, { tokenBalance: admin.firestore.FieldValue.increment(payment.tokens) });
          tx.set(paymentRef, { status: 'SUCCESS', creditedAt: at, updatedAt: at }, { merge: true });
          return 'CREDITED';
        });
      },
    },
  };
}

module.exports = { createFirebase };
