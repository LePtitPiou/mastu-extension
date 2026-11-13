// Version web (GitHub Pages) : fournit à popup.js les mêmes "chrome.*" que l'extension,
// avec localStorage à la place de chrome.storage, et la même logique que background.js.
(() => {
  if (window.chrome && chrome.storage) return; // dans l'extension : rien à faire

  const listeners = [];
  const read = n => { try { return JSON.parse(localStorage.getItem("mastu:" + n) || "{}"); } catch (_) { return {}; } };
  const area = name => ({
    async get(keys) {
      const all = read(name);
      if (keys == null) return { ...all };
      if (typeof keys === "string") keys = [keys];
      if (Array.isArray(keys)) return Object.fromEntries(keys.filter(k => k in all).map(k => [k, all[k]]));
      return { ...keys, ...Object.fromEntries(Object.keys(keys).filter(k => k in all).map(k => [k, all[k]])) };
    },
    async set(obj) {
      const all = read(name), changes = {};
      for (const k in obj) { changes[k] = { oldValue: all[k], newValue: obj[k] }; all[k] = obj[k]; }
      try { localStorage.setItem("mastu:" + name, JSON.stringify(all)); } catch (_) {}
      listeners.forEach(fn => fn(changes, name));
    },
  });
  const local = area("local"), sync = area("sync");

  async function refresh() {
    let data;
    try {
      const r = await fetch(API_BASE + "/api/data", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status);
      data = await r.json();
    } catch (_) { await local.set({ error: true }); return; }

    const store = await local.get(["state", "notifs"]);
    const state = store.state || {};
    const old = store.notifs || [];
    const first = !state.init;
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
    await local.set({
      data, notifs, error: false, updatedAt: Date.now(),
      state: { init: true, liveId: tw?.live?.id || null, announcementId: a?.id || null, videoIds: [...seen].slice(-50) },
    });
  }

  async function markRead() {
    const { notifs = [] } = await local.get("notifs");
    await local.set({ notifs: notifs.map(n => ({ ...n, read: true })) });
  }

  window.chrome = {
    storage: { local, sync, onChanged: { addListener: fn => listeners.push(fn) } },
    runtime: {
      getManifest: () => ({ version: "web" }),
      sendMessage: msg => msg?.type === "refresh" ? refresh() : msg?.type === "markRead" ? markRead() : Promise.resolve(),
    },
  };

  setInterval(refresh, REFRESH_MINUTES * 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
