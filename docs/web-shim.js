// Version web (GitHub Pages) : fournit à popup.js les mêmes "chrome.*" que l'extension,
// avec localStorage à la place de chrome.storage. La logique des notifications est dans core.js.
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

  const refresh = () => mastuRefresh({ local, sync });
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
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
})();
