# Deploying Predict Virtuals to Railway via GitHub

One Railway service runs everything: the website, the payment routes, and the hub connection.
There is **no database to host and no volume to attach**; all data lives in your Firebase project
(Firestore), so redeploys never lose anything.

## 1. Push to GitHub
```bash
git init
git add .
git commit -m "Predict Virtuals with Payment Hub"
git branch -M main
git remote add origin https://github.com/<your-account>/<your-repo>.git
git push -u origin main
```
`.gitignore` already keeps `.env`, `node_modules` and Firebase key files out. Run `git status`
before committing and make sure no key file is listed.

## 2. Create the Railway service
1. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
2. `railway.json` already sets the start command (`npm start`) and the health check (`/api/health`).
3. **Settings → Networking → Generate Domain** to get `https://<name>.up.railway.app`
   (or attach your own domain, e.g. `www.predictvirtuals.com`).

## 3. Variables (Service → Variables)
| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `APP_BASE_URL` | your public address, e.g. `https://www.predictvirtuals.com` (no trailing slash) |
| `HUB_BASE_URL` | your Payment Hub address (the `/api/v1` part is added for you) |
| `HUB_API_KEY` | issued by the hub for this merchant |
| `HUB_API_SECRET` | issued by the hub for this merchant |
| `PAYMENT_CURRENCY` | `GHS` |
| `FIREBASE_SERVICE_ACCOUNT` | the service-account key, see below |

`PORT` is set by Railway; leave it alone.

**Firebase service account:** Firebase console → Project settings → Service accounts →
*Generate new private key*. Railway variables are easiest as one line, so encode it first:
```bash
base64 -w0 your-key.json        # macOS: base64 -i your-key.json | tr -d '\n'
```
Paste the output as `FIREBASE_SERVICE_ACCOUNT` (raw JSON also works). Then delete the key file
from your computer or keep it somewhere safe; never commit it.

## 4. Register the webhook with the hub
On the Payment Hub, create (or edit) the merchant for this site and set its webhook URL to:
```
https://<your-domain>/api/webhooks/hub
```
Use the key/secret it issues for `HUB_API_KEY` / `HUB_API_SECRET`. If you change the domain
later, update `APP_BASE_URL` and this webhook URL together.

## 5. Firebase settings that must match the new domain
- **Authentication → Settings → Authorized domains → Add domain**: add your Railway domain
  (and your custom domain). **Without this, sign-in fails on the new address.**
- **Firestore rules**: block browsers from the payments collection, and stop users editing their own
  `tokenBalance`/`role`:
  ```
  match /hubPayments/{id} { allow read, write: if false; }
  ```

## 6. Verify
1. `https://<your-domain>/api/health` returns `{"ok":true,"hubConfigured":true}`.
   If `hubConfigured` is `false`, a hub variable is missing.
2. Open `/plans`, sign in, tap **Buy**, and complete a small test payment.
3. The tokens should appear on the `/deposit` page within a few seconds. If they don't, check
   **Deployments → Logs** for `[hub:webhook]` or `[payment:return:error]` lines.

## Redeploys
Every push to `main` redeploys automatically. In-flight payments are safe: the server finishes
open requests on shutdown, and a payment missed during a restart is credited when the hub
retries its webhook or when the customer's browser returns.
