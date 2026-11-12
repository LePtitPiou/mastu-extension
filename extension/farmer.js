// Crazy Coins Farmer — tourne sur twitch.tv/mastu (best-effort : Twitch peut changer son HTML)
(() => {
  const D = { autoClaim: true, hideVideo: false, lowQuality: false };
  let cfg = { ...D };
  const onMastu = () => /^\/mastu(\/|$)/i.test(location.pathname);
  const STYLE_ID = "mastu-farmer-style";
  const LOW = JSON.stringify({ default: "160p30" });

  function setHide(on) {
    let st = document.getElementById(STYLE_ID);
    if (on && !st) {
      st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = '[data-a-target="video-player"]{display:none!important}';
      document.head.appendChild(st);
    }
    if (!on && st) st.remove();
    if (on) document.querySelectorAll("video").forEach(v => { v.muted = true; });
  }

  function applyQuality() { // pris en compte au prochain chargement du lecteur
    try {
      if (cfg.lowQuality) localStorage.setItem("video-quality", LOW);
      else if (localStorage.getItem("video-quality") === LOW) localStorage.removeItem("video-quality");
    } catch (_) {}
  }

  function claim() {
    const icon = document.querySelector(".claimable-bonus__icon");
    const btn = icon && icon.closest("button");
    if (!btn) return;
    btn.click();
    chrome.storage.local.get("claimed").then(({ claimed = 0 }) => chrome.storage.local.set({ claimed: claimed + 1 }));
  }

  function tick() {
    try {
      if (!onMastu()) { setHide(false); return; }
      if (cfg.autoClaim) claim();
      setHide(cfg.hideVideo);
    } catch (_) {}
  }

  chrome.storage.sync.get(D).then(v => { cfg = v; applyQuality(); });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "sync") return;
    for (const k in c) if (k in D) cfg[k] = c[k].newValue;
    applyQuality();
  });
  setInterval(tick, 2000);
})();
