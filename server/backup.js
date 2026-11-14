/**
 * নিজের ক্লাউড স্টোরেজে ডাটাবেস ব্যাকআপ + রিস্টোর।
 *
 * ডিফল্ট ডাটাবেস সবসময় নিজের মেশিনের SQLite ফাইল (data/app.db)।
 * ইউজার চাইলে নিজের S3/R2/B2/MinIO অ্যাকাউন্ট যোগ করে দিতে পারেন —
 * তখন ব্যাকআপ স্বয়ংক্রিয়ভাবে ওই বাকেটে যাবে, আর যেকোনো সময় ফিরিয়ে আনা যাবে।
 *
 * ব্যাকআপ ফাইল AES-256-GCM দিয়ে এনক্রিপ্ট করা হয় — বাকেটে কেউ ঢুকে পড়লেও
 * পাসওয়ার্ড হ্যাশ বা webhook সিক্রেট পড়তে পারবে না।
 */

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, copyFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { q, dbFilePath, getDb, closeDatabase, reopenDatabase, audit } from './db.js';
import {
  normalizeConfig,
  putObject,
  getObject,
  listObjects,
  deleteObject,
  testConnection,
  PROVIDER_PRESETS,
} from './storage.js';

const KEY_FILE = process.env.BACKUP_KEY_FILE || join(process.cwd(), 'data', '.backup-key');
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/* ─────────────────────────── এনক্রিপশন কী ─────────────────────────── */

let cachedKey = null;

function encryptionKey() {
  if (cachedKey) return cachedKey;

  const fromEnv = process.env.BACKUP_ENCRYPTION_KEY;
  if (fromEnv && /^[0-9a-fA-F]{64}$/.test(fromEnv)) {
    cachedKey = Buffer.from(fromEnv, 'hex');
    return cachedKey;
  }

  mkdirSync(dirname(KEY_FILE), { recursive: true });
  if (existsSync(KEY_FILE)) {
    const hex = readFileSync(KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(hex)) {
      cachedKey = Buffer.from(hex, 'hex');
      return cachedKey;
    }
    throw new Error('data/.backup-key ফাইলটি নষ্ট — মুছে ফেললে নতুন কী তৈরি হবে');
  }

  const fresh = crypto.randomBytes(32);
  try {
    writeFileSync(KEY_FILE, fresh.toString('hex'), { mode: 0o600, flag: 'wx' });
  } catch {
    /* অন্য প্রসেস আগেই বানিয়ে থাকলে সেটাই পড়ি */
    const hex = readFileSync(KEY_FILE, 'utf8').trim();
    cachedKey = Buffer.from(hex, 'hex');
    return cachedKey;
  }
  cachedKey = fresh;
  return cachedKey;
}

function encrypt(buffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(buffer), cipher.final()]);
  return Buffer.concat([Buffer.from('TMBK1', 'utf8'), iv, cipher.getAuthTag(), body]);
}

