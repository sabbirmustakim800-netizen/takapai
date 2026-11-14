import express from 'express';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { q, audit } from './db.js';
import {
  HttpError,
  nowIso,
  newId,
  newToken,
  toCents,
  formatCents,
  normalizeMsisdn,
  normalizeTrxId,
  createRateLimiter,
  clientIp,
  PROVIDERS,
  PROVIDER_LABELS,
} from './util.js';
import {
  hashPassword,
  verifyPassword,
  createSession,
  destroySession,
  requireMerchant,
  requireDevice,
  generateDeviceKey,
  purgeExpiredSessions,
} from './auth.js';
import { ingestBatch, validateEventPayload, processEvent } from './ingest.js';
import { findEventForOrder, claim, expireOrders, pruneOldEvents, AlreadyConsumedError } from './matcher.js';
import { runWebhook } from './webhook.js';
import { parseMfsMessage } from './parser.js';
import {
  configView,
  getConfigRow,
  saveConfig,
  buildConfig,
  removeConfig,
  runBackup,
  listBackups,
  restoreBackup,
  testConnection,
  dbInfo,
  startBackupScheduler,
  PROVIDER_PRESETS,
} from './backup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_TTL = Number(process.env.DEFAULT_ORDER_TTL_SECONDS || 1800);
const DEFAULT_BEFORE_WINDOW = Number(process.env.DEFAULT_MATCH_WINDOW_BEFORE_SECONDS || 300);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/* ─────────────────────────── নিরাপত্তা হেডার ─────────────────────────── */

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'",
  );
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

app.use(express.json({ limit: '256kb' }));

/* ─────────────────────────── রেট লিমিটার ─────────────────────────── */

const loginLimiter = createRateLimiter({ windowMs: 15 * 60_000, max: 20, name: 'login' });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60_000, max: 10, name: 'register' });
const ingestLimiter = createRateLimiter({ windowMs: 60_000, max: 180, name: 'ingest' });
const apiLimiter = createRateLimiter({ windowMs: 60_000, max: 600, name: 'api' });
const pairLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 30, name: 'pair' });

/* ─────────────────────────── সহায়ক ─────────────────────────── */

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function parseLimit(value, fallback = 50, max = 200) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

function orderView(row, eventRow = null) {
  return {
    id: row.id,
    provider: row.provider,
    provider_label: PROVIDER_LABELS[row.provider] || row.provider,
    amount: formatCents(row.amount_cents),
    amount_cents: row.amount_cents,
    sender_msisdn: row.sender_msisdn,
    trx_id: row.trx_id,
    reference: row.reference,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    matched_at: row.matched_at,
    note: row.note,
    matched_event: eventRow
      ? {
          id: eventRow.id,
          trx_id: eventRow.trx_id,
          sender_msisdn: eventRow.sender_msisdn,
          received_at: eventRow.received_at,
          source: eventRow.source,
          raw_text: eventRow.raw_text,
        }
      : null,
  };
}

function eventView(row) {
  return {
    id: row.id,
    provider: row.provider,
    provider_label: PROVIDER_LABELS[row.provider] || row.provider,
    source: row.source,
    sender_address: row.sender_address,
    direction: row.direction,
    status: row.status,
    amount: row.amount_cents != null ? formatCents(row.amount_cents) : null,
    amount_cents: row.amount_cents,
    trx_id: row.trx_id,
    sender_msisdn: row.sender_msisdn,
    balance: row.balance_cents != null ? formatCents(row.balance_cents) : null,
    received_at: row.received_at,
    ingested_at: row.ingested_at,
    matched_order_id: row.matched_order_id,
    reason: row.reason,
    raw_text: row.raw_text,
    device_id: row.device_id,
  };
}

function deviceView(row) {
  return {
    id: row.id,
    label: row.label,
    device_uid: row.device_uid,
    key_prefix: row.key_prefix + '…',
    status: row.status,
    platform: row.platform,
    app_version: row.app_version,
    last_seen_at: row.last_seen_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at,
  };
}

const PAIR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newPairingCode() {
  const bytes = crypto.randomBytes(8);
  let out = '';
  for (let i = 0; i < 8; i += 1) out += PAIR_ALPHABET[bytes[i] % PAIR_ALPHABET.length];
  return out;
}

