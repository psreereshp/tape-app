(function () {
  const cfg = window.SWING_TRADE_CONFIG || {};
  const $btn = document.getElementById("earningsBtn");
  const $overlay = document.getElementById("earningsModalOverlay");
  const $close = document.getElementById("earningsModalClose");
  const $list = document.getElementById("earningsList");
  const $dayLabel = document.getElementById("earningsDayLabel");
  const $prevDay = document.getElementById("earningsPrevDay");
  const $nextDay = document.getElementById("earningsNextDay");

  let currentDate = todayStr();
  const cache = new Map();

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function todayStr() {
    return new Date().toISOString().slice(0, 10);
  }

  function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function formatDayLabel(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  }

  function fmtMoney(n) {
    if (n == null) return null;
    if (Math.abs(n) >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    return `$${n.toFixed(2)}`;
  }

  function timeTag(releaseTime) {
    if (releaseTime === "bmo") return `<span class="earnings-time-tag">BMO</span>`;
    if (releaseTime === "amc") return `<span class="earnings-time-tag">AMC</span>`;
    return "";
  }

  function renderList(data) {
    if (data.error) {
      $list.innerHTML = `<div class="empty-note">Couldn't load the earnings calendar: ${esc(data.error)}</div>`;
      return;
    }
    if (!data.items || data.items.length === 0) {
      $list.innerHTML = `<div class="empty-note">No notable earnings reports for this day.</div>`;
      return;
    }
    $list.innerHTML = data.items.map((item) => {
      const eps = item.epsEstimate != null ? `Est. EPS ${item.epsEstimate.toFixed(2)}` : "";
      const rev = fmtMoney(item.revenueEstimate);
      return `
        <div class="earnings-row">
          <div class="earnings-row-main">
            <div class="earnings-ticker">${esc(item.ticker)}</div>
            <div class="earnings-company">${esc(item.company)}</div>
          </div>
          <div class="earnings-row-meta">
            ${timeTag(item.releaseTime)}
            <div>${esc(eps)}</div>
            ${rev ? `<div>Est. rev ${esc(rev)}</div>` : ""}
          </div>
        </div>
      `;
    }).join("");
  }

  async function load(dateStr) {
    currentDate = dateStr;
    $dayLabel.textContent = formatDayLabel(dateStr);

    if (cache.has(dateStr)) {
      renderList(cache.get(dateStr));
      return;
    }

    if (!cfg.API_URL) {
      $list.innerHTML = `<div class="empty-note">This app isn't wired up to a backend yet — set API_URL in config.js (see README).</div>`;
      return;
    }

    $list.innerHTML = `<div class="empty-note"><span class="spinner"></span>Loading earnings calendar…</div>`;

    try {
      const res = await fetch(`${cfg.API_URL}/earnings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(cfg.APP_KEY ? { "X-App-Key": cfg.APP_KEY } : {}),
        },
        body: JSON.stringify({ date: dateStr }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status}).`);
      cache.set(dateStr, data);
      if (dateStr === currentDate) renderList(data);
    } catch (err) {
      if (dateStr === currentDate) {
        $list.innerHTML = `<div class="empty-note">Couldn't load the earnings calendar: ${esc(err.message)}</div>`;
      }
    }
  }

  function open() {
    $overlay.hidden = false;
    load(todayStr());
  }

  function close() {
    $overlay.hidden = true;
  }

  $btn.addEventListener("click", open);
  $close.addEventListener("click", close);
  $overlay.addEventListener("click", (e) => {
    if (e.target === $overlay) close();
  });
  $prevDay.addEventListener("click", () => load(addDays(currentDate, -1)));
  $nextDay.addEventListener("click", () => load(addDays(currentDate, 1)));
})();
