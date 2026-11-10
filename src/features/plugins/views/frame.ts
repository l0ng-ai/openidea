/**
 * The document of a view's `html` body. It runs in an `<iframe sandbox=
 * "allow-scripts">` (an opaque origin: no cookies, storage, IDE API or parent
 * access) under a CSP that allows only its own inline scripts and styles and
 * `data:` images — no network. `openidea.postMessage` / `openidea.onMessage`
 * are its only way to the plugin.
 *
 * The IDE theme reaches the frame as `data-theme="light|dark"` on its root and
 * the `--openidea-*` variables of {@link FRAME_THEME_TOKENS}, kept current
 * without reloading the frame; `openidea.theme` / `openidea.onThemeChange` give
 * the same to scripts (canvas drawing, say).
 */
import { resolveTokenColor, toRgb } from "@/platform/cssColor";
import BRIDGE_SOURCE from "./frame-bridge.js?raw";

export const FRAME_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:";

/** Marks frame ↔ workbench messages. */
export const FRAME_TAG = "openidea-view";

/**
 * The theme variables a frame gets: public name → IDE token. Part of the
 * plugin API: names are only ever added, so the IDE's own tokens can change.
 */
export const FRAME_THEME_TOKENS = {
  "--openidea-bg": "--bg-island",
  "--openidea-bg-elevated": "--bg-elev",
  "--openidea-bg-hover": "--bg-hover",
  "--openidea-bg-selected": "--bg-tree-selected",
  "--openidea-bg-input": "--bg-input",
  "--openidea-fg": "--fg",
  "--openidea-fg-strong": "--fg-strong",
  "--openidea-fg-muted": "--fg-muted",
  "--openidea-border": "--border",
  "--openidea-accent": "--accent",
  "--openidea-fg-on-accent": "--fg-on-accent",
  "--openidea-link": "--link",
  "--openidea-focus-ring": "--focus-ring",
  "--openidea-danger": "--danger",
  "--openidea-warning": "--warning",
  "--openidea-success": "--success",
  "--openidea-info": "--info",
} as const;

/** Non-colour variables: public name → IDE token. */
const FRAME_FONT_TOKENS = {
  "--openidea-font-ui": "--font-ui",
  "--openidea-font-mono": "--font-mono",
  "--openidea-font-size": "--fs-ui",
} as const;

export interface FrameTheme {
  dark: boolean;
  /** `--openidea-*` → a concrete value (colours resolved, no `var()`: the frame has no IDE stylesheet). */
  vars: Record<string, string>;
}

/** Font stacks and sizes only; anything that could leave its declaration is dropped. */
const safeValue = (v: string) => v.length <= 400 && !/[<>{};\\]/.test(v);

/** The IDE theme as a frame sees it, read from the root element's tokens. */
export function frameTheme(root: HTMLElement = document.documentElement): FrameTheme {
  const vars: Record<string, string> = {};
  for (const [name, token] of Object.entries(FRAME_THEME_TOKENS)) {
    const c = resolveTokenColor(token, root);
    if (c) vars[name] = toRgb(c);
  }
  if (typeof getComputedStyle !== "undefined") {
    const css = getComputedStyle(root);
    for (const [name, token] of Object.entries(FRAME_FONT_TOKENS)) {
      const v = css.getPropertyValue(token).trim();
      if (v && safeValue(v)) vars[name] = v;
    }
  }
  return { dark: root.dataset.theme !== "light", vars };
}

/** Top-right space reserved for `ToolWindowCornerActions` when a web view uses `header = "none"`. */
export const HEADERLESS_CORNER_INSET = { width: 64, height: 34 } as const;

/** The message that updates a loaded frame's theme. */
export const frameThemeMessage = (theme: FrameTheme) => ({ tag: FRAME_TAG, theme });

/** `window.openidea`, a function expression taking the initial theme (shared with web view pages). */
const bridge = (initial: FrameTheme | null) =>
  `(${BRIDGE_SOURCE.trim().replace(/;$/, "")})(${JSON.stringify(initial).replace(/</g, "\\u003c")});`;

const BASE_STYLE =
  "html[data-theme=light]{color-scheme:light}html[data-theme=dark]{color-scheme:dark}" +
  "body{margin:8px;color:var(--openidea-fg);font-family:var(--openidea-font-ui,system-ui,sans-serif);" +
  "font-size:var(--openidea-font-size,13px)}a{color:var(--openidea-link)}";

/** `html` wrapped with the CSP, the message bridge, the theme and base styles. */
export function frameDocument(html: string, theme: FrameTheme): string {
  return [
    `<!doctype html><html data-theme="${theme.dark ? "dark" : "light"}"><head><meta charset="utf-8">`,
    `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`,
    `<style>${BASE_STYLE}</style>`,
    `<script>${bridge(theme)}</script>`,
    "</head><body>",
    html,
    "</body></html>",
  ].join("");
}
