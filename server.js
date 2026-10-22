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
const ADMIN_USERNAME = env('ADMIN_USERNAME') || env('ADMIN_USER');   // optional: when set, the owner login needs this username too
const PORT = parseInt(env('PORT'), 10) || 3000;
const BASE_URL = (env('BASE_URL') || `http://localhost:${PORT}`).replace(/\/$/, '');

// Either DATABASE_URL, or Postgres's separate PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE variables
const HAS_PG_PARTS = !!(env('PGHOST') && env('PGUSER') && env('PGPASSWORD'));
const HAS_DB = !!DATABASE_URL || HAS_PG_PARTS;
if (!HAS_DB) console.error('Database not set: add DATABASE_URL (or PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE) in Railway → Variables as references to Postgres');
else console.log(DATABASE_URL ? 'Database: using DATABASE_URL' : `Database: using PGHOST (${env('PGHOST')})`);
if (!ADMIN_PASSWORD) console.warn('ADMIN_PASSWORD is not set: the owner page is locked until you set it.');
if (!STRIPE_SECRET_KEY) console.warn('STRIPE_SECRET_KEY is not set: online payments are off.');
if (STRIPE_SECRET_KEY && !/^(sk|rk)_(live|test)_/.test(STRIPE_SECRET_KEY)) console.error('STRIPE_SECRET_KEY should start with sk_live_, sk_test_, rk_live_ or rk_test_');
if (STRIPE_SECRET_KEY && !STRIPE_WEBHOOK_SECRET) console.warn('STRIPE_WEBHOOK_SECRET is not set: bookings confirm from the success page only.');

process.on('unhandledRejection', e => console.error('Unhandled error:', e));
process.on('uncaughtException', e => console.error('Uncaught error:', e));

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;
let useSSL = !/localhost|127\.0\.0\.1|\.railway\.internal|sslmode=disable/.test(DATABASE_URL || env('PGHOST'));
let pool = null;
let dbReady = false;
function makePool() {
  const conn = DATABASE_URL ? { connectionString: DATABASE_URL }
    : { host: env('PGHOST'), port: parseInt(env('PGPORT'), 10) || 5432, user: env('PGUSER'), password: env('PGPASSWORD'), database: env('PGDATABASE') || env('PGUSER') };
  const p = new Pool({ ...conn, ssl: useSSL ? { rejectUnauthorized: false } : false, max: 5 });
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
    ALTER TABLE bookings ADD COLUMN IF NOT EXISTS application_id BIGINT;
    CREATE TABLE IF NOT EXISTS applications (
      id           BIGSERIAL PRIMARY KEY,
      token        TEXT NOT NULL UNIQUE,          -- secret part of the guest's application link
      status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | paid | withdrawn
      plan         TEXT NOT NULL,
      check_in     DATE NOT NULL,
      check_out    DATE NOT NULL,
      stay_label   TEXT,
      amount_cents INT NOT NULL,
      guest_name   TEXT NOT NULL, guest_phone TEXT NOT NULL, guest_email TEXT NOT NULL,
      rig_type     TEXT, rig_length INT, power TEXT, pets BOOLEAN,
      details      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- the rest of the application answers
      booking_id   BIGINT,
      owner_note   TEXT,                           -- message to the guest when approving/denying
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_at   TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );
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
    if (updated.application_id) pool.query(`UPDATE applications SET status='paid' WHERE id=$1`, [updated.application_id]).catch(() => {});
    notifyBooking(updated).catch(e => console.error('notify error', e.message));   // gate code email + owner alerts
    return updated;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}

async function markRequestPaid(session) {
  const { rows: [r] } = await pool.query(
    `UPDATE payment_requests SET status='paid', paid_at=now(), stripe_session=$2, stripe_payment=$3
      WHERE id=$1 AND status='open' RETURNING *`,
    [session.metadata.payment_request_id, session.id, session.payment_intent || null]);
  if (r) {   // newly paid: tell the owners
    ownerAlert(`💵 Payment received: ${r.guest_name} paid ${money(r.amount_cents)} for ${r.description}.`,
      `Payment received: ${r.guest_name}, ${money(r.amount_cents)}`).catch(e => console.error('notify error', e.message));
    return r;
  }
  const { rows: [existing] } = await pool.query('SELECT * FROM payment_requests WHERE id=$1', [session.metadata.payment_request_id]);
  return existing || null;
}

