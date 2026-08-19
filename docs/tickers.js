(function () {
  const DATA_URL = "tickers.json";

  let DATA = [];
  let loadPromise = null;

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch(DATA_URL)
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => {
        DATA = Array.isArray(rows) ? rows : [];
      })
      .catch(() => {
        DATA = [];
      });
    return loadPromise;
  }
  load();

  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // Ranks symbol-prefix matches highest, then name-prefix, then substring
  // matches anywhere in symbol or name — so typing either a ticker or a
  // company name finds the right row.
  function search(query, limit) {
    const q = (query || "").trim().toUpperCase();
    if (!q) return [];
    const qLower = q.toLowerCase();
    const scored = [];
    for (let i = 0; i < DATA.length; i++) {
      const row = DATA[i];
      const sym = row[0];
      const nameUpper = row[1].toUpperCase();
      let score;
      if (sym === q) score = 0;
      else if (sym.startsWith(q)) score = 1;
      else if (nameUpper.startsWith(q)) score = 2;
      else if (sym.indexOf(q) !== -1) score = 3;
      else if (nameUpper.indexOf(qLower.toUpperCase()) !== -1) score = 4;
      else continue;
      scored.push([score, sym.length, row]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2][0].localeCompare(b[2][0]));
    return scored.slice(0, limit || 8).map((s) => s[2]);
  }

  // Wires a typeahead dropdown onto a text input. `opts.anchor` is the
  // element the dropdown is inserted after (defaults to the input's
  // wrapping <label>, or the input itself) — pass it explicitly when the
  // input sits inside a flex row (e.g. the Analyze search box) so the
  // dropdown doesn't land between the input and its sibling button.
  function attach(input, opts) {
    opts = opts || {};
    const onSelect = opts.onSelect || function () {};
    const anchor = opts.anchor || input.closest("label") || input;

    const dropdown = document.createElement("div");
    dropdown.className = "ticker-dropdown";
    dropdown.hidden = true;
    anchor.insertAdjacentElement("afterend", dropdown);

    let items = [];
    let activeIndex = -1;

    function close() {
      dropdown.hidden = true;
      dropdown.innerHTML = "";
      items = [];
      activeIndex = -1;
    }

    function render() {
      dropdown.innerHTML = items.map((row, i) => `
        <div class="ticker-option${i === activeIndex ? " active" : ""}" data-i="${i}">
          <span class="to-symbol">${esc(row[0])}</span>
          <span class="to-name">${esc(row[1])}</span>
          <span class="to-exchange">${esc(row[2])}</span>
        </div>
      `).join("");
      dropdown.hidden = items.length === 0;
    }

    function runSearch() {
      items = search(input.value, 8);
      activeIndex = -1;
      render();
    }

    function pick(row) {
      input.value = row[0];
      close();
      onSelect(row);
    }

    input.addEventListener("input", runSearch);

    input.addEventListener("focus", () => {
      if (input.value.trim()) runSearch();
    });

    load().then(() => {
      if (document.activeElement === input && input.value.trim()) runSearch();
    });

    input.addEventListener("keydown", (e) => {
      if (dropdown.hidden || !items.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        render();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        render();
      } else if (e.key === "Enter") {
        if (activeIndex >= 0) {
          // A caller-registered Enter handler (e.g. "submit" on the Analyze
          // box) would otherwise also fire on this same keypress and read
          // the input's pre-pick value — stop it so the pick wins outright.
          e.preventDefault();
          e.stopImmediatePropagation();
          pick(items[activeIndex]);
        } else {
          close();
        }
      } else if (e.key === "Escape") {
        close();
      }
    });

    // mousedown (not click) fires before the input's blur handler, so the
    // pick registers before the dropdown gets torn down by blur.
    dropdown.addEventListener("mousedown", (e) => {
      const opt = e.target.closest(".ticker-option");
      if (!opt) return;
      e.preventDefault();
      pick(items[Number(opt.dataset.i)]);
    });

    input.addEventListener("blur", () => {
      setTimeout(close, 150);
    });
  }

  window.TickerSearch = { attach, search, ready: load };
})();
