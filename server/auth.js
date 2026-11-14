import crypto from 'node:crypto';
import { q } from './db.js';
import { nowIso, newToken, sha256, safeEqual, unauthorized, forbidden } from './util.js';

const SCRYPT_KEYLEN = 64;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, key] = String(stored).split('$');
    if (scheme !== 'scrypt' || !salt || !key) return false;
    const candidate = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
    return safeEqual(candidate, key);
  } catch {
    return false;
  }
}

const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 604800);

export function createSession(merchantId) {
  const token = `ses_${newToken(32)}`;
  const now = new Date();
  q.run(
    'INSERT INTO sessions (token_hash, merchant_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    sha256(token),
    merchantId,
    now.toISOString(),
    new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString(),
  );
  return { token, expiresAt: new Date(now.getTime() + SESSION_TTL_SECONDS * 1000).toISOString() };
}

export function destroySession(token) {
  if (!token) return;
  q.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

export function purgeExpiredSessions() {
  q.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
}

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : null;
}

/** মার্চেন্ট সেশন প্রয়োজন — req.merchant সেট করে */
export function requireMerchant(req, res, next) {
  const token = bearerToken(req);
  if (!token) return next(unauthorized('সেশন টোকেন নেই — আবার লগইন করুন'));

  const row = q.get(
    `SELECT m.* FROM sessions s
     JOIN merchants m ON m.id = s.merchant_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    sha256(token),
    nowIso(),
  );
  if (!row) return next(unauthorized('সেশন মেয়াদোত্তীর্ণ — আবার লগইন করুন'));

  req.merchant = row;
  req.sessionToken = token;
  req.rateLimitKey = `m:${row.id}`;
  next();
}

/**
 * ডিভাইস প্রমাণীকরণ: X-Device-Id + X-Device-Key
 * (অথবা Authorization: Device <id>:<key>)
 * প্রতিটি ইনস্টলের জন্য আলাদা, শুধু হ্যাশ ডাটাবেসে থাকে।
 */
export function requireDevice(req, res, next) {
  let deviceUid = req.headers['x-device-id'] || null;
  let deviceKey = req.headers['x-device-key'] || null;

  if (!deviceUid) {
    const header = req.headers.authorization || '';
    const m = /^Device\s+([^:]+):(.+)$/i.exec(header.trim());
    if (m) {
      deviceUid = m[1].trim();
      deviceKey = m[2].trim();
    }
  }

  if (!deviceUid || !deviceKey) {
    return next(unauthorized('ডিভাইস আইডি অথবা ডিভাইস কী নেই'));
  }

  const device = q.get('SELECT * FROM devices WHERE device_uid = ?', String(deviceUid));
  if (!device) return next(unauthorized('অজানা ডিভাইস'));
  if (device.status !== 'active') return next(forbidden('এই ডিভাইসটি বাতিল করা হয়েছে'));
  if (!safeEqual(sha256(String(deviceKey)), device.key_hash)) {
    return next(unauthorized('ডিভাইস কী সঠিক নয়'));
  }

  req.device = device;
  req.merchantId = device.merchant_id;
  req.rateLimitKey = `d:${device.id}`;
  next();
}

/** নতুন ডিভাইস কী তৈরি — প্লেইন কী শুধু একবার ফেরত যায় */
export function generateDeviceKey() {
  const key = `dvk_${newToken(32)}`;
  return {
    key,
    keyHash: sha256(key),
    keyPrefix: key.slice(0, 12),
  };
}
