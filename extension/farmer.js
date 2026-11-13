// Onglet Twitch (twitch.tv/mastu) — bonus auto, cacher le stream, couper le son au lancement, qualité minimale
(() => {
  const D = { autoClaim: true, hideVideo: false, lowQuality: false, muteOnStart: false };
  let cfg = { ...D }, ready = false;
  const onMastu = () => /^\/mastu(\/|$)/i.test(location.pathname);
  const STYLE_ID = "mastu-farmer-style";
  const LOW = JSON.stringify({ default: "160p30" });

  // --- cacher le stream ---
  function setHide(on) {
    let st = document.getElementById(STYLE_ID);
    if (on && !st && document.head) {
      st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent = '[data-a-target="video-player"]{display:none!important}';
      document.head.appendChild(st);
    }
    if (!on && st) st.remove();
    if (on) document.querySelectorAll("video").forEach(v => { v.muted = true; });
  }

  // --- couper le son à l'ouverture : une seule fois par lecteur, tu peux ensuite le remettre à la main ---
  const handled = new WeakSet();
  function watchVideo(v) {
    if (!ready || handled.has(v)) return;
    handled.add(v);
    if (!cfg.muteOnStart || !onMastu()) return;
    v.muted = true;
    let n = 0; // Twitch peut remettre le son à l'initialisation : on insiste pendant 3 s
    const t = setInterval(() => { v.muted = true; if (++n >= 15) clearInterval(t); }, 200);
  }
  new MutationObserver(muts => {
    if (!ready || !cfg.muteOnStart) return;
    for (const m of muts) for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.tagName === "VIDEO") watchVideo(n);
      else if (n.querySelector) n.querySelectorAll("video").forEach(watchVideo);
    }
  }).observe(document, { childList: true, subtree: true });

  // --- qualité minimale (prise en compte au prochain chargement du lecteur) ---
  function applyQuality() {
    try {
      if (cfg.lowQuality) localStorage.setItem("video-quality", LOW);
      else if (localStorage.getItem("video-quality") === LOW) localStorage.removeItem("video-quality");
    } catch (_) {}
  }

  // --- Crazy Coins : bonus de points ---
  function claim() {
    const icon = document.querySelector(".claimable-bonus__icon")
      || document.querySelector('.community-points-summary button[aria-label*="onus" i]');
    const btn = icon && (icon.closest("button") || icon);
    if (!btn) return;
    btn.click();
    chrome.storage.local.get("claimed").then(({ claimed = 0 }) => chrome.storage.local.set({ claimed: claimed + 1 }));
  }

  function tick() {
    try {
      if (!onMastu()) { setHide(false); return; }
      if (cfg.autoClaim) claim();
      setHide(cfg.hideVideo);
      document.querySelectorAll("video").forEach(watchVideo);
    } catch (_) {}
  }

  chrome.storage.sync.get(D).then(v => { cfg = v; ready = true; applyQuality(); tick(); });
  chrome.storage.onChanged.addListener((c, area) => {
    if (area !== "sync") return;
    for (const k in c) if (k in D) cfg[k] = c[k].newValue;
    applyQuality();
  });
  setInterval(tick, 2000);
})();
