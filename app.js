'use strict';

// The UI is served from GitHub Pages (colab.devs.surf) while the API stays on the
// Worker, so calls have to be absolute there. On the Worker's own origin the same
// files still work with relative paths, which keeps one build serving both.
const WORKER_ORIGIN = 'https://vexa-colab.adeniranj787.workers.dev';
const API_BASE = location.origin === WORKER_ORIGIN ? '' : WORKER_ORIGIN;
const CROSS_ORIGIN = API_BASE !== '';

const apiUrl = (path) => (/^https?:/i.test(path) ? path : API_BASE + path);

// Credential headers for a bare fetch (the ones that bypass api()). A token
// obtained cross-origin lives in sessionStorage so a reload keeps the session;
// it is cleared on lock and never written to localStorage.
function sessionHeaders() {
  const h = {};
  if (state.key) h['x-vexa-key'] = state.key;
  if (state.sessionToken) h['x-vexa-session'] = state.sessionToken;
  return h;
}

const state = {
  key: null,
  sessionToken: null,
  status: null,
  timer: null,
  integration: null,
  keys: [],
  settings: null,
  checks: null,
  modelConfig: null,
  view: 'overview',
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Wire a listener only if the element exists. A single missing node used to
// throw while the ~60 listeners were being registered, which silently killed
// every handler declared after it.
function on(sel, event, handler) {
  const node = typeof sel === 'string' ? $(sel) : sel;
  if (!node) {
    console.warn(`[vexa] missing element for "${sel}" (${event})`);
    return;
  }
  node.addEventListener(event, handler);
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function svgIcon(paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
  }
  return s;
}

// ------------------------------------------------------------- feedback

let toastTimer = null;
function toast(message, kind = 'ok') {
  const node = $('#toast');
  node.textContent = message;
  node.className = `toast show ${kind === 'err' ? 'err' : 'ok'}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.className = 'toast'), 3600);
}

function busy(btn, on) {
  if (!btn) return;
  btn.disabled = on;
  btn.classList.toggle('is-loading', on);
}

async function withBusy(btn, fn) {
  busy(btn, true);
  try {
    return await fn();
  } finally {
    busy(btn, false);
  }
}

// ---------------------------------------------------------------- fetch

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (state.key) headers['x-vexa-key'] = state.key;
  if (state.sessionToken) headers['x-vexa-session'] = state.sessionToken;
  if (opts.body) headers['content-type'] = 'application/json';

  let res;
  try {
    res = await fetch(apiUrl(path), {
      ...opts,
      headers,
      // Cross-origin, the HttpOnly cookie is not sent, so the session travels in
      // a header instead and credentials must stay out of the request.
      credentials: CROSS_ORIGIN ? 'omit' : 'same-origin',
    });
  } catch (err) {
    throw new Error(navigator.onLine ? 'Network request failed' : 'You are offline');
  }

  if (res.status === 401) {
    // Only tear the session down if the server says the session itself is gone.
    // An endpoint can legitimately answer 401 for a bad credential while the
    // session stays valid, and logging the operator out for that is a bug.
    const probe = await fetch(apiUrl('/api/auth/session'), {
      headers: sessionHeaders(),
      credentials: CROSS_ORIGIN ? 'omit' : 'same-origin',
    })
      .then((r) => r.status)
      .catch(() => 0);
    if (probe !== 200) {
      lock();
      throw new Error('Your session expired. Sign in again.');
    }
    const d = await res.json().catch(() => ({}));
    throw new Error(d?.error || 'unauthorized');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || `Request failed (HTTP ${res.status})`;
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    err.status = res.status;
    throw err;
  }
  return data;
}

// ----------------------------------------------------------------- gate

function unlock() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
}

function lock() {
  sessionStorage.removeItem('vexa_key');
  sessionStorage.removeItem('vexa_session');
  state.key = null;
  state.sessionToken = null;
  state.operator = null;
  clearInterval(state.timer);
  state.timer = null;
  $('#app').classList.add('hidden');
  $('#gate').classList.remove('hidden');
  closeNav();
  $('#gate-key').value = '';
  $('#gate-password').value = '';
  $('#gate-err').textContent = '';
  $('#gate-key-err').textContent = '';
}

// The gate proves a credential against /api/auth/session, which rejects anything
// invalid. /api/status is public, so validating against it let any key unlock the
// dashboard and then 401 the operator out on the first protected call.
async function enterDashboard() {
  unlock();
  startPolling();
  await refreshAll();
  navigate('overview', { closeDrawer: false });
}

async function probeSession() {
  try {
    const res = await fetch(apiUrl('/api/auth/session'), {
      headers: sessionHeaders(),
      credentials: CROSS_ORIGIN ? 'omit' : 'same-origin',
    });
    // A 401 still carries `setupRequired`, so parse the body either way.
    const data = await res.json().catch(() => null);
    if (!data) return null;
    return res.ok ? data : { authenticated: false, setupRequired: !!data.setupRequired };
  } catch {
    return null;
  }
}

on('#gate-form', 'submit', async (e) => {
  e.preventDefault();
  const username = $('#gate-username').value.trim();
  const password = $('#gate-password').value;
  const errNode = $('#gate-err');
  errNode.textContent = '';

  if (!username) return (errNode.textContent = 'Enter your username.');
  if (!password) return (errNode.textContent = 'Enter your password.');

  await withBusy($('#gate-submit'), async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: CROSS_ORIGIN ? 'omit' : 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Sign in failed');

      state.key = null;
      state.operator = data.operator || null;
      // Cross-origin the cookie is unusable, so the server returns the token.
      if (data.sessionToken) {
        state.sessionToken = data.sessionToken;
        sessionStorage.setItem('vexa_session', data.sessionToken);
      }
      $('#gate-password').value = '';
      await enterDashboard();
      if (state.operator?.mustChangePassword) {
        toast('Change your password in Settings', 'warn');
      }
    } catch (err) {
      errNode.textContent = err.message;
    }
  });
});

on('#gate-key-form', 'submit', async (e) => {
  e.preventDefault();
  const key = $('#gate-key').value.trim();
  const errNode = $('#gate-key-err');
  errNode.textContent = '';
  if (!key) return (errNode.textContent = 'Enter your operator key.');

  await withBusy($('#gate-key-submit'), async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        credentials: CROSS_ORIGIN ? 'omit' : 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'That operator key was not accepted.');

      // Keep the key in sessionStorage as well: API helpers fall back to the
      // x-vexa-key header, and the session cookie alone cannot be read by JS.
      state.key = key;
      sessionStorage.setItem('vexa_key', key);
      if (data.sessionToken) {
        state.sessionToken = data.sessionToken;
        sessionStorage.setItem('vexa_session', data.sessionToken);
      }
      $('#gate-key').value = '';
      await enterDashboard();
    } catch (err) {
      state.key = null;
      errNode.textContent = err.message;
    }
  });
});

on('#gate-toggle', 'click', () => {
  const form = $('#gate-key-form');
  const open = form.hidden;
  form.hidden = !open;
  $('#gate-toggle').setAttribute('aria-expanded', String(open));
  $('#gate-toggle').textContent = open ? 'Use a password instead' : 'Use an operator key instead';
  if (open) $('#gate-key').focus();
});

on('#setup-submit', 'click', async () => {
  const username = $('#setup-username').value.trim() || 'admin';
  const password = $('#setup-password').value;
  const errNode = $('#setup-err');
  errNode.textContent = '';
  if (password && password.length < 10) {
    return (errNode.textContent = 'Use at least 10 characters, or leave it blank to generate one.');
  }

  await withBusy($('#setup-submit'), async () => {
    try {
      // The operator key bootstraps the first administrator; the same key is
      // required again to confirm the operator owns this deployment.
      const key = $('#setup-key').value.trim() || state.key || sessionStorage.getItem('vexa_key') || '';
      if (!key) throw new Error('Enter your operator key.');
      const res = await fetch(apiUrl('/api/auth/bootstrap'), {
        method: 'POST',
        credentials: CROSS_ORIGIN ? 'omit' : 'same-origin',
        headers: { 'content-type': 'application/json', 'x-vexa-key': key },
        body: JSON.stringify({ username, password: password || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Setup failed');
      const box = $('#setup-result');
      box.hidden = false;
      $('#setup-result-text').textContent = `Username: ${data.username} — Password: ${data.password}`;
      $('#setup-password').value = '';
      $('#setup-key').value = '';
      // The new administrator can sign in immediately.
      $('#gate-username').value = data.username;
      toast('Administrator created — save the password, then sign in');
    } catch (err) {
      errNode.textContent = err.message;
    }
  });
});

on('#lock', 'click', async () => {
  // End the server-side session too, otherwise the cookie would let the same
  // browser walk straight back in.
  try {
    await fetch(apiUrl('/api/auth/logout'), {
      method: 'POST',
      headers: sessionHeaders(),
      credentials: CROSS_ORIGIN ? 'omit' : 'same-origin',
    });
  } catch {
    /* the local lock still happens */
  }
  lock();
});

// -------------------------------------------------------------- navigation

const TITLES = {
  overview: ['Overview', 'Live platform status'],
  accounts: ['Google Accounts', 'Connected identities and eligibility'],
  runtime: ['Colab Runtime Manager', 'One runtime, centrally coordinated'],
  model: ['Model Server', 'GGUF hosting and inference health'],
  openhands: ['OpenHands Integration', 'Point OpenHands at this endpoint'],
  settings: ['Settings', 'Credentials, connections, and platform config'],
  logs: ['Event Log', 'Platform activity'],
};

const LOADERS = {
  overview: loadStatus,
  accounts: loadAccounts,
  runtime: loadStatus,
  model: loadStatus,
  openhands: loadIntegration,
  settings: loadSettingsView,
  logs: loadLogs,
};

// Programmatic navigation must not close a drawer the operator just opened, so
// only a nav click dismisses it.
function navigate(view, { closeDrawer = true } = {}) {
  const [title, sub] = TITLES[view] || TITLES.overview;
  state.view = view;

  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('.view').forEach((v) => v.classList.add('hidden'));
  const section = $(`#view-${view}`);
  if (section) {
    section.classList.remove('hidden');
    // Re-trigger the entry animation so navigation feels deliberate.
    section.style.animation = 'none';
    void section.offsetWidth;
    section.style.animation = '';
  }
  $('#view-title').textContent = title;
  $('#view-sub').textContent = sub;
  document.title = `${title} · VEXA`;

  if (closeDrawer) closeNav();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });

  const loader = LOADERS[view];
  if (loader) loader().catch((err) => err.message !== 'unauthorized' && toast(err.message, 'err'));
}

