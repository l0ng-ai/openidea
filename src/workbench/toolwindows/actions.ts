import { registerAction, registerActions, type Action } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { formatMessage, tx } from "@/platform/i18n";
import { occurrenceNavigator, showStatusInfo, useContributions } from "../contributions";
import { isDistractionFree, setDistractionFree } from "../distractionFree";
import { focusEditor } from "../focus";
import { chooseItem, promptInput } from "../inputDialogs";
import { confirm } from "../messages";
import {
  deleteLayout,
  layoutNames,
  renameLayout,
  restoreDefaultLayout,
  restoreLayout,
  saveLayout,
  useToolWindowLayouts,
} from "./layouts";
import { closeSelectedContent } from "./content";
import {
  activateToolWindow,
  hideActiveToolWindow,
  hideAllToolWindows,
  hideToolWindow,
  jumpToLastToolWindow,
  lastUsedToolWindow,
  resizeActiveToolWindow,
  useToolWindowLayout,
  toggleMaximizeToolWindow,
} from "./store";

/**
 * Next / Previous Occurrence: steps through the results of the focused tool
 * window, else of the last active one, else of a shown one, so it also works
 * from the editor. The editor gets the focus only when the action ran outside
 * the tool window.
 */
export function goToOccurrence(dir: 1 | -1): boolean {
  const s = useToolWindowLayout.getState();
  for (const id of new Set([s.focused, s.lastActive, lastUsedToolWindow(), ...Object.values(s.visible)])) {
    const nav = id ? occurrenceNavigator(id) : null;
    if (!nav) continue;
    const step = nav.go(dir, s.focused !== id);
    if (step) showStatusInfo(formatMessage(tx("{index} of {total}"), { index: step.index, total: step.total }));
    return !!step;
  }
  return false;
}

/** Window › Tool Window Layouts. */
function layoutActions(): Action[] {
  const exitDistractionFree = () => {
    if (isDistractionFree()) setDistractionFree(false);
  };
  const pick = (title: string) =>
    chooseItem({ title, items: layoutNames(), empty: "No saved layouts. Use Save Current Layout as… first." });
  const free = (current?: string) => (v: string) =>
    !v.trim()
      ? "Enter a layout name"
      : v.trim() !== current && layoutNames().includes(v.trim())
        ? "A layout with this name exists"
        : null;
  return [
    {
      id: "layout.save",
      title: "Save Current Layout as…",
      category: "Window",
      keywords: ["tool window layout", "store layout"],
      when: "projectOpen",
      run: async () => {
        const active = useToolWindowLayouts.getState().active;
        const name = await promptInput({
          title: "Save Current Layout as",
          label: "Layout name:",
          initial: active ?? "",
          okLabel: "Save",
          validate: (v) => (v.trim() ? null : "Enter a layout name"),
        });
        if (name) saveLayout(name);
      },
    },
    {
      id: "layout.restore",
      title: "Restore Tool Window Layout",
      description: "Restores the saved layout named `arg`, or asks which one.",
      category: "Window",
      keywords: ["tool window layout"],
      when: "projectOpen",
      run: async ({ arg }) => {
        exitDistractionFree();
        const name = typeof arg === "string" ? arg : await pick("Restore Layout");
        if (name) restoreLayout(name);
      },
    },
    {
      id: "layout.restoreDefault",
      title: "Restore Default Layout",
      category: "Window",
      keywords: ["tool window layout", "reset"],
      when: "projectOpen",
      run: () => {
        exitDistractionFree();
        restoreDefaultLayout();
      },
    },
    {
      id: "layout.rename",
      title: "Rename Tool Window Layout…",
      category: "Window",
      when: "toolWindowLayoutsSaved",
      run: async () => {
        const from = await pick("Rename Layout");
        if (!from) return;
        const to = await promptInput({
          title: "Rename Layout",
          label: "New name:",
          initial: from,
          okLabel: "Rename",
          validate: free(from),
        });
        if (to) renameLayout(from, to);
      },
    },
    {
      id: "layout.delete",
      title: "Delete Tool Window Layout…",
      category: "Window",
      when: "toolWindowLayoutsSaved",
      run: async () => {
        const name = await pick("Delete Layout");
        if (
          name &&
          (await confirm({
            title: "Delete Layout",
            message: tx`Delete the layout '${name}'?`,
            ok: "Delete",
            icon: "warning",
          }))
        )
          deleteLayout(name);
      },
    },
  ];
}

