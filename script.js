/* MASTU EXTENSION 1.5.0 — Interface et préférences locales */
const API_BASE_URL = "https://mastu-extension-api.onrender.com";
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_SETTINGS = { theme: "dark", glassOpacity: 72, glassBlur: 18, cornerRadius: 20, backgroundImage: null };
const twitchList = document.getElementById("twitch-list");
const youtubeList = document.getElementById("youtube-list");
const themeToggle = document.getElementById("theme-toggle");
const themeLabel = document.getElementById("theme-label");
const themeIcon = document.getElementById("theme-icon");
const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const backgroundStatus = document.getElementById("background-status");
let expandedChannelId = null;
let isLoadingChannels = false;
let currentChannels = [];
let settings = { ...DEFAULT_SETTINGS };
const FALLBACK_AVATAR = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#30303b"/><circle cx="50" cy="37" r="19" fill="#777783"/><path d="M15 100c2-25 16-37 35-37s33 12 35 37" fill="#777783"/></svg>`);

function storageGet(keys) {
  return new Promise(resolve => {
    if (globalThis.chrome?.storage?.local) chrome.storage.local.get(keys, result => resolve(result || {}));
    else { try { resolve({ settings: JSON.parse(localStorage.getItem("mastu-extension-settings") || "{}") }); } catch { resolve({}); } }
  });
}
function storageSet(values) {
  return new Promise((resolve, reject) => {
    if (globalThis.chrome?.storage?.local) chrome.storage.local.set(values, () => chrome.runtime?.lastError ? reject(chrome.runtime.lastError) : resolve());
    else { try { localStorage.setItem("mastu-extension-settings", JSON.stringify(values.settings)); resolve(); } catch (error) { reject(error); } }
  });
}
async function saveSettings() {
  try { await storageSet({ settings }); }
  catch (error) { console.error("Échec de sauvegarde des paramètres :", error); backgroundStatus.textContent = "Enregistrement impossible. Image éventuellement trop volumineuse."; }
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty("--glass-opacity", String(settings.glassOpacity / 100));
  document.documentElement.style.setProperty("--glass-blur", `${settings.glassBlur}px`);
  document.documentElement.style.setProperty("--corner-radius", `${settings.cornerRadius}px`);
  if (settings.backgroundImage) {
    document.documentElement.style.setProperty("--custom-background-image", `url("${settings.backgroundImage}")`);
    document.body.classList.add("has-custom-background");
    backgroundStatus.textContent = "Image de fond personnalisée active.";
  } else {
    document.documentElement.style.removeProperty("--custom-background-image");
    document.body.classList.remove("has-custom-background");
    backgroundStatus.textContent = "Aucune image personnalisée.";
  }
  const dark = settings.theme === "dark";
  themeToggle.setAttribute("aria-pressed", String(dark));
  themeLabel.textContent = dark ? "Mode sombre" : "Mode sombre désactivé";
  themeIcon.textContent = dark ? "☾" : "☀";
  document.getElementById("glass-opacity").value = settings.glassOpacity;
  document.getElementById("glass-blur").value = settings.glassBlur;
  document.getElementById("corner-radius").value = settings.cornerRadius;
  document.getElementById("glass-opacity-value").textContent = `${settings.glassOpacity} %`;
  document.getElementById("glass-blur-value").textContent = `${settings.glassBlur} px`;
  document.getElementById("corner-radius-value").textContent = `${settings.cornerRadius} px`;
}
async function loadSettings() { const stored = await storageGet(["settings"]); settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) }; applySettings(); }
function textElement(tag, className, text) { const el = document.createElement(tag); el.className = className; el.textContent = text; return el; }
function createAvatar(url, name) {
  const img = document.createElement("img"); img.className = "channel-avatar"; img.src = url || FALLBACK_AVATAR; img.alt = name ? `Photo de profil de ${name}` : "Photo de profil"; img.loading = "lazy";
  img.addEventListener("error", () => { img.src = FALLBACK_AVATAR; }, { once: true }); return img;
}
function createPlatformIcon(platform) {
  const el = document.createElement("span"); el.className = `platform-icon ${platform}`; el.setAttribute("aria-label", platform === "twitch" ? "Twitch" : "YouTube");
  el.innerHTML = platform === "twitch" ? `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M4 2 2 6v14h5v3h3l3-3h4l5-5V2H4zm16 12-3 3h-5l-3 3v-3H5V4h15v10z"/><path fill="currentColor" d="M10 7h2v6h-2zm5 0h2v6h-2z"/></svg>` : `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z"/></svg>`;
  return el;
}
function createTwitchStatus(channel) {
  const el = document.createElement("span"); el.className = "twitch-status";
  if (channel.error || typeof channel.isLive !== "boolean") { el.classList.add("status-unavailable"); el.textContent = "Indisponible"; }
  else if (channel.isLive) { el.classList.add("status-live"); el.textContent = "Live"; }
  else { el.classList.add("status-offline"); el.textContent = "Hors ligne"; }
  return el;
}
function createChevron(expanded) {
  const el = document.createElement("span"); el.className = `chevron${expanded ? " is-expanded" : ""}`;
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`; return el;
}
function createExternalIcon() {
  const el = document.createElement("span"); el.className = "external-icon";
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`; return el;
}
function channelKey(channel) { return `${channel.platform}:${channel.id || channel.slug || channel.name}`; }
function createDetailsPanel(channel, id) {
  const panel = document.createElement("div"); panel.className = "channel-details"; panel.id = id;
  panel.appendChild(textElement("p", "details-heading", channel.platform === "twitch" ? "Activité Twitch" : "Chaîne YouTube"));
  let description;
  if (channel.platform === "twitch" && channel.isLive) {
    const viewers = channel.viewerCount == null ? "Nombre de spectateurs indisponible" : `${new Intl.NumberFormat("fr-FR").format(channel.viewerCount)} spectateurs`;
    description = [channel.streamTitle, channel.gameName, viewers].filter(Boolean).join(" · ") || "Mastu est en direct.";
  } else if (channel.platform === "twitch") description = channel.error ? "Le statut Twitch est momentanément indisponible." : "Mastu n'est pas en direct actuellement.";
  else description = channel.error ? "Les données de cette chaîne sont momentanément indisponibles." : "Ouvre la chaîne pour découvrir les dernières vidéos.";
  panel.appendChild(textElement("p", "details-description", description)); return panel;
}
function createChannelCard(channel) {
  const key = channelKey(channel); const expanded = expandedChannelId === key;
  const panelId = `details-${String(channel.id || channel.name).replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  const card = document.createElement("article"); card.className = `channel-card${expanded ? " is-expanded" : ""}`;
  const row = document.createElement("div"); row.className = "channel-row";
  const expand = document.createElement("button"); expand.type = "button"; expand.className = "channel-expand"; expand.setAttribute("aria-expanded", String(expanded)); expand.setAttribute("aria-controls", panelId); expand.setAttribute("aria-label", `${expanded ? "Replier" : "Afficher les détails de"} ${channel.name}`);
  expand.appendChild(createAvatar(channel.profileImage, channel.name));
  const identity = document.createElement("span"); identity.className = "channel-identity"; identity.appendChild(textElement("span", "channel-name", channel.name || "Chaîne")); identity.appendChild(createPlatformIcon(channel.platform)); expand.appendChild(identity);
  if (channel.platform === "twitch") expand.appendChild(createTwitchStatus(channel));
  const toggle = () => { expandedChannelId = expanded ? null : key; renderChannels(currentChannels); }; expand.addEventListener("click", toggle);
  const actions = document.createElement("div"); actions.className = "channel-actions";
  const link = document.createElement("a"); link.className = "glass-icon-button external-link"; link.href = channel.url || "#"; link.target = "_blank"; link.rel = "noopener noreferrer"; link.title = "Ouvrir la chaîne"; link.setAttribute("aria-label", `Ouvrir ${channel.name} sur ${channel.platform === "twitch" ? "Twitch" : "YouTube"}`); link.appendChild(createExternalIcon());
  const arrow = document.createElement("button"); arrow.type = "button"; arrow.className = "glass-icon-button chevron-button"; arrow.setAttribute("aria-label", expanded ? "Replier les détails" : "Déplier les détails"); arrow.setAttribute("aria-expanded", String(expanded)); arrow.appendChild(createChevron(expanded)); arrow.addEventListener("click", toggle);
  actions.append(link, arrow); row.append(expand, actions); card.appendChild(row);
  const details = createDetailsPanel(channel, panelId); details.hidden = !expanded; card.appendChild(details); return card;
}
function renderGroup(container, channels, emptyText) {
  container.replaceChildren();
  if (!channels.length) { container.appendChild(textElement("p", "empty-message", emptyText)); return; }
  channels.forEach(channel => container.appendChild(createChannelCard(channel)));
}
function renderChannels(channels) {
  renderGroup(twitchList, channels.filter(c => c.platform === "twitch"), "Aucune chaîne Twitch configurée.");
  renderGroup(youtubeList, channels.filter(c => c.platform === "youtube"), "Aucune chaîne YouTube configurée.");
}
async function loadChannels() {
  if (isLoadingChannels) return; isLoadingChannels = true;
  try {
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 15000); let response;
    try { response = await fetch(`${API_BASE_URL}/api/channels`, { method: "GET", cache: "no-store", signal: controller.signal }); }
    finally { clearTimeout(timeout); }
    if (!response.ok) throw new Error(`Erreur serveur : ${response.status}`);
    const data = await response.json(); if (!data.success || !Array.isArray(data.channels)) throw new Error("Format de réponse API invalide.");
    currentChannels = data.channels;
    if (expandedChannelId && !currentChannels.some(c => channelKey(c) === expandedChannelId)) expandedChannelId = null;
    renderChannels(currentChannels);
  } catch (error) {
    console.error("Erreur de chargement :", error);
    const message = error.name === "AbortError" ? "Le serveur met trop de temps à répondre." : "Impossible de récupérer les chaînes. Vérifie la connexion à l'API.";
    renderGroup(twitchList, [], message); renderGroup(youtubeList, [], message);
  } finally { isLoadingChannels = false; }
}
function setSettingsPanel(open) {
  settingsPanel.hidden = !open; settingsToggle.setAttribute("aria-expanded", String(open)); settingsToggle.classList.toggle("is-active", open);
  if (open) settingsPanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
themeToggle.addEventListener("click", async () => { settings.theme = settings.theme === "dark" ? "light" : "dark"; applySettings(); await saveSettings(); });
settingsToggle.addEventListener("click", () => setSettingsPanel(settingsPanel.hidden));
document.getElementById("close-settings").addEventListener("click", () => setSettingsPanel(false));
[
  ["glass-opacity", "glassOpacity", "glass-opacity-value", "%"],
  ["glass-blur", "glassBlur", "glass-blur-value", " px"],
  ["corner-radius", "cornerRadius", "corner-radius-value", " px"]
].forEach(([inputId, key, outputId, suffix]) => {
  document.getElementById(inputId).addEventListener("input", async event => { settings[key] = Number(event.target.value); document.getElementById(outputId).textContent = `${event.target.value}${suffix}`; applySettings(); await saveSettings(); });
});
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image(); const objectUrl = URL.createObjectURL(file);
    image.onload = () => { const scale = Math.min(1, 1800 / image.width); const canvas = document.createElement("canvas"); canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale); canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height); URL.revokeObjectURL(objectUrl); resolve(canvas.toDataURL("image/webp", 0.82)); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error("Image illisible.")); }; image.src = objectUrl;
  });
}
document.getElementById("background-upload").addEventListener("change", async event => {
  const file = event.target.files?.[0]; if (!file) return;
  if (!file.type.startsWith("image/")) { backgroundStatus.textContent = "Choisis un fichier image valide."; return; }
  if (file.size > 12 * 1024 * 1024) { backgroundStatus.textContent = "Image trop volumineuse (12 Mo maximum avant compression)."; return; }
  try { settings.backgroundImage = await compressImage(file); applySettings(); await saveSettings(); backgroundStatus.textContent = "Image de fond enregistrée."; }
  catch (error) { console.error(error); backgroundStatus.textContent = "Impossible de charger cette image."; }
  event.target.value = "";
});
document.getElementById("remove-background").addEventListener("click", async () => { settings.backgroundImage = null; applySettings(); await saveSettings(); });
document.getElementById("reset-settings").addEventListener("click", async () => { settings = { ...DEFAULT_SETTINGS }; applySettings(); await saveSettings(); });
(async function initialize() { await loadSettings(); await loadChannels(); setInterval(() => { if (!document.hidden) loadChannels(); }, AUTO_REFRESH_INTERVAL_MS); })();