$$('.nav').forEach((btn) => {
  btn.addEventListener('click', () => navigate(btn.dataset.view));
});

// --------------------------------------------------- mobile drawer

function openNav() {
  $('#sidebar').classList.add('open');
  $('#scrim').hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeNav() {
  $('#sidebar').classList.remove('open');
  $('#scrim').hidden = true;
  document.body.style.overflow = '';
}

on('#nav-open', 'click', openNav);
on('#nav-close', 'click', closeNav);
on('#scrim', 'click', closeNav);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#sidebar').classList.contains('open')) closeNav();
});

// -------------------------------------------------------------- formatters

const fmtTime = (ms) => (ms ? new Date(ms).toLocaleString() : '—');

const fmtAgo = (ms) => {
  if (!ms) return 'never';
  const d = Date.now() - ms;
  if (d < 0) return 'just now';
  if (d < 60e3) return `${Math.floor(d / 1000)}s ago`;
  if (d < 3600e3) return `${Math.floor(d / 60e3)}m ago`;
  if (d < 86400e3) return `${Math.floor(d / 3600e3)}h ago`;
  return `${Math.floor(d / 86400e3)}d ago`;
};

const fmtBytes = (n) => {
  if (!n) return '—';
  const g = n / 1e9;
  return g >= 1 ? `${g.toFixed(2)} GB` : `${(n / 1e6).toFixed(0)} MB`;
};

