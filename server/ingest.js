/**
 * ইনজেস্ট পাইপলাইন
 * ─────────────────
 * ডিভাইস থেকে আসা প্রতিটি মেসেজ এখান দিয়ে যায়:
 *   ভ্যালিডেশন → পার্স → ডুপ্লিকেট চেক → সংরক্ষণ → ম্যাচিং
 *
 * এই ফাইলের বাইরে কখনো সরাসরি sms_events-এ লেখা হয় না।
 */

import { q } from './db.js';
import { parseMfsMessage } from './parser.js';
import { findOrderForEvent, claim, AlreadyConsumedError } from './matcher.js';
import { newId, nowIso } from './util.js';
import { runWebhook } from './webhook.js';

const MAX_EVENTS_PER_REQUEST = 50;
const MAX_TEXT_LENGTH = 2000;
const MAX_SENDER_LENGTH = 120;

export function validateEventPayload(raw, index) {
  if (!raw || typeof raw !== 'object') {
    return { error: { index, reason: 'invalid_event', message: 'ইভেন্ট অবজেক্ট নয়' } };
  }

  const clientEventId = String(raw.client_event_id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{6,80}$/.test(clientEventId)) {
    return { error: { index, reason: 'invalid_client_event_id' } };
  }

  const source = String(raw.source ?? 'sms').toLowerCase();
  if (!['sms', 'notification', 'simulator'].includes(source)) {
    return { error: { index, client_event_id: clientEventId, reason: 'invalid_source' } };
  }

  const sender = String(raw.sender ?? '').slice(0, MAX_SENDER_LENGTH);
  const text = String(raw.text ?? '').slice(0, MAX_TEXT_LENGTH);
  if (!text.trim()) {
    return { error: { index, client_event_id: clientEventId, reason: 'empty_text' } };
  }

  return {
    value: {
      client_event_id: clientEventId,
      source,
      sender,
      text,
      received_at: resolveDeviceTime(raw.received_at),
    },
  };
}

/** ডিভাইসের ঘড়ি ভুল হতে পারে — বাস্তবসম্মত সীমার বাইরে হলে সার্ভারের সময় ব্যবহার করি */
function resolveDeviceTime(input) {
  const now = Date.now();
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) return new Date(now).toISOString();
  if (parsed > now + 10 * 60 * 1000) return new Date(now).toISOString();
  if (parsed < now - 30 * 24 * 3600 * 1000) return new Date(now).toISOString();
  return new Date(parsed).toISOString();
}

/**
 * একটি ইভেন্ট প্রসেস করে ফলাফল দেয় (কখনো throw করে না)।
 * @returns {{client_event_id:string,status:string,order_id?:string,event_id?:string,reason?:string,provider?:string,trx_id?:string,amount_cents?:number}}
 */
