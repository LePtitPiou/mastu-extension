/* MASTU EXTENSION 1.8.0
 * RESPONSABILITÉS : interactions, récupération des données et préférences.
 * Toute la structure de l'interface et des cartes est déclarée dans popup.html.
 *
 * IMAGE DE FOND CONSEILLÉE : format portrait 3:4, environ 1200 × 1600 px.
 * Le fond utilise background-size: cover : il remplit la popup et peut être recadré.
 */
"use strict";

const API_BASE_URL = "https://mastu-extension-api.onrender.com";
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;
const DEFAULT_SETTINGS = { theme: "dark", liquidGlass: true, backgroundImage: null };

const settingsToggle = document.getElementById("settings-toggle");
const settingsMenu = document.getElementById("settings-menu");
const themeToggle = document.getElementById("theme-toggle");
const glassToggle = document.getElementById("glass-toggle");
const backgroundUpload = document.getElementById("background-upload");
const backgroundStatus = document.getElementById("background-status");
const removeBackground = document.getElementById("remove-background");
const closeSettings = document.getElementById("close-settings");
const featuredContainer = document.getElementById("featured-content");
const featuredTemplate = document.getElementById("featured-template");
const channelsContainer = document.getElementById("channels-list");
const channelTemplate = document.getElementById("channel-card-template");
const messageTemplate = document.getElementById("message-template");
const navButtons = [...document.querySelectorAll(".nav-tab")];
const pagePanels = [...document.querySelectorAll("[data-page-panel]")];

let settings = { ...DEFAULT_SETTINGS };
let currentChannels = [];
let expandedChannelId = null;
let isLoading = false;

const FALLBACK_AVATAR = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#30303b"/><circle cx="50" cy="37" r="19" fill="#777783"/><path d="M15 100c2-25 16-37 35-37s33 12 35 37" fill="#777783"/></svg>'
);
const FALLBACK_THUMBNAIL = "data:image/svg+xml," + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360"><rect width="640" height="360" fill="#242633"/><path d="M280 115v130l110-65z" fill="#85899b"/></svg>'
);

function storageGet(keys) {
  return new Promise(resolve => {
    if (globalThis.chrome?.storage?.local) {
      chrome.storage.local.get(keys, result => resolve(result || {}));
      return;
    }
    try { resolve({ settings: JSON.parse(localStorage.getItem("mastu-extension-settings") || "{}") }); }
    catch { resolve({}); }
  });
}

function storageSet(values) {
  return new Promise((resolve, reject) => {
    if (globalThis.chrome?.storage?.local) {
      chrome.storage.local.set(values, () => chrome.runtime?.lastError
        ? reject(chrome.runtime.lastError) : resolve());
      return;
    }
    try {
      localStorage.setItem("mastu-extension-settings", JSON.stringify(values.settings));
      resolve();
    } catch (error) { reject(error); }
  });
}

async function saveSettings() {
  try { await storageSet({ settings }); }
  catch (error) {
    console.error("Échec de sauvegarde des paramètres :", error);
    backgroundStatus.textContent = "Enregistrement impossible. L’image est peut-être trop volumineuse.";
  }
}

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.classList.toggle("glass-disabled", !settings.liquidGlass);
  document.body.classList.toggle("has-custom-background", Boolean(settings.backgroundImage));

  if (settings.backgroundImage) {
    document.documentElement.style.setProperty("--custom-background-image", `url("${settings.backgroundImage}")`);
    backgroundStatus.textContent = "Image de fond personnalisée active.";
  } else {
    document.documentElement.style.removeProperty("--custom-background-image");
    backgroundStatus.textContent = "Aucune image personnalisée.";
  }

  themeToggle.setAttribute("aria-checked", String(settings.theme === "dark"));
  glassToggle.setAttribute("aria-checked", String(Boolean(settings.liquidGlass)));
}

async function loadSettings() {
  const stored = await storageGet(["settings"]);
  settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
  delete settings.glassOpacity;
  delete settings.glassBlur;
  delete settings.cornerRadius;
  applySettings();
}

function setSettingsMenu(open) {
  settingsMenu.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  settingsToggle.classList.toggle("is-active", open);
}

