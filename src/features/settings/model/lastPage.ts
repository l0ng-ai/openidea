/**
 * The page Settings was last shown on (IDEA reopens Settings there). This is UI state, not a
 * setting: it stays out of the settings JSON and lives in localStorage, which the separate
 * Settings window shares with the workbench through the same origin.
 */
const KEY = "openidea.settings.lastPage.v1";

/** Page id characters of every built-in and plugin page (`editor.general`, `tools.sshConfigurations`). */
const PAGE_ID = /^[\w.-]{1,200}$/;

/** The page to reopen Settings on, or `null` when nothing usable was recorded. */
export function lastSettingsPage(): string | null {
  try {
    const value = localStorage.getItem(KEY);
    return value && PAGE_ID.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Records the page Settings shows; `null` forgets it. */
export function rememberSettingsPage(pageId: string | null): void {
  try {
    if (pageId) localStorage.setItem(KEY, pageId);
    else localStorage.removeItem(KEY);
  } catch {
    // Without storage the dialog opens on the first page; nothing else depends on this.
  }
}
