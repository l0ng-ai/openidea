import DOMPurify from "dompurify";
import { Marked } from "marked";
import { mimeText, object, own } from "./outputs";

export const OUTPUT_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; font-src 'none'; media-src 'none'; navigate-to 'none'";
const HTML_TAGS = [
  "div",
  "span",
  "p",
  "br",
  "hr",
  "pre",
  "code",
  "samp",
  "kbd",
  "b",
  "strong",
  "i",
  "em",
  "u",
  "s",
  "small",
  "sub",
  "sup",
  "blockquote",
  "ul",
  "ol",
  "li",
  "dl",
  "dt",
  "dd",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "caption",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "colgroup",
  "col",
  "img",
  "a",
  "details",
  "summary",
];
const RASTER = /^data:image\/(?:png|jpeg);base64,[a-z0-9+/=\s]+$/i;
const SVG_TAGS: Record<string, true> = {
  svg: true,
  g: true,
  defs: true,
  path: true,
  rect: true,
  circle: true,
  ellipse: true,
  line: true,
  polyline: true,
  polygon: true,
  text: true,
  tspan: true,
  title: true,
  desc: true,
  clippath: true,
  mask: true,
  lineargradient: true,
  radialgradient: true,
  stop: true,
  use: true,
  symbol: true,
  pattern: true,
  image: true,
};
const SVG_ATTRS: Record<string, true> = {
  xmlns: true,
  viewbox: true,
  width: true,
  height: true,
  x: true,
  y: true,
  x1: true,
  x2: true,
  y1: true,
  y2: true,
  cx: true,
  cy: true,
  r: true,
  rx: true,
  ry: true,
  d: true,
  points: true,
  transform: true,
  id: true,
  fill: true,
  "fill-opacity": true,
  "fill-rule": true,
  stroke: true,
  "stroke-width": true,
  "stroke-opacity": true,
  "stroke-linecap": true,
  "stroke-linejoin": true,
  "stroke-dasharray": true,
  "stroke-dashoffset": true,
  opacity: true,
  "clip-path": true,
  "clip-rule": true,
  clippathunits: true,
  mask: true,
  maskunits: true,
  gradientunits: true,
  gradienttransform: true,
  offset: true,
  "stop-color": true,
  "stop-opacity": true,
  "font-family": true,
  "font-size": true,
  "font-weight": true,
  "font-style": true,
  "text-anchor": true,
  "dominant-baseline": true,
  dx: true,
  dy: true,
  preserveaspectratio: true,
  patternunits: true,
  patterntransform: true,
  href: true,
  "xlink:href": true,
};