function getSimulatorDevice(merchantId) {
  const id = `dev_sim_${merchantId}`;
  let device = q.get('SELECT * FROM devices WHERE id = ?', id);
  if (!device) {
    q.run(
      `INSERT INTO devices (id, merchant_id, label, device_uid, key_hash, key_prefix, status, platform, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      merchantId,
      'টেস্ট সিমুলেটর',
      `simulator_${merchantId}`,
      'not-a-real-key',
      'sim',
      'active',
      'simulator',
      nowIso(),
    );
    device = q.get('SELECT * FROM devices WHERE id = ?', id);
  }
  return device;
}

/* ═══════════════════════════ স্বাস্থ্য ═══════════════════════════ */

app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'taka-match', time: nowIso() });
});

/* ═══════════════════════════ অ্যাকাউন্ট ═══════════════════════════ */

app.post('/api/auth/register', registerLimiter, (req, res) => {
  const businessName = String(req.body?.business_name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  if (businessName.length < 2 || businessName.length > 80) {
    throw new HttpError(400, 'bad_request', 'ব্যবসার নাম ২–৮০ অক্ষরের হতে হবে');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 160) {
    throw new HttpError(400, 'bad_request', 'সঠিক ইমেইল দিন');
  }
  if (password.length < 8 || password.length > 200) {
    throw new HttpError(400, 'bad_request', 'পাসওয়ার্ড কমপক্ষে ৮ অক্ষরের হতে হবে');
  }

  const exists = q.get('SELECT id FROM merchants WHERE email = ?', email);
  if (exists) throw new HttpError(409, 'email_taken', 'এই ইমেইল দিয়ে ইতিমধ্যে অ্যাকাউন্ট আছে');

  const id = newId('mch');
  q.run(
    `INSERT INTO merchants
      (id, business_name, email, password_hash, webhook_secret, order_ttl_seconds,
       match_window_before_seconds, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    businessName,
    email,
    hashPassword(password),
    `whsec_${newToken(24)}`,
    DEFAULT_TTL,
    DEFAULT_BEFORE_WINDOW,
    nowIso(),
  );

  audit(id, 'merchant', 'account.registered', { email });
  const session = createSession(id);
  res.status(201).json({ token: session.token, expires_at: session.expiresAt });
});

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');

  const merchant = q.get('SELECT * FROM merchants WHERE email = ?', email);
  // টাইমিং অ্যাটাক এড়াতে ভুল ইমেইলেও হ্যাশ চালাই
  const ok = merchant
    ? verifyPassword(password, merchant.password_hash)
    : verifyPassword(password, 'scrypt$00$00');
  if (!merchant || !ok) {
    throw new HttpError(401, 'invalid_credentials', 'ইমেইল বা পাসওয়ার্ড ভুল');
  }

  const session = createSession(merchant.id);
  audit(merchant.id, 'merchant', 'account.login', { ip: clientIp(req) });
  res.json({ token: session.token, expires_at: session.expiresAt });
});

app.post('/api/auth/logout', requireMerchant, (req, res) => {
  destroySession(req.sessionToken);
  res.json({ ok: true });
});

app.get('/api/me', requireMerchant, (req, res) => {
  const m = req.merchant;
  res.json({
    merchant: {
      id: m.id,
      business_name: m.business_name,
      email: m.email,
      webhook_url: m.webhook_url,
      webhook_secret: m.webhook_secret,
      order_ttl_seconds: m.order_ttl_seconds,
      match_window_before_seconds: m.match_window_before_seconds,
      created_at: m.created_at,
    },
  });
});

/* ═══════════════════════════ ডিভাইস ═══════════════════════════ */

app.get('/api/devices', requireMerchant, apiLimiter, (req, res) => {
  const rows = q.all(
    `SELECT * FROM devices
      WHERE merchant_id = ? AND platform <> 'simulator'
      ORDER BY created_at DESC`,
    req.merchant.id,
  );
  res.json({ devices: rows.map(deviceView) });
});