const fmtDur = (ms) => {
  if (!ms || ms < 0) return '—';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

const STATUS_PILL = {
  idle: ['idle', 'idle'],
  activating: ['starting', 'runtime starting'],
  gpu_init: ['starting', 'GPU initializing'],
  model_load: ['starting', 'model loading'],
  ready: ['ready', 'model ready'],
  processing: ['busy', 'model processing'],
  stopping: ['starting', 'shutting down'],
  unavailable: ['error', 'unavailable'],
};

function kv(container, pairs) {
  container.innerHTML = '';
  for (const [k, v] of pairs) {
    container.appendChild(el('div', 'k', k));
    const val = el('div', 'v');
    if (v instanceof Node) val.appendChild(v);
    else val.textContent = v ?? '—';
    container.appendChild(val);
  }
}

function emptyRow(tbody, colspan, message) {
  tbody.innerHTML = '';
  const tr = el('tr');
  const td = el('td', 'empty', message);
  td.colSpan = colspan;
  tr.appendChild(td);
  tbody.appendChild(tr);
}

// ---------------------------------------------------------------- status

async function loadStatus() {
  const data = await api('/api/status');
  state.status = data;
  renderStatus(data);
  return data;
}

function renderStatus(data) {
  const { coordinator: c, accounts, runtime, summary } = data;
  const [cls, label] = STATUS_PILL[c.status] || ['idle', c.status];
  const pill = $('#pill-status');
  pill.className = `pill ${cls}`;
  pill.querySelector('.pill-text').textContent = label;

  const stats = [
    ['Connected accounts', summary.totalAccounts, `${summary.connectedAccounts} authenticated`],
    ['Eligible accounts', summary.eligibleAccounts, 'can host a runtime'],
    [
      'Active Colab',
      c.accountId ? accounts.find((a) => a.id === c.accountId)?.email || '—' : 'none',
      c.status,
    ],
    [
      'GPU',
      c.gpu?.gpu_name || runtime?.gpuName || '—',
      c.gpu?.gpu_vram_mb ? `${(c.gpu.gpu_vram_mb / 1024).toFixed(0)} GB VRAM` : 'not reported',
    ],
    [
      'Model',
      c.status === 'ready' || c.status === 'processing' ? 'available' : c.status,
      c.modelId || data.model?.servedId || '—',
    ],
    ['Uptime', c.readyAt ? fmtDur(Date.now() - c.readyAt) : '—', c.startedAt ? `started ${fmtAgo(c.startedAt)}` : ''],
    ['Last activity', fmtAgo(c.lastActivityAt), c.activeRequests ? `${c.activeRequests} active request(s)` : ''],
    ['Inference requests', summary.totalRequests, `avg ${summary.avgLatencyMs} ms`],
  ];

  const grid = $('#stat-grid');
  grid.innerHTML = '';
  for (const [label2, value, sub] of stats) {
    const s = el('div', 'stat');
    s.appendChild(el('div', 'label', label2));
    s.appendChild(el('div', 'value', String(value ?? '—')));
    if (sub) s.appendChild(el('div', 'sub', String(sub)));
    grid.appendChild(s);
  }

  kv($('#runtime-state'), [
    ['Status', `${c.status} / ${c.phase || '—'}`],
    ['Runtime ID', c.runtimeId || '—'],
    ['Endpoint', c.endpoint || '—'],
    ['Active requests', String(c.activeRequests || 0)],
    ['Agent tasks', String(c.activeTasks || 0)],
    ['Progress', c.progress ? `${c.progress.step} (${c.progress.pct}%)` : '—'],
    ['Last error', c.lastError || '—'],
  ]);

  renderRuntimeView(data);
  renderModelView(data);
  if (state.view === 'overview' || state.view === 'runtime') loadHistory();
}

function renderRuntimeView(data) {
  const { coordinator: c, accounts, runtime } = data;
  const acct = accounts.find((a) => a.id === c.accountId);
  const mem = c.metrics || {};

  kv($('#runtime-detail'), [
    ['Active account', acct ? acct.email : '—'],
    ['Runtime', c.runtimeId || '—'],
    ['Provider', runtime?.provider || c.provider || '—'],
    ['GPU', c.gpu?.gpu_name || '—'],
    ['VRAM', c.gpu?.gpu_vram_mb ? `${(c.gpu.gpu_vram_mb / 1024).toFixed(1)} GB` : '—'],
    ['RAM', c.gpu?.ram_total_mb ? `${(c.gpu.ram_total_mb / 1024).toFixed(1)} GB total` : '—'],
    ['Storage', mem.storage_total_gb ? `${mem.storage_used_gb || 0} / ${mem.storage_total_gb} GB` : '—'],
    ['Model state', c.modelState || (c.status === 'ready' ? 'loaded' : '—')],
    ['Uptime', c.readyAt ? fmtDur(Date.now() - c.readyAt) : '—'],
    ['Active tasks', String(c.activeTasks || 0)],
  ]);

  const pct = c.progress?.pct ?? (c.status === 'ready' || c.status === 'processing' ? 100 : 0);
  $('#progress-bar').style.width = `${pct}%`;
  $('#progress').setAttribute('aria-valuenow', String(pct));
  $('#progress-step').textContent = c.progress?.step || (c.status === 'ready' ? 'model ready' : '—');

  const idleMs = (data.idleTimeoutMinutes || 20) * 60000;
  const busyNow = (c.activeRequests || 0) > 0 || (c.activeTasks || 0) > 0;
  const last = c.lastActivityAt || c.readyAt;

  if (!last || (c.status !== 'ready' && c.status !== 'processing')) {
    $('#idle-count').textContent = '—';
    $('#idle-note').textContent = 'No runtime active.';
  } else if (busyNow) {
    $('#idle-count').textContent = 'held';
    $('#idle-note').textContent = 'Work in flight — the shutdown timer cannot fire while a task runs.';
  } else {
    const left = Math.max(0, idleMs - (Date.now() - last));
    $('#idle-count').textContent = fmtDur(left);
    $('#idle-note').textContent = `Shuts down after ${data.idleTimeoutMinutes || 20} min of genuine inactivity.`;
  }
}

function renderModelView(data) {
  const { coordinator: c, summary } = data;
  const m = data.model || state.modelConfig || {};
  const ready = c.status === 'ready' || c.status === 'processing';

  const grid = $('#model-stats');
  grid.innerHTML = '';
  const stats = [
    ['Model', m.file ? m.file.split('/').pop() : '—', m.repo || ''],
    ['File size', m.bytes ? fmtBytes(m.bytes) : '—', 'GGUF quantisation'],
    ['Served as', m.servedId || '—', 'OpenAI model id'],
    ['Requests', summary.totalRequests, `avg ${summary.avgLatencyMs} ms`],
    ['Tokens in', summary.promptTokens, 'prompt'],
    ['Tokens out', summary.completionTokens, 'completion'],
  ];
  for (const [l, v, s] of stats) {
    const d = el('div', 'stat');
    d.appendChild(el('div', 'label', l));
    d.appendChild(el('div', 'value', String(v ?? '—')));
    if (s) d.appendChild(el('div', 'sub', String(s)));
    grid.appendChild(d);
  }

  kv($('#model-detail'), [
    ['Model file', m.file || '—'],
    ['Persistent storage', 'Google Drive (VEXA_DRIVE_DIR)'],
    ['Download status', c.modelState || 'reused from Drive cache'],
    ['Loading status', c.status === 'model_load' ? 'loading' : ready ? 'loaded' : '—'],
    ['Inference server', ready ? 'llama.cpp (healthy)' : 'not running'],
    ['Endpoint', c.endpoint || '—'],
  ]);
}

async function loadHistory() {
  try {
    const [{ events }, { runtimes }] = await Promise.all([
      api('/api/runtime/logs?limit=40'),
      api('/api/runtimes'),
    ]);

    const init = $('#init-history');
    init.innerHTML = '';
    const rtEvents = events
      .filter((e) => ['runtime', 'agent', 'error', 'idle', 'connection', 'settings'].includes(e.kind))
      .slice(0, 12);
    if (!rtEvents.length) {
      init.appendChild(el('li', 'empty', 'No runtime activity yet.'));
    }
    for (const e of rtEvents) {
      const li = el('li');
      li.appendChild(el('span', 't', e.message || ''));
      li.appendChild(el('div', 'when', fmtTime(e.ts)));
      init.appendChild(li);
    }

    const rot = $('#rotation-history');
    rot.innerHTML = '';
    const starts = runtimes.filter((r) => r.status !== 'awaiting_agent').slice(0, 12);
    if (!starts.length) rot.appendChild(el('li', 'empty', 'No rotations recorded.'));
    for (const r of starts) {
      const acct = state.status?.accounts.find((a) => a.id === r.accountId);
      const li = el('li');
      li.appendChild(
        el(
          'span',
          't',
          `${acct?.email || String(r.accountId).slice(0, 8)} → ${r.status}${r.stopReason ? ` (${r.stopReason})` : ''}`
        )
      );
      const span = r.startedAt && r.stoppedAt ? ` · ${fmtDur(r.stoppedAt - r.startedAt)}` : '';
      li.appendChild(el('div', 'when', `${fmtTime(r.startedAt || r.stoppedAt)}${span}`));
      rot.appendChild(li);
    }
  } catch {
    /* history is best-effort */
  }
}

// -------------------------------------------------------------- accounts

async function loadAccounts() {
  if (!state.status) await loadStatus();
  const { accounts } = await api('/api/accounts');
  const activeId = state.status?.coordinator?.accountId;
  const tbody = $('#accounts-table tbody');
  tbody.innerHTML = '';

  if (!accounts.length) {
    emptyRow(tbody, 6, 'No Google accounts connected yet. Use “Connect Google account” to add one.');
    return;
  }

  for (const a of accounts) {
    const tr = el('tr');

    const idTd = el('td', 'identity', a.email);
    idTd.dataset.label = 'Identity';
    tr.appendChild(idTd);

    const st = el('td');
    st.dataset.label = 'Status';
    const tagCls =
      a.status === 'connected' ? 'ok' : a.status === 'disconnected' ? '' : 'err';
    st.appendChild(el('span', `tag ${tagCls}`, a.status));
    tr.appendChild(st);

    const eligTd = el('td', '', a.eligible ? 'yes' : 'no');
    eligTd.dataset.label = 'Eligible';
    tr.appendChild(eligTd);

    const rtTd = el('td', '', a.id === activeId ? 'active' : '—');
    rtTd.dataset.label = 'Runtime';
    tr.appendChild(rtTd);

    const usedTd = el('td', '', fmtAgo(a.lastUsedAt));
    usedTd.dataset.label = 'Last used';
    tr.appendChild(usedTd);

    const act = el('td', 'actions-cell');
    act.dataset.label = 'Actions';
    if (a.status === 'disconnected') {
      const b = el('button', 'btn sm ghost', 'Reconnect');
      b.onclick = () => (location.href = '/api/auth/google/start');
      act.appendChild(b);
    } else if (a.id === 'svc-google') {
      const b = el('button', 'btn sm ghost', 'Manage in Settings');
      b.onclick = () => navigate('settings');
      act.appendChild(b);
    } else {
      const b = el('button', 'btn sm danger', 'Disconnect');
      b.onclick = async () => {
        if (!confirm(`Disconnect ${a.email}? Its stored tokens will be erased.`)) return;
        try {
          await api('/api/accounts/disconnect', { method: 'POST', body: JSON.stringify({ id: a.id }) });
          toast('Account disconnected');
          await refreshAll();
          await loadAccounts();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      act.appendChild(b);
    }
    tr.appendChild(act);
    tbody.appendChild(tr);
  }
}

on('#connect-account', 'click', () => {
  location.href = '/api/auth/google/start';
});

// A notebook agent is bound to one account, so the token is issued for whichever
// account the operator picks. The token is displayed once and never re-readable.
on('#agent-issue', 'click', async () => {
  if (!state.status) await loadStatus();
  const accounts = state.status?.accounts || [];
  if (!accounts.length) {
    toast('Connect a Google account first', 'err');
    return;
  }
  const target = accounts.find((a) => a.id === state.status.coordinator?.accountId) || accounts[0];
  if (!confirm(`Issue a notebook agent token for ${target.email}?\n\nAny existing token for this account is revoked.`)) {
    return;
  }
  const btn = $('#agent-issue');
  btn.disabled = true;
  btn.textContent = 'Generating…';
  try {
    const res = await api('/api/agents/token', {
      method: 'POST',
      body: JSON.stringify({ accountId: target.id }),
    });
    $('#agent-token-value').textContent = res.token;
    $('#agent-worker-url').textContent = res.vexaUrl || location.origin;
    $('#agent-token-box').classList.remove('hidden');
    $('#agent-hint').textContent = `Token issued for ${target.email}.`;
    toast('Agent token generated');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate agent token';
  }
});

on('#agent-token-copy', 'click', async () => {
  try {
    await navigator.clipboard.writeText($('#agent-token-value').textContent);
    toast('Token copied');
  } catch {
    toast('Clipboard blocked by the browser', 'err');
  }
});

// ------------------------------------------------------------ integration

async function loadIntegration() {
  const data = await api('/api/integration');
  state.integration = data;
  const wrap = $('#integration-fields');
  wrap.innerHTML = '';

  const fields = [
    ['Name', data.name || 'Qwen Colab'],
    ['Custom Model', data.customModel],
    ['Base URL', data.baseUrl],
    ['API Key', data.apiKey || `stored (${data.apiKeyPrefix}…) — generate a new key to view it`],
  ];

  for (const [k, v] of fields) {
    const row = el('div', 'field');
    row.appendChild(el('div', 'k', k));
    row.appendChild(el('div', 'v', v ?? '—'));
    const btn = el('button', 'btn sm ghost', 'Copy');
    btn.type = 'button';
    btn.onclick = async () => {
      if (!data.apiKey && k === 'API Key') {
        toast('Generate a new key to copy its value', 'err');
        return;
      }
      try {
        await navigator.clipboard.writeText(String(v));
        toast(`${k} copied`);
      } catch {
        toast('Clipboard blocked by the browser', 'err');
      }
    };
    row.appendChild(btn);
    wrap.appendChild(row);
  }

  $('#key-note').textContent = data.hasStoredKey
    ? 'The full API key is only shown once, at creation. Generate a new key if you need the value again.'
    : 'Copy this key now — it is not shown again.';

  await loadKeys();
}

async function loadKeys() {
  const { keys } = await api('/api/keys');
  state.keys = keys;
  const tbody = $('#keys-table tbody');

  if (!keys.length) {
    emptyRow(tbody, 5, 'No API keys yet. Generate one to connect OpenHands.');
    return;
  }

  tbody.innerHTML = '';
  for (const k of keys) {
    const tr = el('tr');

    const nameTd = el('td', 'identity', k.name);
    nameTd.dataset.label = 'Name';
    tr.appendChild(nameTd);

    const preTd = el('td', '', `${k.key_prefix}…`);
    preTd.dataset.label = 'Prefix';
    tr.appendChild(preTd);

    const creTd = el('td', '', fmtTime(k.created_at));
    creTd.dataset.label = 'Created';
    tr.appendChild(creTd);

    const usedTd = el('td', '', fmtAgo(k.last_used_at));
    usedTd.dataset.label = 'Last used';
    tr.appendChild(usedTd);

    const act = el('td', 'actions-cell');
    act.dataset.label = 'Actions';
    if (!k.revoked_at) {
      const b = el('button', 'btn sm danger', 'Revoke');
      b.onclick = () =>
        withBusy(b, async () => {
          try {
            await api('/api/keys/revoke', { method: 'POST', body: JSON.stringify({ id: k.id }) });
            toast('Key revoked');
            await loadIntegration();
          } catch (err) {
            toast(err.message, 'err');
          }
        });
      act.appendChild(b);
    } else {
      act.appendChild(el('span', 'tag', 'revoked'));
    }
    tr.appendChild(act);
    tbody.appendChild(tr);
  }
}

on('#new-key', 'click', (e) =>
  withBusy(e.currentTarget, async () => {
    try {
      const res = await api('/api/keys', { method: 'POST', body: JSON.stringify({ name: 'OpenHands' }) });
      await loadIntegration();
      // The full key is returned exactly once, so keep it on screen until the
      // operator dismisses it. A toast alone loses it forever if the clipboard
      // write is blocked.
      const box = $('#new-key-box');
      $('#new-key-value').textContent = res.key;
      box.hidden = false;
      toast('New API key created — copy it now');
      try {
        await navigator.clipboard.writeText(res.key);
        toast('New API key copied to clipboard');
      } catch {
        /* the key stays visible in the box above */
      }
    } catch (err) {
      toast(err.message, 'err');
    }
  })
);

on('#new-key-copy', 'click', async () => {
  const value = $('#new-key-value').textContent;
  try {
    await navigator.clipboard.writeText(value);
    toast('API key copied');
  } catch {
    toast('Copy failed — select the key and copy manually', 'err');
  }
});

on('#new-key-dismiss', 'click', () => {
  $('#new-key-box').hidden = true;
  $('#new-key-value').textContent = '';
});

on('#test-connection', 'click', (e) =>
  withBusy(e.currentTarget, async () => {
    const pre = $('#test-result');
    pre.classList.remove('hidden');
    pre.textContent = 'Testing… (a cold start can take a few minutes)';
    try {
      const res = await api('/api/integration/test', { method: 'POST' });
      pre.textContent = JSON.stringify(res, null, 2);
      toast(res.chatStatus === 200 ? 'Endpoint answered' : 'Endpoint reachable, model not ready', res.chatStatus === 200 ? 'ok' : 'err');
    } catch (err) {
      pre.textContent = `Failed: ${err.message}`;
      toast(err.message, 'err');
    }
  })
);

// --------------------------------------------------------------- settings

const SETTINGS_TEXT_FIELDS = [
  'cloudflare_account_id',
  'google_client_id',
  'colab_scope',
  'dss_fqdn',
  'dss_target',
  'model_served_id',
  'idle_timeout_minutes',
];
const SETTINGS_SECRET_FIELDS = [
  'cloudflare_api_token',
  'google_client_secret',
  'google_refresh_token',
  'dss_api_key',
];

const SOURCE_LABEL = {
  settings: 'Saved in Settings',
  environment: 'Provided by the Worker environment',
  null: 'Not configured',
};

async function loadSettingsView() {
  const [settings, checks] = await Promise.all([
    api('/api/settings'),
    api('/api/connections').catch(() => null),
  ]);
  applySettings(settings);
  if (checks) {
    state.checks = checks;
    renderConnections(checks.checks);
    setDssBadge(checks.checks?.devssurf);
  }
}

function applySettings(settings) {
  state.settings = settings;
  const { values = {}, secrets = {}, derived = {} } = settings;

  for (const name of SETTINGS_TEXT_FIELDS) {
    const input = $(`#${name}`);
    if (!input) continue;
    input.value = values[name] ?? '';
    input.classList.remove('invalid');
    clearFieldError(name);
    const src = values[`${name}_source`];
    const hint = $(`#hint-${name}`);
    if (hint) {
      hint.textContent = SOURCE_LABEL[src] ?? '';
      hint.classList.toggle('source-settings', src === 'settings');
    }
  }

  for (const name of SETTINGS_SECRET_FIELDS) {
    const input = $(`#${name}`);
    if (!input) continue;
    input.value = '';
    input.classList.remove('invalid');
    clearFieldError(name);
    const info = secrets[name] || { set: false, source: null };
    const hint = $(`#hint-${name}`);
    if (hint) {
      hint.textContent = info.set
        ? `Stored (${info.source === 'settings' ? 'Settings' : 'Worker environment'}) — leave blank to keep it`
        : 'Not configured';
      hint.classList.toggle('source-settings', info.source === 'settings');
    }
  }

  if (derived.callbackUrl) $('#callback-url').textContent = derived.callbackUrl;
  $('#save-status').textContent = '';
}

function clearFieldError(name) {
  const node = $(`[data-error-for="${name}"]`);
  if (node) {
    node.textContent = '';
    node.classList.remove('show');
  }
}

function setFieldError(name, message) {
  const node = $(`[data-error-for="${name}"]`);
  const input = $(`#${name}`);
  if (node) {
    node.textContent = message;
    node.classList.add('show');
  }
  if (input) input.classList.add('invalid');
}

function validateSettings(payload) {
  let firstBad = null;
  SETTINGS_TEXT_FIELDS.forEach((n) => clearFieldError(n));
  SETTINGS_SECRET_FIELDS.forEach((n) => clearFieldError(n));

  const accountId = String(payload.cloudflare_account_id || '').trim();
  if (accountId && !/^[0-9a-f]{32}$/i.test(accountId)) {
    setFieldError('cloudflare_account_id', 'Must be 32 hexadecimal characters.');
    firstBad = firstBad || 'cloudflare_account_id';
  }

  const clientId = String(payload.google_client_id || '').trim();
  if (clientId && !clientId.endsWith('.apps.googleusercontent.com')) {
    setFieldError('google_client_id', 'Expected a value ending in .apps.googleusercontent.com');
    firstBad = firstBad || 'google_client_id';
  }

  const idle = String(payload.idle_timeout_minutes ?? '').trim();
  if (idle !== '') {
    const n = Number(idle);
    if (!Number.isInteger(n) || n < 1 || n > 1440) {
      setFieldError('idle_timeout_minutes', 'Enter a whole number between 1 and 1440.');
      firstBad = firstBad || 'idle_timeout_minutes';
    }
  }
  return firstBad;
}

function collectSettings() {
  const payload = {};
  for (const name of SETTINGS_TEXT_FIELDS) {
    const input = $(`#${name}`);
    if (!input) continue;
    payload[name] = input.value.trim();
  }
  for (const name of SETTINGS_SECRET_FIELDS) {
    const input = $(`#${name}`);
    if (!input) continue;
    const v = input.value.trim();
    if (v) payload[name] = v; // blank means "keep the stored secret"
  }
  return payload;
}

on('#settings-form', 'submit', async (e) => {
  e.preventDefault();
  const payload = collectSettings();
  const bad = validateSettings(payload);
  if (bad) {
    const node = $(`#${bad}`);
    node?.focus();
    $('#save-status').textContent = 'Fix the highlighted field before saving.';
    return;
  }

  await withBusy($('#settings-save'), async () => {
    try {
      const res = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      applySettings({ values: res.values, secrets: res.secrets, derived: state.settings?.derived });
      $('#save-status').textContent = `Saved ${res.written?.length || 0} field(s).`;
      toast('Settings saved');
      // A credential change invalidates every previous check.
      await reloadChecks();
      await refreshAll();
    } catch (err) {
      $('#save-status').textContent = 'Save failed.';
      toast(err.message, 'err');
    }
  });
});

on('#settings-reset', 'click', () => {
  if (state.settings) {
    applySettings(state.settings);
    $('#save-status').textContent = 'Changes discarded.';
    toast('Reverted to the last saved values');
  }
});

$$('.reveal').forEach((btn) => {
  btn.addEventListener('click', () => {
    const input = $(`#${btn.dataset.reveal}`);
    if (!input) return;
    const showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    btn.textContent = showing ? 'Show' : 'Hide';
  });
});

on('#copy-callback', 'click', async (e) => {
  const text = $('#callback-url').textContent;
  try {
    await navigator.clipboard.writeText(text);
    toast('Redirect URI copied');
  } catch {
    toast('Clipboard blocked by the browser', 'err');
  }
});

// ------------------------------------------------------------- Devs.Surf DNS

function setDssBadge(check) {
  const badge = $('#dss-badge');
  if (!badge) return;
  const hint = $('#dss-hint');
  if (hint) hint.hidden = check ? check.status !== 'unconfigured' : false;
  const tone = !check ? 'muted' : check.ok ? 'ok' : check.status === 'unconfigured' ? 'muted' : 'err';
  const label = !check
    ? 'not checked'
    : check.ok
      ? 'connected'
      : check.status === 'unconfigured'
        ? 'not configured'
        : check.status;
  badge.textContent = label;
  badge.className = `badge ${tone}`;
  badge.title = check?.detail || '';
}

on('#dss-test', 'click', async () => {
  await withBusy($('#dss-test'), async () => {
    try {
      // Save first so the test runs against what the worker will actually use,
      // then ask the Worker to hit the real API.
      const payload = collectSettings();
      if (payload.dss_api_key || payload.dss_fqdn || payload.dss_target) {
        await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
      }
      const res = await api('/api/connections/test', {
        method: 'POST',
        body: JSON.stringify({ service: 'devssurf' }),
      });
      const check = res.check;
      setDssBadge(check);
      toast(check.ok ? `Devs.Surf: ${check.detail}` : `Devs.Surf: ${check.detail}`, check.ok ? 'ok' : 'err');
    } catch (err) {
      setDssBadge({ ok: false, status: 'error', detail: err.message });
      toast(err.message, 'err');
    }
  });
});

async function loadDns() {
  const panel = $('#dns-panel');
  const tbody = $('#dns-table tbody');
  tbody.innerHTML = '';

  const skeleton = el('tr');
  const cell = el('td');
  cell.colSpan = 5;
  cell.appendChild(el('div', 'skeleton skeleton-row'));
  skeleton.appendChild(cell);
  tbody.appendChild(skeleton);
  panel.hidden = false;

  try {
    const fqdn = $('#dss_fqdn').value.trim();
    const data = await api(`/api/dns${fqdn ? `?fqdn=${encodeURIComponent(fqdn)}` : ''}`);
    tbody.innerHTML = '';
    $('#dns-domain').textContent = data.fqdn;

    if (!data.records.length) {
      const tr = el('tr');
      const td = el('td');
      td.colSpan = 5;
      td.appendChild(el('p', 'empty', 'No DNS records on this domain.'));
      tr.appendChild(td);
      tbody.appendChild(tr);
    }

    for (const rec of data.records) {
      const tr = el('tr');
      const typeTd = el('td');
      typeTd.dataset.label = 'Type';
      typeTd.appendChild(el('span', `chip chip-${rec.type.toLowerCase()}`, rec.type));
      tr.appendChild(typeTd);

      const nameTd = el('td', 'mono');
      nameTd.dataset.label = 'Name';
      nameTd.textContent = rec.name;
      tr.appendChild(nameTd);

      const contentTd = el('td', 'mono wrap');
      contentTd.dataset.label = 'Content';
      contentTd.textContent = rec.content;
      tr.appendChild(contentTd);

      const ttlTd = el('td');
      ttlTd.dataset.label = 'TTL';
      ttlTd.textContent = `${rec.ttl}s`;
      tr.appendChild(ttlTd);

      const act = el('td', 'actions-cell');
      act.dataset.label = 'Actions';
      const del = el('button', 'btn sm danger', 'Delete');
      del.onclick = async () => {
        if (!confirm(`Delete ${rec.type} ${rec.name} → ${rec.content}?`)) return;
        try {
          await api('/api/dns/records/delete', {
            method: 'POST',
            body: JSON.stringify({ fqdn: data.fqdn, id: rec.id }),
          });
          toast('Record deleted');
          await loadDns();
        } catch (err) {
          toast(err.message, 'err');
        }
      };
      act.appendChild(del);
      tr.appendChild(act);
      tbody.appendChild(tr);
    }

    const note = $('#dns-note');
    note.textContent = data.target
      ? `Records are read live from Devs.Surf. Expected apex CNAME target: ${data.target}.`
      : 'Records are read live from Devs.Surf.';
  } catch (err) {
    tbody.innerHTML = '';
    const tr = el('tr');
    const td = el('td');
    td.colSpan = 5;
    td.appendChild(el('p', 'empty error-text', err.message));
    tr.appendChild(td);
    tbody.appendChild(tr);
  }
}

on('#dns-refresh', 'click', loadDns);

on('#dns-add', 'click', () => {
  const form = $('#dns-add-form');
  form.hidden = !form.hidden;
  if (!form.hidden) {
    const target = $('#dss_target').value.trim();
    if (!$('#dns-content').value && target) $('#dns-content').value = target;
    $('#dns-name').value = $('#dns-name').value || '@';
    $('#dns-type').focus();
  }
});

on('#dns-add-cancel', 'click', () => {
  $('#dns-add-form').hidden = true;
  $('#dns-add-err').textContent = '';
});

on('#dns-add-save', 'click', async () => {
  const errNode = $('#dns-add-err');
  errNode.textContent = '';
  const type = $('#dns-type').value;
  const name = $('#dns-name').value.trim() || '@';
  const content = $('#dns-content').value.trim();
  const fqdn = $('#dss_fqdn').value.trim();

  if (!fqdn) return (errNode.textContent = 'Set the subdomain and save it first.');
  if (!content) return (errNode.textContent = 'Enter the record content.');
  if (type === 'A' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(content)) {
    return (errNode.textContent = 'An A record needs an IPv4 address.');
  }
  if (type === 'AAAA' && !content.includes(':')) {
    return (errNode.textContent = 'An AAAA record needs an IPv6 address.');
  }

  await withBusy($('#dns-add-save'), async () => {
    try {
      await api('/api/dns/records', {
        method: 'POST',
        body: JSON.stringify({ fqdn, type, name, content }),
      });
      toast(`${type} record created`);
      $('#dns-add-form').hidden = true;
      $('#dns-content').value = '';
      await loadDns();
    } catch (err) {
      errNode.textContent = err.message;
    }
  });
});

on('#dns-point', 'click', async () => {
  const fqdn = $('#dss_fqdn').value.trim();
  const target = $('#dss_target').value.trim();
  if (!fqdn || !target) {
    toast('Set the subdomain and CNAME target first', 'err');
    return;
  }
  if (!confirm(`Point ${fqdn} at ${target}? Existing apex CNAMEs will be replaced.`)) return;

  await withBusy($('#dns-point'), async () => {
    try {
      const res = await api('/api/dns/point', {
        method: 'POST',
        body: JSON.stringify({ fqdn, target }),
      });
      toast(res.changed ? `${fqdn} now points at ${target}` : `${fqdn} already points at ${target}`);
      await loadDns();
    } catch (err) {
      toast(err.message, 'err');
    }
  });
});

// ------------------------------------------------------- password change

on('#pw-save', 'click', async () => {
  const current = $('#pw-current').value;
  const next = $('#pw-new').value;
  const errNode = $('#pw-err');
  errNode.textContent = '';

  if (!current) return (errNode.textContent = 'Enter your current password.');
  if (!next) return (errNode.textContent = 'Enter a new password.');
  if (next.length < 10) return (errNode.textContent = 'Use at least 10 characters.');
  if (next === current) return (errNode.textContent = 'The new password must be different.');

  await withBusy($('#pw-save'), async () => {
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      $('#pw-current').value = '';
      $('#pw-new').value = '';
      $('#pw-hint').textContent = 'Password updated. Other devices were signed out.';
      toast('Password updated');
    } catch (err) {
      errNode.textContent = err.message;
    }
  });
});

// ------------------------------------------------------------ connection UI

const CONN_META = {
  cloudflare: { name: 'Cloudflare', paths: ['M17 18a4 4 0 0 0 .6-8A6 6 0 0 0 6 11a3.5 3.5 0 0 0 .5 7z'] },
  google: { name: 'Google OAuth', paths: ['M12 3a9 9 0 1 0 9 9', 'M12 8a4 4 0 1 0 4 4', 'M21 3v6h-6'] },
  google_oauth: { name: 'OAuth redirect', paths: ['M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1', 'M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1'] },
  colab: { name: 'Colab runtime', paths: ['M12 3l8 4.5v9L12 21l-8-4.5v-9z', 'M12 12l8-4.5M12 12v9M12 12L4 7.5'] },
  model: { name: 'Model server', paths: ['M4 6h16M4 12h16M4 18h10'] },
  devssurf: { name: 'Devs.Surf DNS', paths: ['M4 7h16M4 12h16M4 17h10', 'M17 14l3 3-3 3'] },
};

function renderConnections(checks) {
  const wrap = $('#connection-cards');
  if (!checks) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'conn-card', 'Connection checks unavailable.'));
    return;
  }
  wrap.innerHTML = '';

  for (const key of ['cloudflare', 'devssurf', 'google', 'google_oauth', 'colab', 'model']) {
    const check = checks[key];
    if (!check) continue;
    wrap.appendChild(connCard(key, check));
  }
}

