/**
 * Monospace font-family lists shared by every consumer of the editor / terminal
 * font. "JetBrains Mono" is the bundled default, but the bundle registers it as
 * "JetBrains Mono Variable" (`@fontsource-variable/jetbrains-mono`); a list that
 * only names "JetBrains Mono" falls through to the system's generic monospace
 * wherever the font isn't installed (SimSun on Chinese Windows).
 */

export const BUNDLED_MONO_FAMILY = "JetBrains Mono";
const BUNDLED_MONO_FACES = ['"JetBrains Mono Variable"', '"JetBrains Mono"'];
const MONO_STACK_FALLBACK = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';

const quote = (f: string) => `"${f.replace(/"/g, "").trim()}"`;

/** The `--font-mono` stack, resolved (canvas / xterm can't use `var()`). */
export function monoStack(): string {
  if (typeof document === "undefined") return MONO_STACK_FALLBACK;
  return getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() || MONO_STACK_FALLBACK;
}

/**
 * `family`, then `fallback`, then `base` (the `--font-mono` stack: `var(--font-mono)`
 * for CSS, `monoStack()` for canvas measurement). The bundled family maps to its
 * bundled face, so it renders without a system install.
 */
export function monoFontFamily(family: string | undefined, fallback = "", base = monoStack()): string {
  const name = (family ?? "").replace(/"/g, "").trim();
  const fb = fallback.replace(/"/g, "").trim();
  const head = !name || name === BUNDLED_MONO_FAMILY ? BUNDLED_MONO_FACES : [quote(name)];
  return [...head, ...(fb ? [quote(fb)] : []), base].join(", ");
}

export const BUNDLED_UI_FAMILY = "Inter";
const BUNDLED_UI_FACES = ['"Inter Variable"', '"Inter"'];

/**
 * The `--font-ui` stack for a custom UI font. The bundled families map to their
 * bundled faces, like `monoFontFamily`, so they render without a system install.
 */
export function uiFontFamily(family: string): string {
  const name = family.replace(/"/g, "").trim();
  const head =
    name === BUNDLED_UI_FAMILY ? BUNDLED_UI_FACES : name === BUNDLED_MONO_FAMILY ? BUNDLED_MONO_FACES : [quote(name)];
  return [...head, "system-ui", "sans-serif"].join(", ");
}

/**
 * Resolves once the faces `family` uses at `size` are loaded, so code that measures
 * glyphs (xterm's cell size) measures the real font rather than the swap fallback.
 */
export async function fontsLoaded(family: string, size: number): Promise<void> {
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (!fonts?.load) return;
  try {
    await Promise.all([fonts.load(`${size}px ${family}`), fonts.load(`bold ${size}px ${family}`)]);
  } catch {
    /* an unparsable list measures with whatever is available */
  }
}
