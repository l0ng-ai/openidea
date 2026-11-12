/**
 * Tools on a drawn Mermaid diagram: a full-screen preview and a PNG export, at
 * the diagram's top-right. `./mermaid` attaches them after every drawing; they
 * are plain DOM, like the rest of the renderer, so both Markdown hosts get them.
 */
import { iconNode } from "@/editor/lsp/iconMarkup";
import { resolveTokenColor, toRgb } from "@/platform/cssColor";
import { tx } from "@/platform/i18n";
import { invokeLocal } from "@/platform/tauriCore";
import { openLayer, trapTab } from "@/ui/popupState";
import { notifications } from "@/workbench/contributions";
import { attachPanZoom } from "../panZoom";
import { reid } from "./svgIds";
import styles from "./MermaidTools.module.css";

/** Marks the tool strip, so a redrawing block replaces it rather than stacking one. */
export const TOOLS_ATTR = "data-mermaid-tools";
const PREVIEW_ATTR = "data-mermaid-preview";
/** Fallback margin around the diagram when the canvas cannot be measured. */
const PREVIEW_PADDING = 48;

type ToolIcon = "fullscreen" | "download" | "close";

export function attachDiagramTools(block: HTMLElement, svg: SVGSVGElement): void {
  block.querySelector(`:scope > [${TOOLS_ATTR}]`)?.remove();
  const tools = document.createElement("div");
  tools.className = styles.tools!;
  tools.setAttribute(TOOLS_ATTR, "");
  tools.append(
    toolButton("fullscreen", tx("Full screen"), (button) => openDiagramPreview(block, svg, button)),
    toolButton("download", tx("Download image"), () => void saveDiagram(svg)),
  );
  block.append(tools);
  // Redrawn (a theme change, an edit) while shown full screen: the preview follows.
  if (preview?.block === block) preview.redraw(svg);
}

function toolButton(icon: ToolIcon, label: string, onClick: (button: HTMLButtonElement) => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = styles.tool!;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(iconNode(icon, 14));
  button.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClick(button);
  });
  return button;
}

let closeActive: (() => void) | null = null;
/** The block shown full screen, and how to show its newest drawing. */
let preview: { block: HTMLElement; redraw: (svg: SVGSVGElement) => void } | null = null;

/**
 * The diagram over the whole window, fitted and centered: drag pans it anywhere,
 * ⌘/Ctrl+wheel zooms, double-click resets. Escape (or a click outside, or Close)
 * returns to the page, with focus back on the button that opened it.
 */
function openDiagramPreview(block: HTMLElement, svg: SVGSVGElement, returnTo?: HTMLElement): void {
  closeActive?.();
  const returnFocus = returnTo ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const overlay = document.createElement("div");
  overlay.className = styles.overlay!;
  overlay.setAttribute(PREVIEW_ATTR, "");
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", tx("Diagram preview"));

  const layer = openLayer(() => overlay);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    if (closeActive === close) closeActive = null;
    if (preview?.redraw === redraw) preview = null;
    document.removeEventListener("keydown", onKey, true);
    layer.release();
    overlay.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  const onKey = (e: KeyboardEvent) => {
    if (!layer.isTop()) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      close();
    } else if (e.key === "Tab") {
      trapTab(e, overlay);
    }
  };

  const canvas = document.createElement("div");
  canvas.className = styles.canvas!;
  overlay.append(canvas);

  const tools = document.createElement("div");
  tools.className = styles.previewTools!;
  const download = toolButton("download", tx("Download image"), () => void saveDiagram(current));
  tools.append(download, toolButton("close", tx("Close"), close));
  overlay.append(tools);

  overlay.addEventListener("pointerdown", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey, true);
  document.body.append(overlay);

  // The canvas fills the window: the fitted drawing is centred in it, and the
  // whole window stays a drag surface once zoomed in. Top rows stay free of it
  // so the Close and Download buttons never cover the drawing.
  const fit = (next: SVGSVGElement) => fittedCopy(next, canvas.clientWidth, Math.max(1, canvas.clientHeight - 32));
  let current = svg;
  let shown = fit(svg);
  const fitted = shown;
  canvas.append(fitted);
  const width = Number(fitted.getAttribute("width"));
  const height = Number(fitted.getAttribute("height"));
  attachPanZoom(canvas, {
    panAlways: true,
    origin: {
      z: 1,
      x: (canvas.clientWidth - width) / 2,
      y: (canvas.clientHeight - height) / 2,
    },
  });
  // In place, inside the pan/zoom layer, so the current pan and zoom stay.
  const redraw = (next: SVGSVGElement) => {
    current = next;
    const copy = fit(next);
    shown.replaceWith(copy);
    shown = copy;
  };
  preview = { block, redraw };
  closeActive = close;
  download.focus({ preventScroll: true });
}