function connCard(key, check) {
  const meta = CONN_META[key] || { name: key, paths: [] };
  // `tone` lets the backend distinguish a genuine failure from a service that
  // is simply idle by design (browser-only Colab, an on-demand model server).
  const tone =
    check.tone === 'ok' || check.ok
      ? 'ok'
      : check.tone === 'standby' || check.status === 'unconfigured'
        ? 'warn'
        : 'err';

  const card = el('div', `conn-card ${tone}`);

  const head = el('div', 'conn-head');
  const nameWrap = el('div', 'conn-name');
  const icon = el('span', 'conn-icon');
  if (meta.paths.length) icon.appendChild(svgIcon(meta.paths));
  nameWrap.appendChild(icon);
  nameWrap.appendChild(el('span', '', meta.name));
  head.appendChild(nameWrap);

  const status = el('div', 'conn-status');
  status.appendChild(el('span', 'dot'));
  status.appendChild(el('span', '', String(check.status || (check.ok ? 'ok' : 'unknown')).replace(/_/g, ' ')));
  head.appendChild(status);
  card.appendChild(head);

  card.appendChild(el('p', 'conn-detail', check.detail || ''));

  if (check.fix) {
    const box = el('div', 'conn-fix');
    box.appendChild(el('div', 'conn-fix-where', check.fix.where));
    const row = el('div', 'copy-row');
    row.appendChild(el('code', '', check.fix.value));
    const copy = el('button', 'btn sm ghost', 'Copy');
    copy.type = 'button';
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(check.fix.value);
        toast('Value copied');
      } catch {
        toast('Clipboard blocked by the browser', 'err');
      }
    };
    row.appendChild(copy);
    box.appendChild(el('div', 'conn-fix-action', check.fix.action));
    box.appendChild(row);
    card.appendChild(box);
  }

  if (check.data && Object.keys(check.data).length) {
    const parts = [];
    const d = check.data;
    if (d.httpStatus) parts.push(`HTTP ${d.httpStatus}`);
    if (d.expiresIn) parts.push(`expires in ${Math.round(d.expiresIn / 60)} min`);
    if (d.tokenStatus) parts.push(`token ${d.tokenStatus}`);
    if (d.coordinatorStatus) parts.push(`runtime ${d.coordinatorStatus}`);
    if (d.scopes?.length) parts.push(`${d.scopes.length} scope(s)`);
    if (parts.length) card.appendChild(el('div', 'conn-meta', parts.join(' · ')));
  }

  const foot = el('div', 'conn-foot');
  foot.appendChild(
    el('span', 'conn-latency', check.latencyMs != null ? `${check.latencyMs} ms` : check.checkedAt ? fmtAgo(check.checkedAt) : '')
  );
  const btn = el('button', 'btn sm ghost', 'Test');
  btn.type = 'button';
  btn.onclick = () =>
    withBusy(btn, async () => {
      try {
        const res = await api('/api/connections/test', {
          method: 'POST',
          body: JSON.stringify({ service: key }),
        });
        state.checks = state.checks || { checks: {} };
        state.checks.checks[key] = res.check;
        renderConnections(state.checks.checks);
        toast(
          res.check.ok ? `${meta.name}: ${res.check.status}` : `${meta.name}: ${res.check.status}`,
          res.check.ok ? 'ok' : 'err'
        );
      } catch (err) {
        toast(err.message, 'err');
      }
    });
  foot.appendChild(btn);
  card.appendChild(foot);

  return card;
}

