/**
 * The Graphviz plugin's preview: renders the `.dot` file it is opened beside
 * (read only: the text editor next to it is where it changes) with viz.js,
 * follows the IDE theme, zooms and pans, exports SVG and PNG through the
 * IDE's save dialog, and sends what Graphviz reports to the plugin's code,
 * which turns it into the file's problems.
 */
import { instance, type Viz } from "@viz-js/viz";
import { ENGINES, type Engine, exportName, problemsOf, renderOptions } from "./render";

const RENDER_DELAY_MS = 150;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;
/** The most Fit enlarges a small graph to (opening a file never enlarges it). */
const MAX_FIT = 4;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function start(bridge: OpenideaBridge) {
  const stage = $<HTMLDivElement>("stage");
  const canvas = $<HTMLDivElement>("canvas");
  const banner = $<HTMLDivElement>("banner");
  const engineSelect = $<HTMLSelectElement>("engine");
  const zoomLabel = $<HTMLSpanElement>("zoom-label");

  for (const e of ENGINES) engineSelect.add(new Option(e, e));

  let viz: Viz | null = null;
  let text = "";
  let name = "graph.dot";
  let engine: Engine = "dot";
  let zoom = 1;
  let fitted = true;
  // How far fitting may enlarge: 1 until the user asks for Fit.
  let fitCap = 1;
  let timer = 0;
  let lastProblems = "";

  const foreground = () => bridge.theme?.vars["--openidea-fg"] ?? null;

  function setZoom(z: number, keepFit = false) {
    zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    fitted = keepFit;
    // `zoom`, not a transform: the scroll area follows the scaled size.
    canvas.style.zoom = String(zoom);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function fit() {
    const svg = canvas.querySelector("svg");
    if (!svg) return;
    // Graphviz sizes its SVG in points; these are CSS pixels at 100%.
    const w = svg.width.baseVal.value;
    const h = svg.height.baseVal.value;
    if (!w || !h) return;
    // The canvas's padding (16px a side) scales with it; a pixel spare for rounding.
    const pad = 32;
    const z = Math.min((stage.clientWidth - 1) / (w + pad), (stage.clientHeight - 1) / (h + pad), fitCap);
    setZoom(z > 0 && Number.isFinite(z) ? z : 1, true);
  }

  /** What Graphviz said, to the plugin (only when it changed: each one republishes the problems). */
  function report(problems: ReturnType<typeof problemsOf>) {
    const key = JSON.stringify(problems);
    if (key === lastProblems) return;
    lastProblems = key;
    bridge.postMessage(JSON.stringify({ op: "problems", items: problems }));
  }

  function render() {
    if (!viz) return;
    const result = viz.render(text, renderOptions(engine, foreground()));
    const problems = problemsOf(result);
    report(problems);
    if (result.status === "success") {
      canvas.innerHTML = result.output;
      canvas.classList.remove("stale");
      banner.hidden = true;
      if (fitted) fit();
    } else {
      // The last good graph stays, dimmed, under what went wrong.
      canvas.classList.add("stale");
      banner.hidden = false;
      banner.textContent = problems.map((p) => (p.line ? `Line ${p.line}: ${p.message}` : p.message)).join("\n");
    }
  }

  const schedule = (delay = RENDER_DELAY_MS) => {
    clearTimeout(timer);
    timer = window.setTimeout(render, delay);
  };

  /** The graph as Graphviz draws it, without the theme's defaults. */
  function exportSvg(): string | null {
    if (!viz) return null;
    const result = viz.render(text, renderOptions(engine, null));
    return result.status === "success" ? result.output : null;
  }

  /** Runs an export; a failure (no dialog, the image not drawn) shows in the banner. */
  async function exporting(run: () => Promise<void>) {
    try {
      await run();
    } catch (e) {
      banner.hidden = false;
      banner.textContent = `Export failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async function saveSvg() {
    const svg = exportSvg();
    if (!svg) return;
    await bridge.saveFile({
      name: exportName(name, "svg"),
      data: svg,
      filters: [{ name: "SVG image", extensions: ["svg"] }],
    });
  }

  async function savePng() {
    const svg = exportSvg();
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("the graph could not be drawn as an image"));
        img.src = url;
      });
      const scale = 2;
      const c = document.createElement("canvas");
      c.width = Math.ceil(img.naturalWidth * scale);
      c.height = Math.ceil(img.naturalHeight * scale);
      const ctx = c.getContext("2d")!;
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);
      const png = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, "image/png"));
      if (!png) throw new Error("the image could not be encoded");
      await bridge.saveFile({
        name: exportName(name, "png"),
        data: png,
        filters: [{ name: "PNG image", extensions: ["png"] }],
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  engineSelect.addEventListener("change", () => {
    engine = engineSelect.value as Engine;
    fitted = true;
    schedule(0);
  });
  $("zoom-in").addEventListener("click", () => setZoom(zoom * 1.25));
  $("zoom-out").addEventListener("click", () => setZoom(zoom / 1.25));
  $("zoom-fit").addEventListener("click", () => {
    fitCap = MAX_FIT;
    fit();
  });
  $("zoom-reset").addEventListener("click", () => setZoom(1));
  $("export-svg").addEventListener("click", () => void exporting(saveSvg));
  $("export-png").addEventListener("click", () => void exporting(savePng));
  // ⌘/Ctrl + wheel (and pinch) zooms; the wheel alone scrolls.
  stage.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom(zoom * Math.exp(-e.deltaY / 300));
    },
    { passive: false },
  );
  // Dragging pans.
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const [x, y, left, top] = [e.clientX, e.clientY, stage.scrollLeft, stage.scrollTop];
    stage.setPointerCapture(e.pointerId);
    stage.classList.add("panning");
    const move = (m: PointerEvent) => {
      stage.scrollLeft = left - (m.clientX - x);
      stage.scrollTop = top - (m.clientY - y);
    };
    const up = () => {
      stage.classList.remove("panning");
      stage.removeEventListener("pointermove", move);
      stage.removeEventListener("pointerup", up);
    };
    stage.addEventListener("pointermove", move);
    stage.addEventListener("pointerup", up);
  });
  new ResizeObserver(() => fitted && fit()).observe(stage);
  bridge.onThemeChange(() => schedule(0));
  bridge.document.onChange((s) => {
    text = s.text;
    schedule();
  });

  void (async () => {
    const [doc, v] = await Promise.all([bridge.document.get(), instance()]);
    viz = v;
    text = doc.text;
    name = doc.name || name;
    render();
  })().catch((e: unknown) => {
    banner.hidden = false;
    banner.textContent = `The preview could not start: ${e instanceof Error ? e.message : String(e)}`;
  });
}

const bridge = window.openidea;
if (bridge) start(bridge);
else document.body.textContent = "This page runs inside OpenIDEA.";
