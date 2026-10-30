/**
 * Mermaid diagrams in the Markdown preview. `renderMarkdown` emits a
 * `[data-mermaid]` placeholder holding the source in `pre > code`; this module
 * turns placeholders into SVG. The library is imported on first use only.
 */
import type { Mermaid } from "mermaid";
import { resolveTokenColor, toRgb } from "@/platform/cssColor";
import { attachPanZoom } from "../panZoom";

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
/** mermaid's render isn't re-entrant across configuration changes: one at a time. */
let queue: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<Mermaid> {
  loading ??= import("mermaid").then((m) => m.default);
  loading.catch(() => (loading = null));
  return loading;
}

/** Theme identity: anything that changes the colours read below. */
export function themeKey(): string {
  const root = document.documentElement;
  const { theme = "", contrast = "", colorTheme = "", pluginTheme = "" } = root.dataset;
  return `${theme}|${contrast}|${colorTheme}|${pluginTheme}|${root.style.getPropertyValue("--accent")}`;
}

/** Calls `cb` when the theme attributes (a plugin theme's included) or the accent on the root change. */
export function subscribeTheme(cb: () => void): () => void {
  if (typeof MutationObserver === "undefined") return () => {};
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme", "data-contrast", "data-color-theme", "data-plugin-theme", "style"],
  });
  return () => observer.disconnect();
}

/**
 * Diagram colours from the IDE tokens. Mermaid parses only hex and `rgb()`, so
 * tokens a theme writes as `hsl()`, `color-mix()` or `var()` are resolved to RGB.
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
  const vars: Record<string, string | undefined> = {
    background: token("--bg-editor", "--bg-app"),
    mainBkg: token("--bg-elev"),
    primaryColor: token("--bg-elev"),
    primaryBorderColor: token("--border-strong"),
    primaryTextColor: token("--fg-strong", "--fg"),
    secondaryColor: token("--bg-popup"),
    tertiaryColor: token("--bg-hover"),
    lineColor: token("--fg-secondary"),
    textColor: token("--fg"),
    edgeLabelBackground: token("--bg-editor", "--bg-app"),
    errorBkgColor: token("--bg-elev"),
    errorTextColor: token("--danger"),
  };
  const out: Record<string, string | boolean> = { darkMode: document.documentElement.dataset.theme !== "light" };
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
    suppressErrorRendering: true,
    theme: "base",
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
  const out = document.createElement("div");
  out.className = OUTPUT_CLASS;
  if (result && "svg" in result) {
    out.innerHTML = result.svg;
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
  if (block.getAttribute(RENDERED_ATTR) === "ok") attachPanZoom(out);
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
    const cached = cache.get(k);
    const keep = () => {
      const out = block.querySelector(`:scope > .${OUTPUT_CLASS}`);
      if (out && block.getAttribute(RENDERED_ATTR) === "ok")
        previous[i] = out.querySelector("svg") ?? out.firstChild ?? out;
    };
    if (cached) {
      show(block, cached);
      keep();
      return;
    }
    show(block, null, previous[i]);
    pending.push(
      enqueue(source, key, () => live).then((r) => {
        if (!r) return;
        remember(k, r);
        if (!live) return;
        show(block, r);
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
