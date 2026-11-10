/**
 * Run configurations, the title bar run widget, the Run tool window (console +
 * test runner) and run/debug/stop actions.
 */
import { registerEditorContribution } from "@/editor/api";
import { executeAction, executeActionOrThrow, getAction, registerActions } from "@/platform/actions";
import { getContext, setContext, useContextKeys } from "@/platform/context";
import { call, commands, onIdeEvent, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onWorkflowSettingsChange } from "@/platform/workflowSettings";
import { showContextMenu, lazyComponent, lazyWhen, type MenuItem } from "@/ui";
import {
  menuGroupItems,
  useDebugRunSessions,
  notifications,
  provideRunOutput,
  registerMenuGroup,
  registerOverlay,
  registerRunAnythingProvider,
  registerRunConfigType,
  registerRunningProcessesProvider,
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
import { openImport } from "./importConfigs";
import { registerComposerInstall } from "./composerInstall";
import { registerGoActions } from "./goActions";
import { invalidateGoModules } from "./goModules";
import { invalidatePythonPackages } from "./pythonPackages";
import { RunWidget } from "./RunWidget";
import { runConfigsRunAnything } from "./runAnything";
import { cleanupRemovedProject, recordRun, registerRunServiceActions, runServiceProvider } from "./services";
import { liveServiceSession, serviceSessions } from "./serviceSessions";
import { ServiceImportHost } from "./serviceImport";
import { cmakeBuildId } from "./cmake";
import { runBeforeLaunch } from "./beforeLaunch";
import { compoundChildren } from "./configs";
import { containerDebuggable, remoteDebugBlocked } from "./remote";
import { debugInContainer } from "./containerDebug";
import { isDebugOnly, registerBuiltinTypes } from "./types";
import { junitType } from "./junitType";
import { listenForApplicationDeactivation, showApplicationUpdate, updatableSessions } from "./applicationUpdate";
import { npmGutter } from "./npmGutter";
import { runGutter } from "./runGutter";
import { gradleDelegation } from "./gradleRun";
import { activateStackTrace, useStackTraces } from "./stackTrace";
import { clearRuntimeCache } from "./runtimes";
import {
  adoptTemporary,
  applyConsoleSettings,
  CURRENT_FILE,
  currentFileSelected,
  prepareLaunch,
  rescheduleConsoleFlushes,
  setBeforeLaunchRunner,
  loadConfigs,
  failedTests,
  baseConfigOf,
  onRunExited,
  rerunFailed,
  rerunSession,
  resetRuns,
  runningSessions,
  saveUserConfigs,
  dropStaleContextConfigs,
  selectConfig,
  selectedConfig,
  startRun,
  startSampleOutput,
  stopSession,
  subscribeOutput,
  trackRecentConfigurations,
  useRun,
  isLive,
} from "./store";
import { rerunFailedConfigs } from "./testing/rerun";
import { compoundTargets, selectedTarget } from "./sessionTargets";
import { tx } from "@/platform/i18n";

function trackFailedTestSelection(): () => void {
  let signature = "";
  let generation = 0;
  const update = () => {
    const state = useRun.getState();
    const id =
      (state.activeSession && failedTests(state.activeSession).length ? state.activeSession : null) ??
      [...state.sessions].reverse().find((s) => failedTests(s.id).length > 0)?.id;
    const session = state.sessions.find((s) => s.id === id);
    const base = session && baseConfigOf(session);
    const paths = id ? failedTests(id) : [];
    const next = JSON.stringify([id, session?.status, base, paths]);
    if (next === signature) return;
    signature = next;
    const request = ++generation;
    setContext("run.canRerunFailed", false);
    if (!session || isLive(session) || !base) return;
    const selection = rerunFailedConfigs(base, paths);
    if (selection instanceof Promise) {
      void selection.then((configs) => {
        if (request === generation) setContext("run.canRerunFailed", configs.length > 0);
      });
    } else setContext("run.canRerunFailed", selection.length > 0);
  };
  const stop = useRun.subscribe(update);
  update();
  return () => {
    generation++;
    stop();
    setContext("run.canRerunFailed", false);
  };
}

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
  const target = selectedTarget(config.id, useRun.getState().sessions, useDebugRunSessions.getState().sessions);
  if (target) {
    target.rerun?.();
    return;
  }
  await startRun(config);
}