async function reloadChecks() {
  const wrap = $('#connection-cards');
  wrap.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const sk = el('div', 'conn-card skeleton');
    sk.appendChild(el('div', 'skeleton-row w60'));
    sk.appendChild(el('div', 'skeleton-row'));
    wrap.appendChild(sk);
  }
  try {
    const res = await api('/api/connections');
    state.checks = res;
    renderConnections(res.checks);
  } catch (err) {
    wrap.innerHTML = '';
    wrap.appendChild(el('div', 'conn-card err', `Could not run checks: ${err.message}`));
  }
}

on('#check-all', 'click', (e) =>
  withBusy(e.currentTarget, async () => {
    await reloadChecks();
    toast('Connection checks refreshed');
  })
);

// ------------------------------------------------------------------ logs

async function loadLogs() {
  const limit = $('#log-limit').value;
  const { events } = await api(`/api/runtime/logs?limit=${limit}`);
  const list = $('#log-list');
  list.innerHTML = '';
  if (!events.length) {
    list.appendChild(el('li', 'empty', 'No events recorded yet.'));
    return;
  }
  for (const e of events) {
    const li = el('li');
    li.appendChild(el('span', 'when', new Date(e.ts).toLocaleTimeString()));
    li.appendChild(el('span', `kind ${e.kind}`, e.kind));
    li.appendChild(el('span', 'msg', e.message || ''));
    list.appendChild(li);
  }
}

