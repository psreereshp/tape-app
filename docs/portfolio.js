(function () {
  const cfg = window.SWING_TRADE_CONFIG || {};
  const STORAGE_KEY = "tapeRealHoldings_v1";
  const WATCHLIST_STORAGE_KEY = "tapeWatchlist_v1";

  let holdings = loadHoldings();
  let watchlist = loadWatchlist();
  const livePrices = {}; // ticker -> { price, changePercent, asOf, fetchedAt }
  let editingId = null;

  // ---------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------

  function loadHoldings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to default
    }
    return [];
  }

  function saveHoldings() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(holdings));
  }

  function loadWatchlist() {
    try {
      const raw = localStorage.getItem(WATCHLIST_STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch {
      // fall through to default
    }
    return [];
  }

  function saveWatchlist() {
    localStorage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(watchlist));
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

  async function getQuote(ticker) {
    if (!cfg.API_URL) throw new Error("Not wired up to a backend yet — set API_URL in config.js.");
    const res = await fetch(`${cfg.API_URL}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.APP_KEY ? { "X-App-Key": cfg.APP_KEY } : {}),
      },
      body: JSON.stringify({ ticker }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
    const price = parseFloat(data.price);
    if (Number.isNaN(price)) throw new Error("Couldn't read a live price for that ticker.");
    const changePercent = data.changePercent != null ? parseFloat(data.changePercent) : null;
    livePrices[ticker] = { price, changePercent: Number.isNaN(changePercent) ? null : changePercent, asOf: data.asOf, fetchedAt: Date.now() };
    return livePrices[ticker];
  }

  // ---------------------------------------------------------------------
  // Portfolio math
  // ---------------------------------------------------------------------

  function holdingValue(h) {
    const live = livePrices[h.ticker];
    return live ? h.shares * live.price : null;
  }

  function unrealizedPnl(h) {
    const live = livePrices[h.ticker];
    if (!live) return null;
    return (live.price - h.costBasis) * h.shares;
  }

  // Derives today's $ move per share from price + day change%, since the quote
  // endpoint only returns the percentage (same figure Markets/Analyze show).
  function dayChangeDollar(h) {
    const live = livePrices[h.ticker];
    if (!live || live.changePercent == null) return null;
    const prevClose = live.price / (1 + live.changePercent / 100);
    return (live.price - prevClose) * h.shares;
  }

  function portfolioStats() {
    let value = 0;
    let cost = 0;
    let dayChange = 0;
    let hasAllPrices = true;
    let hasAnyDayChange = false;
    for (const h of holdings) {
      cost += h.shares * h.costBasis;
      const v = holdingValue(h);
      if (v == null) hasAllPrices = false;
      else value += v;
      const dc = dayChangeDollar(h);
      if (dc != null) {
        dayChange += dc;
        hasAnyDayChange = true;
      }
    }
    const pnl = value - cost;
    const pnlPct = cost ? (pnl / cost) * 100 : null;
    const prevValue = value - dayChange;
    const dayChangePct = hasAnyDayChange && prevValue ? (dayChange / prevValue) * 100 : null;
    return { value, cost, pnl, pnlPct, dayChange: hasAnyDayChange ? dayChange : null, dayChangePct, hasAllPrices };
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------

  function render() {
    renderSummary();
    renderHoldings();
    renderWatchlist();
  }

  function renderSummary() {
    const $el = document.getElementById("holdingsSummary");
    if (holdings.length === 0) {
      $el.innerHTML = `<div class="empty-note">No holdings yet. Add one below.</div>`;
      return;
    }
    const s = portfolioStats();
    const pnlClass = s.pnl > 0 ? "pnl-pos" : s.pnl < 0 ? "pnl-neg" : "";
    const dayClass = s.dayChange > 0 ? "pnl-pos" : s.dayChange < 0 ? "pnl-neg" : "";
    $el.innerHTML = `
      <div class="stats-strip">
        <div class="stat"><div class="s-label">Market value</div><div class="s-value">${s.hasAllPrices ? fmtMoney(s.value) : fmtMoney(s.value) + "*"}</div></div>
        <div class="stat"><div class="s-label">Day change</div><div class="s-value ${dayClass}">${s.dayChange == null ? "—" : `${fmtMoney(s.dayChange)} (${fmtPct(s.dayChangePct)})`}</div></div>
        <div class="stat"><div class="s-label">Cost basis</div><div class="s-value">${fmtMoney(s.cost)}</div></div>
        <div class="stat"><div class="s-label">Total P&amp;L</div><div class="s-value ${pnlClass}">${fmtMoney(s.pnl)} (${fmtPct(s.pnlPct)})</div></div>
        <div class="stat"><div class="s-label">Holdings</div><div class="s-value">${holdings.length}</div></div>
      </div>
      ${!s.hasAllPrices ? `<div class="chart-caption">* some prices not refreshed yet — tap "Refresh prices"</div>` : ""}
    `;
  }

  function renderHoldings() {
    const $list = document.getElementById("holdingsList");
    if (holdings.length === 0) {
      $list.innerHTML = `<div class="empty-note">No holdings yet. Add one below.</div>`;
      return;
    }
    $list.innerHTML = holdings.map((h) => {
      const live = livePrices[h.ticker];
      const pnl = unrealizedPnl(h);
      const pnlPct = pnl == null ? null : (pnl / (h.costBasis * h.shares)) * 100;
      const pnlClass = pnl > 0 ? "pnl-pos" : pnl < 0 ? "pnl-neg" : "";
      const dayPct = live ? live.changePercent : null;
      const dayClass = dayPct > 0 ? "pnl-pos" : dayPct < 0 ? "pnl-neg" : "";
      return `
        <div class="position-row" data-id="${esc(h.id)}">
          <div class="position-main">
            <div>
              <div class="position-ticker">${esc(h.ticker)}</div>
              <div class="position-sub">${fmtShares(h.shares)} sh @ ${fmtMoney(h.costBasis)}</div>
            </div>
            <div class="position-price">
              <div>${live ? fmtMoney(live.price) : "—"}</div>
              <div class="${dayClass}">${dayPct == null ? "" : `Day ${fmtPct(dayPct)}`}</div>
              <div class="${pnlClass}">${pnl == null ? "tap refresh" : `${fmtMoney(pnl)} (${fmtPct(pnlPct)})`}</div>
            </div>
          </div>
          <div class="position-actions">
            <button class="mini-btn refresh-holding-btn" data-ticker="${esc(h.ticker)}" type="button">Refresh</button>
            <button class="mini-btn edit-holding-btn" data-id="${esc(h.id)}" type="button">Edit</button>
            <button class="mini-btn remove-holding-btn" data-id="${esc(h.id)}" type="button">Remove</button>
          </div>
        </div>
      `;
    }).join("");

    $list.querySelectorAll(".refresh-holding-btn").forEach((btn) => {
      btn.addEventListener("click", () => refreshPrice(btn.dataset.ticker));
    });
    $list.querySelectorAll(".edit-holding-btn").forEach((btn) => {
      btn.addEventListener("click", () => openHoldingModal(btn.dataset.id));
    });
    $list.querySelectorAll(".remove-holding-btn").forEach((btn) => {
      btn.addEventListener("click", () => removeHolding(btn.dataset.id));
    });
  }

  function renderWatchlist() {
    const $list = document.getElementById("watchlistList");
    if (watchlist.length === 0) {
      $list.innerHTML = `<div class="empty-note">Nothing on your watchlist yet. Add a ticker below.</div>`;
      return;
    }
    $list.innerHTML = watchlist.map((w) => {
      const live = livePrices[w.ticker];
      const dayPct = live ? live.changePercent : null;
      const dayClass = dayPct > 0 ? "pnl-pos" : dayPct < 0 ? "pnl-neg" : "";
      return `
        <div class="position-row" data-id="${esc(w.id)}">
          <div class="position-main">
            <div>
              <div class="position-ticker">${esc(w.ticker)}</div>
            </div>
            <div class="position-price">
              <div>${live ? fmtMoney(live.price) : "—"}</div>
              <div class="${dayClass}">${dayPct == null ? "tap refresh" : fmtPct(dayPct)}</div>
            </div>
          </div>
          <div class="position-actions">
            <button class="mini-btn refresh-watch-btn" data-ticker="${esc(w.ticker)}" type="button">Refresh</button>
            <button class="mini-btn remove-watch-btn" data-id="${esc(w.id)}" type="button">Remove</button>
          </div>
        </div>
      `;
    }).join("");

    $list.querySelectorAll(".refresh-watch-btn").forEach((btn) => {
      btn.addEventListener("click", () => refreshPrice(btn.dataset.ticker));
    });
    $list.querySelectorAll(".remove-watch-btn").forEach((btn) => {
      btn.addEventListener("click", () => removeWatch(btn.dataset.id));
    });
  }

  // ---------------------------------------------------------------------
  // Actions
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
    const tickers = [...new Set(holdings.map((h) => h.ticker))];
    for (const ticker of tickers) {
      try {
        await getQuote(ticker);
      } catch {
        break; // likely rate-limited — stop spending the daily budget
      }
    }
    render();
  }

  function removeHolding(id) {
    const h = holdings.find((x) => x.id === id);
    if (!h) return;
    if (!confirm(`Remove ${h.ticker} (${fmtShares(h.shares)} sh) from your holdings?`)) return;
    holdings = holdings.filter((x) => x.id !== id);
    saveHoldings();
    render();
  }

  async function refreshAllWatchlistPrices() {
    const tickers = [...new Set(watchlist.map((w) => w.ticker))];
    for (const ticker of tickers) {
      try {
        await getQuote(ticker);
      } catch {
        break; // likely rate-limited — stop spending the daily budget
      }
    }
    render();
  }

  function removeWatch(id) {
    const w = watchlist.find((x) => x.id === id);
    if (!w) return;
    watchlist = watchlist.filter((x) => x.id !== id);
    saveWatchlist();
    render();
  }

  // ---------------------------------------------------------------------
  // Add / edit modal
  // ---------------------------------------------------------------------

  const $overlay = document.getElementById("holdingModalOverlay");
  const $title = document.getElementById("holdingModalTitle");
  const $ticker = document.getElementById("holdingTicker");
  const $shares = document.getElementById("holdingShares");
  const $costMode = document.getElementById("holdingCostMode");
  const $costValue = document.getElementById("holdingCostValue");
  const $status = document.getElementById("holdingModalStatus");
  const $submitBtn = document.getElementById("holdingSubmitBtn");

  function openHoldingModal(id) {
    editingId = id || null;
    const h = editingId ? holdings.find((x) => x.id === editingId) : null;
    $title.textContent = h ? `Edit ${h.ticker}` : "Add holding";
    $ticker.value = h ? h.ticker : "";
    $shares.value = h ? h.shares : "";
    $costMode.value = "perShare";
    $costValue.value = h ? h.costBasis : "";
    $status.textContent = "";
    $overlay.hidden = false;
  }

  function closeModal() {
    $overlay.hidden = true;
  }

  async function submitHolding() {
    const ticker = $ticker.value.trim().toUpperCase();
    const shares = parseFloat($shares.value);
    const costInput = parseFloat($costValue.value);
    const mode = $costMode.value;

    if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
      $status.textContent = "Enter a valid ticker.";
      return;
    }
    if (!shares || shares <= 0) {
      $status.textContent = "Enter a number of shares greater than zero.";
      return;
    }
    if (!costInput || costInput <= 0) {
      $status.textContent = "Enter a cost basis greater than zero.";
      return;
    }

    const costBasis = mode === "total" ? costInput / shares : costInput;

    $submitBtn.disabled = true;
    $status.textContent = "Checking ticker…";

    try {
      await getQuote(ticker);

      if (editingId) {
        const h = holdings.find((x) => x.id === editingId);
        if (h) {
          h.ticker = ticker;
          h.shares = shares;
          h.costBasis = costBasis;
        }
      } else {
        holdings.push({
          id: crypto.randomUUID(),
          ticker,
          shares,
          costBasis,
          addedAt: new Date().toISOString(),
        });
      }
      saveHoldings();
      render();
      closeModal();
    } catch (err) {
      $status.textContent = err.message;
    } finally {
      $submitBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Add-to-watchlist modal
  // ---------------------------------------------------------------------

  const $watchOverlay = document.getElementById("watchlistModalOverlay");
  const $watchTicker = document.getElementById("watchlistTicker");
  const $watchStatus = document.getElementById("watchlistModalStatus");
  const $watchSubmitBtn = document.getElementById("watchlistSubmitBtn");

  function openWatchlistModal() {
    $watchTicker.value = "";
    $watchStatus.textContent = "";
    $watchOverlay.hidden = false;
  }

  function closeWatchlistModal() {
    $watchOverlay.hidden = true;
  }

  async function submitWatch() {
    const ticker = $watchTicker.value.trim().toUpperCase();
    if (!ticker || !/^[A-Z.\-]{1,10}$/.test(ticker)) {
      $watchStatus.textContent = "Enter a valid ticker.";
      return;
    }
    if (watchlist.some((w) => w.ticker === ticker)) {
      $watchStatus.textContent = `${ticker} is already on your watchlist.`;
      return;
    }

    $watchSubmitBtn.disabled = true;
    $watchStatus.textContent = "Checking ticker…";

    try {
      await getQuote(ticker);
      watchlist.push({ id: crypto.randomUUID(), ticker, addedAt: new Date().toISOString() });
      saveWatchlist();
      render();
      closeWatchlistModal();
    } catch (err) {
      $watchStatus.textContent = err.message;
    } finally {
      $watchSubmitBtn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // Wire up static controls
  // ---------------------------------------------------------------------

  document.getElementById("newHoldingBtn").addEventListener("click", () => openHoldingModal(null));
  document.getElementById("holdingModalClose").addEventListener("click", closeModal);
  document.getElementById("holdingSubmitBtn").addEventListener("click", submitHolding);
  document.getElementById("refreshHoldingsBtn").addEventListener("click", refreshAllPrices);
  document.getElementById("resetHoldingsBtn").addEventListener("click", () => {
    if (!confirm("Clear all holdings? This can't be undone.")) return;
    holdings = [];
    saveHoldings();
    render();
  });
  $overlay.addEventListener("click", (e) => {
    if (e.target === $overlay) closeModal();
  });

  document.getElementById("newWatchlistBtn").addEventListener("click", openWatchlistModal);
  document.getElementById("watchlistModalClose").addEventListener("click", closeWatchlistModal);
  document.getElementById("watchlistSubmitBtn").addEventListener("click", submitWatch);
  document.getElementById("refreshWatchlistBtn").addEventListener("click", refreshAllWatchlistPrices);
  document.getElementById("resetWatchlistBtn").addEventListener("click", () => {
    if (!confirm("Clear your watchlist? This can't be undone.")) return;
    watchlist = [];
    saveWatchlist();
    render();
  });
  $watchOverlay.addEventListener("click", (e) => {
    if (e.target === $watchOverlay) closeWatchlistModal();
  });

  if (window.TickerSearch) {
    window.TickerSearch.attach($ticker);
    window.TickerSearch.attach($watchTicker);
  }

  render();

  window.Portfolio = {
    onShow: render,
  };
})();