/** ড্যাশবোর্ড থেকে সরাসরি ডিভাইস তৈরি — কী শুধু এই একবারই দেখায় */
app.post('/api/devices', requireMerchant, apiLimiter, (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 60) || 'আমার ফোন';
  const { key, keyHash, keyPrefix } = generateDeviceKey();
  const id = newId('dev');
  const deviceUid = `dev_${crypto.randomBytes(9).toString('hex')}`;

  q.run(
    `INSERT INTO devices (id, merchant_id, label, device_uid, key_hash, key_prefix, status, platform, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 'android', ?)`,
    id,
    req.merchant.id,
    label,
    deviceUid,
    keyHash,
    keyPrefix,
    nowIso(),
  );

  audit(req.merchant.id, 'merchant', 'device.created', { deviceId: id, label });
  res.status(201).json({
    device: deviceView(q.get('SELECT * FROM devices WHERE id = ?', id)),
    credentials: { device_id: deviceUid, device_key: key },
    warning: 'এই কী আর কখনো দেখানো হবে না — এখনই নিরাপদে সংরক্ষণ করুন।',
  });
});

app.post('/api/devices/:id/revoke', requireMerchant, apiLimiter, (req, res) => {
  const device = q.get(
    'SELECT * FROM devices WHERE id = ? AND merchant_id = ?',
    req.params.id,
    req.merchant.id,
  );
  if (!device) throw new HttpError(404, 'not_found', 'ডিভাইস পাওয়া যায়নি');
  if (device.platform === 'simulator') throw new HttpError(400, 'bad_request', 'সিমুলেটর বাতিল করা যায় না');

  q.run("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE id = ?", nowIso(), device.id);
  audit(req.merchant.id, 'merchant', 'device.revoked', { deviceId: device.id });
  res.json({ ok: true });
});

/** পেয়ারিং কোড — অ্যাপে টাইপ করলেই ওই ইনস্টল নিজের ইউনিক কী পাবে */
app.post('/api/pairing-codes', requireMerchant, apiLimiter, (req, res) => {
  const label = String(req.body?.label || '').trim().slice(0, 60) || 'নতুন ফোন';
  const code = newPairingCode();
  const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

  q.run(
    'INSERT INTO pairing_codes (code, merchant_id, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    code,
    req.merchant.id,
    label,
    nowIso(),
    expiresAt,
  );

  res.status(201).json({ code, label, expires_at: expiresAt });
});

/**
 * অ্যাপ → সার্ভার পেয়ারিং (লগইন ছাড়া, শুধু এক-বারের কোড দিয়ে)
 * সফল হলে অ্যাপ তার নিজের চিরস্থায়ী ডিভাইস আইডি ও কী পায়।
 */
