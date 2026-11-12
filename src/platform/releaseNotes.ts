/**
 * The release notes the updater installed, kept so the What's New page can show
 * them after the restart that installs an update. localStorage, because an
 * update replaces the app bundle but not the webview's data.
 */

const KEY = "openidea.whatsNew.notes.v1";

interface Stored {
  version: string;
  text: string;
}

function read(): Stored | null {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const stored = value as Partial<Stored>;
    return typeof stored.version === "string" && typeof stored.text === "string"
      ? { version: stored.version, text: stored.text }
      : null;
  } catch {
    return null;
  }
}

/** Called once an update installed, with the notes its manifest carried. */
export function recordInstalledUpdate(version: string, notes: string | null): void {
  const text = notes?.trim();
  try {
    if (text) globalThis.localStorage?.setItem(KEY, JSON.stringify({ version, text }));
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* storage unavailable: the page reads the manifest instead */
  }
}

/** Notes recorded when this version was installed, so the page shows them offline. */
export function releaseNotesOf(version: string): string | null {
  const stored = read();
  return stored?.version === version ? stored.text : null;
}

/** Tests only. */
export function _resetReleaseNotesForTests(): void {
  try {
    globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* storage unavailable */
  }
}
