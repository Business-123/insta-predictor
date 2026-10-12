# Predict Virtuals: accounts and token purchases

Visitors land on the sign-in page, create an account, pick a plan on `/plans`, pay at the Payment Hub
checkout from `/deposit?plan=gold`, and the tokens are added to their balance.

Accounts, sign-in sessions and payments are kept by this server in one JSON file (the same approach
as the Phantom Cards site). There is no Firebase or any other outside database or sign-in service.

See **DEPLOY.md** for Railway + GitHub hosting.

## Run it
```
cp .env.example .env     # fill in the values
npm start                # serves the site and the /api routes on :3000
npm test                 # 32 tests: accounts, sessions, payments (fake hub, no real money)
```
There is nothing to `npm install`: the app has no dependencies.

## Accounts
| Route | What it does |
|---|---|
| `POST /api/auth/signup` | Creates the account (name, email, optional username, SportyBet number, password) and signs the person in. |
| `POST /api/auth/login` | Checks email + password. "Keep me signed in" lasts 30 days, otherwise 1 day. |
| `POST /api/auth/logout` | Ends the session on the server. |
| `GET /api/auth/me` | The signed-in user and token balance (or `null`). |

- Passwords are stored only as salted scrypt hashes; session cookies are `HttpOnly`, `SameSite=Lax`
  (and `Secure` on https) and only a hash of each session token is stored.
- Sign-in attempts are limited (8 per 15 minutes per address + email) and sign-ups (10 per hour per address).
- Token balances can only change on the server, through a confirmed payment. Browsers cannot edit them.
- There is no email service, so **Forgot password** tells people to contact support. Support can reset a
  password or suspend someone from the admin portal (`/admin`).

## Admin portal (`/admin`)
Open `https://<your-domain>/admin` and enter the 8-digit PIN from the `ADMIN_PIN` variable. That's the only sign-in:
no admin account or password. If `ADMIN_PIN` is missing or isn't exactly 8 digits, the portal is disabled.

- A correct PIN gives a signed cookie that lasts 8 hours. **Changing `ADMIN_PIN` signs every admin out.**
- Wrong guesses are limited to 5 per 15 minutes per address, and 30 per hour across the whole site.
- Use a random PIN (not a birthday or `12345678`). Only someone who knows it can reach the data.

| Tab | What you can do |
|---|---|
| Overview | Users, revenue, tokens sold, pending payments, and payments that need review. |
| Users | Search; **adjust tokens** (add or remove, with a required reason); **reset a password** (signs them out everywhere); **suspend / restore** an account. |
| Payments | Every checkout with its status; filter by status or search by email / reference. |
| Activity log | Who did what, when (token changes, suspensions, password resets). Stored in the data file. |

The admin API lives under `/api/admin/*` and returns 401 to anyone without a valid PIN session.

## How a purchase flows
| Step | What happens |
|---|---|
| Buy on `/deposit` | Browser sends the plan name (its session cookie identifies the user) to `POST /api/deposit/initialize`. The server looks up the price and token count itself, saves a payment record, asks the hub for a checkout and returns its URL. |
| Customer pays | At the hub's checkout. |
| Webhook (primary) | Hub calls `POST /api/webhooks/hub`. Signature, amount, currency and user are all checked, then tokens are added. |
| Return (backup) | Hub sends the browser to `/api/payment/return`. The server asks the hub directly to verify, then redirects to `/deposit?payment=success`. |
| Safety | Crediting happens in one step inside the server: a payment can only ever credit once, however many of the above fire. |

Plans (edit in `lib/payments.js`; the pages' display copy is in `www.predictvirtuals.com/plans.html`
and `deposit.js`): Gold GHS 300 → 1,000 tokens, Platinum GHS 500 → 2,000, Diamond GHS 1000 → 5,000.

## The data file
`DATA_FILE` (default `data/predict-virtuals.json`) holds `users`, `sessions` and `payments`. It is
rewritten after every change (temp file + rename, so it is never half-written). **Back it up**: it is
your customer list and your payment records. It suits one server and a modest number of users; if you
outgrow it, the methods in `lib/store.js` are the only place that touches storage.

## Notes
- `/predict` (the prediction tool the pages link to after payment) is not part of this project.
- The old support chat and partner/staff screens were Firebase-based and are gone. If `SUPPORT_URL` is
  set, the support button opens that link instead.
