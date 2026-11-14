/* টাকাপাই — সাইটের ইন্টারঅ্যাকশন */

const SNIPPETS = {
  'php-order': [
    "<?php",
    "// আপনার সার্ভারের ঠিকানা (শেষে / ছাড়া)",
    "$server = '{{SERVER}}';",
    "$token  = 'আপনার মার্চেন্ট টোকেন';",
    "",
    "// গ্রাহকের ট্রাঞ্জেকশন জমা দিন",
    "$ch = curl_init($server . '/api/orders');",
    "curl_setopt_array($ch, [",
    "  CURLOPT_RETURNTRANSFER => true,",
    "  CURLOPT_POST           => true,",
    "  CURLOPT_HTTPHEADER     => [",
    "    'content-type: application/json',",
    "    'authorization: Bearer ' . $token,",
    "  ],",
    "  CURLOPT_POSTFIELDS => json_encode([",
    "    'provider'  => 'bkash',        // bkash | rocket | nagad",
    "    'amount'    => '100',          // গ্রাহক কত টাকা পাঠাবে",
    "    'sender'    => '01712345678',  // গ্রাহকের নম্বর",
    "    'reference' => 'ORDER-1024',   // আপনার নিজের অর্ডার আইডি",
    "  ]),",
    "]);",
    "",
    "$res    = json_decode(curl_exec($ch), true);",
    "$status = $res['order']['status'] ?? 'error';   // pending | matched",
    "",
    "if ($status === 'matched') {",
    "    // আগে থেকেই টাকা পড়ে ছিল — এখনই ডেলিভারি দিন",
    "}",
  ].join("\n"),

  'php-hook': [
    "<?php",
    "// আপনার সাইটে এই ফাইলটি রাখুন, যেমন: https://yoursite.com/payment-hook",
    "$raw      = file_get_contents('php://input');",
    "$secret   = 'আপনার webhook সিক্রেট';   // ড্যাশবোর্ড → সেটিংস",
    "$expected = 'sha256=' . hash_hmac('sha256', $raw, $secret);",
    "",
    "// ★ সিগনেচার যাচাই না করলে যে কেউ ভুয়া \"পেমেন্ট হয়েছে\" পাঠাতে পারবে",
    "if (!hash_equals($expected, $_SERVER['HTTP_X_SIGNATURE'] ?? '')) {",
    "    http_response_code(401);",
    "    exit;",
    "}",
    "",
    "$data = json_decode($raw, true);",
    "",
    "if (($data['event'] ?? '') === 'payment.matched') {",
    "    $reference = $data['order']['reference'];",
    "    $trxId     = $data['order']['trx_id'];",
    "",
    "    // এখানে আপনার ডেলিভারি লজিক — একই order.id-এ একবারই যেন চলে",
    "    // deliver_order($reference, $trxId);",
    "}",
    "",
    "http_response_code(200);",
    "echo json_encode(['ok' => true]);",
  ].join("\n"),

  node: [
    "import express from 'express';",
    "import crypto from 'node:crypto';",
    "",
    "const app = express();",
    "const SERVER = '{{SERVER}}';",
    "const TOKEN  = process.env.MERCHANT_TOKEN;",
    "",
    "// ১) গ্রাহকের ট্রাঞ্জেকশন জমা দিন",
    "app.post('/checkout', express.json(), async (req, res) => {",
    "  const r = await fetch(SERVER + '/api/orders', {",
    "    method: 'POST',",
    "    headers: {",
    "      'content-type': 'application/json',",
    "      authorization: 'Bearer ' + TOKEN,",
    "    },",
    "    body: JSON.stringify({",
    "      provider: 'bkash',",
    "      amount: '100',",
    "      sender: '01712345678',",
    "      reference: 'ORDER-1024',",
    "    }),",
    "  });",
    "  res.json(await r.json());",
    "});",
    "",
    "// ২) ম্যাচ হলে webhook এখানে আসবে",
    "app.post('/payment-hook', express.raw({ type: 'application/json' }), (req, res) => {",
    "  const expected = 'sha256=' + crypto",
    "    .createHmac('sha256', process.env.WEBHOOK_SECRET)",
    "    .update(req.body)",
    "    .digest('hex');",
    "",
    "  const given = req.header('x-signature') || '';",
    "  const ok = expected.length === given.length &&",
    "             crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));",
    "  if (!ok) return res.sendStatus(401);",
    "",
    "  const data = JSON.parse(req.body.toString());",
    "  if (data.event === 'payment.matched') {",
    "    console.log('পেমেন্ট সফল:', data.order.reference, data.order.trx_id);",
    "    // deliver(data.order.reference);",
    "  }",
    "  res.json({ ok: true });",
    "});",
    "",
    "app.listen(4000);",
  ].join("\n"),

  python: [
    "import hmac, hashlib, requests",
    "from flask import Flask, request, abort, jsonify",
    "",
    "app = Flask(__name__)",
    "SERVER = '{{SERVER}}'",
    "SECRET = b'আপনার webhook সিক্রেট'",
    "",
    "@app.post('/payment-hook')",
    "def hook():",
    "    raw = request.get_data()",
    "    expected = 'sha256=' + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()",
    "",
    "    # ★ সিগনেচার ছাড়া কাউকে বিশ্বাস করবেন না",
    "    if not hmac.compare_digest(expected, request.headers.get('X-Signature', '')):",
    "        abort(401)",
    "",
    "    data = request.get_json()",
    "    if data.get('event') == 'payment.matched':",
    "        print('পেমেন্ট সফল:', data['order']['reference'])",
    "        # deliver_order(data['order']['reference'])",
    "    return jsonify(ok=True)",
    "",
    "",
    "def create_order(token):",
    "    res = requests.post(SERVER + '/api/orders',",
    "        headers={'authorization': 'Bearer ' + token},",
    "        json={'provider': 'bkash', 'amount': '100',",
    "              'sender': '01712345678', 'reference': 'ORDER-1024'})",
    "    return res.json()['order']['status']    # pending | matched",
  ].join("\n"),

  curl: [
    "# ফোন ছাড়াই একটি মেসেজ পাঠিয়ে পুরো ফ্লো পরীক্ষা করুন",
    "curl -X POST '{{SERVER}}/api/ingest' \\",
    "  -H 'content-type: application/json' \\",
    "  -H 'x-device-id: {{DEVICE}}' \\",
    "  -H 'x-device-key: আপনার_ডিভাইস_কী' \\",
    "  -d '{",
    "    \"events\": [{",
    "      \"client_event_id\": \"test-001\",",
    "      \"source\": \"sms\",",
    "      \"sender\": \"16247\",",
    "      \"text\": \"You have received Tk 100.00 from 01712345678. Fee Tk 0.00. TrxID TEST12345\",",
    "      \"received_at\": \"2026-11-14T10:00:00Z\"",
    "    }]",
    "  }'",
    "",
    "# উত্তর: { \"results\": [ { \"status\": \"matched\", \"order_id\": \"ord_...\" } ] }",
  ].join("\n"),

  html: [
    "<!-- গ্রাহকের ব্রাউজারে চলবে। মার্চেন্ট টোকেন কখনো এখানে বসাবেন না। -->",
    "<form id=\"payForm\">",
    "  <input name=\"amount\" value=\"100\" />",
    "  <button type=\"submit\">টাকা পাঠিয়েছি, যাচাই করুন</button>",
    "</form>",
    "<p id=\"result\"></p>",
    "",
    "<script>",
    "document.getElementById('payForm').addEventListener('submit', async (e) => {",
    "  e.preventDefault();",
    "",
    "  // ⚠ নিজের সার্ভারে পাঠান — আপনার সার্ভারই টাকাপাই API কল করবে",
    "  const res = await fetch('/api/checkout', {",
    "    method: 'POST',",
    "    headers: { 'content-type': 'application/json' },",
    "    body: JSON.stringify({ amount: e.target.amount.value }),",
    "  });",
    "",
    "  const data = await res.json();",
    "  document.getElementById('result').textContent =",
    "    data.order.status === 'matched'",
    "      ? '✓ পেমেন্ট যাচাই হয়েছে'",
    "      : 'অপেক্ষা করুন… (SMS এলে নিজে থেকেই সফল হবে)';",
    "});",
    "</script>",
  ].join("\n"),
};

