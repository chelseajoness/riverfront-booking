// Riverfront Retreat RV Park: booking server
// Express + Postgres + Stripe Checkout. Runs on Railway (or anywhere with Node 20+).

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { Pool } = require('pg');
const Stripe = require('stripe');

// ---------- Settings (change these here) ----------
const PARK = {
  name: 'Riverfront Retreat RV Park',
  sites: 6,                                   // sites 1–6, all back-in, 30/50 amp
  rates: { nightly: 45, weekly: 280, monthly: 500 },  // dollars
  maxNights: 31,                              // longest nightly booking
  maxWeeks: 8,
  maxMonths: 12,
  maxBookAheadDays: 365,
  holdMinutes: 30,                            // a site is held this long while the guest pays (Stripe minimum is 30)
  timeZone: 'America/Chicago',
};

// Railway variables sometimes get pasted with spaces or quotes around them; strip those.
const env = k => (process.env[k] || '').trim().replace(/^["']|["']$/g, '');
const DATABASE_URL = env('DATABASE_URL');
const STRIPE_SECRET_KEY = env('STRIPE_SECRET_KEY');
const STRIPE_WEBHOOK_SECRET = env('STRIPE_WEBHOOK_SECRET');
const ADMIN_PASSWORD = env('ADMIN_PASSWORD');
const PORT = parseInt(env('PORT'), 10) || 3000;
const BASE_URL = (env('BASE_URL') || `http://localhost:${PORT}`).replace(/\/$/, '');

if (!DATABASE_URL) console.error('DATABASE_URL is not set: add it in Railway → Variables as ${{Postgres.DATABASE_URL}}');
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the owner page is locked until you set it.');
if (!STRIPE_SECRET_KEY) console.warn('STRIPE_SECRET_KEY is not set: online payments are off.');
if (STRIPE_SECRET_KEY && !/^(sk|rk)_(live|test)_/.test(STRIPE_SECRET_KEY)) console.error('STRIPE_SECRET_KEY should start with sk_live_, sk_test_, rk_live_ or rk_test_');
if (STRIPE_SECRET_KEY && !STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET is not set: bookings confirm from the success page only.');

process.on('unhandledRejection', e => console.error('Unhandled error:', e));
process.on('uncaughtException', e => console.error('Uncaught error:', e));

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
let useSSL = !/localhost|127\.0\.0\.1|\.railway\.internal|sslmode=disable/.test(DATABASE_URL);
let pool = null;
let dbReady = false;
function makePool() {
  const p = new Pool({ connectionString: DATABASE_URL, ssl: useSSL ? { rejectUnauthorized: false } : false, max: 5 });
  p.on('error', e => console.error('Database connection error (will reconnect):', e.message));  // keeps one dropped connection from crashing the app
  return p;
}

// ---------- Database ----------
async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bookings (
      id            BIGSERIAL PRIMARY KEY,
      site          INT  NOT NULL,
      check_in      DATE NOT NULL,
      check_out     DATE NOT NULL,
      plan          TEXT NOT NULL,              -- nightly | weekly | monthly | block
      status        TEXT NOT NULL,              -- pending | confirmed | cancelled | blocked
      amount_cents  INT  NOT NULL DEFAULT 0,    -- charged online
      guest_name    TEXT, guest_phone TEXT, guest_email TEXT,
      rig_type      TEXT, rig_length INT, power TEXT, pets BOOLEAN,
      notes         TEXT,
      source        TEXT NOT NULL DEFAULT 'web', -- web | owner
      hold_token    TEXT,
      hold_expires  TIMESTAMPTZ,
      stripe_session TEXT UNIQUE,
      stripe_payment TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (check_out > check_in)
    );
    CREATE INDEX IF NOT EXISTS bookings_dates ON bookings (check_in, check_out);
    CREATE TABLE IF NOT EXISTS payment_requests (
      id            BIGSERIAL PRIMARY KEY,
      token         TEXT NOT NULL UNIQUE,         -- the secret part of the pay link
      booking_id    BIGINT REFERENCES bookings(id),
      guest_name    TEXT NOT NULL,
      guest_email   TEXT, guest_phone TEXT,
      description   TEXT NOT NULL,                -- e.g. "October rent, Site 3"
      amount_cents  INT  NOT NULL CHECK (amount_cents > 0),
      status        TEXT NOT NULL DEFAULT 'open', -- open | paid | cancelled
      stripe_session TEXT, stripe_payment TEXT,
      paid_at       TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

// A booking occupies its site when it is confirmed, blocked, or a pending hold that hasn't expired.
const ACTIVE = `(status IN ('confirmed','blocked') OR (status = 'pending' AND hold_expires > now()))`;

async function freeSites(client, checkIn, checkOut) {
  const { rows } = await client.query(
    `SELECT DISTINCT site FROM bookings
      WHERE ${ACTIVE} AND check_in < $2 AND check_out > $1`, [checkIn, checkOut]);
  const taken = new Set(rows.map(r => r.site));
  const free = [];
  for (let s = 1; s <= PARK.sites; s++) if (!taken.has(s)) free.push(s);
  return free;
}

// ---------- Dates & pricing ----------
const DAY = 86400000;
const isISO = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const toD = s => new Date(s + 'T00:00:00Z');
const iso = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(toD(s).getTime() + n * DAY));
function addMonths(s, n) {
  const d = toD(s); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return iso(d);
}
function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: PARK.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
const nightsBetween = (a, b) => Math.round((toD(b) - toD(a)) / DAY);
const fmtDate = s => toD(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Works out the stay from what the guest picked. Throws a readable message on bad input.
function quote({ plan, checkIn, checkOut, count }) {
  if (!['nightly', 'weekly', 'monthly'].includes(plan)) throw new Error('Choose nightly, weekly or monthly.');
  if (!isISO(checkIn)) throw new Error('Pick your arrival date.');
  const today = todayLocal();
  if (checkIn < today) throw new Error("Arrival can't be in the past.");
  if (checkIn > addDays(today, PARK.maxBookAheadDays)) throw new Error('We take bookings up to a year ahead.');

  let out, qty, label, chargeCents, note = '';
  if (plan === 'nightly') {
    if (!isISO(checkOut)) throw new Error('Pick your departure date.');
    qty = nightsBetween(checkIn, checkOut);
    if (qty < 1) throw new Error('Departure must be after arrival.');
    if (qty > PARK.maxNights) throw new Error('For stays over a month, choose the monthly rate.');
    out = checkOut; label = `${qty} night${qty > 1 ? 's' : ''}`;
    chargeCents = qty * PARK.rates.nightly * 100;
  } else if (plan === 'weekly') {
    qty = parseInt(count, 10);
    if (!(qty >= 1 && qty <= PARK.maxWeeks)) throw new Error(`Choose 1 to ${PARK.maxWeeks} weeks.`);
    out = addDays(checkIn, qty * 7); label = `${qty} week${qty > 1 ? 's' : ''}`;
    chargeCents = qty * PARK.rates.weekly * 100;
  } else {
    qty = parseInt(count, 10);
    if (!(qty >= 1 && qty <= PARK.maxMonths)) throw new Error(`Choose 1 to ${PARK.maxMonths} months.`);
    out = addMonths(checkIn, qty); label = `${qty} month${qty > 1 ? 's' : ''}`;
    chargeCents = PARK.rates.monthly * 100;            // first month online
    if (qty > 1) note = `First month paid today. Each month after is $${PARK.rates.monthly}, due at the start of the month.`;
  }
  return { plan, checkIn, checkOut: out, qty, label, chargeCents, note };
}

// ---------- Confirming payments (used by webhook and success page) ----------
async function confirmFromSession(session) {
  if (!session || session.payment_status !== 'paid') return null;
  if (session.metadata && session.metadata.payment_request_id) return markRequestPaid(session);
  const id = session.metadata && session.metadata.booking_id;
  if (!id) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42)');
    const { rows: [b] } = await client.query('SELECT * FROM bookings WHERE id = $1 FOR UPDATE', [id]);
    if (!b) { await client.query('ROLLBACK'); return null; }
    if (b.status === 'confirmed') { await client.query('COMMIT'); return b; }

    const phone = session.customer_details && session.customer_details.phone;
    // If the hold expired before payment finished, re-check that the site is still free; move to another free site if not.
    let site = b.site;
    const { rows: clash } = await client.query(
      `SELECT 1 FROM bookings WHERE id <> $1 AND site = $2 AND ${ACTIVE} AND check_in < $4 AND check_out > $3 LIMIT 1`,
      [b.id, b.site, b.check_in, b.check_out]);
    if (clash.length) {
      const free = await freeSites(client, iso(b.check_in), iso(b.check_out));
      site = free.length ? free[0] : null;
    }
    const notes = site == null ? 'PAID BUT NO SITE FREE: call guest / refund in Stripe' : b.notes;
    const { rows: [updated] } = await client.query(
      `UPDATE bookings SET status='confirmed', site=COALESCE($2, site), notes=$3,
              stripe_payment=$4, guest_phone=COALESCE(guest_phone,$5), hold_expires=NULL, updated_at=now()
        WHERE id=$1 RETURNING *`,
      [b.id, site, notes, session.payment_intent || null, phone || null]);
    await client.query('COMMIT');
    return updated;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function markRequestPaid(session) {
  const { rows: [r] } = await pool.query(
    `UPDATE payment_requests SET status='paid', paid_at=COALESCE(paid_at, now()), stripe_session=$2, stripe_payment=$3
      WHERE id=$1 AND status<>'cancelled' RETURNING *`,
    [session.metadata.payment_request_id, session.id, session.payment_intent || null]);
  return r || null;
}

// ---------- App ----------
const app = express();
app.set('trust proxy', 1);

// Stripe webhook needs the raw body, so it goes before express.json().
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(503).send('Stripe not configured');
  if (!dbReady) return res.status(503).send('Database not ready');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (e) {
    return res.status(400).send(`Webhook signature check failed: ${e.message}`);
  }
  try {
    const s = event.data.object;
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await confirmFromSession(s);
    } else if (event.type === 'checkout.session.expired') {
      await pool.query(`UPDATE bookings SET status='cancelled', updated_at=now() WHERE stripe_session=$1 AND status='pending'`, [s.id]);
    }
    res.json({ received: true });
  } catch (e) {
    console.error('webhook error', e);
    res.status(500).send('error');
  }
});

app.use(express.json({ limit: '20kb' }));

// Until the database connects, booking routes answer with a clear message instead of crashing.
app.use('/api', (req, res, next) => {
  if (dbReady || req.path === '/config') return next();
  res.status(503).json({ error: 'Booking is starting up. Please try again in a minute or call us.' });
});

// Public: park settings for the website
app.get('/api/config', (req, res) => {
  res.json({ sites: PARK.sites, rates: PARK.rates, maxNights: PARK.maxNights, maxWeeks: PARK.maxWeeks,
             maxMonths: PARK.maxMonths, today: todayLocal(), paymentsOn: !!stripe });
});

// Public: how many sites are open for a stay
app.get('/api/availability', async (req, res) => {
  try {
    const q = quote({ plan: req.query.plan, checkIn: req.query.checkIn, checkOut: req.query.checkOut, count: req.query.count });
    const free = await freeSites(pool, q.checkIn, q.checkOut);
    res.json({ ...q, available: free.length, total: PARK.sites });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Public: start a booking → hold a site → send guest to Stripe Checkout
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
app.post('/api/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Online payment is not set up yet. Please call to book.' });
  let q;
  const b = req.body || {};
  try { q = quote(b); } catch (e) { return res.status(400).json({ error: e.message }); }

  const name = clean(b.name, 100), phone = clean(b.phone, 30), email = clean(b.email, 200);
  const rigType = clean(b.rigType, 40), power = b.power === '30A' ? '30A' : '50A';
  const rigLength = parseInt(b.rigLength, 10), pets = !!b.pets;
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Enter a 10-digit phone number.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!(rigLength >= 10 && rigLength <= 65)) return res.status(400).json({ error: 'Enter a rig length between 10 and 65 feet.' });

  const client = await pool.connect();
  let booking;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42)');   // one booking at a time, so two guests can't grab the same site
    const free = await freeSites(client, q.checkIn, q.checkOut);
    if (!free.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'Sorry, all sites are booked for those dates. Try different dates or call us.' }); }
    const token = crypto.randomBytes(16).toString('hex');
    const { rows: [row] } = await client.query(
      `INSERT INTO bookings (site, check_in, check_out, plan, status, amount_cents, guest_name, guest_phone, guest_email,
                             rig_type, rig_length, power, pets, notes, hold_token, hold_expires)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + ($15 || ' minutes')::interval)
       RETURNING *`,
      [free[0], q.checkIn, q.checkOut, q.plan, q.chargeCents, name, phone, email, rigType, rigLength, power, pets,
       q.note || null, token, String(PARK.holdMinutes + 2)]);
    await client.query('COMMIT');
    booking = row;
  } catch (e) {
    await client.query('ROLLBACK'); client.release();
    console.error(e); return res.status(500).json({ error: 'Something went wrong. Please try again or call us.' });
  }
  client.release();

  try {
    const planName = { nightly: 'Nightly', weekly: 'Weekly', monthly: 'Monthly' }[q.plan];
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: email,
      phone_number_collection: { enabled: true },
      client_reference_id: String(booking.id),
      metadata: { booking_id: String(booking.id), site: String(booking.site), check_in: q.checkIn, check_out: q.checkOut, plan: q.plan },
      payment_intent_data: { description: `${PARK.name}: ${planName}, ${fmtDate(q.checkIn)} to ${fmtDate(q.checkOut)}`,
                             metadata: { booking_id: String(booking.id) } },
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: q.chargeCents,
          product_data: {
            name: `RV site: ${planName}, ${q.label}`,
            description: `${fmtDate(q.checkIn)} to ${fmtDate(q.checkOut)}${q.plan === 'monthly' && q.qty > 1 ? ' (first month)' : ''}`,
          },
        },
      }],
      expires_at: Math.floor(Date.now() / 1000) + PARK.holdMinutes * 60,
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/api/cancel-hold?b=${booking.id}&t=${booking.hold_token}`,
    });
    await pool.query('UPDATE bookings SET stripe_session=$2 WHERE id=$1', [booking.id, session.id]);
    res.json({ url: session.url });
  } catch (e) {
    console.error('stripe error', e.message);
    await pool.query(`UPDATE bookings SET status='cancelled' WHERE id=$1`, [booking.id]);
    res.status(502).json({ error: 'Payment page could not be opened. Please try again or call us.' });
  }
});

// Guest backed out of Stripe: release the hold right away
app.get('/api/cancel-hold', async (req, res) => {
  const id = parseInt(req.query.b, 10), t = String(req.query.t || '');
  if (id && t) await pool.query(`UPDATE bookings SET status='cancelled', updated_at=now() WHERE id=$1 AND hold_token=$2 AND status='pending'`, [id, t]);
  res.redirect('/#book');
});

// Success page asks for the booking (confirms directly with Stripe in case the webhook is slow)
app.get('/api/booking-status', async (req, res) => {
  const sid = String(req.query.session_id || '');
  if (!stripe || !/^cs_[A-Za-z0-9_]+$/.test(sid)) return res.status(400).json({ error: 'Missing booking reference.' });
  try {
    let { rows: [b] } = await pool.query('SELECT * FROM bookings WHERE stripe_session=$1', [sid]);
    if (!b) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'confirmed') {
      const session = await stripe.checkout.sessions.retrieve(sid);
      b = (await confirmFromSession(session)) || b;
    }
    const needsCall = (b.notes || '').startsWith('PAID BUT');
    res.json({ status: b.status, site: needsCall ? null : b.site, checkIn: iso(b.check_in), checkOut: iso(b.check_out), plan: b.plan,
               amount: b.amount_cents / 100, name: b.guest_name,
               note: needsCall ? "Your payment went through. We'll call you shortly to confirm your site." : b.notes });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not look up the booking.' }); }
});

// ---------- Owner pages (password protected) ----------
function requireOwner(req, res, next) {
  const [type, val] = (req.headers.authorization || '').split(' ');
  if (ADMIN_PASSWORD && type === 'Basic' && val) {
    const pass = Buffer.from(val, 'base64').toString().split(':').slice(1).join(':');
    const a = Buffer.from(pass), bb = Buffer.from(ADMIN_PASSWORD);
    if (a.length === bb.length && crypto.timingSafeEqual(a, bb)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Riverfront Retreat owner"').status(401).send('Owner login required');
}

app.get('/admin', requireOwner, (req, res) => res.sendFile(path.join(__dirname, 'private', 'admin.html')));

app.get('/api/admin/bookings', requireOwner, async (req, res) => {
  const from = isISO(req.query.from) ? req.query.from : addDays(todayLocal(), -7);
  const { rows } = await pool.query(
    `SELECT *, (status='pending' AND hold_expires > now()) AS holding FROM bookings
      WHERE check_out >= $1 AND (status IN ('confirmed','blocked') OR (status='pending' AND hold_expires > now()))
      ORDER BY check_in, site`, [from]);
  res.json({ today: todayLocal(), sites: PARK.sites, bookings: rows.map(r => ({ ...r, check_in: iso(r.check_in), check_out: iso(r.check_out) })) });
});

// Owner adds a phone/walk-in booking or blocks a site
app.post('/api/admin/bookings', requireOwner, async (req, res) => {
  const b = req.body || {};
  const site = parseInt(b.site, 10);
  if (!(site >= 1 && site <= PARK.sites)) return res.status(400).json({ error: `Site must be 1–${PARK.sites}.` });
  if (!isISO(b.checkIn) || !isISO(b.checkOut) || b.checkOut <= b.checkIn) return res.status(400).json({ error: 'Check the dates.' });
  const kind = b.kind === 'block' ? 'block' : 'booking';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42)');
    const { rows: clash } = await client.query(
      `SELECT id, guest_name FROM bookings WHERE site=$1 AND ${ACTIVE} AND check_in < $3 AND check_out > $2 LIMIT 1`,
      [site, b.checkIn, b.checkOut]);
    if (clash.length) { await client.query('ROLLBACK'); return res.status(409).json({ error: `Site ${site} is already taken for some of those dates.` }); }
    const { rows: [row] } = await client.query(
      `INSERT INTO bookings (site, check_in, check_out, plan, status, amount_cents, guest_name, guest_phone, notes, source)
       VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8,'owner') RETURNING id`,
      [site, b.checkIn, b.checkOut, kind === 'block' ? 'block' : 'owner', kind === 'block' ? 'blocked' : 'confirmed',
       clean(b.name, 100) || null, clean(b.phone, 30) || null, clean(b.notes, 300) || null]);
    await client.query('COMMIT');
    res.json({ id: row.id });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'Could not save.' }); }
  finally { client.release(); }
});

// Owner cancels a booking or removes a block (refunds are done in Stripe)
app.post('/api/admin/bookings/:id/cancel', requireOwner, async (req, res) => {
  const { rowCount } = await pool.query(`UPDATE bookings SET status='cancelled', updated_at=now() WHERE id=$1 AND status<>'cancelled'`, [req.params.id]);
  res.json({ ok: rowCount === 1 });
});

// ---------- Payment links (owner sends a link; guest pays any amount the owner set) ----------
const money = c => '$' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0 });

app.get('/api/admin/payment-requests', requireOwner, async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM payment_requests WHERE status<>'cancelled' OR created_at > now() - interval '30 days' ORDER BY created_at DESC LIMIT 200`);
  res.json({ requests: rows });
});

