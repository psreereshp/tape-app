// Shared "enlarge this chart" modal — single-finger crosshair (date/value
// pills on both axes) and a two-finger compare mode (second crosshair +
// connecting line + a delta summary in the header). Used by the Markets
// tab's index charts and the Analyze tab's 52-week chart, so the
// interaction only has to be built and tested once.
(function () {
  const $overlay = document.getElementById("indexChartModalOverlay");
  const $close = document.getElementById("indexChartModalClose");
  const $title = document.getElementById("indexChartModalTitle");
  const $meta = document.getElementById("indexChartMeta");
  const $canvas = document.getElementById("indexChartCanvas");
  const $caption = document.getElementById("indexChartCaption");

  let chart = null;
  let current = null; // { points: [{date, value}], formatValue, defaultMetaHtml }
  const touchState = { second: null };

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function formatTickDate(dateStr) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
  }

  function daysBetween(dateStrA, dateStrB) {
    const a = new Date(`${dateStrA}T00:00:00Z`);
    const b = new Date(`${dateStrB}T00:00:00Z`);
    return Math.round(Math.abs(b - a) / 86400000);
  }

  // One crosshair: dashed lines out to both axes, plus a small pill on each
  // axis showing that point's date/value.
  function drawCrosshairAt(c, x, y, dateLabel, valueLabel, color) {
    const { ctx, chartArea, scales } = c;

    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.35)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.restore();

    ctx.save();
    ctx.font = "11px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillStyle = color;

    const dateW = ctx.measureText(dateLabel).width + 12;
    const dateX = Math.min(Math.max(x - dateW / 2, chartArea.left), chartArea.right - dateW);
    ctx.fillRect(dateX, scales.x.top, dateW, 18);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(dateLabel, dateX + dateW / 2, scales.x.top + 9);

    ctx.fillStyle = color;
    const valueW = ctx.measureText(valueLabel).width + 12;
    ctx.fillRect(chartArea.right, y - 9, valueW, 18);
    ctx.fillStyle = "#fff";
    ctx.textAlign = "left";
    ctx.fillText(valueLabel, chartArea.right + 6, y);
    ctx.restore();
  }

  const crosshairPlugin = {
    id: "crosshair",
    afterDraw(c) {
      if (!current) return;
      const points = [];

      const active = c.getActiveElements();
      if (active && active.length) {
        points.push({ x: active[0].element.x, y: active[0].element.y, index: active[0].index, color: "#4f8cff" });
      }
      if (touchState.second) {
        points.push({ ...touchState.second, color: "#f59e0b" });
      }

      points.forEach((p) => {
        drawCrosshairAt(
          c,
          p.x,
          p.y,
          formatTickDate(c.data.labels[p.index]),
          current.formatValue(c.data.datasets[0].data[p.index]),
          p.color
        );
      });

      // Two fingers down: connect them so the move between the two points
      // reads as a line, not just two disconnected crosshairs.
      if (points.length === 2) {
        const { ctx } = c;
        ctx.save();
        ctx.strokeStyle = "#a78bfa";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        ctx.lineTo(points[1].x, points[1].y);
        ctx.stroke();
        ctx.restore();
      }
    },
  };

  // Which point came first in time (not which finger touched down first)
  // decides the from/to order.
  function renderCompareMeta(indexA, indexB) {
    if (!current) return;
    const lo = Math.min(indexA, indexB);
    const hi = Math.max(indexA, indexB);
    const pA = current.points[lo];
    const pB = current.points[hi];
    const delta = pB.value - pA.value;
    const deltaPct = pA.value ? (delta / pA.value) * 100 : null;
    const up = delta >= 0;
    $meta.innerHTML = `
      <span class="index-chart-compare">
        ${esc(formatTickDate(pA.date))} &rarr; ${esc(formatTickDate(pB.date))}
        <span class="${up ? "pnl-pos" : "pnl-neg"}">${up ? "+" : "-"}${esc(current.formatValue(Math.abs(delta)))} (${up ? "+" : ""}${deltaPct != null ? deltaPct.toFixed(2) : "—"}%)</span>
        · ${daysBetween(pA.date, pB.date)}d apart
      </span>
    `;
  }

  function canvasPixelFromTouch(canvas, touch) {
    const rect = canvas.getBoundingClientRect();
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  function nearestIndexForX(c, pixelX) {
    const raw = c.scales.x.getValueForPixel(pixelX);
    const count = c.data.labels.length;
    return Math.min(Math.max(Math.round(raw), 0), count - 1);
  }

  // Chart.js's own hover handling already tracks a single touch (touches[0])
  // for the first crosshair — this only adds a second, independent point
  // from touches[1] when a second finger is also down, and clears it the
  // moment we're back to fewer than two touches.
  function handleTouch(e) {
    if (!chart || !current) return;

    if (e.touches.length < 2) {
      if (touchState.second) {
        touchState.second = null;
        $meta.innerHTML = current.defaultMetaHtml;
        chart.draw();
      }
      return;
    }

    e.preventDefault();
    const p1 = canvasPixelFromTouch($canvas, e.touches[1]);
    const index1 = nearestIndexForX(chart, p1.x);
    touchState.second = {
      x: chart.scales.x.getPixelForValue(index1),
      y: chart.scales.y.getPixelForValue(current.points[index1].value),
      index: index1,
    };

    const p0 = canvasPixelFromTouch($canvas, e.touches[0]);
    const index0 = nearestIndexForX(chart, p0.x);
    renderCompareMeta(index0, index1);
    chart.draw();
  }

  $canvas.addEventListener("touchstart", handleTouch, { passive: false });
  $canvas.addEventListener("touchmove", handleTouch, { passive: false });
  $canvas.addEventListener("touchend", handleTouch, { passive: false });
  $canvas.addEventListener("touchcancel", handleTouch, { passive: false });

  function close() {
    $overlay.hidden = true;
    current = null;
    touchState.second = null;
  }

  // config: { title, points: [{date, value}], up, formatValue, metaHtml, caption }
  function open(config) {
    if (!config || !Array.isArray(config.points) || config.points.length < 2) return;

    current = { points: config.points, formatValue: config.formatValue, defaultMetaHtml: config.metaHtml };
    touchState.second = null;

    $title.textContent = config.title;
    $meta.innerHTML = config.metaHtml;
    if (config.caption) $caption.textContent = config.caption;

    const color = config.up ? "#22c55e" : "#ef4444";
    const bg = config.up ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)";

    if (chart) chart.destroy();
    chart = new Chart($canvas, {
      type: "line",
      data: {
        labels: config.points.map((p) => p.date),
        datasets: [{
          data: config.points.map((p) => p.value),
          borderColor: color,
          backgroundColor: bg,
          borderWidth: 2,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHitRadius: 12,
          tension: 0.25,
          fill: true,
        }],
      },
      plugins: [crosshairPlugin],
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", intersect: false, axis: "x" },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              title: (items) => (items.length ? formatTickDate(items[0].label) : ""),
              label: (item) => current.formatValue(item.parsed.y),
            },
          },
        },
        scales: {
          x: {
            display: true,
            grid: { display: false },
            ticks: {
              color: "#66727f",
              maxTicksLimit: 6,
              autoSkip: true,
              callback: function (value) {
                return formatTickDate(this.getLabelForValue(value));
              },
            },
          },
          y: {
            display: true,
            position: "right",
            grid: { color: "rgba(255,255,255,0.06)" },
            ticks: {
              color: "#66727f",
              callback: (value) => current.formatValue(value),
            },
          },
        },
      },
    });

    $overlay.hidden = false;
  }

  $close.addEventListener("click", close);
  $overlay.addEventListener("click", (e) => {
    if (e.target === $overlay) close();
  });

  window.ChartModal = { open, close };
})();
