import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toCents, normalizeMsisdn } from '../server/util.js';
import { parseMfsMessage } from '../server/parser.js';

/* ─────────────── ব্যবহারকারীর লেখা পরিমাণ ─────────────── */

test('"১০০ টাকা" → ১০০০০ পয়সা', () => {
  assert.equal(toCents('১০০ টাকা'), 10_000);
});

test('"১০০" (শুধু বাংলা অঙ্ক) → ১০০০০ পয়সা', () => {
  assert.equal(toCents('১০০'), 10_000);
});

test('"৳100", "100tk", "100 TK", "Tk 100" — সবই ১০০০০', () => {
  assert.equal(toCents('৳100'), 10_000);
  assert.equal(toCents('100tk'), 10_000);
  assert.equal(toCents('100 TK'), 10_000);
  assert.equal(toCents('Tk 100'), 10_000);
  assert.equal(toCents('100 taka'), 10_000);
});

test('কমা ও দশমিক ঠিকভাবে হ্যান্ডেল করে', () => {
  assert.equal(toCents('1,500.00'), 150_000);
  assert.equal(toCents('১০০.৫০'), 10_050);
  assert.equal(toCents(250.75), 25_075);
});

test('খালি বা অর্থহীন ইনপুট null দেয় (০ নয়)', () => {
  assert.equal(toCents(''), null);
  assert.equal(toCents('   '), null);
  assert.equal(toCents('টাকা'), null);
  assert.equal(toCents(null), null);
  assert.equal(toCents('abc'), null);
});

test('বাংলা অঙ্কে নম্বর লেখা হলেও প্রেরক ঠিকভাবে পড়া যায়', () => {
  assert.equal(normalizeMsisdn('০১৭১২৩৪৫৬৭৮'), '01712345678');
  assert.equal(normalizeMsisdn('+8801712345678'), '01712345678');
});

/* ─────────────── মূল দাবি: বাংলা-ইংরেজি মিশ্র ম্যাচিং ─────────────── */

test('অর্ডারে "১০০ টাকা", এসএমএসে "100tk" → একই পরিমাণ', () => {
  const orderCents = toCents('১০০ টাকা');
  const parsed = parseMfsMessage({
    sender: '16247',
    text: 'You have received 100tk from 01712345678. TrxID MIX12345 at 12/11/2026',
  });

  assert.equal(orderCents, 10_000);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.amountCents, orderCents);
});

test('অর্ডারে "100", এসএমএসে "১০০ টাকা পেয়েছেন" → একই পরিমাণ', () => {
  const orderCents = toCents('100');
  const parsed = parseMfsMessage({
    sender: '16247',
    text: 'আপনি ০১৭১২৩৪৫৬৭৮ থেকে ১০০ টাকা পেয়েছেন। TrxID BNGL12345',
  });

  assert.equal(orderCents, 10_000);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.amountCents, orderCents);
});

test('"৳100.50" আর "১০০.৫০ টাকা" দুই ক্ষেত্রেই ১০০৫০', () => {
  assert.equal(toCents('৳100.50'), 10_050);
  const parsed = parseMfsMessage({
    sender: '16167',
    text: 'আপনি ০১৮১২৩৪৫৬৭৮ থেকে ১০০.৫০ টাকা পেয়েছেন। TrxID DEC50001',
  });
  assert.equal(parsed.amountCents, 10_050);
});

test('স্পেসবিহীন "1000tk" ও কমাসহ "1,000.00" একই', () => {
  const a = parseMfsMessage({
    sender: '16216',
    text: 'You have received 1,000.00tk from 01812345678. TxnID 1234567890123',
  });
  const b = parseMfsMessage({
    sender: '16216',
    text: 'You have received 1000tk from 01812345678. TxnID 1234567890124',
  });
  assert.equal(a.amountCents, 100_000);
  assert.equal(b.amountCents, 100_000);
});

test('ব্যালেন্স বাংলায় লেখা হলেও লেনদেনের টাকা ভুল হয় না', () => {
  const parsed = parseMfsMessage({
    sender: '16247',
    text: 'আপনি ০১৭১২৩৪৫৬৭৮ থেকে ১০০ টাকা পেয়েছেন। ব্যালেন্স ৫০০০ টাকা। TrxID BNBAL001',
  });
  assert.equal(parsed.amountCents, 10_000);
  assert.equal(parsed.balanceCents, 500_000);
});
