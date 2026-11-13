importScripts("config.js", "core.js");

const ALARM = "mastu-refresh";

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: REFRESH_MINUTES, delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); refresh(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refresh(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) refresh(); });

// Notification Google Chrome
function notify(n) {
  chrome.notifications.create(n.id, {
    type: "basic", iconUrl: "icons/icon128.png", title: n.title, message: n.text || " ",
    priority: 2, requireInteraction: n.type === "live",
  });
}

// Live démarré : ouvre twitch.tv/mastu dans un nouvel onglet (si l'option est activée et qu'il n'est pas déjà ouvert)
async function onLive(live, settings) {
  if (!settings.autoOpenLive) return;
  const tabs = await chrome.tabs.query({ url: "https://www.twitch.tv/mastu*" }).catch(() => []);
  if (!tabs.length) chrome.tabs.create({ url: live.url, active: true });
}

const refresh = () => mastuRefresh({ local: chrome.storage.local, sync: chrome.storage.sync, notify, onLive });

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg?.type === "refresh") { refresh().then(() => send({ ok: true })); return true; }
  if (msg?.type === "markRead") {
    chrome.storage.local.get("notifs").then(({ notifs = [] }) =>
      chrome.storage.local.set({ notifs: notifs.map(n => ({ ...n, read: true })) }));
  }
  if (msg?.type === "testNotif") {
    notify({ id: "test:" + Date.now(), type: "news", title: "Notification de test", text: "Les notifications Chrome fonctionnent." });
  }
});

chrome.storage.onChanged.addListener((c, area) => {
  if (area === "local" && c.notifs) updateBadge(c.notifs.newValue || []);
});
function updateBadge(notifs) {
  const n = notifs.filter(x => !x.read).length;
  chrome.action.setBadgeText({ text: n ? String(n) : "" });
  chrome.action.setBadgeBackgroundColor({ color: "#e53935" });
}

chrome.notifications.onClicked.addListener(async id => {
  const { notifs = [] } = await chrome.storage.local.get("notifs");
  const n = notifs.find(x => x.id === id);
  if (n?.url) chrome.tabs.create({ url: n.url });
  chrome.notifications.clear(id);
});
