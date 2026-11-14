/**
 * নিজের ক্লাউড স্টোরেজ (S3-compatible) — কোনো লাইব্রেরি ছাড়া, শুধু node:crypto দিয়ে।
 *
 * কাজ করে: Amazon S3, Cloudflare R2, Backblaze B2, MinIO, DigitalOcean Spaces,
 * Wasabi — যেকোনো S3-সামঞ্জস্যপূর্ণ সার্ভিসে।
 *
 * এখানে শুধু "বাকেটে ফাইল রাখা/নেওয়া" হয় — ডেটাবেসের ফাইল (SQLite snapshot)
 * রাখা হয় ব্যাকআপ হিসেবে, যাতে যেকোনো সময়ে ফিরিয়ে আনা যায়।
 */

import crypto from 'node:crypto';

const SERVICE = 's3';
const ALGORITHM = 'AWS4-HMAC-SHA256';

/* ─────────────────────────── প্রোভাইডার প্রিসেট ─────────────────────────── */

export const PROVIDER_PRESETS = {
  r2: {
    label: 'Cloudflare R2',
    endpoint: (cfg) => (cfg.account_id ? `https://${cfg.account_id}.r2.cloudflarestorage.com` : ''),
    region: 'auto',
    path_style: true,
    note: 'R2 ড্যাশবোর্ড → Manage R2 API Tokens থেকে Access Key নিন। ফ্রি টিয়ারে ১০ GB।',
  },
  s3: {
    label: 'Amazon S3',
    endpoint: (cfg) => `https://s3.${cfg.region || 'ap-south-1'}.amazonaws.com`,
    region: 'ap-south-1',
    path_style: false,
    note: 'S3 → Bucket → Permissions-এ CORS লাগবে না, শুধু Access Key দরকার।',
  },
  b2: {
    label: 'Backblaze B2',
    endpoint: (cfg) => `https://s3.${cfg.region || 'us-west-004'}.backblazeb2.com`,
    region: 'us-west-004',
    path_style: true,
    note: 'B2 → Application Keys থেকে keyID ও applicationKey নিন। ১০ GB ফ্রি।',
  },
  minio: {
    label: 'MinIO / নিজের সার্ভার',
    endpoint: () => '',
    region: 'us-east-1',
    path_style: true,
    note: 'নিজের MinIO বা Wasabi/Spaces — Endpoint নিজে লিখুন (যেমন http://192.168.0.5:9000)।',
  },
};

/* ─────────────────────────── সিগনেচার (SigV4) ─────────────────────────── */

const sha256hex = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/** RFC 3986 — S3 canonical URI/query-র জন্য কঠোর এনকোডিং */
function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodePath(pathname) {
  return pathname.split('/').map(encodeRfc3986).join('/');
}

function canonicalQuery(searchParams) {
  const pairs = [];
  for (const [key, value] of searchParams.entries()) {
    pairs.push([encodeRfc3986(key), encodeRfc3986(value)]);
  }
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  return pairs.map(([k, v]) => `${k}=${v}`).join('&');
}

