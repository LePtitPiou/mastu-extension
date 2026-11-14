const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const nf = new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 });
const rtf = new Intl.RelativeTimeFormat("fr", { numeric: "auto" });
const S = {
  data: null, notifs: [], settings: { ...DEFAULTS }, open: new Set(),
  claimed: 0, updatedAt: 0, error: false,
  slides: [], slide: 0, hover: false, busy: false, justDragged: false,
  guests: [], guest: 0, liveStart: null, sig: {},
};

/* ---------- utilitaires ---------- */
const mod = (i, n) => ((i % n) + n) % n;
const canAnimate = el => typeof el.animate === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
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
function movePref(id, d) { // clavier : flèches haut / bas sur la poignée
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
  const box = $("#announce-text"), sig = a ? a.id + "|" + (a.html || a.text) : "none";
  if (sig !== S.sig.announce) { // annonce mise en forme, reconstituée à l'identique (HTML nettoyé)
    S.sig.announce = sig;
    box.classList.toggle("plain", !a?.html);
    if (a?.html) setRich(box, a.html); else box.textContent = a?.text || "Aucune annonce pour le moment.";
  }
  const al = $("#announce-link");
  al.hidden = !a?.link;
  if (a?.link) al.href = a.link;
  $("#announce-date").textContent = a?.date ? new Date(a.date).toLocaleString("fr-FR") : "";

  const vis = orderedChannels();
  const twitch = vis.find(c => c.platform === "twitch");
  renderLive(twitch);
  setSlides(vis.filter(c => c.platform === "youtube" && c.latest));
  $("#home-empty").hidden = !!twitch?.live || S.slides.length > 0;
}

// Retransmission : lecteur Twitch officiel, muet, sans commandes (controls:false), clics bloqués par la feuille de style
function mountPlayer(channel) {
  const box = $("#live-player");
  if (!box || box.dataset.channel === channel) return;
  box.dataset.channel = channel;
  box.replaceChildren();
  if (window.Twitch && Twitch.Player) {
    new Twitch.Player("live-player", { channel, parent: [location.hostname], muted: true, autoplay: true, controls: false, width: "100%", height: "100%" });
  } else { // repli si le script Twitch n'a pas pu se charger
    const f = document.createElement("iframe");
    f.src = `https://player.twitch.tv/?channel=${encodeURIComponent(channel)}&parent=${location.hostname}&muted=true&autoplay=true&controls=false`;
    f.title = "Retransmission du live (sans son)";
    f.allow = "autoplay";
    box.append(f);
  }
}
function unmountPlayer() {
  const box = $("#live-player");
  if (!box) return;
  box.replaceChildren();
  delete box.dataset.channel;
}

