/**
 * The font families installed on this machine (`system_font_families`: CoreText,
 * DirectWrite or fontconfig), for every font picker. Read once per window; the
 * backend caches the list for the run.
 */
import { useEffect, useState } from "react";
import { call, commands, type FontFamily } from "./ipc";

let cached: FontFamily[] | null = null;
let pending: Promise<FontFamily[]> | null = null;

/** The installed families; empty when the font system can't be read. */
export function loadSystemFonts(): Promise<FontFamily[]> {
  pending ??= call(commands.systemFontFamilies())
    .catch(() => [] as FontFamily[])
    .then((list) => (cached = list));
  return pending;
}

/** The installed families, empty until the first read resolves. */
export function useSystemFonts(): FontFamily[] {
  const [fonts, setFonts] = useState<FontFamily[]>(() => cached ?? []);
  useEffect(() => {
    if (cached) return;
    let live = true;
    void loadSystemFonts().then((list) => live && setFonts(list));
    return () => {
      live = false;
    };
  }, []);
  return fonts;
}

/**
 * Picker entries: the installed families (only monospaced ones when asked),
 * plus `include` (the bundled faces, and the current value so a family that
 * isn't installed here still shows as selected), deduplicated and sorted.
 */
export function fontNames(
  fonts: readonly FontFamily[],
  { monospacedOnly = false, include = [] }: { monospacedOnly?: boolean; include?: readonly string[] } = {},
): string[] {
  const seen = new Map<string, string>();
  const add = (name: string) => {
    const n = name.trim();
    if (n && !seen.has(n.toLowerCase())) seen.set(n.toLowerCase(), n);
  };
  include.forEach(add);
  for (const f of fonts) if (!monospacedOnly || f.monospaced) add(f.name);
  return [...seen.values()].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** Test hook: forget the cached list. */
export function resetSystemFontsForTests(): void {
  cached = null;
  pending = null;
}
