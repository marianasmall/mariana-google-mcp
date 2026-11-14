import { parse, serialize, defaultTreeAdapter, html as parse5Html } from "parse5";
import type { DefaultTreeAdapterMap } from "parse5";
import { GuardError } from "./guards.js";

type Node = DefaultTreeAdapterMap["node"];
type ParentNode = DefaultTreeAdapterMap["parentNode"];
type Element = DefaultTreeAdapterMap["element"];

/**
 * Strict allowlist validator + re-serializer for HTML draft bodies.
 *
 * Why this shape: Gmail loads remote resources as soon as the owner OPENS a draft,
 * so an injected <img>, CSS url() or similar leaks data with no send. A text-level
 * guard cannot match how browsers tokenize (tokenize first, decode entities per
 * attribute afterwards). Here the body is parsed with parse5, a WHATWG-spec parser,
 * so every element, attribute and attribute value is exactly what a browser sees.
 * Only allowlisted elements/attributes/CSS survive; anything else is REFUSED (not
 * stripped), except comments and doctypes, which are dropped. The validated tree is
 * re-serialized, and callers must send the RETURNED string, never the input.
 */

const ALLOWED_ELEMENTS = new Set([
  "html", "head", "body", "meta",
  "p", "br", "div", "span", "b", "strong", "i", "em", "u", "s", "small", "sub", "sup",
  "blockquote", "pre", "code", "h1", "h2", "h3", "h4", "h5", "h6",
  "ul", "ol", "li", "hr", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup", "col",
  "center", "font",
]);

const GLOBAL_ATTRS = new Set([
  "dir", "align", "valign", "width", "height", "colspan", "rowspan", "cellpadding", "cellspacing",
  "border", "bgcolor", "color", "face", "size", "title", "alt", "lang", "style",
]);

const ALLOWED_CSS_PROPS = new Set([
  "color", "background-color", "font-family", "font-size", "font-weight", "font-style",
  "text-align", "text-decoration", "line-height", "letter-spacing",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "border-radius", "width", "max-width", "min-width", "height", "vertical-align",
  "display", "white-space", "list-style-type", "border",
]);

// border-* longhands (border-top, border-left-color, border-collapse, ...). Never border-image*.
const BORDER_LONGHAND = /^border-(?:top|right|bottom|left|color|style|width|collapse|spacing)(?:-(?:color|style|width))?$|^border-(?:top|bottom)-(?:left|right)-radius$/;

const HELP =
  "HTML drafts allow basic formatting only: wrap links in <a href>, use inline style for color/font/spacing, images only cid:/data:/allowed hosts.";

function refuse(what: string): never {
  throw new GuardError(`HTML draft refused: ${what} is not allowed. ${HELP}`);
}

const CSS_FORBIDDEN: Array<[RegExp, string]> = [
  [/\\/, "a backslash"],
  [/\/\*/, "a comment"],
  [/url/i, "url"],
  [/image/i, "image"],
  [/@/, "@"],
  [/expression/i, "expression"],
  [/[<>]/, "< or >"],
  [/[\u0000-\u0008\u000a-\u001f\u007f]/, "a line break or control character"],
];

const RGB_FN = /rgba?\(\s*[0-9.,%\s]*\)/gi;
const CSS_VALUE = /^[#a-zA-Z0-9%.,\s"'!-]*$/;

function checkStyle(value: string): void {
  for (const [re, label] of CSS_FORBIDDEN) {
    if (re.test(value)) refuse(`${label} in style=""`);
  }
  for (const raw of value.split(";")) {
    const decl = raw.trim();
    if (decl === "") continue;
    const m = /^([a-zA-Z-]+)\s*:\s*([\s\S]*)$/.exec(decl);
    if (!m) refuse(`the CSS declaration "${decl.slice(0, 40)}"`);
    const prop = m[1].toLowerCase();
    if (!ALLOWED_CSS_PROPS.has(prop) && !BORDER_LONGHAND.test(prop)) refuse(`the CSS property ${prop}`);
    const v = m[2].trim();
    const rest = v.replace(RGB_FN, "");
    if (v === "" || !CSS_VALUE.test(rest)) refuse(`the value of CSS property ${prop}`);
  }
}

const HREF_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

function checkHref(value: string): void {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    refuse(`<a href> that is not an absolute http, https, mailto or tel link`);
  }
  if (!HREF_SCHEMES.has(u.protocol)) refuse(`the link scheme ${u.protocol}`);
}

