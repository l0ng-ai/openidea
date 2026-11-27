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
import { registerStatusItem, showStatusInfo } from "@/workbench/contributions";
import { vimKeyClaim } from "./conflicts";
import { loadRcFile } from "./rcFile";
import { setVimEnabled, syncVimSettingsFromStorage, useVimSettings } from "./settings";
import { activateSettingsPages, VIM_SETTINGS_PAGE } from "./settingsPages";
import { VimStatus } from "./VimStatus";

type Engine = typeof import("./engine");

export function activate(): () => void {
  let engine: Promise<Engine> | null = null;
  let contribution: (() => void) | null = null;
  let rcApplied = false;
  let generation = 0;

  const loadEngine = () => (engine ??= import("./engine"));

  const reloadRc = async (quiet: boolean) => {
    const [e, rc] = await Promise.all([useVimSettings.getState().enabled ? loadEngine() : engine, loadRcFile()]);
    if (e) {
      const problems = e.applyRcCommands(rc.commands);
      rcApplied = true;
      for (const p of problems) console.warn(`vimrc: ${p}`);
    }
    if (!quiet)
      showStatusInfo(rc.commands.length ? "Vim: rc file reloaded" : "Vim: no ~/.openideavimrc or ~/.ideavimrc");
  };

  const apply = async (enabled: boolean) => {
    const gen = ++generation;
    setContext("vimMode", enabled);
    if (!enabled) {
      setContext("vim.mode", "");
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
      extensions: (ctx) => e.vimExtension(ctx),
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
        enabled: ({ ctx, arg }) => ctx.vimMode === true || arg === "settings",
        run: ({ arg }) => reloadRc(arg === "settings"),
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
    setContext("vim.mode", "");
    disposers.reverse().forEach((d) => d());
  };
}