async function debugConfig(config: RunConfig, chain: readonly string[] = [], show?: boolean) {
  if (config.kind === "compound") {
    if (!(await prepareLaunch(config, chain, show))) return;
    const children = compoundChildren(config, useRun.getState().configs);
    await Promise.all(children.map((c) => debugConfig(c, [...chain, config.id], show)));
    return;
  }
  if (remoteDebugBlocked(config)) return;
  if (!(await prepareLaunch(config, chain, show))) return;
  recordRun(config.id);
  // Python on a Docker / Compose target: debugpy in the container, the debugger attaches.
  if (containerDebuggable(config) && getAction("debug.attach")) {
    await debugInContainer(config);
    return;
  }
  // Remote JVM Debug, Go Remote…: the debugger attaches, nothing is launched here.
  if (isDebugOnly(config) && getAction("debug.startConfig")) {
    await executeAction("debug.startConfig", show === false ? { config, show: false } : config);
    return;
  }
  // A single compiled file (rustc / clang): build with debug info, then debug the binary.
  const compiled = await compiledDebugPlan(config);
  if (compiled?.debug) {
    await launchProduced(compiled, true, show);
    return;
  }
  // "Build and run using: Gradle": the JavaExec JVM gets the agent, the debugger attaches to it.
  let delegated: RunConfig | null;
  try {
    delegated = getAction("debug.attach") ? await gradleDelegation(config) : null;
  } catch (error) {
    notifications().notify({
      group: "run",
      level: "error",
      title: `Cannot run '${config.name}'`,
      body: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (delegated) {
    await debugWithAgent(delegated, show);
    return;
  }
  // Maven / Gradle: the build tool starts the JVM with a debug agent, the debugger attaches.
  if (jdwpLaunch(config) && getAction("debug.attach")) {
    await debugWithAgent(config, show);
    return;
  }
  if (getAction("debug.startConfig")) {
    await executeAction("debug.startConfig", show === false ? { config, show: false } : config);
    return;
  }
  notifications().notify({
    group: "run",
    level: "warning",
    title: "Debugger is not available",
    body: tx`Running '${config.name}' without the debugger.`,
    key: "run-no-debugger",
  });
  await startRun(config, undefined, undefined, { prepared: true, show });
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
 * Stop: in the Run or Debug tool window, the selected tab's process; otherwise the selected
 * configuration's session, or a chooser of every running process.
 */
/**
 * Stop. In the Run tool window: its active tab. From the run widget (`arg` "widget"): the selected
 * configuration's process. Elsewhere (shortcut, menu, Find Action), like IDEA's Stop: the only
 * stoppable process, or a list of them with Stop All when there are several.
 */
function stopAction(arg?: unknown) {
  const ctx = getContext();
  if (ctx.toolWindowFocus && ctx.activeToolWindow === "debug" && getAction("debug.stop")) {
    void executeAction("debug.stop");
    return;
  }
  const running = runningSessions();
  if (ctx.toolWindowFocus && ctx.activeToolWindow === "run") {
    const active = running.find((s) => s.id === useRun.getState().activeSession);
    if (active) {
      void stopSession(active.id);
      return;
    }
  }
  const debug = useDebugRunSessions.getState().sessions;
  if (arg === "widget") {
    const compound = compoundTargets(selectedConfig(), running, debug);
    if (compound.length) {
      compound.forEach((s) => s.stop());
      return;
    }
    const target = selectedTarget(useRun.getState().selectedId, running, debug);
    if (target) {
      target.stop();
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
  // A Debug launch has no Run process: with nothing else to stop, the title-bar Stop reaches
  // the debug session itself (the Debug window need not be focused).
  if (items.length === 0) {
    if (debug.length === 0) return;
    if (debug.length === 1) {
      debug[0]!.stop();
      return;
    }
    const anchor = document.querySelector("[data-run-chooser]")?.getBoundingClientRect();
    const at = anchor ? { x: anchor.left, y: anchor.bottom + 4 } : { x: window.innerWidth / 2 - 120, y: 44 };
    showContextMenu(at, [
      { kind: "header", label: "Stop Process" },
      ...debug.map((s): MenuItem => ({ label: s.name, verbatim: true, icon: "debug", run: () => s.stop() })),
    ]);
    return;
  }
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
  return useRun((s) => s.sessions.filter(isLive).length || null);
}

const CONFIG_FILES =
  /(?:^|\/)(?:\.openidea\/run\.toml|package\.json|deno\.jsonc?|Cargo\.toml|build\.gradle(?:\.kts)?|pom\.xml|go\.(?:mod|work)|pyproject\.toml|setup\.cfg|pytest\.ini|manage\.py|Makefile|justfile|CMakeLists\.txt|CMakeCache\.txt|index-[^/]+\.json)$/;

let reloadTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleReload() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => void loadConfigs(), 300);
}

const useEditConfigsOpen = () => useRun((s) => s.editorOpen);

export function activate(): () => void {
  const disposers: Array<() => void> = [
    // The performance harness (`perf/`): a console streaming generated output.
    import.meta.env.DEV || import.meta.env.MODE === "perf"
      ? registerActions([
          {
            id: "run.sampleOutput",
            title: "Stream Sample Output",
            category: "Run",
            hidden: true,
            run: async ({ arg }) => {
              const { lines = 20_000, perFrame = 200 } = (arg ?? {}) as { lines?: number; perFrame?: number };
              await startSampleOutput(lines, perFrame);
            },
          },
        ])
      : () => {},
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
    registerRunConfigType(junitType),
    registerGoActions(),
    registerComposerInstall(),
    registerOverlay({ id: "run.chooser", component: ConfigChooserOverlay }),
    registerOverlay({
      id: "run.editConfigs",
      component: lazyWhen(useEditConfigsOpen, () => import("./EditConfigsDialog").then((m) => m.EditConfigsOverlay)),
    }),
    registerOverlay({ id: "run.dialogs", component: RunDialogsOverlay }),
    registerOverlay({ id: "run.serviceImport", component: ServiceImportHost }),
    registerOverlay({ id: "run.serviceImport", component: ServiceImportHost }),
    registerServiceProvider(runServiceProvider),
    registerRunServiceActions(),
    registerRunningProcessesProvider({
      id: "run",
      running: () =>
        serviceSessions(useRun.getState().sessions, useDebugRunSessions.getState().serviceSessions)
          .filter(liveServiceSession)
          .map((s) => ({ name: s.config.name })),
      // A closing window asks first, then shows the progress while these shut down; `kill`
      // is the second Stop that SIGKILLs instead of waiting.
      stop: (kill) => {
        // The first call asks to stop; with `kill` the second one reaches the backend while
        // the session is already stopping, which turns it into SIGKILL.
        for (const s of useRun.getState().sessions.filter(isLive)) {
          void stopSession(s.id);
          if (kill) void stopSession(s.id);
        }
        for (const d of useDebugRunSessions.getState().sessions) {
          d.stop();
          if (kill) d.stop();
        }
      },
    }),
    onWorkflowSettingsChange((w) => w.console, applyConsoleSettings),
    registerExternalTools(),
    activateStackTrace(),
    listenForApplicationDeactivation(),
    trackRecentConfigurations(),
    trackFailedTestSelection(),
    useDebugRunSessions.subscribe(() => setContext("run.updatableRunning", updatableSessions().length > 0)),
    // A removed workspace member (or a closed project) takes its sessions,
    // temporary configurations and Services groups with it.
    // Only while the same project stays open: closing it tears its runs down separately.
    useProject.subscribe((s, prev) => {
      if (!s.project || s.project.root !== prev.project?.root) return;
      const before = prev.project.workspace?.projects ?? [prev.project.root];
      const after = s.project.workspace?.projects ?? [s.project.root];
      for (const root of before) if (!after.includes(root)) void cleanupRemovedProject(root);
    }),
    registerEditorContribution({ id: "run.targets", order: 55, extensions: runGutter }),
    registerEditorContribution({ id: "run.npmScripts", order: 58, extensions: npmGutter }),
    registerMenuGroup({
      id: "run.context",
      menus: ["editor", "projectView", "editorTab"],
      items: contextMenuItems,
      prepare: prepareMenu,
    }),
    registerActions([
      {
        id: "run.updateApplication",
        title: "Update Application",
        category: "Run",
        icon: "refresh",
        when: "run.updatableRunning",
        run: () => showApplicationUpdate(),
      },
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
        run: ({ arg }) => stopAction(arg),
      },
      {
        id: "run.stopProcess",
        title: "Stop",
        category: "Run",
        hidden: true,
        run: async ({ arg }) => {
          if (typeof arg !== "number") return;
          const session = useRun.getState().sessions.find((s) => s.runId === arg);
          if (session) await stopSession(session.id);
          else await call(commands.runStop(arg));
        },
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
        id: "run.importVscodeLaunch",
        title: "Import Run Configurations from .vscode/launch.json",
        category: "Run",
        when: "projectOpen",
        keywords: ["launch.json", "vscode", "visual studio code", "debug configuration"],
        run: () => openImport("vscode"),
      },
      {
        id: "run.importJetbrains",
        title: "Import Run Configurations from JetBrains (.run, .idea)",
        category: "Run",
        when: "projectOpen",
        keywords: ["pycharm", "webstorm", "intellij", "run.xml", "workspace.xml", "run configuration"],
        run: () => openImport("jetbrains"),
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
          const show = arg && typeof arg === "object" && "show" in arg ? (arg as { show?: boolean }).show : undefined;
          if (config) await debugConfig(config, [], show);
        },
      },
      {
        id: "run.rerunFailed",
        title: "Rerun Failed Tests",
        category: "Run",
        icon: "rerun",
        when: "projectOpen && run.canRerunFailed",
        keywords: ["failed tests", "rerun"],
        run: async () => {
          const s = useRun.getState();
          const id =
            (s.activeSession && failedTests(s.activeSession).length ? s.activeSession : null) ??
            [...s.sessions].reverse().find((x) => failedTests(x.id).length > 0)?.id;
          if (!id || !(await rerunFailed(id)))
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
        id: "run.pluginStart",
        title: "Run Plugin Configuration",
        category: "Run",
        hidden: true,
        when: "projectOpen",
        run: async ({ arg }) => {
          const a = arg as {
            config: import("@/bindings").RunConfig;
            debug: boolean;
            onExit: (code: number | null, stopped: boolean) => void;
          };
          if (a.debug) {
            if (!getAction("debug.pluginStart")) throw new Error("Debugger unavailable");
            await executeActionOrThrow("debug.pluginStart", a);
            return;
          }
          const session = await startRun(a.config, undefined, undefined, { onExit: a.onExit });
          if (!session || session.status === "failed") throw new Error("Run did not start");
          if (session.runId === null && session.status === "finished") a.onExit(session.exitCode, !!session.stopped);
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
          if (!config) return;
          // `{ config, onExit }`: told when the process exits, or right away when it didn't start.
          const onExit = (arg as { onExit?: (code: number | null, stopped: boolean) => void } | null)?.onExit;
          if (typeof onExit !== "function") {
            await startRun(config);
            return;
          }
          const session = await startRun(config, undefined, undefined, { onExit });
          if (!session || session.status === "failed") onExit(null, false);
          else if (session.runId === null && session.status === "finished") onExit(session.exitCode, !!session.stopped);
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
    onIdeEvent("projectRootsChanged", scheduleReload),
    // Lets other title items follow the selected configuration (e.g. Build shows only for compiled ones).
    useRun.subscribe((s) => {
      const selected = s.configs.find((c) => c.id === s.selectedId);
      setContext("run.selectedKind", selected?.kind ?? "");
      const cmake = selected ?? s.configs.find((c) => c.kind === "cmake" && c.args[0] === "--build");
      setContext("run.cmakeBuild", cmakeBuildId(cmake, s.configs));
      setContext("run.updatableRunning", updatableSessions().length > 0);
    }),
    useProject.subscribe((s, prev) => {
      if (s.project?.root === prev.project?.root && s.project?.trusted === prev.project?.trusted) return;
      resetRuns();
      useStackTraces.setState({ tabs: [], dialog: null });
      if (s.project) void loadConfigs();
    }),
  ];

  setBeforeLaunchRunner(runBeforeLaunch);
  disposers.push(() => setBeforeLaunchRunner(null));
  provideRunOutput({ subscribe: subscribeOutput });
  disposers.push(() => provideRunOutput(undefined));
  if (hasProject()) void loadConfigs();

  // Reload when run.toml or build files change on disk (cheap; detection is fast).
  disposers.push(
    onIdeEvent("fsChanged", (e) => {
      const paths = [...e.created, ...e.modified, ...e.removed];
      // A file that moved or was deleted leaves its context configuration behind.
      dropStaleContextConfigs(e.removed);
      if (paths.some((p) => /(?:^|\/)go\.(?:mod|work)$/.test(p))) invalidateGoModules();
      if (paths.some((p) => p.endsWith("/__init__.py"))) invalidatePythonPackages();
      if (paths.some((p) => CONFIG_FILES.test(p))) scheduleReload();
    }),
    useContextKeys.subscribe((s, prev) => {
      if (prev["build.running"] && !s["build.running"]) scheduleReload();
    }),
    onIdeEvent("runExited", (e) => {
      if (useRun.getState().sessions.some((s) => s.runId === e.run && s.config.kind === "cmake")) scheduleReload();
    }),
    // Detected configs carry the selected toolchains (interpreter, JDK, Maven home and options).
    onIdeEvent("settingsChanged", (e) => {
      if (
        !e.key ||
        e.key === "languages" ||
        e.key.startsWith("languages.") ||
        e.key === "cmake" ||
        e.key.startsWith("cmake.")
      )
        scheduleReload();
    }),
  );

  // Hidden tabs pause rAF: move pending console flushes to timeouts (and back on
  // return) so output keeps draining while a run continues in the background.
  const onVisibility = () => rescheduleConsoleFlushes();
  document.addEventListener("visibilitychange", onVisibility);
  disposers.push(() => document.removeEventListener("visibilitychange", onVisibility));

  return () => {
    clearTimeout(reloadTimer);
    disposers.reverse().forEach((d) => d());
    resetRuns();
  };
}
