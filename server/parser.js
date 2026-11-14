/**
 * বিকাশ / রকেট / নগদ — পেমেন্ট এসএমএস ও নোটিফিকেশন পার্সার
 * ─────────────────────────────────────────────────────────
 * নকশার নীতি:
 *  1. কখনো "বিশ্বাস" করি না — যা বের করা যায় না, সেটা null থাকে; অনুমান করি না।
 *  2. একাধিক রেগেক্স প্যাটার্ন, কারণ অপারেটররা সময় সময় ফরম্যাট বদলায়।
 *  3. কেবল "টাকা ঢুকেছে" ধরনের মেসেজ গ্রহণ করি (received / cash in)।
 *     পাঠানো, পেমেন্ট, উত্তোলন — সব বাদ।
 *  4. র' টেক্সট সবসময় সাথে রাখি, যাতে ভুল হলে মানুষ যাচাই করতে পারে।
 */

import { toCents, normalizeMsisdn } from './util.js';

/* ───────────────────────── প্রোভাইডার তথ্য ───────────────────────── */

export const PROVIDERS = {
  bkash: {
    key: 'bkash',
    label: 'বিকাশ',
    shortcodes: ['16247'],
    names: ['bkash', 'bikash', 'বিকাশ'],
  },
  rocket: {
    key: 'rocket',
    label: 'রকেট',
    shortcodes: ['16216'],
    names: ['rocket', 'rocketbd', 'ডাচ-বাংলা', 'dutch bangla', 'dbbl'],
  },
  nagad: {
    key: 'nagad',
    label: 'নগদ',
    shortcodes: ['16167'],
    names: ['nagad', 'নগদ'],
  },
};

const BENGALI_DIGITS = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