app.post('/api/devices/pair', pairLimiter, (req, res) => {
  const code = String(req.body?.pairing_code || '').trim().toUpperCase();
  const platform = String(req.body?.platform || 'android').slice(0, 20);
  const appVersion = String(req.body?.app_version || '').slice(0, 30);

  if (!/^[A-Z0-9]{6,12}$/.test(code)) {
    throw new HttpError(400, 'bad_request', 'পেয়ারিং কোড সঠিক নয়');
  }

  const row = q.get('SELECT * FROM pairing_codes WHERE code = ?', code);
  if (!row) throw new HttpError(404, 'not_found', 'কোড পাওয়া যায়নি');
  if (row.used_at) throw new HttpError(409, 'code_used', 'এই কোড আগেই ব্যবহার হয়েছে');
  if (row.expires_at < nowIso()) throw new HttpError(410, 'code_expired', 'কোডের মেয়াদ শেষ');

  const { key, keyHash, keyPrefix } = generateDeviceKey();
  const deviceId = newId('dev');
  const deviceUid = `dev_${crypto.randomBytes(9).toString('hex')}`;
  const now = nowIso();

  q.run(
    `INSERT INTO devices (id, merchant_id, label, device_uid, key_hash, key_prefix, status, platform, app_version, last_seen_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    deviceId,
    row.merchant_id,
    row.label || 'মোবাইল ডিভাইস',
    deviceUid,
    keyHash,
    keyPrefix,
    platform,
    appVersion || null,
    now,
    now,
  );
  q.run('UPDATE pairing_codes SET used_at = ?, used_device_id = ? WHERE code = ?', now, deviceId, code);
  audit(row.merchant_id, 'device', 'device.paired', { deviceId, platform });

  res.json({
    device: { id: deviceId, label: row.label, platform },
    credentials: { device_id: deviceUid, device_key: key, merchant_id: row.merchant_id },
  });
});

/* ═══════════════════════════ অর্ডার ═══════════════════════════ */

app.post('/api/orders', requireMerchant, apiLimiter, (req, res) => {
  const merchant = req.merchant;
  const provider = String(req.body?.provider || '').toLowerCase();
  const amountCents = toCents(req.body?.amount);
  const sender = normalizeMsisdn(req.body?.sender);
  const rawTrx = req.body?.trx_id ? String(req.body.trx_id) : '';
  const trxId = rawTrx ? normalizeTrxId(rawTrx) : null;
  const reference = req.body?.reference ? String(req.body.reference).slice(0, 64) : null;

  if (!PROVIDERS.includes(provider)) {
    throw new HttpError(400, 'bad_request', 'প্রোভাইডার bkash / rocket / nagad এর একটি হতে হবে');
  }
  if (amountCents === null || amountCents <= 0) {
    throw new HttpError(400, 'bad_request', 'সঠিক টাকার পরিমাণ দিন');
  }
  if (amountCents > 100_000_000) {
    throw new HttpError(400, 'bad_request', 'পরিমাণ অনেক বেশি');
  }
  if (!sender) {
    throw new HttpError(400, 'bad_request', 'সঠিক বাংলাদেশি মোবাইল নম্বর দিন (যেমন 01712345678)');
  }
  if (rawTrx && !trxId) {
    throw new HttpError(400, 'bad_request', 'TrxID সঠিক নয় (৫–৩২ অক্ষরের অক্ষর/সংখ্যা)');
  }

  if (trxId) {
    const clash = q.get(
      'SELECT id, status FROM orders WHERE merchant_id = ? AND provider = ? AND trx_id = ?',
      merchant.id,
      provider,
      trxId,
    );
    if (clash) {
      throw new HttpError(409, 'duplicate_order', `এই TrxID দিয়ে আগেই একটি অর্ডার আছে (${clash.status})`);
    }
  }

  let ttl = Number(req.body?.expires_in_seconds) || merchant.order_ttl_seconds || DEFAULT_TTL;
  ttl = Math.min(Math.max(Math.floor(ttl), 60), 86_400);

  const id = newId('ord');
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

  try {
    q.run(
      `INSERT INTO orders
        (id, merchant_id, provider, amount_cents, sender_msisdn, trx_id, reference, status,
         created_at, expires_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
      id,
      merchant.id,
      provider,
      amountCents,
      sender,
      trxId,
      reference,
      createdAt,
      expiresAt,
      req.body?.note ? String(req.body.note).slice(0, 200) : null,
    );
  } catch (err) {
    if (/UNIQUE/i.test(String(err?.message))) {
      throw new HttpError(409, 'duplicate_order', 'এই TrxID দিয়ে আগেই একটি অর্ডার আছে');
    }
    throw err;
  }

  audit(merchant.id, 'merchant', 'order.created', { orderId: id, provider, amountCents });

  // গ্রাহক আগে টাকা দিয়ে থাকলে এখানেই ম্যাচ হয়ে যাবে
  let matched = null;
  const candidate = findEventForOrder(
    q.get('SELECT * FROM orders WHERE id = ?', id),
    merchant.match_window_before_seconds ?? DEFAULT_BEFORE_WINDOW,
  );
  if (candidate) {
    try {
      claim(candidate.id, id);
      const eventRow = q.get('SELECT * FROM sms_events WHERE id = ?', candidate.id);
      const orderRow = q.get('SELECT * FROM orders WHERE id = ?', id);
      runWebhook(merchant.id, orderRow, eventRow);
      matched = eventView(eventRow);
    } catch (err) {
      if (!(err instanceof AlreadyConsumedError)) throw err;
    }
  }

  const row = q.get('SELECT * FROM orders WHERE id = ?', id);
  const eventRow = row.matched_event_id
    ? q.get('SELECT * FROM sms_events WHERE id = ?', row.matched_event_id)
    : null;

  res.status(201).json({
    order: orderView(row, eventRow),
    matched: Boolean(matched),
    matched_event: matched,
  });
});

