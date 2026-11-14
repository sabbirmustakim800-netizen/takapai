/* TakaMatch — ড্যাশবোর্ড ক্লায়েন্ট */

const TOKEN_KEY = 'takamatch_token';
let token = localStorage.getItem(TOKEN_KEY) || null;
let merchant = null;
let currentView = 'dashboard';
let refreshTimer = null;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ─────────────── সহায়ক ─────────────── */

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('bn-BD', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

function relTime(iso) {
  if (!iso) return '—';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'এইমাত্র';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} মিনিট আগে`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} ঘণ্টা আগে`;
  return `${Math.floor(diff / 86_400_000)} দিন আগে`;
}

function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  el.hidden = false;
  clearTimeout(el._t);
  el._t = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => { el.hidden = true; }, 220);
  }, 3600);
}

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (auth && token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  let data = null;
  try { data = await res.json(); } catch { data = null; }

  if (res.status === 401 && auth) {
    logout(true);
    throw new Error('সেশন শেষ — আবার লগইন করুন');
  }
  if (!res.ok) {
    throw new Error(data?.error?.message || `অনুরোধ ব্যর্থ (${res.status})`);
  }
  return data;
}

/* ─────────────── অথেন্টিকেশন ─────────────── */

function setSession(newToken) {
  token = newToken;
  localStorage.setItem(TOKEN_KEY, newToken);
}

function logout(silent = false) {
  if (token && !silent) api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  token = null;
  merchant = null;
  localStorage.removeItem(TOKEN_KEY);
  stopAutoRefresh();
  $('#app').hidden = true;
  $('#auth-screen').hidden = false;
}

async function bootSession() {
  if (!token) return;
  try {
    const data = await api('/api/me');
    merchant = data.merchant;
    enterApp();
  } catch {
    logout(true);
  }
}

function enterApp() {
  $('#auth-screen').hidden = true;
  $('#app').hidden = false;
  $('#biz-name').textContent = merchant?.business_name || '';
  showView('dashboard');
  startAutoRefresh();
}

/* ─────────────── ভিউ ─────────────── */

const loaders = {
  dashboard: loadDashboard,
  orders: loadOrders,
  devices: loadDevices,
  feed: loadFeed,
  settings: loadSettings,
  backup: loadBackup,
};

function showView(name) {
  currentView = name;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => { v.hidden = v.id !== `view-${name}`; });
  if (loaders[name]) loaders[name]().catch((e) => toast(e.message, 'err'));
}

function startAutoRefresh() {
  stopAutoRefresh();
  refreshTimer = setInterval(() => {
    if (['dashboard', 'orders', 'feed', 'devices'].includes(currentView)) {
      loaders[currentView]().catch(() => {});
    }
  }, 7000);
}

function stopAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

/* ─────────────── ড্যাশবোর্ড ─────────────── */

async function loadDashboard() {
  const data = await api('/api/stats');
  const s = data.stats;

  $('#stat-pending').textContent = s.pending;
  $('#stat-today-count').textContent = s.today_matched_count;
  $('#stat-today-amount').textContent = `৳${s.today_matched_amount}`;
  $('#stat-devices').textContent = s.active_devices;
  $('#stat-total').textContent = `মোট ${s.total_orders} অর্ডার · ${s.matched} ম্যাচড`;

  const box = $('#recent-matches');
  if (!data.recent_matches.length) {
    box.innerHTML = '<p class="empty">এখনো কোনো সফল ম্যাচ নেই। অর্ডার সাবমিট করুন বা সিমুলেটর দিয়ে পরীক্ষা করুন।</p>';
    return;
  }
  box.innerHTML = data.recent_matches.map((o) => `
    <div class="match-item">
      <span class="provider-dot"><i class="p-${esc(o.provider)}"></i>${esc(o.provider_label)}</span>
      <span class="amount">৳${esc(o.amount)}</span>
      <span class="grow meta">
        ${esc(o.reference || 'রেফারেন্স নেই')} · ${esc(o.sender_msisdn)}
        ${o.matched_event ? ` · TrxID ${esc(o.matched_event.trx_id)}` : ''}
      </span>
      <span class="meta">${esc(relTime(o.matched_at))}</span>
    </div>
  `).join('');
}

/* ─────────────── অর্ডার ─────────────── */

async function loadOrders() {
  const filter = $('#order-filter').value;
  const data = await api(`/api/orders?limit=60${filter ? `&status=${filter}` : ''}`);
  const body = $('#orders-body');

  if (!data.orders.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">কোনো অর্ডার নেই</td></tr>';
    return;
  }

  body.innerHTML = data.orders.map((o) => `
    <tr>
      <td class="muted mono">${esc(fmtDate(o.created_at))}</td>
      <td><span class="provider-dot"><i class="p-${esc(o.provider)}"></i>${esc(o.provider_label)}</span></td>
      <td class="mono">৳${esc(o.amount)}</td>
      <td class="mono">${esc(o.sender_msisdn)}</td>
      <td class="mono">${esc(o.trx_id || '—')}</td>
      <td><span class="pill ${esc(o.status)}">${statusBn(o.status)}</span></td>
    </tr>
  `).join('');
}

