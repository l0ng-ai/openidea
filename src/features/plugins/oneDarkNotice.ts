/**
 * The one-time notice for installs whose settings file still names the removed
 * `one-dark` built-in (#2981): One Dark now ships as the One Dark Pro marketplace
 * plugin, and the notice offers to install it. Shown once (a `localStorage` flag,
 * like the nightly update prompt); the backend only reports the raw id, the notice
 * decides what it means.
 */
import { tx } from "@/platform/i18n";
import { commands, ideEventsReady, isTauri } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { installFromMarket, usePlugins } from "./store";

/** The marketplace plugin that maintains One Dark and its variants. */
export const ONE_DARK_PRO = "ffgenius.one-dark-pro-theme";

const SEEN_KEY = "openidea.plugins.oneDarkNoticeSeen";

export function startOneDarkNotice(): () => void {
  if (!isTauri()) return () => {};
  let disposed = false;
  void ideEventsReady().then(async () => {
    if (disposed || localStorage.getItem(SEEN_KEY)) return;
    let removed: string | null = null;
    try {
      removed = await commands.settingsRemovedTheme();
    } catch {
      return;
    }
    if (disposed || removed !== "one-dark") return;
    // The plugin list loads in the background; wait for it so Install is only
    // offered when the plugin is actually missing.
    if (!usePlugins.getState().loaded)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          unsubscribe();
          resolve();
        };
        const timer = setTimeout(done, 5000);
        const unsubscribe = usePlugins.subscribe((s) => s.loaded && done());
      });
    if (disposed) return;
    localStorage.setItem(SEEN_KEY, "1");
    const installed = usePlugins.getState().plugins.some((p) => p.id === ONE_DARK_PRO);
    notifications().notify({
      group: "plugins",
      level: "info",
      sticky: true,
      key: "plugins.oneDark",
      title: tx("One Dark is now provided by the One Dark Pro plugin"),
      body: tx("The built-in One Dark theme was removed; the plugin provides it and its variants."),
      actions: installed ? [] : [{ label: tx("Install"), run: () => void installFromMarket(ONE_DARK_PRO) }],
    });
  });
  return () => {
    disposed = true;
  };
}
