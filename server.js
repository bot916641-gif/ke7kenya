/**
 * Aviator — single-process full-stack crash betting game.
 * Express + Socket.IO + PostgreSQL + M-Pesa Daraja (STK Push deposits, B2C withdrawals).
 *
 * Required env vars:
 *   DATABASE_URL          PostgreSQL connection string
 *   JWT_SECRET            Random string used to sign auth tokens
 *   ADMIN_USERNAME        Default: "admin"
 *   ADMIN_PASSWORD        Required for /admin-dashboard sign-in
 *
 * Optional M-Pesa env vars (deposits/withdrawals stay "pending" until set):
 *   MPESA_ENV               "sandbox" (default) or "production"
 *   MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET
 *   MPESA_SHORTCODE, MPESA_PASSKEY                  (STK Push)
 *   MPESA_INITIATOR_NAME, MPESA_INITIATOR_PASSWORD  (B2C)
 *   MPESA_CALLBACK_BASE_URL                         (public HTTPS URL of this server)
 */
require('dotenv').config();
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server: IOServer } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const { Pool } = require('pg');

// ───────────────────────── Config ─────────────────────────
const PORT = Number(process.env.PORT) || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin';
let JWT_SECRET = process.env.JWT_SECRET || ''; // auto-persisted on first boot if not provided

if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Link a PostgreSQL database and re-deploy.');
  process.exit(1);
}

const MPESA = {
  env: (process.env.MPESA_ENV || 'sandbox').toLowerCase(),
  consumerKey: process.env.MPESA_CONSUMER_KEY || '',
  consumerSecret: process.env.MPESA_CONSUMER_SECRET || '',
  shortcode: process.env.MPESA_SHORTCODE || '',
  passkey: process.env.MPESA_PASSKEY || '',
  initiator: process.env.MPESA_INITIATOR_NAME || '',
  initiatorPwd: process.env.MPESA_INITIATOR_PASSWORD || '',
  callbackBase: (process.env.MPESA_CALLBACK_BASE_URL || process.env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
};
const mpesaConfigured = () =>
  !!(MPESA.consumerKey && MPESA.consumerSecret && MPESA.shortcode && MPESA.passkey);
const mpesaB2CConfigured = () =>
  mpesaConfigured() && MPESA.initiator && MPESA.initiatorPwd;
const mpesaBaseUrl = () =>
  MPESA.env === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

// ───────────────────────── Database ─────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
});
const q = (text, params) => pool.query(text, params);

