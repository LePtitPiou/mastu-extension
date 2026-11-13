const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const nf = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const S = {
  data: null, notifs: [], settings: { ...DEFAULTS }, open: new Set(),
  claimed: 0, updatedAt: 0, error: false,
  slides: [], slide: 0, guests: [], guest: 0, liveStart: null, sig: {},
};

/* ---------- utilitaires ---------- */
function ago(ts) {
  const m = Math.round((ts - Date.now()) / 60000);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  return Math.abs(h) < 24 ? rtf.format(h, "hour") : rtf.format(Math.round(h / 24), "day");
}
function setImg(img, src) { img.hidden = !src; if (src) img.src = src; }
const ping = () => { try { chrome.runtime.sendMessage({ type: "refresh" })?.catch?.(() => {}); } catch (_) {} };

/* ---------- préférences de chaînes (ordre, visibilité, notifications) ---------- */
const prefs = () => ({ order: [], hidden: {}, muted: {}, ...(S.settings.channelPrefs || {}) });
function orderedChannels(all = false) {
  const chans = S.data?.channels || [], p = prefs();
  const rank = id => { const i = p.order.indexOf(id); return i < 0 ? 1000 + chans.findIndex(c => c.id === id) : i; };
  const sorted = [...chans].sort((a, b) => rank(a.id) - rank(b.id));
  return all ? sorted : sorted.filter(c => !p.hidden[c.id]);
}
const savePrefs = next => chrome.storage.sync.set({ channelPrefs: next });
function setPref(key, id, value) {
  const p = prefs();
  p[key] = { ...p[key], [id]: value };
  return savePrefs(p);
}
function movePref(id, d) {
  const ids = orderedChannels(true).map(c => c.id), i = ids.indexOf(id), j = i + d;
  if (i < 0 || j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  return savePrefs({ ...prefs(), order: ids });
}

/* ---------- chargement ---------- */
async function load() {
  const [l, s] = await Promise.all([
    chrome.storage.local.get(["data", "notifs", "claimed", "updatedAt", "error"]),
    chrome.storage.sync.get(null),
  ]);
  S.data = l.data || null;
  S.notifs = l.notifs || [];
  S.claimed = l.claimed || 0;
  S.updatedAt = l.updatedAt || 0;
  S.error = !!l.error;
  S.settings = { ...DEFAULTS, ...s };
  applySettings();
  render();
}
function render() {
  renderHome();
  renderChannels();
  renderNotifs();
  renderPrefs();
  $("#banner-error").hidden = !S.error;
  const fc = $("#farmer-claimed");
  if (fc) fc.textContent = S.claimed;
  $("#settings-updated").textContent = S.updatedAt ? new Date(S.updatedAt).toLocaleTimeString("fr-FR") : "—";
}

/* ---------- accueil ---------- */
function renderHome() {
  const d = S.data, a = d?.announcement;
  $("#announce-text").textContent = a?.text || "Aucune annonce pour le moment.";
  const al = $("#announce-link");
  al.hidden = !a?.link;
  if (a?.link) al.href = a.link;
  $("#announce-date").textContent = a?.date ? new Date(a.date).toLocaleString("fr-FR") : "";

  const vis = orderedChannels();
  const twitch = vis.find(c => c.platform === "twitch");
  renderLive(twitch);
  S.slides = vis.filter(c => c.platform === "youtube" && c.latest);
  renderSlide();
  $("#home-empty").hidden = !!twitch?.live || S.slides.length > 0;
}

function renderLive(twitch) {
  const live = twitch?.live;
  $("#live").hidden = !live;
  if (!live) {
    S.guests = []; S.liveStart = null;
    const pl = $("#live-player"); // site : on arrête le lecteur quand le live se termine
    if (pl && pl.getAttribute("src")) { pl.removeAttribute("src"); delete pl.dataset.channel; }
    return;
  }

  $("#live-link").href = live.url;
  S.liveStart = Date.parse(live.startedAt);

  // site web : lecteur Twitch sans son ; extension : aperçu actualisé
  const wrap = $("#live-player-wrap");
  if (wrap) {
    const pl = $("#live-player");
    wrap.hidden = false;
    $("#live-media").hidden = true;
    if (pl.dataset.channel !== twitch.handle) {
      pl.dataset.channel = twitch.handle;
      pl.src = `https://player.twitch.tv/?channel=${encodeURIComponent(twitch.handle)}&parent=${location.hostname}&muted=true&autoplay=true`;
    }
  } else {
    setImg($("#live-thumb"), live.thumbnail ? live.thumbnail + "?t=" + Math.floor(Date.now() / 30000) : "");
  }

  setImg($("#live-logo"), twitch.logo);
  $("#live-name").textContent = twitch.name;
  S.guests = live.guests || [];
  const w = $("#live-with");
  w.hidden = !S.guests.length;
  if (S.guests.length) w.textContent = "Avec " + S.guests.slice(0, 2).map(g => g.name).join(", ") + (S.guests.length > 2 ? "…" : "");
  renderGuest();

  $("#live-title").textContent = live.title;
  $("#live-count").textContent = `${nf.format(live.viewers)} spectateurs`;
  tickDuration();
}
// avatar des invités en bas à droite de la photo Twitch (du plus au moins suivi), défile s'il y en a plusieurs
function renderGuest() {
  const img = $("#live-guest"), g = S.guests;
  if (!g.length) { img.hidden = true; return; }
  const cur = g[((S.guest % g.length) + g.length) % g.length];
  setImg(img, cur.logo);
  img.alt = cur.name;
}
function tickDuration() {
  if (!S.liveStart) return;
  const s = Math.max(0, Math.floor((Date.now() - S.liveStart) / 1000)), p = x => String(x).padStart(2, "0");
  $("#live-duration").textContent = `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

// défilement des dernières vidéos
function renderSlide() {
  const list = S.slides;
  $("#videos").hidden = !list.length;
  if (!list.length) return;
  S.slide = ((S.slide % list.length) + list.length) % list.length;
  const c = list[S.slide], v = c.latest;
  $("#slide-link").href = v.url;
  setImg($("#slide-thumb"), v.thumbnail);
  setImg($("#slide-logo"), c.logo);
  $("#slide-channel").textContent = c.name;
  $("#slide-title").textContent = v.title;
  $("#slide-views").textContent = `${nf.format(v.views)} vues`;
  $("#slide-pos").textContent = `${S.slide + 1} / ${list.length}`;
}
let timer;
function startTimer() {
  clearInterval(timer);
  timer = setInterval(() => { S.slide++; S.guest++; renderSlide(); renderGuest(); }, 3000);
}
$("#slide-prev").addEventListener("click", () => { S.slide--; renderSlide(); startTimer(); });
$("#slide-next").addEventListener("click", () => { S.slide++; renderSlide(); startTimer(); });

/* ---------- chaînes ---------- */
function renderChannels() {
  const chans = orderedChannels(), sig = JSON.stringify(chans);
  if (sig === S.sig.channels) return;
  S.sig.channels = sig;
  const tpl = $("#tpl-channel");
  $("#channels-list").replaceChildren(...chans.map(c => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = c.id;
    setImg($(".channel-logo", li), c.logo);
    $(".channel-name", li).textContent = c.name;
    $(".channel-live", li).hidden = !c.live;
    const subs = $(".channel-subs", li);
    subs.hidden = c.platform === "twitch" || c.subscribers == null;
    if (!subs.hidden) subs.textContent = `${nf.format(c.subscribers)} abonnés`;
    $(".channel-open", li).href = c.url;

    $(".channel-details", li).hidden = !S.open.has(c.id);
    setImg($(".channel-banner", li), c.banner);
    setImg($(".channel-logo-big", li), c.logo);
    $(".channel-desc", li).textContent = c.description || "";

    let item = null, label = "", meta = "";
    if (c.platform === "twitch") {
      if (c.live) { item = c.live; label = "En direct"; meta = `${nf.format(c.live.viewers)} spectateurs`; }
      else if (c.lastVod) { item = c.lastVod; label = "Hors ligne — dernière rediff"; meta = `${nf.format(c.lastVod.views)} vues`; }
      else label = "Hors ligne";
    } else if (c.latest) {
      item = c.latest; label = "Dernière vidéo"; meta = `${nf.format(c.latest.views)} vues`;
    }
    $(".channel-video-label", li).textContent = label;
    const v = $(".channel-video", li);
    v.hidden = !item;
    if (item) {
      v.href = item.url;
      setImg($(".channel-video-thumb", v), item.thumbnail);
      $(".channel-video-title", v).textContent = item.title;
      $(".channel-video-meta", v).textContent = meta;
    }
    return li;
  }));
}
$("#channels-list").addEventListener("click", e => {
  if (e.target.closest(".channel-open")) return;
  const bar = e.target.closest(".channel-bar");
  if (!bar) return;
  const li = bar.closest(".channel"), det = $(".channel-details", li);
  det.hidden = !det.hidden;
  det.hidden ? S.open.delete(li.dataset.id) : S.open.add(li.dataset.id);
});
$("#channels-list").addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("channel-bar")) { e.preventDefault(); e.target.click(); }
});

/* ---------- notifications ---------- */
function renderNotifs() {
  const tpl = $("#tpl-notif"), unread = S.notifs.some(n => !n.read);
  $("#notif-empty").hidden = S.notifs.length > 0;
  $("#notif-dot").hidden = !unread;
  $("#btn-mark-read").hidden = !unread;
  $("#notif-list").replaceChildren(...S.notifs.map(n => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.classList.toggle("notif--unread", !n.read);
    li.dataset.type = n.type;
    const a = $(".notif-link", li);
    if (n.url) a.href = n.url; else a.removeAttribute("href");
    $(".notif-title", li).textContent = n.title;
    $(".notif-text", li).textContent = n.text || "";
    $(".notif-time", li).textContent = ago(n.ts);
    return li;
  }));
}
const markAllRead = () => chrome.runtime.sendMessage({ type: "markRead" });
function closeNotifs() {
  if ($("#notif-panel").hidden) return;
  $("#notif-panel").hidden = true;
  if (S.notifs.some(n => !n.read)) markAllRead();
}
$("#btn-notifs").addEventListener("click", () => {
  if ($("#notif-panel").hidden) { $("#notif-panel").hidden = false; renderNotifs(); }
  else closeNotifs();
});
$("#btn-mark-read").addEventListener("click", markAllRead);

/* ---------- navigation ---------- */
function showPage(name) {
  closeNotifs();
  $$(".page").forEach(p => { p.hidden = p.id !== "page-" + name; });
  $$("#nav button").forEach(b => b.classList.toggle("active", b.dataset.page === name));
}
$$("#nav button").forEach(b => b.addEventListener("click", () => showPage(b.dataset.page)));
$("#btn-settings").addEventListener("click", () => showPage("settings"));

/* ---------- réglages ---------- */
function applySettings() {
  $$("[data-setting]").forEach(el => {
    const v = S.settings[el.dataset.setting];
    if (el.type === "checkbox") el.checked = !!v; else el.value = v;
  });
  const t = S.settings.theme;
  document.documentElement.dataset.theme = t === "auto" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : t;
}
$$("[data-setting]").forEach(el => el.addEventListener("change", () =>
  chrome.storage.sync.set({ [el.dataset.setting]: el.type === "checkbox" ? el.checked : el.value })));

function renderPrefs() {
  const chans = orderedChannels(true), p = prefs(), sig = JSON.stringify([chans.map(c => [c.id, c.name, c.logo]), p]);
  if (sig === S.sig.prefs) return;
  S.sig.prefs = sig;
  const tpl = $("#tpl-pref");
  $("#prefs-list").replaceChildren(...chans.map((c, i) => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    setImg($(".pref-logo", li), c.logo);
    $(".pref-name", li).textContent = c.name;
    const up = $(".pref-up", li), down = $(".pref-down", li);
    up.disabled = i === 0;
    down.disabled = i === chans.length - 1;
    up.addEventListener("click", () => movePref(c.id, -1));
    down.addEventListener("click", () => movePref(c.id, 1));
    const vis = $(".pref-visible", li), notif = $(".pref-notif", li);
    vis.checked = !p.hidden[c.id];
    notif.checked = !p.muted[c.id];
    vis.addEventListener("change", () => setPref("hidden", c.id, !vis.checked));
    notif.addEventListener("change", () => setPref("muted", c.id, !notif.checked));
    return li;
  }));
}
$("#btn-refresh").addEventListener("click", ping);
const testBtn = $("#btn-test-notif");
if (testBtn) testBtn.addEventListener("click", () => chrome.runtime.sendMessage({ type: "testNotif" }));
$("#settings-version").textContent = chrome.runtime.getManifest().version;

/* ---------- démarrage ---------- */
chrome.storage.onChanged.addListener(load);
showPage("home");
load();
ping();
startTimer();
setInterval(tickDuration, 1000);
setInterval(() => { if (!document.hidden) ping(); }, 15000); // le live apparaît en moins de ~15 s
