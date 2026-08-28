function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)));
}

const voidTagNames = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const blockTagNames = new Set(["address", "article", "aside", "blockquote", "dd", "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"]);
const knownTagNames = new Set([
  ...blockTagNames,
  ...voidTagNames,
  "a", "abbr", "audio", "b", "bdi", "bdo", "button", "canvas", "caption", "cite", "code", "data", "del", "details", "dfn", "dialog", "em", "font", "head", "html", "i", "iframe", "ins", "kbd", "label", "legend", "main", "mark", "menu", "meter", "noscript", "object", "optgroup", "option", "output", "picture", "progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "select", "slot", "small", "span", "strong", "style", "sub", "summary", "sup", "svg", "symbol", "template", "text", "textarea", "title", "track", "u", "use", "var", "video", "circle", "clipPath", "defs", "ellipse", "g", "line", "path", "polygon", "polyline", "rect",
]);
const tagTokenPattern = /<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)([^>]*)>/g;

function stripMarkup(value: string): string {
  const tokens = [...value.matchAll(tagTokenPattern)];
  const opening = new Set(tokens.filter((token) => token[1] === "").map((token) => token[2].toLowerCase()));
  const closing = new Set(tokens.filter((token) => token[1] === "/").map((token) => token[2].toLowerCase()));
  const paired = new Set([...opening].filter((name) => closing.has(name)));
  const hasMarkupEvidence = paired.size > 0 || tokens.some((token) => token[3].replace(/\/\s*$/, "").trim().length > 0);
  return value.replace(tagTokenPattern, (match, closingMark: string, rawName: string, rawAttributes: string) => {
    const name = rawName.toLowerCase();
    const hasAttributes = rawAttributes.replace(/\/\s*$/, "").trim().length > 0;
    const isMarkup = paired.has(name) || hasAttributes || closingMark === "/" && knownTagNames.has(name) || (voidTagNames.has(name) && hasMarkupEvidence);
    if (!isMarkup) return match;
    if (name === "br") return "\n";
    if (closingMark === "/" && blockTagNames.has(name)) return "\n";
    return "";
  });
}

export function normalizeContent(html: string): string {
  const withoutStructuralMarkup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!doctype\b[^>]*>/gi, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  return decodeHtmlEntities(stripMarkup(withoutStructuralMarkup))
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && lines[index - 1].length > 0))
    .join("\n")
    .trim();
}

export function isCanonicalContent(value: string): boolean {
  return normalizeContent(value) === value;
}