// ---------- Settings (gate code, Wi-Fi, who gets alerts) ----------
const SETTING_KEYS = ['gate_code', 'wifi_name', 'wifi_password', 'checkin_note', 'alert_emails', 'alert_phones', 'require_application', 'approval_hours'];
async function getSettings() {
  const out = Object.fromEntries(SETTING_KEYS.map(k => [k, '']));
  if (!pool) return out;
  const { rows } = await pool.query('SELECT key, value FROM settings');
  rows.forEach(r => { if (SETTING_KEYS.includes(r.key)) out[r.key] = r.value; });
  if (!out.require_application) out.require_application = 'on';   // applications are on unless the owner turns them off
  if (!out.approval_hours) out.approval_hours = '48';
  return out;
}
const splitList = v => String(v || '').split(/[\s,;]+/).map(x => x.trim()).filter(Boolean);
const toE164 = p => { const d = String(p).replace(/\D/g, ''); return d.length === 10 ? '+1' + d : d.length === 11 && d[0] === '1' ? '+' + d : null; };
const escHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Email (Resend) and text messages (Twilio): each turns on when its keys are set in Railway ----------
const RESEND_API_KEY = env('RESEND_API_KEY');
const MAIL_FROM = env('MAIL_FROM') || 'Riverfront Retreat RV Park <bookings@riverfrontretreatrvpark.com>';
const MAIL_REPLY_TO = env('MAIL_REPLY_TO') || 'riverfrontretreatrvpark@gmail.com';
const TWILIO_SID = env('TWILIO_ACCOUNT_SID'), TWILIO_TOKEN = env('TWILIO_AUTH_TOKEN'), TWILIO_FROM = env('TWILIO_FROM');

async function sendEmail(to, subject, html) {
  const list = Array.isArray(to) ? to : [to];
  if (!RESEND_API_KEY || !list.length) return false;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: MAIL_FROM, to: list, reply_to: MAIL_REPLY_TO, subject, html }),
  });
  if (!r.ok) { console.error('email failed', r.status, (await r.text()).slice(0, 300)); return false; }
  return true;
}
async function sendText(to, body) {
  const num = toE164(to);
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM || !num) return false;
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: num, From: TWILIO_FROM, Body: body.slice(0, 1500) }),
  });
  if (!r.ok) { console.error('text failed', r.status, (await r.text()).slice(0, 300)); return false; }
  return true;
}
// Alerts to the owners: a text to each alert phone (if texting is set up) and an email to each alert email
async function ownerAlert(text, subject) {
  const st = await getSettings();
  const results = await Promise.all([
    ...splitList(st.alert_phones).map(p => sendText(p, text)),
    sendEmail(splitList(st.alert_emails), subject || text.slice(0, 80), `<p style="font:16px/1.5 sans-serif">${escHtml(text).replace(/\n/g, '<br>')}</p><p style="font:14px sans-serif"><a href="${BASE_URL}/admin">Open the owner page</a></p>`),
  ]);
  return results.some(Boolean);
}