async function ensureSchema() {
  await q(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance NUMERIC(14,2) NOT NULL DEFAULT 0,
      is_banned BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS rounds (
      id SERIAL PRIMARY KEY,
      seed TEXT NOT NULL,
      seed_hash TEXT NOT NULL,
      crash_multiplier NUMERIC(10,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      started_at TIMESTAMPTZ,
      crashed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bets (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      round_id INT NOT NULL REFERENCES rounds(id) ON DELETE CASCADE,
      amount NUMERIC(14,2) NOT NULL,
      auto_cashout NUMERIC(10,2),
      cashed_out_at NUMERIC(10,2),
      payout NUMERIC(14,2) NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'placed',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      phone TEXT,
      reference TEXT,
      meta JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value NUMERIC NOT NULL
    );
    CREATE TABLE IF NOT EXISTS app_secrets (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const defaults = {
    bet_phase_seconds: 8,
    min_bet: 10,
    max_bet: 10000,
    house_edge: 0.03,
    max_multiplier_cap: 1000,
    starting_bonus: 0,
  };
  for (const [k, v] of Object.entries(defaults)) {
    await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO NOTHING', [k, v]);
  }
}
async function getSettings() {
  const r = await q('SELECT key,value FROM settings');
  const out = {};
  for (const row of r.rows) out[row.key] = Number(row.value);
  return out;
}
async function ensureJwtSecret() {
  if (JWT_SECRET) return;
  const r = await q("SELECT value FROM app_secrets WHERE key='jwt_secret'");
  if (r.rowCount) {
    JWT_SECRET = r.rows[0].value;
    return;
  }
  JWT_SECRET = crypto.randomBytes(32).toString('hex');
  await q(
    "INSERT INTO app_secrets(key,value) VALUES('jwt_secret',$1) ON CONFLICT (key) DO NOTHING",
    [JWT_SECRET],
  );
  console.warn('JWT_SECRET env var not set — generated and persisted one in the database.');
}

// ───────────────────────── Auth helpers ─────────────────────────
function signUserToken(user) {
  return jwt.sign({ uid: user.id, u: user.username }, JWT_SECRET, { expiresIn: '30d' });
}
function signAdminToken() {
  return jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '12h' });
}
function readBearer(req) {
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7);
  return null;
}
async function requireUser(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) return res.status(401).json({ error: 'Unauthorized' });
    const data = jwt.verify(token, JWT_SECRET);
    if (!data.uid) return res.status(401).json({ error: 'Unauthorized' });
    const r = await q('SELECT id,username,balance,is_banned FROM users WHERE id=$1', [data.uid]);
    if (!r.rowCount) return res.status(401).json({ error: 'Unauthorized' });
    if (r.rows[0].is_banned) return res.status(403).json({ error: 'Account banned' });
    req.user = r.rows[0];
    next();
  } catch (e) {
    res.status(401).json({ error: 'Unauthorized' });
  }
}
function requireAdmin(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) return res.status(401).json({ error: 'Admin login required' });
    const d = jwt.verify(token, JWT_SECRET);
    if (!d.admin) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch {
    res.status(401).json({ error: 'Admin login required' });
  }
}

// ───────────────────────── M-Pesa ─────────────────────────
function normalisePhone(p) {
  let s = String(p || '').replace(/\D/g, '');
  if (s.startsWith('0')) s = '254' + s.slice(1);
  if (s.startsWith('7') || s.startsWith('1')) s = '254' + s;
  if (s.startsWith('+')) s = s.slice(1);
  return s;
}
async function mpesaToken() {
  const auth = Buffer.from(`${MPESA.consumerKey}:${MPESA.consumerSecret}`).toString('base64');
  const { data } = await axios.get(
    `${mpesaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` }, timeout: 15000 },
  );
  return data.access_token;
}
async function mpesaStkPush({ phone, amount, accountRef, description, callbackUrl }) {
  const token = await mpesaToken();
  const ts = new Date()
    .toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const password = Buffer.from(`${MPESA.shortcode}${MPESA.passkey}${ts}`).toString('base64');
  const { data } = await axios.post(
    `${mpesaBaseUrl()}/mpesa/stkpush/v1/processrequest`,
    {
      BusinessShortCode: MPESA.shortcode,
      Password: password,
      Timestamp: ts,
      TransactionType: 'CustomerPayBillOnline',
      Amount: Math.round(amount),
      PartyA: phone,
      PartyB: MPESA.shortcode,
      PhoneNumber: phone,
      CallBackURL: callbackUrl,
      AccountReference: accountRef,
      TransactionDesc: description,
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 },
  );
  return data;
}
async function mpesaB2C({ phone, amount, remarks, resultUrl, queueTimeoutUrl }) {
  const token = await mpesaToken();
  // Encrypt initiator password with M-Pesa public cert. In sandbox the password
  // can be sent plain or pre-encrypted by Safaricom's docs; here we send as-is
  // so the user can paste an already-encrypted SecurityCredential.
  const { data } = await axios.post(
    `${mpesaBaseUrl()}/mpesa/b2c/v1/paymentrequest`,
    {
      InitiatorName: MPESA.initiator,
      SecurityCredential: MPESA.initiatorPwd,
      CommandID: 'BusinessPayment',
      Amount: Math.round(amount),
      PartyA: MPESA.shortcode,
      PartyB: phone,
      Remarks: remarks,
      QueueTimeOutURL: queueTimeoutUrl,
      ResultURL: resultUrl,
      Occasion: 'AviatorWithdrawal',
    },
    { headers: { Authorization: `Bearer ${token}` }, timeout: 20000 },
  );
  return data;
}

