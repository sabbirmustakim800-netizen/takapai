/**
 * ম্যাচ সফল হলে মার্চেন্টের সিস্টেমে signed webhook পাঠায়।
 * এই webhook-ই "টাকা দিয়ে দাও / ডেলিভারি করো" — অর্থাৎ অটো-পেমেন্ট আউটপুট।
 *
 * সিকিউরিটি:
 *  - শরীরের HMAC-SHA256 সিগনেচার (X-Signature: sha256=...)
 *  - মানি-কম্প্যারিজন, fire-and-forget + ৩ বার রিট্রাই
 *  - সিক্রেট শুধু মার্চেন্ট নিজের ড্যাশবোর্ডে দেখতে পায়
 */

import crypto from 'node:crypto';
import { q, audit } from './db.js';
import { nowIso } from './util.js';

const RETRY_DELAYS_MS = [1000, 3000, 9000];
const TIMEOUT_MS = 10_000;

export function buildPayload(merchantId, order, event) {
  return {
    event: 'payment.matched',
    merchant_id: merchantId,
    order: {
      id: order.id,
      reference: order.reference,
      provider: order.provider,
      amount_cents: order.amount_cents,
      amount: (order.amount_cents / 100).toFixed(2),
      sender_msisdn: order.sender_msisdn,
      trx_id: order.trx_id,
      created_at: order.created_at,
      matched_at: order.matched_at,
    },
    payment: {
      trx_id: event.trx_id,
      provider: event.provider,
      amount_cents: event.amount_cents,
      amount: (event.amount_cents / 100).toFixed(2),
      sender_msisdn: event.sender_msisdn,
      balance_cents: event.balance_cents,
      received_at: event.received_at,
      source: event.source,
    },
    sent_at: nowIso(),
  };
}

export function signBody(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

/** কোনো মার্চেন্টের webhook কনফিগার করা আছে কি না */
export function hasWebhook(merchantId) {
  const row = q.get('SELECT webhook_url FROM merchants WHERE id = ?', merchantId);
  return Boolean(row?.webhook_url);
}

export function runWebhook(merchantId, order, event) {
  let merchant;
  try {
    merchant = q.get('SELECT webhook_url, webhook_secret FROM merchants WHERE id = ?', merchantId);
  } catch (err) {
    console.error('[webhook] merchant lookup failed:', err?.message);
    return;
  }
  if (!merchant?.webhook_url) return;

  const payload = buildPayload(merchantId, order, event);
  const body = JSON.stringify(payload);
  const signature = signBody(merchant.webhook_secret, body);

  deliver(merchant.webhook_url, body, signature, order.id, 0);
}

async function deliver(url, body, signature, orderId, attempt) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'TakaMatch/1.0',
        'x-signature': signature,
        'x-event': 'payment.matched',
        'x-order-id': orderId,
      },
      body,
      signal: controller.signal,
      redirect: 'follow',
    });

    if (res.ok) {
      audit(null, 'system', 'webhook.delivered', { orderId, url: redact(url), attempt: attempt + 1 });
      return;
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => deliver(url, body, signature, orderId, attempt + 1), RETRY_DELAYS_MS[attempt]);
    } else {
      audit(null, 'system', 'webhook.failed', {
        orderId,
        url: redact(url),
        status: res.status,
        attempts: attempt + 1,
      });
    }
  } catch (err) {
    if (attempt < RETRY_DELAYS_MS.length) {
      setTimeout(() => deliver(url, body, signature, orderId, attempt + 1), RETRY_DELAYS_MS[attempt]);
    } else {
      audit(null, 'system', 'webhook.failed', {
        orderId,
        url: redact(url),
        error: String(err?.message || err),
        attempts: attempt + 1,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

function redact(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return 'invalid-url';
  }
}