function decrypt(payload) {
  if (payload.subarray(0, 5).toString('utf8') !== 'TMBK1') {
    throw new Error('এটি TakaMatch ব্যাকআপ ফাইল নয়');
  }
  const iv = payload.subarray(5, 17);
  const tag = payload.subarray(17, 33);
  const body = payload.subarray(33);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/* ─────────────────────────── কনফিগ সেভ/পড়া ─────────────────────────── */

function rowToConfig(row) {
  if (!row) return null;
  return normalizeConfig({
    provider: row.provider,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    access_key_id: row.access_key_id,
    secret_access_key: decryptSecret(row),
    interval_minutes: row.interval_minutes,
    keep: row.keep,
    path_style: Number(row.path_style) === 1,
  });
}

function decryptSecret(row) {
  try {
    return decrypt(Buffer.from(row.secret_cipher, 'base64')).toString('utf8');
  } catch {
    throw new Error('সংরক্ষিত সিক্রেট কী পড়া যাচ্ছে না — নতুন করে দিন');
  }
}

export function getConfigRow(merchantId) {
  return q.get('SELECT * FROM storage_configs WHERE merchant_id = ?', merchantId) || null;
}

export function configView(row) {
  if (!row) return { configured: false };
  const preset = PROVIDER_PRESETS[row.provider] || {};
  return {
    configured: true,
    provider: row.provider,
    provider_label: preset.label || row.provider,
    endpoint: row.endpoint,
    region: row.region,
    bucket: row.bucket,
    prefix: row.prefix,
    access_key_id: row.access_key_id,
    secret_masked: '••••••••••••',
    interval_minutes: Number(row.interval_minutes),
    keep: Number(row.keep),
    path_style: Number(row.path_style) === 1,
    last_run_at: row.last_run_at,
    last_status: row.last_status,
    last_error: row.last_error,
    updated_at: row.updated_at,
  };
}

/** সংরক্ষিত মান আর ব্যবহারকারীর দেওয়া ইনপুট মিলিয়ে সম্পূর্ণ কনফিগ */
export function buildConfig(merchantId, input = {}) {
  const existing = getConfigRow(merchantId);
  const merged = { ...input };
  if (existing) {
    const saved = rowToConfig(existing);
    merged.provider = merged.provider || saved.provider;
    merged.endpoint = merged.endpoint || saved.endpoint;
    merged.region = merged.region || saved.region;
    merged.bucket = merged.bucket || saved.bucket;
    merged.prefix = merged.prefix || saved.prefix;
    merged.access_key_id = merged.access_key_id || saved.accessKeyId;
    merged.secret_access_key = merged.secret_access_key || saved.secretAccessKey;
    if (merged.path_style === undefined) merged.path_style = saved.pathStyle;
  }
  return normalizeConfig(merged);
}

export async function saveConfig(merchantId, input) {
  const existing = getConfigRow(merchantId);
  const merged = { ...input };

  // সিক্রেট না দিলে আগেরটাই থাকবে
  if (!merged.secret_access_key && existing) {
    merged.secret_access_key = decryptSecret(existing);
  }

  const cfg = normalizeConfig(merged);
  const now = new Date().toISOString();
  const secretCipher = encrypt(Buffer.from(cfg.secretAccessKey, 'utf8')).toString('base64');

  q.run(
    `INSERT INTO storage_configs
       (merchant_id, provider, endpoint, region, bucket, prefix, access_key_id, secret_cipher,
        interval_minutes, keep, path_style, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(merchant_id) DO UPDATE SET
       provider = excluded.provider,
       endpoint = excluded.endpoint,
       region = excluded.region,
       bucket = excluded.bucket,
       prefix = excluded.prefix,
       access_key_id = excluded.access_key_id,
       secret_cipher = excluded.secret_cipher,
       interval_minutes = excluded.interval_minutes,
       keep = excluded.keep,
       path_style = excluded.path_style,
       updated_at = excluded.updated_at`,
    merchantId,
    cfg.provider,
    cfg.endpoint,
    cfg.region,
    cfg.bucket,
    cfg.prefix,
    cfg.accessKeyId,
    secretCipher,
    cfg.intervalMinutes,
    cfg.keep,
    cfg.pathStyle ? 1 : 0,
    now,
    now,
  );

  audit(merchantId, 'merchant', 'storage.saved', {
    provider: cfg.provider,
    bucket: cfg.bucket,
    interval_minutes: cfg.intervalMinutes,
  });

  return configView(getConfigRow(merchantId));
}

export function removeConfig(merchantId) {
  q.run('DELETE FROM storage_configs WHERE merchant_id = ?', merchantId);
  audit(merchantId, 'merchant', 'storage.removed', {});
  return { configured: false };
}

/* ─────────────────────────── স্ন্যাপশট ─────────────────────────── */

/** চলমান ডাটাবেসের হুবহু কপি — VACUUM INTO দিয়ে নিরাপদ, লক ছাড়াই */
function snapshot() {
  const target = join(tmpdir(), `takamatch-${crypto.randomBytes(6).toString('hex')}.db`);
  const escaped = target.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${escaped}'`);
  const buffer = readFileSync(target);
  rmSync(target, { force: true });
  return buffer;
}

function dbInfo() {
  const file = dbFilePath();
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    size = 0;
  }
  const counts = {
    merchants: Number(q.get('SELECT COUNT(*) AS n FROM merchants').n || 0),
  };
  return { file: basename(file), size_bytes: size, engine: 'SQLite (এই মেশিনে)', tables: counts };
}

