
/* ========================================
   MASTU EXTENSION API
   NODE.JS + EXPRESS
======================================== */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;
const CACHE_TTL_SECONDS = Number(
    process.env.CACHE_TTL_SECONDS || 300
);

// ========================================
// CONFIGURATION
// ========================================

const TWITCH_CHANNEL = {
    login: "mastu",
    name: "Mastu",
    url: "https://www.twitch.tv/mastu"
};

const YOUTUBE_CHANNEL = {
    handle: "@mastu",
    name: "Mastu",
    url: "https://www.youtube.com/@mastu"
};

// ========================================
// CORS
// ========================================

const extensionIds = (
    process.env.CHROME_EXTENSION_IDS || ""
)
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

const allowedOrigins = extensionIds.map(
    id => `chrome-extension://${id}`
);

const corsOptions = {
    origin(origin, callback) {
        // Requêtes serveur-à-serveur et outils de test.
        if (!origin || origin === "null") {
            return callback(null, true);
        }

        // Extension Chrome autorisée.
        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // Autorisation de développement uniquement.
        if (
            process.env.NODE_ENV !== "production" &&
            /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
        ) {
            return callback(null, true);
        }

        return callback(new Error("Origine non autorisée."));
    },
    methods: ["GET"],
    allowedHeaders: ["Content-Type"]
};

app.use(cors(corsOptions));

// ========================================
// RATE LIMITING
// ========================================

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    message: {
        success: false,
        error: "Trop de requêtes. Réessaie dans une minute."
    }
});

app.use("/api/", apiLimiter);

// ========================================
// CACHE
// ========================================

let dashboardCache = null;
let cacheExpiration = 0;
let pendingRequest = null;

function getCachedDashboard() {
    if (
        dashboardCache &&
        Date.now() < cacheExpiration
    ) {
        return dashboardCache;
    }

    return null;
}

function saveDashboardCache(data) {
    dashboardCache = data;

    cacheExpiration =
        Date.now() + CACHE_TTL_SECONDS * 1000;
}

// ========================================
// OUTIL HTTP
// ========================================

async function fetchJson(url, options = {}) {
    const response = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(12000)
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
        const message =
            data.message ||
            data.error ||
            `Erreur HTTP ${response.status}`;

        throw new Error(message);
    }

    return data;
}

// ========================================
// TWITCH : APP ACCESS TOKEN
// ========================================

let twitchAppToken = null;
let twitchTokenExpiration = 0;

async function getTwitchAppToken() {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error(
            "Identifiants Twitch non configurés."
        );
    }

    if (
        twitchAppToken &&
        Date.now() < twitchTokenExpiration
    ) {
        return twitchAppToken;
    }

    const params = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials"
    });

    const data = await fetchJson(
        "https://id.twitch.tv/oauth2/token",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded"
            },
            body: params
        }
    );

    if (!data.access_token || !data.expires_in) {
        throw new Error(
            "Twitch n'a pas fourni de token valide."
        );
    }

    twitchAppToken = data.access_token;

    twitchTokenExpiration =
        Date.now() + (data.expires_in - 60) * 1000;

    return twitchAppToken;
}

// ========================================
// TWITCH : REQUÊTE HELIX
// ========================================

async function twitchRequest(endpoint, token) {
    return fetchJson(
        `https://api.twitch.tv/helix/${endpoint}`,
        {
            headers: {
                "Client-Id": process.env.TWITCH_CLIENT_ID,
                "Authorization": `Bearer ${token}`
            }
        }
    );
}

// ========================================
// TWITCH : PROFIL + LIVE
// ========================================

async function getTwitchChannel() {
    const token = await getTwitchAppToken();

    const usersData = await twitchRequest(
        `users?login=${encodeURIComponent(TWITCH_CHANNEL.login)}`,
        token
    );

    const user = usersData.data?.[0];

    if (!user) {
        throw new Error("Chaîne Twitch introuvable.");
    }

    const streamsData = await twitchRequest(
        `streams?user_id=${encodeURIComponent(user.id)}`,
        token
    );

    const stream = streamsData.data?.[0] || null;

    return {
        id: user.id,
        name: user.display_name || TWITCH_CHANNEL.name,
        profileImage: user.profile_image_url || null,

        isLive: Boolean(stream),

        viewerCount: stream
            ? stream.viewer_count
            : null,

        streamTitle: stream
            ? stream.title
            : null,

        gameName: stream
            ? stream.game_name
            : null,

        startedAt: stream
            ? stream.started_at
            : null,

        url: TWITCH_CHANNEL.url,
        platform: "twitch"
    };
}