const DEFAULTS = {
  server: 'https://takapai-api.example.com',
  device: 'dev_xxxxxxxxxxxx',
};

let activeTab = 'php-order';

function currentConfig() {
  const serverInput = document.getElementById('cfgServer');
  const deviceInput = document.getElementById('cfgDevice');
  const server = (serverInput.value || '').trim().replace(/\/+$/, '');
  const device = (deviceInput.value || '').trim();
  return {
    server: server || DEFAULTS.server,
    device: device || DEFAULTS.device,
  };
}

function render() {
  const { server, device } = currentConfig();
  const text = SNIPPETS[activeTab]
    .replace(/\{\{SERVER\}\}/g, server)
    .replace(/\{\{DEVICE\}\}/g, device);

  document.getElementById('snippetCode').textContent = text;

  document.querySelectorAll('.copy').forEach((btn) => {
    btn.dataset.copy = activeTab;
  });
}

function saveConfig() {
  try {
    localStorage.setItem('takapai.server', document.getElementById('cfgServer').value);
    localStorage.setItem('takapai.device', document.getElementById('cfgDevice').value);
  } catch (e) {
    /* private mode */
  }
}

function loadConfig() {
  try {
    const server = localStorage.getItem('takapai.server');
    const device = localStorage.getItem('takapai.device');
    if (server) document.getElementById('cfgServer').value = server;
    if (device) document.getElementById('cfgDevice').value = device;
  } catch (e) {
    /* ignore */
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadConfig();

  document.getElementById('codeTabs').addEventListener('click', (ev) => {
    const tab = ev.target.closest('.tab');
    if (!tab) return;
    activeTab = tab.dataset.tab;
    document.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('active', t === tab);
    });
    render();
  });

  document.querySelectorAll('.copy').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const text = document.getElementById('snippetCode').textContent;
      try {
        await navigator.clipboard.writeText(text);
        const original = btn.textContent;
        btn.textContent = 'কপি হয়েছে ✓';
        setTimeout(() => { btn.textContent = original; }, 1600);
      } catch (e) {
        btn.textContent = 'কপি ব্যর্থ';
      }
    });
  });

  ['cfgServer', 'cfgDevice'].forEach((id) => {
    document.getElementById(id).addEventListener('input', () => {
      saveConfig();
      render();
    });
  });

  render();
});

