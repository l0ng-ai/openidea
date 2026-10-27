/**
 * xterm.js theme read from the design tokens at runtime, so the terminal
 * follows the active theme. The 16-colour palette comes from the `--ansi-*`
 * tokens (PyCharm's console colours per theme); when a theme lacks them it is
 * derived from the status + syntax tokens.
 */
import type { ITheme, Terminal } from "@xterm/xterm";
import { fontWeightOf } from "@/platform/editorSettings";
import { BUNDLED_MONO_FAMILY, fontsLoaded, monoFontFamily, monoStack } from "@/platform/fonts";

export type Rgba = [number, number, number, number];

/** Parses `#rgb[a]`, `#rrggbb[aa]`, `rgb[a](…)` and `color(srgb …)`; `null` when unknown. */
export function parseColor(input: string): Rgba | null {
  const s = input.trim().toLowerCase();
  if (s.startsWith("#")) {
    const h = s.slice(1);
    if (!/^[0-9a-f]+$/.test(h)) return null;
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a = "f"] = h.split("") as [string, string, string, string?];
      return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16), parseInt(a + a, 16) / 255];
    }
    if (h.length === 6 || h.length === 8) {
      const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), a];
    }
    return null;
  }
  let m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(s);
  if (m) {
    const alpha = m[4] === undefined ? 1 : m[4].endsWith("%") ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
    return [Number(m[1]), Number(m[2]), Number(m[3]), alpha];
  }
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\s*\)$/.exec(s);
  if (m) {
    return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : Number(m[4])];
  }
  return null;
}

export function toHex([r, g, b]: Rgba): string {
  const h = (n: number) =>
    Math.round(Math.max(0, Math.min(255, n)))
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Linear mix: `t = 0` → `a`, `t = 1` → `b`. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1];
}

/** Reads a token as a colour; `fallback` when missing or unparsable. */
export type TokenReader = (name: string) => string;

const FALLBACK: Record<string, string> = {
  "--bg-app": "#0f1012",
  "--fg": "#b9bbc1",
  "--fg-strong": "#e2e3e6",
  "--fg-subtle": "#6d7076",
  "--accent": "#8fa5d6",
  "--control-off": "#3a3b3f",
};

export function buildTheme(read: TokenReader): ITheme {
  const color = (name: string, fallback = FALLBACK[name] ?? "#808080"): Rgba =>
    parseColor(read(name)) ?? parseColor(fallback)!;

  const bg = color("--bg-island", read("--bg-app") || FALLBACK["--bg-app"]);
  const fg = color("--fg-editor", read("--fg") || FALLBACK["--fg"]);
  const strong = color("--fg-strong");
  const accent = color("--accent");
  const caret = color("--caret", toHex(accent));
  const selection = parseColor(read("--bg-editor-selection"));
  const ansi = (name: string, derived: () => Rgba): Rgba => parseColor(read(`--ansi-${name}`)) ?? derived();

  const red = ansi("red", () => color("--danger", "#c97a6f"));
  const green = ansi("green", () => color("--success", "#8fae7e"));
  const yellow = ansi("yellow", () => color("--warning", "#c9a35f"));
  const blue = ansi("blue", () => color("--syn-keyword", "#8fa5d6"));
  const magenta = ansi("magenta", () => color("--syn-annotation", "#a89bc4"));
  // No cyan token: halfway between the keyword blue and the string green reads as a calm teal.
  const cyan = ansi("cyan", () => mix(blue, color("--syn-string", "#9fb88a"), 0.5));
  const black = ansi("black", () => color("--control-off"));
  const white = ansi("white", () => fg);
  const bright = (name: string, base: Rgba) => toHex(ansi(`bright-${name}`, () => mix(base, strong, 0.28)));

  return {
    background: toHex(bg),
    foreground: toHex(fg),
    cursor: toHex(caret),
    cursorAccent: toHex(bg),
    selectionBackground: toHex(selection ?? mix(bg, accent, 0.32)),
    selectionInactiveBackground: toHex(selection ? mix(bg, selection, 0.6) : mix(bg, accent, 0.18)),
    selectionForeground: undefined,
    // The overview ruler (search matches beside the scrollbar) needs no separator line.
    overviewRulerBorder: toHex(bg),
    black: toHex(black),
    red: toHex(red),
    green: toHex(green),
    yellow: toHex(yellow),
    blue: toHex(blue),
    magenta: toHex(magenta),
    cyan: toHex(cyan),
    white: toHex(white),
    brightBlack: toHex(ansi("bright-black", () => color("--fg-subtle"))),
    brightRed: bright("red", red),
    brightGreen: bright("green", green),
    brightYellow: bright("yellow", yellow),
    brightBlue: bright("blue", blue),
    brightMagenta: bright("magenta", magenta),
    brightCyan: bright("cyan", cyan),
    brightWhite: toHex(ansi("bright-white", () => strong)),
  };
}

