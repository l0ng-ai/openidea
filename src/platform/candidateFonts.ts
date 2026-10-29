/**
 * Bounded legacy fallback, never the primary desktop catalog. Width comparisons
 * can miss installed families and are only hints; they say nothing about coverage.
 */
import type { FontFamily } from "@/bindings";
import { monoFontFamily } from "./fonts";

// Keep the former editor's 31 candidates for recovery, not as an installed-font whitelist.
const CANDIDATES = [
  "JetBrains Mono",
  "SF Mono",
  "Menlo",
  "Monaco",
  "Fira Code",
  "Fira Mono",
  "Source Code Pro",
  "Cascadia Code",
  "Cascadia Mono",
  "IBM Plex Mono",
  "Hack",
  "Inconsolata",
  "Roboto Mono",
  "Ubuntu Mono",
  "DejaVu Sans Mono",
  "Consolas",
  "Courier New",
  "PT Mono",
  "Andale Mono",
  "Victor Mono",
  "Iosevka",
  "Sarasa Mono SC",
  "Noto Sans Mono",
  "Noto Sans Mono CJK SC",
  "PingFang SC",
  "Hiragino Sans GB",
  "Microsoft YaHei",
  "Helvetica Neue",
  "Arial",
  "Inter",
  "Georgia",
];

export function detectCandidateFonts(): FontFamily[] {
  try {
    if (typeof document === "undefined") return [];
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return [];
    const width = (font: string, text: string) => {
      ctx.font = `32px ${font}`;
      return ctx.measureText(text).width;
    };
    const sample = "mmmmmmmmmmlli1WQ@";
    const out: FontFamily[] = [];
    for (const name of CANDIDATES) {
      const present = ["monospace", "serif", "sans-serif"].some((base) => {
        const measured = width(monoFontFamily(name, "", base), sample);
        const baseline = width(base, sample);
        return Number.isFinite(measured) && Number.isFinite(baseline) && measured !== baseline;
      });
      if (!present) continue;
      const narrow = width(monoFontFamily(name, "", "monospace"), "iiiiiiiiii");
      const wide = width(monoFontFamily(name, "", "monospace"), "WWWWWWWWWW");
      out.push({
        name,
        monospaced: Number.isFinite(narrow) && Number.isFinite(wide) && Math.abs(narrow - wide) < 0.5,
      });
    }
    return out;
  } catch {
    // Canvas can be absent or disabled in browser development / hardened webviews.
    // Never mark unmeasurable candidates as installed. The service adds bundled faces.
    return [];
  }
}
