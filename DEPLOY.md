# Deploying Predict Virtuals to Railway via GitHub

One Railway service runs everything: the website, accounts, the payment routes and the hub
connection. It needs **one volume** (where the data file lives) and **no outside database**.

## 1. Push to GitHub
```bash
git init
git add .
git commit -m "Predict Virtuals"
git branch -M main
git remote add origin https://github.com/<your-account>/<your-repo>.git
git push -u origin main
```
`.gitignore` keeps `.env`, `node_modules` and `data/` out of the repo. Run `git status` before
committing and make sure no `.env` or data file is listed.

## 2. Create the Railway service
1. Railway → **New Project → Deploy from GitHub repo** → pick the repo.
2. `railway.json` builds from the `Dockerfile` and sets the health check (`/api/health`).
3. **Settings → Networking → Generate Domain** to get `https://<name>.up.railway.app`
   (or attach your own domain, e.g. `www.predictvirtuals.com`).

## 3. Add a volume (required)
Railway wipes the container's disk on every deploy, so accounts and payments must live on a volume.
1. Service → **Settings → Volumes → New Volume**, mount path `/data`.
2. Set `DATA_FILE=/data/predict-virtuals.json` (below).

Without this, every redeploy deletes all accounts and payments. The server prints a warning at start-up
if `DATA_FILE` is not set.

## 4. Variables (Service → Variables)
| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATA_FILE` | `/data/predict-virtuals.json` |
| `APP_BASE_URL` | your public address, e.g. `https://www.predictvirtuals.com` (no trailing slash) |
| `HUB_BASE_URL` | your Payment Hub address (the `/api/v1` part is added for you) |
| `HUB_API_KEY` | issued by the hub for this merchant |
| `HUB_API_SECRET` | issued by the hub for this merchant |
| `PAYMENT_CURRENCY` | `GHS` |
| `SUPPORT_URL` | optional: a WhatsApp / Telegram / web link for the support button |

`PORT` is set by Railway; leave it alone. The old `FIREBASE_SERVICE_ACCOUNT` variable is no longer
used and can be deleted.

## 5. Register the webhook with the hub
On the Payment Hub, create (or edit) the merchant for this site and set its webhook URL to:
```
https://<your-domain>/api/webhooks/hub
```
Use the key/secret it issues for `HUB_API_KEY` / `HUB_API_SECRET`. If you change the domain
later, update `APP_BASE_URL` and this webhook URL together.

## 6. Verify
1. `https://<your-domain>/api/health` returns `{"ok":true,"hubConfigured":true}`.
   If `hubConfigured` is `false`, a hub variable is missing.
2. Open the site, create an account, open **Buy** on a plan and complete a small test payment.
3. The tokens should appear on the `/deposit` page within a few seconds. If they don't, check
   **Deployments → Logs** for `[hub:webhook]` or `[payment:return:error]` lines.
4. Redeploy once and confirm you can still sign in: that proves the volume is working.

## Backups
Everything is in the one file at `DATA_FILE`. Download a copy regularly (Railway CLI: `railway ssh`, or
a volume backup), since it holds your customers and payment records.

## Redeploys
Every push to `main` redeploys automatically. Accounts and payments are on the volume, so they survive.
In-flight payments are safe: the server finishes open requests on shutdown, and a payment missed during
a restart is credited when the hub retries its webhook or when the customer's browser returns.