/** Search match decorations for @xterm/addon-search (colours must be `#rrggbb`). */
export function buildSearchDecorations(read: TokenReader) {
  const color = (name: string, fallback: string): Rgba => parseColor(read(name)) ?? parseColor(fallback)!;
  const bg = color("--bg-island", read("--bg-app") || FALLBACK["--bg-app"]!);
  const match = parseColor(read("--bg-text-search-result"));
  const active = parseColor(read("--bg-text-search-result-current"));
  if (match && active) {
    return {
      matchBackground: toHex(match),
      matchOverviewRuler: toHex(match),
      activeMatchBackground: toHex(active),
      activeMatchBorder: toHex(active),
      activeMatchColorOverviewRuler: toHex(active),
    };
  }
  const legacyMatch = color("--match", FALLBACK["--accent"]!);
  const legacyActive = color("--warning", "#c9a35f");
  return {
    matchBackground: toHex(mix(bg, legacyMatch, 0.3)),
    matchOverviewRuler: toHex(legacyMatch),
    activeMatchBackground: toHex(mix(bg, legacyActive, 0.45)),
    activeMatchBorder: toHex(legacyActive),
    activeMatchColorOverviewRuler: toHex(legacyActive),
  };
}

export function readSearchDecorations() {
  return buildSearchDecorations(documentTokenReader());
}

/** Reads tokens from the document root, resolving `var()`/`color-mix()` through computed style. */
export function documentTokenReader(): TokenReader {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return (name) => {
    const raw = style.getPropertyValue(name).trim();
    if (!raw || parseColor(raw)) return raw;
    const probe = Object.assign(document.createElement("span"), { hidden: true });
    probe.style.color = `var(${name})`;
    root.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  };
}

export function readTerminalTheme(): ITheme {
  return buildTheme(documentTokenReader());
}

const NERD_FONT_FALLBACKS = [
  "Symbols Nerd Font Mono",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono Nerd Font",
  "MesloLGS NF",
  "MesloLGS Nerd Font",
  "Hack Nerd Font",
  "FiraCode Nerd Font",
  "Hasklug Nerd Font",
  "CaskaydiaCove Nerd Font",
]
  .map((f) => `"${f}"`)
  .join(", ");

export interface TerminalFontSettings {
  useEditorFont: boolean;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fallbackFontFamily: string;
  columnWidth: number;
}

export interface EditorFont {
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  fallbackFont?: string;
  fontWeight?: number;
  boldFontWeight?: number;
}

export interface TerminalFont {
  family: string;
  size: number;
  lineHeight: number;
  letterSpacing: number;
  /** xterm `fontWeight` / `fontWeightBold`. */
  weight: number;
  boldWeight: number;
}

/**
 * Prompt themes (powerlevel10k, starship) use Nerd Font private-use glyphs; list
 * common installs before the generic family so per-glyph fallback finds them.
 */
function withNerdFonts(family: string): string {
  return `${family.replace(/,\s*monospace\s*$/i, "")}, ${NERD_FONT_FALLBACKS}, monospace`;
}

function cssNumber(name: string): number {
  if (typeof document === "undefined") return NaN;
  return parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
}

/**
 * Font from Settings › Tools › Terminal: the editor font (Editor › Font, with its
 * fallback and Typography Settings weights) or the terminal's own family / size / line height (a multiple of the
 * cell height). The family resolves like the editor's (`monoFontFamily`), so the
 * bundled JetBrains Mono is used where it isn't installed; `base` is the resolved
 * `--font-mono` stack, since xterm measures on a canvas and can't use `var()`.
 * The column width (a multiple of the cell width) becomes xterm's letter spacing,
 * from the ≈ 0.6 em advance of monospace fonts.
 */
export function terminalFont(t: TerminalFontSettings, editor: EditorFont | undefined, base = monoStack()): TerminalFont {
  let family: string, fallback: string, size: number, lineHeight: number;
  let weight = 400,
    boldWeight = 700;
  if (!t.useEditorFont) {
    family = t.fontFamily;
    fallback = t.fallbackFontFamily;
    size = t.fontSize;
    lineHeight = t.lineHeight;
  } else {
    family = editor?.fontFamily || BUNDLED_MONO_FAMILY;
    fallback = t.fallbackFontFamily.trim() || editor?.fallbackFont || "";
    size = editor?.fontSize || cssNumber("--fs-code") || 13;
    const lh = editor?.lineHeight ?? (editor?.fontSize ? size * 1.6 : cssNumber("--lh-code") || 21);
    // xterm's lineHeight is a multiplier of the cell height (≈ 1.2 × font size); aim for the editor's line height.
    lineHeight = Math.max(1, Math.round((lh / (size * 1.2)) * 100) / 100);
    weight = fontWeightOf(editor?.fontWeight, weight);
    boldWeight = fontWeightOf(editor?.boldFontWeight, boldWeight);
  }
  const letterSpacing = Math.round((t.columnWidth - 1) * size * 0.6 * 10) / 10;
  return { family: withNerdFonts(monoFontFamily(family, fallback, base)), size, lineHeight, letterSpacing, weight, boldWeight };
}

/**
 * xterm measures its cell once per font change; a webfont still loading (the
 * bundled JetBrains Mono on first open) leaves cells sized for the swap font.
 * Re-measures once the faces load (unless `alive()` turned false), then calls `after` (refit).
 */
export function remeasureWhenFontsLoad(term: Terminal, font: TerminalFont, alive: () => boolean, after: () => void) {
  void fontsLoaded(font.family, font.size).then(() => {
    if (!alive()) return;
    const o = term.options;
    if (o.fontFamily !== font.family) return;
    o.fontFamily = "monospace";
    o.fontFamily = font.family;
    after();
  });
}