function stayLines(b, st) {
  const lines = [
    ['Site', b.site], ['Arrive', fmtDate(iso(b.check_in))], ['Leave', fmtDate(iso(b.check_out))],
    ['Gate code', st.gate_code || 'We will text it to you before you arrive'],
  ];
  if (st.wifi_name) lines.push(['Wi-Fi', st.wifi_name + (st.wifi_password ? ` · password ${st.wifi_password}` : '')]);
  return lines;
}
async function notifyBooking(b) {
  if (!b || b.status !== 'confirmed' || b.source !== 'web') return;
  const st = await getSettings();
  const needsCall = (b.notes || '').startsWith('PAID BUT');
  const RIG = { ClassA: 'Class A', ClassB: 'Class B', ClassC: 'Class C', '5thWheel': 'Fifth wheel', TravelTrailer: 'Travel trailer', Other: 'Other rig' };
  // 1) Owners: text + email
  await ownerAlert(
    `🏕️ New booking${needsCall ? ' (NEEDS A CALL: no site was free)' : ''}: ${b.guest_name}, Site ${b.site}, ${fmtDate(iso(b.check_in))} to ${fmtDate(iso(b.check_out))}, ${money(b.amount_cents)} paid.\nPhone: ${b.guest_phone || 'n/a'}\nRig: ${RIG[b.rig_type] || b.rig_type || ''} ${b.rig_length || ''}ft, ${b.power || ''}${b.pets ? ', pets' : ''}`,
    `New booking: ${b.guest_name}, Site ${b.site}, ${fmtDate(iso(b.check_in))}`);
  // 2) Guest: confirmation email with gate code and Wi-Fi
  if (b.guest_email && !needsCall) {
    const rows = stayLines(b, st).map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#56635C">${k}</td><td style="padding:6px 0;font-weight:600">${escHtml(v)}</td></tr>`).join('');
    await sendEmail(b.guest_email, `You're booked at Riverfront Retreat: Site ${b.site}, ${fmtDate(iso(b.check_in))}`,
      `<div style="font:16px/1.5 -apple-system,Segoe UI,sans-serif;color:#16231E;max-width:520px">
        <h2 style="font-family:Georgia,serif;margin:0 0 8px">See you on the river, ${escHtml((b.guest_name || '').split(' ')[0])}!</h2>
        <p>Your RV site at Riverfront Retreat RV Park is confirmed.</p>
        <table style="border-collapse:collapse;margin:12px 0">${rows}</table>
        ${st.checkin_note ? `<p>${escHtml(st.checkin_note)}</p>` : ''}
        <p><b>Address:</b> 120 Old Hwy 24, New Augusta, MS 39462<br><a href="https://www.google.com/maps/search/?api=1&query=120+Old+Hwy+24+New+Augusta+MS+39462">Get directions</a></p>
        <p>Questions? Call or text (601) 408-1851 or (601) 620-8833, or reply to this email.</p>
      </div>`);
  }
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
  if (dbReady || ['/config', '/login', '/logout'].includes(req.path)) return next();
  res.status(503).json({ error: 'Booking is starting up. Please try again in a minute or call us.' });
});

// Public: park settings for the website
app.get('/api/config', async (req, res) => {
  let requireApplication = true;
  try { requireApplication = dbReady ? (await getSettings()).require_application !== 'off' : true; } catch (_) {}
  res.json({ sites: PARK.sites, rates: PARK.rates, maxNights: PARK.maxNights, maxWeeks: PARK.maxWeeks,
             maxMonths: PARK.maxMonths, today: todayLocal(), paymentsOn: !!stripe, requireApplication });
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
  if ((await getSettings()).require_application !== 'off') return res.status(400).json({ error: 'Please submit an application for your dates.' });
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
    if (!b) {
      const session = await stripe.checkout.sessions.retrieve(sid);
      const bid = session && session.metadata && session.metadata.booking_id;
      if (bid) b = (await pool.query('SELECT * FROM bookings WHERE id=$1', [bid])).rows[0];
    }
    if (!b) return res.status(404).json({ error: 'Booking not found.' });
    if (b.status !== 'confirmed') {
      const session = await stripe.checkout.sessions.retrieve(sid);
      b = (await confirmFromSession(session)) || b;
    }
    const needsCall = (b.notes || '').startsWith('PAID BUT');
    const st = b.status === 'confirmed' && !needsCall ? await getSettings() : {};
    res.json({ status: b.status, site: needsCall ? null : b.site, gateCode: st.gate_code || '', wifiName: st.wifi_name || '', wifiPassword: st.wifi_password || '', checkinNote: st.checkin_note || '', checkIn: iso(b.check_in), checkOut: iso(b.check_out), plan: b.plan,
               amount: b.amount_cents / 100, name: b.guest_name,
               note: needsCall ? "Your payment went through. We'll call you shortly to confirm your site." : b.notes });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Could not look up the booking.' }); }
});

