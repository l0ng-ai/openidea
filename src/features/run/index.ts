/**
 * Run configurations, the title bar run widget, the Run tool window (console +
 * test runner) and run/debug/stop actions.
 */
import { registerEditorContribution } from "@/editor/api";
import { executeAction, getAction, registerActions } from "@/platform/actions";
import { getContext, setContext } from "@/platform/context";
import { onIdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onWorkflowSettingsChange } from "@/platform/workflowSettings";
import { showContextMenu, lazyComponent, type MenuItem } from "@/ui";
import {
  menuGroupItems,
  notifications,
  registerMenuGroup,
  registerOverlay,
  registerRunAnythingProvider,
  registerServiceProvider,
  registerTitleItem,
  registerToolWindow,
} from "@/workbench/contributions";
import { chooserJustClosed, ConfigChooserOverlay } from "./ConfigChooser";
import {
  compiledDebugPlan,
  contextMenuItems,
  executeContext,
  launchProduced,
  modifyContext,
  prepareMenu,
  runContextAction,
} from "./contextRun";
import { runWithExecutor } from "./executors";
import { debugWithAgent, jdwpLaunch } from "./javaDebug";
import { RunDialogsOverlay } from "./dialogs";
import { registerExternalTools } from "./externalTools";
import { EditConfigsOverlay } from "./EditConfigsDialog";
import { RunWidget } from "./RunWidget";
import { runConfigsRunAnything } from "./runAnything";
import { runServiceProvider } from "./services";
import { runBeforeLaunch } from "./beforeLaunch";
import { compoundChildren } from "./configs";
import { remoteDebugBlocked } from "./remote";
import { isDebugOnly, registerBuiltinTypes } from "./types";
import { runGutter } from "./runGutter";
import { activateStackTrace, useStackTraces } from "./stackTrace";
import { clearRuntimeCache } from "./runtimes";
import {
  adoptTemporary,
  applyConsoleSettings,
  CURRENT_FILE,
  currentFileSelected,
  prepareLaunch,
  sessionsOf,
  setBeforeLaunchRunner,
  loadConfigs,
  failedTests,
  onRunExited,
  rerunFailed,
  rerunSession,
  resetRuns,
  runningSessions,
  saveUserConfigs,
  selectConfig,
  selectedConfig,
  startRun,
  stopSession,
  useRun,
} from "./store";
import { tx } from "@/platform/i18n";

function hasProject() {
  return !!useProject.getState().project;
}

async function ensureConfigs() {
  if (!useRun.getState().loaded) await loadConfigs();
}

async function runSelected() {
  await ensureConfigs();
  if (currentFileSelected()) return runCurrentFile(false);
  const config = selectedConfig();
  if (!config) {
    useRun.setState({ chooserOpen: true, chooserMode: "run" });
    return;
  }
  await startRun(config);
}

async function debugConfig(config: RunConfig, chain: readonly string[] = []) {
  if (config.kind === "compound") {
    if (!(await prepareLaunch(config, chain))) return;
    const children = compoundChildren(config, useRun.getState().configs);
    await Promise.all(children.map((c) => debugConfig(c, [...chain, config.id])));
    return;
  }
  if (remoteDebugBlocked(config)) return;
  if (!(await prepareLaunch(config, chain))) return;
  // Remote JVM Debug, Go Remote…: the debugger attaches, nothing is launched here.
  if (isDebugOnly(config) && getAction("debug.startConfig")) {
    await executeAction("debug.startConfig", config);
    return;
  }
  // A single compiled file (rustc / clang): build with debug info, then debug the binary.
  const compiled = await compiledDebugPlan(config);
  if (compiled?.debug) {
    await launchProduced(compiled, true);
    return;
  }
  // Maven / Gradle: the build tool starts the JVM with a debug agent, the debugger attaches.
  if (jdwpLaunch(config) && getAction("debug.attach")) {
    await debugWithAgent(config);
    return;
  }
  if (getAction("debug.startConfig")) {
    await executeAction("debug.startConfig", config);
    return;
  }
  notifications().notify({
    group: "run",
    level: "warning",
    title: "Debugger is not available",
    body: tx`Running '${config.name}' without the debugger.`,
    key: "run-no-debugger",
  });
  await startRun(config, undefined, undefined, { prepared: true });
}

