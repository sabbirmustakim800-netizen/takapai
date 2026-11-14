import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DB_FILE = resolve(process.env.DATABASE_FILE || './data/app.db');

mkdirSync(dirname(DB_FILE), { recursive: true });

/** ডিফল্ট ডাটাবেস = নিজের মেশিনের SQLite ফাইল। কোনো ক্লাউড অ্যাকাউন্ট লাগে না। */
function openDatabase() {
  const handle = new DatabaseSync(DB_FILE);
  handle.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);
  return handle;
}

let db = openDatabase();

db.exec(`
CREATE TABLE IF NOT EXISTS merchants (
  id                              TEXT PRIMARY KEY,
  business_name                   TEXT NOT NULL,
  email                           TEXT NOT NULL UNIQUE,
  password_hash                   TEXT NOT NULL,
  webhook_url                     TEXT,
  webhook_secret                  TEXT NOT NULL,
  order_ttl_seconds               INTEGER NOT NULL DEFAULT 1800,
  match_window_before_seconds     INTEGER NOT NULL DEFAULT 300,
  created_at                      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash    TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_merchant ON sessions(merchant_id);

CREATE TABLE IF NOT EXISTS pairing_codes (
  code          TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  label         TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  used_at       TEXT,
  used_device_id TEXT
);

CREATE TABLE IF NOT EXISTS devices (
  id            TEXT PRIMARY KEY,
  merchant_id   TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  label         TEXT NOT NULL,
  device_uid    TEXT NOT NULL UNIQUE,
  key_hash      TEXT NOT NULL,
  key_prefix    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',
  platform      TEXT NOT NULL DEFAULT 'android',
  app_version   TEXT,
  last_seen_at  TEXT,
  created_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_devices_merchant ON devices(merchant_id, status);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  amount_cents    INTEGER NOT NULL,
  sender_msisdn   TEXT NOT NULL,
  trx_id          TEXT,
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'pending',
  matched_event_id TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  matched_at      TEXT,
  cancelled_at    TEXT,
  note            TEXT
);
CREATE INDEX IF NOT EXISTS ix_orders_lookup ON orders(merchant_id, status, provider, amount_cents, sender_msisdn);
CREATE INDEX IF NOT EXISTS ix_orders_created ON orders(merchant_id, created_at DESC);
-- একই TrxID দিয়ে একই মার্চেন্টের দুটি অর্ডার কখনো তৈরি হতে পারবে না
CREATE UNIQUE INDEX IF NOT EXISTS ux_orders_trx
  ON orders(merchant_id, provider, trx_id) WHERE trx_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sms_events (
  id              TEXT PRIMARY KEY,
  merchant_id     TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  device_id       TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  client_event_id TEXT NOT NULL,
  provider        TEXT NOT NULL,
  source          TEXT NOT NULL,
  sender_address  TEXT NOT NULL,
  raw_text        TEXT NOT NULL,
  direction       TEXT NOT NULL DEFAULT 'other',
  status          TEXT NOT NULL DEFAULT 'unmatched',
  amount_cents    INTEGER,
  trx_id          TEXT,
  sender_msisdn   TEXT,
  balance_cents   INTEGER,
  parsed_at       TEXT,
  device_time     TEXT,
  received_at     TEXT NOT NULL,
  ingested_at     TEXT NOT NULL,
  matched_order_id TEXT,
  matched_at      TEXT,
  reason          TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sms_client_event ON sms_events(device_id, client_event_id);
-- ★ মূল নিয়ম: একই (প্রোভাইডার + TrxID) একবারই সিস্টেমে ঢুকতে পারবে।
--   'duplicate' হিসেবে চিহ্নিত সারিগুলো বাদে বাকি সব সারি চিরস্থায়ীভাবে ব্লক করে।
CREATE UNIQUE INDEX IF NOT EXISTS ux_sms_trx_once
  ON sms_events(provider, trx_id) WHERE trx_id IS NOT NULL AND status <> 'duplicate';
CREATE INDEX IF NOT EXISTS ix_sms_match ON sms_events(merchant_id, status, provider, amount_cents, sender_msisdn);
CREATE INDEX IF NOT EXISTS ix_sms_ingested ON sms_events(merchant_id, ingested_at DESC);

CREATE TABLE IF NOT EXISTS audit_log (
  id           TEXT PRIMARY KEY,
  merchant_id  TEXT,
  actor        TEXT,
  action       TEXT NOT NULL,
  detail       TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_merchant ON audit_log(merchant_id, created_at DESC);

-- নিজের ক্লাউড স্টোরেজ (S3/R2/B2/MinIO) — ব্যাকআপ রাখার জন্য।
-- গোপন কী এনক্রিপ্ট করেই রাখা হয় (AES-256-GCM)।
CREATE TABLE IF NOT EXISTS storage_configs (
  merchant_id      TEXT PRIMARY KEY REFERENCES merchants(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL,
  endpoint         TEXT NOT NULL,
  region           TEXT NOT NULL DEFAULT 'auto',
  bucket           TEXT NOT NULL,
  prefix           TEXT NOT NULL DEFAULT 'takamatch',
  access_key_id    TEXT NOT NULL,
  secret_cipher    TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL DEFAULT 0,
  keep             INTEGER NOT NULL DEFAULT 7,
  path_style       INTEGER NOT NULL DEFAULT 1,
  last_run_at      TEXT,
  last_status      TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backup_runs (
  id          TEXT PRIMARY KEY,
  merchant_id TEXT NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  object_key  TEXT NOT NULL,
  size_bytes  INTEGER,
  sha256      TEXT,
  status      TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_backup_merchant ON backup_runs(merchant_id, created_at DESC);
`);

/** ছোট হেল্পার — prepared statement ক্যাশ করে না, node:sqlite নিজেই দ্রুত */
export const q = {
  run: (sql, ...params) => db.prepare(sql).run(...params),
  get: (sql, ...params) => db.prepare(sql).get(...params),
  all: (sql, ...params) => db.prepare(sql).all(...params),
};

/** একটি সিঙ্ক্রোনাস ট্রানজ্যাকশনে fn চালায় (BEGIN IMMEDIATE) */
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** ডাটাবেস হ্যান্ডেল (ব্যাকআপ/রিস্টোরের জন্য) */
export const getDb = () => db;

/** ফাইল পাথ — ব্যাকআপ নেওয়ার জন্য */
export const dbFilePath = () => DB_FILE;

export function closeDatabase() {
  try {
    db.close();
  } catch {
    /* আগেই বন্ধ থাকলে */
  }
}

/** ফাইল বদলানোর পর নতুন করে খোলে (রিস্টোরের পরে) */
export function reopenDatabase() {
  closeDatabase();
  db = openDatabase();
  return db;
}

export function audit(merchantId, actor, action, detail) {
  q.run(
    'INSERT INTO audit_log (id, merchant_id, actor, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    `log_${cryptoRandomId()}`,
    merchantId || null,
    actor || null,
    action,
    detail ? JSON.stringify(detail) : null,
    new Date().toISOString(),
  );
}

function cryptoRandomId() {
  return globalThis.crypto.randomUUID().replace(/-/g, '');
}

export const DB_PATH = DB_FILE;
