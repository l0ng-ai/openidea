/**
 * The What's New page: an editor tab with the release notes of one version.
 * Help opens it at any time; checkAfterUpdate opens it once on the first start
 * after an update (called from features/app once the window is up).
 */
import { call, commands, isTauri } from "@/platform/ipc";
import { loadSettings, startupLaunchHandled, useProject } from "@/platform/project";
import { releaseNotesOf } from "@/platform/releaseNotes";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";

export const WHATS_NEW_KIND = "whatsNew";

export interface WhatsNewData {
  version: string;
  /** Notes the install recorded; null when the page has to read the manifest. */
  notes: string | null;
}

export function whatsNewInput(version: string): EditorInput {
  return {
    kind: WHATS_NEW_KIND,
    key: WHATS_NEW_KIND + ":" + version,
    data: { version, notes: releaseNotesOf(version) } satisfies WhatsNewData,
  };
}

/** Opens the tab of this version; the same version opened again focuses it. */
export function openWhatsNew(version: string): void {
  void maybeEditorService()?.openInput(whatsNewInput(version), { focus: true });
}

/** Help > What's New: the version the app runs. */
export async function openCurrentWhatsNew(): Promise<void> {
  const info = await commands.appBuildInfo().catch(() => null);
  if (!info) return;
  openWhatsNew(info.version);
}

/** general.showWhatsNewAfterUpdate, on unless it was switched off in Settings. */
export function showAfterUpdate(): boolean {
  return useProject.getState().settings?.general?.showWhatsNewAfterUpdate !== false;
}

/** The page's checkbox: Settings > Updates shows the same switch. */
export async function setShowAfterUpdate(show: boolean): Promise<void> {
  const settings = await call(commands.settingsSet("global", "general.showWhatsNewAfterUpdate", JSON.stringify(show)));
  useProject.setState({ settings });
}

/** The splash covers the window, and the remembered project restores right after it. */
async function windowReady(): Promise<void> {
  if (typeof document !== "undefined" && document.getElementById("splash")) {
    await new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener("openidea:boot-ready", done);
        resolve();
      };
      window.addEventListener("openidea:boot-ready", done);
      // The splash gives up after 4 s; a failed boot must not swallow the page.
      setTimeout(done, 5000);
    });
  }
  await startupLaunchHandled();
  // A remembered project reopens after the splash and replaces the saved tab session,
  // so give it the start: opening while it restores would close the page again.
  await new Promise((resolve) => setTimeout(resolve, 300));
}

async function rememberRunVersion(version: string): Promise<void> {
  const settings = await call(commands.settingsSet("global", "general.lastRunVersion", JSON.stringify(version)));
  useProject.setState({ settings });
}

/** First start of a different version opens the page; one start opens it once. */
export async function checkAfterUpdate(): Promise<void> {
  if (!isTauri()) return;
  const info = await commands.appBuildInfo().catch(() => null);
  // A build without an update endpoint never installed a version: nothing to show.
  if (!info?.updates) return;
  // The Welcome screen has no settings loaded yet.
  if (!useProject.getState().settings) await loadSettings().catch(() => {});
  const previous = useProject.getState().settings?.general?.lastRunVersion ?? "";
  if (previous === info.version) return;
  // Record the start before opening: an update installed outside the app is
  // recognised the same way as one installed by the updater.
  await rememberRunVersion(info.version);
  // The first run has nothing to compare against.
  if (!previous || !showAfterUpdate()) return;
  await windowReady();
  openWhatsNew(info.version);
}