async function debugSelected() {
  await ensureConfigs();
  if (currentFileSelected()) return runCurrentFile(true);
  const config = selectedConfig();
  if (!config) {
    useRun.setState({ chooserOpen: true, chooserMode: "debug" });
    return;
  }
  await debugConfig(config);
}

async function runContext(debug: boolean, arg?: unknown) {
  if (!(await runContextAction(debug, arg))) nothingToRun();
}

/** "Current File" stays selected after running the file's context (which adopts a temporary configuration). */
async function runCurrentFile(debug: boolean) {
  await runContext(debug);
  selectConfig(CURRENT_FILE);
}

function nothingToRun() {
  notifications().notify({
    group: "run",
    level: "info",
    title: "Nothing to run here",
    body: "The active file has no runnable element, test or run configuration.",
    key: "run-context",
  });
}

/**
 * The configuration an action argument names: a config id, a `RunConfig`, or
 * `{ config, temporary: true }` (Maven / Gradle tool windows: becomes a temporary configuration, like IDEA).
 */
function configFromArg(arg: unknown): RunConfig | undefined {
  if (typeof arg === "string") return useRun.getState().configs.find((c) => c.id === arg);
  if (!arg || typeof arg !== "object") return undefined;
  if ("config" in arg) {
    const { config, temporary } = arg as { config: RunConfig; temporary?: boolean };
    return temporary ? adoptTemporary(config) : config;
  }
  return arg as RunConfig;
}

/**
 * IDEA's Stop: in the Run or Debug tool window, the selected tab's process; otherwise the
 * only running process, or a chooser of every running one (run sessions and the
 * `stopProcess` items other features contribute, e.g. debug sessions).
 */
function stopAction() {
  const ctx = getContext();
  if (ctx.toolWindowFocus && ctx.activeToolWindow === "debug" && getAction("debug.stop")) {
    void executeAction("debug.stop");
    return;
  }
  const running = runningSessions();
  const { activeSession } = useRun.getState();
  if (ctx.toolWindowFocus && ctx.activeToolWindow === "run") {
    const active = running.find((s) => s.id === activeSession);
    if (active) {
      void stopSession(active.id);
      return;
    }
  }
  // A selected compound stops all of its configurations.
  const selected = selectedConfig();
  if (selected?.kind === "compound") {
    const own = sessionsOf(selected, running);
    if (own.length) {
      own.forEach((s) => void stopSession(s.id));
      return;
    }
  }
  const items = [
    ...running.map((s): MenuItem => ({
      label: s.config.name,
      verbatim: true,
      icon: "run",
      run: () => void stopSession(s.id),
    })),
    ...menuGroupItems("stopProcess", { paths: [] }),
  ].filter((i): i is MenuItem & { run: () => void } => "run" in i && !!i.run);
  if (items.length === 0) return;
  if (items.length === 1) {
    items[0]!.run();
    return;
  }
  const anchor = document.querySelector("[data-run-chooser]")?.getBoundingClientRect();
  const at = anchor ? { x: anchor.left, y: anchor.bottom + 4 } : { x: window.innerWidth / 2 - 120, y: 44 };
  showContextMenu(at, [
    { kind: "header", label: "Stop Process" },
    ...items,
    { kind: "separator" },
    { label: "Stop All", icon: "stop", danger: true, run: () => items.forEach((i) => i.run()) },
  ]);
}

/** IDEA's Rerun (⌘R / Ctrl+F5 in the Run tool window): restarts the selected tab without asking. */
function rerunActive() {
  const { activeSession, sessions } = useRun.getState();
  const id = activeSession ?? sessions[sessions.length - 1]?.id;
  if (id) rerunSession(id);
}

function useRunningCount(): number | null {
  return useRun((s) => s.sessions.filter((x) => x.status === "running" || x.status === "starting").length || null);
}

const CONFIG_FILES =
  /(?:^|\/)(?:\.openidea\/run\.toml|package\.json|deno\.jsonc?|Cargo\.toml|build\.gradle(?:\.kts)?|pom\.xml|go\.mod|pyproject\.toml|setup\.cfg|pytest\.ini|manage\.py|Makefile|justfile)$/;

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void loadConfigs(), 300);
}