/**
 * A re-ided copy of `svg` fitted into `availW × availH`, keeping its viewBox: a
 * small drawing is enlarged (up to 3×) instead of sitting tiny in the middle.
 */
function fittedCopy(svg: SVGSVGElement, availW: number, availH: number): SVGSVGElement {
  const holder = document.createElement("div");
  holder.innerHTML = reid(svg.outerHTML);
  const copy =
    holder.firstElementChild instanceof SVGSVGElement
      ? holder.firstElementChild
      : (svg.cloneNode(true) as SVGSVGElement);
  const { w, h } = naturalSize(svg);
  const areaW = availW > 0 ? availW : window.innerWidth - PREVIEW_PADDING;
  const areaH = availH > 0 ? availH : window.innerHeight - PREVIEW_PADDING;
  const fit = Math.max(0.01, Math.min(3, areaW / w, areaH / h));
  copy.setAttribute("width", String(Math.max(1, Math.round(w * fit))));
  copy.setAttribute("height", String(Math.max(1, Math.round(h * fit))));
  // Mermaid writes `max-width` inline; the fitted size above must win.
  copy.style.maxWidth = "none";
  return copy;
}

function naturalSize(svg: SVGSVGElement): { w: number; h: number } {
  const box = (svg as SVGSVGElement & { viewBox?: SVGAnimatedRect }).viewBox?.baseVal;
  if (box && box.width > 0 && box.height > 0) return { w: box.width, h: box.height };
  const width = Number(svg.getAttribute("width"));
  const height = Number(svg.getAttribute("height"));
  if (width > 0 && height > 0) return { w: width, h: height };
  const rect = svg.getBoundingClientRect();
  return { w: rect.width > 0 ? rect.width : 800, h: rect.height > 0 ? rect.height : 600 };
}

async function saveDiagram(svg: SVGSVGElement): Promise<void> {
  try {
    const { save } = await import("@/platform/dialog");
    const path = await save({
      title: tx("Save diagram"),
      defaultPath: "mermaid-diagram.png",
      filters: [{ name: tx("PNG image"), extensions: ["png"] }],
    });
    if (!path) return;
    const base64 = await diagramPng(svg);
    // The path comes from this machine's save dialog, so write it here even when
    // the project lives on a remote host.
    await invokeLocal("plugin_web_save_file", { path, base64 });
    notifications().notify({ level: "info", title: "Diagram saved", body: path, key: "mermaid.diagram" });
  } catch (e) {
    notifications().notify({
      level: "error",
      title: "Cannot save the diagram",
      body: errorText(e),
      key: "mermaid.diagram",
    });
  }
}

/** The diagram as a PNG on the editor background, at 2× for crisp lines. */
async function diagramPng(svg: SVGSVGElement): Promise<string> {
  const { w, h } = naturalSize(svg);
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
  copy.setAttribute("width", String(w));
  copy.setAttribute("height", String(h));
  copy.style.maxWidth = "none";
  const markup = new XMLSerializer().serializeToString(copy);
  const image = new Image();
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error(tx("The diagram could not be drawn")));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  });

  // 2× for crisp lines, bounded so a huge diagram still fits a canvas.
  const scale = Math.min(2, 8192 / Math.max(w, h), Math.sqrt(14_000_000 / (w * h)));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error(tx("A canvas is not available"));
  context.scale(scale, scale);
  const background = resolveTokenColor("--bg-editor") ?? resolveTokenColor("--bg-app");
  if (background) {
    context.fillStyle = toRgb(background);
    context.fillRect(0, 0, w, h);
  }
  context.drawImage(image, 0, 0, w, h);
  return canvas.toDataURL("image/png").replace(/^data:image\/png;base64,/, "");
}

function errorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