function statusBn(status) {
  return ({
    pending: 'পেন্ডিং', matched: 'ম্যাচড', expired: 'মেয়াদোত্তীর্ণ', cancelled: 'বাতিল',
    unmatched: 'অমিল', ignored: 'বাদ', duplicate: 'ডুপ্লিকেট',
  }[status] || status);
}

/* ─────────────── ডিভাইস ─────────────── */

async function loadDevices() {
  const data = await api('/api/devices');
  const box = $('#device-list');

  if (!data.devices.length) {
    box.innerHTML = '<p class="empty">কোনো ডিভাইস নেই — উপরের পেয়ারিং কোড দিয়ে অ্যাপ যোগ করুন।</p>';
    return;
  }

  box.innerHTML = data.devices.map((d) => `
    <div class="device ${d.status === 'revoked' ? 'revoked' : ''}">
      <span class="grow">
        <div class="name">${esc(d.label)}</div>
        <div class="sub mono">${esc(d.device_uid)}</div>
        <div class="sub">${d.last_seen_at ? `সর্বশেষ: ${esc(relTime(d.last_seen_at))}` : 'এখনো সংযুক্ত হয়নি'} · কী ${esc(d.key_prefix)}</div>
      </span>
      <span class="pill ${d.status === 'active' ? 'matched' : 'expired'}">${d.status === 'active' ? 'সক্রিয়' : 'বাতিল'}</span>
      ${d.status === 'active' ? `<button class="btn danger small" data-revoke="${esc(d.id)}">বাতিল</button>` : ''}
    </div>
  `).join('');

  $$('[data-revoke]', box).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('ডিভাইসটি বাতিল করলে ওই ফোন আর এসএমএস পাঠাতে পারবে না। নিশ্চিত?')) return;
      try {
        await api(`/api/devices/${btn.dataset.revoke}/revoke`, { method: 'POST' });
        toast('ডিভাইস বাতিল হয়েছে', 'ok');
        loadDevices();
      } catch (e) { toast(e.message, 'err'); }
    });
  });
}

/* ─────────────── ফিড ─────────────── */

async function loadFeed() {
  const data = await api('/api/events?limit=60');
  const box = $('#feed-list');

  if (!data.events.length) {
    box.innerHTML = '<p class="empty">এখনো কোনো এসএমএস আসেনি। সিমুলেটর দিয়ে পরীক্ষা করতে পারেন।</p>';
    return;
  }

  box.innerHTML = data.events.map((e) => `
    <div class="feed-item">
      <div class="feed-top">
        <span class="provider-dot"><i class="p-${esc(e.provider)}"></i>${esc(e.provider_label)}</span>
        <span class="mono">${e.amount ? `৳${esc(e.amount)}` : '—'}</span>
        <span class="muted mono">${esc(e.trx_id || 'no-trx')}</span>
        <span class="pill ${esc(e.status)}">${statusBn(e.status)}</span>
        <span class="muted small-text">${esc(e.source)} · ${esc(relTime(e.ingested_at))}</span>
        ${e.reason ? `<span class="muted small-text">(${esc(e.reason)})</span>` : ''}
        ${e.matched_order_id ? `<span class="muted small-text">→ অর্ডার ${esc(e.matched_order_id.slice(-8))}</span>` : ''}
      </div>
      <div class="feed-text">${esc(e.raw_text)}</div>
    </div>
  `).join('');
}

/* ─────────────── সেটিংস ─────────────── */

async function loadSettings() {
  const data = await api('/api/me');
  merchant = data.merchant;
  const f = $('#settings-form');
  f.webhook_url.value = merchant.webhook_url || '';
  f.order_ttl_seconds.value = merchant.order_ttl_seconds;
  f.match_window_before_seconds.value = merchant.match_window_before_seconds;
  $('#webhook-secret').textContent = merchant.webhook_secret;
}

/* ─────────────── ইভেন্ট ওয়্যারিং ─────────────── */