app.post('/api/admin/payment-requests', requireOwner, async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 100), email = clean(b.email, 200), phone = clean(b.phone, 30), description = clean(b.description, 200);
  const amountCents = Math.round(parseFloat(String(b.amount || '').replace(/[$,\s]/g, '')) * 100);
  if (name.length < 2) return res.status(400).json({ error: 'Enter who is paying.' });
  if (!description) return res.status(400).json({ error: 'Say what the payment is for, like "October rent, Site 3".' });
  if (!(amountCents >= 100 && amountCents <= 1000000)) return res.status(400).json({ error: 'Enter an amount between $1 and $10,000.' });
  if (email && !/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'That email doesn\'t look right.' });
  const bookingId = parseInt(b.bookingId, 10) || null;
  const token = crypto.randomBytes(12).toString('base64url');
  const { rows: [r] } = await pool.query(
    `INSERT INTO payment_requests (token, booking_id, guest_name, guest_email, guest_phone, description, amount_cents)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [token, bookingId, name, email || null, phone || null, description, amountCents]);
  res.json({ request: r, url: `${BASE_URL}/pay/${token}` });
});

app.post('/api/admin/payment-requests/:id/cancel', requireOwner, async (req, res) => {
  const { rowCount } = await pool.query(`UPDATE payment_requests SET status='cancelled' WHERE id=$1 AND status='open'`, [req.params.id]);
  res.json({ ok: rowCount === 1 });
});

// Everything paid online, newest first
app.get('/api/admin/payments', requireOwner, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT 'booking' AS kind, id, guest_name, guest_email, guest_phone, amount_cents, updated_at AS paid_at,
           'Site ' || site || ': ' || plan || ', ' || to_char(check_in,'Mon DD') || ' to ' || to_char(check_out,'Mon DD') AS description
      FROM bookings WHERE status='confirmed' AND source='web' AND amount_cents > 0
    UNION ALL
    SELECT 'link', id, guest_name, guest_email, guest_phone, amount_cents, paid_at, description
      FROM payment_requests WHERE status='paid'
    ORDER BY paid_at DESC LIMIT 300`);
  res.json({ payments: rows });
});