export function activate(): () => void {
  const disposers: Array<() => void> = [
    registerToolWindow({
      id: "run",
      title: "Run",
      icon: "toolwindow-run",
      anchor: "bottom",
      stripe: "onUse",
      order: 5,
      component: lazyComponent(() => import("./RunView").then((m) => m.RunView)),
      headerContent: lazyComponent(() => import("./RunView").then((m) => m.RunTabs)),
      useBadge: useRunningCount,
    }),
    registerTitleItem({ id: "run.widget", title: "Run Widget", align: "right", priority: 0, component: RunWidget }),
    registerRunAnythingProvider(runConfigsRunAnything),
    registerBuiltinTypes(),
    registerOverlay({ id: "run.chooser", component: ConfigChooserOverlay }),
    registerOverlay({ id: "run.editConfigs", component: EditConfigsOverlay }),
    registerOverlay({ id: "run.dialogs", component: RunDialogsOverlay }),
    registerServiceProvider(runServiceProvider),
    onWorkflowSettingsChange((w) => w.console, applyConsoleSettings),
    registerExternalTools(),
    activateStackTrace(),
    registerEditorContribution({ id: "run.targets", order: 55, extensions: runGutter }),
    registerMenuGroup({
      id: "run.context",
      menus: ["editor", "projectView", "editorTab"],
      items: contextMenuItems,
      prepare: prepareMenu,
    }),
    registerActions([
      {
        id: "run.run",
        title: "Run",
        category: "Run",
        icon: "run",
        when: "projectOpen",
        run: () => runSelected(),
      },
      {
        id: "run.debug",
        title: "Debug",
        category: "Run",
        icon: "debug",
        when: "projectOpen",
        run: () => debugSelected(),
      },
      {
        id: "run.runContext",
        title: "Run Context Configuration",
        description: "Run the test or program in the active file",
        category: "Run",
        icon: "run",
        when: "projectOpen",
        keywords: ["run file", "run test"],
        run: ({ arg }) => runContext(false, arg),
      },
      {
        id: "run.debugContext",
        title: "Debug Context Configuration",
        category: "Run",
        icon: "debug",
        when: "projectOpen",
        run: ({ arg }) => runContext(true, arg),
      },
      {
        id: "run.modifyContext",
        title: "Modify Run Configuration…",
        description: "Edit the configuration that would run the context before saving it",
        category: "Run",
        icon: "edit",
        when: "projectOpen",
        run: ({ arg }) => modifyContext(arg),
      },
      {
        id: "run.stop",
        title: "Stop",
        category: "Run",
        icon: "stop",
        when: "projectOpen",
        run: () => stopAction(),
      },
      {
        id: "run.rerun",
        title: "Rerun",
        category: "Run",
        icon: "rerun",
        when: "projectOpen && activeToolWindow == 'run'",
        run: () => rerunActive(),
      },
      {
        id: "run.chooseConfig",
        title: "Select Run/Debug Configuration…",
        description:
          'Run a configuration (hold Shift to debug); the title bar widget passes "select" to only select one',
        category: "Run",
        when: "projectOpen",
        run: async ({ arg }) => {
          if (useRun.getState().chooserOpen || chooserJustClosed()) {
            useRun.setState({ chooserOpen: false });
            return;
          }
          await ensureConfigs();
          useRun.setState({ chooserOpen: true, chooserMode: arg === "select" ? "select" : "run" });
        },
      },
      {
        id: "run.chooseDebugConfig",
        title: "Debug…",
        description: "Choose a run/debug configuration and debug it",
        category: "Run",
        keywords: ["choose and debug configuration"],
        when: "projectOpen",
        run: async () => {
          if (useRun.getState().chooserOpen || chooserJustClosed()) {
            useRun.setState({ chooserOpen: false });
            return;
          }
          await ensureConfigs();
          useRun.setState({ chooserOpen: true, chooserMode: "debug" });
        },
      },
      {
        id: "run.editConfigs",
        title: "Edit Configurations…",
        category: "Run",
        icon: "settings",
        when: "projectOpen",
        keywords: ["run configuration", "launch"],
        run: async ({ arg }) => {
          await ensureConfigs();
          useRun.setState({
            editorOpen: true,
            chooserOpen: false,
            editTarget: typeof arg === "string" ? arg : null,
          });
        },
      },
      {
        id: "run.debugConfig",
        title: "Debug Configuration",
        category: "Run",
        hidden: true,
        when: "projectOpen",
        run: async ({ arg }) => {
          await ensureConfigs();
          const config = configFromArg(arg);
          if (config) await debugConfig(config);
        },
      },
      {
        id: "run.rerunFailed",
        title: "Rerun Failed Tests",
        category: "Run",
        icon: "rerun",
        when: "projectOpen",
        keywords: ["failed tests", "rerun"],
        run: () => {
          const s = useRun.getState();
          const id =
            (s.activeSession && failedTests(s.activeSession).length ? s.activeSession : null) ??
            [...s.sessions].reverse().find((x) => failedTests(x.id).length > 0)?.id;
          if (!id || !rerunFailed(id))
            notifications().notify({
              group: "run",
              level: "info",
              title: "No failed tests to rerun",
              key: "run-rerun-failed",
            });
        },
      },
      {
        id: "run.reloadConfigs",
        title: "Reload Run Configurations",
        category: "Run",
        icon: "refresh",
        when: "projectOpen",
        run: () => {
          clearRuntimeCache();
          return loadConfigs();
        },
      },
      {
        id: "run.runConfig",
        title: "Run Configuration",
        category: "Run",
        hidden: true,
        when: "projectOpen",
        run: async ({ arg }) => {
          await ensureConfigs();
          const config = configFromArg(arg);
          if (config) await startRun(config);
        },
      },
      {
        id: "run.withExecutor",
        title: "Run with Executor",
        description:
          "Runs with a contributed executor (`{ executor, config? }` or `{ executor, context }`): the given or selected configuration, or the context.",
        category: "Run",
        hidden: true,
        when: "projectOpen",
        run: async ({ arg }) => {
          if (!arg || typeof arg !== "object" || typeof (arg as { executor?: unknown }).executor !== "string") return;
          const { executor, config, context } = arg as { executor: string; config?: unknown; context?: unknown };
          if (context !== undefined) {
            if (!(await executeContext(executor, context === true ? undefined : context))) nothingToRun();
            return;
          }
          await ensureConfigs();
          if (config === undefined && currentFileSelected()) {
            if (!(await executeContext(executor, undefined))) nothingToRun();
            return;
          }
          const target = config !== undefined ? configFromArg(config) : selectedConfig();
          if (!target) {
            useRun.setState({ chooserOpen: true, chooserMode: "run" });
            return;
          }
          await runWithExecutor(target, executor);
        },
      },
      {
        id: "run.createConfig",
        title: "Create Run Configuration",
        description: "Saves the given `RunConfig` as a user configuration and opens it in Edit Configurations.",
        category: "Run",
        hidden: true,
        when: "projectOpen",
        run: async ({ arg }) => {
          if (!arg || typeof arg !== "object") return;
          await ensureConfigs();
          const config: RunConfig = { ...(arg as RunConfig), detected: false };
          const { configs, temporary } = useRun.getState();
          const user = configs.filter((c) => !c.detected && !temporary.includes(c.id) && c.id !== config.id);
          await saveUserConfigs([...user, config]);
          selectConfig(config.id);
          useRun.setState({ editorOpen: true, chooserOpen: false, editTarget: config.id });
        },
      },
    ]),
    onIdeEvent("runExited", (e) => onRunExited(e.run, e.code)),
    // Lets other title items follow the selected configuration (e.g. Build shows only for compiled ones).
    useRun.subscribe((s) => setContext("run.selectedKind", s.configs.find((c) => c.id === s.selectedId)?.kind ?? "")),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root) return;
      resetRuns();
      useStackTraces.setState({ tabs: [], dialog: null });
      if (s.project) void loadConfigs();
    }),
  ];

  setBeforeLaunchRunner(runBeforeLaunch);
  disposers.push(() => setBeforeLaunchRunner(null));
  if (hasProject()) void loadConfigs();

  // Reload when run.toml or build files change on disk (cheap; detection is fast).
  disposers.push(
    onIdeEvent("fsChanged", (e) => {
      const paths = [...e.created, ...e.modified, ...e.removed];
      if (paths.some((p) => CONFIG_FILES.test(p))) scheduleReload();
    }),
    // Detected configs carry the selected toolchains (interpreter, JDK, Maven home and options).
    onIdeEvent("settingsChanged", (e) => {
      if (e.key === "languages" || e.key.startsWith("languages.")) scheduleReload();
    }),
  );

  return () => {
    clearTimeout(reloadTimer);
    disposers.reverse().forEach((d) => d());
    resetRuns();
  };
}
