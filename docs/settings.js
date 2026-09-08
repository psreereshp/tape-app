(function () {
  const STORAGE_KEY = "tape_gemini_key";

  function getUserGeminiKey() {
    try {
      const v = (localStorage.getItem(STORAGE_KEY) || "").trim();
      return v || null;
    } catch {
      return null;
    }
  }

  const $btn = document.getElementById("settingsBtn");
  const $overlay = document.getElementById("settingsModalOverlay");
  const $close = document.getElementById("settingsModalClose");
  const $input = document.getElementById("geminiKeyInput");
  const $toggle = document.getElementById("geminiKeyToggle");
  const $status = document.getElementById("geminiKeyStatus");
  const $save = document.getElementById("geminiKeySaveBtn");
  const $remove = document.getElementById("geminiKeyRemoveBtn");
  const $keyNote = document.getElementById("analyzeKeyNote");

  function refreshStatus() {
    const key = getUserGeminiKey();
    $status.textContent = key
      ? "Using your own key — Analyze calls draw on your Gemini quota."
      : "Using the shared app key — Analyze calls draw on a pool shared with other testers.";
    $remove.hidden = !key;
    if ($keyNote) {
      $keyNote.hidden = !key;
      if (key) $keyNote.textContent = "Using your own Gemini key for this analysis.";
    }
  }

  refreshStatus();

  function openModal() {
    $input.value = getUserGeminiKey() || "";
    $input.type = "password";
    $toggle.textContent = "Show";
    refreshStatus();
    $overlay.hidden = false;
  }

  function closeModal() {
    $overlay.hidden = true;
  }

  $btn.addEventListener("click", openModal);
  $close.addEventListener("click", closeModal);
  $overlay.addEventListener("click", (e) => {
    if (e.target === $overlay) closeModal();
  });

  $toggle.addEventListener("click", () => {
    const showing = $input.type === "text";
    $input.type = showing ? "password" : "text";
    $toggle.textContent = showing ? "Show" : "Hide";
  });

  $save.addEventListener("click", () => {
    const key = $input.value.trim();
    if (!key) {
      $status.textContent = "Paste a key first, or use Remove to go back to the shared one.";
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      $status.textContent = "Couldn't save — this browser may be blocking local storage.";
      return;
    }
    refreshStatus();
  });

  $remove.addEventListener("click", () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
    $input.value = "";
    refreshStatus();
  });

  window.getUserGeminiKey = getUserGeminiKey;
})();