// ---------- Owner login (login page + signed cookie, stays signed in for 30 days) ----------
const SESSION_DAYS = 30;
const COOKIE = 'rr_owner';
// The signing key comes from the owner's username + password, so changing the password signs everyone out.
const sessionKey = () => crypto.createHash('sha256').update(`rr|${ADMIN_USERNAME.toLowerCase()}|${ADMIN_PASSWORD}|${env('SESSION_SECRET')}`).digest();
const signSession = exp => `${exp}.${crypto.createHmac('sha256', sessionKey()).update(String(exp)).digest('base64url')}`;
const same = (x, y) => { const a = Buffer.from(String(x)), b = Buffer.from(String(y)); return a.length === b.length && crypto.timingSafeEqual(a, b); };
function readCookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function isOwner(req) {
  if (!ADMIN_PASSWORD) return false;
  const v = readCookie(req, COOKIE); const exp = parseInt(v.split('.')[0], 10);
  return !!exp && exp > Date.now() && same(v, signSession(exp));
}
function requireOwner(req, res, next) {
  if (isOwner(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in again.', login: true });
  res.redirect('/login');
}
const cookieAttrs = req => `Path=/; HttpOnly; SameSite=Lax${req.secure ? '; Secure' : ''}`;

// Slow down password guessing: 8 tries per 15 minutes per address
const tries = new Map();
function tooManyTries(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 15 * 60000);
  tries.set(ip, t); return t.length >= 8;
}

app.get('/login', (req, res) => isOwner(req) ? res.redirect('/admin') : res.sendFile(path.join(__dirname, 'private', 'login.html')));

app.post('/api/login', (req, res) => {
  if (!ADMIN_PASSWORD) return res.status(503).json({ error: 'The owner password isn\'t set up yet. Add ADMIN_PASSWORD in Railway.' });
  if (tooManyTries(req.ip)) return res.status(429).json({ error: 'Too many tries. Wait 15 minutes and try again.' });
  const { username = '', password = '' } = req.body || {};
  const userOk = !ADMIN_USERNAME || same(String(username).trim().toLowerCase(), ADMIN_USERNAME.toLowerCase());
  if (!(userOk && same(password, ADMIN_PASSWORD))) {
    tries.get(req.ip).push(Date.now());
    return res.status(401).json({ error: 'That username or password isn\'t right.' });
  }
  tries.delete(req.ip);
  const exp = Date.now() + SESSION_DAYS * 86400000;
  res.set('Set-Cookie', `${COOKIE}=${encodeURIComponent(signSession(exp))}; Max-Age=${SESSION_DAYS * 86400}; ${cookieAttrs(req)}`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.set('Set-Cookie', `${COOKIE}=; Max-Age=0; ${cookieAttrs(req)}`);
  res.json({ ok: true });
});

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
  if (!isISO(b.checkIn)) return res.status(400).json({ error: 'Pick the first date.' });
  if (!isISO(b.checkOut)) return res.status(400).json({ error: 'Pick the end date.' });
  if (b.checkOut <= b.checkIn) return res.status(400).json({ error: b.kind === 'block' ? 'The last day closed can\'t be before the first day.' : 'The leave date has to be after the arrive date.' });
  const kind = b.kind === 'block' ? 'block' : 'booking';
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42)');
    const { rows: clash } = await client.query(
      `SELECT id, guest_name, status, notes, check_in, check_out FROM bookings WHERE site=$1 AND ${ACTIVE} AND check_in < $3 AND check_out > $2 ORDER BY check_in LIMIT 1`,
      [site, b.checkIn, b.checkOut]);
    if (clash.length) {
      await client.query('ROLLBACK');
      const c = clash[0], who = c.status === 'blocked' ? `already blocked${c.notes ? ` (${c.notes})` : ''}` : `booked by ${c.guest_name || 'a guest'}`;
      const span = c.status === 'blocked' ? `${fmtDate(iso(c.check_in))} through ${fmtDate(addDays(iso(c.check_out), -1))}` : `${fmtDate(iso(c.check_in))} to ${fmtDate(iso(c.check_out))}`;
      return res.status(409).json({ error: `Site ${site} is ${who} ${span}. Pick other dates or another site.` });
    }
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

// ---------- Applications: guest applies → owner approves → guest pays → confirmed ----------
const RIG_NAMES = { ClassA: 'Class A', ClassB: 'Class B', ClassC: 'Class C', '5thWheel': 'Fifth wheel', TravelTrailer: 'Travel trailer', Other: 'Other rig' };
const emailWrap = inner => `<div style="font:16px/1.5 -apple-system,Segoe UI,sans-serif;color:#16231E;max-width:520px">${inner}<p style="color:#56635C;font-size:14px">Riverfront Retreat RV Park · 120 Old Hwy 24, New Augusta, MS 39462 · (601) 408-1851 or (601) 620-8833</p></div>`;
const appLink = a => `${BASE_URL}/apply/${a.token}`;

app.post('/api/apply', async (req, res) => {
  const b = req.body || {};
  let q; try { q = quote(b); } catch (e) { return res.status(400).json({ error: e.message }); }
  const name = clean(b.name, 100), phone = clean(b.phone, 30), email = clean(b.email, 200);
  const rigType = clean(b.rigType, 40), power = b.power === '30A' ? '30A' : '50A';
  const rigLength = parseInt(b.rigLength, 10), pets = !!b.pets;
  if (name.length < 2) return res.status(400).json({ error: 'Enter your name.' });
  if (phone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Enter a 10-digit phone number.' });
  if (!/^\S+@\S+\.\S+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (!(rigLength >= 10 && rigLength <= 65)) return res.status(400).json({ error: 'Enter a rig length between 10 and 65 feet.' });
  const d = b.details || {};
  const details = {
    adults: clean(String(d.adults ?? ''), 3), children: clean(String(d.children ?? ''), 3),
    petDetails: clean(d.petDetails, 200), rigYear: clean(d.rigYear, 10),
    vehicle: clean(d.vehicle, 120), plate: clean(d.plate, 30),
    reason: clean(d.reason, 300), employer: clean(d.employer, 120),
    emergencyName: clean(d.emergencyName, 100), emergencyPhone: clean(d.emergencyPhone, 30),
    referral: clean(d.referral, 120), notes: clean(d.notes, 600), agreed: !!d.agreed,
  };
  if (!(parseInt(details.adults, 10) >= 1)) return res.status(400).json({ error: 'Enter how many adults will stay.' });
  if (!details.reason) return res.status(400).json({ error: 'Tell us a little about your stay.' });
  if (!details.emergencyName || details.emergencyPhone.replace(/\D/g, '').length < 10) return res.status(400).json({ error: 'Enter an emergency contact name and phone.' });
  if (!details.agreed) return res.status(400).json({ error: 'Please agree to the park rules.' });
  const free = await freeSites(pool, q.checkIn, q.checkOut);
  if (!free.length) return res.status(409).json({ error: 'Sorry, all sites are booked for those dates. Try different dates or call us.' });

  const token = crypto.randomBytes(12).toString('base64url');
  const { rows: [a] } = await pool.query(
    `INSERT INTO applications (token, plan, check_in, check_out, stay_label, amount_cents, guest_name, guest_phone, guest_email, rig_type, rig_length, power, pets, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [token, q.plan, q.checkIn, q.checkOut, q.label, q.chargeCents, name, phone, email, rigType, rigLength, power, pets, details]);
  ownerAlert(`📝 New application: ${name}, ${fmtDate(q.checkIn)} to ${fmtDate(q.checkOut)} (${q.label}, ${q.plan}). ${RIG_NAMES[rigType] || rigType} ${rigLength}ft. Phone ${phone}.\nReview it on the owner page.`,
    `New application: ${name}, ${fmtDate(q.checkIn)}`).catch(e => console.error('notify error', e.message));
  sendEmail(email, 'We received your application · Riverfront Retreat RV Park', emailWrap(
    `<h2 style="font-family:Georgia,serif;margin:0 0 8px">Thanks, ${escHtml(name.split(' ')[0])}!</h2>
     <p>We received your application for <b>${fmtDate(q.checkIn)} to ${fmtDate(q.checkOut)}</b> (${escHtml(q.label)}). We'll review it and email you, usually within a day.</p>
     <p>Once approved, you'll get a link to pay and lock in your site. You can check your status any time: <a href="${appLink(a)}">${appLink(a)}</a></p>`)).catch(() => {});
  res.json({ ok: true, token: a.token, url: `/apply/${a.token}` });
});

// Guest's application page
app.get('/apply/:token', (req, res) => res.sendFile(path.join(__dirname, 'public', 'apply.html')));
app.get('/api/apply/:token', async (req, res) => {
  const { rows: [a] } = await pool.query('SELECT * FROM applications WHERE token=$1', [String(req.params.token)]);
  if (!a) return res.status(404).json({ error: 'Application not found. Please check the link or call us.' });
  let b = null;
  if (a.booking_id) b = (await pool.query('SELECT * FROM bookings WHERE id=$1', [a.booking_id])).rows[0];
  const holdOk = b && b.status === 'pending' && b.hold_expires && new Date(b.hold_expires) > new Date();
  res.json({
    status: a.status, name: a.guest_name.split(' ')[0], plan: a.plan, label: a.stay_label,
    checkIn: iso(a.check_in), checkOut: iso(a.check_out), amount: a.amount_cents / 100,
    site: b ? b.site : null, payBy: holdOk ? b.hold_expires : null, canPay: a.status === 'approved' && !!holdOk && !!stripe,
    expired: a.status === 'approved' && !holdOk && !(b && b.status === 'confirmed'),
    message: a.owner_note || '',
  });
});
// Approved guest pays → Stripe Checkout for their held site
app.post('/api/apply/:token/checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Online payment is not set up yet. Please call us.' });
  const { rows: [a] } = await pool.query('SELECT * FROM applications WHERE token=$1', [String(req.params.token)]);
  if (!a || a.status !== 'approved' || !a.booking_id) return res.status(400).json({ error: 'This application is not ready for payment.' });
  const { rows: [b] } = await pool.query('SELECT * FROM bookings WHERE id=$1', [a.booking_id]);
  if (!b || b.status !== 'pending' || !(b.hold_expires && new Date(b.hold_expires) > new Date()))
    return res.status(410).json({ error: 'Your approval has expired. Please call us and we will set you back up.' });
  try {
    const planName = { nightly: 'Nightly', weekly: 'Weekly', monthly: 'Monthly' }[a.plan];
    const session = await stripe.checkout.sessions.create({
      mode: 'payment', customer_email: a.guest_email, phone_number_collection: { enabled: true },
      client_reference_id: String(b.id),
      metadata: { booking_id: String(b.id), application_id: String(a.id), site: String(b.site), check_in: iso(b.check_in), check_out: iso(b.check_out), plan: a.plan },
      payment_intent_data: { description: `${PARK.name}: ${planName}, ${fmtDate(iso(b.check_in))} to ${fmtDate(iso(b.check_out))}`, metadata: { booking_id: String(b.id) } },
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: b.amount_cents,
        product_data: { name: `RV Site ${b.site}: ${planName}, ${a.stay_label || ''}`.trim(), description: `${fmtDate(iso(b.check_in))} to ${fmtDate(iso(b.check_out))}` } } }],
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: appLink(a),
    });
    await pool.query('UPDATE bookings SET stripe_session=$2 WHERE id=$1', [b.id, session.id]);
    res.json({ url: session.url });
  } catch (e) {
    console.error('stripe error', e.message);
    res.status(502).json({ error: 'The payment page could not be opened. Please try again or call us.' });
  }
});