/* ═══════════ Setup Your Server ═══════════ */
(function setupServerUI() {
  const $ = (s) => document.querySelector(s);
  const regForm = $('#setup-register-form');
  const loginForm = $('#setup-login-form');
  if (!regForm || !loginForm) return;

  const tabReg = $('#setup-tab-register');
  const tabLogin = $('#setup-tab-login');
  const msg = $('#setup-auth-msg');
  const result = $('#setup-result');
  const feedPanel = $('#setup-feed-panel');
  const feed = $('#setup-feed');

  const storeKey = 'takapai_project_session';
  let session = null;
  try { session = JSON.parse(localStorage.getItem(storeKey) || 'null'); } catch {}

  function showTab(which) {
    const isReg = which === 'reg';
    regForm.style.display = isReg ? 'grid' : 'none';
    loginForm.style.display = isReg ? 'none' : 'grid';
    tabReg.classList.toggle('ghost', !isReg);
    tabLogin.classList.toggle('ghost', isReg);
  }
  tabReg?.addEventListener('click', () => showTab('reg'));
  tabLogin?.addEventListener('click', () => showTab('login'));

  // ব্যাকএন্ড অন্য ডোমেইনে থাকলে site/config.js-এ window.TAKAPAI_API সেট করা থাকে
  const API_BASE = (typeof window !== 'undefined' && window.TAKAPAI_API) ? String(window.TAKAPAI_API).replace(/\/+$/, '') : '';

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (session?.token) headers.Authorization = 'Bearer ' + session.token;
    const res = await fetch(API_BASE + path, { ...opts, headers });
    const text = await res.text();
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok) throw new Error(data?.error?.message || data?.message || ('HTTP ' + res.status));
    return data;
  }

  function renderProject(p, dash) {
    result.style.display = 'block';
    $('#out-server-address').textContent = p.server_address || '';
    const link = $('#out-server-link'); link.href = p.server_address || '#';
    const appServer = p.app_server_address || API_BASE || '';
    const appEl = $('#out-app-server');
    if (appEl) appEl.textContent = appServer;
    $('#btn-copy-app-server')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(appServer); $('#btn-copy-app-server').textContent = 'কপি হয়েছে ✓'; setTimeout(() => { $('#btn-copy-app-server').textContent = 'কপি'; }, 1600); }
      catch { $('#out-app-server').scrollIntoView({ block: 'center' }); }
    });
    const apiUrl = p.api_url || p.api_base || '';
    $('#out-api-url').textContent = apiUrl;
    $('#out-api-example').textContent = apiUrl ? (apiUrl + '/orders') : '';
    const st = $('#out-api-status'); if (st) st.textContent = apiUrl ? (apiUrl + '/orders/[order_id]') : '';
    if (dash?.project) {
      $('#out-pairing-key').textContent = dash.project.pairing_key || '— (নতুন কী তৈরি করুন)';
      $('#out-pairing-exp').textContent = dash.project.pairing_expires_at ? ('মেয়াদ: ' + dash.project.pairing_expires_at) : '';
    }
    if (dash?.events) renderFeed(dash.events);
  }

  function renderFeed(events) {
    if (!feed) return;
    feedPanel.style.display = 'block';
    if (!events || !events.length) { feed.innerHTML = '<div class="meta" style="color:var(--muted)">এখনো কোনো মেসেজ আসেনি। অ্যাপ কানেক্ট হলে এখানে দেখাবে।</div>'; return; }
    feed.innerHTML = events.slice(0, 30).map(ev => {
      const amt = ev.amount ? ('৳' + ev.amount) : '';
      return `<div style="border:1px solid var(--line);border-radius:10px;padding:10px;background:rgba(255,255,255,.02)">
        <div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><b>${ev.provider_label||ev.provider||''} ${amt}</b><span class="meta" style="color:var(--muted)">${ev.status||''}</span></div>
        <div class="meta" style="color:var(--muted);margin-top:4px">Trx: ${ev.trx_id||'—'} · From: ${ev.sender_msisdn||'—'} · ${ev.ingested_at||''}</div>
        ${ev.reason ? `<div class="meta" style="color:var(--warn);margin-top:2px">${ev.reason}</div>` : ''}
      </div>`;
    }).join('');
  }

  async function refreshDashboard() {
    if (!session?.token || !session?.project?.project_name) return;
    try {
      const dash = await api(`/api/server/${encodeURIComponent(session.project.project_name)}/dashboard`);
      renderProject(dash.project, dash);
      msg.textContent = 'লগইন করা আছে: ' + session.project.project_name;
      msg.style.color = 'var(--accent)';
    } catch (e) {
      if (/401|403/.test(String(e))) { localStorage.removeItem(storeKey); session = null; result.style.display='none'; feedPanel.style.display='none'; }
      msg.textContent = e.message; msg.style.color = 'var(--danger)';
    }
  }

  async function handleAuth(ev, url) {
    ev.preventDefault();
    msg.textContent = 'অপেক্ষা করুন…'; msg.style.color = 'var(--muted)';
    const fd = new FormData(ev.target);
    const body = Object.fromEntries(fd.entries());
    try {
      const data = await api(url, { method: 'POST', body: JSON.stringify(body) });
      session = { token: data.token, project: data.project };
      localStorage.setItem(storeKey, JSON.stringify(session));
      msg.textContent = 'সফল!'; msg.style.color = 'var(--accent)';
      renderProject(data.project, null);
      await refreshDashboard();
    } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--danger)'; }
  }

  regForm.addEventListener('submit', (e) => handleAuth(e, '/api/server/register'));
  loginForm.addEventListener('submit', (e) => handleAuth(e, '/api/server/login'));

  $('#btn-new-pairing')?.addEventListener('click', async () => {
    if (!session?.project?.project_name) return;
    try {
      const data = await api(`/api/server/${encodeURIComponent(session.project.project_name)}/pairing-key`, { method: 'POST', body: '{}' });
      $('#out-pairing-key').textContent = data.pairing_key || '—';
      $('#out-pairing-exp').textContent = data.expires_at ? ('মেয়াদ: ' + data.expires_at) : '';
      msg.textContent = 'নতুন পেয়ারিং কী তৈরি হয়েছে'; msg.style.color = 'var(--accent)';
    } catch (e) { msg.textContent = e.message; msg.style.color = 'var(--danger)'; }
  });
  $('#setup-refresh')?.addEventListener('click', refreshDashboard);
  $('#setup-logout')?.addEventListener('click', () => {
    localStorage.removeItem(storeKey); session = null;
    result.style.display='none'; feedPanel.style.display='none';
    msg.textContent = 'লগআউট হয়েছে'; msg.style.color = 'var(--muted)';
  });

  if (session?.token) refreshDashboard();
})();
