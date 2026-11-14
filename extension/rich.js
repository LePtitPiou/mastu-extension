// Annonces « type Word » : nettoyage par liste blanche + affichage identique dans l'extension, le site et l'aperçu du panneau.
const RICH_TAGS = new Set(["P", "BR", "DIV", "SPAN", "B", "STRONG", "I", "EM", "U", "S", "STRIKE", "DEL", "SUB", "SUP",
  "H1", "H2", "H3", "UL", "OL", "LI", "BLOCKQUOTE", "HR", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH", "COLGROUP", "COL", "A"]);
const RICH_DROP = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "SVG", "MATH", "FORM", "INPUT",
  "BUTTON", "TEXTAREA", "SELECT", "TEMPLATE", "NOSCRIPT", "IMG", "VIDEO", "AUDIO"]);
const RICH_COLOR = /^(#[0-9a-f]{3,8}|rgba?\([\d\s,.%]+\))$/i;
const RICH_SIZE = /^\d{1,3}(\.\d+)?(px|%)$/;
const RICH_STYLES = {
  "font-size": v => /^\d{1,2}(\.\d+)?px$/.test(v) && parseFloat(v) >= 8 && parseFloat(v) <= 64,
  "font-weight": v => /^(normal|bold|[1-9]00)$/.test(v),
  "font-style": v => /^(normal|italic)$/.test(v),
  "text-decoration": v => /^(none|underline|line-through|underline line-through|line-through underline)$/.test(v),
  "text-align": v => /^(left|right|center|justify)$/.test(v),
  "color": v => RICH_COLOR.test(v),
  "background-color": v => RICH_COLOR.test(v),
  "width": v => RICH_SIZE.test(v),
  "height": v => RICH_SIZE.test(v),
  "vertical-align": v => /^(top|middle|bottom)$/.test(v),
};

function richStyle(css) {
  return css.split(";").map(d => {
    const i = d.indexOf(":");
    if (i < 0) return "";
    const k = d.slice(0, i).trim().toLowerCase(), v = d.slice(i + 1).trim().toLowerCase();
    return RICH_STYLES[k] && RICH_STYLES[k](v) ? `${k}:${v}` : "";
  }).filter(Boolean).join(";");
}

function richClean(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType === 8) { child.remove(); continue; }          // commentaires
    if (child.nodeType !== 1) continue;
    if (RICH_DROP.has(child.tagName)) { child.remove(); continue; }  // balises dangereuses : supprimées
    richClean(child);
    if (!RICH_TAGS.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; } // inconnue : on garde le texte
    for (const at of [...child.attributes]) {
      const n = at.name.toLowerCase(), v = at.value.trim();
      if (n === "style") { const s = richStyle(at.value); if (s) child.setAttribute("style", s); else child.removeAttribute("style"); }
      else if (n === "href" && child.tagName === "A" && /^(https?:|mailto:)/i.test(v)) { /* autorisé */ }
      else if ((n === "colspan" || n === "rowspan") && /^\d{1,2}$/.test(v)) { /* autorisé */ }
      else child.removeAttribute(at.name);
    }
    if (child.tagName === "A") { child.setAttribute("target", "_blank"); child.setAttribute("rel", "noopener noreferrer"); }
  }
}

function sanitizeRich(html) {
  const doc = new DOMParser().parseFromString("<body>" + html, "text/html");
  richClean(doc.body);
  return doc.body.innerHTML;
}
function setRich(el, html) { el.innerHTML = sanitizeRich(html); }
