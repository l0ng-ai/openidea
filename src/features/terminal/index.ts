/**
 * Integrated terminal: xterm.js sessions on backend PTYs in the bottom
 * "Terminal" tool window (tabs, split tab groups, links, IDEA-style shortcuts).
 */
import { registerActions } from "@/platform/actions";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onWorkflowSettingsChange } from "@/platform/workflowSettings";
import { provideEmbeddedTerminal, registerToolWindow, toolWindowService } from "@/workbench/contributions";
import { lazyComponent } from "@/ui";
import { installTerminalKeys } from "./keys";
import { loadTerminalRuntime, terminalRuntime } from "./loader";

const WINDOW = "terminal";

function projectRoot(): string | null {
  return useProject.getState().project?.root ?? null;
}

function focusActiveSoon() {
  // Wait for the tool window and pane to mount before focusing xterm.
  requestAnimationFrame(() => requestAnimationFrame(() => terminalRuntime()?.activeSession()?.focus()));
}

function shellName(path: string): string {
  return (
    path
      .split(/[\\/]/)
      .pop()!
      .replace(/\.exe$/i, "") || path
  );
}

async function openNewTab(dir?: string) {
  const root = projectRoot();
  const cwd = dir || root;
  if (!cwd) return;
  const rt = await loadTerminalRuntime();
  if (dir) rt.newTabAt(dir);
  else rt.newTab(rt.startDirectory(cwd));
  toolWindowService().show(WINDOW, true);
  focusActiveSoon();
}

/** Split Right / Split Down of tab `arg` (from its context menu), else of the active tab. */
async function split(arg: unknown, orientation: "horizontal" | "vertical", move = false) {
  const rt = await loadTerminalRuntime();
  const id = typeof arg === "string" && arg ? arg : rt.useTerminals.getState().activeTab;
  if (!id) return move ? undefined : openNewTab();
  rt.splitTab(id, orientation, move);
  toolWindowService().show(WINDOW, true);
  focusActiveSoon();
}