on('#log-limit', 'change', () =>
  loadLogs().catch((err) => err.message !== 'unauthorized' && toast(err.message, 'err'))
);

// -------------------------------------------------------------- controls

function runtimeAction(button, path, okMessage) {
  button.addEventListener('click', (e) =>
    withBusy(e.currentTarget, async () => {
      try {
        const r = await api(path, { method: 'POST', body: '{}' });
        const ok = r.ok !== false;
        toast(ok ? okMessage : r.error || r.reason || 'Request refused', ok ? 'ok' : 'err');
        await refreshAll();
      } catch (err) {
        toast(err.message, 'err');
      }
    })
  );
}

runtimeAction($('#rt-start'), '/api/runtime/start', 'Runtime activation requested');
runtimeAction($('#rt-stop'), '/api/runtime/stop', 'Runtime stopped');
runtimeAction($('#rt-rotate'), '/api/runtime/rotate', 'Switched to the next eligible account');

on('#rt-logs', 'click', () => navigate('logs'));
on('#refresh', 'click', (e) =>
  withBusy(e.currentTarget, async () => {
    await refreshAll();
    if (state.view === 'accounts') await loadAccounts();
    if (state.view === 'logs') await loadLogs();
    if (state.view === 'settings') await reloadChecks();
    toast('Refreshed');
  })
);

