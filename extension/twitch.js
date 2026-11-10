(async () => {
  const settings = (await chrome.storage.local.get(["settings"])).settings || {};
  let hideStyle;
  function applyHide() {
    if (settings.hidePlayer) {
      if (!hideStyle) {
        hideStyle = document.createElement("style");
        hideStyle.textContent = '[data-a-target="player"], .video-player { visibility:hidden !important; }';
        document.documentElement.appendChild(hideStyle);
      }
    } else if (hideStyle) { hideStyle.remove(); hideStyle = null; }
  }
  applyHide();

  // Bonus de points : interaction limitée au bouton de bonus visible de Twitch.
  // Twitch modifie régulièrement ses sélecteurs ; cette détection est donc best-effort.
  if (!settings.autoClaim) return;
  const claim = () => {
    const candidates = [...document.querySelectorAll('button,[role="button"]')];
    const button = candidates.find(el => {
      const text = (el.innerText || el.getAttribute("aria-label") || "").toLowerCase();
      const visible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
      return visible && (text.includes("claim bonus") || text.includes("récupérer le bonus") || text.includes("bonus de points"));
    });
    if (button && !button.disabled) button.click();
  };
  const observer = new MutationObserver(claim);
  observer.observe(document.documentElement, {childList: true, subtree: true});
  claim();
})();
