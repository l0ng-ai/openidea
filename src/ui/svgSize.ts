/**
 * Intrinsic CSS pixel dimensions of SVGs and Markdown preview images, so
 * diagrams and embedded `.svg` / raster assets scale with `--markdown-zoom-scale`.
 */

const UNIT_PX: Record<string, number> = {
  "": 1,
  px: 1,
  pt: 96 / 72,
  pc: 16,
  in: 96,
  cm: 96 / 2.54,
  mm: 96 / 25.4,
};

/** Parses an absolute SVG/HTML length into CSS pixels (ignoring `%`, `em`, etc.). */
export function parseLengthPx(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*([a-z%]*)\s*$/i.exec(raw);
  if (!m) return null;
  const factor = UNIT_PX[m[2]!.toLowerCase()];
  if (!factor) return null;
  const n = Number(m[1]) * factor;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parsePercent(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)%\s*$/.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Parses `viewBox="minX minY width height"` into `{ w, h }`. */
export function parseViewBoxSize(raw: string | null | undefined): { w: number; h: number } | null {
  if (!raw) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4) return null;
  const w = parts[2]!;
  const h = parts[3]!;
  return Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
}

function resolveSvgDims(
  style: string | null | undefined,
  widthAttr: string | null | undefined,
  heightAttr: string | null | undefined,
  viewBoxAttr: string | null | undefined,
): { w: number; h: number } | null {
  const vb = parseViewBoxSize(viewBoxAttr);
  const storedW = parseLengthPx(/(?:^|;)\s*--diagram-width\s*:\s*([^;]+)/i.exec(style ?? "")?.[1]);
  const inlineMaxW = parseLengthPx(/(?:^|;)\s*max-width\s*:\s*([^;]+)/i.exec(style ?? "")?.[1]);
  const attrW = parseLengthPx(widthAttr);
  const attrH = parseLengthPx(heightAttr);

  const w = storedW ?? inlineMaxW ?? attrW ?? (attrH && vb ? (attrH * vb.w) / vb.h : (vb?.w ?? null));
  if (!w) return null;
  const h = attrH ?? (vb ? (w * vb.h) / vb.w : w * 0.75);
  return { w, h };
}

/** Intrinsic CSS pixel size of an in-DOM `<svg>`, when declared on the element. */
export function svgElementSize(svg: SVGSVGElement): { w: number; h: number } | null {
  const fromAttrs = resolveSvgDims(
    svg.getAttribute("style"),
    svg.getAttribute("width"),
    svg.getAttribute("height"),
    svg.getAttribute("viewBox"),
  );
  if (fromAttrs) return fromAttrs;
  const box = (svg as SVGSVGElement & { viewBox?: SVGAnimatedRect }).viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { w: box.width, h: box.height };
  return null;
}

function readAttr(tag: string, name: string): string | null {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * Intrinsic CSS pixel size of a `data:image/svg+xml` URL from its `<svg>` header.
 * Decodes only the leading chunk so large `.excalidraw.svg` scenes stay cheap.
 */
export function svgDataUrlSize(url: string): { w: number; h: number } | null {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(0, comma);
  if (!/^data:image\/svg\+xml\b/i.test(header)) return null;
  const payload = url.slice(comma + 1, comma + 1 + 16384);
  let head: string;
  try {
    if (/;base64\b/i.test(header)) {
      const clean = payload.replace(/\s+/g, "");
      const aligned = clean.slice(0, clean.length - (clean.length % 4));
      head = atob(aligned);
    } else {
      const safe = payload.replace(/%[0-9a-f]?$/i, "");
      head = decodeURIComponent(safe);
    }
  } catch {
    return null;
  }
  const withoutComments = head.replace(/<!--[\s\S]*?-->/g, "");
  const open = /<svg\b((?:"[^"]*"|'[^']*'|[^'">])*)>/i.exec(withoutComments);
  if (!open) return null;
  const attrs = open[1]!;
  return resolveSvgDims(
    readAttr(attrs, "style"),
    readAttr(attrs, "width"),
    readAttr(attrs, "height"),
    readAttr(attrs, "viewBox"),
  );
}

const formatPx = (n: number) => `${Number(n.toFixed(2))}px`;

/**
 * Sets an `<img>`'s 1× base width so CSS scales it by `--markdown-zoom-scale`,
 * respecting explicit HTML `width` / `height` attributes when present.
 */
export function applyImageZoomWidth(img: HTMLImageElement, intrinsic?: { w: number; h: number } | null): boolean {
  const rawWidth = img.getAttribute("width");
  const pct = parsePercent(rawWidth);
  if (pct !== null) {
    img.style.width = `calc(${pct}% * var(--markdown-zoom-scale, 1))`;
    img.style.height = "auto";
    return true;
  }
  const attrW = parseLengthPx(rawWidth);
  if (attrW !== null) {
    img.style.setProperty("--image-width", formatPx(attrW));
    img.dataset.naturalWidth = "";
    return true;
  }
  if (!intrinsic || intrinsic.w <= 0 || intrinsic.h <= 0) return false;
  const attrH = parseLengthPx(img.getAttribute("height"));
  const baseW = attrH !== null ? (attrH * intrinsic.w) / intrinsic.h : intrinsic.w;
  img.style.setProperty("--image-width", formatPx(baseW));
  img.dataset.naturalWidth = "";
  return true;
}