app.get('/api/orders', requireMerchant, apiLimiter, (req, res) => {
  const limit = parseLimit(req.query.limit);
  const status = req.query.status ? String(req.query.status) : null;
  const params = [req.merchant.id];
  let sql = 'SELECT * FROM orders WHERE merchant_id = ?';
  if (status && ['pending', 'matched', 'expired', 'cancelled'].includes(status)) {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = q.all(sql, ...params);
  const orders = rows.map((row) => {
    const eventRow = row.matched_event_id
      ? q.get('SELECT * FROM sms_events WHERE id = ?', row.matched_event_id)
      : null;
    return orderView(row, eventRow);
  });
  res.json({ orders });
});

app.get('/api/orders/:id', requireMerchant, apiLimiter, (req, res) => {
  const row = q.get('SELECT * FROM orders WHERE id = ? AND merchant_id = ?', req.params.id, req.merchant.id);
  if (!row) throw new HttpError(404, 'not_found', 'অর্ডার পাওয়া যায়নি');
  const eventRow = row.matched_event_id
    ? q.get('SELECT * FROM sms_events WHERE id = ?', row.matched_event_id)
    : null;
  res.json({ order: orderView(row, eventRow) });
});

app.post('/api/orders/:id/cancel', requireMerchant, apiLimiter, (req, res) => {
  const row = q.get('SELECT * FROM orders WHERE id = ? AND merchant_id = ?', req.params.id, req.merchant.id);
  if (!row) throw new HttpError(404, 'not_found', 'অর্ডার পাওয়া যায়নি');
  if (row.status !== 'pending') {
    throw new HttpError(409, 'not_pending', 'শুধু pending অর্ডার বাতিল করা যায়');
  }
  q.run("UPDATE orders SET status = 'cancelled', cancelled_at = ? WHERE id = ?", nowIso(), row.id);
  audit(req.merchant.id, 'merchant', 'order.cancelled', { orderId: row.id });
  res.json({ ok: true });
});

/* ═══════════════════════════ ডিভাইস ইনজেস্ট ═══════════════════════════ */

app.post('/api/ingest', requireDevice, ingestLimiter, (req, res) => {
  const body = req.body || {};
  const events = Array.isArray(body.events) ? body.events : [body];

  const result = ingestBatch(req.device, events);
  if (result.error) throw new HttpError(400, 'bad_request', result.error);

  res.json({
    ok: true,
    ...result,
    server_time: nowIso(),
  });
});

/* ═══════════════════════════ লাইভ ফিড ও স্ট্যাট ═══════════════════════════ */

app.get('/api/events', requireMerchant, apiLimiter, (req, res) => {
  const limit = parseLimit(req.query.limit, 60, 200);
  const rows = q.all(
    'SELECT * FROM sms_events WHERE merchant_id = ? ORDER BY ingested_at DESC LIMIT ?',
    req.merchant.id,
    limit,
  );
  res.json({ events: rows.map(eventView) });
});

app.get('/api/stats', requireMerchant, apiLimiter, (req, res) => {
  const merchantId = req.merchant.id;
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);

  const counts = q.get(
    `SELECT
       SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) AS matched,
       SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
       SUM(CASE WHEN status = 'matched' AND matched_at >= ? THEN amount_cents ELSE 0 END) AS today_matched_cents,
       SUM(CASE WHEN status = 'matched' AND matched_at >= ? THEN 1 ELSE 0 END) AS today_matched_count,
       COUNT(*) AS total
     FROM orders WHERE merchant_id = ?`,
    dayStart.toISOString(),
    dayStart.toISOString(),
    merchantId,
  );

  const deviceCount = q.get(
    `SELECT COUNT(*) AS active FROM devices
      WHERE merchant_id = ? AND status = 'active' AND platform <> 'simulator'`,
    merchantId,
  );

  const recentMatches = q.all(
    `SELECT * FROM orders WHERE merchant_id = ? AND status = 'matched'
      ORDER BY matched_at DESC LIMIT 6`,
    merchantId,
  );

  res.json({
    stats: {
      total_orders: Number(counts.total || 0),
      pending: Number(counts.pending || 0),
      matched: Number(counts.matched || 0),
      expired: Number(counts.expired || 0),
      today_matched_count: Number(counts.today_matched_count || 0),
      today_matched_amount: formatCents(Number(counts.today_matched_cents || 0)),
      active_devices: Number(deviceCount.active || 0),
    },
    recent_matches: recentMatches.map((row) => orderView(row)),
  });
});