export function processEvent(device, payload) {
  const parsed = parseMfsMessage({ sender: payload.sender, text: payload.text });
  const now = nowIso();

  // ── ১) আগে থেকেই এই ইভেন্ট প্রসেস হয়েছে? (ডিভাইসের পুনরায় চেষ্টা) ──
  const existing = q.get(
    'SELECT * FROM sms_events WHERE device_id = ? AND client_event_id = ?',
    device.id,
    payload.client_event_id,
  );
  if (existing) {
    return toResult(existing, 'already_received');
  }

  // ── ২) প্রোভাইডার শনাক্ত হয়নি → বাদ ──
  if (!parsed.provider) {
    return storeAndReport({
      device,
      payload,
      parsed,
      status: 'ignored',
      reason: parsed.reason || 'unknown_provider',
      trxIdForStorage: null,
    });
  }

  // ── ৩) গ্রহণযোগ্য ইনকামিং পেমেন্ট নয় → বাদ (তবে অডিটের জন্য রাখি) ──
  if (!parsed.ok) {
    return storeAndReport({
      device,
      payload,
      parsed,
      status: 'ignored',
      reason: parsed.reason || 'not_a_payment',
      trxIdForStorage: null,
    });
  }

  // ── ৪) একই TrxID আগে এসেছে? → চিরতরে ডুপ্লিকেট ──
  const previous = q.get(
    `SELECT * FROM sms_events
      WHERE provider = ? AND trx_id = ? AND status <> 'duplicate'
      LIMIT 1`,
    parsed.provider,
    parsed.trxId,
  );
  if (previous) {
    return storeAndReport({
      device,
      payload,
      parsed,
      status: 'duplicate',
      reason: 'trx_id_already_used',
      trxIdForStorage: parsed.trxId,
      matchedOrderId: previous.matched_order_id || null,
    });
  }

  // ── ৫) সংরক্ষণ ──
  const eventId = newId('evt');
  let insertError = null;
  try {
    q.run(
      `INSERT INTO sms_events
        (id, merchant_id, device_id, client_event_id, provider, source, sender_address, raw_text,
         direction, status, amount_cents, trx_id, sender_msisdn, balance_cents, parsed_at,
         device_time, received_at, ingested_at, reason)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      eventId,
      device.merchant_id,
      device.id,
      payload.client_event_id,
      parsed.provider,
      payload.source,
      payload.sender,
      payload.text,
      parsed.direction,
      'unmatched',
      parsed.amountCents,
      parsed.trxId,
      parsed.senderMsisdn,
      parsed.balanceCents,
      now,
      payload.received_at,
      payload.received_at,
      now,
      null,
    );
  } catch (err) {
    insertError = err;
    // ইউনিক ইনডেক্স ধরেছে (সম্ভাব্য রেস) → ডুপ্লিকেট হিসেবে লেখার চেষ্টা
    if (!/UNIQUE/i.test(String(err?.message))) throw err;
  }

  if (insertError) {
    return storeAndReport({
      device,
      payload,
      parsed,
      status: 'duplicate',
      reason: 'trx_id_already_used',
      trxIdForStorage: parsed.trxId,
    });
  }

  const event = q.get('SELECT * FROM sms_events WHERE id = ?', eventId);

  // ── ৬) ম্যাচিং ──
  const order = findOrderForEvent(event);
  if (!order) {
    return toResult(event, 'no_matching_order');
  }

  try {
    const { matchedAt } = claim(event.id, order.id);
    const matchedEvent = q.get('SELECT * FROM sms_events WHERE id = ?', event.id);
    const matchedOrder = q.get('SELECT * FROM orders WHERE id = ?', order.id);

    runWebhook(device.merchant_id, matchedOrder, matchedEvent);

    return {
      client_event_id: payload.client_event_id,
      status: 'matched',
      order_id: order.id,
      event_id: event.id,
      provider: parsed.provider,
      trx_id: parsed.trxId,
      amount_cents: parsed.amountCents,
      matched_at: matchedAt,
      reason: null,
    };
  } catch (err) {
    if (err instanceof AlreadyConsumedError) {
      // এর মধ্যেই অন্য কেউ ব্যবহার করে ফেলেছে → চিরতরে ডুপ্লিকেট
      return toResult(q.get('SELECT * FROM sms_events WHERE id = ?', event.id), 'race_lost');
    }
    throw err;
  }
}

function storeAndReport({ device, payload, parsed, status, reason, trxIdForStorage, matchedOrderId = null }) {
  const eventId = newId('evt');
  const now = nowIso();
  q.run(
    `INSERT INTO sms_events
      (id, merchant_id, device_id, client_event_id, provider, source, sender_address, raw_text,
       direction, status, amount_cents, trx_id, sender_msisdn, balance_cents, parsed_at,
       device_time, received_at, ingested_at, reason, matched_order_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    eventId,
    device.merchant_id,
    device.id,
    payload.client_event_id,
    parsed.provider || 'unknown',
    payload.source,
    payload.sender,
    payload.text,
    parsed.direction || 'other',
    status,
    parsed.amountCents ?? null,
    trxIdForStorage ?? null,
    parsed.senderMsisdn ?? null,
    parsed.balanceCents ?? null,
    now,
    payload.received_at,
    payload.received_at,
    now,
    reason,
    matchedOrderId,
  );

  return {
    client_event_id: payload.client_event_id,
    status,
    event_id: eventId,
    provider: parsed.provider || 'unknown',
    trx_id: trxIdForStorage ?? null,
    amount_cents: parsed.amountCents ?? null,
    order_id: matchedOrderId || undefined,
    reason,
  };
}

function toResult(event, reason) {
  return {
    client_event_id: event.client_event_id,
    status: event.status,
    event_id: event.id,
    order_id: event.matched_order_id || undefined,
    provider: event.provider,
    trx_id: event.trx_id,
    amount_cents: event.amount_cents,
    reason: event.reason || reason || null,
  };
}

/** ব্যাচ ইনজেস্ট */
export function ingestBatch(device, events) {
  if (!Array.isArray(events)) return { error: 'events_must_be_array' };
  if (events.length === 0) return { results: [] };
  if (events.length > MAX_EVENTS_PER_REQUEST) return { error: 'too_many_events' };

  const results = [];
  events.forEach((raw, index) => {
    const checked = validateEventPayload(raw, index);
    if (checked.error) {
      results.push({ status: 'invalid', ...checked.error });
      return;
    }
    try {
      results.push(processEvent(device, checked.value));
    } catch (err) {
      console.error('[ingest] event failed:', err?.message);
      results.push({
        client_event_id: checked.value.client_event_id,
        status: 'error',
        reason: 'internal_error',
      });
    }
  });

  q.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', nowIso(), device.id);

  return {
    results,
    summary: {
      total: results.length,
      matched: results.filter((r) => r.status === 'matched').length,
      duplicate: results.filter((r) => r.status === 'duplicate').length,
      ignored: results.filter((r) => r.status === 'ignored').length,
    },
  };
}
