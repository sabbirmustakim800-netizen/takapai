/**
 * এন্ড-টু-এন্ড স্মোক টেস্ট (চালু সার্ভারের বিরুদ্ধে)
 *   node scripts/smoke.mjs http://127.0.0.1:3001
 *
 * যা যাচাই করে: রেজিস্ট্রেশন → ডিভাইস কী → পেয়ারিং → অর্ডার →
 * এসএমএস ইনজেস্ট → ম্যাচ → ডুপ্লিকেট ব্লক → স্বাক্ষরিত webhook → স্ট্যাট।
 */

import http from 'node:http';
import crypto from 'node:crypto';

import { startMockS3 } from './mock-s3.mjs';

const BASE = process.argv[2] || 'http://127.0.0.1:3001';
const results = [];

function check(name, condition, detail = '') {
  results.push({ name, ok: Boolean(condition), detail });
  console.log(`${condition ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function call(path, { method = 'GET', body, token, device } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (device) {
    headers['x-device-id'] = device.device_id;
    headers['x-device-key'] = device.device_key;
  }
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, json };
}

/* ─────────── webhook রিসিভার ─────────── */

const received = [];
const hookServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    received.push({ raw, signature: req.headers['x-signature'] });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});

await new Promise((resolve) => hookServer.listen(0, '127.0.0.1', resolve));
const hookPort = hookServer.address().port;

try {
  /* ─────────── হেলথ ─────────── */
  const health = await call('/api/health');
  check('সার্ভার সাড়া দিচ্ছে', health.status === 200 && health.json?.ok);

  /* ─────────── অ্যাকাউন্ট ─────────── */
  const email = `smoke_${Date.now()}@example.com`;
  const reg = await call('/api/auth/register', {
    method: 'POST',
    body: { business_name: 'স্মোক টেস্ট স্টোর', email, password: 'supersecret123' },
  });
  check('রেজিস্ট্রেশন', reg.status === 201 && reg.json?.token);
  const token = reg.json.token;

  const badLogin = await call('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'wrong-password' },
  });
  check('ভুল পাসওয়ার্ড প্রত্যাখ্যাত', badLogin.status === 401);

  const noAuth = await call('/api/orders');
  check('টোকেন ছাড়া অর্ডার দেখা যায় না', noAuth.status === 401);

  /* ─────────── ডিভাইস ─────────── */
  const dev = await call('/api/devices', { method: 'POST', token, body: { label: 'স্মোক ফোন' } });
  check('ডিভাইস তৈরি ও কী ইস্যু', dev.status === 201 && dev.json?.credentials?.device_key);
  const device = dev.json.credentials;
  check('কী একবারই দেখানো হয়', !('key_hash' in (dev.json.device || {})));

  /* ─────────── পেয়ারিং ─────────── */
  const pairCode = await call('/api/pairing-codes', { method: 'POST', token, body: { label: 'অ্যাপ ফোন' } });
  check('পেয়ারিং কোড তৈরি', pairCode.status === 201 && /^[A-Z0-9]{8}$/.test(pairCode.json.code));

  const paired = await call('/api/devices/pair', {
    method: 'POST',
    body: { pairing_code: pairCode.json.code, platform: 'android', app_version: '1.0.0' },
  });
  check('পেয়ারিং সফল, ইউনিক কী পাওয়া গেছে', paired.status === 200 && paired.json?.credentials?.device_key);

  const reusePair = await call('/api/devices/pair', {
    method: 'POST',
    body: { pairing_code: pairCode.json.code },
  });
  check('একই পেয়ারিং কোড দ্বিতীয়বার কাজ করে না', reusePair.status === 409);

  const otherDevice = paired.json.credentials;
  check(
    'দুটি ডিভাইসের কী আলাদা',
    otherDevice.device_key !== device.device_key && otherDevice.device_id !== device.device_id,
  );

  /* ─────────── webhook সেট ─────────── */
  const hookUrl = `http://127.0.0.1:${hookPort}/hook`;
  const settings = await call('/api/settings', {
    method: 'PATCH',
    token,
    body: { webhook_url: hookUrl, order_ttl_seconds: 900 },
  });
  check('webhook ইউআরএল সংরক্ষিত', settings.status === 200 && settings.json.merchant.webhook_url === hookUrl);
  const webhookSecret = settings.json.merchant.webhook_secret;

  /* ─────────── অর্ডার + ম্যাচ ─────────── */
  const sender = '01712345678';
  const order = await call('/api/orders', {
    method: 'POST',
    token,
    body: { provider: 'bkash', amount: '500.00', sender, reference: 'SMOKE-1' },
  });
  check('অর্ডার তৈরি', order.status === 201 && order.json.order.status === 'pending');

  // TrxID পুরো সিস্টেমে চিরস্থায়ীভাবে ইউনিক — তাই প্রতিবার নতুনটি ব্যবহার করি
  const RUN = Date.now().toString(36).toUpperCase();
  const smsText =
    'You have received Tk 500.00 from 01712345678. Fee Tk 0.00. Balance Tk 1,200.00. ' +
    `TrxID SMK${RUN} at 12/11/2026 10:30. Download bKash app.`;

  const ingest = await call('/api/ingest', {
    method: 'POST',
    device,
    body: {
      events: [
        { client_event_id: 'smoke_evt_1', source: 'sms', sender: '16247', text: smsText, received_at: new Date().toISOString() },
      ],
    },
  });
  check('এসএমএস ইনজেস্ট → ম্যাচ', ingest.json?.results?.[0]?.status === 'matched', JSON.stringify(ingest.json?.results?.[0]));

  const orderAfter = await call(`/api/orders/${order.json.order.id}`, { token });
  check('অর্ডার matched হয়েছে', orderAfter.json?.order?.status === 'matched');

  /* ─────────── এক-বার নিয়ম ─────────── */
  const replay = await call('/api/ingest', {
    method: 'POST',
    device,
    body: {
      events: [
        { client_event_id: 'smoke_evt_2', source: 'sms', sender: '16247', text: smsText, received_at: new Date().toISOString() },
      ],
    },
  });
  check('একই TrxID পুনরায় পাঠালে ডুপ্লিকেট', replay.json?.results?.[0]?.status === 'duplicate');

  const order2 = await call('/api/orders', {
    method: 'POST',
    token,
    body: { provider: 'bkash', amount: '500.00', sender, reference: 'SMOKE-2' },
  });
  check('একই টাকা/নম্বরের নতুন অর্ডার তৈরি হয়েছে', order2.status === 201);

  const replay2 = await call('/api/ingest', {
    method: 'POST',
    device,
    body: {
      events: [
        { client_event_id: 'smoke_evt_3', source: 'sms', sender: '16247', text: smsText, received_at: new Date().toISOString() },
      ],
    },
  });
  check('পুনরায় পাঠালেও ডুপ্লিকেট', replay2.json?.results?.[0]?.status === 'duplicate');

  const order2After = await call(`/api/orders/${order2.json.order.id}`, { token });
  check('দ্বিতীয় অর্ডার এখনো পেন্ডিং', order2After.json?.order?.status === 'pending');

  /* ─────────── client_event_id রিট্রাই ─────────── */
  const retry = await call('/api/ingest', {
    method: 'POST',
    device,
    body: {
      events: [
        { client_event_id: 'smoke_evt_1', source: 'sms', sender: '16247', text: smsText, received_at: new Date().toISOString() },
      ],
    },
  });
  check(
    'একই client_event_id রিট্রাই নিরাপদ (idempotent)',
    retry.json?.results?.[0]?.status === 'matched',
  );

  /* ─────────── ভুল ডিভাইস কী ─────────── */
  const badKey = await call('/api/ingest', {
    method: 'POST',
    device: { device_id: device.device_id, device_key: 'dvk_wrong' },
    body: { events: [{ client_event_id: 'x1', source: 'sms', sender: '16247', text: smsText }] },
  });
  check('ভুল ডিভাইস কী প্রত্যাখ্যাত', badKey.status === 401);

  /* ─────────── webhook যাচাই ─────────── */
  await new Promise((r) => setTimeout(r, 700));
  check('webhook পৌঁছেছে', received.length >= 1, `${received.length}টি`);

  if (received.length) {
    const { raw, signature } = received[0];
    const expected = 'sha256=' + crypto.createHmac('sha256', webhookSecret).update(raw).digest('hex');
    check('webhook সিগনেচার সঠিক', expected === signature);
    const payload = JSON.parse(raw);
    check('webhook পেলোডে সঠিক অর্ডার', payload.event === 'payment.matched' && payload.order.amount === '500.00');
  }

  /* ─────────── স্ট্যাট ─────────── */
  const stats = await call('/api/stats', { token });
  check('স্ট্যাট: একটি ম্যাচ', stats.json?.stats?.matched === 1, JSON.stringify(stats.json?.stats));
  check('স্ট্যাট: একটি পেন্ডিং', stats.json?.stats?.pending === 1);

  /* ─────────── সিমুলেটর ─────────── */
  const sim = await call('/api/simulate', {
    method: 'POST',
    token,
    body: {
      sender: '16167',
      text: 'You have received Tk 120.00 from 01899887766. Balance Tk 900.00. TrxID NAGAD1234',
      dry_run: true,
    },
  });
  check(
    'সিমুলেটর ড্রাই-রান নগদ মেসেজ পড়ে',
    sim.json?.parsed?.provider === 'nagad' && sim.json?.parsed?.amountCents === 12000,
  );

  /* ─────────── বাংলা/ইংরেজি মিশ্র পরিমাণ ─────────── */
  const mixedOrder = await call('/api/orders', {
    method: 'POST',
    token,
    body: {
      provider: 'bkash',
      amount: '১০০ টাকা',
      sender: '০১৭৯৮৭৬৫৪৩২',
      reference: 'MIXED-1',
    },
  });
  check(
    'বাংলায় লেখা পরিমাণ ও নম্বর গ্রহণ ("১০০ টাকা")',
    mixedOrder.status === 201 && mixedOrder.json.order.amount === '100.00',
    JSON.stringify(mixedOrder.json?.order?.amount ?? mixedOrder.json),
  );

  const mixedIngest = await call('/api/ingest', {
    method: 'POST',
    device: otherDevice,
    body: {
      events: [
        {
          client_event_id: 'mix_evt_1',
          source: 'sms',
          sender: '16247',
          text: `You have received 100tk from 01798765432. TrxID MIX${RUN} at 12/11/2026`,
          received_at: new Date().toISOString(),
        },
      ],
    },
  });
  check(
    '"১০০ টাকা" অর্ডার "100tk" এসএমএসের সাথে মিলেছে',
    mixedIngest.json?.results?.[0]?.status === 'matched',
    JSON.stringify(mixedIngest.json?.results?.[0]),
  );

  /* ─────────── ডিভাইস বাতিল ─────────── */
  const rev = await call(`/api/devices/${dev.json.device.id}/revoke`, { method: 'POST', token });
  check('ডিভাইস বাতিল', rev.status === 200);

  const afterRevoke = await call('/api/ingest', {
    method: 'POST',
    device,
    body: { events: [{ client_event_id: 'x2', source: 'sms', sender: '16247', text: smsText }] },
  });
  check('বাতিল ডিভাইস আর পাঠাতে পারে না', afterRevoke.status === 403);

  /* ─────────── নিজের ক্লাউড স্টোরেজ ধরে ব্যাকআপ + রিস্টোর ─────────── */
  const mockS3 = startMockS3();
  const s3Endpoint = await mockS3.listen();

  const savedStorage = await call('/api/storage', {
    method: 'POST',
    token,
    body: {
      provider: 'minio',
      endpoint: s3Endpoint,
      region: 'us-east-1',
      bucket: 'test-bucket',
      prefix: 'takamatch',
      access_key_id: 'test-access-key',
      secret_access_key: 'test-secret-key-123456',
      interval_minutes: 0,
      keep: 3,
    },
  });
  check(
    'নিজের ক্লাউড স্টোরেজ সংরক্ষণ',
    savedStorage.status === 200 && savedStorage.json?.storage?.configured === true,
    JSON.stringify(savedStorage.json?.storage || savedStorage.json),
  );
  check(
    'সিক্রেট কী উত্তরে কখনো ফেরত যায় না',
    !JSON.stringify(savedStorage.json).includes('test-secret-key-123456'),
  );

  const tested = await call('/api/storage/test', { method: 'POST', token, body: {} });
  check('স্টোরেজ সংযোগ পরীক্ষা', tested.status === 200 && tested.json?.ok === true, JSON.stringify(tested.json));

  const bkp = await call('/api/storage/backup', { method: 'POST', token });
  check('ব্যাকআপ আপলোড', bkp.status === 200 && bkp.json?.ok === true, JSON.stringify(bkp.json));

  const bkpList = await call('/api/storage/backups', { token });
  check(
    'ব্যাকআপ তালিকায় ক্লাউডে আছে',
    bkpList.status === 200 && bkpList.json?.backups?.some((b) => b.in_cloud),
  );

  const restored = await call('/api/storage/restore', {
    method: 'POST',
    token,
    body: { key: bkp.json?.key },
  });
  check('ব্যাকআপ ফিরিয়ে আনা', restored.status === 200 && restored.json?.ok === true, JSON.stringify(restored.json));

  const afterRestore = await call('/api/me', { token });
  check('রিস্টোরের পরও লগইন ও ডাটা ঠিক', afterRestore.status === 200);

  await call('/api/storage', { method: 'DELETE', token });
  await mockS3.close();
  check('নকল S3-তে কোনো সই/বডি ভুল নেই', mockS3.problems.length === 0, mockS3.problems.join(' | '));
} finally {
  hookServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} পাস`);
process.exit(failed.length ? 1 : 0);
