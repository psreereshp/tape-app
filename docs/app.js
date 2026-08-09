(function () {
  const cfg = window.SWING_TRADE_CONFIG || {};
  const $status = document.getElementById("status");
  const $dashboard = document.getElementById("dashboard");
  const $input = document.getElementById("tickerInput");
  const $btn = document.getElementById("analyzeBtn");

  let chartInstance = null;

  function setStatus(html, isError) {
    $status.innerHTML = html;
    $status.classList.toggle("error", !!isError);
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function verdictBeaconClasses(verdict) {
    const map = {
      favourable: { red: "", amber: "", green: "lit-green" },
      neutral: { red: "", amber: "lit-amber", green: "" },
      unfavourable: { red: "lit-red", amber: "", green: "" },
    };
    return map[verdict] || map.neutral;
  }

  function verdictLabel(verdict) {
    return { favourable: "FAVOURABLE", neutral: "NEUTRAL", unfavourable: "UNFAVOURABLE" }[verdict] || "NEUTRAL";
  }

  function renderDashboard(d) {
    const lit = verdictBeaconClasses(d.verdict);
    const entryProminent = d.verdict === "favourable";

    const tilesHtml = `
      <div class="tiles">
        <div class="tile ${entryProminent ? "prominent" : ""}">
          <div class="t-label">Entry</div>
          <div class="t-value">${esc(d.entry?.value)}</div>
        </div>
        <div class="tile">
          <div class="t-label">Stop</div>
          <div class="t-value">${esc(d.stop?.value)}</div>
        </div>
        <div class="tile">
          <div class="t-label">Target</div>
          <div class="t-value">${esc(d.target?.value)}</div>
        </div>
      </div>
      ${d.entry?.label ? `<div class="rr">${esc(d.entry.label)}</div>` : ""}
      ${d.riskReward ? `<div class="rr">Reward-to-risk: ${esc(d.riskReward)}</div>` : ""}
    `;

    const stats = d.stats || {};
    const statsHtml = `
      <div class="card">
        <div class="stats-strip">
          ${[
            ["52-wk high", stats.high52],
            ["52-wk low", stats.low52],
            ["% from high", stats.pctFromHigh],
            ["% from low", stats.pctFromLow],
            ["~1-yr return", stats.oneYearReturn],
            ["Volatility", stats.volatility],
            ["Big-move days", stats.bigMoveDays],
          ].filter(([, v]) => v != null && v !== "")
            .map(([label, value]) => `
              <div class="stat">
                <div class="s-label">${esc(label)}</div>
                <div class="s-value">${esc(value)}</div>
              </div>
            `).join("")}
        </div>
        <div class="chart-wrap">
          <canvas id="priceChart" role="img" aria-label="52-week price line chart for ${esc(d.ticker)}"></canvas>
        </div>
        <div class="chart-caption">52-week trend${d.chartApproximate ? " (approximate — sparse data)" : ""}</div>
      </div>
    `;

    const tech = d.technical || {};
    const sent = d.sentiment || {};
    const year = d.yearStory || {};

    function block(takeaway, detail) {
      if (!takeaway && !detail) return "";
      return `
        <div class="block">
          ${takeaway ? `<div class="takeaway">${esc(takeaway)}</div>` : ""}
          ${detail ? `<div class="detail">${esc(detail)}</div>` : ""}
        </div>
      `;
    }

    const expandHtml = `
      <details class="expand">
        <summary>Technical breakdown <span class="chev">&#9660;</span></summary>
        <div class="expand-body">
          ${block(tech.trendTakeaway, tech.trendDetail)}
          ${block(tech.momentumTakeaway, tech.momentumDetail)}
          ${block(tech.volatilityTakeaway, tech.volatilityDetail)}
          ${tech.patternTakeaway ? block(tech.patternTakeaway, "") : ""}
        </div>
      </details>
      <details class="expand">
        <summary>Market sentiment <span class="chev">&#9660;</span></summary>
        <div class="expand-body">
          ${block(sent.newsTakeaway, sent.newsDetail)}
          ${block(sent.analystTakeaway, sent.analystDetail)}
          ${sent.crowdTakeaway ? block(sent.crowdTakeaway, "") : ""}
        </div>
      </details>
      <details class="expand">
        <summary>The year's story <span class="chev">&#9660;</span></summary>
        <div class="expand-body">
          ${block(year.narrative, "")}
          ${year.earningsReactions ? block("Past earnings reactions", year.earningsReactions) : ""}
        </div>
      </details>
    `;

    $dashboard.innerHTML = `
      <div class="card">
        <div class="ticker-header">
          <div>
            <div class="symbol">${esc(d.ticker)}</div>
            <div class="name">${esc(d.companyName)}</div>
          </div>
          <div class="price">
            <div class="p">${esc(d.price)}</div>
            <div class="chg">${esc(d.changePercent)}</div>
          </div>
        </div>
        <div class="as-of">${esc(d.asOf)}</div>
      </div>

      <div class="card beacon-card">
        <div class="beacon">
          <div class="dot ${lit.red}"></div>
          <div class="dot ${lit.amber}"></div>
          <div class="dot ${lit.green}"></div>
        </div>
        <div class="beacon-text">
          <div class="label ${esc(d.verdict)}">${verdictLabel(d.verdict)}</div>
          <div class="headline">${esc(d.verdictHeadline)}</div>
        </div>
      </div>

      <div class="card">${tilesHtml}</div>

      ${d.verdict !== "unfavourable" ? `<button id="paperTradeBtn" class="full-btn" type="button">Paper trade this setup</button>` : ""}

      ${statsHtml}

      <div class="card key-risk">
        <div class="kr-label">Key risk / catalyst to watch</div>
        <div>${esc(d.keyRisk)}</div>
      </div>

      ${expandHtml}

      <footer class="disclaimer">
        <div class="prov">${esc(d.provenance)}</div>
        <div>${esc(d.disclaimer)}</div>
      </footer>
    `;

    $dashboard.classList.add("visible");

    if (chartInstance) chartInstance.destroy();
    const points = Array.isArray(d.chartPoints) ? d.chartPoints : [];
    const ctx = document.getElementById("priceChart");
    if (ctx && points.length) {
      chartInstance = new Chart(ctx, {
        type: "line",
        data: {
          labels: points.map((p) => p.date),
          datasets: [{
            data: points.map((p) => p.price),
            borderColor: "#4f8cff",
            borderWidth: 2,
            pointRadius: 0,
            tension: 0.25,
            fill: false,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { enabled: true } },
          scales: {
            x: { display: false },
            y: { display: false },
          },
        },
      });
    }

    const $paperTradeBtn = document.getElementById("paperTradeBtn");
    if ($paperTradeBtn && window.PaperTrading) {
      $paperTradeBtn.addEventListener("click", () => {
        window.PaperTrading.openNewTradeModal({
          ticker: d.ticker,
          stop: d.verdict === "favourable" ? parseFloat(String(d.stop?.value || "").replace(/[^0-9.]/g, "")) : null,
          target: d.verdict === "favourable" ? parseFloat(String(d.target?.value || "").replace(/[^0-9.]/g, "")) : null,
        });
      });
    }
  }

  async function analyze() {
    const ticker = ($input.value || "").trim().toUpperCase();
    if (!ticker) {
      setStatus("Enter a ticker first.", true);
      return;
    }
    if (!cfg.API_URL) {
      setStatus("This app isn't wired up to a backend yet — set API_URL in config.js (see README).", true);
      return;
    }

    $btn.disabled = true;
    $dashboard.classList.remove("visible");
    setStatus(`<span class="spinner"></span>Pulling technicals, history, and sentiment for ${esc(ticker)}… this can take 15–30s.`);

    try {
      const res = await fetch(`${cfg.API_URL}/analyze`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.APP_KEY ? { "X-App-Key": cfg.APP_KEY } : {}),
        },
        body: JSON.stringify({ ticker }),
      });

      const data = await res.json();

      if (!res.ok) {
        setStatus(esc(data.error || `Request failed (${res.status}).`), true);
        return;
      }

      setStatus("");
      renderDashboard(data);
    } catch (err) {
      setStatus("Network error — check your connection and try again.", true);
    } finally {
      $btn.disabled = false;
    }
  }

  $btn.addEventListener("click", analyze);
  $input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") analyze();
  });

  // iOS "Add to Home Screen" tip (iOS has no install prompt API, so nudge manually)
  (function iosTip() {
    const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    const isStandalone = window.navigator.standalone === true;
    const dismissed = localStorage.getItem("iosTipDismissed") === "1";
    if (isIOS && !isStandalone && !dismissed) {
      document.getElementById("iosTip").classList.add("show");
    }
    document.getElementById("iosTipClose").addEventListener("click", () => {
      document.getElementById("iosTip").classList.remove("show");
      localStorage.setItem("iosTipDismissed", "1");
    });
  })();

  // Tabs
  (function tabs() {
    const $tabMarkets = document.getElementById("tabMarketsBtn");
    const $tabAnalyze = document.getElementById("tabAnalyzeBtn");
    const $tabPaper = document.getElementById("tabPaperBtn");
    const $marketsView = document.getElementById("marketsView");
    const $analyzeView = document.getElementById("analyzeView");
    const $paperView = document.getElementById("paperView");

    function show(view) {
      $tabMarkets.classList.toggle("active", view === "markets");
      $tabAnalyze.classList.toggle("active", view === "analyze");
      $tabPaper.classList.toggle("active", view === "paper");
      $marketsView.hidden = view !== "markets";
      $analyzeView.hidden = view !== "analyze";
      $paperView.hidden = view !== "paper";
      if (view === "paper" && window.PaperTrading) window.PaperTrading.onShow();
      if (view === "markets" && window.Markets) window.Markets.onShow();
    }

    $tabMarkets.addEventListener("click", () => show("markets"));
    $tabAnalyze.addEventListener("click", () => show("analyze"));
    $tabPaper.addEventListener("click", () => show("paper"));
  })();

  // Register the service worker for push notifications (paper.js handles subscribing)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {
      // Push notifications just won't be available; paper trading still works.
    });
  }
})();