function switchPage(pageName) {
  navButtons.forEach(button => {
    const active = button.dataset.page === pageName;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  pagePanels.forEach(panel => {
    const active = panel.dataset.pagePanel === pageName;
    panel.hidden = !active;
    panel.classList.toggle("is-active", active);
  });
  setSettingsMenu(false);
}

function formatRelativeDate(value) {
  if (!value) return "Date inconnue";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date inconnue";
  const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
  if (seconds < 60) return "À l’instant";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `Il y a ${days} j`;
  const months = Math.floor(days / 30);
  if (months < 12) return `Il y a ${months} mois`;
  return `Il y a ${Math.floor(months / 12)} an${months >= 24 ? "s" : ""}`;
}

function formatElapsed(value) {
  if (!value) return "";
  const start = new Date(value).getTime();
  if (Number.isNaN(start)) return "";
  const totalMinutes = Math.max(0, Math.floor((Date.now() - start) / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return `${Math.floor(hours / 24)} j ${hours % 24} h`;
  if (hours) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

function formatDuration(value) {
  if (!value) return "";
  if (/^\d+:\d{2}(:\d{2})?$/.test(value)) return value;
  const match = String(value).match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return value;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatCount(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "Vues indisponibles";
  return `${new Intl.NumberFormat("fr-FR").format(Number(value))} vues`;
}

function channelKey(channel) {
  return `${channel.platform}:${channel.id || channel.slug || channel.name}`;
}

function platformLabel(platform) {
  return platform === "twitch" ? "Twitch" : "YouTube";
}

function setImage(image, source, fallback = FALLBACK_THUMBNAIL) {
  image.src = source || fallback;
  image.addEventListener("error", () => { image.src = fallback; }, { once: true });
}

function getLatestAcrossChannels(channels) {
  const candidates = channels
    .filter(channel => channel.latestContent && channel.latestContent.publishedAt)
    .map(channel => ({ ...channel.latestContent, channel }));
  candidates.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return candidates[0] || null;
}

function renderFeatured(channels) {
  featuredContainer.replaceChildren();
  featuredContainer.setAttribute("aria-busy", "false");

  const liveChannel = channels.find(channel => channel.platform === "twitch" && channel.isLive);
  let content;
  let isLive = false;

  if (liveChannel) {
    content = {
      ...(liveChannel.latestContent || {}),
      type: "live",
      title: liveChannel.streamTitle || liveChannel.latestContent?.title || "Mastu est en direct",
      thumbnail: liveChannel.liveThumbnail || liveChannel.latestContent?.thumbnail,
      url: liveChannel.url,
      views: liveChannel.viewerCount,
      publishedAt: liveChannel.startedAt,
      channel: liveChannel
    };
    isLive = true;
  } else {
    content = getLatestAcrossChannels(channels);
  }

  if (!content) {
    const message = messageTemplate.content.cloneNode(true);
    message.querySelector(".empty-message").textContent = "Aucun contenu récent n’est disponible pour le moment.";
    featuredContainer.appendChild(message);
    return;
  }

  const fragment = featuredTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".featured-card");
  const media = fragment.querySelector(".featured-media");
  const thumbnail = fragment.querySelector(".featured-thumbnail");
  const liveBadge = fragment.querySelector(".featured-live-badge");
  const duration = fragment.querySelector(".featured-duration");
  const platform = fragment.querySelector(".featured-platform");
  const age = fragment.querySelector(".featured-age");
  const title = fragment.querySelector(".featured-title");
  const stats = fragment.querySelector(".featured-stats");
  const open = fragment.querySelector(".featured-open");

  media.href = content.url || content.channel?.url || "#";
  setImage(thumbnail, content.thumbnail);
  thumbnail.alt = content.title || "Miniature du contenu";
  liveBadge.hidden = !isLive;
  duration.textContent = isLive ? formatElapsed(content.publishedAt) : formatDuration(content.duration);
  duration.hidden = !duration.textContent;
  platform.textContent = `${platformLabel(content.channel?.platform || "youtube")} · ${content.channel?.name || "Mastu"}`;
  age.textContent = isLive ? "En direct maintenant" : formatRelativeDate(content.publishedAt);
  title.textContent = content.title || "Dernier contenu";
  stats.textContent = isLive
    ? `${new Intl.NumberFormat("fr-FR").format(Number(content.views || 0))} spectateurs`
    : formatCount(content.views);
  open.href = media.href;
  open.textContent = isLive ? "Regarder le live ↗" : "Regarder la vidéo ↗";
  card.classList.toggle("is-live", isLive);
  featuredContainer.appendChild(fragment);
}

function setChannelStatus(element, channel) {
  element.className = "channel-status";
  if (channel.platform !== "twitch") {
    element.textContent = "YouTube";
    element.classList.add("status-platform");
  } else if (channel.error || typeof channel.isLive !== "boolean") {
    element.textContent = "Indisponible";
    element.classList.add("status-unavailable");
  } else if (channel.isLive) {
    element.textContent = "Live";
    element.classList.add("status-live");
  } else {
    element.textContent = "Hors ligne";
    element.classList.add("status-offline");
  }
}

function createChannelCard(channel) {
  const fragment = channelTemplate.content.cloneNode(true);
  const card = fragment.querySelector(".channel-card");
  const expandButton = fragment.querySelector(".channel-expand");
  const avatar = fragment.querySelector(".channel-avatar");
  const name = fragment.querySelector(".channel-name");
  const subline = fragment.querySelector(".channel-subline");
  const platformIcon = fragment.querySelector(".platform-icon");
  const actions = fragment.querySelector(".channel-actions");
  const externalLink = fragment.querySelector(".external-link");
  const chevronButton = fragment.querySelector(".chevron-button");
  const chevron = fragment.querySelector(".chevron");
  const details = fragment.querySelector(".channel-details");
  const contentLink = fragment.querySelector(".channel-content-media");
  const contentThumbnail = fragment.querySelector(".content-thumbnail");
  const contentDuration = fragment.querySelector(".content-duration");
  const contentKind = fragment.querySelector(".content-kind");
  const contentTitle = fragment.querySelector(".content-title");
  const contentStats = fragment.querySelector(".content-stats");
  const contentAge = fragment.querySelector(".content-age");
  const empty = fragment.querySelector(".channel-content-empty");

  const key = channelKey(channel);
  const expanded = expandedChannelId === key;
  const safeId = String(channel.id || channel.name || "channel").replace(/[^a-zA-Z0-9_-]/g, "-");
  const detailsId = `channel-details-${safeId}`;

  card.classList.toggle("is-expanded", expanded);
  details.id = detailsId;
  details.hidden = !expanded;
  expandButton.setAttribute("aria-expanded", String(expanded));
  expandButton.setAttribute("aria-controls", detailsId);
  expandButton.setAttribute("aria-label", `${expanded ? "Replier" : "Déplier"} ${channel.name || "la chaîne"}`);

  setImage(avatar, channel.profileImage, FALLBACK_AVATAR);
  avatar.alt = `Logo de ${channel.name || "la chaîne"}`;
  name.textContent = channel.name || "Chaîne";
  platformIcon.classList.add(channel.platform === "twitch" ? "twitch" : "youtube");
  platformIcon.setAttribute("aria-label", platformLabel(channel.platform));
  platformIcon.querySelector(".platform-twitch").hidden = channel.platform !== "twitch";
  platformIcon.querySelector(".platform-youtube").hidden = channel.platform !== "youtube";
  setChannelStatus(subline.querySelector(".channel-status"), channel);

  externalLink.href = channel.url || "#";
  externalLink.setAttribute("aria-label", `Ouvrir ${channel.name || "la chaîne"}`);
  chevronButton.setAttribute("aria-expanded", String(expanded));
  chevronButton.setAttribute("aria-controls", detailsId);
  chevron.classList.toggle("is-expanded", expanded);

  const content = channel.latestContent;
  if (content) {
    empty.hidden = true;
    contentLink.href = content.url || channel.url || "#";
    setImage(contentThumbnail, content.thumbnail);
    contentThumbnail.alt = content.title || "Miniature";
    contentDuration.textContent = channel.isLive ? formatElapsed(content.publishedAt) : formatDuration(content.duration);
    contentDuration.hidden = !contentDuration.textContent;
    contentKind.textContent = channel.isLive ? "EN DIRECT" : (content.type === "stream" ? "DERNIER LIVE" : "DERNIÈRE VIDÉO");
    contentTitle.textContent = content.title || "Contenu récent";
    contentStats.textContent = channel.isLive
      ? `${new Intl.NumberFormat("fr-FR").format(Number(content.views || 0))} spectateurs`
      : formatCount(content.views);
    contentAge.textContent = channel.isLive ? "En direct maintenant" : formatRelativeDate(content.publishedAt);
  } else {
    contentLink.hidden = true;
    contentTitle.hidden = true;
    contentKind.hidden = true;
    contentStats.hidden = true;
    contentAge.hidden = true;
    empty.hidden = false;
    empty.textContent = channel.error
      ? "Les données de cette chaîne sont momentanément indisponibles."
      : "Aucune vidéo ou aucun live récent disponible.";
  }

  const toggleDetails = () => {
    expandedChannelId = expanded ? null : key;
    renderChannels(currentChannels);
  };
  expandButton.addEventListener("click", toggleDetails);
  chevronButton.addEventListener("click", toggleDetails);
  return fragment;
}

function renderChannels(channels) {
  channelsContainer.replaceChildren();
  channelsContainer.setAttribute("aria-busy", "false");
  const ordered = [...channels].sort((a, b) => {
    if (a.platform === "twitch" && a.isLive) return -1;
    if (b.platform === "twitch" && b.isLive) return 1;
    return 0;
  });
  if (!ordered.length) {
    const message = messageTemplate.content.cloneNode(true);
    message.querySelector(".empty-message").textContent = "Aucune chaîne configurée.";
    channelsContainer.appendChild(message);
    return;
  }
  const fragment = document.createDocumentFragment();
  ordered.forEach(channel => fragment.appendChild(createChannelCard(channel)));
  channelsContainer.appendChild(fragment);
}

function renderError(message) {
  featuredContainer.replaceChildren();
  channelsContainer.replaceChildren();
  [featuredContainer, channelsContainer].forEach(container => {
    const item = messageTemplate.content.cloneNode(true);
    const paragraph = item.querySelector(".empty-message");
    paragraph.classList.add("error-message");
    paragraph.textContent = message;
    container.appendChild(item);
    container.setAttribute("aria-busy", "false");
  });
}

async function loadChannels() {
  if (isLoading) return;
  isLoading = true;
  featuredContainer.setAttribute("aria-busy", "true");
  channelsContainer.setAttribute("aria-busy", "true");

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    let response;
    try {
      response = await fetch(`${API_BASE_URL}/api/channels`, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) throw new Error(`Erreur serveur : ${response.status}`);
    const data = await response.json();
    if (!data.success || !Array.isArray(data.channels)) throw new Error("Format de réponse API invalide.");

    currentChannels = data.channels;
    if (expandedChannelId && !currentChannels.some(channel => channelKey(channel) === expandedChannelId)) {
      expandedChannelId = null;
    }
    renderFeatured(currentChannels);
    renderChannels(currentChannels);
  } catch (error) {
    console.error("Erreur de chargement des chaînes :", error);
    renderError(error.name === "AbortError"
      ? "Le serveur met trop de temps à répondre."
      : "Impossible de récupérer les contenus. Vérifie la connexion à l’API.");
  } finally {
    isLoading = false;
  }
}

function compressImage(file) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const objectUrl = URL.createObjectURL(file);
    image.onload = () => {
      // Réduction à 1800 px de large maximum, en conservant le ratio original.
      const scale = Math.min(1, 1800 / image.width);
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.width * scale);
      canvas.height = Math.round(image.height * scale);
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(objectUrl);
        reject(new Error("Canvas indisponible."));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(objectUrl);
      resolve(canvas.toDataURL("image/webp", 0.82));
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Image illisible."));
    };
    image.src = objectUrl;
  });
}

settingsToggle.addEventListener("click", () => setSettingsMenu(settingsMenu.hidden));
closeSettings.addEventListener("click", () => setSettingsMenu(false));
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && !settingsMenu.hidden) setSettingsMenu(false);
});
document.addEventListener("click", event => {
  if (!settingsMenu.hidden && !event.target.closest(".settings-wrapper")) setSettingsMenu(false);
});

