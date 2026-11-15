/**
 * Design tokens as concrete colours. Themes may write tokens as `hsl()`,
 * `color-mix()` or `var()`; consumers outside CSS (the native window, Mermaid,
 * xterm) need RGB, so a token is resolved by the browser and parsed here.
 */

/** Red, green, blue (0–255) and alpha (0–1). */
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

const probes = new WeakMap<HTMLElement, HTMLElement>();

/**
 * `var(name)` (a `color-mix()`, `hsl()`, …) as the browser computes it under `root`. One hidden
 * element per root stays for it: inserting one per token restyled the whole page each time.
 */
export function computedTokenColor(name: string, root: HTMLElement = document.documentElement): string {
  let probe = probes.get(root);
  if (probe?.parentElement !== root) {
    probe = root.ownerDocument.createElement("span");
    probe.hidden = true;
    probe.dataset.tokenProbe = "";
    root.appendChild(probe);
    probes.set(root, probe);
  }
  probe.style.color = `var(${name})`;
  return getComputedStyle(probe).color;
}

/** The computed colour of token `name` on `root`, whatever syntax the theme wrote it in. */
export function resolveTokenColor(name: string, root: HTMLElement = document.documentElement): Rgba | null {
  if (typeof getComputedStyle === "undefined") return null;
  const raw = getComputedStyle(root).getPropertyValue(name).trim();
  if (!raw) return null;
  return parseColor(raw) ?? parseColor(computedTokenColor(name, root));
}

const byte = (v: number) => Math.min(255, Math.max(0, Math.round(v)));

/** `#rrggbb`, or `#rrggbbaa` when translucent. */
export function toHex([r, g, b, a]: Rgba): string {
  const parts = [r, g, b].map(byte);
  if (byte(a * 255) !== 255) parts.push(byte(a * 255));
  return `#${parts.map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** `rgb(r, g, b)`, or `rgba(r, g, b, a)` when translucent. */
export function toRgb([r, g, b, a]: Rgba): string {
  const [rr, gg, bb] = [r, g, b].map(byte);
  return a < 1 ? `rgba(${rr}, ${gg}, ${bb}, ${Math.round(a * 1000) / 1000})` : `rgb(${rr}, ${gg}, ${bb})`;
}