// ───────────────────────── Game engine ─────────────────────────
let currentRound = null;     // { id, seed, hash, crash, startedAt, status }
let phaseTimer = null;
let tickTimer = null;
let bettingClosesAt = 0;
const liveBets = new Map(); // userId -> { betId, amount, autoCashout, username }
const recentRounds = [];     // array of { id, crash }
let ioRef = null;

function provablyFairCrash(seed, edge, cap) {
  // Standard "instant 1.00x with house edge" model.
  const h = crypto.createHmac('sha256', seed).update('crashpoint').digest();
  const intVal = h.readUInt32BE(0);
  if (intVal % Math.floor(1 / Math.max(edge, 0.0001)) === 0) return 1.0;
  const e = 2 ** 32;
  const raw = (100 * e - intVal) / (e - intVal) / 100;
  return Math.max(1.0, Math.min(cap, Math.floor(raw * 100) / 100));
}

async function startGameLoop(io) {
  ioRef = io;
  await runPhaseBetting();
}
function broadcastState(extra = {}) {
  if (!ioRef) return;
  ioRef.emit('state', {
    round: currentRound
      ? {
          id: currentRound.id,
          status: currentRound.status,
          hash: currentRound.hash,
          startedAt: currentRound.startedAt,
          crash: currentRound.status === 'crashed' ? currentRound.crash : null,
          seed: currentRound.status === 'crashed' ? currentRound.seed : null,
        }
      : null,
    bettingClosesAt,
    liveBets: [...liveBets.entries()].map(([uid, b]) => ({
      userId: uid, username: b.username, amount: b.amount,
      autoCashout: b.autoCashout, cashedAt: b.cashedAt || null,
    })),
    history: recentRounds.slice(-30),
    ...extra,
  });
}
async function runPhaseBetting() {
  clearTimeout(phaseTimer); clearInterval(tickTimer);
  const settings = await getSettings();
  const seed = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  const crash = provablyFairCrash(seed, settings.house_edge, settings.max_multiplier_cap);
  const r = await q(
    `INSERT INTO rounds(seed, seed_hash, crash_multiplier, status)
     VALUES($1,$2,$3,'betting') RETURNING id`,
    [seed, hash, crash],
  );
  currentRound = { id: r.rows[0].id, seed, hash, crash, status: 'betting', startedAt: null };
  liveBets.clear();
  bettingClosesAt = Date.now() + settings.bet_phase_seconds * 1000;
  broadcastState();
  phaseTimer = setTimeout(runPhasePlaying, settings.bet_phase_seconds * 1000);
}
async function runPhasePlaying() {
  if (!currentRound) return;
  currentRound.status = 'playing';
  currentRound.startedAt = Date.now();
  await q('UPDATE rounds SET status=$1, started_at=NOW() WHERE id=$2', ['playing', currentRound.id]);
  broadcastState();
  tickTimer = setInterval(async () => {
    try {
      if (!currentRound || currentRound.status !== 'playing') return;
      const t = (Date.now() - currentRound.startedAt) / 1000;
      const m = Math.max(1, Math.pow(1.07, t));
      // auto-cashouts
      for (const [uid, b] of liveBets) {
        if (b.cashedAt) continue;
        if (b.autoCashout && m >= b.autoCashout) await performCashout(uid, b.autoCashout);
      }
      if (m >= currentRound.crash) {
        clearInterval(tickTimer); tickTimer = null;
        await runPhaseCrashed();
        return;
      }
      if (ioRef) ioRef.emit('tick', { multiplier: Math.floor(m * 100) / 100 });
    } catch (e) {
      console.error('tick error', e);
    }
  }, 100);
}
async function runPhaseCrashed() {
  if (!currentRound) return;
  currentRound.status = 'crashed';
  await q('UPDATE rounds SET status=$1, crashed_at=NOW() WHERE id=$2', ['crashed', currentRound.id]);
  // Mark all uncashed bets as lost.
  await q(
    `UPDATE bets SET status='lost' WHERE round_id=$1 AND status='placed'`,
    [currentRound.id],
  );
  recentRounds.push({ id: currentRound.id, crash: currentRound.crash });
  if (recentRounds.length > 50) recentRounds.shift();
  if (ioRef) ioRef.emit('crash', { multiplier: currentRound.crash, seed: currentRound.seed });
  broadcastState();
  // Brief intermission, then next round.
  setTimeout(() => { runPhaseBetting().catch(console.error); }, 3000);
}
async function placeBet(userId, username, amount, autoCashout) {
  if (!currentRound || currentRound.status !== 'betting')
    throw new Error('Betting is closed');
  const settings = await getSettings();
  amount = Math.floor(Number(amount));
  if (!amount || amount < settings.min_bet) throw new Error(`Minimum bet is ${settings.min_bet}`);
  if (amount > settings.max_bet) throw new Error(`Maximum bet is ${settings.max_bet}`);
  if (liveBets.has(userId)) throw new Error('Bet already placed for this round');
  // Atomic balance check + debit + bet insert.
  const client = await pool.connect();
  let betId;
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [userId]);
    if (!u.rowCount) throw new Error('User not found');
    if (Number(u.rows[0].balance) < amount) throw new Error('Insufficient balance');
    await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [amount, userId]);
    const ins = await client.query(
      `INSERT INTO bets(user_id, round_id, amount, auto_cashout)
       VALUES($1,$2,$3,$4) RETURNING id`,
      [userId, currentRound.id, amount, autoCashout || null],
    );
    betId = ins.rows[0].id;
    await client.query(
      `INSERT INTO transactions(user_id, type, amount, status, reference)
       VALUES($1,'bet',$2,'completed',$3)`,
      [userId, amount, `round:${currentRound.id}`],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally { client.release(); }
  liveBets.set(userId, { betId, amount, autoCashout: autoCashout || null, username });
  broadcastState();
  return { betId };
}
async function performCashout(userId, multiplier) {
  const b = liveBets.get(userId);
  if (!b || b.cashedAt) return null;
  if (!currentRound || currentRound.status !== 'playing') return null;
  const m = Math.floor(Number(multiplier) * 100) / 100;
  if (m < 1) return null;
  const payout = Math.floor(b.amount * m * 100) / 100;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const upd = await client.query(
      `UPDATE bets SET cashed_out_at=$1, payout=$2, status='won' WHERE id=$3 AND status='placed'`,
      [m, payout, b.betId],
    );
    if (upd.rowCount === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [payout, userId]);
    await client.query(
      `INSERT INTO transactions(user_id, type, amount, status, reference)
       VALUES($1,'payout',$2,'completed',$3)`,
      [userId, payout, `round:${currentRound.id}@${m}x`],
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); console.error('cashout error', e); return null;
  } finally { client.release(); }
  b.cashedAt = m; b.payout = payout;
  if (ioRef) ioRef.emit('cashout', { userId, username: b.username, multiplier: m, payout });
  broadcastState();
  return { multiplier: m, payout };
}
async function userCashout(userId) {
  if (!currentRound || currentRound.status !== 'playing')
    throw new Error('Round not running');
  const t = (Date.now() - currentRound.startedAt) / 1000;
  const m = Math.max(1, Math.pow(1.07, t));
  if (m >= currentRound.crash) throw new Error('Too late, plane crashed');
  const r = await performCashout(userId, m);
  if (!r) throw new Error('No active bet');
  return r;
}