$$('[data-auth-tab]').forEach((tab) => {
  tab.addEventListener('click', () => {
    $$('[data-auth-tab]').forEach((t) => t.classList.toggle('active', t === tab));
    $('#login-form').hidden = tab.dataset.authTab !== 'login';
    $('#register-form').hidden = tab.dataset.authTab !== 'register';
  });
});

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const data = await api('/api/auth/login', {
      method: 'POST', auth: false,
      body: { email: form.get('email'), password: form.get('password') },
    });
    setSession(data.token);
    await bootSession();
    toast('স্বাগতম!', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#register-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const data = await api('/api/auth/register', {
      method: 'POST', auth: false,
      body: {
        business_name: form.get('business_name'),
        email: form.get('email'),
        password: form.get('password'),
      },
    });
    setSession(data.token);
    await bootSession();
    toast('অ্যাকাউন্ট তৈরি হয়েছে', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#logout-btn').addEventListener('click', () => logout());

$$('.nav-btn').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view));
});

$$('[data-refresh]').forEach((btn) => {
  btn.addEventListener('click', () => loaders[currentView]?.().catch((e) => toast(e.message, 'err')));
});

$('#order-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  const submitBtn = ev.target.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  try {
    const data = await api('/api/orders', {
      method: 'POST',
      body: {
        provider: form.get('provider'),
        amount: form.get('amount'),
        sender: form.get('sender'),
        trx_id: form.get('trx_id') || undefined,
        reference: form.get('reference') || undefined,
      },
    });
    if (data.matched) {
      toast(`✓ ম্যাচ হয়েছে! ৳${data.order.amount} যাচাই সম্পন্ন`, 'ok');
    } else {
      toast('অর্ডার তৈরি হয়েছে — এসএমএসের অপেক্ষায়', 'ok');
    }
    ev.target.reset();
    loadOrders();
  } catch (e) { toast(e.message, 'err'); }
  finally { submitBtn.disabled = false; }
});

$('#order-filter').addEventListener('change', () => loadOrders().catch((e) => toast(e.message, 'err')));

$('#pair-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const data = await api('/api/pairing-codes', {
      method: 'POST',
      body: { label: form.get('label') || undefined },
    });
    $('#pair-output').hidden = false;
    $('#pair-code').textContent = data.code;
    toast('কোড তৈরি — ১৫ মিনিটের মধ্যে অ্যাপে দিন', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#device-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const data = await api('/api/devices', {
      method: 'POST',
      body: { label: form.get('label') || undefined },
    });
    $('#key-output').hidden = false;
    $('#key-device').textContent = data.credentials.device_id;
    $('#key-secret').textContent = data.credentials.device_key;
    toast('ডিভাইস কী তৈরি হয়েছে', 'ok');
    loadDevices();
  } catch (e) { toast(e.message, 'err'); }
});

