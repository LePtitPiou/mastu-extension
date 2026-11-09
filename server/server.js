/* ========================================
   MASTU EXTENSION API
   NODE.JS 20+ / EXPRESS
   Réponse unifiée Twitch + YouTube
======================================== */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();
app.disable("x-powered-by");

const PORT = process.env.PORT || 3000;
const CACHE_TTL_SECONDS = Math.max(
    30,
    Number(process.env.CACHE_TTL_SECONDS || 60)
);

// ========================================
// CHAÎNES CONFIGURÉES
// ========================================

const TWITCH_CHANNELS = [
    {
        id: "twitch-mastu",
        login: "mastu",
        name: "Mastu",
        url: "https://www.twitch.tv/mastu"
    }
];

const YOUTUBE_CHANNELS = [
    {
        id: "youtube-mastu",
        handle: "@mastu",
        name: "Mastu",
        url: "https://www.youtube.com/@mastu"
    },
    {
        id: "youtube-mastu-gear-2",
        handle: "@mastu2nd",
        name: "Mastu Gear 2",
        url: "https://www.youtube.com/@mastu2nd"
    },
    {
        id: "youtube-mastu-plus",
        handle: "@masturediffusions",
        name: "Mastu +",
        url: "https://www.youtube.com/@masturediffusions"
    }
];

// ========================================
// CORS
// ========================================

const extensionIds = (process.env.CHROME_EXTENSION_IDS || "")
    .split(",")
    .map(id => id.trim())
    .filter(Boolean);

const allowedOrigins = extensionIds.map(
    id => `chrome-extension://${id}`
);

app.use(cors({
    origin(origin, callback) {
        // Autorise les tests navigateur et appels sans Origin.
        if (!origin || origin === "null") {
            return callback(null, true);
        }

        if (allowedOrigins.includes(origin)) {
            return callback(null, true);
        }

        // Autorisation des extensions Chrome uniquement en développement.
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
}));

// ========================================
// LIMITATION DES REQUÊTES
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
    if (dashboardCache && Date.now() < cacheExpiration) {
        return dashboardCache;
    }

    return null;
}

function saveDashboardCache(data) {
    dashboardCache = data;
    cacheExpiration = Date.now() + CACHE_TTL_SECONDS * 1000;
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
            data.error?.message ||
            data.message ||
            data.error ||
            `Erreur HTTP ${response.status}`;

        throw new Error(String(message));
    }

    return data;
}

// ========================================
// TWITCH : TOKEN APPLICATION
// ========================================

let twitchAppToken = null;
let twitchTokenExpiration = 0;

async function getTwitchAppToken() {
    const clientId = process.env.TWITCH_CLIENT_ID;
    const clientSecret = process.env.TWITCH_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error("Identifiants Twitch non configurés.");
    }

    if (twitchAppToken && Date.now() < twitchTokenExpiration) {
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
        throw new Error("Twitch n'a pas fourni de token valide.");
    }

    twitchAppToken = data.access_token;
    twitchTokenExpiration = Date.now() + (data.expires_in - 60) * 1000;

    return twitchAppToken;
}

async function twitchRequest(endpoint, token) {
    return fetchJson(`https://api.twitch.tv/helix/${endpoint}`, {
        headers: {
            "Client-Id": process.env.TWITCH_CLIENT_ID,
            "Authorization": `Bearer ${token}`
        }
    });
}

// ========================================
// TWITCH : UNE CHAÎNE
// ========================================

async function getTwitchChannel(channelConfig, token) {
    const usersData = await twitchRequest(
        `users?login=${encodeURIComponent(channelConfig.login)}`,
        token
    );
    const user = usersData.data?.[0];
    if (!user) throw new Error(`Chaîne Twitch introuvable : ${channelConfig.login}`);

    const [streamsData, videosData] = await Promise.all([
        twitchRequest(`streams?user_id=${encodeURIComponent(user.id)}`, token),
        twitchRequest(`videos?user_id=${encodeURIComponent(user.id)}&type=archive&first=1`, token)
            .catch(error => {
                console.error(`Dernier replay Twitch indisponible (${channelConfig.name}) :`, error.message);
                return { data: [] };
            })
    ]);

    const stream = streamsData.data?.[0] || null;
    const lastVideo = videosData.data?.[0] || null;
    const thumbnail = value => value
        ? value.replace("%{width}", "1280").replace("%{height}", "720")
        : null;

    return {
        id: channelConfig.id,
        platform: "twitch",
        name: user.display_name || channelConfig.name,
        profileImage: user.profile_image_url || null,
        url: channelConfig.url,
        isLive: Boolean(stream),
        viewerCount: stream ? stream.viewer_count : null,
        streamTitle: stream ? stream.title : null,
        gameName: stream ? stream.game_name : null,
        startedAt: stream ? stream.started_at : null,
        liveThumbnail: stream ? thumbnail(stream.thumbnail_url) : null,
        latestContent: stream ? {
            type: "live",
            title: stream.title || "Mastu est en direct",
            thumbnail: thumbnail(stream.thumbnail_url),
            url: channelConfig.url,
            views: stream.viewer_count ?? null,
            duration: null,
            publishedAt: stream.started_at || null
        } : lastVideo ? {
            type: "stream",
            title: lastVideo.title || "Dernier live",
            thumbnail: thumbnail(lastVideo.thumbnail_url),
            url: lastVideo.url || channelConfig.url,
            views: Number(lastVideo.view_count || 0),
            duration: lastVideo.duration || null,
            publishedAt: lastVideo.created_at || null
        } : null
    };
}

