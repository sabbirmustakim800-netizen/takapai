import crypto from 'node:crypto';
import { q, audit } from './db.js';
import { HttpError, newId, newToken, nowIso, PROVIDERS, PROVIDER_LABELS, formatCents } from './util.js';
import { hashPassword, verifyPassword, createSession } from './auth.js';
import { parseMfsMessage } from './parser.js';
import { validateEventPayload, processEvent } from './ingest.js';
import { findEventForOrder, claim, AlreadyConsumedError } from './matcher.js';
import { runWebhook } from './webhook.js';

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])?$/;

export function normalizeSlug(input) {
  const slug = String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return SLUG_RE.test(slug) ? slug : null;
}

export function normalizeUsername(input) {
  const u = String(input || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9_.-]{1,30}[a-z0-9])?$/.test(u)) return null;
  return u;
}

/**
 * পাবলিক সাইট ও API আলাদা ডোমেইনে থাকতে পারে (Render static site + web service)।
 * ব্রাউজার থেকে আসা অনুরোধে Origin হেডার থাকলে ব্যবহারকারীর দেখা সাইট-ঠিকানাই লিংকে বসাই,
 * নাহলে সার্ভারের নিজের ঠিকানা।
 */
function publicBase(req) {
  const origin = req.get('origin');
  if (origin && /^https?:\/\/[^/]+$/i.test(origin)) return origin.replace(/\/+$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

/** API সবসময় এই সার্ভারের নিজের ঠিকানাতেই থাকে (static site API সার্ভ করতে পারে না)। */
function apiHostBase(req) {
  return `${req.protocol}://${req.get('host')}`;
}

function ensureApiSecret(merchant) {
  if (merchant.api_secret) return merchant.api_secret;
  const secret = `tkp_${newToken(24)}`;
  q.run('UPDATE merchants SET api_secret = ? WHERE id = ?', secret, merchant.id);
  return secret;
}

export function projectView(merchant, req) {
  const host = publicBase(req);
  const slug = merchant.project_slug;
  const apiSecret = merchant.api_secret;
  const apiBase = apiSecret ? `${apiHostBase(req)}/api/${apiSecret}` : null;
  return {
    project_name: slug,
    username: merchant.username,
    business_name: merchant.business_name,
    server_address: slug ? `${host}/dashboard/server/${encodeURIComponent(slug)}` : null,
    api_base: apiBase,
    api_url: apiBase,
    pairing_hint: 'ড্যাশবোর্ড থেকে পেয়ারিং কোড তৈরি করে অ্যাপে দিন — অ্যাপটি আপনার ডিভাইসের মেসেজ এই সার্ভারে পাঠাবে।',
  };
}

export function registerProject(req, res) {
  const projectName = String(req.body?.project_name ?? req.body?.projectName ?? '').trim();
  const usernameRaw = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');
  const businessName = String(req.body?.business_name ?? projectName ?? usernameRaw ?? '').trim();

  const slug = normalizeSlug(projectName);
  if (!slug) throw new HttpError(400, 'bad_request', 'প্রোজেক্ট নাম দিন (a-z, 0-9, ড্যাশ; ৩+ অক্ষর)');
  const username = normalizeUsername(usernameRaw);
  if (!username) throw new HttpError(400, 'bad_request', 'সঠিক ইউজারনেম দিন (a-z, 0-9, . _ -)');
  if (password.length < 6 || password.length > 200) {
    throw new HttpError(400, 'bad_request', 'পাসওয়ার্ড কমপক্ষে ৬ অক্ষরের হতে হবে');
  }
  if (q.get('SELECT id FROM merchants WHERE project_slug = ?', slug)) {
    throw new HttpError(409, 'project_taken', 'এই প্রোজেক্ট নামটি নেওয়া হয়ে গেছে');
  }
  if (q.get('SELECT id FROM merchants WHERE username = ?', username)) {
    throw new HttpError(409, 'username_taken', 'এই ইউজারনেমটি নেওয়া হয়ে গেছে');
  }

  const id = newId('mch');
  const email = `${username}+${slug}@projects.takapai.local`;
  const apiSecret = `tkp_${newToken(24)}`;
  q.run(
    `INSERT INTO merchants
      (id, business_name, email, password_hash, webhook_secret, order_ttl_seconds,
       match_window_before_seconds, project_slug, username, api_secret, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    businessName.slice(0, 80) || slug,
    email,
    hashPassword(password),
    `whsec_${newToken(24)}`,
    1800,
    300,
    slug,
    username,
    apiSecret,
    nowIso(),
  );

  audit(id, 'merchant', 'project.registered', { slug, username });
  const session = createSession(id);
  const merchant = q.get('SELECT * FROM merchants WHERE id = ?', id);
  res.status(201).json({ token: session.token, expires_at: session.expiresAt, project: projectView(merchant, req) });
}

export function loginProject(req, res) {
  const projectName = String(req.body?.project_name ?? req.body?.projectName ?? '').trim();
  const usernameRaw = String(req.body?.username ?? '').trim();
  const password = String(req.body?.password ?? '');

  const slug = normalizeSlug(projectName);
  const username = normalizeUsername(usernameRaw);
  if (!slug || !username) throw new HttpError(400, 'bad_request', 'প্রোজেক্ট নাম ও ইউজারনেম দিন');

  const merchant = q.get(
    'SELECT * FROM merchants WHERE project_slug = ? AND username = ?',
    slug,
    username,
  );
  const ok = merchant ? verifyPassword(password, merchant.password_hash) : verifyPassword(password, 'scrypt$00$00');
  if (!merchant || !ok) throw new HttpError(401, 'invalid_credentials', 'প্রোজেক্ট নাম, ইউজারনেম বা পাসওয়ার্ড ভুল');

  ensureApiSecret(merchant);
  const fresh = q.get('SELECT * FROM merchants WHERE id = ?', merchant.id);
  const session = createSession(fresh.id);
  audit(fresh.id, 'merchant', 'project.login', {});
  res.json({ token: session.token, expires_at: session.expiresAt, project: projectView(fresh, req) });
}

export function requireProjectOwner(req, res, next) {
  // req.merchant set by requireMerchant; ensure matches :project
  const slug = String(req.params.project || '').toLowerCase();
  if (!req.merchant) return next(new HttpError(401, 'unauthorized', 'লগইন প্রয়োজন'));
  if (req.merchant.project_slug !== slug) {
    return next(new HttpError(403, 'forbidden', 'এই প্রোজেক্টে আপনার অনুমতি নেই'));
  }
  next();
}

export function projectDashboardData(req, res) {
  const m = q.get('SELECT * FROM merchants WHERE id = ?', req.merchant.id);
  ensureApiSecret(m);
  const fresh = q.get('SELECT * FROM merchants WHERE id = ?', m.id);
  const host = publicBase(req);
  const slug = fresh.project_slug;

  const events = q.all(
    'SELECT * FROM sms_events WHERE merchant_id = ? ORDER BY ingested_at DESC LIMIT 50',
    fresh.id,
  ).map((row) => ({
    id: row.id,
    provider: row.provider,
    provider_label: PROVIDER_LABELS[row.provider] || row.provider,
    status: row.status,
    amount: row.amount_cents != null ? formatCents(row.amount_cents) : null,
    trx_id: row.trx_id,
    sender_msisdn: row.sender_msisdn,
    reason: row.reason,
    ingested_at: row.ingested_at,
    raw_text: row.raw_text,
  }));

  const devices = q.all(
    `SELECT id,label,status,platform,last_seen_at,created_at FROM devices
      WHERE merchant_id = ? AND platform <> 'simulator' ORDER BY created_at DESC`,
    fresh.id,
  );

  // active pairing code if any (latest unused unexpired)
  const pairing = q.get(
    `SELECT code, label, expires_at, created_at FROM pairing_codes
      WHERE merchant_id = ? AND used_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
    fresh.id,
    nowIso(),
  );

  res.json({
    project: {
      project_name: slug,
      username: fresh.username,
      business_name: fresh.business_name,
      server_address: `${host}/dashboard/server/${encodeURIComponent(slug)}`,
      pairing_key: pairing ? pairing.code : null,
      pairing_expires_at: pairing ? pairing.expires_at : null,
      api_key: fresh.api_secret,
      api_url: `${apiHostBase(req)}/api/${fresh.api_secret}`,
      api_example: `${apiHostBase(req)}/api/${fresh.api_secret}/orders`,
    },
    devices,
    events,
  });
}

function merchantByApiSecret(req, res, next) {
  const secret = String(req.params.secret || '').trim();
  if (!secret) return next(new HttpError(401, 'unauthorized', 'API key নেই'));
  const merchant = q.get('SELECT * FROM merchants WHERE api_secret = ?', secret);
  if (!merchant) return next(new HttpError(401, 'unauthorized', 'API key সঠিক নয়'));
  req.merchant = merchant;
  req.rateLimitKey = `k:${merchant.id}`;
  next();
}

function orderViewRow(row) {
  return {
    id: row.id,
    provider: row.provider,
    amount: formatCents(row.amount_cents),
    amount_cents: row.amount_cents,
    sender_msisdn: row.sender_msisdn,
    trx_id: row.trx_id,
    reference: row.reference,
    status: row.status,
    created_at: row.created_at,
    expires_at: row.expires_at,
    matched_at: row.matched_at,
  };
}

export function mountProjectApi(app, apiLimiter) {
  const infoHandler = (req, res) => {
    const host = apiHostBase(req);
    res.json({ ok: true, project: req.merchant.project_slug, api_base: `${host}/api/${req.params.secret}`, endpoints: { orders: `${host}/api/${req.params.secret}/orders`, events: `${host}/api/${req.params.secret}/events` } });
  };

  const createOrderHandler = (req, res) => {
    const merchant = req.merchant;
    const provider = String(req.body?.provider || '').toLowerCase();
    if (!PROVIDERS.includes(provider)) throw new HttpError(400, 'bad_request', 'প্রোভাইডার bkash / rocket / nagad');
    const amountRaw = req.body?.amount;
    const { toCents, normalizeMsisdn, normalizeTrxId } = requireUtil();
    const amountCents = toCents(amountRaw);
    const sender = normalizeMsisdn(req.body?.sender);
    const rawTrx = req.body?.trx_id ? String(req.body.trx_id) : '';
    const trxId = rawTrx ? normalizeTrxId(rawTrx) : null;
    const reference = req.body?.reference ? String(req.body.reference).slice(0, 64) : null;
    if (amountCents === null || amountCents <= 0) throw new HttpError(400, 'bad_request', 'সঠিক টাকার পরিমাণ দিন');
    if (!sender) throw new HttpError(400, 'bad_request', 'সঠিক মোবাইল নম্বর দিন');
    if (rawTrx && !trxId) throw new HttpError(400, 'bad_request', 'TrxID সঠিক নয়');
    if (trxId) {
      const clash = q.get('SELECT id,status FROM orders WHERE merchant_id=? AND provider=? AND trx_id=?', merchant.id, provider, trxId);
      if (clash) throw new HttpError(409, 'duplicate_order', 'এই TrxID দিয়ে আগেই অর্ডার আছে');
    }
    let ttl = Number(req.body?.expires_in_seconds) || merchant.order_ttl_seconds || 1800;
    ttl = Math.min(Math.max(Math.floor(ttl), 60), 86400);
    const id = newId('ord');
    const createdAt = nowIso();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    try {
      q.run(
        `INSERT INTO orders (id,merchant_id,provider,amount_cents,sender_msisdn,trx_id,reference,status,created_at,expires_at,note)
         VALUES (?,?,?,?,?,?,?, 'pending',?,?,?)`,
        id, merchant.id, provider, amountCents, sender, trxId, reference, createdAt, expiresAt,
        req.body?.note ? String(req.body.note).slice(0, 200) : null,
      );
    } catch (err) {
      if (/UNIQUE/i.test(String(err?.message))) throw new HttpError(409, 'duplicate_order', 'এই TrxID দিয়ে আগেই অর্ডার আছে');
      throw err;
    }
    const candidate = findEventForOrder(q.get('SELECT * FROM orders WHERE id=?', id), merchant.match_window_before_seconds ?? 300);
    if (candidate) {
      try { claim(candidate.id, id); runWebhook(merchant.id, q.get('SELECT * FROM orders WHERE id=?', id), q.get('SELECT * FROM sms_events WHERE id=?', candidate.id)); } catch (e) { if (!(e instanceof AlreadyConsumedError)) throw e; }
    }
    const row = q.get('SELECT * FROM orders WHERE id=?', id);
    res.status(201).json({ ok: true, order: orderViewRow(row) });
  };

  const getOrderHandler = (req, res) => {
    const row = q.get('SELECT * FROM orders WHERE id=? AND merchant_id=?', req.params.id, req.merchant.id);
    if (!row) throw new HttpError(404, 'not_found', 'অর্ডার পাওয়া যায়নি');
    res.json({ ok: true, order: orderViewRow(row) });
  };

  const eventsHandler = (req, res) => {
    const rows = q.all('SELECT id,provider,status,amount_cents,trx_id,sender_msisdn,reason,ingested_at FROM sms_events WHERE merchant_id=? ORDER BY ingested_at DESC LIMIT 50', req.merchant.id);
    res.json({ ok: true, events: rows.map(r => ({...r, amount: r.amount_cents!=null?formatCents(r.amount_cents):null, provider_label: PROVIDER_LABELS[r.provider]||r.provider})) });
  };

  const onlyTkp = (req, res, next) => {
    if (!String(req.params.secret || '').startsWith('tkp_')) return next('route');
    next();
  };

  // canonical
  app.get('/api/k/:secret', apiLimiter, merchantByApiSecret, infoHandler);
  app.post('/api/k/:secret/orders', apiLimiter, merchantByApiSecret, createOrderHandler);
  app.get('/api/k/:secret/orders/:id', apiLimiter, merchantByApiSecret, getOrderHandler);
  app.get('/api/k/:secret/events', apiLimiter, merchantByApiSecret, eventsHandler);

  // direct form requested by user: /api/<tkp_...> (registered after specific /api routes, guarded)
  app.get('/api/:secret', apiLimiter, onlyTkp, merchantByApiSecret, infoHandler);
  app.post('/api/:secret/orders', apiLimiter, onlyTkp, merchantByApiSecret, createOrderHandler);
  app.get('/api/:secret/orders/:id', apiLimiter, onlyTkp, merchantByApiSecret, getOrderHandler);
  app.get('/api/:secret/events', apiLimiter, onlyTkp, merchantByApiSecret, eventsHandler);
}

function requireUtil() {
  // lazy to avoid circular in this quick module; util is pure
  return require_util_cache;
}
import * as require_util_cache from './util.js';

export function mountProjectRoutes(app, deps) {
  const { requireMerchant, apiLimiter, registerLimiter, loginLimiter, SITE_DIR, PUBLIC_DIR } = deps;

  app.post('/api/server/register', registerLimiter, (req, res) => registerProject(req, res));
  app.post('/api/server/login', loginLimiter, (req, res) => loginProject(req, res));

  app.get('/api/server/me', requireMerchant, apiLimiter, (req, res) => {
    const m = q.get('SELECT * FROM merchants WHERE id=?', req.merchant.id);
    if (m?.api_secret == null && m?.project_slug) ensureApiSecret(m);
    const fresh = q.get('SELECT * FROM merchants WHERE id=?', req.merchant.id);
    res.json({ project: projectView(fresh, req) });
  });

  app.get('/api/server/:project/dashboard', requireMerchant, apiLimiter, (req, res, next) => {
    if (req.merchant.project_slug !== String(req.params.project||'').toLowerCase()) return next(new HttpError(403,'forbidden','অনুমতি নেই'));
    projectDashboardData(req, res);
  });

  app.post('/api/server/:project/pairing-key', requireMerchant, apiLimiter, (req, res, next) => {
    const slug = String(req.params.project||'').toLowerCase();
    if (req.merchant.project_slug !== slug) return next(new HttpError(403,'forbidden','অনুমতি নেই'));
    const codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = crypto.randomBytes(8);
    let code = '';
    for (let i=0;i<8;i++) code += codeAlphabet[bytes[i] % codeAlphabet.length];
    const expiresAt = new Date(Date.now() + 24*60*60_000).toISOString();
    q.run('INSERT INTO pairing_codes (code, merchant_id, label, created_at, expires_at) VALUES (?,?,?,?,?)',
      code, req.merchant.id, 'Setup pairing key', nowIso(), expiresAt);
    res.status(201).json({ pairing_key: code, expires_at: expiresAt });
  });

  mountProjectApi(app, apiLimiter);

  // Serve project dashboard SPA page
  app.get('/dashboard/server/:project', (req, res) => {
    res.sendFile('project-dashboard.html', { root: SITE_DIR });
  });
}
