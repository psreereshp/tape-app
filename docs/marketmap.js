(function () {
  const cfg = window.SWING_TRADE_CONFIG || {};
  const STORAGE_KEY = "tape_market_map_list";
  const MAX_TICKERS = 25;
  const TICKER_RE = /^[A-Z.\-]{1,10}$/;

  const $subtabSingle = document.getElementById("analyzeSubtabSingle");
  const $subtabMap = document.getElementById("analyzeSubtabMap");
  const $subtabScenario = document.getElementById("analyzeSubtabScenario");
  const $singleView = document.getElementById("singleStockView");
  const $mapView = document.getElementById("marketMapView");
  const $scenarioView = document.getElementById("scenarioView");

  const $mapInput = document.getElementById("mapTickerInput");
  const $mapAddBtn = document.getElementById("mapAddBtn");
  const $mapList = document.getElementById("mapList");
  const $signalBtn = document.getElementById("mapSignalBtn");
  const $mapStatus = document.getElementById("mapStatus");
  const $scoreLegend = document.getElementById("scoreLegend");
  const $scoreInfoBtn = document.getElementById("scoreInfoBtn");
  const $scoreInfoPanel = document.getElementById("scoreInfoPanel");
  const $mapResults = document.getElementById("mapResults");

  let list = loadList();

  function loadList() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.filter((t) => typeof t === "string") : [];
    } catch {
      return [];
    }
  }

  function saveList() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  }

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Best-effort company name for a listed ticker — the local search index
  // is already loaded for the typeahead, so reuse it instead of a fetch.
  function nameFor(ticker) {
    if (!window.TickerSearch) return "";
    const hit = window.TickerSearch.search(ticker, 1)[0];
    return hit && hit[0] === ticker ? hit[1] : "";
  }

  function renderList() {
    $mapList.innerHTML = list.length === 0
      ? `<div class="map-empty">No tickers yet — add one above.</div>`
      : list.map((t) => `
          <div class="map-row" data-ticker="${esc(t)}">
            <div class="map-row-info">
              <span class="map-row-symbol">${esc(t)}</span>
              <span class="map-row-name">${esc(nameFor(t))}</span>
            </div>
            <button class="map-remove-btn" type="button" aria-label="Remove ${esc(t)}">&times;</button>
          </div>
        `).join("");

    $signalBtn.disabled = list.length === 0;
    $signalBtn.classList.toggle("lit", list.length > 0);
    $signalBtn.title = list.length === 0 ? "Add a ticker to enable scanning" : "Scan your list";
  }

  function addTicker(raw) {
    const ticker = String(raw || "").trim().toUpperCase();
    if (!ticker) return;
    if (!TICKER_RE.test(ticker)) {
      $mapStatus.textContent = "Enter a valid ticker symbol.";
      return;
    }
    if (list.includes(ticker)) {
      $mapInput.value = "";
      return;
    }
    if (list.length >= MAX_TICKERS) {
      $mapStatus.textContent = `List is capped at ${MAX_TICKERS} tickers — remove one to add another.`;
      return;
    }
    list.push(ticker);
    saveList();
    renderList();
    $mapInput.value = "";
    $mapStatus.textContent = "";
  }

  function removeTicker(ticker) {
    list = list.filter((t) => t !== ticker);
    saveList();
    renderList();
  }

  function fmtPrice(price) {
    return price != null ? `$${Number(price).toFixed(2)}` : "—";
  }

  function fmtChange(pct) {
    if (pct == null) return "";
    const sign = pct >= 0 ? "+" : "";
    return `${sign}${pct.toFixed(2)}%`;
  }

  function verdictLabel(verdict) {
    return { favourable: "Favourable", neutral: "Neutral", unfavourable: "Unfavourable" }[verdict] || "Neutral";
  }

  function renderResults(results) {
    const sorted = [...results].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const rows = sorted.map((r) => {
      if (r.error) {
        return `
          <tr>
            <td class="mt-ticker">${esc(r.ticker)}</td>
            <td class="mt-error" colspan="5">${esc(r.error)}</td>
          </tr>
        `;
      }
      return `
        <tr class="mt-row" data-ticker="${esc(r.ticker)}" tabindex="0" role="button">
          <td class="mt-ticker">${esc(r.ticker)}</td>
          <td class="mt-company">${esc(r.companyName || "")}</td>
          <td class="mt-price">
            ${esc(fmtPrice(r.price))}
            <span class="mt-change ${r.changePercent >= 0 ? "up" : "down"}">${esc(fmtChange(r.changePercent))}</span>
          </td>
          <td class="mt-score ${esc(r.verdict)}">${esc(r.score)}</td>
          <td class="mt-verdict"><span class="dot ${esc(r.verdict)}"></span>${verdictLabel(r.verdict)}</td>
          <td class="mt-reason">${esc(r.reason || "")}</td>
        </tr>
      `;
    }).join("");

    $mapResults.innerHTML = `
      <div class="map-table-wrap">
        <table class="map-table">
          <thead>
            <tr><th>Ticker</th><th>Company</th><th>Price</th><th>Score</th><th>Verdict</th><th>Reason</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;

    $scoreLegend.hidden = !sorted.some((r) => !r.error);
  }

  function openFullAnalysis(ticker) {
    switchSubtab("single");
    document.getElementById("tickerInput").value = ticker;
    document.getElementById("analyzeBtn").click();
  }

  async function runScan() {
    if (list.length === 0) return;
    if (!cfg.API_URL) {
      $mapStatus.textContent = "This app isn't wired up to a backend yet — set API_URL in config.js (see README).";
      return;
    }

    $signalBtn.disabled = true;
    $mapStatus.innerHTML = `<span class="spinner"></span>Scanning ${list.length} ticker${list.length > 1 ? "s" : ""}…`;
    $mapResults.innerHTML = "";
    $scoreLegend.hidden = true;
    $scoreInfoPanel.hidden = true;

    try {
      const res = await fetch(`${cfg.API_URL}/scan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.APP_KEY ? { "X-App-Key": cfg.APP_KEY } : {}),
        },
        body: JSON.stringify({ tickers: list }),
      });
      const data = await res.json();

      if (!res.ok) {
        $mapStatus.textContent = data.error || `Request failed (${res.status}).`;
        return;
      }

      $mapStatus.textContent = `Scanned at ${new Date(data.scannedAt).toLocaleTimeString()}`;
      renderResults(data.results || []);
    } catch {
      $mapStatus.textContent = "Network error — check your connection and try again.";
    } finally {
      $signalBtn.disabled = list.length === 0;
    }
  }

  function switchSubtab(which) {
    $subtabSingle.classList.toggle("active", which === "single");
    $subtabMap.classList.toggle("active", which === "map");
    $subtabScenario.classList.toggle("active", which === "scenario");
    $singleView.hidden = which !== "single";
    $mapView.hidden = which !== "map";
    $scenarioView.hidden = which !== "scenario";
  }

  window.AnalyzeSubtabs = { show: switchSubtab };

  $subtabSingle.addEventListener("click", () => switchSubtab("single"));
  $subtabScenario.addEventListener("click", () => switchSubtab("scenario"));
  $subtabMap.addEventListener("click", () => switchSubtab("map"));

  $mapAddBtn.addEventListener("click", () => addTicker($mapInput.value));

  // Registered before this plain Enter handler so a dropdown pick (see
  // tickers.js) wins a shared Enter keypress instead of both firing.
  if (window.TickerSearch) {
    window.TickerSearch.attach($mapInput, {
      anchor: $mapInput.closest(".search-row"),
      onSelect: (row) => addTicker(row[0]),
    });
  }
  $mapInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addTicker($mapInput.value);
    }
  });

  $mapList.addEventListener("click", (e) => {
    const btn = e.target.closest(".map-remove-btn");
    if (!btn) return;
    removeTicker(btn.closest(".map-row").dataset.ticker);
  });

  $mapResults.addEventListener("click", (e) => {
    const row = e.target.closest(".mt-row");
    if (row) openFullAnalysis(row.dataset.ticker);
  });
  $mapResults.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const row = e.target.closest(".mt-row");
    if (!row) return;
    e.preventDefault();
    openFullAnalysis(row.dataset.ticker);
  });

  $signalBtn.addEventListener("click", runScan);

  $scoreInfoBtn.addEventListener("click", () => {
    const willShow = $scoreInfoPanel.hidden;
    $scoreInfoPanel.hidden = !willShow;
    $scoreInfoBtn.setAttribute("aria-expanded", String(willShow));
  });

  renderList();

  // Names are blank on first paint if tickers.json hasn't loaded yet (e.g.
  // a list restored from localStorage on page load) — backfill once it has.
  if (window.TickerSearch) window.TickerSearch.ready().then(renderList);
})();
