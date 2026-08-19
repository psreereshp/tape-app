(function () {
  const cfg = window.SWING_TRADE_CONFIG || {};
  const $cards = document.getElementById("indexCards");
  const $updated = document.getElementById("marketsUpdated");
  const $news = document.getElementById("newsList");
  const $refreshBtn = document.getElementById("marketsRefreshBtn");

  let loaded = false;
  let loading = false;
  const sparklineCharts = [];
  let latestIndices = [];

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function fmtPct(n) {
    if (n == null || Number.isNaN(n)) return "—";
    return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
  }

  function relativeTime(dateStr) {
    if (!dateStr) return "";
    const d = new Date(dateStr);
    if (Number.isNaN(d.getTime())) return "";
    const diffMin = Math.round((Date.now() - d.getTime()) / 60000);
    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h ago`;
    return `${Math.round(diffHr / 24)}d ago`;
  }

  function fmtValue(idx, value) {
    if (value == null) return "—";
    return idx.raw ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : `$${value.toFixed(2)}`;
  }

  function sessionTag(session) {
    return session === "pre" ? "Pre-mkt" : "After hrs";
  }

  // Small line for pre/post-market movement — absent during regular hours
  // or when the market's fully closed, since there's nothing extra to show.
  function extendedLineHtml(idx) {
    if (!idx.extended) return "";
    const up = idx.extended.changePercent >= 0;
    return `
      <div class="index-card-extended ${up ? "pnl-pos" : "pnl-neg"}">
        <span class="ext-tag">${esc(sessionTag(idx.session))}</span>
        ${esc(fmtValue(idx, idx.extended.price))} ${esc(fmtPct(idx.extended.changePercent))}
      </div>
    `;
  }

  function renderCards(indices) {
    sparklineCharts.forEach((c) => c.destroy());
    sparklineCharts.length = 0;
    latestIndices = indices || [];

    if (!indices || indices.length === 0) {
      $cards.innerHTML = `<div class="empty-note">Market data isn't available right now.</div>`;
      return;
    }

    $cards.innerHTML = indices.map((idx, i) => {
      const up = idx.changePercent != null && idx.changePercent >= 0;
      const pnlClass = idx.changePercent == null ? "" : up ? "pnl-pos" : "pnl-neg";
      const canEnlarge = Array.isArray(idx.points) && idx.points.length >= 2;
      return `
        <div class="index-card${canEnlarge ? " tappable" : ""}" data-i="${i}"${canEnlarge ? ' role="button" tabindex="0"' : ""}>
          <div class="index-card-label">${esc(idx.label)}</div>
          <div class="index-card-price">${fmtValue(idx, idx.price)}</div>
          <div class="index-card-change ${pnlClass}">${fmtPct(idx.changePercent)}</div>
          ${extendedLineHtml(idx)}
          <div class="index-card-chart"><canvas id="sparkline${i}"></canvas></div>
          <div class="index-card-sub">via ${esc(idx.symbol)}</div>
        </div>
      `;
    }).join("");

    indices.forEach((idx, i) => {
      const ctx = document.getElementById(`sparkline${i}`);
      if (!ctx || !Array.isArray(idx.points) || idx.points.length < 2) return;
      const up = idx.changePercent == null || idx.changePercent >= 0;
      sparklineCharts.push(new Chart(ctx, {
        type: "line",
        data: {
          labels: idx.points.map((p) => p.date),
          datasets: [{
            data: idx.points.map((p) => p.close),
            borderColor: up ? "#22c55e" : "#ef4444",
            borderWidth: 1.5,
            pointRadius: 0,
            tension: 0.3,
            fill: false,
          }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: { legend: { display: false }, tooltip: { enabled: false } },
          scales: { x: { display: false }, y: { display: false } },
        },
      }));
    });
  }

  function defaultChartMeta(idx) {
    const up = idx.changePercent == null || idx.changePercent >= 0;
    const pnlClass = idx.changePercent == null ? "" : up ? "pnl-pos" : "pnl-neg";
    const extUp = idx.extended && idx.extended.changePercent >= 0;
    const extended = idx.extended ? `
      <span class="index-chart-extended-row ${extUp ? "pnl-pos" : "pnl-neg"}">
        <span class="ext-tag">${esc(sessionTag(idx.session))}</span>
        ${esc(fmtValue(idx, idx.extended.price))} ${esc(fmtPct(idx.extended.changePercent))}
      </span>
    ` : "";
    return `
      <span class="index-chart-price">${esc(fmtValue(idx, idx.price))}</span>
      <span class="index-chart-change ${pnlClass}">${esc(fmtPct(idx.changePercent))}</span>
      <span class="index-chart-sub">via ${esc(idx.symbol)}</span>
      ${extended}
    `;
  }

  function openChartModal(i) {
    const idx = latestIndices[i];
    if (!idx || !window.ChartModal) return;
    const up = idx.changePercent == null || idx.changePercent >= 0;
    window.ChartModal.open({
      title: idx.label,
      points: (idx.points || []).map((p) => ({ date: p.date, value: p.close })),
      up,
      formatValue: (v) => fmtValue(idx, v),
      metaHtml: defaultChartMeta(idx),
      caption: "Tap or hover a point for its date and value · two fingers to compare two points · 6-month daily close, via Yahoo Finance",
    });
  }

  function renderNews(items) {
    if (!items || items.length === 0) {
      $news.innerHTML = `<div class="empty-note">No headlines right now.</div>`;
      return;
    }
    $news.innerHTML = items.map((item) => `
      <a class="news-row" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
        <div class="news-title">${esc(item.title)}</div>
        <div class="news-meta">${esc(item.source || "")}${item.source && item.pubDate ? " · " : ""}${esc(relativeTime(item.pubDate))}</div>
      </a>
    `).join("");
  }

  async function load(force) {
    if (loading) return;
    if (loaded && !force) return;
    if (!cfg.API_URL) {
      $cards.innerHTML = `<div class="empty-note">This app isn't wired up to a backend yet — set API_URL in config.js (see README).</div>`;
      $news.innerHTML = "";
      return;
    }

    loading = true;
    $refreshBtn.disabled = true;
    if (!loaded) {
      $cards.innerHTML = `<div class="empty-note"><span class="spinner"></span>Loading market data…</div>`;
    }

    try {
      const res = await fetch(`${cfg.API_URL}/market`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.APP_KEY ? { "X-App-Key": cfg.APP_KEY } : {}),
        },
        body: JSON.stringify({ force: !!force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);

      renderCards(data.indices);
      renderNews(data.news);
      $updated.textContent = data.indicesUpdatedAt ? `Indices updated ${relativeTime(new Date(data.indicesUpdatedAt).toISOString())}` : "";
      loaded = true;
    } catch (err) {
      $cards.innerHTML = `<div class="empty-note">Couldn't load market data: ${esc(err.message)}</div>`;
    } finally {
      loading = false;
      $refreshBtn.disabled = false;
    }
  }

  $refreshBtn.addEventListener("click", () => load(true));

  $cards.addEventListener("click", (e) => {
    const card = e.target.closest(".index-card.tappable");
    if (card) openChartModal(Number(card.dataset.i));
  });
  $cards.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const card = e.target.closest(".index-card.tappable");
    if (!card) return;
    e.preventDefault();
    openChartModal(Number(card.dataset.i));
  });

  window.Markets = {
    onShow: () => load(false),
  };

  load(false);
})();
