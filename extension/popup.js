const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const nf = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const S = { data: null, notifs: [], settings: { ...DEFAULTS }, open: new Set(), claimed: 0, updatedAt: 0, error: false };

/* ---------- utilitaires ---------- */
function ago(ts) {
  const m = Math.round((ts - Date.now()) / 60000);
  if (Math.abs(m) < 60) return rtf.format(m, "minute");
  const h = Math.round(m / 60);
  return Math.abs(h) < 24 ? rtf.format(h, "hour") : rtf.format(Math.round(h / 24), "day");
}
function setImg(img, src) { img.hidden = !src; if (src) img.src = src; }
function fillLogos(box, urls) {
  const tpl = $("#tpl-logo");
  box.replaceChildren(...urls.filter(Boolean).map(u => {
    const n = tpl.content.firstElementChild.cloneNode(true);
    n.src = u;
    return n;
  }));
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
  $("#banner-error").hidden = !S.error;
  $("#farmer-claimed").textContent = S.claimed;
  $("#settings-updated").textContent = S.updatedAt ? new Date(S.updatedAt).toLocaleTimeString("fr-FR") : "—";
}

/* ---------- accueil ---------- */
function renderHome() {
  const d = S.data, a = d?.announcement, now = d?.now;
  $("#announce-text").textContent = a?.text || "Aucune annonce pour le moment.";
  const al = $("#announce-link");
  al.hidden = !a?.link;
  if (a?.link) al.href = a.link;
  $("#announce-date").textContent = a?.date ? new Date(a.date).toLocaleString("fr-FR") : "";

  $("#now-empty").hidden = !!now;
  $("#now-link").hidden = !now;
  if (!now) return;

  const live = now.type === "live";
  const item = live ? now.live : now.video;
  const people = live ? [now.channel, ...(now.live.participants || [])] : [now.channel];

  $("#now-link").href = item.url;
  fillLogos($("#now-logos"), people.map(p => p.logo));
  $("#now-channel").textContent = people.map(p => p.name).join(" × ");
  $("#now-handle").textContent = people.map(p => p.handle).join(" × ");
  setImg($("#now-thumb"), live ? item.thumbnail + "?t=" + Math.floor(Date.now() / 60000) : item.thumbnail);
  $("#now-title").textContent = item.title;
  $("#now-live").hidden = !live;
  $("#now-count").textContent = live ? `${nf.format(item.viewers)} spectateurs` : `${nf.format(item.views)} vues`;
  $("#now-duration").hidden = !live;
  tickDuration();
}
function tickDuration() {
  const n = S.data?.now;
  if (n?.type !== "live") return;
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(n.live.startedAt)) / 1000));
  const p = x => String(x).padStart(2, "0");
  $("#now-duration").textContent = `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/* ---------- chaînes ---------- */
function renderChannels() {
  const tpl = $("#tpl-channel");
  $("#channels-list").replaceChildren(...(S.data?.channels || []).map(c => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = c.id;
    setImg($(".channel-logo", li), c.logo);
    $(".channel-name", li).textContent = c.name;
    $(".channel-live", li).hidden = !c.live;
    const subs = $(".channel-subs", li);
    subs.hidden = c.platform === "twitch" || c.subscribers == null;
    if (c.subscribers != null) subs.textContent = `${nf.format(c.subscribers)} abonnés`;
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
  const tpl = $("#tpl-notif");
  $("#notif-empty").hidden = S.notifs.length > 0;
  $("#notif-dot").hidden = !S.notifs.some(n => !n.read);
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
function closeNotifs() {
  if ($("#notif-panel").hidden) return;
  $("#notif-panel").hidden = true;
  if (S.notifs.some(n => !n.read)) chrome.runtime.sendMessage({ type: "markRead" });
}
$("#btn-notifs").addEventListener("click", () => {
  if ($("#notif-panel").hidden) { $("#notif-panel").hidden = false; renderNotifs(); }
  else closeNotifs();
});

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
$("#btn-refresh").addEventListener("click", () => chrome.runtime.sendMessage({ type: "refresh" }));
$("#settings-version").textContent = chrome.runtime.getManifest().version;

/* ---------- démarrage ---------- */
chrome.storage.onChanged.addListener(load);
showPage("home");
load();
chrome.runtime.sendMessage({ type: "refresh" });
setInterval(tickDuration, 1000);