// ========================================
// YOUTUBE : PROFIL + ABONNÉS
// ========================================

async function getYouTubeChannel() {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (!apiKey) {
        throw new Error(
            "Clé API YouTube non configurée."
        );
    }

    const params = new URLSearchParams({
        part: "snippet,statistics",
        forHandle: YOUTUBE_CHANNEL.handle,
        key: apiKey
    });

    const data = await fetchJson(
        `https://www.googleapis.com/youtube/v3/channels?${params}`
    );

    const channel = data.items?.[0];

    if (!channel) {
        throw new Error("Chaîne YouTube introuvable.");
    }

    const snippet = channel.snippet || {};
    const statistics = channel.statistics || {};
    const thumbnails = snippet.thumbnails || {};

    const profileImage =
        thumbnails.high?.url ||
        thumbnails.medium?.url ||
        thumbnails.default?.url ||
        null;

    const subscribersHidden =
        statistics.hiddenSubscriberCount === true;

    const subscribers =
        subscribersHidden ||
        statistics.subscriberCount === undefined
            ? null
            : Number(statistics.subscriberCount);

    return {
        id: channel.id,
        name: snippet.title || YOUTUBE_CHANNEL.name,
        profileImage,
        subscribers,
        subscribersHidden,
        url: YOUTUBE_CHANNEL.url,
        platform: "youtube"
    };
}

// ========================================
// CONSTRUCTION DU TABLEAU DE BORD
// ========================================

async function buildDashboard() {
    const [twitchResult, youtubeResult] = await Promise.allSettled([
        getTwitchChannel(),
        getYouTubeChannel()
    ]);

    const twitch = twitchResult.status === "fulfilled"
        ? [twitchResult.value]
        : [{
            name: TWITCH_CHANNEL.name,
            error: "Données Twitch indisponibles.",
            url: TWITCH_CHANNEL.url,
            platform: "twitch"
        }];

    const youtube = youtubeResult.status === "fulfilled"
        ? [youtubeResult.value]
        : [{
            name: YOUTUBE_CHANNEL.name,
            error: "Données YouTube indisponibles.",
            url: YOUTUBE_CHANNEL.url,
            platform: "youtube"
        }];

    const errors = [];

    if (twitchResult.status === "rejected") {
        console.error(
            "Erreur Twitch :",
            twitchResult.reason.message
        );

        errors.push("Twitch indisponible");
    }

    if (youtubeResult.status === "rejected") {
        console.error(
            "Erreur YouTube :",
            youtubeResult.reason.message
        );

        errors.push("YouTube indisponible");
    }

    return {
        success: true,
        updatedAt: new Date().toISOString(),
        cacheSeconds: CACHE_TTL_SECONDS,
        twitch,
        youtube,
        errors
    };
}

// ========================================
// ROUTE : TABLEAU DE BORD
// ========================================

app.get("/api/channels", async (req, res) => {
    try {
        const cached = getCachedDashboard();

        if (cached) {
            return res
                .set("Cache-Control", "public, max-age=60")
                .json(cached);
        }

        if (!pendingRequest) {
            pendingRequest = buildDashboard()
                .then(data => {
                    saveDashboardCache(data);
                    return data;
                })
                .finally(() => {
                    pendingRequest = null;
                });
        }

        const data = await pendingRequest;

        return res
            .set("Cache-Control", "public, max-age=60")
            .json(data);

    } catch (error) {
        console.error(
            "Erreur tableau de bord :",
            error.message
        );

        return res.status(500).json({
            success: false,
            error: "Impossible de récupérer les données."
        });
    }
});

// ========================================
// ROUTE : SANTÉ DU SERVEUR
// ========================================

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "Mastu Extension API",
        status: "online",
        timestamp: new Date().toISOString()
    });
});

// ========================================
// ROUTE : RACINE
// ========================================

app.get("/", (req, res) => {
    res.send("Mastu Extension API fonctionne.");
});

// ========================================
// ERREURS
// ========================================

app.use((error, req, res, next) => {
    console.error("Erreur serveur :", error.message);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        success: false,
        error: "Erreur interne du serveur."
    });
});

// ========================================
// DÉMARRAGE
// ========================================

app.listen(PORT, "0.0.0.0", () => {
    console.log("-----------------------------------");
    console.log("MASTU EXTENSION API");
    console.log("-----------------------------------");
    console.log(`Port : ${PORT}`);
    console.log(`Environnement : ${process.env.NODE_ENV || "development"}`);
    console.log(`Cache : ${CACHE_TTL_SECONDS} secondes`);
    console.log("-----------------------------------");
});
