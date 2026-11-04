/**
 * Color literals of a line for the gutter's color preview: `#rgb` / `#rrggbb` (with alpha),
 * `rgb()` / `rgba()` / `hsl()` / `hsla()`, and CSS named colors in style sheets. Pure; the
 * names are checked by the caller (the browser knows them).
 */

export type ColorFormat = "hex" | "rgb" | "hsl" | "name";

export interface ColorMatch {
  /** UTF-16 offsets in the line. */
  from: number;
  to: number;
  text: string;
  format: ColorFormat;
}

/** Red, green, blue 0–255 and alpha 0–1. */
export type Rgba = [number, number, number, number];

/** Style sheet languages: named colors and unquoted hex values are colors there. */
const STYLE_SHEETS = new Set(["css", "scss", "sass", "less", "stylus", "postcss"]);
/** Markup that embeds style sheets (`<style>`, `style="…"`): unquoted hex values too. */
const MARKUP = new Set(["html", "vue", "svelte", "astro", "xml", "xhtml"]);
/** Prose: `#123` is an issue, `#fab` a heading or a tag. */
const PROSE = new Set(["markdown", "plaintext", "text", "restructuredtext", "asciidoc", "git-commit"]);

const HEX = String.raw`#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])`;
const NUMBER = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?`;
const FUNCTION = String.raw`\b(?:rgba?|hsla?)\(\s*${NUMBER}(?:deg|%)?(?:\s*[,\s]\s*${NUMBER}%?){2}(?:\s*[,/]\s*${NUMBER}%?)?\s*\)`;
const COLOR_RE = new RegExp(`${FUNCTION}|${HEX}|(?<![\\w.#$@-])[a-zA-Z]{3,20}(?![\\w(-])`, "g");

/** Global keywords and words that are valid colors but say nothing about one. */
const NOT_COLORS = new Set(["inherit", "initial", "unset", "revert", "currentcolor", "transparent"]);

/**
 * The colors on `line` of a document in `language`. Outside style sheets and markup, only quoted hex
 * values (`"#1b766c"`) and color functions count: `#add` may be a comment, `#123` an issue.
 */
export function findColors(line: string, language: string, isColorName: (word: string) => boolean): ColorMatch[] {
  if (PROSE.has(language)) return [];
  const sheet = STYLE_SHEETS.has(language);
  const looseHex = sheet || MARKUP.has(language);
  const out: ColorMatch[] = [];
  for (const m of line.matchAll(COLOR_RE)) {
    const text = m[0];
    const from = m.index;
    const format: ColorFormat = text.startsWith("#")
      ? "hex"
      : text.includes("(")
        ? /^r/i.test(text)
          ? "rgb"
          : "hsl"
        : "name";
    if (format === "name") {
      // A property value (`color: red`), not a property, selector or at-rule.
      if (!sheet || NOT_COLORS.has(text.toLowerCase()) || !/:\s*(?:\S+\s+)*$/.test(line.slice(0, from))) continue;
      if (!isColorName(text)) continue;
    } else if (format === "hex" && !looseHex && !/["'`]$/.test(line.slice(0, from))) continue;
    out.push({ from, to: from + text.length, text, format });
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const hex2 = (v: number) =>
  Math.round(clamp(v, 0, 255))
    .toString(16)
    .padStart(2, "0");
const round = (v: number, digits = 2) => String(Number(v.toFixed(digits)));

/** `#rrggbb` of `rgba`, as `<input type=color>` takes it. */
export function toHex6([r, g, b]: Rgba): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

/** `#rrggbb` → its components with `alpha`. */
export function fromHex6(hex: string, alpha: number): Rgba | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  return m ? [Number.parseInt(m[1]!, 16), Number.parseInt(m[2]!, 16), Number.parseInt(m[3]!, 16), alpha] : null;
}

/** Components of the browser's computed color (`rgb(1, 2, 3)` / `rgba(1, 2, 3, 0.5)`), null for other spaces. */
export function parseComputed(color: string): Rgba | null {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color.trim());
  if (!m) return null;
  const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
  return [Number(m[1]), Number(m[2]), Number(m[3]), a];
}

function toHsl([r, g, b]: Rgba): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

/**
 * `rgba` written in the original's format: hex keeps its case and whether it had alpha, a function
 * keeps its name and separators; a named color becomes hex.
 */
export function formatColor(rgba: Rgba, original: ColorMatch): string {
  const alpha = rgba[3];
  const hasAlpha = alpha < 1;
  if (original.format === "hex" || original.format === "name") {
    const short = original.text.length === 4 || original.text.length === 5;
    const hadAlpha = original.format === "hex" && (original.text.length === 5 || original.text.length === 9);
    let hex = toHex6(rgba) + (hadAlpha || hasAlpha ? hex2(alpha * 255) : "");
    // `#abc` stays short when the new color has a short form.
    if (short && /^#(?:([0-9a-f])\1)+$/.test(hex)) hex = `#${hex.slice(1).replace(/(.)\1/g, "$1")}`;
    return /[A-F]/.test(original.text) ? hex.toUpperCase() : hex;
  }
  const name = /^\w+/.exec(original.text)![0];
  const commas = original.text.includes(",");
  // The original's fourth component is its alpha.
  const withAlpha = hasAlpha || (original.text.match(new RegExp(NUMBER, "g"))?.length ?? 0) > 3;
  const parts =
    original.format === "rgb"
      ? rgba.slice(0, 3).map((v) => String(Math.round(clamp(v, 0, 255))))
      : toHsl(rgba).map((v, i) => (i === 0 ? round(v, 0) : `${round(v, 1)}%`));
  const a = round(alpha);
  if (commas) return `${name}(${parts.join(", ")}${withAlpha ? `, ${a}` : ""})`;
  return `${name}(${parts.join(" ")}${withAlpha ? ` / ${a}` : ""})`;
}
