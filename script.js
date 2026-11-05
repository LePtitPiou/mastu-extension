/* ========================================
   MASTU EXTENSION - SCRIPT.JS
   Liste unifiée Twitch + YouTube
======================================== */

const API_BASE_URL = "https://mastu-extension-api.onrender.com";

const CHANNELS_CONTAINER = document.getElementById("channels-list");
const CHANNEL_COUNT = document.getElementById("channel-count");
const LAST_UPDATE = document.getElementById("last-update");
const REFRESH_BUTTON = document.getElementById("refresh-button");

let expandedChannelId = null;
let isLoadingChannels = false;

// L'API et le cache serveur sont réglés sur 60 secondes.
const AUTO_REFRESH_INTERVAL_MS = 60 * 1000;

const FALLBACK_AVATAR =
    "data:image/svg+xml," +
    encodeURIComponent(`
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
            <rect width="100" height="100" fill="#30303b"/>
            <circle cx="50" cy="37" r="19" fill="#777783"/>
            <path d="M15 100c2-25 16-37 35-37s33 12 35 37" fill="#777783"/>
        </svg>
    `);

function formatNumber(value) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) {
        return "Non disponible";
    }

    return new Intl.NumberFormat("fr-FR").format(Number(value));
}

function createTextElement(tagName, className, text) {
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = text;
    return element;
}

function createAvatar(url, alt) {
    const image = document.createElement("img");
    image.className = "channel-avatar";
    image.src = url || FALLBACK_AVATAR;
    image.alt = alt ? `Photo de profil de ${alt}` : "Photo de profil";
    image.loading = "lazy";

    image.addEventListener("error", () => {
        image.src = FALLBACK_AVATAR;
    }, { once: true });

    return image;
}

function createPlatformIcon(platform) {
    const wrapper = document.createElement("span");
    wrapper.className = `platform-icon ${platform}`;
    wrapper.setAttribute(
        "aria-label",
        platform === "twitch" ? "Twitch" : "YouTube"
    );
    wrapper.setAttribute("title", platform === "twitch" ? "Twitch" : "YouTube");

    if (platform === "twitch") {
        wrapper.innerHTML = `
            <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                <path fill="currentColor" d="M4 2 2 6v14h5v3h3l3-3h4l5-5V2H4zm16 12-3 3h-5l-3 3v-3H5V4h15v10z"/>
                <path fill="currentColor" d="M10 7h2v6h-2zm5 0h2v6h-2z"/>
            </svg>
        `;
    } else {
        wrapper.innerHTML = `
            <svg viewBox="0 0 24 24" role="img" aria-hidden="true">
                <path fill="currentColor" d="M23.5 6.2a3 3 0 0 0-2.1-2.1C19.5 3.6 12 3.6 12 3.6s-7.5 0-9.4.5A3 3 0 0 0 .5 6.2 31 31 0 0 0 0 12a31 31 0 0 0 .5 5.8 3 3 0 0 0 2.1 2.1c1.9.5 9.4.5 9.4.5s7.5 0 9.4-.5a3 3 0 0 0 2.1-2.1A31 31 0 0 0 24 12a31 31 0 0 0-.5-5.8ZM9.6 15.6V8.4l6.2 3.6-6.2 3.6Z"/>
            </svg>
        `;
    }

    return wrapper;
}

function createTwitchStatus(channel) {
    const status = document.createElement("span");
    status.className = "twitch-status";

    if (channel.error || typeof channel.isLive !== "boolean") {
        status.classList.add("status-unavailable");
        status.textContent = "Indisponible";
        status.setAttribute("aria-label", "Statut Twitch indisponible");
    } else if (channel.isLive) {
        status.classList.add("status-live");
        status.textContent = "Live";
        status.setAttribute("aria-label", "Mastu est en direct sur Twitch");
    } else {
        status.classList.add("status-offline");
        status.textContent = "Hors ligne";
        status.setAttribute("aria-label", "Mastu est hors ligne sur Twitch");
    }

    return status;
}

function createChevron(isExpanded) {
    const wrapper = document.createElement("span");
    wrapper.className = `chevron${isExpanded ? " is-expanded" : ""}`;
    wrapper.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;
    return wrapper;
}