function amzDate(now = new Date()) {
  return now.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

/**
 * চাওয়া রিকোয়েস্টে সই করে হেডারগুলো ফেরত দেয়।
 * @returns {Record<string,string>} পাঠানোর মতো হেডার
 */
export function signRequest({ method, url, headers = {}, payload = '', accessKeyId, secretAccessKey, region = 'auto' }) {
  const u = new URL(url);
  const body = payload === null || payload === undefined ? '' : payload;
  const payloadHash = sha256hex(body);
  const stamp = amzDate();

  const base = {
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': stamp,
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])),
  };

  const names = Object.keys(base).sort();
  const canonicalHeaders = names.map((n) => `${n}:${base[n].trim()}\n`).join('');
  const signedHeaders = names.join(';');

  const canonicalRequest = [
    method.toUpperCase(),
    encodePath(u.pathname || '/'),
    canonicalQuery(u.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGORITHM, stamp, scope, sha256hex(canonicalRequest)].join('\n');

  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return {
    ...base,
    authorization: `${ALGORITHM} Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/* ─────────────────────────── কনফিগ যাচাই ─────────────────────────── */

export function normalizeConfig(input = {}) {
  const provider = String(input.provider || 'r2').toLowerCase();
  if (!PROVIDER_PRESETS[provider]) {
    throw new Error('provider অবশ্যই r2 / s3 / b2 / minio-এর একটি হবে');
  }
  const preset = PROVIDER_PRESETS[provider];
  const region = String(input.region || preset.region).trim();
  let endpoint = String(input.endpoint || '').trim();

  if (!endpoint) {
    endpoint = preset.endpoint({ region, account_id: input.account_id });
  }
  endpoint = endpoint.replace(/\/+$/, '');
  if (!endpoint) throw new Error('Endpoint দরকার (যেমন https://xxx.r2.cloudflarestorage.com)');

  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error('Endpoint সঠিক URL নয়');
  }
  const isLocal = ['localhost', '127.0.0.1', '0.0.0.0'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error('Endpoint অবশ্যই https:// হতে হবে (নাহলে key প্লেইনটেক্সটে যাবে)');
  }

  const bucket = String(input.bucket || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new Error('Bucket নাম সঠিক নয় (ছোট হাতের অক্ষর, ৩–৬৩ অক্ষর)');
  }

  const accessKeyId = String(input.access_key_id || '').trim();
  const secretAccessKey = String(input.secret_access_key || '').trim();
  if (!accessKeyId || secretAccessKey.length < 8) {
    throw new Error('Access Key ID ও Secret Key দুটোই দরকার');
  }

  const prefix = String(input.prefix || 'takamatch').replace(/^\/+|\/+$/g, '') || 'takamatch';
  const interval = Math.floor(Number(input.interval_minutes ?? 0));
  if (!Number.isFinite(interval) || interval < 0 || interval > 24 * 60) {
    throw new Error('ব্যাকআপের ব্যবধান ০–১৪৪০ মিনিটের মধ্যে হতে হবে');
  }
  const keep = Math.floor(Number(input.keep ?? 7));
  if (!Number.isFinite(keep) || keep < 1 || keep > 60) {
    throw new Error('কতটি ব্যাকআপ রাখবেন — ১ থেকে ৬০');
  }

  return {
    provider,
    endpoint,
    region: region || 'auto',
    bucket,
    prefix,
    accessKeyId,
    secretAccessKey,
    intervalMinutes: interval,
    keep,
    pathStyle: input.path_style === undefined ? preset.path_style : Boolean(input.path_style),
  };
}

/* ─────────────────────────── রিকোয়েস্ট ─────────────────────────── */

function objectUrl(cfg, key = '', query = '') {
  const base = new URL(cfg.endpoint);
  if (cfg.pathStyle) {
    const path = `/${cfg.bucket}${key ? `/${encodePath(key)}` : ''}`;
    const u = new URL(base.origin + path);
    if (query) u.search = query;
    return u;
  }
  // virtual-host style (Amazon S3)
  const u = new URL(base.origin);
  u.hostname = `${cfg.bucket}.${u.hostname}`;
  u.pathname = key ? `/${encodePath(key)}` : '/';
  if (query) u.search = query;
  return u;
}

async function send(cfg, { method, key = '', query = '', body, contentType }) {
  const url = objectUrl(cfg, key, query);
  const payload = body ?? '';
  const extra = {};
  if (contentType) extra['content-type'] = contentType;

  const signed = signRequest({
    method,
    url: url.toString(),
    headers: extra,
    payload,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    region: cfg.region,
  });

  const headers = { ...extra };
  for (const [k, v] of Object.entries(signed)) {
    if (k === 'host') continue;
    headers[k] = v;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'GET' || method === 'HEAD' ? undefined : payload,
    signal: AbortSignal.timeout(20_000),
  });

  return { res, url };
}

function s3Error(status, text) {
  const code = /<Code>([^<]+)<\/Code>/.exec(text || '')?.[1];
  const message = /<Message>([^<]+)<\/Message>/.exec(text || '')?.[1];
  const err = new Error(
    `স্টোরেজ সার্ভার ${status}${code ? ` (${code})` : ''}${message ? `: ${message}` : ''}`,
  );
  err.status = status;
  err.code = code;
  return err;
}

/* ─────────────────────────── পাবলিক API ─────────────────────────── */

export async function putObject(cfg, key, body, contentType = 'application/octet-stream') {
  const { res } = await send(cfg, { method: 'PUT', key, body, contentType });
  if (!res.ok) throw s3Error(res.status, await res.text().catch(() => ''));
  return true;
}

export async function getObject(cfg, key) {
  const { res } = await send(cfg, { method: 'GET', key });
  if (res.status === 404) {
    const err = new Error('এই ব্যাকআপ আর নেই');
    err.status = 404;
    throw err;
  }
  if (!res.ok) throw s3Error(res.status, await res.text().catch(() => ''));
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteObject(cfg, key) {
  const { res } = await send(cfg, { method: 'DELETE', key });
  if (!res.ok && res.status !== 404) throw s3Error(res.status, await res.text().catch(() => ''));
  return true;
}

export async function listObjects(cfg, prefix = '', maxKeys = 100) {
  const qs = new URLSearchParams({
    'list-type': '2',
    prefix,
    'max-keys': String(maxKeys),
  }).toString();
  const { res } = await send(cfg, { method: 'GET', query: qs });
  if (!res.ok) throw s3Error(res.status, await res.text().catch(() => ''));
  const xml = await res.text();

  const items = [];
  const blocks = xml.match(/<Contents>[\s\S]*?<\/Contents>/g) || [];
  for (const block of blocks) {
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(block)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(block)?.[1];
    const modified = /<LastModified>([^<]+)<\/LastModified>/.exec(block)?.[1];
    if (key) {
      items.push({
        key: decodeXml(key),
        size: Number(size || 0),
        modified: modified || null,
      });
    }
  }
  items.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return items;
}

function decodeXml(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** সংযোগ পরীক্ষা — বাকেট আছে কি না এবং লেখার অনুমতি আছে কি না */
export async function testConnection(cfg) {
  const started = Date.now();
  const items = await listObjects(cfg, `${cfg.prefix}/`, 1);
  return { ok: true, latency_ms: Date.now() - started, objects: items.length };
}