const CID_SRC = /^cid:[^\s"'<>()\\]+$/i;
const DATA_IMAGE_SRC = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/i;

function checkImgSrc(value: string, hosts: Set<string>): void {
  if (CID_SRC.test(value) || DATA_IMAGE_SRC.test(value)) return;
  // https only, written plainly: the raw authority must be exactly the hostname,
  // so userinfo, any explicit port (even :443), backslashes or odd spacing all fail.
  const authority = /^https:\/\/([^/?#]*)(?:[/?#]|$)/i.exec(value)?.[1];
  let u: URL | null = null;
  try {
    u = new URL(value);
  } catch {
    u = null;
  }
  if (
    authority !== undefined &&
    u !== null &&
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    u.port === "" &&
    authority.toLowerCase() === u.hostname &&
    !u.hostname.endsWith(".") &&
    hosts.has(u.hostname)
  ) {
    return;
  }
  refuse("<img src> other than cid:, data:image (png/jpeg/gif/webp base64) or an https host listed in allowedImageHosts");
}

function checkElement(el: Element, hosts: Set<string>): void {
  const tag = el.tagName;
  if (el.namespaceURI !== parse5Html.NS.HTML || !ALLOWED_ELEMENTS.has(tag)) refuse(`the <${tag}> element`);
  for (const attr of el.attrs) {
    const name = attr.name;
    if (attr.namespace || attr.prefix) refuse(`the ${name} attribute on <${tag}>`);
    if (tag === "meta") {
      if (name !== "charset" || !/^[A-Za-z0-9_.:-]{1,40}$/.test(attr.value)) refuse(`<meta ${name}>`);
      continue;
    }
    if (tag === "a" && name === "href") {
      checkHref(attr.value);
      continue;
    }
    if (tag === "a" && (name === "target" || name === "rel")) {
      if (!/^[A-Za-z0-9_ -]*$/.test(attr.value)) refuse(`the ${name} value on <a>`);
      continue;
    }
    if (tag === "img" && name === "src") {
      checkImgSrc(attr.value, hosts);
      continue;
    }
    if (!GLOBAL_ATTRS.has(name)) refuse(`the ${name} attribute on <${tag}>`);
    if (name === "style") checkStyle(attr.value);
  }
}

function walk(parent: ParentNode, hosts: Set<string>): void {
  // Iterate over a copy: comments and doctypes are removed in place.
  for (const node of [...parent.childNodes] as Node[]) {
    if (defaultTreeAdapter.isCommentNode(node) || defaultTreeAdapter.isDocumentTypeNode(node)) {
      defaultTreeAdapter.detachNode(node);
      continue;
    }
    if (defaultTreeAdapter.isTextNode(node)) continue; // text never fetches
    if (defaultTreeAdapter.isElementNode(node)) {
      checkElement(node, hosts);
      walk(node, hosts);
      continue;
    }
    refuse(`the node ${(node as { nodeName?: string }).nodeName ?? "unknown"}`);
  }
}

export function normalizeImageHosts(allowedImageHosts: string[]): Set<string> {
  return new Set(allowedImageHosts.map((h) => h.trim().toLowerCase()).filter((h) => h && !h.endsWith(".")));
}

/**
 * Validate an HTML draft body against the allowlist and return the re-serialized
 * document. Throws GuardError naming the first offending element, attribute or CSS
 * property. Callers MUST send the returned string, never the input.
 */
export function sanitizeDraftHtml(html: string, opts: { allowedImageHosts: string[] }): string {
  const hosts = normalizeImageHosts(opts.allowedImageHosts ?? []);
  const doc = parse(html);
  walk(doc, hosts);
  return serialize(doc);
}
