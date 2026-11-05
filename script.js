
/* ========================================
   MASTU EXTENSION - SCRIPT.JS
======================================== */

const API_BASE_URL = "https://mastu-extension-api.onrender.com";

const TWITCH_CONTAINER = document.getElementById("twitch-channels");
const YOUTUBE_CONTAINER = document.getElementById("youtube-channels");
const LAST_UPDATE = document.getElementById("last-update");
const REFRESH_BUTTON = document.getElementById("refresh-button");

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
    if (value === null || value === undefined) {
        return "Non disponible";
    }

    return new Intl.NumberFormat("fr-FR").format(value);
}

function createTextElement(className, text) {
    const element = document.createElement("span");

    element.className = className;
    element.textContent = text;

    return element;
}

function createAvatar(url, alt) {
    const image = document.createElement("img");

    image.className = "channel-avatar";
    image.src = url || FALLBACK_AVATAR;
    image.alt = alt || "Photo de profil";
    image.loading = "lazy";

    image.addEventListener("error", () => {
        image.src = FALLBACK_AVATAR;
    }, { once: true });

    return image;
}

function createStatus(isLive) {
    const status = document.createElement("div");

    status.className = isLive
        ? "channel-status status-live"
        : "channel-status status-offline";

    const dot = document.createElement("span");
    dot.className = "status-dot";

    status.appendChild(dot);

    status.appendChild(
        document.createTextNode(
            isLive ? "EN DIRECT" : "HORS LIGNE"
        )
    );

    return status;
}

function createChannelCard(channel, platform) {
    const isTwitch = platform === "twitch";

    const card = document.createElement("a");

    card.className = isTwitch
        ? "channel-card twitch-card"
        : "channel-card youtube-card";

    card.href = channel.url || "#";
    card.target = "_blank";
    card.rel = "noopener noreferrer";

    card.appendChild(
        createAvatar(channel.profileImage, channel.name)
    );

    const info = document.createElement("div");
    info.className = "channel-info";

    info.appendChild(
        createTextElement("channel-name", channel.name)
    );

    info.appendChild(
        createTextElement(
            "channel-platform",
            isTwitch ? "Twitch" : "YouTube"
        )
    );

    if (isTwitch) {
        info.appendChild(createStatus(channel.isLive));

        if (channel.isLive) {
            const viewers = channel.viewerCount;

            info.appendChild(
                createTextElement(
                    "channel-stats",
                    viewers === null || viewers === undefined
                        ? "Spectateurs indisponibles"
                        : `${formatNumber(viewers)} spectateurs`
                )
            );

            if (channel.streamTitle) {
                info.appendChild(
                    createTextElement(
                        "channel-platform",
                        channel.streamTitle
                    )
                );
            }
        }
    } else {
        let subscriberLabel;

        if (channel.subscribersHidden) {
            subscriberLabel = "Abonnés masqués";
        } else if (
            channel.subscribers === null ||
            channel.subscribers === undefined
        ) {
            subscriberLabel = "Abonnés indisponibles";
        } else {
            subscriberLabel =
                `${formatNumber(channel.subscribers)} abonnés`;
        }

        info.appendChild(
            createTextElement("channel-stats", subscriberLabel)
        );
    }

    card.appendChild(info);

    return card;
}

function renderChannels(channels, container, platform) {
    container.replaceChildren();

    if (!Array.isArray(channels) || channels.length === 0) {
        container.appendChild(
            createTextElement(
                "empty-message",
                "Aucune chaîne disponible."
            )
        );

        return;
    }

    channels.forEach((channel) => {
        if (channel.error) {
            const errorCard = createTextElement(
                "error-message",
                `${channel.name} : données indisponibles`
            );

            container.appendChild(errorCard);
            return;
        }

        container.appendChild(
            createChannelCard(channel, platform)
        );
    });
}

async function loadChannels() {
    REFRESH_BUTTON.disabled = true;
    REFRESH_BUTTON.textContent = "Chargement...";

    LAST_UPDATE.textContent = "Récupération des données...";

    try {
        const controller = new AbortController();

        const timeout = setTimeout(
            () => controller.abort(),
            15000
        );

        let response;

        try {
            response = await fetch(
                `${API_BASE_URL}/api/channels`,
                {
                    method: "GET",
                    cache: "no-store",
                    signal: controller.signal
                }
            );
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            throw new Error(
                `Erreur serveur : ${response.status}`
            );
        }

        const data = await response.json();

        if (!data.success) {
            throw new Error("Le serveur n'a pas pu récupérer les données.");
        }

        renderChannels(
            data.twitch,
            TWITCH_CONTAINER,
            "twitch"
        );

        renderChannels(
            data.youtube,
            YOUTUBE_CONTAINER,
            "youtube"
        );

        LAST_UPDATE.textContent =
            "Mis à jour à " +
            new Date(data.updatedAt || Date.now()).toLocaleTimeString(
                "fr-FR",
                {
                    hour: "2-digit",
                    minute: "2-digit"
                }
            );

    } catch (error) {
        console.error("Erreur de chargement :", error);

        const message = error.name === "AbortError"
            ? "Le serveur met trop de temps à répondre."
            : "Impossible de récupérer les données.";

        TWITCH_CONTAINER.replaceChildren(
            createTextElement("error-message", message)
        );

        YOUTUBE_CONTAINER.replaceChildren(
            createTextElement("error-message", message)
        );

        LAST_UPDATE.textContent = "Erreur de connexion.";
    } finally {
        REFRESH_BUTTON.disabled = false;
        REFRESH_BUTTON.textContent = "Actualiser";
    }
}

REFRESH_BUTTON.addEventListener("click", loadChannels);

// Chargement à l'ouverture du popup.
loadChannels();

// Actualisation automatique toutes les cinq minutes.
setInterval(loadChannels, 5 * 60 * 1000);
