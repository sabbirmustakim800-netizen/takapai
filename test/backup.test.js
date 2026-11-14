import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { startMockS3 } from '../scripts/mock-s3.mjs';
import { signRequest, normalizeConfig } from '../server/storage.js';

const dir = mkdtempSync(join(tmpdir(), 'takamatch-backup-test-'));
process.env.DATABASE_FILE = join(dir, 'app.db');
process.env.BACKUP_KEY_FILE = join(dir, '.backup-key');
process.env.BACKUP_ENCRYPTION_KEY = '';

const { q } = await import('../server/db.js');
const backup = await import('../server/backup.js');

const MERCHANT = 'm_test_backup';
const OTHER = 'm_other_backup';

function seedMerchant(id) {
  q.run(
    `INSERT INTO merchants (id, business_name, email, password_hash, webhook_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    'Backup Test Store',
    `${id}@example.com`,
    'x',
    'whsec_test',
    new Date().toISOString(),
  );
}

seedMerchant(MERCHANT);
seedMerchant(OTHER);

const mock = startMockS3();
const endpoint = await mock.listen();

function configInput(extra = {}) {
  return {
    provider: 'minio',
    endpoint,
    region: 'us-east-1',
    bucket: 'test-bucket',
    prefix: 'takamatch',
    access_key_id: 'test-access-key',
    secret_access_key: 'test-secret-key-123456',
    interval_minutes: 0,
    keep: 7,
    ...extra,
  };
}

test('SigV4 সিগনেচার নির্ধারিত ও সঠিক আকৃতির', () => {
  const headers = signRequest({
    method: 'PUT',
    url: 'http://127.0.0.1:9000/bucket/a.db',
    headers: { 'content-type': 'application/octet-stream' },
    payload: 'hello',
    accessKeyId: 'AK',
    secretAccessKey: 'SK',
    region: 'auto',
  });
  assert.match(
    headers.authorization,
    /^AWS4-HMAC-SHA256 Credential=AK\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
  );
  assert.equal(headers['x-amz-content-sha256'], '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
});

test('কনফিগ যাচাই — http শুধু লোকালhost-এ, bucket নাম কঠোর', () => {
  assert.throws(() => normalizeConfig(configInput({ endpoint: 'http://example.com' })), /https/);
  assert.throws(() => normalizeConfig(configInput({ bucket: 'Bad_Bucket' })), /Bucket/);
  assert.throws(() => normalizeConfig(configInput({ secret_access_key: '' })), /Access Key/);
  const ok = normalizeConfig(configInput());
  assert.equal(ok.pathStyle, true);
  assert.equal(ok.secretAccessKey, 'test-secret-key-123456');
});

test('কনফিগ সংরক্ষণে সিক্রেট এনক্রিপ্টেড থাকে, উত্তরে ফাঁস হয় না', async () => {
  const view = await backup.saveConfig(MERCHANT, configInput());
  assert.equal(view.configured, true);
  assert.equal(view.bucket, 'test-bucket');
  assert.ok(!JSON.stringify(view).includes('test-secret-key-123456'));

  const row = backup.getConfigRow(MERCHANT);
  assert.ok(!row.secret_cipher.includes('test-secret-key-123456'));
});

test('সংযোগ পরীক্ষা সফল হয়', async () => {
  const cfg = backup.buildConfig(MERCHANT, {});
  const res = await backup.testConnection(cfg);
  assert.equal(res.ok, true);
});

test('ব্যাকআপ আপলোড হয় এবং ফাইলটি এনক্রিপ্টেড', async () => {
  q.run(
    `INSERT INTO orders (id, merchant_id, provider, amount_cents, sender_msisdn, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    'o_test_1',
    MERCHANT,
    'bkash',
    50000,
    '01712345678',
    new Date().toISOString(),
    new Date(Date.now() + 600000).toISOString(),
  );

  const res = await backup.runBackup(MERCHANT, { reason: 'test' });
  assert.equal(res.ok, true);
  assert.ok(res.key.includes(`/backups/${MERCHANT}/`));

  const stored = mock.objects.get(res.key);
  assert.ok(stored, 'অবজেক্ট বাকেটে নেই');
  assert.equal(stored.subarray(0, 5).toString('utf8'), 'TMBK1', 'এনক্রিপশন হেডার নেই');
  assert.ok(!stored.includes(Buffer.from('SQLite format 3')), 'প্লেইন SQLite ফাইল লিক করেছে');
  assert.deepEqual(mock.problems, [], `মক S3 সমস্যা: ${mock.problems.join(' | ')}`);
});

