import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseMfsMessage } from '../server/parser.js';

const NOW = '12/11/2026 10:30';

/* ─────────────── বিকাশ ─────────────── */

test('বিকাশ: সাধারণ ইনকামিং এসএমএস ঠিকভাবে পড়ে', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: `You have received Tk 1,500.00 from 01712345678. Fee Tk 0.00. Balance Tk 5,000.00. TrxID AB12CD34EF at ${NOW}. Download bKash app to enjoy more.`,
  });

  assert.equal(r.provider, 'bkash');
  assert.equal(r.direction, 'received');
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 150000);
  assert.equal(r.balanceCents, 500000);
  assert.equal(r.trxId, 'AB12CD34EF');
  assert.equal(r.senderMsisdn, '01712345678');
});

test('বিকাশ: প্রেরকের নাম "bKash" থেকেও শনাক্ত হয়', () => {
  const r = parseMfsMessage({
    sender: 'bKash',
    text: 'You have received Tk 500.00 from 01812345678. Fee Tk 0.00. TrxID XY99ZZ11QQ at 12/11/2026',
  });
  assert.equal(r.provider, 'bkash');
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 50000);
});

test('বিকাশ: টাকা পাঠানোর এসএমএস বাদ পড়ে', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'You have sent Tk 500.00 to 01712345678 successfully. Fee Tk 0.00. Balance Tk 900.00. TrxID SEND123456 at 12/11/2026',
  });
  assert.equal(r.direction, 'sent');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not_incoming_payment');
});

test('বিকাশ: "Payment of" (মার্চেন্ট পেমেন্ট) বাদ পড়ে', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'Payment of Tk 200.00 to SHOP123 successful. TrxID PAY12AB34C at 12/11/2026 10:30. Balance Tk 1,000.00',
  });
  assert.equal(r.direction, 'sent');
  assert.equal(r.ok, false);
});

test('বিকাশ: "You have received payment of" ইনকামিং হিসেবেই ধরা হয়', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'You have received payment of Tk 750.00 from 01911223344. TrxID RCVD12345 at 12/11/2026',
  });
  assert.equal(r.direction, 'received');
  assert.equal(r.amountCents, 75000);
});

test('বিকাশ: Cash In মেসেজে ফি ও ব্যালেন্স ট্রাঞ্জেকশনের টাকা নয়', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'You have received Tk 1,000.00 from 01712345678 (Cash In). Fee Tk 0.00. Balance Tk 2,500.00. TrxID CI12345678 at 12/11/2026',
  });
  assert.equal(r.amountCents, 100000);
  assert.equal(r.balanceCents, 250000);
});

/* ─────────────── রকেট ─────────────── */

test('রকেট: 16216 থেকে আসা মেসেজ ও TxnID', () => {
  const r = parseMfsMessage({
    sender: '16216',
    text: 'You have received Tk 500.00 from 01812345678. TxnID 1234567890123. Your new balance is Tk 1,200.00.',
  });
  assert.equal(r.provider, 'rocket');
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 50000);
  assert.equal(r.trxId, '1234567890123');
  assert.equal(r.senderMsisdn, '01812345678');
  assert.equal(r.balanceCents, 120000);
});

test('রকেট: Ref নম্বরও TrxID হিসেবে নেওয়া হয়', () => {
  const r = parseMfsMessage({
    sender: 'Rocket',
    text: 'You have received Tk 300.00 from 01999887766. Ref: 998877665544. Balance Tk 400.00',
  });
  assert.equal(r.provider, 'rocket');
  assert.equal(r.trxId, '998877665544');
});

/* ─────────────── নগদ ─────────────── */

test('নগদ: 16167 থেকে ইনকামিং পেমেন্ট', () => {
  const r = parseMfsMessage({
    sender: '16167',
    text: 'You have received Tk 1,000.00 from 01912345678. Your new balance is Tk 2,500.00. TrxID 1234567890. Date: 12/11/2026 10:30',
  });
  assert.equal(r.provider, 'nagad');
  assert.equal(r.ok, true);
  assert.equal(r.amountCents, 100000);
  assert.equal(r.trxId, '1234567890');
});

/* ─────────────── বাংলা টেক্সট ─────────────── */

test('বাংলা অঙ্ক ও বাংলা লেখা ঠিকভাবে পড়ে', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'আপনি ০১৭১২৩৪৫৬৭৮ থেকে ৫০০.০০ টাকা পেয়েছেন। ব্যালেন্স ১০০০.০০ টাকা। ট্রানজেকশন আইডি: AB12CD34EF',
  });
  assert.equal(r.provider, 'bkash');
  assert.equal(r.amountCents, 50000);
  assert.equal(r.balanceCents, 100000);
  assert.equal(r.trxId, 'AB12CD34EF');
  assert.equal(r.senderMsisdn, '01712345678');
  assert.equal(r.ok, true);
});

/* ─────────────── প্রতিরক্ষামূলক কেস ─────────────── */

test('অজানা প্রেরক ও একাধিক ব্র্যান্ড নাম → প্রোভাইডার শনাক্ত হয় না', () => {
  const r = parseMfsMessage({
    sender: '+8801700000000',
    text: 'bKash and Nagad both received Tk 100 somewhere',
  });
  assert.equal(r.provider, null);
  assert.equal(r.ok, false);
});

test('TrxID ছাড়া পেমেন্ট ম্যাচিংয়ের জন্য গ্রহণ করা হয় না', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'You have received Tk 900.00 from 01712345678. Balance Tk 1,900.00.',
  });
  assert.equal(r.amountCents, 90000);
  assert.equal(r.trxId, null);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'trx_id_not_found');
});

test('প্রেরকের নম্বর ছাড়া মেসেজ গ্রহণ করা হয় না', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'You have received Tk 900.00. TrxID NOSENDER01 at 12/11/2026',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sender_not_found');
});

test('খালি মেসেজ', () => {
  const r = parseMfsMessage({ sender: '16247', text: '   ' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empty_message');
});

test('TrxID কখনো ফোন নম্বর হিসেবে ধরা হয় না', () => {
  const r = parseMfsMessage({
    sender: '16247',
    text: 'You have received Tk 10.00 from 01712345678. TrxID 01712345678 at 12/11/2026',
  });
  // নম্বরটি TrxID হিসেবে গৃহীত হয় না, ফলে trx_id_not_found
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'trx_id_not_found');
});

test('৳ চিহ্ন দিয়েও পরিমাণ পড়া যায়', () => {
  const r = parseMfsMessage({
    sender: '16167',
    text: 'You have received ৳250.00 from 01812345678. TrxID TAKA123456',
  });
  assert.equal(r.amountCents, 25000);
});