function renderLive(twitch) {
  const live = twitch?.live;
  $("#live").hidden = !live;
  if (!live) { S.guests = []; S.liveStart = null; unmountPlayer(); return; }

  $("#live-link").href = live.url;
  S.liveStart = Date.parse(live.startedAt);

  // site web : retransmission du live sans commandes et sans son ; extension : aperçu actualisé
  if ($("#live-player-wrap")) {
    $("#live-player-wrap").hidden = false;
    $("#live-media").hidden = true;
    $("#live-player-open").href = live.url;
    mountPlayer(twitch.handle);
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
function renderGuest(animate) {
  const img = $("#live-guest"), g = S.guests;
  if (!g.length) { img.hidden = true; return; }
  const cur = g[mod(S.guest, g.length)];
  const changed = img.dataset.login !== cur.handle;
  img.dataset.login = cur.handle;
  setImg(img, cur.logo);
  img.alt = cur.name;
  if (animate && changed && canAnimate(img)) {
    img.animate([{ opacity: 0, transform: "scale(.5)" }, { opacity: 1, transform: "scale(1)" }], { duration: 350, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
}
function tickDuration() {
  if (!S.liveStart) return;
  const s = Math.max(0, Math.floor((Date.now() - S.liveStart) / 1000)), p = x => String(x).padStart(2, "0");
  $("#live-duration").textContent = `${Math.floor(s / 3600)}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/* ---------- carrousel : les vidéos se poussent, points, glisse au doigt ---------- */
const SLIDE_MS = 3000, PUSH_MS = 380;
let timer = null, barAnim = null, drag = null;

function makeSlide(idx) {
  const c = S.slides[mod(idx, S.slides.length)], v = c.latest;
  const el = $("#tpl-slide").content.firstElementChild.cloneNode(true);
  $(".slide-card", el).href = v.url;
  setImg($(".slide-thumb", el), v.thumbnail);
  setImg($(".slide-logo", el), c.logo);
  $(".slide-channel", el).textContent = c.name;
  $(".slide-title", el).textContent = v.title;
  $(".slide-views", el).textContent = `${nf.format(v.views)} vues`;
  return el;
}
function buildTrack() {
  const n = S.slides.length, track = $("#slide-track");
  if (!n) { track.replaceChildren(); return; }
  S.slide = mod(S.slide, n);
  if (n === 1) { track.replaceChildren(makeSlide(0)); track.style.transform = "none"; }
  else { track.replaceChildren(makeSlide(S.slide - 1), makeSlide(S.slide), makeSlide(S.slide + 1)); track.style.transform = "translateX(-100%)"; }
  renderDots();
}
function renderDots() {
  const n = S.slides.length, tpl = $("#tpl-dot");
  $("#slide-dots").replaceChildren(...S.slides.map((_, i) => {
    const b = tpl.content.firstElementChild.cloneNode(true);
    b.setAttribute("aria-label", `Vidéo ${i + 1} sur ${n}`);
    b.classList.toggle("active", i === S.slide);
    b.addEventListener("click", () => goTo(i));
    return b;
  }));
}
function updateDots(active = S.slide) {
  $$("#slide-dots .dot").forEach((b, i) => b.classList.toggle("active", i === mod(active, S.slides.length)));
}
function setSlides(list) {
  const sig = JSON.stringify(list.map(c => [c.id, c.latest.id, c.latest.title, c.latest.views, c.latest.thumbnail, c.logo, c.name]));
  S.slides = list;
  $("#videos").hidden = !list.length;
  $("#slide-nav").hidden = $("#slide-progress").hidden = list.length < 2;
  if (!list.length) { stopTimer(); S.sig.slides = null; return; }
  if (sig !== S.sig.slides && !S.busy && !drag) { S.sig.slides = sig; buildTrack(); }
  if (!timer && !S.hover) startTimer();
}

function stopTimer() { clearTimeout(timer); timer = null; barAnim?.cancel(); barAnim = null; }
function startTimer() {
  stopTimer();
  if (S.slides.length < 2 || S.hover || S.busy || drag) return;
  const bar = $("#slide-bar");
  if (canAnimate(bar)) barAnim = bar.animate([{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }], { duration: SLIDE_MS, easing: "linear", fill: "forwards" });
  timer = setTimeout(() => go(1), SLIDE_MS);
}

// pousse la vidéo actuelle hors du cadre : d = +1 (la suivante arrive de la droite) ou -1 (de la gauche)
function pushTo(target, d, fromPx = 0) {
  const n = S.slides.length;
  if (n < 2 || S.busy) return;
  S.busy = true;
  stopTimer();
  const track = $("#slide-track");
  if (target !== S.slide + d) track.children[d > 0 ? 2 : 0].replaceWith(makeSlide(target)); // saut direct via les points
  updateDots(target);
  const finish = () => { S.slide = mod(target, n); buildTrack(); S.busy = false; startTimer(); };
  if (canAnimate(track)) {
    const an = track.animate(
      [{ transform: `translateX(calc(-100% + ${fromPx}px))` }, { transform: `translateX(${-100 - d * 100}%)` }],
      { duration: PUSH_MS, easing: "cubic-bezier(.22,.8,.24,1)", fill: "forwards" });
    an.onfinish = () => { an.cancel(); finish(); };
  } else finish();
}
const go = d => pushTo(S.slide + d, d);
const goTo = i => { if (i !== S.slide) pushTo(i, i > S.slide ? 1 : -1); };
$("#slide-prev").addEventListener("click", () => go(-1));
$("#slide-next").addEventListener("click", () => go(1));
$("#videos").addEventListener("mouseenter", () => { S.hover = true; stopTimer(); });
$("#videos").addEventListener("mouseleave", () => { S.hover = false; startTimer(); });

// glisser avec le doigt ou la souris
const vp = $("#slide-viewport");
vp.addEventListener("pointerdown", e => {
  if (S.slides.length < 2 || S.busy || e.button > 0) return;
  drag = { x: e.clientX, dx: 0, id: e.pointerId, moved: false };
  stopTimer();
});
vp.addEventListener("pointermove", e => {
  if (!drag || e.pointerId !== drag.id) return;
  drag.dx = e.clientX - drag.x;
  if (!drag.moved && Math.abs(drag.dx) > 6) { drag.moved = true; vp.setPointerCapture?.(e.pointerId); vp.classList.add("dragging"); }
  if (drag.moved) $("#slide-track").style.transform = `translateX(calc(-100% + ${drag.dx}px))`;
});
function endDrag(e) {
  if (!drag || e.pointerId !== drag.id) return;
  const { dx, moved } = drag;
  drag = null;
  vp.classList.remove("dragging");
  if (!moved) { startTimer(); return; }
  S.justDragged = true;
  setTimeout(() => { S.justDragged = false; }, 60);
  if (Math.abs(dx) > Math.min(60, (vp.clientWidth || 300) * 0.2)) { const d = dx < 0 ? 1 : -1; pushTo(S.slide + d, d, dx); }
  else { // pas assez loin : retour en place
    const track = $("#slide-track");
    track.style.transform = "translateX(-100%)";
    if (canAnimate(track)) track.animate([{ transform: `translateX(calc(-100% + ${dx}px))` }, { transform: "translateX(-100%)" }], { duration: 200, easing: "ease-out" });
    startTimer();
  }
}
vp.addEventListener("pointerup", endDrag);
vp.addEventListener("pointercancel", endDrag);
vp.addEventListener("click", e => { if (S.justDragged) { e.preventDefault(); e.stopPropagation(); } }, true); // un glissé n'ouvre pas la vidéo

/* ---------- chaînes ---------- */
function renderChannels() {
  const chans = orderedChannels(), sig = JSON.stringify(chans);
  if (sig === S.sig.channels) return;
  S.sig.channels = sig;
  const tpl = $("#tpl-channel");
  $("#channels-list").replaceChildren(...chans.map(c => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = c.id;
    li.classList.toggle("is-open", S.open.has(c.id));
    setImg($(".channel-logo", li), c.logo);
    $(".channel-name", li).textContent = c.name;
    $(".channel-live", li).hidden = !c.live;
    const subs = $(".channel-subs", li);
    subs.hidden = c.platform === "twitch" || c.subscribers == null;
    if (!subs.hidden) subs.textContent = `${nf.format(c.subscribers)} abonnés`;
    $(".channel-open", li).href = c.url;

    $(".channel-details", li).hidden = !S.open.has(c.id);
    setImg($(".channel-banner", li), c.banner);
    $(".channel-details", li).classList.toggle("no-banner", !c.banner); // sans bannière : le logo ne remonte plus
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
// dépliage animé : la hauteur s'ouvre, le contenu apparaît en cascade, la flèche tourne
function toggleChannel(li) {
  const det = $(".channel-details", li), id = li.dataset.id, opening = det.hidden;
  opening ? S.open.add(id) : S.open.delete(id);
  li.classList.toggle("is-open", opening);
  if (!canAnimate(det)) { det.hidden = !opening; return; }
  if (opening) {
    det.hidden = false;
    li.classList.add("opening");
    setTimeout(() => li.classList.remove("opening"), 650);
    det.animate([{ height: "0px", opacity: 0 }, { height: det.scrollHeight + "px", opacity: 1 }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
  } else {
    const an = det.animate([{ height: det.offsetHeight + "px", opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 230, easing: "ease-in", fill: "forwards" });
    an.onfinish = () => { det.hidden = true; an.cancel(); };
  }
}
$("#channels-list").addEventListener("click", e => {
  if (e.target.closest(".channel-open")) return; // le bouton d'ouverture suit son lien
  const bar = e.target.closest(".channel-bar");
  if (bar) toggleChannel(bar.closest(".channel"));
});
$("#channels-list").addEventListener("keydown", e => {
  if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("channel-bar")) { e.preventDefault(); e.target.click(); }
});

/* ---------- notifications ---------- */
function renderNotifs() {
  const tpl = $("#tpl-notif"), unread = S.notifs.some(n => !n.read);
  $("#notif-empty").hidden = S.notifs.length > 0;
  $("#notif-dot").hidden = !unread;
  $("#btn-notifs").classList.toggle("has-unread", unread);
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
function openNotifs() {
  $("#notif-panel").hidden = false;
  $("#notif-backdrop").hidden = false;
  renderNotifs();
}
function closeNotifs() {
  if ($("#notif-panel").hidden) return;
  $("#notif-panel").hidden = true;
  $("#notif-backdrop").hidden = true;
  if (S.notifs.some(n => !n.read)) markAllRead();
}
$("#btn-notifs").addEventListener("click", () => ($("#notif-panel").hidden ? openNotifs() : closeNotifs()));
$("#notif-backdrop").addEventListener("click", closeNotifs);
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

/* chaînes préférées : on attrape la poignée et on glisse la chaîne vers le haut ou le bas */
function renderPrefs() {
  const chans = orderedChannels(true), p = prefs(), sig = JSON.stringify([chans.map(c => [c.id, c.name, c.logo]), p]);
  if (sig === S.sig.prefs) return;
  S.sig.prefs = sig;
  const tpl = $("#tpl-pref");
  $("#prefs-list").replaceChildren(...chans.map(c => {
    const li = tpl.content.firstElementChild.cloneNode(true);
    li.dataset.id = c.id;
    setImg($(".pref-logo", li), c.logo);
    $(".pref-name", li).textContent = c.name;
    const vis = $(".pref-visible", li), notif = $(".pref-notif", li), grip = $(".pref-grip", li);
    vis.checked = !p.hidden[c.id];
    notif.checked = !p.muted[c.id];
    vis.addEventListener("change", () => setPref("hidden", c.id, !vis.checked));
    notif.addEventListener("change", () => setPref("muted", c.id, !notif.checked));
    grip.addEventListener("pointerdown", e => startPrefDrag(e, li));
    grip.addEventListener("keydown", e => {
      if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); movePref(c.id, e.key === "ArrowUp" ? -1 : 1); }
    });
    return li;
  }));
}
function startPrefDrag(e, li) {
  if (e.button > 0) return;
  e.preventDefault();
  const list = $("#prefs-list"), startY = e.clientY, startTop = li.offsetTop;
  li.classList.add("dragging");
  const place = clientY => { li.style.transform = `translateY(${clientY - startY - (li.offsetTop - startTop)}px)`; };
  const swap = (other, after) => { // échange avec la chaîne voisine, qui glisse vers sa nouvelle place
    const before = other.offsetTop;
    list.insertBefore(li, after ? other.nextSibling : other);
    if (canAnimate(other)) other.animate([{ transform: `translateY(${before - other.offsetTop}px)` }, { transform: "none" }], { duration: 170, easing: "ease-out" });
  };
  const move = ev => {
    place(ev.clientY);
    const mid = li.offsetTop + (ev.clientY - startY - (li.offsetTop - startTop)) + li.offsetHeight / 2;
    const prev = li.previousElementSibling, next = li.nextElementSibling;
    if (next && mid > next.offsetTop + next.offsetHeight / 2) { swap(next, true); place(ev.clientY); }
    else if (prev && mid < prev.offsetTop + prev.offsetHeight / 2) { swap(prev, false); place(ev.clientY); }
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    window.removeEventListener("pointercancel", up);
    const from = li.style.transform;
    li.style.transform = "";
    li.classList.remove("dragging");
    if (from && canAnimate(li)) li.animate([{ transform: from }, { transform: "none" }], { duration: 150, easing: "ease-out" });
    savePrefs({ ...prefs(), order: $$(".pref", list).map(x => x.dataset.id) });
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
  window.addEventListener("pointercancel", up);
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
setInterval(() => { S.guest++; renderGuest(true); }, 3000);
setInterval(tickDuration, 1000);
setInterval(() => { if (!document.hidden) ping(); }, 15000); // le live apparaît en moins de ~15 s
