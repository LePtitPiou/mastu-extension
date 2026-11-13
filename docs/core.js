// Logique commune (extension + site) : lit l'API, détecte les nouveautés, alimente les notifications.
async function mastuRefresh({ local, sync, notify, onLive }) {
  let data;
  try {
    const r = await fetch(API_BASE + "/api/data", { cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    data = await r.json();
    if (!Array.isArray(data.channels)) throw new Error("données invalides");
  } catch (_) { await local.set({ error: true }); return; }

  const store = await local.get(["state", "notifs"]);
  const state = store.state || {};
  let notifs = store.notifs || [];
  const settings = { ...DEFAULTS, ...(await sync.get(null)) };
  const muted = (settings.channelPrefs && settings.channelPrefs.muted) || {};
  const first = !state.init; // 1er lancement : on mémorise sans notifier

  // « Réinitialiser les notifications de tout le monde » lancé depuis le panneau
  const resetAt = Math.max(state.resetAt || 0, data.notifResetAt || 0);
  if ((data.notifResetAt || 0) > (state.resetAt || 0)) notifs = [];

  const found = [];
  const tw = data.channels.find(c => c.platform === "twitch");
  const live = tw && tw.live;
  if (live && live.id !== state.liveId && !muted[tw.id]) {
    found.push({ id: "live:" + live.id, type: "live", title: "Mastu est en live !", text: live.title, url: live.url, ts: Date.parse(live.startedAt) });
  }

  const seen = new Set(state.videoIds || []);
  for (const c of data.channels) {
    if (c.platform === "youtube" && c.latest && !seen.has(c.latest.id)) {
      seen.add(c.latest.id);
      if (!muted[c.id]) found.push({ id: "video:" + c.latest.id, type: "video", title: "Nouvelle vidéo • " + c.name, text: c.latest.title, url: c.latest.url, ts: Date.parse(c.latest.publishedAt) });
    }
  }

  const a = data.announcement;
  if (a && a.id !== state.announcementId) {
    found.push({ id: "news:" + a.id, type: "news", title: "Annonce", text: a.text, url: a.link || "", ts: Date.parse(a.date) || Date.now() });
  }

  const known = new Set(notifs.map(n => n.id));
  const fresh = found.filter(n => !known.has(n.id)).map(n => ({ ...n, read: first }));
  notifs = [...fresh, ...notifs].sort((x, y) => y.ts - x.ts).slice(0, 30);

  await local.set({
    data, notifs, error: false, updatedAt: Date.now(),
    state: {
      init: true, resetAt,
      liveId: live ? live.id : null,
      openedLiveId: live ? live.id : state.openedLiveId || null, // pour n'ouvrir l'onglet qu'une fois par live
      announcementId: a ? a.id : state.announcementId || null,
      videoIds: [...seen].slice(-50),
    },
  });

  if (first) return;
  const allowed = { live: settings.notifLive, video: settings.notifVideo, news: settings.notifNews };
  if (notify && settings.notifChrome) for (const n of fresh) if (allowed[n.type]) await notify(n);
  if (onLive && live && live.id !== state.openedLiveId) await onLive(live, settings);
}
