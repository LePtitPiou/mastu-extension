importScripts("config.js");

const ALARM = "mastu-refresh";

function ensureAlarm() {
  chrome.alarms.create(ALARM, { periodInMinutes: REFRESH_MINUTES, delayInMinutes: 0.1 });
}
chrome.runtime.onInstalled.addListener(() => { ensureAlarm(); refresh(); });
chrome.runtime.onStartup.addListener(() => { ensureAlarm(); refresh(); });
chrome.alarms.onAlarm.addListener(a => { if (a.name === ALARM) refresh(); });

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg?.type === "refresh") { refresh().then(() => send({ ok: true })); return true; }
  if (msg?.type === "markRead") {
    chrome.storage.local.get("notifs").then(({ notifs = [] }) =>
      chrome.storage.local.set({ notifs: notifs.map(n => ({ ...n, read: true })) }));
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

async function refresh() {
  let data;
  try {
    const r = await fetch(API_BASE + "/api/data", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
  } catch (_) {
    await chrome.storage.local.set({ error: true });
    return;
  }

  const store = await chrome.storage.local.get(["state", "notifs"]);
  const state = store.state || {};
  const old = store.notifs || [];
  const first = !state.init; // 1er lancement : on mémorise sans notifier
  const settings = { ...DEFAULTS, ...(await chrome.storage.sync.get(null)) };
  const found = [];

  const tw = data.channels.find(c => c.platform === "twitch");
  if (tw?.live && tw.live.id !== state.liveId) {
    found.push({ id: "live:" + tw.live.id, type: "live", title: "Mastu est en live !", text: tw.live.title, url: tw.live.url, ts: Date.parse(tw.live.startedAt) });
  }

  const seen = new Set(state.videoIds || []);
  for (const c of data.channels) {
    if (c.platform === "youtube" && c.latest && !seen.has(c.latest.id)) {
      found.push({ id: "video:" + c.latest.id, type: "video", title: "Nouvelle vidéo • " + c.name, text: c.latest.title, url: c.latest.url, ts: Date.parse(c.latest.publishedAt) });
      seen.add(c.latest.id);
    }
  }

  const a = data.announcement;
  if (a && a.id !== state.announcementId) {
    found.push({ id: "news:" + a.id, type: "news", title: "Annonce", text: a.text, url: a.link || "", ts: Date.parse(a.date) || Date.now() });
  }

  const known = new Set(old.map(n => n.id));
  const fresh = found.filter(n => !known.has(n.id)).map(n => ({ ...n, read: first }));
  const notifs = [...fresh, ...old].sort((x, y) => y.ts - x.ts).slice(0, 30);

  await chrome.storage.local.set({
    data, notifs, error: false, updatedAt: Date.now(),
    state: { init: true, liveId: tw?.live?.id || null, announcementId: a?.id || null, videoIds: [...seen].slice(-50) },
  });

  if (!first && settings.notifChrome) {
    const allowed = { live: settings.notifLive, video: settings.notifVideo, news: settings.notifNews };
    for (const n of fresh) {
      if (!allowed[n.type]) continue;
      chrome.notifications.create(n.id, { type: "basic", iconUrl: "icons/icon128.png", title: n.title, message: n.text || " " });
    }
  }
}
