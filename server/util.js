import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();

/** ইউনিক আইডি (প্রিফিক্স সহ, ডাটাবেস-সেফ) */
export function newId(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString('hex')}`;
}

/** মানুষের পড়ার উপযোগী র‍্যান্ডম টোকেন */
export function newToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** crate-সেফ হ্যাশ — ডিভাইস কি ও সেশন টোকেন কখনো প্লেইন টেক্সটে রাখা হয় না */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (msg, details) => new HttpError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'প্রমাণীকরণ প্রয়োজন') => new HttpError(401, 'unauthorized', msg);
export const forbidden = (msg = 'অনুমতি নেই') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'খুঁজে পাওয়া যায়নি') => new HttpError(404, 'not_found', msg);
export const conflict = (msg, details) => new HttpError(409, 'conflict', msg, details);

/* ─────────────────────────── টাকার হিসাব ─────────────────────────── */

const BENGALI_DIGIT_MAP = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

/** বাংলা অঙ্ক → ইংরেজি অঙ্ক */
export function toAsciiDigits(value) {
  return String(value ?? '').replace(/[০-৯]/g, (d) => BENGALI_DIGIT_MAP[d] || d);
}

/**
 * humanos টাকার লেখা → পয়সা (integer)।
 * "১০০ টাকা", "৳100", "100tk", "1,500.00", "Rs 200/-" — সবই চলে।
 * ফ্লোটিং পয়েন্ট ত্রুটি এড়াতে পয়সায় হিসাব হয়।
 */
export function toCents(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }

  let text = toAsciiDigits(value)
    .replace(/,/g, '')
    .replace(/৳|৳/g, '')
    // মুদ্রার শব্দ/প্রতীক — শুরুতেই বাদ, যাতে "100tk" বা "১০০ টাকা" দুটোই কাজ করে
    .replace(/\b(?:tk|taka|bdt|টাকা|rupi|rupaya)\b\.?/gi, '')
    .replace(/\/-/g, '')
    .trim();

  // "tk500" / "500tk" — শব্দের সীমানা না থাকলেও বাদ দিই
  text = text.replace(/(?:tk|taka|bdt)/gi, '').replace(/টাকা/g, '').trim();

  if (!text) return null;
  const n = Number(text);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

/** পয়সা → "1,234.00" */
export function formatCents(cents) {
  const n = Number(cents || 0) / 100;
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* ─────────────────────────── ভ্যালিডেশন ─────────────────────────── */

export const PROVIDERS = ['bkash', 'rocket', 'nagad'];

export const PROVIDER_LABELS = {
  bkash: 'বিকাশ',
  rocket: 'রকেট',
  nagad: 'নগদ',
};

/**
 * বাংলাদেশি মোবাইল নম্বর নরমালাইজ: +8801712345678 → 01712345678
 * ভুল হলে null।
 */
export function normalizeMsisdn(input) {
  if (input === null || input === undefined) return null;
  let digits = toAsciiDigits(input).replace(/[^\d]/g, '');
  if (digits.startsWith('880') && digits.length === 13) digits = '0' + digits.slice(3);
  if (digits.length === 10 && digits.startsWith('1')) digits = '0' + digits;
  return /^01[3-9]\d{8}$/.test(digits) ? digits : null;
}

/** TrxID নরমালাইজ: স্পেস/ড্যাশ বাদ, বড় হাতের অক্ষরে */
export function normalizeTrxId(input) {
  if (!input) return null;
  const cleaned = String(input).replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (cleaned.length < 5 || cleaned.length > 32) return null;
  return cleaned;
}

/* ─────────────────────────── রেট লিমিট ─────────────────────────── */

/**
 * সাধারণ fixed-window রেট লিমিটার (in-memory)।
 * প্রসেস রিস্টার্টে রিসেট হয় — একক-ইনস্ট্যান্স ডিপ্লয়ের জন্য যথেষ্ট।
 */
export function createRateLimiter({ windowMs, max, name = 'rl' }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [key, entry] of hits) {
      if (entry.start < cutoff) hits.delete(key);
    }
  }, Math.max(30_000, windowMs));
  timer.unref?.();

  return function rateLimit(req, res, next) {
    const key = `${name}:${req.rateLimitKey || req.ip || 'unknown'}`;
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.start >= windowMs) {
      entry = { start: now, count: 0 };
      hits.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.start + windowMs - now) / 1000));
      return res.status(429).json({
        error: { code: 'rate_limited', message: 'অনেক বেশি অনুরোধ — একটু পরে আবার চেষ্টা করুন' },
      });
    }
    next();
  };
}

export function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length) return forwarded.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}
