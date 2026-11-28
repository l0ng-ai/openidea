/**
 * Integrated terminal: xterm.js sessions on backend PTYs in the bottom
 * "Terminal" tool window (tabs, split tab groups, links, IDEA-style shortcuts),
 * plus the CLI editor tabs (#2202): full-size agent CLIs as editor-area tabs.
 */
import { createElement } from "react";
import { registerActions } from "@/platform/actions";
import { commands, isTauri, onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { isRemoteWindow, parseRemoteLocation, projectLocation } from "@/platform/remote";
import { useSystemFontStore } from "@/platform/systemFonts";
import { onWorkflowSettingsChange } from "@/platform/workflowSettings";
import {
  EDITOR_TAB_MIME,
  maybeEditorService,
  provideEmbeddedTerminal,
  registerAgentContextSource,
  registerEditorDropHandler,
  registerEditorKind,
  registerMenuGroup,
  registerToolWindow,
  toolWindowService,
} from "@/workbench/contributions";
import { lazyComponent } from "@/ui";
import {
  CLI_KIND,
  CliDoneMark,
  TERMINAL_TAB_MIME,
  cliData,
  cliEditorPayload,
  moveEditorToTerminal,
  moveTerminalToEditor,
  openNewTerminalInEditor,
  splitCliTab,
  useClis,
} from "./cli";
import { installTerminalKeys } from "./keys";
import { loadTerminalRuntime, terminalRuntime } from "./loader";
import { SAMPLE_TUI_END, SAMPLE_TUI_START, sampleTuiFrame } from "./sampleTui";
import { notifyTerminalVisibility } from "./outputGate";
import type { SessionOptions } from "./session";

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

/**
 * The performance harness (`perf/`): a full-screen TUI repainting the active terminal
 * `frames` times at `fps`, opening a tab first when there is none.
 */
async function streamSampleTui(frames: number, fps: number) {
  const rt = await loadTerminalRuntime();
  if (!rt.activeSession()) rt.newTab(rt.startDirectory(projectRoot() ?? "/"));
  toolWindowService().show(WINDOW, true);
  const deadline = performance.now() + 5_000;
  let term = rt.activeSession()?.term;
  while (!term?.element && performance.now() < deadline) {
    // oxlint-disable-next-line no-await-in-loop -- polls one animation frame at a time until the terminal element exists
    await new Promise((r) => requestAnimationFrame(r));
    term = rt.activeSession()?.term;
  }
  if (!term?.element) throw new Error("terminal did not open");
  const write = (data: string) => new Promise<void>((resolve) => term.write(data, resolve));
  await write(SAMPLE_TUI_START);
  for (let n = 0; n < frames; n++) {
    const next = performance.now() + 1000 / fps;
    // oxlint-disable-next-line no-await-in-loop -- frames are written in order to the same terminal
    await write(sampleTuiFrame(n, term.cols, term.rows));
    // oxlint-disable-next-line no-await-in-loop -- each frame is paced to its deadline before the next write
    await new Promise((r) => setTimeout(r, Math.max(0, next - performance.now())));
  }
  await write(SAMPLE_TUI_END);
}

export function activate(): () => void {
  const disposers: Array<() => void> = [
    import.meta.env.DEV || import.meta.env.MODE === "perf"
      ? registerActions([
          {
            id: "terminal.sampleTui",
            title: "Stream Sample TUI",
            category: "Terminal",
            hidden: true,
            run: async ({ arg }) => {
              const { frames = 40, fps = 10 } = (arg ?? {}) as { frames?: number; fps?: number };
              await streamSampleTui(frames, fps);
            },
          },
        ])
      : () => {},
    registerAgentContextSource({
      id: "terminal",
      title: "Terminal",
      description: "The active terminal's recent output",
      icon: "terminal",
      resolve: async () => {
        const output = terminalRuntime()?.activeSession()?.recentOutput();
        return output?.text ? { kind: "block", info: `terminal ${output.title}`.trim(), text: output.text } : null;
      },
    }),
    registerToolWindow({
      id: WINDOW,
      title: "Terminal",
      icon: "toolwindow-terminal",
      anchor: "bottom",
      order: 10,
      component: lazyComponent(() => loadTerminalRuntime().then((rt) => rt.TerminalView), { prefetch: true }),
      headerContent: lazyComponent(() => loadTerminalRuntime().then((rt) => rt.TerminalTabs)),
      plainTitle: true,
      headerMenu: [
        { kind: "action", action: "terminal.splitRight" },
        { kind: "action", action: "terminal.splitDown" },
        { kind: "separator" },
        { kind: "action", action: "file.settings", arg: "tools.terminal", label: "Settings", icon: "settings" },
      ],
      onStripeDrop: {
        accepts: (type, data) => type === EDITOR_TAB_MIME && cliEditorPayload(data.payload) !== null,
        drop: (data) => {
          const input = cliEditorPayload(data.payload);
          if (input) void moveEditorToTerminal(input);
        },
      },
    }),
    // Terminal sessions moved to the editor (#2202): saved with the editor session, kept alive while hidden.
    registerEditorKind({
      kind: CLI_KIND,
      component: lazyComponent(() => loadTerminalRuntime().then((rt) => rt.CliEditor)),
      title: (input) => cliData(input)?.name ?? "Terminal",
      icon: () => "terminal",
      // A finished command not seen yet (#3712).
      trailing: (input) => createElement(CliDoneMark, { inputKey: input.key }),
      // A reopened tab shows Start: nothing runs on its own.
      restorable: true,
      keepAlive: true,
      singleton: true,
      splitInput: splitCliTab,
      canNavigate: (input, open) => open || !!useClis.getState().sessions[input.key],
      onClose: (input) => terminalRuntime()?.disposeCli(input.key),
      isBusy: (input) => terminalRuntime()?.cliBusy(input.key) ?? false,
    }),
    registerEditorDropHandler({
      accepts: (type) => type === TERMINAL_TAB_MIME,
      allowSplit: true,
      drop: ({ payload }, target) => void moveTerminalToEditor(payload, target),
    }),
    registerMenuGroup({
      id: "terminal.editorTab",
      menus: ["editorTab"],
      order: 10,
      items: (_, { input }) =>
        input?.kind === CLI_KIND ? [{ kind: "action", action: "terminal.moveToToolWindow", arg: input.key }] : [],
    }),
    registerActions([
      {
        id: "terminal.moveToEditor",
        title: "Move to Editor",
        description: "Moves a terminal tab, with its running session, into the editor area (arg: tab id).",
        category: "Terminal",
        when: "projectOpen",
        keywords: ["terminal", "editor", "cli", "claude", "codex"],
        run: ({ arg }) => moveTerminalToEditor(typeof arg === "string" ? arg : undefined),
      },
      {
        id: "terminal.moveToToolWindow",
        title: "Move to Terminal",
        description:
          "Moves a terminal editor tab, with its running session, back to the Terminal tool window (arg: input key).",
        category: "Terminal",
        icon: "terminal",
        when: "projectOpen",
        enabled: ({ arg }) => typeof arg === "string" || maybeEditorService()?.activeInput?.()?.kind === CLI_KIND,
        keywords: ["terminal", "editor", "dock", "tool window"],
        run: ({ arg }) => moveEditorToTerminal(typeof arg === "string" ? arg : undefined),
      },
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
        id: "terminal.newInEditor",
        title: "New Terminal Tab in Editor",
        description: "Opens a new terminal session as a tab in the editor area.",
        category: "Terminal",
        icon: "plus",
        when: "projectOpen",
        keywords: ["shell", "console", "editor", "cli"],
        // Shortcuts run anywhere outside the Terminal tool window (and popups), so a key like ⌘T can be shared with New Terminal Tab.
        keyWhen: "!terminalFocus && activeToolWindow != 'terminal' && !popupOpen",
        run: ({ arg }) => openNewTerminalInEditor(typeof arg === "string" && arg ? arg : undefined),
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
        id: "terminal.pluginSession",
        title: "Open Plugin Terminal Session",
        category: "Terminal",
        hidden: true,
        when: "projectOpen",
        run: async ({ arg }) => {
          const rt = await loadTerminalRuntime();
          await rt.pluginSession(arg as Parameters<typeof rt.pluginSession>[0]);
          toolWindowService().show(WINDOW, true);
          focusActiveSoon();
        },
      },
      {
        id: "terminal.runLines",
        title: "Run Lines in Terminal",
        description: "Opens a shell tab and types `{ lines, name?, cwd? }` into it.",
        category: "Terminal",
        icon: "terminal",
        when: "projectOpen",
        hidden: true,
        run: async ({ arg }) => {
          const a = arg as { lines?: unknown; name?: unknown; cwd?: unknown } | undefined;
          const lines = Array.isArray(a?.lines) ? a.lines.filter((x): x is string => typeof x === "string") : [];
          const cwd = (typeof a?.cwd === "string" && a.cwd) || projectRoot();
          if (!lines.length || !cwd) return;
          const rt = await loadTerminalRuntime();
          rt.newTabRunning(cwd, typeof a?.name === "string" && a.name ? a.name : undefined, lines);
          toolWindowService().show(WINDOW, true);
          focusActiveSoon();
        },
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
          const a = arg as
            | { program?: unknown; args?: unknown; name?: unknown; cwd?: unknown; spawn?: unknown }
            | undefined;
          const spawn =
            typeof a?.spawn === "function" ? (a.spawn as NonNullable<SessionOptions["command"]>["spawn"]) : undefined;
          if (!a || ((typeof a.program !== "string" || !a.program) && !spawn)) return;
          const args = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === "string") : [];
          const cwd = (typeof a.cwd === "string" && a.cwd) || projectRoot();
          if (!cwd) return;
          const rt = await loadTerminalRuntime();
          const program = typeof a.program === "string" ? a.program : "";
          rt.newTab(cwd, typeof a.name === "string" && a.name ? a.name : undefined, { program, args, spawn });
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
        id: "terminal.runHighlightedCommand",
        title: "Run Highlighted Command Using IDE",
        category: "Terminal",
        icon: "run",
        when: "terminalFocus",
        keywords: ["smart command", "run anything", "pytest", "npm run"],
        // Settings › Tools › Terminal › Run commands using IDE; anything else is a plain Enter.
        run: async () => {
          const rt = terminalRuntime();
          const focused = document.activeElement;
          const s = rt && (rt.sessionFromElement(focused) ?? rt.cliSessionFromElement(focused) ?? rt.activeSession());
          if (s && !(await s.runTypedCommand())) s.send("\r");
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
      () => {
        terminalRuntime()?.applySettingsToAll();
        terminalRuntime()?.applySettingsToClis();
      },
    ),
    // Font "same as editor" follows Editor › Font.
    useProject.subscribe((s, prev) => {
      if (s.settings?.editor !== prev.settings?.editor) {
        terminalRuntime()?.applySettingsToAll();
        terminalRuntime()?.applySettingsToClis();
      }
    }),
    // Prompt-theme icons (oh-my-posh, starship) come from the user's installed Nerd Font.
    // Faces beyond the known list are discovered once the native font catalog loads (off
    // startup), so open terminals re-apply their font stack then (#3723).
    useSystemFontStore.subscribe((s, prev) => {
      if (s.fonts === prev.fonts) return;
      terminalRuntime()?.applySettingsToAll();
      terminalRuntime()?.applySettingsToClis();
    }),
    onIdeEvent("terminalExited", (e) => {
      const rt = terminalRuntime();
      (rt?.sessionForTerminalId(e.terminal) ?? rt?.cliSessionForTerminalId(e.terminal))?.exited(e.code);
    }),
    (() => {
      if (typeof document === "undefined") return () => {};
      const onVisibility = () => notifyTerminalVisibility();
      document.addEventListener("visibilitychange", onVisibility);
      return () => document.removeEventListener("visibilitychange", onVisibility);
    })(),
    // Sessions belong to the project. Remember this project's tabs, then open the next one's.
    (() => {
      let prevLocation = projectLocation(useProject.getState().project?.root);
      return useProject.subscribe((s) => {
        const nextLocation = projectLocation(s.project?.root);
        if (nextLocation === prevLocation) return;
        const wasRemote = !!prevLocation && parseRemoteLocation(prevLocation) !== null;
        prevLocation = nextLocation;
        const rt = terminalRuntime();
        if (rt) {
          if (rt.useTerminalFind.getState().open) rt.closeTerminalFind();
          rt.syncTerminalProject(s.project?.root ?? null, nextLocation);
          // The editor drops the old project's tabs without `onClose`; their CLIs end with it locally,
          // or detach without killing the remote daemon's PTYs.
          rt.disposeAllClis(!wasRemote);
        } else if (s.project?.root && isRemoteWindow() && isTauri()) {
          const root = s.project.root;
          void commands
            .termList()
            .then(async (list) => {
              if (list.length > 0 && useProject.getState().project?.root === root) {
                await loadTerminalRuntime();
              }
            })
            .catch(() => {});
        }
      });
    })(),
    (() => {
      if (typeof window === "undefined") return () => {};
      const flush = () => terminalRuntime()?.rememberTerminals();
      window.addEventListener("pagehide", flush);
      window.addEventListener("beforeunload", flush);
      return () => {
        window.removeEventListener("pagehide", flush);
        window.removeEventListener("beforeunload", flush);
      };
    })(),
  ];

  if (typeof MutationObserver !== "undefined" && typeof document !== "undefined") {
    const observer = new MutationObserver(() => {
      terminalRuntime()?.applyThemeToAll();
      terminalRuntime()?.applyThemeToClis();
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
    terminalRuntime()?.unbindTerminals();
  };
}
