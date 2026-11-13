const API_BASE = "https://mastu-extension-api.onrender.com";
const REFRESH_MINUTES = 0.5; // vérification toutes les 30 s en arrière-plan

const DEFAULTS = {
  theme: "auto",          // auto | light | dark
  notifChrome: true,      // notifications Google Chrome
  notifLive: true,
  notifVideo: true,
  notifNews: true,
  autoOpenLive: false,    // Twitch : ouvrir le live dans un nouvel onglet dès qu'il démarre
  muteOnStart: false,     // Twitch : couper le son du live à l'ouverture
  autoClaim: true,        // Twitch : récupérer les Crazy Coins
  hideVideo: false,       // Twitch : cacher la fenêtre vidéo
  lowQuality: false,      // Twitch : qualité minimale
  channelPrefs: { order: [], hidden: {}, muted: {} } // chaînes : ordre, visibilité, notifications coupées
};