// Owner: list, approve, decline
app.get('/api/admin/applications', requireOwner, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT a.*, b.site, b.status AS booking_status, b.hold_expires
      FROM applications a LEFT JOIN bookings b ON b.id = a.booking_id
     WHERE a.status IN ('pending','approved') OR a.created_at > now() - interval '30 days'
     ORDER BY (a.status='pending') DESC, a.created_at DESC LIMIT 200`);
  res.json({ applications: rows.map(r => ({ ...r, check_in: iso(r.check_in), check_out: iso(r.check_out), url: appLink(r) })), emailOn: !!RESEND_API_KEY });
});

app.post('/api/admin/applications/:id/approve', requireOwner, async (req, res) => {
  const st = await getSettings();
  const hours = Math.min(168, Math.max(6, parseInt(st.approval_hours, 10) || 48));
  const wantSite = parseInt((req.body || {}).site, 10) || null;
  const note = clean((req.body || {}).message, 500);
  const client = await pool.connect();
  let a, booking;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(42)');
    a = (await client.query('SELECT * FROM applications WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
    if (!a || a.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'This application was already handled.' }); }
    const free = await freeSites(client, iso(a.check_in), iso(a.check_out));
    const site = wantSite ? (free.includes(wantSite) ? wantSite : null) : free[0];
    if (!site) { await client.query('ROLLBACK'); return res.status(409).json({ error: wantSite ? `Site ${wantSite} is not free for those dates.` : 'No sites are free for those dates anymore.' }); }
    let q = {}; try { q = quote({ plan: a.plan, checkIn: iso(a.check_in), checkOut: iso(a.check_out), count: (a.stay_label || '').split(' ')[0] }); } catch (_) {}
    booking = (await client.query(
      `INSERT INTO bookings (site, check_in, check_out, plan, status, amount_cents, guest_name, guest_phone, guest_email,
                             rig_type, rig_length, power, pets, notes, hold_token, hold_expires, application_id)
       VALUES ($1,$2,$3,$4,'pending',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now() + ($15 || ' hours')::interval, $16) RETURNING *`,
      [site, a.check_in, a.check_out, a.plan, a.amount_cents, a.guest_name, a.guest_phone, a.guest_email, a.rig_type, a.rig_length, a.power, a.pets,
       q.note || null, crypto.randomBytes(16).toString('hex'), String(hours), a.id])).rows[0];
    a = (await client.query(`UPDATE applications SET status='approved', booking_id=$2, owner_note=$3, decided_at=now() WHERE id=$1 RETURNING *`, [a.id, booking.id, note || null])).rows[0];
    await client.query('COMMIT');
  } catch (e) { await client.query('ROLLBACK'); console.error(e); return res.status(500).json({ error: 'Could not approve. Try again.' }); }
  finally { client.release(); }

  const payBy = new Date(booking.hold_expires).toLocaleString('en-US', { timeZone: PARK.timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const emailed = await sendEmail(a.guest_email, `You're approved! Pay to lock in Site ${booking.site} · Riverfront Retreat`, emailWrap(
    `<h2 style="font-family:Georgia,serif;margin:0 0 8px">You're approved, ${escHtml(a.guest_name.split(' ')[0])}!</h2>
     <p>Your application for <b>${fmtDate(iso(a.check_in))} to ${fmtDate(iso(a.check_out))}</b> is approved, and we're holding <b>Site ${booking.site}</b> for you.</p>
     ${note ? `<p>${escHtml(note)}</p>` : ''}
     <p>Pay <b>${money(a.amount_cents)}</b> by <b>${payBy}</b> to confirm your stay:</p>
     <p><a href="${appLink(a)}" style="display:inline-block;background:#1C6B66;color:#fff;padding:12px 20px;border-radius:10px;text-decoration:none;font-weight:600">Pay and confirm my site</a></p>
     <p style="font-size:14px;color:#56635C">After you pay, you'll get your gate code and Wi-Fi details.</p>`)).catch(() => false);
  res.json({ ok: true, site: booking.site, emailed, url: appLink(a), payBy,
    text: `Hi ${a.guest_name.split(' ')[0]}, your application at Riverfront Retreat RV Park is approved! Site ${booking.site} is held for you until ${payBy}. Pay ${money(a.amount_cents)} here to confirm: ${appLink(a)}` });
});