const findRequest = async token => (await pool.query('SELECT * FROM payment_requests WHERE token=$1', [String(token || '')])).rows[0];
const publicRequest = r => ({ name: (r.guest_name || '').split(' ')[0], description: r.description, amount: r.amount_cents / 100,
                              amountText: money(r.amount_cents), status: r.status, paidAt: r.paid_at });

app.get('/pay/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'pay.html')));

app.get('/api/pay/:token', async (req, res) => {
  const r = await findRequest(req.params.token);
  if (!r) return res.status(404).json({ error: 'This payment link isn\'t valid. Please check the link or call us.' });
  if (r.status === 'open' && req.query.session_id && stripe && /^cs_[A-Za-z0-9_]+$/.test(req.query.session_id)) {
    const session = await stripe.checkout.sessions.retrieve(req.query.session_id);
    if (session.metadata && session.metadata.payment_request_id === String(r.id) && session.payment_status === 'paid') {
      return res.json(publicRequest(await markRequestPaid(session)));
    }
  }
  res.json(publicRequest(r));
});

app.post('/api/pay/:token/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Online payment is not set up yet. Please call us.' });
  const r = await findRequest(req.params.token);
  if (!r) return res.status(404).json({ error: 'This payment link isn\'t valid.' });
  if (r.status === 'paid') return res.status(409).json({ error: 'This has already been paid. Thank you!' });
  if (r.status !== 'open') return res.status(410).json({ error: 'This payment link was cancelled. Please call us.' });
  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      ...(r.guest_email ? { customer_email: r.guest_email } : {}),
      client_reference_id: `request-${r.id}`,
      metadata: { payment_request_id: String(r.id) },
      payment_intent_data: { description: `${PARK.name}: ${r.description}`, metadata: { payment_request_id: String(r.id) } },
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: r.amount_cents,
        product_data: { name: r.description, description: `${PARK.name} · ${r.guest_name}` } } }],
      success_url: `${BASE_URL}/pay/${r.token}?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/pay/${r.token}`,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error('stripe error', e.message);
    res.status(502).json({ error: 'The payment page could not be opened. Please try again or call us.' });
  }
});

app.get('/healthz', (req, res) => res.send(dbReady ? 'ok' : 'starting: database not connected yet'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, '0.0.0.0', () => console.log(`${PARK.name} booking server listening on port ${PORT} (${BASE_URL})`));

async function connectDb(attempt = 1) {
  if (!DATABASE_URL) return;
  try {
    if (!pool) pool = makePool();
    await migrate();
    dbReady = true;
    console.log('Database ready');
  } catch (e) {
    console.error(`Database not reachable (attempt ${attempt}): ${e.message}`);
    if (/SSL|ssl/.test(e.message)) {           // wrong SSL setting for this database: flip it and retry
      useSSL = !useSSL; console.log(`Retrying with SSL ${useSSL ? 'on' : 'off'}`);
    }
    try { if (pool) await pool.end(); } catch (_) {}
    pool = null;
    setTimeout(() => connectDb(attempt + 1), Math.min(30000, 2000 * attempt));
  }
}
connectDb();

module.exports = { quote, addMonths };