/* ═══════════════════════════ সেটিংস ═══════════════════════════ */

app.patch('/api/settings', requireMerchant, apiLimiter, (req, res) => {
  const merchant = req.merchant;
  const updates = [];

  if (req.body?.webhook_url !== undefined) {
    const url = String(req.body.webhook_url || '').trim();
    if (url) {
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        throw new HttpError(400, 'bad_request', 'webhook URL সঠিক নয়');
      }
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new HttpError(400, 'bad_request', 'webhook URL অবশ্যই http বা https হতে হবে');
      }
    }
    updates.push(['webhook_url', url || null]);
  }

  if (req.body?.order_ttl_seconds !== undefined) {
    const ttl = Math.floor(Number(req.body.order_ttl_seconds));
    if (!Number.isFinite(ttl) || ttl < 60 || ttl > 86_400) {
      throw new HttpError(400, 'bad_request', 'মেয়াদ ৬০ সেকেন্ড থেকে ২৪ ঘণ্টার মধ্যে হতে হবে');
    }
    updates.push(['order_ttl_seconds', ttl]);
  }

  if (req.body?.match_window_before_seconds !== undefined) {
    const win = Math.floor(Number(req.body.match_window_before_seconds));
    if (!Number.isFinite(win) || win < 0 || win > 3600) {
      throw new HttpError(400, 'bad_request', 'সময়সীমা ০–৩৬০০ সেকেন্ডের মধ্যে হতে হবে');
    }
    updates.push(['match_window_before_seconds', win]);
  }

  if (!updates.length) throw new HttpError(400, 'bad_request', 'পরিবর্তনের কিছু নেই');

  for (const [column, value] of updates) {
    q.run(`UPDATE merchants SET ${column} = ? WHERE id = ?`, value, merchant.id);
  }
  audit(merchant.id, 'merchant', 'settings.updated', Object.fromEntries(updates));

  const fresh = q.get('SELECT * FROM merchants WHERE id = ?', merchant.id);
  res.json({
    merchant: {
      id: fresh.id,
      business_name: fresh.business_name,
      email: fresh.email,
      webhook_url: fresh.webhook_url,
      webhook_secret: fresh.webhook_secret,
      order_ttl_seconds: fresh.order_ttl_seconds,
      match_window_before_seconds: fresh.match_window_before_seconds,
    },
  });
});

app.post('/api/settings/rotate-webhook-secret', requireMerchant, apiLimiter, (req, res) => {
  const secret = `whsec_${newToken(24)}`;
  q.run('UPDATE merchants SET webhook_secret = ? WHERE id = ?', secret, req.merchant.id);
  audit(req.merchant.id, 'merchant', 'webhook_secret.rotated', {});
  res.json({ webhook_secret: secret });
});

/* ═══════════════════════════ টেস্ট সিমুলেটর ═══════════════════════════ */

/**
 * ফোন ছাড়াই পুরো ফ্লো পরীক্ষা করার জন্য।
 * এখানে পাঠানো মেসেজও একই পাইপলাইনে যায় — তাই এক-বার নিয়মও এখানে খাটে।
 */
app.post('/api/simulate', requireMerchant, apiLimiter, (req, res) => {
  const sender = String(req.body?.sender || '').trim();
  const text = String(req.body?.text || '').trim();
  if (!sender || !text) throw new HttpError(400, 'bad_request', 'sender ও text দুটোই দরকার');

  const parsed = parseMfsMessage({ sender, text });
  if (!req.body?.dry_run) {
    const device = getSimulatorDevice(req.merchant.id);
    const checked = validateEventPayload(
      {
        client_event_id: `sim_${crypto.randomBytes(8).toString('hex')}`,
        source: 'simulator',
        sender,
        text,
        received_at: nowIso(),
      },
      0,
    );
    if (checked.error) throw new HttpError(400, 'bad_request', checked.error.reason);
    const result = processEvent(device, checked.value);
    return res.json({ parsed, result });
  }

  res.json({ parsed });
});

