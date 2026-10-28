/**
 * Vim mode, modelled on IntelliJ's IdeaVim: a persisted on/off toggle (Tools ›
 * Vim, the status bar widget, Settings › Editor › Vim) applied live to every
 * editor, shortcut conflicts the keymap dispatcher respects, and the
 * `~/.ideavimrc` subset. The Vim engine loads only once Vim mode is on.
 */
import { executeAction, registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { registerKeyClaim } from "@/platform/keymap";
import { registerEditorContribution } from "@/editor/api";
import { registerSettingsPage, registerStatusItem, showStatusInfo } from "@/workbench/contributions";
import { lazyComponent } from "@/ui";
import { vimKeyClaim } from "./conflicts";
import { loadRcFile } from "./rcFile";
import { setVimEnabled, syncVimSettingsFromStorage, useVimSettings } from "./settings";
import { VimStatus } from "./VimStatus";

export const VIM_SETTINGS_PAGE = "editor.vim";

/** Settings › Editor › Vim (also used by the Settings window). */
export function activateSettingsPages(): () => void {
  return registerSettingsPage({
    id: VIM_SETTINGS_PAGE,
    title: "Vim",
    group: "Editor",
    order: 45,
    keywords: ["vim", "ideavim", "ideavimrc", "emulation", "shortcut conflicts", "handler"],
    component: lazyComponent(() => import("./VimSettingsPage").then((m) => m.VimSettingsPage)),
  });
}

type Engine = typeof import("./engine");

export function activate(): () => void {
  let engine: Promise<Engine> | null = null;
  let contribution: (() => void) | null = null;
  let rcApplied = false;
  let generation = 0;

  const loadEngine = () => (engine ??= import("./engine"));

  const reloadRc = async (quiet: boolean) => {
    const [e, rc] = await Promise.all([loadEngine(), loadRcFile()]);
    const problems = e.applyRcCommands(rc.commands);
    rcApplied = true;
    for (const p of problems) console.warn(`vimrc: ${p}`);
    if (!quiet)
      showStatusInfo(rc.commands.length ? "Vim: rc file reloaded" : "Vim: no ~/.openideavimrc or ~/.ideavimrc");
  };

  const apply = async (enabled: boolean) => {
    const gen = ++generation;
    setContext("vimMode", enabled);
    if (!enabled) {
      contribution?.();
      contribution = null;
      return;
    }
    const e = await loadEngine();
    if (!rcApplied) await reloadRc(true).catch((err) => console.error("vimrc failed", err));
    if (gen !== generation || contribution) return;
    contribution = registerEditorContribution({
      id: "vim",
      order: 0,
      embedded: true,
      extensions: () => e.vimExtension(),
    });
  };

  void apply(useVimSettings.getState().enabled);
  const unsubscribe = useVimSettings.subscribe((s, prev) => {
    if (s.enabled !== prev.enabled) void apply(s.enabled);
  });

  const disposers = [
    unsubscribe,
    syncVimSettingsFromStorage(),
    registerKeyClaim(vimKeyClaim(() => useVimSettings.getState())),
    activateSettingsPages(),
    registerStatusItem({
      id: "vim.mode",
      align: "right",
      priority: 45,
      component: VimStatus,
      title: "Vim",
      lightEdit: true,
    }),
    registerActions([
      {
        id: "vim.toggle",
        title: "Vim",
        description: "Turn Vim emulation on or off in all editors",
        category: "Tools",
        keywords: ["vim", "ideavim", "emulator", "toggle vim mode"],
        toggled: () => useVimSettings.getState().enabled,
        run: () => setVimEnabled(!useVimSettings.getState().enabled),
      },
      {
        id: "vim.reloadRc",
        title: "Reload .ideavimrc",
        category: "Tools",
        keywords: ["vim", "vimrc", "openideavimrc"],
        when: "vimMode",
        run: () => reloadRc(false),
      },
      {
        id: "vim.settings",
        title: "Vim Settings…",
        category: "Tools",
        keywords: ["vim", "shortcut conflicts"],
        run: () => void executeAction("file.settings", VIM_SETTINGS_PAGE),
      },
    ]),
  ];
  return () => {
    generation++;
    contribution?.();
    contribution = null;
    setContext("vimMode", false);
    disposers.reverse().forEach((d) => d());
  };
}
