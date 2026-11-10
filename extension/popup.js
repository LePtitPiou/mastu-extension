const API = window.MASTU_CONFIG.API_BASE_URL;
const $ = (id) => document.getElementById(id);
let state = { notifications: [], settings: {} };

async function api(path) {
  const response = await fetch(`${API}${path}`);
  if (!response.ok) throw new Error(`API ${response.status}`);
  return response.json();
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function setPage(pageId) {
  document.querySelectorAll(".page").forEach(p => p.hidden = p.id !== pageId);
  document.querySelectorAll(".navbar button").forEach(b => b.classList.toggle("active", b.dataset.page === pageId));
}
function mediaMarkup(item) {
  if (!item) return "<p>Aucune vidéo ou aucun live disponible pour le moment.</p>";
  if (item.type === "live") return `
    <a class="media-card" href="${escapeHtml(item.url)}" target="_blank">
      <span class="badge-live">● LIVE</span>
      <img class="media-thumb" src="${escapeHtml(item.thumbnail || "")}" alt="">
      <h3>${escapeHtml(item.title)}</h3>
      <p>${escapeHtml(item.channelName || "Mastu")} · ${escapeHtml(item.viewers ?? 0)} spectateurs</p>
      <p class="meta">En direct depuis ${escapeHtml(item.duration || "maintenant")}</p>
    </a>`;
  return `<a class="media-card" href="${escapeHtml(item.url)}" target="_blank">
    <img class="media-thumb" src="${escapeHtml(item.thumbnail || "")}" alt="">
    <p class="meta">${escapeHtml(item.channelName)} · ${escapeHtml(item.handle)}</p>
    <h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.views ?? 0)} vues</p>
  </a>`;
}
async function loadHome() {
  const [announcement, current] = await Promise.all([api("/announcement"), api("/current")]);
  $("announcement").innerHTML = `<h3>${escapeHtml(announcement.title || "Annonce")}</h3><p>${escapeHtml(announcement.message || "")}</p>` +
    (announcement.url ? `<a href="${escapeHtml(announcement.url)}" target="_blank">En savoir plus</a>` : "");
  $("currentMedia").innerHTML = mediaMarkup(current.item);
}
async function loadChannels() {
  const data = await api("/channels");
  $("channelsList").innerHTML = data.channels.map((c, i) => `
    <div class="channel-row">
      <img class="channel-logo" src="${escapeHtml(c.avatar || "")}" alt="">
      <div class="channel-main" data-expand="${i}">
        <strong>${escapeHtml(c.name)}</strong> <span>${c.platform === "twitch" ? (c.live ? '<b class="badge-live">LIVE</b>' : '<span class="meta">Hors ligne</span>') : ""}</span>
        <div class="meta">${escapeHtml(c.handle)} · ${escapeHtml(c.subscribersLabel || "Abonnés indisponibles")}</div>
      </div>
      <a href="${escapeHtml(c.url)}" target="_blank" aria-label="Ouvrir la chaîne">↗</a>
    </div>
    <div class="channel-details" id="details-${i}" hidden>
      ${c.banner ? `<img class="channel-banner" src="${escapeHtml(c.banner)}" alt="">` : ""}
      <p>${escapeHtml(c.description || "")}</p>
      ${mediaMarkup(c.latest || c.lastStream)}
    </div>`).join("");
  document.querySelectorAll("[data-expand]").forEach(el => el.addEventListener("click", () => {
    const panel = $(`details-${el.dataset.expand}`); panel.hidden = !panel.hidden;
  }));
}
async function loadNotifications() {
  const stored = await chrome.storage.local.get(["notifications"]);
  state.notifications = stored.notifications || [];
  const unread = state.notifications.filter(n => !n.read);
  $("unreadDot").hidden = unread.length === 0;
  $("notificationsList").innerHTML = state.notifications.slice(0, 15).map(n =>
    `<article class="notification ${n.read ? "" : "unread"}"><strong>${escapeHtml(n.title)}</strong><p>${escapeHtml(n.message)}</p><span class="meta">${escapeHtml(new Date(n.date).toLocaleString("fr-FR"))}</span></article>`
  ).join("") || "<p>Aucune notification.</p>";
}
async function loadSettings() {
  const s = (await chrome.storage.local.get(["settings"])).settings || {};
  state.settings = s;
  $("desktopNotifications").checked = s.desktopNotifications !== false;
  $("autoClaim").checked = !!s.autoClaim;
  $("hidePlayer").checked = !!s.hidePlayer;
  $("darkMode").checked = s.darkMode !== false;
  document.body.classList.toggle("light", s.darkMode === false);
}
document.querySelectorAll(".navbar button").forEach(b => b.addEventListener("click", async () => {
  setPage(b.dataset.page);
  if (b.dataset.page === "channelsPage") await loadChannels().catch(showError);
  if (b.dataset.page === "settingsPage") await loadSettings();
}));
$("notificationsButton").addEventListener("click", async () => {
  $("notificationsPanel").hidden = !$("notificationsPanel").hidden;
  await loadNotifications();
});
$("markAllRead").addEventListener("click", async () => {
  state.notifications = state.notifications.map(n => ({...n, read: true}));
  await chrome.storage.local.set({notifications: state.notifications}); await loadNotifications();
});
$("settingsButton").addEventListener("click", async () => { setPage("settingsPage"); await loadSettings(); });
$("saveSettings").addEventListener("click", async () => {
  const settings = {
    desktopNotifications: $("desktopNotifications").checked,
    autoClaim: $("autoClaim").checked,
    hidePlayer: $("hidePlayer").checked,
    darkMode: $("darkMode").checked
  };
  await chrome.storage.local.set({settings});
  document.body.classList.toggle("light", !settings.darkMode);
  $("settingsStatus").textContent = "Réglages enregistrés.";
});
function showError(error) {
  console.error(error);
  $("currentMedia").textContent = "Impossible de charger les données. Vérifie l'URL de l'API Render.";
}
(async () => {
  try { await loadHome(); } catch (e) { showError(e); }
  await loadNotifications();
  await loadSettings();
})();