/* ═══════════════════════════ ডাটাবেস ও ক্লাউড ব্যাকআপ ═══════════════════════════ */

/** ডিফল্ট ডাটাবেস কোথায় আর কত বড় — ড্যাশবোর্ডে দেখানোর জন্য */
app.get('/api/storage', requireMerchant, apiLimiter, (req, res) => {
  const row = getConfigRow(req.merchant.id);
  res.json({
    database: dbInfo(),
    storage: configView(row),
    providers: Object.entries(PROVIDER_PRESETS).map(([slug, p]) => ({ slug, label: p.label, note: p.note })),
  });
});

/** নিজের ক্লাউড স্টোরেজ যোগ/পরিবর্তন */
app.post('/api/storage', requireMerchant, apiLimiter, asyncRoute(async (req, res) => {
  const view = await saveConfig(req.merchant.id, req.body || {});
  res.json({ storage: view });
}));

/** সেভ না করেই সংযোগ परीक्षा */
app.post('/api/storage/test', requireMerchant, apiLimiter, asyncRoute(async (req, res) => {
  let cfg;
  try {
    cfg = buildConfig(req.merchant.id, req.body || {});
  } catch (err) {
    throw new HttpError(400, 'bad_request', err.message);
  }

  try {
    const result = await testConnection(cfg);
    res.json({ ok: true, latency_ms: result.latency_ms, objects: result.objects });
  } catch (err) {
    throw new HttpError(400, 'storage_unreachable', `সংযোগ ব্যর্থ: ${err.message}`);
  }
}));

app.delete('/api/storage', requireMerchant, apiLimiter, (req, res) => {
  res.json({ storage: removeConfig(req.merchant.id) });
});

app.get('/api/storage/backups', requireMerchant, apiLimiter, asyncRoute(async (req, res) => {
  res.json(await listBackups(req.merchant.id));
}));

app.post('/api/storage/backup', requireMerchant, apiLimiter, asyncRoute(async (req, res) => {
  try {
    res.json(await runBackup(req.merchant.id, { reason: 'manual' }));
  } catch (err) {
    throw new HttpError(err.status || 502, 'backup_failed', err.message);
  }
}));

app.post('/api/storage/restore', requireMerchant, apiLimiter, asyncRoute(async (req, res) => {
  const key = String(req.body?.key || '').trim();
  if (!key) throw new HttpError(400, 'bad_request', 'ব্যাকআপের key দরকার');
  try {
    res.json(await restoreBackup(req.merchant.id, key));
  } catch (err) {
    throw new HttpError(err.status || 502, 'restore_failed', err.message);
  }
}));

/* ═══════════════════════════ স্ট্যাটিক ড্যাশবোর্ড ═══════════════════════════ */

app.use(express.static(PUBLIC_DIR, { maxAge: '1h', index: 'index.html' }));

app.use('/api', (req, res) => {
  res.status(404).json({ error: { code: 'not_found', message: 'এই API নেই' } });
});

/* ═══════════════════════════ এরর হ্যান্ডলার ═══════════════════════════ */

app.use((err, req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details },
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_json', message: 'JSON সঠিক নয়' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'ডেটা অনেক বড়' } });
  }
  console.error('[error]', err?.stack || err);
  res.status(500).json({ error: { code: 'internal_error', message: 'সার্ভারে সমস্যা হয়েছে' } });
});

/* ═══════════════════════════ ব্যাকগ্রাউন্ড জব ═══════════════════════════ */

setInterval(() => {
  try {
    expireOrders();
  } catch (err) {
    console.error('[expire] failed:', err?.message);
  }
}, 30_000).unref();

setInterval(() => {
  try {
    purgeExpiredSessions();
    pruneOldEvents();
  } catch (err) {
    console.error('[maintenance] failed:', err?.message);
  }
}, 60 * 60_000).unref();

/* ═══════════════════════════ স্টার্ট ═══════════════════════════ */

app.listen(PORT, HOST, () => {
  console.log(`TakaMatch সার্ভার চালু — http://${HOST}:${PORT}`);
  startBackupScheduler();
});