app.post('/api/admin/applications/:id/deny', requireOwner, async (req, res) => {
  const note = clean((req.body || {}).message, 500);
  const { rows: [a] } = await pool.query(`UPDATE applications SET status='denied', owner_note=$2, decided_at=now() WHERE id=$1 AND status='pending' RETURNING *`, [req.params.id, note || null]);
  if (!a) return res.status(400).json({ error: 'This application was already handled.' });
  const emailed = (req.body || {}).notify === false ? false : await sendEmail(a.guest_email, 'About your application · Riverfront Retreat RV Park', emailWrap(
    `<p>Hi ${escHtml(a.guest_name.split(' ')[0])},</p><p>Thank you for applying for ${fmtDate(iso(a.check_in))} to ${fmtDate(iso(a.check_out))}. Unfortunately we aren't able to approve this stay.</p>${note ? `<p>${escHtml(note)}</p>` : ''}<p>Thank you for thinking of us.</p>`)).catch(() => false);
  res.json({ ok: true, emailed });
});

// ---------- Owner settings ----------
app.get('/api/admin/settings', requireOwner, async (req, res) => {
  res.json({ settings: await getSettings(), emailOn: !!RESEND_API_KEY, textOn: !!(TWILIO_SID && TWILIO_TOKEN && TWILIO_FROM) });
});
app.put('/api/admin/settings', requireOwner, async (req, res) => {
  const b = req.body || {};
  for (const k of SETTING_KEYS) {
    if (typeof b[k] !== 'string') continue;
    await pool.query(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [k, b[k].trim().slice(0, 500)]);
  }
  res.json({ settings: await getSettings() });
});
app.post('/api/admin/test-alert', requireOwner, async (req, res) => {
  const sent = await ownerAlert('✅ Test alert from your Riverfront Retreat booking site. New bookings will look like this.', 'Test alert from Riverfront Retreat');
  res.json({ ok: sent });
});
// Send (or resend) the confirmation + gate code email to a guest
app.post('/api/admin/bookings/:id/send-code', requireOwner, async (req, res) => {
  const { rows: [b] } = await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
  if (!b || !b.guest_email) return res.status(400).json({ error: 'This booking has no email address.' });
  if (!RESEND_API_KEY) return res.status(503).json({ error: 'Email sending is not set up yet.' });
  const st = await getSettings();
  const rows = stayLines(b, st).map(([k, v]) => `<tr><td style="padding:6px 16px 6px 0;color:#56635C">${k}</td><td style="padding:6px 0;font-weight:600">${escHtml(v)}</td></tr>`).join('');
  const ok = await sendEmail(b.guest_email, `Your gate code for Riverfront Retreat (Site ${b.site})`,
    `<div style="font:16px/1.5 -apple-system,Segoe UI,sans-serif;color:#16231E;max-width:520px"><p>Hi ${escHtml((b.guest_name || '').split(' ')[0])}, here are your stay details:</p><table style="border-collapse:collapse;margin:12px 0">${rows}</table>${st.checkin_note ? `<p>${escHtml(st.checkin_note)}</p>` : ''}<p>120 Old Hwy 24, New Augusta, MS 39462 · (601) 408-1851</p></div>`);
  res.status(ok ? 200 : 502).json(ok ? { ok: true } : { error: 'The email could not be sent.' });
});

app.get('/healthz', (req, res) => res.send(dbReady ? 'ok' : 'starting: database not connected yet'));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.listen(PORT, '0.0.0.0', () => console.log(`${PARK.name} booking server listening on port ${PORT} (${BASE_URL})`));

async function connectDb(attempt = 1) {
  if (!HAS_DB) return;
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