// ------------------------------------------------------------------ boot

async function refreshAll() {
  try {
    await loadStatus();
    if (state.view === 'accounts') await loadAccounts();
    if (state.view === 'logs') await loadLogs();
  } catch (err) {
    if (err.message !== 'unauthorized') console.error(err);
  }
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(async () => {
    $('#clock').textContent = new Date().toLocaleTimeString();
    if (['logs', 'settings'].includes(state.view)) return;
    try {
      await loadStatus();
      if (state.view === 'accounts') await loadAccounts();
    } catch (err) {
      if (err.message !== 'unauthorized') {
        $('#pill-status').className = 'pill error';
        $('#pill-status').querySelector('.pill-text').textContent = 'offline';
      }
    }
  }, 5000);
}

// OAuth return
const params = new URLSearchParams(location.search);
if (params.get('oauth') === 'ok') {
  history.replaceState({}, '', '/');
  setTimeout(() => toast('Google account connected'), 300);
} else if (params.get('oauth') === 'error') {
  const reason = params.get('reason') || 'unknown';
  history.replaceState({}, '', '/');
  setTimeout(() => toast(`Connection failed: ${reason}`, 'err'), 300);
}

// Clock starts as soon as the dashboard is visible, even before polling.
setInterval(() => {
  if (state.key) $('#clock').textContent = new Date().toLocaleTimeString();
}, 1000);