function createExternalIcon() {
    const wrapper = document.createElement("span");
    wrapper.className = "external-icon";
    wrapper.innerHTML = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M14 4h6v6M20 4l-9 9" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"
                  fill="none" stroke="currentColor" stroke-width="2"
                  stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
    `;
    return wrapper;
}

function getChannelId(channel) {
    return `${channel.platform}:${channel.id || channel.slug || channel.name}`;
}

function createDetailsPanel(channel, panelId) {
    const panel = document.createElement("div");
    panel.className = "channel-details";
    panel.id = panelId;

    const heading = createTextElement(
        "p",
        "details-heading",
        channel.platform === "twitch" ? "Activité Twitch" : "Dernière vidéo"
    );
    panel.appendChild(heading);

    const description = channel.platform === "twitch"
        ? "Les informations du direct (spectateurs et durée) ou du dernier live seront ajoutées ici."
        : "Les informations de la dernière vidéo seront ajoutées ici.";

    panel.appendChild(
        createTextElement("p", "details-placeholder", description)
    );

    if (channel.error) {
        panel.appendChild(
            createTextElement(
                "p",
                "details-error",
                "Les données de cette chaîne sont momentanément indisponibles."
            )
        );
    }

    return panel;
}

function createChannelCard(channel) {
    const platform = channel.platform === "twitch" ? "twitch" : "youtube";
    const channelId = getChannelId(channel);
    const isExpanded = expandedChannelId === channelId;
    const panelId = `details-${platform}-${String(channel.id || channel.name)
        .replace(/[^a-zA-Z0-9_-]/g, "-")}`;

    const card = document.createElement("article");
    card.className = `channel-card${isExpanded ? " is-expanded" : ""}`;

    const row = document.createElement("div");
    row.className = "channel-row";

    const expandButton = document.createElement("button");
    expandButton.type = "button";
    expandButton.className = "channel-expand";
    expandButton.setAttribute("aria-expanded", String(isExpanded));
    expandButton.setAttribute("aria-controls", panelId);
    expandButton.setAttribute(
        "aria-label",
        `${isExpanded ? "Replier" : "Déplier"} ${channel.name}`
    );

    const avatar = createAvatar(channel.profileImage, channel.name);
    expandButton.appendChild(avatar);

    const name = createTextElement("span", "channel-name", channel.name || "Chaîne");
    expandButton.appendChild(name);
    expandButton.appendChild(createPlatformIcon(platform));

    if (platform === "twitch") {
        expandButton.appendChild(createTwitchStatus(channel));
    }

    expandButton.addEventListener("click", () => {
        expandedChannelId = isExpanded ? null : channelId;
        renderChannels(window.currentChannels || []);
    });

    const actions = document.createElement("div");
    actions.className = "channel-actions";

    const externalLink = document.createElement("a");
    externalLink.className = "external-link";
    externalLink.href = channel.url || "#";
    externalLink.target = "_blank";
    externalLink.rel = "noopener noreferrer";
    externalLink.setAttribute("aria-label", `Ouvrir ${channel.name} sur ${platform === "twitch" ? "Twitch" : "YouTube"}`);
    externalLink.title = "Ouvrir la chaîne";
    externalLink.appendChild(createExternalIcon());

    const chevronButton = document.createElement("button");
    chevronButton.type = "button";
    chevronButton.className = "chevron-button";
    chevronButton.setAttribute("aria-label", isExpanded ? "Replier les informations" : "Déplier les informations");
    chevronButton.setAttribute("aria-expanded", String(isExpanded));
    chevronButton.appendChild(createChevron(isExpanded));

    chevronButton.addEventListener("click", () => {
        expandedChannelId = isExpanded ? null : channelId;
        renderChannels(window.currentChannels || []);
    });

    // Le bouton flèche et la zone principale ouvrent le panneau.
    actions.appendChild(externalLink);
    actions.appendChild(chevronButton);

    row.appendChild(expandButton);
    row.appendChild(actions);
    card.appendChild(row);

    const panel = createDetailsPanel(channel, panelId);
    panel.hidden = !isExpanded;
    card.appendChild(panel);

    return card;
}

function renderChannels(channels) {
    CHANNELS_CONTAINER.replaceChildren();

    if (!Array.isArray(channels) || channels.length === 0) {
        CHANNELS_CONTAINER.appendChild(
            createTextElement("p", "empty-message", "Aucune chaîne disponible.")
        );
        CHANNEL_COUNT.textContent = "0 chaîne";
        return;
    }

    CHANNEL_COUNT.textContent =
        `${channels.length} chaîne${channels.length > 1 ? "s" : ""}`;

    channels.forEach(channel => {
        CHANNELS_CONTAINER.appendChild(createChannelCard(channel));
    });
}

async function loadChannels() {
    if (isLoadingChannels) return;
    isLoadingChannels = true;

    REFRESH_BUTTON.disabled = true;
    REFRESH_BUTTON.textContent = "Chargement…";
    LAST_UPDATE.textContent = "Récupération des données…";

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);

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

        if (!response.ok) {
            throw new Error(`Erreur serveur : ${response.status}`);
        }

        const data = await response.json();

        if (!data.success || !Array.isArray(data.channels)) {
            throw new Error("Format de réponse API invalide.");
        }

        window.currentChannels = data.channels;
        if (
            expandedChannelId &&
            !data.channels.some(channel => getChannelId(channel) === expandedChannelId)
        ) {
            expandedChannelId = null;
        }

        renderChannels(data.channels);

        LAST_UPDATE.textContent =
            "Mis à jour à " +
            new Date(data.updatedAt || Date.now()).toLocaleTimeString("fr-FR", {
                hour: "2-digit",
                minute: "2-digit"
            });

    } catch (error) {
        console.error("Erreur de chargement :", error);

        const message = error.name === "AbortError"
            ? "Le serveur met trop de temps à répondre."
            : "Impossible de récupérer les chaînes. Vérifie l'API Render.";

        CHANNELS_CONTAINER.replaceChildren(
            createTextElement("p", "error-message", message)
        );
        CHANNEL_COUNT.textContent = "Erreur";
        LAST_UPDATE.textContent = "Erreur de connexion.";
    } finally {
        isLoadingChannels = false;
        REFRESH_BUTTON.disabled = false;
        REFRESH_BUTTON.textContent = "Actualiser";
    }
}

REFRESH_BUTTON.addEventListener("click", loadChannels);

// Chargement dès l'ouverture, puis actualisation automatique toutes les minutes
// tant que la popup Chrome reste ouverte.
loadChannels();
setInterval(() => {
    if (!document.hidden) {
        loadChannels();
    }
}, AUTO_REFRESH_INTERVAL_MS);
