(function () {
  const cfg = window.SWING_TRADE_CONFIG || {};
  const STORAGE_KEY = "swingTradePaperPortfolio_v1";
  const STARTING_CASH = 100000;

  let portfolio = loadPortfolio();
  const livePrices = {}; // ticker -> { price, asOf, fetchedAt }
  let pushSubscription = null;
  let modalPrefill = null;

  // ---------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------

  function loadPortfolio() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to default
    }
    return { cash: STARTING_CASH, startingCash: STARTING_CASH, positions: [], history: [] };
  }

  function savePortfolio() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(portfolio));
  }

  // ---------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------

  const moneyFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  function fmtMoney(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return moneyFmt.format(n);
  }
  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  }
  function fmtShares(n) {
    return Number.isInteger(n) ? String(n) : n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ---------------------------------------------------------------------
  // Backend calls
  // ---------------------------------------------------------------------

  async function apiPost(path, body) {
    if (!cfg.API_URL) throw new Error("Not wired up to a backend yet — set API_URL in config.js.");
    const res = await fetch(`${cfg.API_URL}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.APP_KEY ? { "X-App-Key": cfg.APP_KEY } : {}),
      },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    return data;
  }

  async function getQuote(ticker) {
    const q = await apiPost("/quote", { ticker });
    const price = parseFloat(q.price);
    if (Number.isNaN(price)) throw new Error("Couldn't read a live price for that ticker.");
    livePrices[ticker] = { price, asOf: q.asOf, fetchedAt: Date.now() };
    return livePrices[ticker];
  }

  // ---------------------------------------------------------------------
  // Portfolio math
  // ---------------------------------------------------------------------

  function positionValue(pos) {
    const live = livePrices[pos.ticker];
    return live ? pos.shares * live.price : null;
  }

  function unrealizedPnl(pos) {
    const live = livePrices[pos.ticker];
    if (!live) return null;
    return (live.price - pos.entryPrice) * pos.shares;
  }

  function portfolioStats() {
    let positionsValue = 0;
    let hasAllPrices = true;
    for (const pos of portfolio.positions) {
      const v = positionValue(pos);
      if (v == null) hasAllPrices = false;
      else positionsValue += v;
    }
    const realizedPnl = portfolio.history.reduce((sum, t) => sum + t.pnl, 0);
    const unrealized = portfolio.positions.reduce((sum, pos) => {
      const u = unrealizedPnl(pos);
      return u == null ? sum : sum + u;
    }, 0);
    const equity = portfolio.cash + positionsValue;
    const totalPnl = equity - portfolio.startingCash;
    const wins = portfolio.history.filter((t) => t.pnl > 0).length;
    const winRate = portfolio.history.length ? (wins / portfolio.history.length) * 100 : null;
    return { positionsValue, hasAllPrices, realizedPnl, unrealized, equity, totalPnl, winRate };
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function render() {
    renderSummary();
    renderPositions();
    renderHistory();
    renderNotifyStatus();
  }

  function renderSummary() {
    const s = portfolioStats();
    const pnlClass = s.totalPnl > 0 ? "pnl-pos" : s.totalPnl < 0 ? "pnl-neg" : "";
    const totalPnlPct = (s.totalPnl / portfolio.startingCash) * 100;
    document.getElementById("portfolioSummary").innerHTML = `
      <div class="stats-strip">
        <div class="stat"><div class="s-label">Cash</div><div class="s-value">${fmtMoney(portfolio.cash)}</div></div>
        <div class="stat"><div class="s-label">Positions value</div><div class="s-value">${s.hasAllPrices || portfolio.positions.length === 0 ? fmtMoney(s.positionsValue) : fmtMoney(s.positionsValue) + "*"}</div></div>
        <div class="stat"><div class="s-label">Equity</div><div class="s-value">${fmtMoney(s.equity)}</div></div>
        <div class="stat"><div class="s-label">Total P&amp;L</div><div class="s-value ${pnlClass}">${fmtMoney(s.totalPnl)} (${fmtPct(totalPnlPct)})</div></div>
        <div class="stat"><div class="s-label">Win rate</div><div class="s-value">${s.winRate == null ? "—" : s.winRate.toFixed(0) + "%"}</div></div>
        <div class="stat"><div class="s-label">Closed trades</div><div class="s-value">${portfolio.history.length}</div></div>
      </div>
      ${!s.hasAllPrices && portfolio.positions.length ? `<div class="chart-caption">* some prices not refreshed yet — tap "Refresh prices"</div>` : ""}
    `;
  }

  function renderPositions() {
    const $list = document.getElementById("positionsList");
    if (portfolio.positions.length === 0) {
      $list.innerHTML = `<div class="empty-note">No open positions. Start one below.</div>`;
      return;
    }
    $list.innerHTML = portfolio.positions.map((pos) => {
      const live = livePrices[pos.ticker];
      const pnl = unrealizedPnl(pos);
      const pnlPct = pnl == null ? null : (pnl / (pos.entryPrice * pos.shares)) * 100;
      const pnlClass = pnl > 0 ? "pnl-pos" : pnl < 0 ? "pnl-neg" : "";
      return `
        <div class="position-row" data-id="${esc(pos.id)}">
          <div class="position-main">
            <div>
              <div class="position-ticker">${esc(pos.ticker)} ${pos.watchId ? '<span class="bell" title="Push alert active">🔔</span>' : ""}</div>
              <div class="position-sub">${fmtShares(pos.shares)} sh @ ${fmtMoney(pos.entryPrice)}${pos.stop != null ? ` · stop ${fmtMoney(pos.stop)}` : ""}${pos.target != null ? ` · target ${fmtMoney(pos.target)}` : ""}</div>
            </div>
            <div class="position-price">
              <div>${live ? fmtMoney(live.price) : "—"}</div>
              <div class="${pnlClass}">${pnl == null ? "tap refresh" : `${fmtMoney(pnl)} (${fmtPct(pnlPct)})`}</div>
            </div>
          </div>
          <div class="position-actions">
            <button class="mini-btn refresh-pos-btn" data-ticker="${esc(pos.ticker)}" type="button">Refresh</button>
            <button class="mini-btn close-pos-btn" data-id="${esc(pos.id)}" type="button">Close</button>
          </div>
        </div>
      `;
    }).join("");

    $list.querySelectorAll(".refresh-pos-btn").forEach((btn) => {
      btn.addEventListener("click", () => refreshPrice(btn.dataset.ticker));
    });
    $list.querySelectorAll(".close-pos-btn").forEach((btn) => {
      btn.addEventListener("click", () => closePosition(btn.dataset.id, "manual"));
    });
  }

  function renderHistory() {
    const $list = document.getElementById("historyList");
    if (portfolio.history.length === 0) {
      $list.innerHTML = `<div class="empty-note">No closed trades yet.</div>`;
      return;
    }
    const reasonLabel = { manual: "Manual close", stop: "Stop hit", target: "Target hit" };
    $list.innerHTML = [...portfolio.history].reverse().map((t) => {
      const pnlClass = t.pnl > 0 ? "pnl-pos" : t.pnl < 0 ? "pnl-neg" : "";
      return `
        <div class="history-row">
          <div>
            <div class="position-ticker">${esc(t.ticker)}</div>
            <div class="position-sub">${fmtShares(t.shares)} sh · ${fmtMoney(t.entryPrice)} → ${fmtMoney(t.exitPrice)} · ${reasonLabel[t.reason] || t.reason}</div>
          </div>
          <div class="${pnlClass}">${fmtMoney(t.pnl)} (${fmtPct(t.pnlPct)})</div>
        </div>
      `;
    }).join("");
  }

  function renderNotifyStatus() {
    const $status = document.getElementById("notifyStatus");
    const $btn = document.getElementById("enableNotifyBtn");
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) {
      $status.textContent = "Not supported on this browser.";
      $btn.disabled = true;
      return;
    }
    if (Notification.permission === "denied") {
      $status.textContent = "Blocked — allow notifications for this site in your browser settings.";
      return;
    }
    if (pushSubscription) {
      $status.textContent = "Enabled.";
      $btn.textContent = "Notifications enabled";
      $btn.disabled = true;
    } else {
      $status.textContent = "Not enabled.";
      $btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Trades
  // ---------------------------------------------------------------------

  async function refreshPrice(ticker) {
    try {
      await getQuote(ticker);
    } catch (err) {
      alert(`Couldn't refresh ${ticker}: ${err.message}`);
    }
    render();
  }

  async function refreshAllPrices() {
    const tickers = [...new Set(portfolio.positions.map((p) => p.ticker))];
    for (const ticker of tickers) {
      try {
        await getQuote(ticker);
      } catch {
        break; // likely rate-limited — stop spending the daily budget
      }
    }
    render();
  }

  async function closePosition(id, reason, knownPrice) {
    const pos = portfolio.positions.find((p) => p.id === id);
    if (!pos) return;

    let exitPrice = knownPrice;
    if (exitPrice == null) {
      try {
        exitPrice = (await getQuote(pos.ticker)).price;
      } catch (err) {
        alert(`Couldn't get a live price to close ${pos.ticker}: ${err.message}`);
        return;
      }
    }

    const pnl = (exitPrice - pos.entryPrice) * pos.shares;
    const pnlPct = (pnl / (pos.entryPrice * pos.shares)) * 100;

    portfolio.cash += pos.shares * exitPrice;
    portfolio.positions = portfolio.positions.filter((p) => p.id !== id);
    portfolio.history.push({
      id: pos.id, ticker: pos.ticker, shares: pos.shares, entryPrice: pos.entryPrice,
      entryDate: pos.entryDate, exitPrice, exitDate: new Date().toISOString(),
      pnl, pnlPct, reason,
    });
    savePortfolio();
    render();

    if (pos.watchId) {
      apiPost("/unwatch", { watchId: pos.watchId }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------------
  // New trade modal
  // ---------------------------------------------------------------------

  const $overlay = document.getElementById("tradeModalOverlay");
  const $tradeTicker = document.getElementById("tradeTicker");
  const $tradeAmountMode = document.getElementById("tradeAmountMode");
  const $tradeAmountValue = document.getElementById("tradeAmountValue");
  const $tradeStop = document.getElementById("tradeStop");
  const $tradeTarget = document.getElementById("tradeTarget");
  const $tradeModalStatus = document.getElementById("tradeModalStatus");
  const $tradeSubmitBtn = document.getElementById("tradeSubmitBtn");

  function openNewTradeModal(prefill) {
    modalPrefill = prefill || null;
    $tradeTicker.value = prefill?.ticker || "";
    $tradeAmountMode.value = "dollars";
    $tradeAmountValue.value = "";
    $tradeStop.value = prefill?.stop != null && !Number.isNaN(prefill.stop) ? prefill.stop : "";
    $tradeTarget.value = prefill?.target != null && !Number.isNaN(prefill.target) ? prefill.target : "";
    $tradeModalStatus.textContent = "";
    $overlay.hidden = false;
  }

  function closeModal() {
    $overlay.hidden = true;
  }

  async function submitTrade() {
    const ticker = $tradeTicker.value.trim().toUpperCase();
    const mode = $tradeAmountMode.value;
    const amount = parseFloat($tradeAmountValue.value);
    const stop = $tradeStop.value === "" ? null : parseFloat($tradeStop.value);
    const target = $tradeTarget.value === "" ? null : parseFloat($tradeTarget.value);

    if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
      $tradeModalStatus.textContent = "Enter a valid ticker.";
      return;
    }
    if (!amount || amount <= 0) {
      $tradeModalStatus.textContent = "Enter an amount greater than zero.";
      return;
    }

    $tradeSubmitBtn.disabled = true;
    $tradeModalStatus.textContent = "Getting live price…";

    try {
      const quote = await getQuote(ticker);
      const shares = mode === "shares" ? amount : amount / quote.price;
      const cost = shares * quote.price;

      if (cost > portfolio.cash + 0.005) {
        $tradeModalStatus.textContent = `Not enough virtual cash — this costs ${fmtMoney(cost)}, you have ${fmtMoney(portfolio.cash)}.`;
        $tradeSubmitBtn.disabled = false;
        return;
      }

      const position = {
        id: crypto.randomUUID(),
        ticker,
        shares,
        entryPrice: quote.price,
        entryDate: new Date().toISOString(),
        stop: Number.isNaN(stop) ? null : stop,
        target: Number.isNaN(target) ? null : target,
        watchId: null,
      };

      if (pushSubscription && (position.stop != null || position.target != null)) {
        try {
          const res = await apiPost("/watch", {
            ticker, stop: position.stop, target: position.target,
            subscription: pushSubscription.toJSON(),
          });
          position.watchId = res.watchId;
        } catch {
          // Notifications just won't fire for this position — trade still goes through.
        }
      }

      portfolio.cash -= cost;
      portfolio.positions.push(position);
      savePortfolio();
      render();
      closeModal();
    } catch (err) {
      $tradeModalStatus.textContent = err.message;
    } finally {
      $tradeSubmitBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Push notifications
  // ---------------------------------------------------------------------

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  async function loadExistingSubscription() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    try {
      const reg = await navigator.serviceWorker.ready;
      pushSubscription = await reg.pushManager.getSubscription();
    } catch {
      pushSubscription = null;
    }
    renderNotifyStatus();
  }

  async function enableNotifications() {
    const $btn = document.getElementById("enableNotifyBtn");
    const $status = document.getElementById("notifyStatus");
    if (!cfg.VAPID_PUBLIC_KEY) {
      $status.textContent = "Server isn't configured for push yet (missing VAPID_PUBLIC_KEY in config.js).";
      return;
    }
    $btn.disabled = true;
    $status.textContent = "Requesting permission…";
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        $status.textContent = "Permission not granted.";
        $btn.disabled = false;
        return;
      }
      const reg = await navigator.serviceWorker.ready;
      pushSubscription = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(cfg.VAPID_PUBLIC_KEY),
      });
      $status.textContent = "Sending a test notification…";
      try {
        const result = await apiPost("/test-push", { subscription: pushSubscription.toJSON() });
        $status.textContent = result.ok ? "Enabled — test notification sent." : `Enabled, but the test push failed (status ${result.status}). Notifications may not work.`;
      } catch (err) {
        $status.textContent = `Enabled, but the test push failed: ${err.message}`;
      }
    } catch (err) {
      $status.textContent = `Couldn't enable: ${err.message}`;
      $btn.disabled = false;
      return;
    }
    renderNotifyStatus();
  }

  // ---------------------------------------------------------------------
  // Trigger handling (push notification clicked / app reopened)
  // ---------------------------------------------------------------------

  async function handleTrigger(ticker) {
    const positions = portfolio.positions.filter((p) => p.ticker === ticker && (p.stop != null || p.target != null));
    if (positions.length === 0) return;

    let quote;
    try {
      quote = await getQuote(ticker);
    } catch {
      return;
    }

    for (const pos of positions) {
      const hitTarget = pos.target != null && quote.price >= pos.target;
      const hitStop = pos.stop != null && quote.price <= pos.stop;
      if (!hitTarget && !hitStop) continue;

      const reason = hitTarget ? "target" : "stop";
      const label = hitTarget ? "hit your target" : "hit your stop";
      const ok = confirm(`${ticker} ${label} — now at ${fmtMoney(quote.price)}.\n\nClose this paper position (${fmtShares(pos.shares)} sh @ ${fmtMoney(pos.entryPrice)})?`);
      if (ok) closePosition(pos.id, reason, quote.price);
    }
    render();
  }

  function checkUrlTrigger() {
    const params = new URLSearchParams(window.location.search);
    const ticker = params.get("trigger");
    if (ticker) {
      handleTrigger(ticker.toUpperCase());
      params.delete("trigger");
      const newUrl = window.location.pathname + (params.toString() ? `?${params}` : "");
      window.history.replaceState({}, "", newUrl);
    }
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data && event.data.type === "watch-trigger-click" && event.data.data?.ticker) {
        handleTrigger(event.data.data.ticker);
      }
    });
  }

  // ---------------------------------------------------------------------
  // Wire up static controls
  // ---------------------------------------------------------------------

  document.getElementById("newTradeBtn").addEventListener("click", () => openNewTradeModal(null));
  document.getElementById("tradeModalClose").addEventListener("click", closeModal);
  document.getElementById("tradeSubmitBtn").addEventListener("click", submitTrade);
  document.getElementById("refreshAllBtn").addEventListener("click", refreshAllPrices);
  document.getElementById("enableNotifyBtn").addEventListener("click", enableNotifications);
  document.getElementById("resetPortfolioBtn").addEventListener("click", () => {
    if (!confirm("Reset your paper portfolio? This clears all positions and history and can't be undone.")) return;
    portfolio = { cash: STARTING_CASH, startingCash: STARTING_CASH, positions: [], history: [] };
    savePortfolio();
    render();
  });
  $overlay.addEventListener("click", (e) => {
    if (e.target === $overlay) closeModal();
  });

  loadExistingSubscription();
  checkUrlTrigger();
  render();

  window.PaperTrading = {
    openNewTradeModal,
    onShow: render,
  };
})();