/** Image-only SVG: no foreign HTML, animation, scripts, CSS, or external references. */
export function sanitizedSvgUrl(source: string): string {
  const clean = DOMPurify.sanitize(source, {
    USE_PROFILES: { svg: true, svgFilters: false },
    ADD_TAGS: ["use"],
    RETURN_DOM_FRAGMENT: true,
  });
  const svg = clean.querySelector("svg");
  if (!svg) return "";
  for (const node of [svg, ...svg.querySelectorAll("*")]) {
    if (!Object.hasOwn(SVG_TAGS, node.localName.toLowerCase())) {
      node.remove();
      continue;
    }
    // Matplotlib uses presentation CSS. Convert only safe paint/text properties
    // to SVG attributes before dropping style itself.
    const presentation = node.getAttribute("style");
    if (presentation)
      for (const declaration of presentation.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon < 0) continue;
        const name = declaration.slice(0, colon).trim().toLowerCase();
        const value = declaration.slice(colon + 1).trim();
        if (
          /^(?:fill(?:-opacity|-rule)?|stroke(?:-width|-opacity|-linecap|-linejoin|-dasharray|-dashoffset)?|opacity|font-size|font-weight|font-style|font-family|text-anchor|stop-color|stop-opacity)$/.test(
            name,
          )
        )
          node.setAttribute(name, value);
      }
    for (const attr of [...node.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (
        !Object.hasOwn(SVG_ATTRS, name) ||
        /[\p{Cc}\\]/u.test(value) ||
        ((name === "href" || name === "xlink:href") &&
          !/^#[\w.-]+$/.test(value) &&
          !(node.localName.toLowerCase() === "image" && RASTER.test(value))) ||
        (/url\s*\(/i.test(value) && !/^url\(\s*#[\w.-]+\s*\)$/i.test(value))
      )
        node.removeAttribute(attr.name);
    }
  }
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
}

function htmlRoot(html: string, markdown = false): HTMLElement {
  const root = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: HTML_TAGS,
    ALLOWED_ATTR: [
      "src",
      "alt",
      "title",
      "width",
      "height",
      "colspan",
      "rowspan",
      "scope",
      "align",
      ...(markdown ? ["href"] : ["style"]),
    ],
    // Attachment references are resolved by us after sanitization. No arbitrary
    // URI survives the explicit src allowlist below.
    ADD_URI_SAFE_ATTR: ["src"],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    RETURN_DOM: true,
  }) as HTMLElement;
  for (const node of root.querySelectorAll("*")) {
    // Style attributes are iframe-only. Strip URL-bearing declarations even
    // though the child CSP also blocks their network requests.
    const style = node.getAttribute("style");
    if (style && /url\s*\(|image-set\s*\(|src\s*\(|https?:|\/\/|@|\\|expression\s*\(|behavior|binding/i.test(style))
      node.removeAttribute("style");
    const src = node.getAttribute("src");
    if (src && !RASTER.test(src) && !(markdown && src.startsWith("attachment:"))) node.removeAttribute("src");
    if (!markdown) node.removeAttribute("href");
  }
  return root;
}

export function staticOutputDocument(html: string): string {
  const root = htmlRoot(html);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${OUTPUT_CSP}"><style>body{margin:8px;font:13px system-ui,sans-serif;color:#222;background:white;overflow-wrap:anywhere}table{border-collapse:collapse;max-width:100%}th,td{padding:4px 8px;border:1px solid #ddd;text-align:left}pre{white-space:pre-wrap}img{max-width:100%;height:auto}</style></head><body>${root.innerHTML}</body></html>`;
}

const markdown = new Marked({ gfm: true });
/**
 * Sanitized Markdown with inert links; link clicks are handled by the editor and
 * `attachment:` images are left for `resolveMarkdownAttachments`.
 */
export function markdownRoot(source: string): HTMLElement {
  const root = htmlRoot(markdown.parse(source, { async: false }) as string, true);
  for (const link of root.querySelectorAll("a[href]")) {
    const href = link.getAttribute("href")!;
    link.removeAttribute("href");
    link.setAttribute("data-notebook-href", href);
    link.setAttribute("role", "link");
    link.setAttribute("tabindex", "0");
  }
  return root;
}

function attachmentName(img: Element): string | null | undefined {
  const src = img.getAttribute("src");
  if (!src?.startsWith("attachment:")) return undefined;
  try {
    return decodeURIComponent(src.slice("attachment:".length));
  } catch {
    return null;
  }
}

/** Names referenced after Markdown entity and URI decoding, which a source-text search would miss. */
export function markdownAttachmentNames(root: HTMLElement): string[] {
  const names = new Set<string>();
  for (const img of root.querySelectorAll("img")) {
    const name = attachmentName(img);
    if (name) names.add(name);
  }
  return [...names];
}

/** Host Markdown has no arbitrary CSS or remote images: only embedded attachments resolve. */
export function resolveMarkdownAttachments(root: HTMLElement, attachments: unknown): HTMLElement {
  for (const img of root.querySelectorAll("img")) {
    const name = attachmentName(img);
    if (name === undefined) continue;
    if (name === null) {
      img.removeAttribute("src");
      continue;
    }
    const data = object(own(attachments, name));
    const url = imageMimeUrl(data);
    if (url) img.setAttribute("src", url);
    else img.replaceWith(document.createTextNode(img.getAttribute("alt") || name));
  }
  return root;
}

export function imageMimeUrl(bundle: Record<string, unknown>): string {
  for (const mime of ["image/png", "image/jpeg"]) {
    const value = mimeText(bundle[mime]).replace(/\s/g, "");
    if (value && /^[a-z0-9+/=]+$/i.test(value)) return `data:${mime};base64,${value}`;
  }
  const svg = mimeText(bundle["image/svg+xml"]);
  return svg ? sanitizedSvgUrl(svg) : "";
}