// ───────────────────────── HTTP / API ─────────────────────────
const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: true, credentials: true } });

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '512kb' }));

const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR, { index: false, maxAge: '1h' }));

app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Player auth
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const u = String(username || '').trim().toLowerCase();
    const p = String(password || '');
    if (!/^[a-z0-9_]{3,32}$/.test(u))
      return res.status(400).json({ error: 'Username must be 3-32 chars (a-z, 0-9, _)' });
    if (p.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    const settings = await getSettings();
    const hash = await bcrypt.hash(p, 10);
    const r = await q(
      `INSERT INTO users(username, password_hash, balance) VALUES($1,$2,$3)
       RETURNING id, username, balance`,
      [u, hash, settings.starting_bonus || 0],
    );
    const user = r.rows[0];
    res.json({ token: signUserToken(user), user });
  } catch (e) {
    if (String(e.message).includes('duplicate'))
      return res.status(409).json({ error: 'Username already taken' });
    res.status(500).json({ error: e.message });
  }
});
app.post('/api/auth/login', async (req, res) => {
  try {
    const u = String((req.body || {}).username || '').trim().toLowerCase();
    const p = String((req.body || {}).password || '');
    const r = await q('SELECT id,username,password_hash,balance,is_banned FROM users WHERE username=$1', [u]);
    if (!r.rowCount) return res.status(401).json({ error: 'Invalid username or password' });
    const ok = await bcrypt.compare(p, r.rows[0].password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid username or password' });
    if (r.rows[0].is_banned) return res.status(403).json({ error: 'Account banned' });
    const user = { id: r.rows[0].id, username: r.rows[0].username, balance: r.rows[0].balance };
    res.json({ token: signUserToken(user), user });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/auth/me', requireUser, (req, res) => res.json({ user: req.user }));

app.get('/api/transactions', requireUser, async (req, res) => {
  const r = await q(
    'SELECT id,type,amount,status,phone,reference,created_at FROM transactions WHERE user_id=$1 ORDER BY id DESC LIMIT 100',
    [req.user.id],
  );
  res.json({ transactions: r.rows });
});

// Payments
app.get('/api/payments/status', (req, res) => {
  res.json({ env: MPESA.env, mpesaConfigured: mpesaConfigured(), mpesaB2CConfigured: mpesaB2CConfigured() });
});
app.post('/api/payments/deposit', requireUser, async (req, res) => {
  try {
    const amount = Number((req.body || {}).amount);
    const phone = normalisePhone((req.body || {}).phone);
    if (!Number.isFinite(amount) || amount < 1)
      return res.status(400).json({ error: 'Invalid amount' });
    if (!/^2547\d{8}$/.test(phone) && !/^2541\d{8}$/.test(phone))
      return res.status(400).json({ error: 'Invalid Kenyan phone number' });
    const ins = await q(
      `INSERT INTO transactions(user_id, type, amount, status, phone)
       VALUES($1,'deposit',$2,'pending',$3) RETURNING id`,
      [req.user.id, amount, phone],
    );
    const txId = ins.rows[0].id;
    if (!mpesaConfigured()) {
      return res.json({
        ok: true,
        message: 'M-Pesa not configured yet. Once admin sets MPESA_* env vars, this will trigger STK Push.',
        transactionId: txId,
      });
    }
    const cb = `${MPESA.callbackBase || ''}/api/payments/mpesa/stk-callback`;
    const r = await mpesaStkPush({
      phone, amount, accountRef: `AVT${txId}`,
      description: `Aviator deposit ${txId}`, callbackUrl: cb,
    });
    await q('UPDATE transactions SET reference=$1, meta=$2 WHERE id=$3',
      [r.CheckoutRequestID || null, r, txId]);
    res.json({ ok: true, message: 'STK Push sent. Approve on your phone.', transactionId: txId });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.errorMessage || e.message });
  }
});
app.post('/api/payments/withdraw', requireUser, async (req, res) => {
  try {
    const amount = Number((req.body || {}).amount);
    const phone = normalisePhone((req.body || {}).phone);
    if (!Number.isFinite(amount) || amount < 1)
      return res.status(400).json({ error: 'Invalid amount' });
    if (!/^2547\d{8}$/.test(phone) && !/^2541\d{8}$/.test(phone))
      return res.status(400).json({ error: 'Invalid Kenyan phone number' });
    // Atomic debit
    const client = await pool.connect();
    let txId;
    try {
      await client.query('BEGIN');
      const u = await client.query('SELECT balance FROM users WHERE id=$1 FOR UPDATE', [req.user.id]);
      if (Number(u.rows[0].balance) < amount) throw new Error('Insufficient balance');
      await client.query('UPDATE users SET balance = balance - $1 WHERE id=$2', [amount, req.user.id]);
      const ins = await client.query(
        `INSERT INTO transactions(user_id, type, amount, status, phone)
         VALUES($1,'withdrawal',$2,'pending',$3) RETURNING id`,
        [req.user.id, amount, phone],
      );
      txId = ins.rows[0].id;
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: e.message });
    } finally { client.release(); }
    if (!mpesaB2CConfigured()) {
      return res.json({
        ok: true,
        message: 'Withdrawal queued. M-Pesa B2C not configured yet — admin will release manually.',
        transactionId: txId,
      });
    }
    const base = MPESA.callbackBase || '';
    try {
      const r = await mpesaB2C({
        phone, amount,
        remarks: `Aviator withdrawal ${txId}`,
        resultUrl: `${base}/api/payments/mpesa/b2c-result`,
        queueTimeoutUrl: `${base}/api/payments/mpesa/b2c-timeout`,
      });
      await q('UPDATE transactions SET reference=$1, meta=$2 WHERE id=$3',
        [r.ConversationID || null, r, txId]);
      res.json({ ok: true, message: 'Withdrawal requested. You will receive an M-Pesa SMS.', transactionId: txId });
    } catch (e) {
      // Refund on B2C failure.
      await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [amount, req.user.id]);
      await q(`UPDATE transactions SET status='failed', meta=$1 WHERE id=$2`,
        [{ error: e.response?.data || e.message }, txId]);
      res.status(500).json({ error: e.response?.data?.errorMessage || e.message });
    }
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/payments/mpesa/stk-callback', async (req, res) => {
  try {
    const cb = req.body?.Body?.stkCallback || {};
    const checkoutId = cb.CheckoutRequestID;
    const resultCode = cb.ResultCode;
    if (!checkoutId) return res.json({ ok: true });
    const r = await q('SELECT id,user_id,amount,status FROM transactions WHERE reference=$1 AND type=$2', [checkoutId, 'deposit']);
    if (!r.rowCount) return res.json({ ok: true });
    const tx = r.rows[0];
    if (tx.status !== 'pending') return res.json({ ok: true });
    if (resultCode === 0) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE transactions SET status='completed', meta=$1 WHERE id=$2`, [cb, tx.id]);
        await client.query('UPDATE users SET balance = balance + $1 WHERE id=$2', [tx.amount, tx.user_id]);
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    } else {
      await q(`UPDATE transactions SET status='failed', meta=$1 WHERE id=$2`, [cb, tx.id]);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.json({ ok: true }); }
});
app.post('/api/payments/mpesa/b2c-result', async (req, res) => {
  try {
    const r = req.body?.Result || {};
    const ref = r.ConversationID;
    const tx = (await q('SELECT id,user_id,amount,status FROM transactions WHERE reference=$1 AND type=$2', [ref, 'withdrawal'])).rows[0];
    if (!tx || tx.status !== 'pending') return res.json({ ok: true });
    if (r.ResultCode === 0) {
      await q(`UPDATE transactions SET status='completed', meta=$1 WHERE id=$2`, [r, tx.id]);
    } else {
      await q(`UPDATE transactions SET status='failed', meta=$1 WHERE id=$2`, [r, tx.id]);
      await q(`UPDATE users SET balance = balance + $1 WHERE id=$2`, [tx.amount, tx.user_id]);
    }
    res.json({ ok: true });
  } catch (e) { console.error(e); res.json({ ok: true }); }
});
app.post('/api/payments/mpesa/b2c-timeout', (req, res) => res.json({ ok: true }));

// Admin
app.post('/api/admin/login', (req, res) => {
  const u = String((req.body || {}).username || '');
  const p = String((req.body || {}).password || '');
  if (!ADMIN_PASSWORD) return res.status(500).json({ error: 'ADMIN_PASSWORD env var not set' });
  if (u !== ADMIN_USERNAME || p !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Invalid admin credentials' });
  res.json({ token: signAdminToken() });
});
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const [users, dep, wd, bets, last] = await Promise.all([
    q('SELECT COUNT(*)::int AS n, COALESCE(SUM(balance),0)::float AS bal FROM users'),
    q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS s FROM transactions WHERE type='deposit' AND status='completed'`),
    q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS s FROM transactions WHERE type='withdrawal' AND status='completed'`),
    q(`SELECT COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS s FROM bets WHERE created_at > NOW() - INTERVAL '24 hours'`),
    q(`SELECT id, crash_multiplier, status FROM rounds ORDER BY id DESC LIMIT 1`),
  ]);
  res.json({
    users: { total: users.rows[0].n, totalBalance: users.rows[0].bal },
    deposits: { count: dep.rows[0].n, total: dep.rows[0].s },
    withdrawals: { count: wd.rows[0].n, total: wd.rows[0].s },
    bets24h: { count: bets.rows[0].n, total: bets.rows[0].s },
    activePlayers: liveBets.size,
    lastRound: last.rows[0] || null,
  });
});
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const s = String(req.query.search || '').toLowerCase();
  const r = s
    ? await q('SELECT id,username,balance,is_banned,created_at FROM users WHERE username ILIKE $1 ORDER BY id DESC LIMIT 200', [`%${s}%`])
    : await q('SELECT id,username,balance,is_banned,created_at FROM users ORDER BY id DESC LIMIT 200');
  res.json({ users: r.rows });
});
app.patch('/api/admin/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { ban, balanceDelta, setBalance } = req.body || {};
  if (typeof ban === 'boolean')
    await q('UPDATE users SET is_banned=$1 WHERE id=$2', [ban, id]);
  if (Number.isFinite(Number(balanceDelta))) {
    const d = Number(balanceDelta);
    await q('UPDATE users SET balance = balance + $1 WHERE id=$2', [d, id]);
    await q(`INSERT INTO transactions(user_id, type, amount, status, reference) VALUES($1,$2,$3,'completed',$4)`,
      [id, d >= 0 ? 'admin_credit' : 'admin_debit', Math.abs(d), 'admin_adjust']);
  }
  if (Number.isFinite(Number(setBalance))) {
    await q('UPDATE users SET balance=$1 WHERE id=$2', [Number(setBalance), id]);
    await q(`INSERT INTO transactions(user_id, type, amount, status, reference) VALUES($1,'admin_credit',$2,'completed','admin_set')`,
      [id, Number(setBalance)]);
  }
  const r = await q('SELECT id,username,balance,is_banned,created_at FROM users WHERE id=$1', [id]);
  res.json({ user: r.rows[0] });
});
app.get('/api/admin/transactions', requireAdmin, async (req, res) => {
  const type = String(req.query.type || '');
  const sql = `
    SELECT t.id,t.type,t.amount,t.status,t.phone,t.reference,t.created_at,u.username
    FROM transactions t JOIN users u ON u.id=t.user_id
    ${type ? 'WHERE t.type=$1' : ''}
    ORDER BY t.id DESC LIMIT 300`;
  const r = await q(sql, type ? [type] : []);
  res.json({ transactions: r.rows });
});
app.get('/api/admin/rounds', requireAdmin, async (req, res) => {
  const r = await q('SELECT id,crash_multiplier,status,started_at,crashed_at,seed_hash FROM rounds ORDER BY id DESC LIMIT 50');
  res.json({ rounds: r.rows });
});
app.get('/api/admin/settings', requireAdmin, async (req, res) => {
  res.json({ settings: await getSettings() });
});
app.patch('/api/admin/settings', requireAdmin, async (req, res) => {
  const updates = req.body || {};
  for (const [k, v] of Object.entries(updates)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    await q('INSERT INTO settings(key,value) VALUES($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [k, n]);
  }
  res.json({ settings: await getSettings() });
});

// SPA routes
app.get(['/admin-dashboard', '/admin-dashboard/*'], (req, res) =>
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html')),
);
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ───────────────────────── Sockets ─────────────────────────
io.use((socket, next) => {
  const token = socket.handshake.auth?.token || socket.handshake.query?.token;
  if (!token) return next(); // anonymous spectators allowed
  try {
    const d = jwt.verify(String(token), JWT_SECRET);
    if (d.uid) socket.data.user = { id: d.uid, username: d.u };
  } catch {}
  next();
});
io.on('connection', (socket) => {
  // Send initial state to the new client.
  socket.emit('state', {
    round: currentRound ? {
      id: currentRound.id, status: currentRound.status, hash: currentRound.hash,
      startedAt: currentRound.startedAt,
      crash: currentRound.status === 'crashed' ? currentRound.crash : null,
      seed: currentRound.status === 'crashed' ? currentRound.seed : null,
    } : null,
    bettingClosesAt,
    liveBets: [...liveBets.entries()].map(([uid, b]) => ({
      userId: uid, username: b.username, amount: b.amount,
      autoCashout: b.autoCashout, cashedAt: b.cashedAt || null,
    })),
    history: recentRounds.slice(-30),
  });
  socket.on('placeBet', async ({ amount, autoCashout }, cb) => {
    try {
      if (!socket.data.user) throw new Error('Please sign in to place a bet');
      const r = await placeBet(socket.data.user.id, socket.data.user.username, amount, autoCashout);
      const u = await q('SELECT balance FROM users WHERE id=$1', [socket.data.user.id]);
      cb && cb({ ok: true, betId: r.betId, balance: Number(u.rows[0].balance) });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });
  socket.on('cashout', async (_p, cb) => {
    try {
      if (!socket.data.user) throw new Error('Please sign in');
      const r = await userCashout(socket.data.user.id);
      const u = await q('SELECT balance FROM users WHERE id=$1', [socket.data.user.id]);
      cb && cb({ ok: true, ...r, balance: Number(u.rows[0].balance) });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });
});

// ───────────────────────── Boot ─────────────────────────
process.on('unhandledRejection', (e) => console.error('unhandledRejection', e));
process.on('uncaughtException', (e) => console.error('uncaughtException', e));

(async () => {
  await ensureSchema();
  await ensureJwtSecret();
  await startGameLoop(io);
  server.listen(PORT, HOST, () => {
    console.log(`Aviator listening on http://${HOST}:${PORT}`);
    console.log(`  mpesa: ${MPESA.env} (configured=${mpesaConfigured()})`);
    console.log(`  admin: username=${ADMIN_USERNAME} password=${process.env.ADMIN_PASSWORD ? '(env)' : 'admin (DEFAULT — change ADMIN_PASSWORD env var!)'}`);
    console.log(`  jwt:   ${process.env.JWT_SECRET ? '(env)' : '(auto-persisted in DB)'}`);
  });
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
