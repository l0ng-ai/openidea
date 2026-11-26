import { parseLengthPx, parseViewBoxSize } from "@/ui/svgSize";
import type { DiffSide } from "./diffInput";
import { readImageSide } from "./imageDiffInput";
import { imageBounds, type ImageSize } from "./imagePixels";

type Unavailable = { kind: "absent" } | { kind: "error"; error: string };
type Source = { kind: "raster"; url: string } | { kind: "svg"; svg: SVGSVGElement; intrinsic: ImageSize } | Unavailable;
export type ImageFrame =
  | { kind: "ready"; image: HTMLImageElement; intrinsic: ImageSize; size: ImageSize }
  | Unavailable;

export function svgIntrinsicSize(svg: SVGSVGElement): ImageSize {
  const box = parseViewBoxSize(svg.getAttribute("viewBox"));
  const w = parseLengthPx(svg.style.width || svg.getAttribute("width"));
  const h = parseLengthPx(svg.style.height || svg.getAttribute("height"));
  return {
    width: Math.max(1, Math.round(w ?? (h && box ? (h * box.w) / box.h : (box?.w ?? 300)))),
    height: Math.max(1, Math.round(h ?? (w && box ? (w * box.h) / box.w : (box?.h ?? 150)))),
  };
}

function readSvg(url: string): SVGSVGElement {
  const comma = url.indexOf(",");
  const data = url.slice(comma + 1);
  const xml = /;base64/i.test(url.slice(0, comma))
    ? new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
    : decodeURIComponent(data);
  const svg = new DOMParser().parseFromString(xml, "image/svg+xml").documentElement;
  if (svg.localName !== "svg" || svg.namespaceURI !== "http://www.w3.org/2000/svg") throw new Error("Invalid SVG");
  return svg as unknown as SVGSVGElement;
}

/** Set the SVG layout viewport before rasterizing so intrinsic sizes don't stretch one revision's pixels. */
export function svgAtViewport(svg: SVGSVGElement, { width, height }: ImageSize): string {
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.style.setProperty("width", width + "px", "important");
  svg.style.setProperty("height", height + "px", "important");
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(svg));
}

function failed(e: unknown): Unavailable {
  return { kind: "error", error: e instanceof Error ? e.message : String(e) };
}

export async function loadImageFrames(
  path: string,
  sides: DiffSide[],
  cancelled: () => boolean,
): Promise<ImageFrame[]> {
  const sources = await Promise.all(
    sides.map(async (side): Promise<Source> => {
      try {
        const url = await readImageSide(path, side);
        if (cancelled() || url === null) return { kind: "absent" };
        if (!/^data:image\/svg\+xml\b/i.test(url)) return { kind: "raster", url };
        const svg = readSvg(url);
        return { kind: "svg", svg, intrinsic: svgIntrinsicSize(svg) };
      } catch (e) {
        return failed(e);
      }
    }),
  );
  if (cancelled()) return [];
  const viewport = imageBounds(sources.flatMap((s) => (s.kind === "svg" ? [s.intrinsic] : [])));
  return Promise.all(
    sources.map(async (source): Promise<ImageFrame> => {
      if (source.kind === "absent" || source.kind === "error") return source;
      try {
        const image = new Image();
        // Even for XML we only render in an image context, where scripts and external resources are disabled.
        image.src = source.kind === "svg" ? svgAtViewport(source.svg, viewport) : source.url;
        await image.decode();
        const size = { width: image.naturalWidth, height: image.naturalHeight };
        return { kind: "ready", image, size, intrinsic: source.kind === "svg" ? source.intrinsic : size };
      } catch (e) {
        return failed(e);
      }
    }),
  );
}