test('ব্যাকআপ তালিকা দেখা যায়', async () => {
  const list = await backup.listBackups(MERCHANT);
  assert.equal(list.configured, true);
  assert.ok(list.backups.length >= 1);
  assert.equal(list.backups[0].in_cloud, true);
});

test('অন্য merchant-এর ব্যাকআপ ফিরিয়ে আনা যায় না', async () => {
  await backup.saveConfig(OTHER, configInput());
  const list = await backup.listBackups(MERCHANT);
  const key = list.backups[0].key;
  await assert.rejects(() => backup.restoreBackup(OTHER, key), /আপনার নয়/);

  // নিজের পাথ দিলেও অন্য merchant-এর ফোল্ডার ছুঁানো যাবে না
  const forged = `takamatch/backups/${MERCHANT}/${key.split('/').pop()}`;
  await assert.rejects(() => backup.restoreBackup(OTHER, forged), /আপনার নয়/);
  await backup.removeConfig(OTHER);
});

test('রিস্টোরে ডাটা ফিরে আসে এবং ডাটাবেস আবার কাজ করে', async () => {
  const list = await backup.listBackups(MERCHANT);
  const key = list.backups[0].key;

  q.run(
    `INSERT INTO orders (id, merchant_id, provider, amount_cents, sender_msisdn, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    'o_after_backup',
    MERCHANT,
    'nagad',
    10000,
    '01799999999',
    new Date().toISOString(),
    new Date(Date.now() + 600000).toISOString(),
  );

  const res = await backup.restoreBackup(MERCHANT, key);
  assert.equal(res.ok, true);

  const gone = q.get('SELECT id FROM orders WHERE id = ?', 'o_after_backup');
  assert.equal(gone, undefined, 'ব্যাকআপের পরের অর্ডার থাকা উচিত নয়');

  const kept = q.get('SELECT id FROM orders WHERE id = ?', 'o_test_1');
  assert.ok(kept, 'ব্যাকআপের আগের অর্ডার ফিরে আসেনি');

  const merchantRow = q.get('SELECT id FROM merchants WHERE id = ?', MERCHANT);
  assert.ok(merchantRow, 'রিস্টোরের পর merchants টেবিল পড়া যাচ্ছে না');
});

test('পুরনো ব্যাকআপ মুছে গিয়ে শুধু keep সংখ্যক থাকে', async () => {
  await backup.saveConfig(MERCHANT, configInput({ keep: 2 }));
  await backup.runBackup(MERCHANT, { reason: 'test' });
  await backup.runBackup(MERCHANT, { reason: 'test' });
  await backup.runBackup(MERCHANT, { reason: 'test' });

  const inBucket = [...mock.objects.keys()].filter((k) => k.includes(`/backups/${MERCHANT}/`));
  assert.ok(inBucket.length <= 2, `keep=2 হওয়া সত্ত্বেও ${inBucket.length} টি ব্যাকআপ আছে`);
});

test('ব্যাকআপ ছাড়া স্টোরেজ কনফিগ সরানো যায়', async () => {
  await new Promise((r) => setTimeout(r, 50));
  const res = await backup.removeConfig(MERCHANT);
  assert.equal(res.configured, false);
  assert.equal(backup.getConfigRow(MERCHANT), null);
});

test.after(async () => {
  await mock.close();
});
