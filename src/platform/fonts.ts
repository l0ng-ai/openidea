/**
 * Monospace font-family lists shared by every consumer of the editor / terminal
 * font. "JetBrains Mono" is the bundled default, but the bundle registers it as
 * "JetBrains Mono Variable" (`@fontsource-variable/jetbrains-mono`); a list that
 * only names "JetBrains Mono" falls through to the system's generic monospace
 * wherever the font isn't installed (SimSun on Chinese Windows).
 */

export const BUNDLED_MONO_FAMILY = "JetBrains Mono";
export const BUNDLED_UI_FAMILY = "Inter";
const BUNDLED_FACES: ReadonlyMap<string, readonly string[]> = new Map([
  [BUNDLED_MONO_FAMILY.toLowerCase(), ['"JetBrains Mono Variable"', '"JetBrains Mono"']],
  [BUNDLED_UI_FAMILY.toLowerCase(), ['"Inter Variable"', '"Inter"']],
]);
const MONO_STACK_FALLBACK = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';

/** Quote one CSS family safely (including quotes, backslashes and control characters). */
export const quoteFontFamily = (family: string) =>
  // oxlint-disable-next-line no-control-regex -- CSS string escaping must cover controls
  `"${family.trim().replace(/["\\\x00-\x1f\x7f]/g, (char) => `\\${char.codePointAt(0)!.toString(16)} `)}"`;

// Preserve compatibility with previously saved names wrapped in CSS quotes.
const familyName = (family: string) => family.trim().replace(/^"(.*)"$/, "$1");

/** One resolver for primary, fallback and UI families, matching the bundled CSS registrations. */
function familyFaces(family: string): readonly string[] {
  const name = familyName(family);
  return BUNDLED_FACES.get(name.toLowerCase()) ?? [quoteFontFamily(name)];
}

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
  const name = familyName(family ?? "");
  const fb = familyName(fallback);
  const head = familyFaces(name || BUNDLED_MONO_FAMILY);
  return [...head, ...(fb ? familyFaces(fb) : []), base].join(", ");
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

/** Bundled aliases also apply when selected for the interface. */
export function uiFontFamily(family: string): string {
  return [...familyFaces(family), "system-ui", "sans-serif"].join(", ");
}
