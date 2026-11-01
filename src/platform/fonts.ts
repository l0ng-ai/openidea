import { invoke, isTauri } from "@tauri-apps/api/core";
import { guessOs } from "./platformInfo";

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
  ["jetbrains mono variable", ['"JetBrains Mono Variable"']],
  ["inter variable", ['"Inter Variable"']],
  [BUNDLED_UI_FAMILY.toLowerCase(), ['"Inter Variable"', '"Inter"']],
]);
const MONO_STACK_FALLBACK = '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace';

/** Quote one CSS family safely (including quotes, backslashes and control characters). */
export const quoteFontFamily = (family: string) =>
  // oxlint-disable-next-line no-control-regex -- CSS string escaping must cover controls
  `"${family.trim().replace(/["\\\x00-\x1f\x7f]/g, (char) => `\\${char.codePointAt(0)!.toString(16)} `)}"`;

// Preserve compatibility with previously saved names wrapped in CSS quotes.
const familyName = (family: string) => family.trim().replace(/^"(.*)"$/, "$1");

// Per webview: the CSS alias stays stable while its faces load; DOM consumers
// reflow automatically and canvas consumers await the same promise below.
const userFonts = new Map<string, { alias: string; loaded: Promise<void> }>();

/** WKWebView needs a connected canvas to resolve user fonts. Remove it in finally after probing. */
export function createFontProbeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.hidden = true;
  (document.body ?? document.documentElement).append(canvas);
  return canvas;
}

/** A pure local-name probe; FontFaceSet.check also returns true for unknown families. */
export function fontAvailable(name: string): boolean {
  let canvas: HTMLCanvasElement | undefined;
  try {
    canvas = createFontProbeCanvas();
    const ctx = canvas.getContext("2d");
    if (!ctx) return true;
    // Symbol-only Nerd fonts and CJK faces may have no Latin glyphs.
    return ["mmmmmmmmmmlli1WQ@", "\uF418\uE725\u{F0001}", "汉字かな한글"].some((sample) =>
      ["monospace", "serif", "sans-serif"].some((base) => {
        ctx.font = `32px ${base}`;
        const baseline = ctx.measureText(sample).width;
        ctx.font = `32px ${quoteFontFamily(name)}, ${base}`;
        const width = ctx.measureText(sample).width;
        return Number.isFinite(width) && Number.isFinite(baseline) && width !== baseline;
      }),
    );
  } catch {
    return true;
  } finally {
    canvas?.remove();
  }
}

async function loadUserFont(name: string, alias: string): Promise<void> {
  const buffer = await invoke<ArrayBuffer>("user_font_data", { family: name });
  const headerLength = new DataView(buffer).getUint32(0, true);
  const start = 4 + headerLength;
  const faces: { weight: number; style: string; offset: number; length: number }[] = JSON.parse(
    new TextDecoder().decode(buffer.slice(4, start)),
  );
  await Promise.all(
    faces.map(async ({ weight, style, offset, length }) => {
      const face = new FontFace(alias, buffer.slice(start + offset, start + offset + length), {
        weight: String(weight),
        style,
      });
      document.fonts.add(face);
      try {
        await face.load();
      } catch {
        document.fonts.delete(face);
      }
    }),
  );
}

/** One resolver for primary, fallback and UI families, matching the bundled CSS registrations. */
export function familyFaces(family: string): readonly string[] {
  const name = familyName(family);
  const bundled = BUNDLED_FACES.get(name.toLowerCase());
  if (bundled) return bundled;
  if (!name || !isTauri() || guessOs() !== "macos" || typeof FontFace === "undefined") return [quoteFontFamily(name)];
  const key = name.toLowerCase();
  let entry = userFonts.get(key);
  if (!entry) {
    if (fontAvailable(name)) return [quoteFontFamily(name)];
    const alias = `OpenIDEA User Font ${userFonts.size}`;
    const loaded = loadUserFont(name, alias).catch(() => {
      /* retain local-name and bundled fallbacks */
    });
    entry = { alias, loaded };
    userFonts.set(key, entry);
  }
  return [quoteFontFamily(entry.alias), quoteFontFamily(name)];
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
  const pending = [...userFonts.values()].filter(({ alias }) => family.includes(quoteFontFamily(alias)));
  if (pending.length) await Promise.all(pending.map(({ loaded }) => loaded));
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