export function activate(): () => void {
  const disposers: Array<() => void> = [
    registerToolWindow({
      id: WINDOW,
      title: "Terminal",
      icon: "toolwindow-terminal",
      anchor: "bottom",
      order: 10,
      component: lazyComponent(() => loadTerminalRuntime().then((rt) => rt.TerminalView)),
      headerContent: lazyComponent(() => loadTerminalRuntime().then((rt) => rt.TerminalTabs)),
    }),
    registerActions([
      {
        id: "terminal.new",
        title: "New Terminal Tab",
        category: "Terminal",
        icon: "plus",
        when: "projectOpen",
        keywords: ["shell", "console"],
        // ⌘T is VCS Update elsewhere; in the terminal it opens a tab, as in IDEA.
        keyWhen: "terminalFocus",
        run: () => openNewTab(),
      },
      {
        id: "terminal.newPredefinedSession",
        title: "New Predefined Session",
        description: "Opens a terminal tab running the shell at `arg` (a path from `termAvailableShells`).",
        category: "Terminal",
        icon: "terminal",
        when: "projectOpen",
        hidden: true,
        run: async ({ arg }) => {
          const root = projectRoot();
          if (typeof arg !== "string" || !arg || !root) return;
          const rt = await loadTerminalRuntime();
          rt.newTab(rt.startDirectory(root), shellName(arg), { program: arg, args: [], shell: true });
          toolWindowService().show(WINDOW, true);
          focusActiveSoon();
        },
      },
      {
        id: "terminal.openAt",
        title: "Open in Terminal",
        category: "Terminal",
        icon: "terminal",
        when: "projectOpen",
        hidden: true,
        run: ({ arg }) => openNewTab(typeof arg === "string" && arg ? arg : undefined),
      },
      {
        id: "terminal.runCommand",
        title: "Run Command in Terminal",
        description: "Opens a terminal tab running `{ program, args, name?, cwd? }` instead of the shell.",
        category: "Terminal",
        icon: "terminal",
        when: "projectOpen",
        hidden: true,
        run: async ({ arg }) => {
          const a = arg as { program?: unknown; args?: unknown; name?: unknown; cwd?: unknown } | undefined;
          if (!a || typeof a.program !== "string" || !a.program) return;
          const args = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === "string") : [];
          const cwd = (typeof a.cwd === "string" && a.cwd) || projectRoot();
          if (!cwd) return;
          const rt = await loadTerminalRuntime();
          rt.newTab(cwd, typeof a.name === "string" && a.name ? a.name : undefined, { program: a.program, args });
          toolWindowService().show(WINDOW, true);
          focusActiveSoon();
        },
      },
      {
        id: "terminal.splitRight",
        title: "Split Right",
        category: "Terminal",
        icon: "split",
        when: "projectOpen",
        run: ({ arg }) => split(arg, "horizontal"),
      },
      {
        id: "terminal.splitDown",
        title: "Split Down",
        category: "Terminal",
        icon: "split-horizontal",
        when: "projectOpen",
        run: ({ arg }) => split(arg, "vertical"),
      },
      {
        id: "terminal.splitAndMoveRight",
        title: "Split and Move Right",
        category: "Terminal",
        when: "projectOpen",
        run: ({ arg }) => split(arg, "horizontal", true),
      },
      {
        id: "terminal.splitAndMoveDown",
        title: "Split and Move Down",
        category: "Terminal",
        when: "projectOpen",
        run: ({ arg }) => split(arg, "vertical", true),
      },
      {
        id: "terminal.unsplit",
        title: "Unsplit",
        category: "Terminal",
        when: "projectOpen",
        run: async ({ arg }) => {
          const rt = await loadTerminalRuntime();
          const { tabs, activeTab } = rt.useTerminals.getState();
          const group = typeof arg === "string" ? arg : tabs.find((t) => t.id === activeTab)?.group;
          if (!group) return;
          rt.unsplit(group);
          toolWindowService().show(WINDOW, true);
          focusActiveSoon();
        },
      },
      {
        id: "terminal.find",
        title: "Find in Terminal",
        category: "Terminal",
        icon: "search",
        when: "terminalFocus || activeToolWindow == 'terminal'",
        keywords: ["search", "scrollback"],
        run: () => {
          const rt = terminalRuntime();
          if (!rt?.activeSession()) return;
          toolWindowService().show(WINDOW);
          rt.openTerminalFind();
        },
      },
      {
        id: "terminal.clear",
        title: "Clear Terminal Buffer",
        category: "Terminal",
        when: "terminalFocus",
        run: () => terminalRuntime()?.activeSession()?.clear(),
      },
      {
        id: "terminal.closeSession",
        title: "Close Terminal Session",
        category: "Terminal",
        when: "terminalFocus",
        run: () => {
          const rt = terminalRuntime();
          const s = rt?.activeSession();
          if (!rt || !s) return;
          void rt.requestCloseSession(s.key).then((closed) => {
            if (!closed) return;
            if (rt.useTerminals.getState().tabs.length === 0) toolWindowService().hide(WINDOW);
            else focusActiveSoon();
          });
        },
      },
    ]),
    installTerminalKeys(),
    onWorkflowSettingsChange(
      (s) => s.terminal,
      () => terminalRuntime()?.applySettingsToAll(),
    ),
    // Font "same as editor" follows Editor › Font.
    useProject.subscribe((s, prev) => {
      if (s.settings?.editor !== prev.settings?.editor) terminalRuntime()?.applySettingsToAll();
    }),
    onIdeEvent("terminalExited", (e) => terminalRuntime()?.sessionForTerminalId(e.terminal)?.exited(e.code)),
    // Sessions belong to the project; closing / switching it ends them.
    useProject.subscribe((s, prev) => {
      const rt = terminalRuntime();
      if (rt && s.project?.root !== prev.project?.root) {
        if (rt.useTerminalFind.getState().open) rt.closeTerminalFind();
        rt.closeAll();
      }
    }),
  ];

  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const observer = new MutationObserver(() => {
      terminalRuntime()?.applyThemeToAll();
      terminalRuntime()?.applyThemeToEmbedded();
    });
    // A palette or plugin theme switch keeps data-theme when both themes share a light / dark base.
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-contrast", "data-color-theme", "data-plugin-theme", "style"],
    });
    disposers.push(() => observer.disconnect());
  }

  provideEmbeddedTerminal(async (host, options) => (await loadTerminalRuntime()).createEmbeddedTerminal(host, options));
  disposers.push(() => provideEmbeddedTerminal(undefined));

  return () => {
    disposers.reverse().forEach((d) => d());
    terminalRuntime()?.closeAll();
  };
}
