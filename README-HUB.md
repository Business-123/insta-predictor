# Payment Hub for Predict Virtuals

Ported from Phantom Cards. Customers pick a plan on `/plans`, land on `/deposit?plan=gold`,
pay at the hub checkout, and the tokens are added to `users/{uid}.tokenBalance`.

See **DEPLOY.md** for Railway + GitHub hosting.

## Run it
```
npm install
cp .env.example .env     # fill in the values
npm start                # serves the site and the /api routes on :3000
npm test                 # 8 tests against a fake hub, no real money or Firebase needed
```

## Setup checklist
1. **Hub credentials**: put `HUB_BASE_URL`, `HUB_API_KEY`, `HUB_API_SECRET` in `.env`.
2. **Register the webhook** with the hub: `https://YOUR-DOMAIN/api/webhooks/hub`
   (the hub signs it with your secret in `x-hub-signature`; unsigned or wrongly signed calls get 401).
3. **Firebase service account**: set `FIREBASE_SERVICE_ACCOUNT` (needed to verify sign-ins and add tokens).
4. **Set `APP_BASE_URL`** to your real https address.
5. **Firestore rules**: payments are stored in the `hubPayments` collection, written only by the
   server (Admin SDK). Make sure browsers cannot touch it:
   ```
   match /hubPayments/{id} { allow read, write: if false; }
   ```

## How a purchase flows
| Step | What happens |
|---|---|
| Buy on `/deposit` | Browser sends the plan name and the user's Firebase ID token to `POST /api/deposit/initialize`. The server looks up the price and token count itself, saves a `hubPayments` record, asks the hub for a checkout and returns its URL. |
| Customer pays | At the hub's checkout. |
| Webhook (primary) | Hub calls `POST /api/webhooks/hub`. Signature, amount, currency and user are all checked, then tokens are added. |
| Return (backup) | Hub sends the browser to `/api/payment/return`. The server asks the hub directly to verify, then redirects to `/deposit?payment=success`. |
| Safety | Crediting is one atomic Firestore transaction: a payment can only ever credit once, however many of the above fire. |

Plans (edit in `lib/payments.js`; the deposit page's display copy is in `www.predictvirtuals.com/deposit.html`):
Gold GHS 300 → 1,000 tokens, Platinum GHS 500 → 2,000, Diamond GHS 1000 → 5,000.

## Notes
- This export contained only the front end. The routes `/api/support/*` and `/api/auth/ban-status`
  that the pages call are not in it and are not implemented here. If your live site already has those
  routes (a Next.js app), keep it and add `lib/hub.js` + `lib/payments.js` there instead; they have no
  framework dependency. Routes to mount are listed at the top of `server.js`.
- The users' own sign-up code writes `tokenBalance: 0` from the browser, so your Firestore rules should
  stop clients from changing `tokenBalance` and `role` on their own profile. Otherwise anyone can give
  themselves tokens regardless of this payment flow.
- `users.paymentStatus` (set to `pending` at sign-up) is left untouched; I could not see what uses it.
