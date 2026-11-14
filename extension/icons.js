// Icônes : un fichier SVG par icône dans le dossier svg/.
// Pour ajouter ou changer une icône : crée / remplace svg/nom.svg, puis ajoute "nom" dans la liste ci-dessous
// et utilise <i data-icon="nom"></i> dans popup.html. Les SVG sont insérés tels quels (couleur = currentColor, animations possibles).
const ICON_NAMES = ["bell", "settings", "home", "list", "bolt", "check-all", "refresh", "external", "caret", "grip",
  "youtube", "twitch", "instagram", "tiktok"];

const ICON_CACHE = {};
const iconsReady = Promise.all(ICON_NAMES.map(async name => {
  try { const r = await fetch(`svg/${name}.svg`); ICON_CACHE[name] = r.ok ? await r.text() : ""; }
  catch (_) { ICON_CACHE[name] = ""; }
}));

// remplace chaque <i data-icon="nom"> de la zone par le SVG correspondant (garde ses classes)
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-icon]").forEach(ph => {
    const doc = new DOMParser().parseFromString(ICON_CACHE[ph.dataset.icon] || "", "image/svg+xml");
    const src = doc.documentElement;
    if (!src || src.nodeName !== "svg") return;
    const svg = document.importNode(src, true);
    svg.classList.add("icon");
    ph.classList.forEach(c => svg.classList.add(c));
    svg.setAttribute("aria-hidden", "true");
    ph.replaceWith(svg);
  });
}
