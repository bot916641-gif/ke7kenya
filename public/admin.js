/* Aviator admin dashboard — vanilla JS SPA at /admin-dashboard. */
(function () {
  'use strict';

  const TOKEN_KEY = 'aviator_admin_token';
  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  async function api(path, init) {
    init = init || {};
    init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {});
    const tok = getToken();
    if (tok) init.headers.Authorization = 'Bearer ' + tok;
    const r = await fetch(path, init);
    let body = null; try { body = await r.json(); } catch {}
    if (r.status === 401) { clearToken(); render(); throw new Error((body && body.error) || 'Unauthorized'); }
    if (!r.ok) throw new Error((body && body.error) || r.statusText || 'Request failed');
    return body;
  }

  let activeTab = 'overview';
  let pollTimer = null;

  const root = document.getElementById('root');
  function render() {
    if (!getToken()) return renderLogin();
    return renderShell();
  }

  function renderLogin() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    root.innerHTML = `
      <div class="login-page">
        <form class="login-card" id="form">
          <h1>Admin sign in</h1>
          <p class="muted">Restricted area. Set ADMIN_USERNAME / ADMIN_PASSWORD env vars.</p>
          <label>Username</label><input name="username" value="admin" autocomplete="username" />
          <label>Password</label><input name="password" type="password" autocomplete="current-password" />
          <div class="err" id="err" style="margin-top:10px;font-size:13px"></div>
          <button type="submit">Sign in</button>
        </form>
      </div>`;
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('/api/admin/login', {
          method: 'POST',
          body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
        });
        setToken(r.token); render();
      } catch (err) { document.getElementById('err').textContent = err.message; }
    });
  }

  function renderShell() {
    const tabs = [
      ['overview', 'Overview'],
      ['users', 'Users'],
      ['transactions', 'Transactions'],
      ['rounds', 'Rounds'],
      ['settings', 'Settings'],
    ];
    root.innerHTML = `
      <div class="shell">
        <aside>
          <div class="brand">Aviator Admin</div>
          <nav>${tabs.map(([k, l]) => `
            <button data-tab="${k}" class="${activeTab === k ? 'active' : ''}">${l}</button>`).join('')}
          </nav>
          <button class="logout" id="logout">Sign out</button>
        </aside>
        <main id="main"></main>
      </div>`;
    document.querySelectorAll('[data-tab]').forEach((b) => {
      b.onclick = () => { activeTab = b.dataset.tab; render(); };
    });
    document.getElementById('logout').onclick = () => { clearToken(); render(); };
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (activeTab === 'overview') return renderOverview();
    if (activeTab === 'users') return renderUsers();
    if (activeTab === 'transactions') return renderTx();
    if (activeTab === 'rounds') return renderRounds();
    if (activeTab === 'settings') return renderSettings();
  }

  // ─────────── Overview ───────────
  async function renderOverview() {
    const main = document.getElementById('main');
    main.innerHTML = '<h2>Overview</h2><div id="stats" class="muted">Loading…</div>';
    async function load() {
      try {
        const s = await api('/api/admin/stats');
        const fmt = (n) => Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const cards = [
          ['Total users', s.users.total, `Wallets total: ${fmt(s.users.totalBalance)}`],
          ['Total deposits', fmt(s.deposits.total), `${s.deposits.count} transactions`],
          ['Total withdrawals', fmt(s.withdrawals.total), `${s.withdrawals.count} transactions`],
          ['Bets in last 24h', fmt(s.bets24h.total), `${s.bets24h.count} bets`],
          ['Active players', s.activePlayers, ''],
          ['Last round', s.lastRound ? Number(s.lastRound.crash_multiplier).toFixed(2) + 'x' : '—',
            s.lastRound ? s.lastRound.status : ''],
        ];
        document.getElementById('stats').outerHTML = `
          <div class="stat-grid" id="stats">${cards.map(([l, v, sub]) => `
            <div class="stat-card">
              <div class="s">${esc(l)}</div>
              <div class="v">${esc(v)}</div>
              <div class="s">${esc(sub)}</div>
            </div>`).join('')}
          </div>`;
      } catch (e) {
        const el = document.getElementById('stats');
        if (el) el.outerHTML = `<div class="err" id="stats">${esc(e.message)}</div>`;
      }
    }
    await load();
    pollTimer = setInterval(load, 4000);
  }

  // ─────────── Users ───────────
  async function renderUsers(search) {
    const main = document.getElementById('main');
    main.innerHTML = `
      <div class="row spread">
        <h2>Users</h2>
        <input id="search" placeholder="Search username…" value="${esc(search || '')}" />
      </div>
      <div id="userTable" class="muted">Loading…</div>`;
    document.getElementById('search').addEventListener('input', (e) => {
      clearTimeout(window.__usersDebounce);
      window.__usersDebounce = setTimeout(() => loadUsers(e.target.value.trim()), 250);
    });
    function rowHtml(u) {
      return `
        <tr>
          <td>${u.id}</td>
          <td>${esc(u.username)}</td>
          <td>${Number(u.balance).toFixed(2)}</td>
          <td>${new Date(u.created_at).toLocaleDateString()}</td>
          <td><span class="pill ${u.is_banned ? 'ban' : 'ok'}">${u.is_banned ? 'BANNED' : 'ACTIVE'}</span></td>
          <td class="actions">
            <button data-act="adjust" data-id="${u.id}" data-name="${esc(u.username)}" data-bal="${u.balance}">Adjust</button>
            <button data-act="ban" data-id="${u.id}" data-name="${esc(u.username)}" data-banned="${u.is_banned}"
              class="${u.is_banned ? '' : 'danger'}">${u.is_banned ? 'Unban' : 'Ban'}</button>
          </td>
        </tr>`;
    }
    async function loadUsers(s) {
      try {
        const r = await api('/api/admin/users?search=' + encodeURIComponent(s || ''));
        document.getElementById('userTable').outerHTML = `
          <table class="data" id="userTable">
            <thead><tr><th>ID</th><th>Username</th><th>Balance</th><th>Joined</th><th>Status</th><th></th></tr></thead>
            <tbody>${r.users.map(rowHtml).join('')}</tbody>
          </table>`;
        document.querySelectorAll('[data-act="adjust"]').forEach((b) => {
          b.onclick = async () => {
            const v = window.prompt(
              `Adjust balance for ${b.dataset.name} (current: ${b.dataset.bal}).\n` +
              `Enter +amount or -amount, or =amount to set absolute:`, '');
            if (!v) return;
            const body = v.startsWith('=')
              ? { setBalance: Number(v.slice(1)) }
              : { balanceDelta: Number(v) };
            try {
              await api('/api/admin/users/' + b.dataset.id, { method: 'PATCH', body: JSON.stringify(body) });
              loadUsers(document.getElementById('search').value.trim());
            } catch (e) { alert(e.message); }
          };
        });
        document.querySelectorAll('[data-act="ban"]').forEach((b) => {
          b.onclick = async () => {
            const banned = b.dataset.banned === 'true';
            if (!confirm(`${banned ? 'Unban' : 'Ban'} ${b.dataset.name}?`)) return;
            try {
              await api('/api/admin/users/' + b.dataset.id, {
                method: 'PATCH', body: JSON.stringify({ ban: !banned }),
              });
              loadUsers(document.getElementById('search').value.trim());
            } catch (e) { alert(e.message); }
          };
        });
      } catch (e) {
        const el = document.getElementById('userTable');
        if (el) el.outerHTML = `<div class="err" id="userTable">${esc(e.message)}</div>`;
      }
    }
    loadUsers(search || '');
  }

  // ─────────── Transactions ───────────
  async function renderTx() {
    const main = document.getElementById('main');
    main.innerHTML = `
      <div class="row spread">
        <h2>Transactions</h2>
        <select id="type">
          <option value="">All</option><option value="deposit">Deposits</option>
          <option value="withdrawal">Withdrawals</option><option value="bet">Bets</option>
          <option value="payout">Payouts</option>
          <option value="admin_credit">Admin credits</option><option value="admin_debit">Admin debits</option>
        </select>
      </div>
      <div id="txTable" class="muted">Loading…</div>`;
    document.getElementById('type').addEventListener('change', (e) => load(e.target.value));
    async function load(type) {
      try {
        const r = await api('/api/admin/transactions' + (type ? '?type=' + encodeURIComponent(type) : ''));
        document.getElementById('txTable').outerHTML = `
          <table class="data" id="txTable">
            <thead><tr><th>ID</th><th>User</th><th>Type</th><th>Amount</th>
              <th>Status</th><th>Phone</th><th>Reference</th><th>Date</th></tr></thead>
            <tbody>${r.transactions.map((t) => `
              <tr>
                <td>${t.id}</td><td>${esc(t.username)}</td><td>${esc(t.type)}</td>
                <td>${Number(t.amount).toFixed(2)}</td>
                <td><span class="pill ${esc(t.status)}">${esc(t.status)}</span></td>
                <td>${esc(t.phone || '-')}</td><td>${esc(t.reference || '-')}</td>
                <td>${new Date(t.created_at).toLocaleString()}</td>
              </tr>`).join('')}
            </tbody>
          </table>`;
      } catch (e) {
        const el = document.getElementById('txTable');
        if (el) el.outerHTML = `<div class="err" id="txTable">${esc(e.message)}</div>`;
      }
    }
    load('');
  }

  // ─────────── Rounds ───────────
  async function renderRounds() {
    const main = document.getElementById('main');
    main.innerHTML = '<h2>Recent rounds</h2><div id="roundsTable" class="muted">Loading…</div>';
    try {
      const r = await api('/api/admin/rounds');
      document.getElementById('roundsTable').outerHTML = `
        <table class="data" id="roundsTable">
          <thead><tr><th>ID</th><th>Crash</th><th>Status</th><th>Started</th>
            <th>Crashed</th><th>Hash</th></tr></thead>
          <tbody>${r.rounds.map((row) => {
            const m = Number(row.crash_multiplier);
            return `<tr>
              <td>${row.id}</td>
              <td><b style="color:${m >= 2 ? '#6ee895' : '#ff7a7a'}">${m.toFixed(2)}x</b></td>
              <td>${esc(row.status)}</td>
              <td>${row.started_at ? new Date(row.started_at).toLocaleTimeString() : '-'}</td>
              <td>${row.crashed_at ? new Date(row.crashed_at).toLocaleTimeString() : '-'}</td>
              <td class="mono">${esc((row.seed_hash || '').slice(0, 16))}…</td>
            </tr>`;
          }).join('')}</tbody>
        </table>`;
    } catch (e) {
      const el = document.getElementById('roundsTable');
      if (el) el.outerHTML = `<div class="err" id="roundsTable">${esc(e.message)}</div>`;
    }
  }

  // ─────────── Settings ───────────
  async function renderSettings() {
    const main = document.getElementById('main');
    main.innerHTML = '<h2>Game settings</h2><div id="settingsBody" class="muted">Loading…</div>';
    try {
      const r = await api('/api/admin/settings');
      const fields = [
        ['bet_phase_seconds', 'Bet phase (seconds)', 'How long players have to place a bet between rounds'],
        ['min_bet', 'Minimum bet', 'Smallest bet a user can place'],
        ['max_bet', 'Maximum bet', 'Largest bet a user can place'],
        ['house_edge', 'House edge (0-0.2)', 'Chance of an instant 1.00x crash. 0.03 = 3%.'],
        ['max_multiplier_cap', 'Max multiplier cap', 'Maximum crash point allowed in any round'],
        ['starting_bonus', 'Sign-up bonus (KES)', 'Free balance credited to new users'],
      ];
      document.getElementById('settingsBody').outerHTML = `
        <div id="settingsBody">
          <p class="muted">Changes apply on the very next round.</p>
          <div class="settings-grid">
            ${fields.map(([k, l, h]) => `
              <div class="setting-row">
                <label>${esc(l)}</label>
                <input type="number" step="any" data-key="${k}" value="${esc(r.settings[k])}" />
                <div class="h">${esc(h)}</div>
              </div>`).join('')}
          </div>
          <button id="save" class="primary">Save settings</button>
          <span id="saved" class="ok" style="margin-left:12px"></span>
        </div>`;
      document.getElementById('save').onclick = async () => {
        const updates = {};
        document.querySelectorAll('[data-key]').forEach((i) => { updates[i.dataset.key] = Number(i.value); });
        try {
          await api('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(updates) });
          const el = document.getElementById('saved'); el.textContent = 'Saved!';
          setTimeout(() => { el.textContent = ''; }, 1500);
        } catch (e) { alert(e.message); }
      };
    } catch (e) {
      const el = document.getElementById('settingsBody');
      if (el) el.outerHTML = `<div class="err" id="settingsBody">${esc(e.message)}</div>`;
    }
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  render();
})();
