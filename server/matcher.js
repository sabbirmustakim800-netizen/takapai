/**
 * ম্যাচিং ইঞ্জিন
 * ─────────────
 * নিয়ম (সবগুলো একসাথে সত্য হতে হবে):
 *   ১. একই প্রোভাইডার (বিকাশ/রকেট/নগদ)
 *   ২. হুবহু একই টাকার পরিমাণ (পয়সা পর্যন্ত)
 *   ৩. একই প্রেরকের নম্বর
 *   ৪. অর্ডারে TrxID দেওয়া থাকলে TrxID-ও হুবহু মিলতে হবে
 *   ৫. এসএমএস এসেছে অর্ডার তৈরির আগে-পরে নির্দিষ্ট সময়সীমার ভেতরে
 *   ৬. অর্ডার এখনো pending, আর এসএমএসটি এখনো কেউ ব্যবহার করেনি
 *
 * একবার ব্যবহার নিষিদ্ধ (one-time): claim() একটি ট্রানজ্যাকশনের ভেতরে
 * দুটি শর্তসহ UPDATE চালায় — দুটোই সফল হলেই ম্যাচ হয়, নাহলে পুরোটা rollback।
 * তাই একই TrxID/Second request কখনোই দুইবার টাকা ছাড়তে পারবে না।
 */

import { q, transaction } from './db.js';
import { nowIso } from './util.js';

/** ঘড়ির সামান্য অমিল মেনে নেওয়ার সহনশীলতা */
const CLOCK_SKEW_MS = 60_000;

/**
 * একটি এসএমএস ইভেন্টের জন্য উপযুক্ত pending অর্ডার খুঁজে বের করে।
 */
export function findOrderForEvent(event) {
  if (!event.trx_id || !event.sender_msisdn || !event.amount_cents) return null;

  const receivedAt = Date.parse(event.received_at);
  if (!Number.isFinite(receivedAt)) return null;

  return (
    q.get(
      `SELECT * FROM orders
        WHERE merchant_id = ?
          AND status = 'pending'
          AND provider = ?
          AND amount_cents = ?
          AND sender_msisdn = ?
          AND created_at <= ?
          AND expires_at >= ?
          AND (trx_id IS NULL OR trx_id = ?)
        ORDER BY created_at ASC
        LIMIT 1`,
      event.merchant_id,
      event.provider,
      event.amount_cents,
      event.sender_msisdn,
      new Date(receivedAt + CLOCK_SKEW_MS).toISOString(),
      event.received_at,
      event.trx_id,
    ) || null
  );
}

/**
 * একটি নতুন অর্ডারের জন্য আগে থেকেই পড়ে থাকা (unmatched) এসএমএস খুঁজে বের করে।
 * গ্রাহক আগে টাকা দিয়ে পরে অর্ডার সাবমিট করলে এই পথেই ম্যাচ হয়।
 */
export function findEventForOrder(order, windowBeforeSeconds) {
  const createdAt = Date.parse(order.created_at);
  if (!Number.isFinite(createdAt)) return null;

  const lowerBound = new Date(createdAt - windowBeforeSeconds * 1000).toISOString();
  const upperBound = new Date(createdAt + CLOCK_SKEW_MS).toISOString();

  return (
    q.get(
      `SELECT * FROM sms_events
        WHERE merchant_id = ?
          AND status = 'unmatched'
          AND direction = 'received'
          AND provider = ?
          AND amount_cents = ?
          AND sender_msisdn = ?
          AND received_at >= ?
          AND received_at <= ?
          AND (? IS NULL OR trx_id = ?)
        ORDER BY received_at ASC
        LIMIT 1`,
      order.merchant_id,
      order.provider,
      order.amount_cents,
      order.sender_msisdn,
      lowerBound,
      upperBound,
      order.trx_id,
      order.trx_id,
    ) || null
  );
}

export class AlreadyConsumedError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * অর্ডার ও এসএমএস দুটোকেই একযোগে "ব্যবহৃত" হিসেবে দখল করে।
 * দুটির একটিও আগে থেকে দখল করা থাকলে কিছুই বদলায় না (rollback)।
 */
export function claim(eventId, orderId) {
  return transaction(() => {
    const now = nowIso();

    const eventUpdate = q.run(
      `UPDATE sms_events
          SET status = 'matched', matched_order_id = ?, matched_at = ?
        WHERE id = ? AND status = 'unmatched'`,
      orderId,
      now,
      eventId,
    );
    if (Number(eventUpdate.changes) !== 1) {
      throw new AlreadyConsumedError('event_already_consumed');
    }

    const orderUpdate = q.run(
      `UPDATE orders
          SET status = 'matched', matched_event_id = ?, matched_at = ?
        WHERE id = ? AND status = 'pending'`,
      eventId,
      now,
      orderId,
    );
    if (Number(orderUpdate.changes) !== 1) {
      throw new AlreadyConsumedError('order_already_resolved');
    }

    return { matchedAt: now };
  });
}

/** মেয়াদোত্তীর্ণ pending অর্ডারগুলো expire করে */
export function expireOrders() {
  const res = q.run(
    `UPDATE orders SET status = 'expired'
      WHERE status = 'pending' AND expires_at < ?`,
    nowIso(),
  );
  return Number(res.changes) || 0;
}

/** পুরনো unmatched এসএমএস (৭ দিনের বেশি) আর্কাইভ করে দেয় */
export function pruneOldEvents(days = 45) {
  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const res = q.run(
    `DELETE FROM sms_events
      WHERE status IN ('duplicate', 'ignored')
        AND ingested_at < ?`,
    cutoff,
  );
  return Number(res.changes) || 0;
}