// ========================================
// YOUTUBE : CHAÎNE ET DERNIÈRE VIDÉO
// ========================================

async function getYouTubeChannel(channelConfig) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) throw new Error("Clé API YouTube non configurée.");

    const params = new URLSearchParams({
        part: "snippet,statistics,contentDetails",
        forHandle: channelConfig.handle,
        key: apiKey
    });
    const data = await fetchJson(`https://www.googleapis.com/youtube/v3/channels?${params}`);
    const channel = data.items?.[0];
    if (!channel) throw new Error(`Chaîne YouTube introuvable : ${channelConfig.handle}`);

    const snippet = channel.snippet || {};
    const statistics = channel.statistics || {};
    const thumbnails = snippet.thumbnails || {};
    const profileImage = thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || null;
    const uploadsPlaylist = channel.contentDetails?.relatedPlaylists?.uploads;
    let latestContent = null;

    if (uploadsPlaylist) {
        const playlistParams = new URLSearchParams({
            part: "snippet,contentDetails",
            playlistId: uploadsPlaylist,
            maxResults: "1",
            key: apiKey
        });
        const playlistData = await fetchJson(`https://www.googleapis.com/youtube/v3/playlistItems?${playlistParams}`);
        const item = playlistData.items?.[0];
        const videoId = item?.contentDetails?.videoId;

        if (videoId) {
            const videoParams = new URLSearchParams({
                part: "snippet,statistics,contentDetails",
                id: videoId,
                key: apiKey
            });
            const videoData = await fetchJson(`https://www.googleapis.com/youtube/v3/videos?${videoParams}`);
            const video = videoData.items?.[0];

            if (video) {
                const videoSnippet = video.snippet || {};
                const videoThumbs = videoSnippet.thumbnails || {};
                latestContent = {
                    type: "video",
                    title: videoSnippet.title || "Dernière vidéo",
                    thumbnail: videoThumbs.maxres?.url || videoThumbs.high?.url ||
                        videoThumbs.medium?.url || videoThumbs.default?.url || null,
                    url: `https://www.youtube.com/watch?v=${video.id}`,
                    views: Number(video.statistics?.viewCount || 0),
                    duration: video.contentDetails?.duration || null,
                    publishedAt: videoSnippet.publishedAt || null
                };
            }
        }
    }

    const subscribersHidden = statistics.hiddenSubscriberCount === true;
    const subscribers = subscribersHidden || statistics.subscriberCount === undefined
        ? null : Number(statistics.subscriberCount);

    return {
        id: channelConfig.id,
        platform: "youtube",
        name: snippet.title || channelConfig.name,
        profileImage,
        url: channelConfig.url,
        subscribers,
        subscribersHidden,
        latestContent
    };
}

// ========================================
// CONSTRUCTION DE LA LISTE UNIFIÉE
// ========================================

async function buildDashboard() {
    let twitchToken = null;
    let twitchTokenError = null;

    try {
        twitchToken = await getTwitchAppToken();
    } catch (error) {
        twitchTokenError = error;
        console.error("Erreur token Twitch :", error.message);
    }

    const twitchPromises = TWITCH_CHANNELS.map(async config => {
        try {
            if (twitchTokenError) throw twitchTokenError;
            return await getTwitchChannel(config, twitchToken);
        } catch (error) {
            console.error(`Erreur Twitch (${config.name}) :`, error.message);
            return {
                id: config.id,
                platform: "twitch",
                name: config.name,
                profileImage: null,
                url: config.url,
                error: "Données Twitch indisponibles."
            };
        }
    });

    const youtubePromises = YOUTUBE_CHANNELS.map(async config => {
        try {
            return await getYouTubeChannel(config);
        } catch (error) {
            console.error(`Erreur YouTube (${config.name}) :`, error.message);
            return {
                id: config.id,
                platform: "youtube",
                name: config.name,
                profileImage: null,
                url: config.url,
                error: "Données YouTube indisponibles."
            };
        }
    });

    const channels = await Promise.all([
        ...twitchPromises,
        ...youtubePromises
    ]);

    channels.sort((a, b) => {
        if (a.platform === "twitch" && a.isLive) return -1;
        if (b.platform === "twitch" && b.isLive) return 1;
        return 0;
    });

    return {
        success: true,
        updatedAt: new Date().toISOString(),
        cacheSeconds: CACHE_TTL_SECONDS,
        channels,
        errors: channels
            .filter(channel => channel.error)
            .map(channel => `${channel.name} (${channel.platform}) indisponible`)
    };
}

// ========================================
// API : LISTE DES CHAÎNES
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
        console.error("Erreur tableau de bord :", error.message);

        return res.status(500).json({
            success: false,
            error: "Impossible de récupérer les données."
        });
    }
});

// ========================================
// SANTÉ DU SERVEUR
// ========================================

app.get("/health", (req, res) => {
    res.json({
        success: true,
        service: "Mastu Extension API",
        status: "online",
        timestamp: new Date().toISOString()
    });
});

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
    console.log(`Chaînes Twitch : ${TWITCH_CHANNELS.length}`);
    console.log(`Chaînes YouTube : ${YOUTUBE_CHANNELS.length}`);
    console.log("-----------------------------------");
});
