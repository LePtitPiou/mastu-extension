// Détecte où tourne la page : dans l'extension Chrome ("ext") ou sur le site web, ex. GitHub Pages ("web")
const IS_EXT = !!(window.chrome && chrome.runtime && chrome.runtime.id);
document.documentElement.dataset.env = IS_EXT ? "ext" : "web";
