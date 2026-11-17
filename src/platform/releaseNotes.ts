/**
 * The release notes the updater installed, kept so the What's New page can show
 * them after the restart that installs an update. localStorage, because an
 * update replaces the app bundle but not the webview's data. Notes are kept in
 * the languages the update manifest carried: `text` is English, the fallback
 * for the locales `texts` has no entry for.
 */

import { DEFAULT_LOCALE } from "./i18n";

const KEY = "openidea.whatsNew.notes.v1";

interface Stored {
  version: string;
  text: string;
  /** The notes' translations, keyed like the UI's locales (`zh`, not `zh-CN`). */
  texts?: Record<string, string>;
}

function read(): Stored | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const stored = value as Partial<Stored>;
    if (typeof stored.version !== "string" || typeof stored.text !== "string") return null;
    const texts = stored.texts;
    return {
      version: stored.version,
      text: stored.text,
      texts:
        texts && typeof texts === "object"
          ? Object.fromEntries(Object.entries(texts).filter(([, t]) => typeof t === "string"))
          : {},
    };
  } catch {
    return null;
  }
}

/** Called once an update installed, with the notes its manifest carried. */
export function recordInstalledUpdate(
  version: string,
  notes: string | null,
  translations: Record<string, string> | null = null,
): void {
  const text = notes?.trim();
  const texts = Object.fromEntries(
    Object.entries(translations ?? {}).filter(([lang, t]) => lang && lang !== DEFAULT_LOCALE && t.trim()),
  );
  try {
    if (text) globalThis.localStorage?.setItem(KEY, JSON.stringify({ version, text, texts }));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* storage unavailable: the page reads the manifest instead */
  }
}

/** Notes recorded when this version was installed, for the page to pick the UI's language from. */
export function recordedNotes(version: string): { text: string; texts: Record<string, string> } | null {
  const stored = read();
  return stored?.version === version ? { text: stored.text, texts: stored.texts ?? {} } : null;
}

/** Notes for `locale`: the recorded translation when there is one, English otherwise. */
export function releaseNotesOf(version: string, locale: string = DEFAULT_LOCALE): string | null {
  const stored = recordedNotes(version);
  return stored ? (stored.texts[locale] ?? stored.text) : null;
}

/** Tests only. */
export function _resetReleaseNotesForTests(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
