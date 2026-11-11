/**
 * Mermaid diagrams in the Markdown preview. `renderMarkdown` emits a
 * `[data-mermaid]` placeholder holding the source in `pre > code`; this module
 * turns placeholders into SVG. The library is imported on first use only.
 */
import { fontsLoaded } from "@/platform/fonts";
import type { Mermaid } from "mermaid";
import { resolveTokenColor, toRgb } from "@/platform/cssColor";
import { themeKey } from "@/platform/themeWatch";
import { attachPanZoom } from "../panZoom";
import { attachDiagramTools, TOOLS_ATTR } from "./mermaidTools";
import { localSvg } from "./localSvg";
import { reid } from "./svgIds";

export const MERMAID_SELECTOR = "[data-mermaid]";
const OUTPUT_CLASS = "mermaid-output";
const RENDERED_ATTR = "data-mermaid-state";

type Result = { svg: string } | { error: string };

let loading: Promise<Mermaid> | null = null;
let configured = "";
let seq = 0;
/** Results by theme + source, so edits elsewhere in the file don't re-render diagrams. */
const cache = new Map<string, Result>();
const CACHE_LIMIT = 64;
/** What each placeholder shows (theme + source): a later pass leaves those it already drew alone. */
const drawn = new WeakMap<HTMLElement, string>();
/** mermaid's render isn't re-entrant across configuration changes: one at a time. */
let queue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  loading.catch(() => (loading = null));
  return loading;
}

/**
 * Diagram colours from the IDE tokens. Mermaid parses only hex and `rgb()`, so
 * tokens a theme writes as `hsl()`, `color-mix()` or `var()` are resolved to RGB.
 *
 * Shape fills cannot be the editor surface: on a dark theme that is nearly the
 * preview background, so nodes, actors and slices paint as black. Class-diagram
 * text is `nodeBorder`, so that has to be the foreground, not a chrome border.
 * `darkMode` then darkens every `cScale*` by 75%; series colours are passed
 * explicitly because a later override restores them.
 */
