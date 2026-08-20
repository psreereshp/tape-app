(function () {
  const cfg = window.SWING_TRADE_CONFIG || {};
  const TICKER_RE = /^[A-Z.\-]{1,10}$/;
  const LEGEND_COLORS = ["#4f8cff", "#22c55e", "#a78bfa"];

  const $t1 = document.getElementById("scenarioTicker1");
  const $t2 = document.getElementById("scenarioTicker2");
  const $t3 = document.getElementById("scenarioTicker3");
  const $startDate = document.getElementById("scenarioStartDate");
  const $endDate = document.getElementById("scenarioEndDate");
  const $amount = document.getElementById("scenarioAmount");
  const $recurringToggle = document.getElementById("scenarioRecurringToggle");
  const $recurringRow = document.getElementById("scenarioRecurringRow");
  const $recurringAmount = document.getElementById("scenarioRecurringAmount");
  const $formStatus = document.getElementById("scenarioFormStatus");
  const $runBtn = document.getElementById("scenarioRunBtn");
  const $status = document.getElementById("scenarioStatus");
  const $results = document.getElementById("scenarioResults");

  let comparisonChart = null;

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtMoney(v) {
    if (v == null) return "—";
    return `$${Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  function fmtPct(v) {
    if (v == null || Number.isNaN(v)) return "—";
    return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  }

  function formatTickDate(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  // Best-effort company name from the local ticker DB already loaded for
  // the search-as-you-type dropdown — no extra fetch.
  function nameFor(ticker) {
    if (!window.TickerSearch) return "";
    const hit = window.TickerSearch.search(ticker, 1)[0];
    return hit && hit[0] === ticker ? hit[1] : "";
  }

  // Init: end date defaults to today and can't go past it; start date is
  // left blank so the user makes an explicit choice.
  (function initDates() {
    const today = new Date().toISOString().slice(0, 10);
    $endDate.value = today;
    $endDate.max = today;
    $startDate.max = today;
  })();

  $recurringToggle.addEventListener("change", () => {
    $recurringRow.hidden = !$recurringToggle.checked;
  });

  if (window.TickerSearch) {
    window.TickerSearch.attach($t1);
    window.TickerSearch.attach($t2);
    window.TickerSearch.attach($t3);
  }

  function collectTickers() {
    const raw = [$t1.value, $t2.value, $t3.value]
      .map((v) => String(v || "").trim().toUpperCase())
      .filter(Boolean);
    return [...new Set(raw)];
  }

  function validate(tickers, startDate, endDate, amount, recurringAmount) {
    if (tickers.length < 2 || tickers.length > 3) {
      return "Enter 2 or 3 tickers (ticker 3 is optional).";
    }
    if (!tickers.every((t) => TICKER_RE.test(t))) {
      return "One of the tickers doesn't look valid.";
    }
    if (!startDate) return "Pick an investment date.";
    const start = new Date(`${startDate}T00:00:00Z`);
    const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    if (Number.isNaN(start.getTime()) || start >= today) {
      return "Investment date must be in the past.";
    }
    if (endDate && new Date(`${endDate}T00:00:00Z`) <= start) {
      return "The end date must be after the investment date.";
    }
    if (!amount || amount <= 0) return "Enter a deposit amount greater than zero.";
    if ($recurringToggle.checked && !(recurringAmount > 0)) {
      return "Enter a monthly amount, or turn off the recurring investment.";
    }
    return null;
  }

  function statBlock(label, value) {
    return `
      <div class="scenario-stat">
        <div class="s-label">${esc(label)}</div>
        <div class="s-value">${value}</div>
      </div>
    `;
  }

  function renderResultCard(r) {
    if (r.error) {
      return `
        <div class="scenario-result-card">
          <div class="scenario-result-top">
            <span class="scenario-result-symbol">${esc(r.ticker)}</span>
            <span class="scenario-result-name">${esc(r.error)}</span>
          </div>
        </div>
      `;
    }
    const up = r.gainLoss >= 0;
    return `
      <div class="scenario-result-card">
        <div class="scenario-result-top">
          <span class="scenario-result-symbol">${esc(r.ticker)}</span>
          <span class="scenario-result-name">${esc(nameFor(r.ticker))}</span>
          <span class="scenario-result-gain ${up ? "pnl-pos" : "pnl-neg"}">${esc(fmtPct(r.gainLossPercent))}</span>
        </div>
        <div class="scenario-result-grid">
          ${statBlock("Invested", fmtMoney(r.totalInvested))}
          ${statBlock("Current value", fmtMoney(r.currentValue))}
          ${statBlock("Start price", fmtMoney(r.startPrice))}
          ${statBlock("End price", fmtMoney(r.endPrice))}
          ${statBlock("Gain / loss", `<span class="${up ? "pnl-pos" : "pnl-neg"}">${up ? "+" : ""}${esc(fmtMoney(r.gainLoss))}</span>`)}
          ${statBlock("Monthly buys", r.recurringContributions > 0 ? String(r.recurringContributions) : "—")}
        </div>
      </div>
    `;
  }

  function renderComparisonChart(results) {
    const ok = results.filter((r) => !r.error && Array.isArray(r.series) && r.series.length > 1);
    if (ok.length === 0) return "";

    // Dates should line up across tickers on the same exchange calendar;
    // the longest series is used as the shared label axis.
    const longest = ok.reduce((a, b) => (b.series.length > a.series.length ? b : a));

    return `
      <div class="scenario-legend">
        ${ok.map((r, i) => `
          <span class="scenario-legend-item">
            <span class="scenario-legend-swatch" style="background:${LEGEND_COLORS[i % LEGEND_COLORS.length]}"></span>
            ${esc(r.ticker)}
          </span>
        `).join("")}
      </div>
      <div class="scenario-chart-wrap">
        <canvas id="scenarioComparisonCanvas"></canvas>
      </div>
      <div class="chart-caption">Portfolio value over time — same deposit into each ticker, run independently</div>
    `;
  }

  function drawComparisonChart(results) {
    const ok = results.filter((r) => !r.error && Array.isArray(r.series) && r.series.length > 1);
    if (ok.length === 0) return;

    const canvas = document.getElementById("scenarioComparisonCanvas");
    if (!canvas) return;

    const longest = ok.reduce((a, b) => (b.series.length > a.series.length ? b : a));

    if (comparisonChart) comparisonChart.destroy();
    comparisonChart = new Chart(canvas, {
      type: "line",
      data: {
        labels: longest.series.map((p) => p.date),
        datasets: ok.map((r, i) => ({
          label: r.ticker,
          data: r.series.map((p) => p.value),
          borderColor: LEGEND_COLORS[i % LEGEND_COLORS.length],
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          tension: 0.2,
          fill: false,
        })),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? formatTickDate(longest.series[items[0].dataIndex].date) : ""),
              label: (item) => `${item.dataset.label}: ${fmtMoney(item.parsed.y)}`,
            },
          },
        },
        scales: {
          x: {
            display: true,
            grid: { display: false },
            ticks: { color: "#66727f", maxTicksLimit: 6, autoSkip: true, callback: function (v) { return formatTickDate(this.getLabelForValue(v)); } },
          },
          y: {
            display: true,
            position: "right",
            grid: { color: "rgba(255,255,255,0.06)" },
            ticks: { color: "#66727f", callback: (v) => fmtMoney(v) },
          },
        },
      },
    });
  }

  function renderResults(results, startDate, endDate) {
    const sorted = [...results].sort((a, b) => (b.gainLossPercent ?? -Infinity) - (a.gainLossPercent ?? -Infinity));
    $results.innerHTML = `
      ${sorted.map(renderResultCard).join("")}
      ${renderComparisonChart(results)}
    `;
    drawComparisonChart(results);
  }

  async function runScenario() {
    const tickers = collectTickers();
    const startDate = $startDate.value;
    const endDate = $endDate.value;
    const amount = parseFloat($amount.value);
    const recurringAmount = $recurringToggle.checked ? parseFloat($recurringAmount.value) : null;

    const err = validate(tickers, startDate, endDate, amount, recurringAmount);
    if (err) {
      $formStatus.textContent = err;
      return;
    }
    $formStatus.textContent = "";

    if (!cfg.API_URL) {
      $status.textContent = "This app isn't wired up to a backend yet — set API_URL in config.js (see README).";
      return;
    }

    $runBtn.disabled = true;
    $status.innerHTML = `<span class="spinner"></span>Backtesting ${tickers.join(", ")}…`;
    $results.innerHTML = "";

    try {
      const res = await fetch(`${cfg.API_URL}/backtest`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.APP_KEY ? { "X-App-Key": cfg.APP_KEY } : {}),
        },
        body: JSON.stringify({
          tickers,
          startDate,
          endDate,
          amount,
          recurring: recurringAmount ? { amount: recurringAmount } : null,
        }),
      });
      const data = await res.json();

      if (!res.ok) {
        $status.textContent = data.error || `Request failed (${res.status}).`;
        return;
      }

      $status.textContent = `${formatTickDate(data.startDate)} → ${formatTickDate(data.endDate)}`;
      renderResults(data.results || [], data.startDate, data.endDate);
    } catch {
      $status.textContent = "Network error — check your connection and try again.";
    } finally {
      $runBtn.disabled = false;
    }
  }

  $runBtn.addEventListener("click", runScenario);
})();