themeToggle.addEventListener("click", async () => {
  settings.theme = settings.theme === "dark" ? "light" : "dark";
  applySettings();
  await saveSettings();
});
glassToggle.addEventListener("click", async () => {
  settings.liquidGlass = !settings.liquidGlass;
  applySettings();
  await saveSettings();
});
backgroundUpload.addEventListener("change", async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    backgroundStatus.textContent = "Choisis un fichier image valide.";
    event.target.value = "";
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    backgroundStatus.textContent = "Image trop volumineuse (12 Mo maximum avant compression).";
    event.target.value = "";
    return;
  }
  try {
    settings.backgroundImage = await compressImage(file);
    applySettings();
    await saveSettings();
    backgroundStatus.textContent = "Image de fond enregistrée.";
  } catch (error) {
    console.error(error);
    backgroundStatus.textContent = "Impossible de charger cette image.";
  }
  event.target.value = "";
});
removeBackground.addEventListener("click", async () => {
  settings.backgroundImage = null;
  applySettings();
  await saveSettings();
});
navButtons.forEach(button => button.addEventListener("click", () => switchPage(button.dataset.page)));

(async function initialize() {
  await loadSettings();
  await loadChannels();
  setInterval(() => {
    if (!document.hidden) loadChannels();
  }, AUTO_REFRESH_INTERVAL_MS);
})();