function themeVariables(): Record<string, string | boolean> {
  const root = document.documentElement;
  const css = getComputedStyle(root);
  const token = (...names: string[]) => {
    for (const n of names) {
      const v = css.getPropertyValue(n).trim();
      if (/^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(v)) return v;
      const resolved = v ? resolveTokenColor(n, root) : null;
      if (resolved) return toRgb(resolved);
    }
    return undefined;
  };
  const dark = root.dataset.theme !== "light";
  const canvas = token("--bg-editor", "--bg-app");
  const surface = dark ? token("--bg-floating-toolbar", "--bg-popup", "--bg-elev") : token("--bg-elev", "--bg-popup");
  const cluster = dark
    ? token("--bg-selected", "--bg-floating-toolbar", "--bg-elev")
    : token("--bg-hover", "--bg-elev");
  const ink = token("--fg-strong", "--fg");
  const line = token("--fg-secondary", "--fg");
  const text = token("--fg");
  const series = [
    "--accent",
    "--chart-series",
    "--success",
    "--warning",
    "--info",
    "--danger",
    "--link",
    "--vcs-modified",
  ]
    .map((name) => token(name))
    .filter((color): color is string => Boolean(color));
  const vars: Record<string, string | undefined> = {
    background: canvas,
    mainBkg: surface,
    secondBkg: surface,
    primaryColor: series[0] ?? surface,
    secondaryColor: series[1] ?? surface,
    tertiaryColor: series[2] ?? surface,
    primaryBorderColor: ink,
    secondaryBorderColor: line,
    tertiaryBorderColor: line,
    nodeBorder: ink,
    primaryTextColor: ink,
    secondaryTextColor: ink,
    tertiaryTextColor: ink,
    nodeTextColor: ink,
    textColor: text,
    titleColor: ink,
    classText: ink,
    lineColor: line,
    defaultLinkColor: line,
    edgeLabelBackground: canvas,
    clusterBkg: cluster,
    clusterBorder: line,
    actorBkg: surface,
    actorBorder: line,
    actorTextColor: ink,
    actorLineColor: line,
    signalColor: text,
    signalTextColor: text,
    labelBoxBkgColor: surface,
    labelBoxBorderColor: line,
    labelTextColor: ink,
    loopTextColor: ink,
    activationBkgColor: cluster,
    activationBorderColor: line,
    sequenceNumberColor: ink,
    sectionBkgColor: cluster,
    sectionBkgColor2: surface,
    altSectionBkgColor: canvas,
    excludeBkgColor: surface,
    taskBkgColor: surface,
    taskBorderColor: ink,
    activeTaskBkgColor: cluster,
    activeTaskBorderColor: token("--accent"),
    doneTaskBkgColor: surface,
    doneTaskBorderColor: line,
    critBkgColor: surface,
    critBorderColor: token("--danger"),
    taskTextColor: ink,
    taskTextDarkColor: ink,
    taskTextOutsideColor: text,
    taskTextClickableColor: token("--link", "--accent"),
    gridColor: line,
    todayLineColor: token("--danger"),
    vertLineColor: token("--accent"),
    labelBackgroundColor: surface,
    compositeBackground: canvas,
    compositeTitleBackground: surface,
    compositeBorder: line,
    innerEndBackground: canvas,
    altBackground: cluster,
    pieStrokeColor: line,
    pieOuterStrokeColor: line,
    pieTitleTextColor: ink,
    pieSectionTextColor: text,
    pieLegendTextColor: ink,
    branchLabelColor: ink,
    tagLabelColor: ink,
    tagLabelBackground: surface,
    commitLabelColor: ink,
    commitLabelBackground: surface,
    archEdgeColor: line,
    archEdgeArrowColor: line,
    archGroupBorderColor: line,
    errorBkgColor: surface,
    errorTextColor: token("--danger"),
    attributeBackgroundColorOdd: surface,
    attributeBackgroundColorEven: cluster,
  };
  for (let i = 0; i < 12 && series.length; i++) {
    const color = series[i % series.length]!;
    vars[`cScale${i}`] = color;
    vars[`cScaleInv${i}`] = ink;
    vars[`cScaleLabel${i}`] = ink;
    vars[`pie${i + 1}`] = color;
    if (i < 8) {
      vars[`git${i}`] = color;
      vars[`gitBranchLabel${i}`] = ink;
    }
  }
  // `none` drops the built-in light-grey halo, which reads as a grey smudge on dark surfaces.
  const out: Record<string, string | boolean> = { darkMode: dark, useGradient: false, dropShadow: "none" };
  for (const [k, v] of Object.entries(vars)) if (v) out[k] = v;
  const font = css.getPropertyValue("--font-ui").trim();
  if (font) out.fontFamily = font;
  return out;
}

function configure(mermaid: Mermaid, key: string) {
  if (configured === key) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // These go into the diagram's stylesheet as written: a diagram setting them could fetch from any host.
    secure: ["themeCSS", "fontFamily", "altFontFamily"],
    suppressErrorRendering: true,
    theme: "base",
    // Each diagram type defaults to "neo": the start state is hard-coded
    // black, and strokes become a gradient of the border colour.
    look: "classic",
    themeVariables: themeVariables(),
  });
  configured = key;
}

function removeTemp(id: string) {
  // mermaid measures in detached-from-preview nodes under <body>: `d<id>` (and `i<id>` when sandboxed).
  for (const tmp of [`d${id}`, `i${id}`, id]) document.getElementById(tmp)?.remove();
}

async function renderOne(source: string, key: string): Promise<Result> {
  const mermaid = await loadMermaid();
  await fontsLoaded(getComputedStyle(document.documentElement).getPropertyValue("--font-ui").trim(), 16);
  configure(mermaid, key);
  const id = `openidea-mermaid-${++seq}`;
  try {
    const { svg } = await mermaid.render(id, source);
    return { svg };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: msg.trim() || "Invalid diagram" };
  } finally {
    removeTemp(id);
  }
}

