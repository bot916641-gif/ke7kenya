/* Aviator player client — vanilla JS SPA. */
(function () {
  'use strict';

  // ─────────── small router ───────────
  const routes = ['/', '/login', '/register', '/wallet'];
  function go(path) { window.history.pushState({}, '', path); render(); }
  window.addEventListener('popstate', render);

  // ─────────── auth state ───────────
  const TOKEN_KEY = 'aviator_token';
  function getToken() { return localStorage.getItem(TOKEN_KEY); }
  function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
  function clearToken() { localStorage.removeItem(TOKEN_KEY); }

  let me = null;
  let socket = null;
  let lastState = null;
  let currentMultiplier = 1.00;
  let myActiveBet = null; // { amount, autoCashout, betId, cashedAt }

  async function api(path, init) {
    init = init || {};
    init.headers = Object.assign({ 'Content-Type': 'application/json' }, init.headers || {});
    const tok = getToken();
    if (tok) init.headers.Authorization = 'Bearer ' + tok;
    const r = await fetch(path, init);
    let body = null; try { body = await r.json(); } catch {}
    if (!r.ok) throw new Error((body && body.error) || r.statusText || 'Request failed');
    return body;
  }
  async function refreshMe() {
    if (!getToken()) { me = null; return; }
    try { const r = await api('/api/auth/me'); me = r.user; }
    catch { clearToken(); me = null; }
  }

  // ─────────── render ───────────
  const root = document.getElementById('root');
  async function render() {
    await refreshMe();
    const path = window.location.pathname;
    if (path === '/login') return renderLogin();
    if (path === '/register') return renderRegister();
    if (path === '/wallet') {
      if (!me) return go('/login');
      return renderWallet();
    }
    return renderGame();
  }

  // ─────────── auth pages ───────────
  function renderLogin() {
    root.innerHTML = `
      <div class="center-page">
        <form class="card" id="form">
          <h1>Sign in</h1>
          <p class="muted">Welcome back to Aviator.</p>
          <label>Username</label><input name="username" autocomplete="username" required />
          <label>Password</label><input name="password" type="password" autocomplete="current-password" required />
          <div class="err" id="err"></div>
          <button class="primary" type="submit">Sign in</button>
          <p class="muted" style="margin-top:14px;font-size:13px">
            New here? <a href="/register" data-link>Create an account</a>
          </p>
        </form>
      </div>`;
    bindLinks();
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const r = await api('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
        });
        setToken(r.token);
        go('/');
      } catch (err) { document.getElementById('err').textContent = err.message; }
    });
  }

  function renderRegister() {
    root.innerHTML = `
      <div class="center-page">
        <form class="card" id="form">
          <h1>Create account</h1>
          <p class="muted">3-32 lowercase letters, digits or _</p>
          <label>Username</label><input name="username" autocomplete="username" required />
          <label>Password (min 6 chars)</label><input name="password" type="password" autocomplete="new-password" required />
          <label>Confirm password</label><input name="confirm" type="password" autocomplete="new-password" required />
          <div class="err" id="err"></div>
          <button class="primary" type="submit">Create account</button>
          <p class="muted" style="margin-top:14px;font-size:13px">
            Already have one? <a href="/login" data-link>Sign in</a>
          </p>
        </form>
      </div>`;
    bindLinks();
    document.getElementById('form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      if (fd.get('password') !== fd.get('confirm')) {
        document.getElementById('err').textContent = "Passwords don't match"; return;
      }
      try {
        const r = await api('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') }),
        });
        setToken(r.token); go('/');
      } catch (err) { document.getElementById('err').textContent = err.message; }
    });
  }

  // ─────────── wallet ───────────
  async function renderWallet() {
    const status = await api('/api/payments/status').catch(() => ({}));
    let tab = 'deposit';

    function paint() {
      root.innerHTML = `
        <div class="center-page">
          <div class="card wide">
            <div class="row spread">
              <h1>Wallet</h1>
              <a href="/" data-link class="muted">← back to game</a>
            </div>
            <div class="balance-box">
              <div><div class="muted" style="font-size:12px">Signed in as</div>
                <div style="font-weight:700">${escape(me.username)}</div></div>
              <div><div class="muted" style="font-size:12px">Balance</div>
                <div style="font-weight:700;font-size:22px">KES ${Number(me.balance).toFixed(2)}</div></div>
            </div>
            <div class="tabs">
              <button data-tab="deposit"   class="${tab==='deposit'?'active':''}">Deposit</button>
              <button data-tab="withdraw"  class="${tab==='withdraw'?'active':''}">Withdraw</button>
              <button data-tab="history"   class="${tab==='history'?'active':''}">History</button>
            </div>
            <div id="tab-body"></div>
          </div>
        </div>`;
      bindLinks();
      document.querySelectorAll('[data-tab]').forEach((b) => {
        b.onclick = () => { tab = b.dataset.tab; paint(); };
      });
      const body = document.getElementById('tab-body');
      if (tab === 'history') return renderHistory(body);
      renderForm(body, tab);
    }

    function renderForm(body, action) {
      const isDeposit = action === 'deposit';
      body.innerHTML = `
        ${isDeposit && status && !status.mpesaConfigured ? `
          <div class="warn">M-Pesa is not configured yet. Once admin sets the Daraja keys
            (MPESA_CONSUMER_KEY, MPESA_CONSUMER_SECRET, MPESA_SHORTCODE, MPESA_PASSKEY,
            MPESA_CALLBACK_BASE_URL), STK Push will start working here.</div>` : ''}
        ${!isDeposit && status && !status.mpesaB2CConfigured ? `
          <div class="warn">Withdrawals queue as <b>pending</b> until admin sets up M-Pesa B2C
            (MPESA_INITIATOR_NAME + MPESA_INITIATOR_PASSWORD). Admin can release them manually.</div>` : ''}
        <form id="payform">
          <label>Amount (KES)</label>
          <input name="amount" type="number" min="1" value="100" required />
          <label>M-Pesa phone (e.g. 0712345678)</label>
          <input name="phone" placeholder="07XXXXXXXX" required />
          <div class="err" id="err"></div>
          <div class="ok" id="ok"></div>
          <button class="primary" type="submit">${isDeposit ? 'Send STK Push' : 'Withdraw to M-Pesa'}</button>
        </form>`;
      document.getElementById('payform').addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
          const url = isDeposit ? '/api/payments/deposit' : '/api/payments/withdraw';
          const r = await api(url, {
            method: 'POST',
            body: JSON.stringify({ amount: Number(fd.get('amount')), phone: fd.get('phone') }),
          });
          document.getElementById('ok').textContent = r.message || 'Request sent';
          document.getElementById('err').textContent = '';
          await refreshMe(); paint();
        } catch (err) {
          document.getElementById('ok').textContent = '';
          document.getElementById('err').textContent = err.message;
        }
      });
    }

    async function renderHistory(body) {
      body.innerHTML = '<div class="muted" style="margin-top:12px">Loading…</div>';
      try {
        const r = await api('/api/transactions');
        if (!r.transactions.length) {
          body.innerHTML = '<div class="muted" style="margin-top:12px">No transactions yet.</div>'; return;
        }
        body.innerHTML = '<div class="tx-list">' + r.transactions.map((t) => {
          const sign = (t.type === 'withdrawal' || t.type === 'bet' || t.type === 'admin_debit') ? '-' : '+';
          return `
            <div class="tx-row">
              <div><div style="font-weight:700">${escape(t.type)}</div>
                <div class="muted" style="font-size:12px">${new Date(t.created_at).toLocaleString()}</div></div>
              <div class="pill ${escape(t.status)}">${escape(t.status)}</div>
              <div style="font-weight:700">${sign}${Number(t.amount).toFixed(2)}</div>
            </div>`;
        }).join('') + '</div>';
      } catch (e) {
        body.innerHTML = '<div class="err">' + escape(e.message) + '</div>';
      }
    }

    paint();
  }

  // ─────────── game ───────────
  function renderGame() {
    root.innerHTML = `
      <div class="game">
        <header class="topbar">
          <div class="brand">AVI<span class="accent">A</span>TOR</div>
          <div class="top-actions" id="topActions"></div>
        </header>
        <div class="game-body">
          <div class="panel">
            <div class="history-strip" id="history"></div>
            <div class="canvas-wrap">
              <canvas id="canvas"></canvas>
              <div class="multiplier-overlay" id="mult">
                <div class="big">1.00x</div>
                <div class="label">Connecting…</div>
              </div>
            </div>
          </div>
          <div class="panel bet-panel" id="betPanel"></div>
        </div>
      </div>`;
    paintTopActions();
    paintBetPanel();
    initCanvas();
    initSocket();
  }

  function paintTopActions() {
    const el = document.getElementById('topActions');
    if (!el) return;
    if (me) {
      el.innerHTML = `
        <div class="balance">KES <span id="hdrBalance">${Number(me.balance).toFixed(2)}</span></div>
        <a href="/wallet" data-link>Wallet</a>
        <button id="logoutBtn" class="danger">Logout</button>`;
      bindLinks();
      document.getElementById('logoutBtn').onclick = () => { clearToken(); me = null; go('/'); };
    } else {
      el.innerHTML = `
        <a href="/login" data-link>Sign in</a>
        <a href="/register" data-link>Sign up</a>`;
      bindLinks();
    }
  }
  function updateHeaderBalance() {
    const el = document.getElementById('hdrBalance');
    if (el && me) el.textContent = Number(me.balance).toFixed(2);
  }

  function paintBetPanel() {
    const el = document.getElementById('betPanel');
    if (!el) return;
    el.innerHTML = `
      <div>
        <label class="muted" style="font-size:12px">Bet amount (KES)</label>
        <div class="input-group" style="margin-top:6px">
          <div class="stepper">
            <button id="dec">−</button>
          </div>
          <input id="amount" type="number" value="50" min="1" />
          <div class="stepper">
            <button id="inc">+</button>
          </div>
        </div>
        <div class="quick-amounts" style="margin-top:8px">
          <button data-amt="50">50</button><button data-amt="100">100</button>
          <button data-amt="500">500</button><button data-amt="1000">1000</button>
        </div>
      </div>
      <div>
        <label class="muted" style="font-size:12px">Auto cashout (multiplier)</label>
        <input id="autoCashout" type="number" step="0.1" min="1.01" placeholder="(optional, e.g. 2.0)" />
      </div>
      <button id="actionBtn" class="bet-button bet" disabled>Connecting…</button>
      <div class="err" id="betErr"></div>
      <div>
        <div class="muted" style="font-size:12px;margin-bottom:6px">Live bets</div>
        <div class="live-bets" id="liveBets"></div>
      </div>`;
    document.getElementById('inc').onclick = () => stepAmount(+10);
    document.getElementById('dec').onclick = () => stepAmount(-10);
    document.querySelectorAll('[data-amt]').forEach((b) => {
      b.onclick = () => { document.getElementById('amount').value = b.dataset.amt; };
    });
    document.getElementById('actionBtn').onclick = onActionClick;
    syncBetPanel();
  }
  function stepAmount(d) {
    const i = document.getElementById('amount');
    const v = Math.max(1, (Number(i.value) || 0) + d); i.value = v;
  }

  function syncBetPanel() {
    if (!lastState) return;
    const btn = document.getElementById('actionBtn');
    const liveBetsEl = document.getElementById('liveBets');
    if (!btn) return;
    const status = lastState.round && lastState.round.status;
    if (status === 'betting') {
      const remaining = Math.max(0, Math.ceil((lastState.bettingClosesAt - Date.now()) / 1000));
      btn.className = 'bet-button bet';
      btn.disabled = !me || !!myActiveBet;
      btn.textContent = myActiveBet
        ? 'Bet placed for next round'
        : (me ? `Place bet (${remaining}s)` : 'Sign in to play');
    } else if (status === 'playing') {
      if (myActiveBet && !myActiveBet.cashedAt) {
        btn.className = 'bet-button cashout'; btn.disabled = false;
        const payout = (myActiveBet.amount * currentMultiplier).toFixed(2);
        btn.textContent = `Cash out ${currentMultiplier.toFixed(2)}x (${payout})`;
      } else {
        btn.className = 'bet-button bet'; btn.disabled = true;
        btn.textContent = myActiveBet ? `Cashed at ${myActiveBet.cashedAt.toFixed(2)}x ✓` : 'Round in progress';
      }
    } else {
      btn.className = 'bet-button bet'; btn.disabled = true;
      btn.textContent = 'Round ended';
    }
    if (liveBetsEl) {
      if (!lastState.liveBets.length) {
        liveBetsEl.innerHTML = '<div class="muted" style="font-size:12px">No bets yet.</div>';
      } else {
        liveBetsEl.innerHTML = lastState.liveBets.map((b) => `
          <div class="row">
            <div class="username">${escape(b.username)}</div>
            <div>${Number(b.amount).toFixed(0)}</div>
            <div class="${b.cashedAt ? 'cashed' : 'pending'}">
              ${b.cashedAt ? b.cashedAt.toFixed(2) + 'x' : '—'}
            </div>
          </div>`).join('');
      }
    }
    // History strip
    const hist = document.getElementById('history');
    if (hist) {
      hist.innerHTML = (lastState.history || []).slice(-15).reverse().map((r) => {
        const m = Number(r.crash);
        return `<div class="h ${m >= 2 ? 'high' : 'low'}">${m.toFixed(2)}x</div>`;
      }).join('');
    }
  }

  function onActionClick() {
    const errEl = document.getElementById('betErr');
    if (!me) return go('/login');
    const status = lastState && lastState.round && lastState.round.status;
    if (status === 'playing' && myActiveBet && !myActiveBet.cashedAt) {
      socket.emit('cashout', {}, (resp) => {
        if (!resp || !resp.ok) { errEl.textContent = (resp && resp.error) || 'Cashout failed'; return; }
        if (myActiveBet) myActiveBet.cashedAt = resp.multiplier;
        if (resp.balance != null) { me.balance = resp.balance; updateHeaderBalance(); }
        syncBetPanel();
      });
      return;
    }
    if (status === 'betting' && !myActiveBet) {
      const amount = Number(document.getElementById('amount').value);
      const auto = Number(document.getElementById('autoCashout').value) || null;
      socket.emit('placeBet', { amount, autoCashout: auto }, (resp) => {
        if (!resp || !resp.ok) { errEl.textContent = (resp && resp.error) || 'Bet failed'; return; }
        errEl.textContent = '';
        myActiveBet = { amount, autoCashout: auto, betId: resp.betId, cashedAt: null };
        if (resp.balance != null) { me.balance = resp.balance; updateHeaderBalance(); }
        syncBetPanel();
      });
    }
  }

  // ─────────── canvas crash animation ───────────
  let canvas, ctx, animFrame;
  function initCanvas() {
    canvas = document.getElementById('canvas');
    if (!canvas) return;
    function resize() {
      const rect = canvas.getBoundingClientRect();
      canvas.width = Math.floor(rect.width * devicePixelRatio);
      canvas.height = Math.floor(rect.height * devicePixelRatio);
      ctx = canvas.getContext('2d'); ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }
    resize(); window.addEventListener('resize', resize);
    cancelAnimationFrame(animFrame);
    function loop() {
      drawCanvas();
      animFrame = requestAnimationFrame(loop);
    }
    loop();
  }
  function drawCanvas() {
    if (!ctx || !canvas) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    // Grid background.
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 1;
    for (let x = 0; x <= w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y <= h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const status = lastState && lastState.round && lastState.round.status;
    const overlay = document.getElementById('mult');
    if (!status) {
      if (overlay) {
        overlay.className = 'multiplier-overlay';
        overlay.innerHTML = `<div class="big">1.00x</div><div class="label">Connecting…</div>`;
      }
      return;
    }
    if (status === 'betting') {
      const remaining = Math.max(0, Math.ceil((lastState.bettingClosesAt - Date.now()) / 1000));
      if (overlay) {
        overlay.className = 'multiplier-overlay betting';
        overlay.innerHTML = `<div class="big">${remaining}s</div><div class="label">Place your bet now</div>`;
      }
      return;
    }
    if (status === 'playing') {
      // Curve: x = time, y = e^(t * factor) but fitted to the canvas.
      const startedAt = lastState.round.startedAt || Date.now();
      const tNow = (Date.now() - startedAt) / 1000;
      const m = Math.max(1, Math.pow(1.07, tNow));
      currentMultiplier = m;
      const maxT = Math.max(2, tNow);
      const maxM = Math.max(1.5, m * 1.05);
      const grad = ctx.createLinearGradient(0, h, w, 0);
      grad.addColorStop(0, '#a23bff'); grad.addColorStop(1, '#ff6e6e');
      ctx.strokeStyle = grad; ctx.lineWidth = 4; ctx.beginPath();
      const N = 80;
      for (let i = 0; i <= N; i++) {
        const t = (i / N) * tNow;
        const v = Math.pow(1.07, t);
        const px = (t / maxT) * (w - 20) + 10;
        const py = h - ((v - 1) / (maxM - 1)) * (h - 20) - 10;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.stroke();
      // Plane glyph at end.
      const lastX = w - 10, lastY = h - ((m - 1) / (maxM - 1)) * (h - 20) - 10;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(lastX - 22, lastY - 8);
      ctx.lineTo(lastX - 22, lastY + 8);
      ctx.closePath(); ctx.fill();
      if (overlay) {
        overlay.className = 'multiplier-overlay';
        overlay.innerHTML = `<div class="big">${m.toFixed(2)}x</div><div class="label">Plane is flying…</div>`;
      }
      // Auto-update the cashout button's payout figure
      syncBetPanel();
      return;
    }
    if (status === 'crashed') {
      if (overlay) {
        overlay.className = 'multiplier-overlay crashed';
        overlay.innerHTML = `<div class="big">${Number(lastState.round.crash).toFixed(2)}x</div>
                             <div class="label">FLEW AWAY</div>`;
      }
    }
  }

  // ─────────── socket ───────────
  function initSocket() {
    if (socket) socket.disconnect();
    socket = io({ auth: { token: getToken() || '' } });
    socket.on('state', (s) => {
      lastState = s;
      const mine = me ? s.liveBets.find((b) => b.userId === me.id) : null;
      // Reset our active bet when a new round starts and we're not in liveBets.
      if (s.round && s.round.status === 'betting' && !mine) myActiveBet = null;
      // Restore active bet on reconnect / page refresh during a live round.
      if (s.round && s.round.status === 'playing' && mine && !myActiveBet) {
        myActiveBet = {
          amount: Number(mine.amount),
          autoCashout: mine.autoCashout ? Number(mine.autoCashout) : null,
          betId: null,
          cashedAt: mine.cashedAt ? Number(mine.cashedAt) : null,
        };
      }
      // Mirror cash-out from server-side state into local bet.
      if (mine && mine.cashedAt && myActiveBet) myActiveBet.cashedAt = Number(mine.cashedAt);
      syncBetPanel();
    });
    socket.on('tick', (d) => { currentMultiplier = d.multiplier; syncBetPanel(); });
    socket.on('cashout', (d) => {
      if (me && d.userId === me.id) {
        if (myActiveBet) myActiveBet.cashedAt = Number(d.multiplier);
        refreshMe().then(() => { paintTopActions(); syncBetPanel(); }).catch(() => {});
      }
    });
    socket.on('crash', () => {});
  }

  // ─────────── helpers ───────────
  function escape(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function bindLinks() {
    document.querySelectorAll('a[data-link]').forEach((a) => {
      a.onclick = (e) => { e.preventDefault(); go(a.getAttribute('href')); };
    });
  }

  render();
})();
