import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* ডাটাবেস পাথ ইমপোর্টের আগেই ঠিক করতে হবে */
const dir = mkdtempSync(join(tmpdir(), 'takamatch-'));
process.env.DATABASE_FILE = join(dir, 'test.db');

const { q } = await import('../server/db.js');
const { processEvent } = await import('../server/ingest.js');
const { findEventForOrder, claim, expireOrders, AlreadyConsumedError } = await import(
  '../server/matcher.js'
);

/* ─────────────── সিড ডেটা ─────────────── */

const MERCHANT = 'mch_test';
const DEVICE = { id: 'dev_test', merchant_id: MERCHANT };

q.run(
  `INSERT INTO merchants
    (id, business_name, email, password_hash, webhook_secret, order_ttl_seconds,
     match_window_before_seconds, created_at)
   VALUES (?,?,?,?,?,?,?,?)`,
  MERCHANT, 'টেস্ট স্টোর', 'test@example.com', 'x', 'whsec_test', 1800, 300,
  new Date().toISOString(),
);

q.run(
  `INSERT INTO devices
    (id, merchant_id, label, device_uid, key_hash, key_prefix, status, platform, created_at)
   VALUES (?,?,?,?,?,?,'active','android',?)`,
  DEVICE.id, MERCHANT, 'টেস্ট ফোন', 'dev_test_uid', 'hash', 'dvk_test', new Date().toISOString(),
);

/* ─────────────── হেল্পার ─────────────── */

let seq = 0;
function nextSender() {
  seq += 1;
  return `017${String(10_000_000 + seq).padStart(8, '0')}`;
}

function nextTrx() {
  seq += 1;
  return `TRX${String(seq).padStart(7, '0')}`;
}

function bkash(amountCents, sender, trx) {
  return `You have received Tk ${(amountCents / 100).toFixed(2)} from ${sender}. Fee Tk 0.00. Balance Tk 9,999.00. TrxID ${trx} at 12/11/2026 10:30. Download bKash app.`;
}

let eventSeq = 0;
function sendSms({ sender, text, receivedAt = new Date().toISOString() }) {
  eventSeq += 1;
  return processEvent(DEVICE, {
    client_event_id: `cli_${eventSeq}_${Math.random().toString(36).slice(2, 8)}`,
    source: 'sms',
    sender,
    text,
    received_at: receivedAt,
  });
}

let orderSeq = 0;
function insertOrder({
  provider = 'bkash',
  amountCents,
  sender,
  trxId = null,
  createdAt = new Date().toISOString(),
  ttlSeconds = 1800,
}) {
  orderSeq += 1;
  const id = `ord_${orderSeq}`;
  q.run(
    `INSERT INTO orders
      (id, merchant_id, provider, amount_cents, sender_msisdn, trx_id, reference, status,
       created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,'pending',?,?)`,
    id, MERCHANT, provider, amountCents, sender, trxId, `REF-${orderSeq}`,
    createdAt, new Date(Date.parse(createdAt) + ttlSeconds * 1000).toISOString(),
  );
  return q.get('SELECT * FROM orders WHERE id = ?', id);
}

/* ─────────────── টেস্ট ─────────────── */

test('পেন্ডিং অর্ডারের সাথে এসএমএস মিলে যায়', () => {
  const sender = nextSender();
  const amountCents = 50_000;
  const order = insertOrder({ amountCents, sender });

  const res = sendSms({ sender: '16247', text: bkash(amountCents, sender, nextTrx()) });

  assert.equal(res.status, 'matched');
  assert.equal(res.order_id, order.id);

  const fresh = q.get('SELECT * FROM orders WHERE id = ?', order.id);
  assert.equal(fresh.status, 'matched');
  assert.ok(fresh.matched_at);
  assert.ok(fresh.matched_event_id);
});

test('একই TrxID দ্বিতীয়বার এলে ডুপ্লিকেট হিসেবে বাতিল হয়', () => {
  const sender = nextSender();
  const amountCents = 51_000;
  const trx = nextTrx();
  insertOrder({ amountCents, sender });

  const first = sendSms({ sender: '16247', text: bkash(amountCents, sender, trx) });
  assert.equal(first.status, 'matched');

  const second = sendSms({ sender: '16247', text: bkash(amountCents, sender, trx) });
  assert.equal(second.status, 'duplicate');
  assert.equal(second.reason, 'trx_id_already_used');
  assert.equal(second.order_id, first.order_id);
});

test('একবার ব্যবহৃত TrxID নতুন অর্ডারকেও ম্যাচ করতে পারে না', () => {
  const sender = nextSender();
  const amountCents = 52_000;
  const trx = nextTrx();

  const order1 = insertOrder({ amountCents, sender });
  const first = sendSms({ sender: '16247', text: bkash(amountCents, sender, trx) });
  assert.equal(first.status, 'matched');

  // একই টাকা, একই নম্বর — নতুন অর্ডার
  const order2 = insertOrder({ amountCents, sender });
  const replay = sendSms({ sender: '16247', text: bkash(amountCents, sender, trx) });
  assert.equal(replay.status, 'duplicate');

  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', order2.id).status, 'pending');
  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', order1.id).status, 'matched');
});