/** বাংলা অঙ্ক, নানান স্পেস ও অদৃশ্য ক্যারেক্টার পরিষ্কার করে */
export function normalizeText(raw) {
  return String(raw ?? '')
    .replace(/[০-৯]/g, (d) => BENGALI_DIGITS[d] || d)
    .replace(/\u00a0|\u200b|\u200e|\u200f|\u202f/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ───────────────────────── প্রোভাইডার শনাক্তকরণ ───────────────────────── */

/**
 * প্রেরকের ঠিকানা (16247 / bKash) দেখে প্রোভাইডার ঠিক করে।
 * প্রেরক অজানা হলে টেক্সটের ভেতরে প্রোভাইডারের নাম খোঁজে —
 * কিন্তু তখন কেবল তখনই গ্রহণ করে যখন টেক্সটে ঠিক একটি প্রোভাইডারের নাম আছে।
 */
export function detectProvider(senderAddress, normalizedText) {
  const sender = String(senderAddress || '').toLowerCase().trim();
  const senderDigits = sender.replace(/[^\d]/g, '');

  // ১) শর্ট কোড — সবচেয়ে নির্ভরযোগ্য
  for (const p of Object.values(PROVIDERS)) {
    for (const code of p.shortcodes) {
      if (senderDigits === code || sender.includes(code)) {
        return { provider: p.key, via: 'shortcode' };
      }
    }
  }

  // ২) প্রেরকের ঠিকানায় ব্র্যান্ড নাম
  for (const p of Object.values(PROVIDERS)) {
    for (const name of p.names) {
      if (sender.includes(name)) return { provider: p.key, via: 'sender_name' };
    }
  }

  // ৩) টেক্সটে ব্র্যান্ড নাম — একাধিক নাম থাকলে অস্পষ্ট, তাই বাদ
  const text = normalizedText.toLowerCase();
  const found = Object.values(PROVIDERS).filter((p) =>
    p.names.some((name) => text.includes(name)),
  );
  if (found.length === 1) return { provider: found[0].key, via: 'text_name' };

  return { provider: null, via: found.length > 1 ? 'ambiguous' : 'none' };
}

/* ───────────────────────── দিক নির্ণয় (টাকা ঢুকেছে কি?) ───────────────────────── */

/** "টাকা ঢুকেছে" — এগুলো থাকলে মেসেজটি অবশ্যই ইনকামিং */
const STRONG_IN = [
  /\breceived\b/, /\bcredited\b/, /\bdeposited\b/, /\bcash\s*-?\s*in\b/, /\bcashin\b/,
  /পেয়েছেন/, /পেয়েছি/, /জমা\s*হয়েছে/, /গ্রহণ\s*কর/, /ক্যাশ\s*ইন/,
];

/** "টাকা বের হয়েছে" — এগুলো থাকলে আউটগোয়িং */
const STRONG_OUT = [
  /\byou\s+have\s+sent\b/, /\bsent\s+to\b/, /\bhas\s+been\s+sent\b/,
  /\bwithdrawn?\b/, /\bcash\s*-?\s*out\b/, /\bcashout\b/,
  /পাঠিয়েছেন/, /উত্তোলন/, /ক্যাশ\s*আউট/,
];

const WEAK_IN = [/\breceive\b/, /\bpayment\s+received\b/, /\bgot\b/, /ঢুকেছে/];

const WEAK_OUT = [
  /\bpayment\s+of\b/, /\bpayment\s+to\b/, /\bpaid\b/, /\btransfer(?:red)?\s+to\b/,
  /\brecharge\b/, /পরিশোধ/, /রিচার্জ/, /কাটা\s*হয়েছে/,
];

/**
 * দিক নির্ণয়। শক্তিশালী সংকেত আগে;
 * একইসাথে দুটো থাকলে (যেমন "You have received payment of ...") দুর্বল সংকেত দেখে ঠিক করি।
 */
export function detectDirection(normalizedText) {
  const text = normalizedText.toLowerCase();
  const strongIn = STRONG_IN.filter((re) => re.test(text)).length;
  const strongOut = STRONG_OUT.filter((re) => re.test(text)).length;
  const weakIn = WEAK_IN.filter((re) => re.test(text)).length;
  const weakOut = WEAK_OUT.filter((re) => re.test(text)).length;

  if (strongIn && !strongOut) {
    return { direction: 'received', inbound: strongIn + weakIn, outbound: weakOut };
  }
  if (strongOut && !strongIn) {
    return { direction: 'sent', inbound: weakIn, outbound: strongOut + weakOut };
  }

  // দুটোই শক্তিশালী, অথবা কোনোটিই নয় → দুর্বল সংকেতের ভোট
  const inbound = strongIn * 2 + weakIn;
  const outbound = strongOut * 2 + weakOut;
  if (inbound > outbound) return { direction: 'received', inbound, outbound };
  if (outbound > inbound) return { direction: 'sent', inbound, outbound };
  return { direction: 'other', inbound, outbound };
}

/* ───────────────────────── টাকার পরিমাণ ───────────────────────── */

// শব্দের সীমানা (\b) ইচ্ছাকৃতভাবে নেই — কারণ "100tk" / "৳100" / "১০০ টাকা"
// — তিন ধরনের লেখাই এলাকায় দেখা যায় (বাংলা + ইংরেজি মিশ্র)।
const MONEY_AFTER = /(?:৳|tk\.?|taka|bdt|টাকা)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/gi;
const MONEY_BEFORE = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:৳|tk|taka|bdt|টাকা)/gi;
/** যে শব্দগুলো থাকলে পাশের সংখ্যাটি লেনদেনের টাকা নয় */
const NON_AMOUNT_CONTEXT =
  /(balance|ব্যালেন্স|fee|ফি|charge|চার্জ|commission|কমিশন|limit|লিমিট)/gi;

/** পরিমাণের ঠিক আগের সবচেয়ে কাছের কীওয়ার্ডটি ফেরত দেয় */
function nearestContext(before) {
  NON_AMOUNT_CONTEXT.lastIndex = 0;
  let last = null;
  let m;
  while ((m = NON_AMOUNT_CONTEXT.exec(before)) !== null) last = m[1];
  return last;
}

function collectMoneyMatches(text) {
  const out = [];
  const push = (m, amountIndex) => {
    const before = text.slice(Math.max(0, m.index - 32), m.index);
    const value = m[amountIndex];
    const cents = toCents(value);
    if (cents === null) return;
    out.push({
      index: m.index,
      end: m.index + m[0].length,
      value,
      cents,
      excludedBy: nearestContext(before),
    });
  };

  MONEY_AFTER.lastIndex = 0;
  let m;
  while ((m = MONEY_AFTER.exec(text)) !== null) push(m, 1);

  MONEY_BEFORE.lastIndex = 0;
  while ((m = MONEY_BEFORE.exec(text)) !== null) {
    // একই অবস্থানে ডুপ্লিকেট এড়াই
    if (!out.some((e) => Math.abs(e.index - m.index) < 3)) push(m, 1);
  }

  return out.sort((a, b) => a.index - b.index);
}

export function extractAmount(normalizedText) {
  const all = collectMoneyMatches(normalizedText);
  if (!all.length) return { amountCents: null, balanceCents: null, all };

  // ব্যালেন্স আলাদা করে নিই
  const balanceHit = all.find((e) => /balance|ব্যালেন্স/i.test(e.excludedBy || ''));
  const balanceCents = balanceHit ? balanceHit.cents : null;

  // ফি/ব্যালেন্স/লিমিট বাদ দিয়ে প্রথম বৈধ পরিমাণটাই লেনদেনের টাকা
  const primary = all.find((e) => !e.excludedBy);
  return { amountCents: primary ? primary.cents : null, balanceCents, all };
}

/* ───────────────────────── TrxID ───────────────────────── */

const TRX_PATTERNS = [
  /\b(?:trx|txn|trnx|transaction|transection|trans)\s*(?:id|no|number|#)?\s*[:\-–#]?\s*([A-Za-z0-9]{5,32})\b/i,
  /\b(?:ref(?:erence)?|rrn|voucher)\s*(?:no|id|number|#)?\s*[:\-–#]?\s*([A-Za-z0-9]{5,32})\b/i,
  /(?:ট্রানজেকশন|ট্রান্সজেকশন|লেনদেন)\s*(?:আইডি|নং|নম্বর)?\s*[:\-–#]?\s*([A-Za-z0-9]{5,32})/i,
];

export function extractTrxId(normalizedText, senderMsisdn) {
  for (const re of TRX_PATTERNS) {
    const m = re.exec(normalizedText);
    if (!m) continue;
    const raw = m[1];
    const candidate = raw.toUpperCase();
    // নম্বরকে ভুল করে TrxID ধরবেন না
    if (/^01[3-9]\d{8}$/.test(candidate)) continue;
    if (senderMsisdn && candidate === senderMsisdn) continue;
    if (candidate.length < 5) continue;
    return candidate;
  }
  return null;
}

/* ───────────────────────── প্রেরকের নম্বর ───────────────────────── */

const MSISDN_RE = /\b(?:880|0)?1[3-9]\d{8}\b/g;

export function extractSenderMsisdn(normalizedText) {
  const text = normalizedText;

  // "from 01XXXXXXXXX" — সবচেয়ে নির্ভরযোগ্য
  const fromMatch = /\bfrom\s*[:\-]?\s*(\+?88)?(0?1[3-9]\d{8})\b/i.exec(text);
  if (fromMatch) {
    const normalized = normalizeMsisdn(fromMatch[1] ? '+880' + fromMatch[2].replace(/^0?1/, '') : fromMatch[2]);
    if (normalized) return normalized;
  }

  // নাহলে প্রথম বৈধ বাংলাদেশি মোবাইল নম্বর
  MSISDN_RE.lastIndex = 0;
  let m;
  while ((m = MSISDN_RE.exec(text)) !== null) {
    const normalized = normalizeMsisdn(m[0]);
    if (normalized) return normalized;
  }
  return null;
}

/* ───────────────────────── মূল ফাংশন ───────────────────────── */

/**
 * @param {{sender?: string, text?: string}} input
 * @returns {{
 *   provider: string|null, providerLabel: string|null, providerVia: string,
 *   direction: string, isPaymentIn: boolean,
 *   amountCents: number|null, balanceCents: number|null,
 *   trxId: string|null, senderMsisdn: string|null,
 *   ok: boolean, reason: string|null, notes: string[], normalizedText: string
 * }}
 */
export function parseMfsMessage({ sender, text } = {}) {
  const normalizedText = normalizeText(text);
  const notes = [];

  if (!normalizedText) {
    return fail('empty_message', 'মেসেজ খালি');
  }

  const { provider, via } = detectProvider(sender, normalizedText);
  if (!provider) {
    return fail(via === 'ambiguous' ? 'ambiguous_provider' : 'unknown_provider', 'প্রোভাইডার শনাক্ত হয়নি', {
      providerVia: via,
    });
  }
  const label = PROVIDERS[provider].label;

  const { direction, inbound, outbound } = detectDirection(normalizedText);
  notes.push(`direction=${direction} (in=${inbound}, out=${outbound})`);

  const senderMsisdn = extractSenderMsisdn(normalizedText);
  const { amountCents, balanceCents, all } = extractAmount(normalizedText);
  const trxId = extractTrxId(normalizedText, senderMsisdn);

  if (all.length > 1) notes.push(`${all.length}টি পরিমাণ পাওয়া গেছে, প্রেরিত/গ্রহণকৃত টাকাটি বেছে নেওয়া হয়েছে`);

  const base = {
    provider,
    providerLabel: label,
    providerVia: via,
    direction,
    amountCents,
    balanceCents,
    trxId,
    senderMsisdn,
    normalizedText,
    notes,
  };

  // ── গ্রহণযোগ্যতার শর্ত ──
  if (direction !== 'received') {
    return { ...base, isPaymentIn: false, ok: false, reason: 'not_incoming_payment' };
  }
  if (amountCents === null) {
    return { ...base, isPaymentIn: false, ok: false, reason: 'amount_not_found' };
  }
  if (!trxId) {
    return { ...base, isPaymentIn: false, ok: false, reason: 'trx_id_not_found' };
  }
  if (!senderMsisdn) {
    return { ...base, isPaymentIn: false, ok: false, reason: 'sender_not_found' };
  }

  return { ...base, isPaymentIn: true, ok: true, reason: null };
}

function fail(reason, message, extra = {}) {
  return {
    provider: null,
    providerLabel: null,
    providerVia: 'none',
    direction: 'other',
    amountCents: null,
    balanceCents: null,
    trxId: null,
    senderMsisdn: null,
    isPaymentIn: false,
    ok: false,
    reason,
    message,
    notes: [],
    normalizedText: '',
    ...extra,
  };
}