/** Registers `toolwindow.<id>` for every tool window plus the generic tool window actions. */
export function installToolWindowActions(): () => void {
  const perWindow = new Map<string, { title: string; icon: string; dispose: () => void }>();

  const sync = () => {
    const windows = useContributions.getState().toolWindows;
    for (const [id, entry] of perWindow) {
      const tw = windows.get(id);
      if (!tw || tw.title !== entry.title || tw.icon !== entry.icon) {
        entry.dispose();
        perWindow.delete(id);
      }
    }
    for (const [id, tw] of windows) {
      if (perWindow.has(id)) continue;
      const dispose = registerAction({
        id: `toolwindow.${id}`,
        title: tw.title,
        category: "Tool Windows",
        icon: tw.icon,
        keywords: ["tool window", "show", "hide"],
        run: () => activateToolWindow(id),
      });
      perWindow.set(id, { title: tw.title, icon: tw.icon, dispose });
    }
  };
  sync();
  const unsubscribe = useContributions.subscribe((s, prev) => {
    if (s.toolWindows !== prev.toolWindows) sync();
  });
  const publishLayouts = () => setContext("toolWindowLayoutsSaved", useToolWindowLayouts.getState().layouts.length > 0);
  publishLayouts();
  const unsubscribeLayouts = useToolWindowLayouts.subscribe(publishLayouts);

  const disposeStatic = registerActions([
    { id: "toolwindow.hideAll", title: "Hide All Tool Windows", category: "Window", run: hideAllToolWindows },
    {
      id: "toolwindow.jumpToLast",
      title: "Jump to Last Tool Window",
      category: "Window",
      keywords: ["tool window", "focus"],
      when: "projectOpen",
      run: jumpToLastToolWindow,
    },
    {
      // IDEA: also from the editor, hiding the last active window if it is still shown.
      id: "toolwindow.hideActive",
      title: "Hide Active Tool Window",
      category: "Window",
      when: "projectOpen && !popupOpen",
      run: hideActiveToolWindow,
    },
    {
      // Close Content, as IDEA (⌘W / Ctrl+F4 in a tool window): the selected closable tab, else the window.
      id: "toolwindow.closeContent",
      title: "Close Tool Window Tab",
      category: "Window",
      when: "toolWindowFocus && !popupOpen",
      run: () => {
        const s = useToolWindowLayout.getState();
        const id = s.focused ?? s.lastActive;
        if (id && !closeSelectedContent(id)) hideToolWindow(id);
      },
    },
    {
      id: "toolwindow.focusEditor",
      title: "Focus Editor",
      category: "Window",
      when: "toolWindowFocus && !popupOpen",
      run: () => focusEditor(),
    },
    {
      id: "navigate.nextOccurrence",
      title: "Next Occurrence",
      category: "Navigate",
      icon: "arrow-down",
      keywords: ["usage", "result", "find"],
      when: "projectOpen",
      run: () => void goToOccurrence(1),
    },
    {
      id: "navigate.prevOccurrence",
      title: "Previous Occurrence",
      category: "Navigate",
      icon: "arrow-up",
      keywords: ["usage", "result", "find"],
      when: "projectOpen",
      run: () => void goToOccurrence(-1),
    },
    ...layoutActions(),
    {
      id: "toolwindow.maximize",
      title: "Maximize Tool Window",
      category: "Window",
      when: "toolWindowFocus",
      run: () => {
        const s = useToolWindowLayout.getState();
        const id = s.focused ?? s.lastActive;
        if (id) toggleMaximizeToolWindow(id);
      },
    },
    ...(["left", "right", "up", "down"] as const).map((dir): Action => ({
      id: `toolwindow.resize${dir[0]!.toUpperCase()}${dir.slice(1)}`,
      title: { left: "Stretch to Left", right: "Stretch to Right", up: "Stretch to Top", down: "Stretch to Bottom" }[
        dir
      ],
      category: "Window",
      keywords: ["resize tool window", "tool window size"],
      when: "toolWindowFocus",
      run: () => resizeActiveToolWindow(dir),
    })),
  ]);

  return () => {
    unsubscribe();
    unsubscribeLayouts();
    disposeStatic();
    perWindow.forEach((e) => e.dispose());
    perWindow.clear();
  };
}