/** Resolves `null` when the pass was superseded before its turn came. */
function enqueue(source: string, key: string, live: () => boolean): Promise<Result | null> {
  const p = queue.then(() => (live() ? renderOne(source, key) : null));
  queue = p.catch(() => undefined);
  return p;
}

function remember(k: string, r: Result) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  cache.set(k, r);
}

function show(block: HTMLElement, result: Result | null, stale?: Node) {
  block.querySelector(`:scope > .${OUTPUT_CLASS}`)?.remove();
  block.querySelector(`:scope > [${TOOLS_ATTR}]`)?.remove();
  const out = document.createElement("div");
  out.className = OUTPUT_CLASS;
  if (result && "svg" in result) {
    out.append(localSvg(reid(result.svg)));
    block.setAttribute(RENDERED_ATTR, "ok");
  } else if (result) {
    out.setAttribute("role", "alert");
    out.textContent = result.error;
    block.setAttribute(RENDERED_ATTR, "error");
  } else if (stale) {
    // The diagram before this edit, until the new one is ready (no flicker while typing).
    out.append(stale.cloneNode(true));
    block.setAttribute(RENDERED_ATTR, "ok");
  } else {
    block.setAttribute(RENDERED_ATTR, "pending");
    return;
  }
  block.append(out);
  if (block.getAttribute(RENDERED_ATTR) === "ok") {
    attachPanZoom(out);
    const svg = out.querySelector("svg");
    if (svg) attachDiagramTools(block, svg);
  }
}

export const hasMermaid = (root: ParentNode) => root.querySelector(MERMAID_SELECTOR) !== null;

export interface MermaidPass {
  /** Whether some diagram renders asynchronously (it changes the layout when `done`). */
  async: boolean;
  /** Settles when every diagram of the pass is in place (or the pass was cancelled). */
  done: Promise<void>;
  cancel(): void;
}

/**
 * Renders the placeholders under `root`. `previous` holds the last rendered
 * output per block index of the same preview (updated in place) and stands in
 * while a changed diagram renders. Cached results are applied synchronously.
 */
export function renderMermaidIn(root: HTMLElement, previous: Node[] = []): MermaidPass {
  const blocks = [...root.querySelectorAll<HTMLElement>(MERMAID_SELECTOR)];
  let live = true;
  if (!blocks.length) return { async: false, done: Promise.resolve(), cancel: () => {} };
  const key = themeKey();
  const pending: Promise<void>[] = [];
  blocks.forEach((block, i) => {
    const source = (block.querySelector("code")?.textContent ?? "").replace(/\n+$/, "");
    const k = `${key}\n${source}`;
    const keep = () => {
      const out = block.querySelector(`:scope > .${OUTPUT_CLASS}`);
      if (out && block.getAttribute(RENDERED_ATTR) === "ok")
        previous[i] = out.querySelector("svg") ?? out.firstChild ?? out;
    };
    if (drawn.get(block) === k && block.querySelector(`:scope > .${OUTPUT_CLASS}`)) {
      keep();
      return;
    }
    const cached = cache.get(k);
    if (cached) {
      show(block, cached);
      drawn.set(block, k);
      keep();
      return;
    }
    drawn.delete(block);
    show(block, null, previous[i]);
    pending.push(
      enqueue(source, key, () => live).then((r) => {
        if (!r) return;
        remember(k, r);
        if (!live) return;
        show(block, r);
        drawn.set(block, k);
        keep();
      }),
    );
  });
  previous.length = blocks.length;
  return {
    async: pending.length > 0,
    done: Promise.all(pending).then(() => undefined),
    cancel: () => {
      live = false;
    },
  };
}

/** For tests. */
export function resetMermaidForTests() {
  cache.clear();
  configured = "";
  loading = null;
}
