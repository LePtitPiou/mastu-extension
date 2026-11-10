importScripts("config.js");
const API = self.MASTU_CONFIG.API_BASE_URL;
async function poll() {
  try {
    const result = await fetch(`${API}/updates`).then(r => { if (!r.ok) throw new Error(r.status); return r.json(); });
    const stored = await chrome.storage.local.get(["notifications", "settings", "lastUpdateIds"]);
    const notifications = stored.notifications || [];
    const known = new Set(stored.lastUpdateIds || []);
    const fresh = (result.notifications || []).filter(n => !known.has(n.id));
    for (const n of fresh) {
      notifications.unshift({...n, read: false, date: n.date || new Date().toISOString()});
      if ((stored.settings || {}).desktopNotifications !== false) {
        chrome.notifications.create(n.id, {type: "basic", iconUrl: "icon.png", title: n.title, message: n.message});
      }
    }
    await chrome.storage.local.set({
      notifications: notifications.slice(0, 50),
      lastUpdateIds: [...known, ...fresh.map(n => n.id)].slice(-100)
    });
  } catch (e) { console.warn("Mastu API unavailable", e); }
}
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("mastupoll", {periodInMinutes: Math.max(1, self.MASTU_CONFIG.POLL_MINUTES || 1)});
  poll();
});
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === "mastupoll") poll(); });