// Boot: the session cookie is the source of truth, and a remembered operator
// key is only a convenience. Either one is proven against /api/auth/session
// before the dashboard is shown, so a stale credential lands on the login form
// instead of a half-loaded dashboard.
(async function boot() {
  const saved = sessionStorage.getItem('vexa_key');
  if (saved) state.key = saved;
  // A cross-origin session lives here instead of in a cookie, so restore it
  // before probing or every reload would appear signed out.
  const savedSession = sessionStorage.getItem('vexa_session');
  if (savedSession) state.sessionToken = savedSession;

  const session = await probeSession();
  if (session?.authenticated) {
    state.operator = session.operator || null;
    if (session.operator?.mustChangePassword) {
      toast('Change your password in Settings', 'warn');
    }
    await enterDashboard();
    return;
  }

  if (saved) {
    state.key = null;
    sessionStorage.removeItem('vexa_key');
  }
  if (savedSession) {
    state.sessionToken = null;
    sessionStorage.removeItem('vexa_session');
  }
  lock();

  // No administrator exists yet: offer first-run setup rather than an
  // unanswerable login form.
  if (session?.setupRequired) {
    $('#gate-main').hidden = true;
    $('#gate-setup').hidden = false;
    if (saved) $('#setup-key').value = saved;
  }
})();
