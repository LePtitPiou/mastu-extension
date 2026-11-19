// ─────────────────────────────────────────────────────────────────────────────
// Comptes affichés dans l'extension et sur le site.
// Pour ajouter un compte : ajoute une ligne, enregistre, c'est tout. L'ordre ici = l'ordre par défaut.
//
//   Twitch    { platform: "twitch", login: "pseudo" }          (main: true = chaîne principale : live, invités, notifications)
//   YouTube   { platform: "youtube", handle: "@pseudo" }       ou  { platform: "youtube", id: "UC..." }
//   Instagram { platform: "instagram", username: "pseudo" }
//   TikTok    { platform: "tiktok", username: "pseudo" }
//
// Facultatif pour Instagram / TikTok : name: "Nom affiché", logo: "https://…/photo.jpg", description: "Texte"
// Le dernier TikTok / la dernière publication Instagram se mettent à jour depuis le panneau d'administration
// (section « Réseaux sociaux ») ou automatiquement pour Instagram si INSTAGRAM_ACCESS_TOKEN est défini sur Render.
// ─────────────────────────────────────────────────────────────────────────────
module.exports = [
  { platform: "twitch", login: "mastu", main: true },
  { platform: "youtube", handle: "@Mastu" },
  { platform: "youtube", id: "UCLnv0iKl-QbLnkuF-aSZKTQ" }, // Mastu Gear 2
  { platform: "youtube", id: "UCW2JcUbafBUzIYP6X1-3YJQ" }, // Mastu+
];