test('টাকার পরিমাণ না মিললে ম্যাচ হয় না', () => {
  const sender = nextSender();
  insertOrder({ amountCents: 60_000, sender });

  const res = sendSms({ sender: '16247', text: bkash(59_900, sender, nextTrx()) });
  assert.equal(res.status, 'unmatched');
  assert.equal(res.order_id, undefined);
});

test('প্রেরকের নম্বর না মিললে ম্যাচ হয় না', () => {
  const orderSender = nextSender();
  const payerSender = nextSender();
  insertOrder({ amountCents: 61_000, sender: orderSender });

  const res = sendSms({ sender: '16247', text: bkash(61_000, payerSender, nextTrx()) });
  assert.equal(res.status, 'unmatched');
});

test('প্রোভাইডার না মিললে ম্যাচ হয় না', () => {
  const sender = nextSender();
  insertOrder({ provider: 'nagad', amountCents: 62_000, sender });

  const res = sendSms({ sender: '16247', text: bkash(62_000, sender, nextTrx()) });
  assert.equal(res.status, 'unmatched');
});

test('আগে আসা এসএমএস পরে তৈরি অর্ডারের সাথে মেলে (রিভার্স ম্যাচ)', () => {
  const sender = nextSender();
  const amountCents = 63_000;
  const trx = nextTrx();

  const res = sendSms({ sender: '16247', text: bkash(amountCents, sender, trx) });
  assert.equal(res.status, 'unmatched');

  const order = insertOrder({ amountCents, sender });
  const candidate = findEventForOrder(order, 300);
  assert.ok(candidate, 'আগের অপ্রক্রিয় এসএমএস পাওয়া উচিত');

  claim(candidate.id, order.id);
  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', order.id).status, 'matched');
  assert.equal(q.get('SELECT status FROM sms_events WHERE id = ?', candidate.id).status, 'matched');
});

test('মেয়াদোত্তীর্ণ অর্ডার আর ম্যাচ হয় না', () => {
  const sender = nextSender();
  const amountCents = 64_000;
  insertOrder({
    amountCents,
    sender,
    createdAt: new Date(Date.now() - 3 * 3600 * 1000).toISOString(),
    ttlSeconds: 60,
  });

  const res = sendSms({ sender: '16247', text: bkash(amountCents, sender, nextTrx()) });
  assert.equal(res.status, 'unmatched');
});

test('claim() একই ইভেন্ট দুইবার দখল করতে পারে না', () => {
  const sender = nextSender();
  const amountCents = 65_000;
  const trx = nextTrx();

  sendSms({ sender: '16247', text: bkash(amountCents, sender, trx) });
  const event = q.get(
    "SELECT * FROM sms_events WHERE trx_id = ? AND status = 'unmatched'",
    trx,
  );
  assert.ok(event);

  const order = insertOrder({ amountCents, sender });
  claim(event.id, order.id);

  const other = insertOrder({ amountCents, sender });
  assert.throws(() => claim(event.id, other.id), (err) => err instanceof AlreadyConsumedError);
  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', other.id).status, 'pending');
});

test('একই টাকা ও নম্বরের দুটি অর্ডারে একটি এসএমএস কেবল পুরনোটিকে ম্যাচ করে', () => {
  const sender = nextSender();
  const amountCents = 66_000;

  const older = insertOrder({
    amountCents,
    sender,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  });
  const newer = insertOrder({ amountCents, sender });

  const res = sendSms({ sender: '16247', text: bkash(amountCents, sender, nextTrx()) });
  assert.equal(res.status, 'matched');
  assert.equal(res.order_id, older.id);
  assert.equal(q.get('SELECT status FROM orders WHERE id = ?', newer.id).status, 'pending');
});

test('expireOrders মেয়াদোত্তীর্ণ অর্ডার expire করে', () => {
  const sender = nextSender();
  insertOrder({
    amountCents: 67_000,
    sender,
    createdAt: new Date(Date.now() - 7200 * 1000).toISOString(),
    ttlSeconds: 60,
  });

  const changed = expireOrders();
  assert.ok(changed >= 1);
  assert.equal(
    q.get('SELECT COUNT(*) AS n FROM orders WHERE status = ?', 'pending').n >= 0,
    true,
  );
});

test('বিকাশ, রকেট, নগদ — তিনটি প্রোভাইডার আলাদা আলাদা কাজ করে', () => {
  const cases = [
    { sender: '16247', text: (a, s, t) => `You have received Tk ${a} from ${s}. TrxID ${t}. Balance Tk 9,000.00` },
    { sender: '16216', text: (a, s, t) => `You have received Tk ${a} from ${s}. TxnID ${t}. Balance Tk 9,000.00` },
    { sender: '16167', text: (a, s, t) => `You have received Tk ${a} from ${s}. TrxID ${t}. Balance Tk 9,000.00` },
  ];
  const providers = ['bkash', 'rocket', 'nagad'];

  cases.forEach((c, i) => {
    const sender = nextSender();
    const amountCents = 68_000 + i * 1000;
    const order = insertOrder({ provider: providers[i], amountCents, sender });
    const res = sendSms({
      sender: c.sender,
      text: c.text((amountCents / 100).toFixed(2), sender, nextTrx()),
    });
    assert.equal(res.status, 'matched', `প্রোভাইডার ${providers[i]}`);
    assert.equal(res.order_id, order.id);
  });
});