/* ─────────────────────────── ব্যাকআপ ─────────────────────────── */

function objectKeyFor(cfg, merchantId, hash) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${cfg.prefix}/backups/${merchantId}/${stamp}-${hash.slice(0, 8)}.db.enc`;
}

export async function runBackup(merchantId, { reason = 'manual' } = {}) {
  const row = getConfigRow(merchantId);
  if (!row) {
    const err = new Error('আগে নিজের ক্লাউড স্টোরেজ যোগ করুন');
    err.status = 400;
    throw err;
  }
  const cfg = rowToConfig(row);

  const snapshotBuffer = snapshot();
  const sha = crypto.createHash('sha256').update(snapshotBuffer).digest('hex');
  const payload = encrypt(snapshotBuffer);
  const key = objectKeyFor(cfg, merchantId, sha);

  try {
    await putObject(cfg, key, payload, 'application/octet-stream');

    q.run(
      `INSERT INTO backup_runs (id, merchant_id, object_key, size_bytes, sha256, status, error, created_at)
       VALUES (?, ?, ?, ?, ?, 'ok', NULL, ?)`,
      `bkp_${crypto.randomBytes(8).toString('hex')}`,
      merchantId,
      key,
      payload.length,
      sha,
      new Date().toISOString(),
    );
    q.run(
      'UPDATE storage_configs SET last_run_at = ?, last_status = ?, last_error = NULL WHERE merchant_id = ?',
      new Date().toISOString(),
      `ok:${reason}`,
      merchantId,
    );

    await prune(merchantId, cfg);
    audit(merchantId, 'system', 'backup.done', { key, bytes: payload.length, reason });
    return { ok: true, key, size_bytes: payload.length, sha256: sha.slice(0, 12), reason };
  } catch (err) {
    q.run(
      'UPDATE storage_configs SET last_run_at = ?, last_status = ?, last_error = ? WHERE merchant_id = ?',
      new Date().toISOString(),
      'failed',
      String(err.message).slice(0, 300),
      merchantId,
    );
    audit(merchantId, 'system', 'backup.failed', { error: String(err.message).slice(0, 200) });
    throw err;
  }
}

/** পুরনো ব্যাকআপ মুছে দেয়, শেষ `keep` সংখ্যক রেখে */
async function prune(merchantId, cfg) {
  try {
    const all = await listObjects(cfg, `${cfg.prefix}/backups/${merchantId}/`, 1000);
    const extra = all.slice(cfg.keep);
    for (const item of extra) {
      await deleteObject(cfg, item.key).catch(() => {});
      q.run('DELETE FROM backup_runs WHERE merchant_id = ? AND object_key = ?', merchantId, item.key);
    }
  } catch {
    /* প্রুনিং ব্যর্থ হলেও ব্যাকআপ ঠিক আছে */
  }
}

export async function listBackups(merchantId) {
  const row = getConfigRow(merchantId);
  const local = q.all(
    'SELECT * FROM backup_runs WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 30',
    merchantId,
  );

  if (!row) return { configured: false, backups: local };

  const cfg = rowToConfig(row);
  let remote = [];
  let remoteError = null;
  try {
    remote = await listObjects(cfg, `${cfg.prefix}/backups/${merchantId}/`, 100);
  } catch (err) {
    remoteError = err.message;
  }

  const byKey = new Map();
  for (const run of local) {
    byKey.set(run.object_key, {
      key: run.object_key,
      created_at: run.created_at,
      size_bytes: run.size_bytes,
      sha256: run.sha256,
      status: run.status,
      in_cloud: false,
    });
  }
  for (const item of remote) {
    const existing = byKey.get(item.key);
    if (existing) {
      existing.in_cloud = true;
      existing.cloud_size = item.size;
    } else {
      byKey.set(item.key, {
        key: item.key,
        created_at: item.modified,
        size_bytes: item.size,
        sha256: null,
        status: 'ok',
        in_cloud: true,
        cloud_size: item.size,
      });
    }
  }

  const backups = [...byKey.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return { configured: true, backups, remote_error: remoteError };
}

/* ─────────────────────────── রিস্টোর ─────────────────────────── */

export async function restoreBackup(merchantId, objectKey) {
  const row = getConfigRow(merchantId);
  if (!row) {
    const err = new Error('আগে নিজের ক্লাউড স্টোরেজ যোগ করুন');
    err.status = 400;
    throw err;
  }
  if (!objectKey || !objectKey.includes(`/backups/${merchantId}/`)) {
    const err = new Error('এই ব্যাকআপটি আপনার নয়');
    err.status = 403;
    throw err;
  }

  const cfg = rowToConfig(row);
  const encrypted = await getObject(cfg, objectKey);
  const plain = decrypt(encrypted);

  if (plain.subarray(0, 16).toString('utf8') !== SQLITE_MAGIC) {
    throw new Error('ফাইলটি বৈধ SQLite ডাটাবেস নয়');
  }

  const staged = join(tmpdir(), `takamatch-restore-${crypto.randomBytes(6).toString('hex')}.db`);
  writeFileSync(staged, plain);

  // আগে যাচাই, তারপর ফাইল বদল — নাহলে নষ্ট ব্যাকআপে ডাটাবেস হারাবে
  const probe = new DatabaseSync(staged, { readOnly: true });
  let integrity;
  try {
    integrity = probe.prepare('PRAGMA integrity_check').get();
  } finally {
    probe.close();
  }
  if (String(Object.values(integrity || {})[0] || '') !== 'ok') {
    rmSync(staged, { force: true });
    throw new Error('ব্যাকআপ ফাইলের অখণ্ডতা যাচাইয়ে ব্যর্থ');
  }

  const file = dbFilePath();
  const safety = `${file}.pre-restore-${Date.now()}`;
  try {
    copyFileSync(file, safety);
  } catch {
    /* ফাইল না থাকলেও চলবে */
  }

  closeDatabase();
  for (const suffix of ['-wal', '-shm']) rmSync(`${file}${suffix}`, { force: true });
  copyFileSync(staged, file);
  rmSync(staged, { force: true });
  reopenDatabase();

  const counts = {
    merchants: Number(q.get('SELECT COUNT(*) AS n FROM merchants').n || 0),
    orders: Number(q.get('SELECT COUNT(*) AS n FROM orders').n || 0),
    events: Number(q.get('SELECT COUNT(*) AS n FROM sms_events').n || 0),
    devices: Number(q.get('SELECT COUNT(*) AS n FROM devices').n || 0),
  };

  audit(merchantId, 'merchant', 'backup.restored', { key: objectKey, counts });
  return { ok: true, restored_from: objectKey, counts, safety_copy: basename(safety) };
}

/* ─────────────────────────── স্বয়ংক্রিয় ব্যাকআপ ─────────────────────────── */

let timer = null;

export function startBackupScheduler({ tickMs = 60_000 } = {}) {
  if (timer) return timer;

  timer = setInterval(async () => {
    try {
      const due = q.all(
        `SELECT * FROM storage_configs
          WHERE interval_minutes > 0
            AND (last_run_at IS NULL
                 OR julianday('now') - julianday(last_run_at) >= interval_minutes / 1440.0)`,
      );
      for (const row of due) {
        try {
          await runBackup(row.merchant_id, { reason: 'auto' });
        } catch (err) {
          console.error('[backup] ব্যাকআপ ব্যর্থ:', err?.message);
        }
      }
    } catch (err) {
      console.error('[backup] শিডিউলার সমস্যা:', err?.message);
    }
  }, tickMs);

  timer.unref?.();
  return timer;
}

export function stopBackupScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

export { testConnection, dbInfo, PROVIDER_PRESETS };