$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  try {
    const data = await api('/api/settings', {
      method: 'PATCH',
      body: {
        webhook_url: form.get('webhook_url') || '',
        order_ttl_seconds: Number(form.get('order_ttl_seconds')),
        match_window_before_seconds: Number(form.get('match_window_before_seconds')),
      },
    });
    merchant = data.merchant;
    toast('সেটিংস সংরক্ষিত', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

$('#rotate-secret').addEventListener('click', async () => {
  if (!confirm('পুরনো সিক্রেট আর কাজ করবে না। রোটেট করবেন?')) return;
  try {
    const data = await api('/api/settings/rotate-webhook-secret', { method: 'POST' });
    $('#webhook-secret').textContent = data.webhook_secret;
    toast('সিক্রেট রোটেট হয়েছে — কোড আপডেট করুন', 'ok');
  } catch (e) { toast(e.message, 'err'); }
});

async function runSimulator(dryRun) {
  const form = $('#sim-form');
  const formData = new FormData(form);
  const out = $('#sim-result');
  try {
    const data = await api('/api/simulate', {
      method: 'POST',
      body: {
        sender: formData.get('sender'),
        text: formData.get('text'),
        dry_run: dryRun,
      },
    });
    out.hidden = false;
    out.textContent = JSON.stringify(data, null, 2);
    if (!dryRun && data.result?.status === 'matched') {
      toast(`✓ ম্যাচ হয়েছে — অর্ডার ${data.result.order_id}`, 'ok');
      loadFeed();
    }
  } catch (e) {
    toast(e.message, 'err');
  }
}

$('#sim-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  runSimulator(false);
});
$('#sim-dry').addEventListener('click', () => runSimulator(true));

/* ─────────────── ব্যাকআপ ─────────────── */

let storageBound = false;

function fmtBytes(n) {
  const size = Number(n || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(2)} MB`;
}

async function loadBackup() {
  const data = await api('/api/storage');
  const db = data.database || {};

  $('#db-info').innerHTML = `
    <div class="device">
      <span class="grow">
        <div class="name">${esc(db.file || 'app.db')}</div>
        <div class="sub">ইঞ্জিন: ${esc(db.engine || 'SQLite')} · আকার: ${esc(fmtBytes(db.size_bytes))}</div>
        <div class="sub">মার্চেন্ট: ${esc(db.tables?.merchants ?? 0)} · এই সার্ভারেই সংরক্ষিত</div>
      </span>
      <span class="pill matched">সক্রিয়</span>
    </div>
  `;

  const form = $('#storage-form');
  const s = data.storage || {};
  if (s.configured) {
    form.provider.value = s.provider;
    form.endpoint.value = s.endpoint || '';
    form.region.value = s.region || '';
    form.bucket.value = s.bucket || '';
    form.access_key_id.value = s.access_key_id || '';
    form.interval_minutes.value = s.interval_minutes || 0;
    form.keep.value = s.keep || 7;
    $('#storage-status').textContent = s.last_run_at
      ? `সর্বশেষ ব্যাকআপ: ${relTime(s.last_run_at)}${s.last_status?.startsWith('ok') ? ' ✓' : ` · সমস্যা: ${s.last_error || s.last_status}`}`
      : 'এখনো কোনো ব্যাকআপ হয়নি।';
  } else {
    $('#storage-status').textContent = 'কোনো ক্লাউড স্টোরেজ যোগ করা নেই — সব ডাটা এই মেশিনেই আছে।';
  }

  bindStorageForm();
  await loadBackupList();
}

async function loadBackupList() {
  const box = $('#backup-list');
  let data;
  try {
    data = await api('/api/storage/backups');
  } catch (e) {
    box.innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }

  if (!data.configured) {
    box.innerHTML = '<p class="empty">আগে নিজের ক্লাউড স্টোরেজ সংরক্ষণ করুন।</p>';
    return;
  }
  if (!data.backups?.length) {
    box.innerHTML = '<p class="empty">এখনো কোনো ব্যাকআপ নেই — উপরের "এখনই ব্যাকআপ" চাপুন।</p>';
    return;
  }

  box.innerHTML = data.backups.map((b) => `
    <div class="device">
      <span class="grow">
        <div class="name mono">${esc(String(b.key).split('/').pop())}</div>
        <div class="sub">${esc(fmtDate(b.created_at))} · ${esc(fmtBytes(b.size_bytes))}</div>
      </span>
      <span class="pill ${b.in_cloud ? 'matched' : 'expired'}">${b.in_cloud ? 'ক্লাউডে' : 'শুধু রেকর্ড'}</span>
      <button class="btn ghost small" data-restore="${esc(b.key)}">ফিরিয়ে আনুন</button>
    </div>
  `).join('');

  $$('[data-restore]', box).forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('এই ব্যাকআপ ফিরিয়ে আনলে এখনকার ডাটা প্রতিস্থাপিত হবে (আগেরটি .pre-restore কপি হিসেবে থাকবে)। নিশ্চিত?')) return;
      btn.disabled = true;
      try {
        const res = await api('/api/storage/restore', { method: 'POST', body: { key: btn.dataset.restore } });
        toast(`রিস্টোর সম্পন্ন — ${res.counts?.orders ?? 0} অর্ডার, ${res.counts?.events ?? 0} ইভেন্ট`, 'ok');
        showView('backup');
      } catch (e) {
        toast(e.message, 'err');
        btn.disabled = false;
      }
    });
  });
}

function bindStorageForm() {
  if (storageBound) return;
  storageBound = true;

  const form = $('#storage-form');

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.interval_minutes) data.interval_minutes = 0;
    if (!data.keep) data.keep = 7;
    try {
      await api('/api/storage', { method: 'POST', body: data });
      form.secret_access_key.value = '';
      toast('ক্লাউড স্টোরেজ সংরক্ষিত', 'ok');
      loadBackup();
    } catch (e) { toast(e.message, 'err'); }
  });

  $('#storage-test').addEventListener('click', async () => {
    const data = Object.fromEntries(new FormData(form).entries());
    $('#storage-status').textContent = 'পরীক্ষা চলছে…';
    try {
      const res = await api('/api/storage/test', { method: 'POST', body: data });
      $('#storage-status').textContent = `সংযোগ ঠিক আছে ✓ (${res.latency_ms} ms, ${res.objects} বস্তু)`;
      toast('সংযোগ সফল', 'ok');
    } catch (e) {
      $('#storage-status').textContent = e.message;
      toast(e.message, 'err');
    }
  });

  $('#backup-now').addEventListener('click', async () => {
    const btn = $('#backup-now');
    btn.disabled = true;
    try {
      const res = await api('/api/storage/backup', { method: 'POST' });
      toast(`ব্যাকআপ হয়েছে — ${fmtBytes(res.size_bytes)}`, 'ok');
      loadBackup();
    } catch (e) { toast(e.message, 'err'); }
    finally { btn.disabled = false; }
  });
}

/* ─────────────── স্টার্ট ─────────────── */

bootSession();
