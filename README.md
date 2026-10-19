# Riverfront Retreat RV Park: booking website

The website for riverfrontretreatrvpark.com. Guests pick dates, see how many of the 6 sites are open, and pay by card through Stripe. Paying confirms the booking and assigns a site automatically.

- **Website:** `/`
- **Owner page:** `/admin` (password protected). See the next 3 weeks by site, add phone and walk-in bookings, block sites, and cancel bookings.

## How a booking works

1. The guest picks nightly, weekly or monthly and their dates. The page shows how many sites are open.
2. On **Continue to secure payment**, the server holds the first open site for 30 minutes and opens Stripe Checkout for the exact total.
3. Once the guest pays, Stripe notifies the server and the booking is confirmed. The guest sees their site number and gets a Stripe receipt by email.
4. If the guest backs out or the 30 minutes run out, the site is released.

Monthly stays pay the first month online. Later months are collected by you.
Refunds are done in the Stripe dashboard. Cancel the booking on `/admin` too, so the site frees up.

## Settings

Rates, number of sites and booking limits are at the top of `server.js` in `PARK`.

## Environment variables (set these in Railway → your service → Variables)

| Name | What it is |
|---|---|
| `DATABASE_URL` | Add a Postgres database in Railway and reference its `DATABASE_URL` |
| `BASE_URL` | `https://riverfrontretreatrvpark.com` |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → Secret key |
| `STRIPE_WEBHOOK_SECRET` | Stripe → Developers → Webhooks → your endpoint → Signing secret |
| `ADMIN_USERNAME` | Username for `/admin` (not case-sensitive) |
| `ADMIN_PASSWORD` | Password for `/admin` |
| `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE` | References to the Postgres service (used when `DATABASE_URL` is empty) |
| `RESEND_API_KEY` | Optional. Turns on emails (guest confirmations with gate code, owner alerts). From resend.com |
| `MAIL_FROM` | Optional. Sender, e.g. `Riverfront Retreat RV Park <bookings@riverfrontretreatrvpark.com>` (domain must be verified in Resend) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Optional. Turns on text alerts to the owners. From twilio.com |

Gate code, Wi-Fi, check-in note and who gets alerts are set on the owner page under **Settings**.

## Stripe webhook

In Stripe, go to Developers → Webhooks → **Add endpoint**:

- URL: `https://riverfrontretreatrvpark.com/api/stripe/webhook`
- Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `checkout.session.expired`

## Run locally

```
npm install
cp .env.example .env   # fill it in
node --env-file=.env server.js
```
