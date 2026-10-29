/** Debugger actions (ids match `keymaps/intellij-macos.ts`). */
import { executeAction, getAction, registerActions, type Action } from "@/platform/actions";
import { call, commands, isCancelled, isTauri, nextRequestId, type RunConfig, type RunId } from "@/platform/ipc";
import { downloadJdkActions } from "@/platform/jdk";
import { useProject } from "@/platform/project";
import { activeEditor } from "@/editor/api";
import { maybeEditorService, notifications, showStatusInfo, toolWindowService } from "@/workbench/contributions";
import { canPlaceBreakpoint } from "./breakpoints/languages";
import {
  removeAllBreakpoints,
  setMuted,
  toggleBreakpoint,
  toggleTemporaryBreakpoint,
  useBreakpoints,
} from "./breakpoints/store";
import { removeAllSpecial, specialAt, toggleFieldAt, toggleMethodAt } from "./breakpoints/special";
import { fieldAt, methodAt } from "./breakpoints/symbols";
import { toggleBreakpointSmart } from "./breakpoints/toggle";
import { isJavaAttachTarget, isJavaDebuggable, javaAttachConfig, javaLaunchConfig } from "./java";
import { reloadChangedClasses } from "./hotswap";
import { debugUnsupportedReason, launchConfigFor } from "./launch";
import { isRemoteConfig, REMOTE_JVM, remoteAttachConfig, remoteJvmTarget } from "./remote";
import {
  activeSession,
  evaluate,
  isLive,
  rerunSession,
  revealFrame,
  rootOf,
  sessionSupports,
  showExecutionPoint,
  startSession,
  stopSession,
  useDebug,
  type DebugSession,
} from "./state";
import { focusedDebugView } from "./ui/focusedView";
import { browseFocusedConsoleHistory } from "./ui/expressionHistory";
import { expressionAt, valueHint } from "./editor/valueTooltip";
import { showHint } from "@/editor/lsp/hint";
import { pausedLineTargets, startInlineSmartStep } from "./editor/smartStep";
import {
  openBreakpointsDialog,
  openConfigChooser,
  openEvaluateDialog,
  openSmartStepChooser,
  useOverlays,
} from "./ui/popoverStore";
import { tx } from "@/platform/i18n";

function isRunConfig(arg: unknown): arg is RunConfig {
  return !!arg && typeof arg === "object" && "command" in arg && "args" in arg && "debugAdapter" in arg;
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

async function report(title: string, p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    // A Java launch without a JDK new enough (for jdtls or the project) offers to download one.
    const actions = downloadJdkActions(errorText(e));
    notifications().notify({ group: "run", level: "error", title, body: errorText(e), key: "debug.action", actions });
  }
}

/** The paused session and the thread to act on. */
function pausedTarget(): { s: DebugSession; thread: number } | null {
  const s = activeSession();
  if (!s || s.status !== "paused") return null;
  const thread = s.selectedThread ?? s.stoppedThread ?? s.threads[0]?.id;
  return thread == null ? null : { s, thread };
}

/** Run to Cursor at `line` (0-based) of `path` in the paused session. */
export function runToLine(path: string, line: number) {
  const t = pausedTarget();
  if (t) void report("Run to Cursor failed", call(commands.debugRunTo(t.s.id, t.thread, path, line, false)));
}

function notSupported(what: string, s: DebugSession) {
  notifications().notify({
    group: "run",
    level: "info",
    key: "debug.unsupported",
    title: `${what} is not supported by ${s.adapter || "this debugger"}`,
  });
}

/** The selected frame of the paused session (top frame when none is selected). */
function selectedFrame(s: DebugSession) {
  return s.frames.find((f) => f.id === s.selectedFrame) ?? s.frames[0] ?? null;
}

/**
 * Smart Step Into: the calls on the current line, picked in the editor (the
 * dialog when they cannot be placed); one call (or none) steps straight in, like IDEA.
 */
async function smartStepInto() {
  const t = pausedTarget();
  if (!t) return;
  const frame = selectedFrame(t.s);
  if (!frame || !sessionSupports("stepInTargets", t.s)) {
    await call(commands.debugStep(t.s.id, t.thread, "into"));
    return;
  }
  const targets = pausedLineTargets(await call(commands.debugStepInTargets(t.s.id, frame.id)));
  if (targets.length <= 1) {
    await call(
      targets[0]
        ? commands.debugStepInTarget(t.s.id, t.thread, targets[0].id)
        : commands.debugStep(t.s.id, t.thread, "into"),
    );
    return;
  }
  if (!startInlineSmartStep(t.s.id, t.thread, targets)) openSmartStepChooser(t.s.id, t.thread, targets);
}

/** Opens the Attach to Process popup and loads the process list. */
export async function openAttachPopup() {
  if (!isTauri()) {
    notifications().notify({ group: "run", level: "warning", title: "Attaching needs the desktop app" });
    return;
  }
  useOverlays.setState({ attach: { processes: null, error: null } });
  try {
    const processes = await call(commands.debugAttachableProcesses());
    if (useOverlays.getState().attach) useOverlays.setState({ attach: { processes, error: null } });
  } catch (e) {
    if (useOverlays.getState().attach)
      useOverlays.setState({ attach: { processes: [], error: errorText(e) || "Cannot list processes" } });
  }
}

function cursor(): { path: string; line: number; selection: string } | null {
  const ed = activeEditor();
  if (!ed) return null;
  const { state } = ed.view;
  const main = state.selection.main;
  return {
    path: ed.ctx.path,
    line: state.doc.lineAt(main.head).number - 1,
    selection: state.sliceDoc(main.from, main.to),
  };
}

/** Evaluate's initial text, as in IDEA: the selection, else the expression at the caret. */
function evaluateSeed(): string {
  const ed = activeEditor();
  if (!ed) return "";
  const { state } = ed.view;
  const sel = state.selection.main;
  if (!sel.empty) return state.sliceDoc(sel.from, sel.to);
  return expressionAt(ed.view, sel.head)?.text ?? "";
}

async function quickEvaluate() {
  const view = activeEditor()?.view;
  if (!view) return;
  const sel = view.state.selection.main;
  const expression = evaluateSeed().trim();
  if (!expression) return showHint(view, "Nothing to evaluate at the caret");
  const session = activeSession();
  try {
    const value = await evaluate(expression, "hover", session);
    if (!session) return;
    showHint(view, () => valueHint(expression, value, session.id), { pos: sel.from, timeout: 60_000 });
  } catch (e) {
    showHint(view, e instanceof Error ? e.message : String(e), { pos: sel.from, tone: "error" });
  }
}

/**
 * Remote JVM Debug in listen mode: the IDE listens and the remote JVM connects; java-debug
 * then attaches through a loopback relay. Null when cancelled.
 */
async function listenForJvm(name: string, host: string, port: number): Promise<number | null> {
  const request = nextRequestId();
  const key = `debug.listen.${request}`;
  notifications().notify({
    group: "run",
    level: "info",
    key,
    sticky: true,
    title: `'${name}': listening for the remote JVM on port ${port}`,
    body: tx`Start the remote JVM with -agentlib:jdwp=transport=dt_socket,server=n,address=${host}:${port},suspend=y`,
    actions: [{ label: "Cancel", run: () => void commands.cancelRequest(request) }],
  });
  try {
    return await call(commands.debugListenForJvm(request, host, port));
  } catch (e) {
    if (isCancelled(e)) return null;
    throw e;
  } finally {
    notifications().expire?.(key);
  }
}

/** Remote JVM Debug, Go Remote, Python / Node.js remote: attach over host:port. */
async function startRemote(config: RunConfig, root: string) {
  if (config.kind === REMOTE_JVM) {
    const t = remoteJvmTarget(config);
    let hostName = t.host;
    let port = t.port;
    if (t.mode === "listen") {
      const relay = await listenForJvm(config.name, t.host, t.port);
      if (relay == null) return;
      [hostName, port] = ["127.0.0.1", relay];
    }
    const launch = await javaAttachConfig({ name: config.name, module: t.module, hostName, port }, root);
    // A listen relay accepts one debugger: rerunning listens again through the configuration.
    await startSession(launch, { rerunnable: t.mode === "attach" });
    return;
  }
  const launch = remoteAttachConfig(config, root);
  if (launch) await startSession(launch);
}

async function startConfig(arg: unknown) {
  const root = useProject.getState().project?.root;
  if (!root) return;
  let config: RunConfig | null = isRunConfig(arg) ? arg : null;
  if (!config) {
    if (!isTauri()) {
      notifications().notify({ group: "run", level: "warning", title: "Debugging needs the desktop app" });
      return;
    }
    const configs = (await call(commands.runConfigs())).filter((c) => c.debugAdapter);
    if (!configs.length) {
      notifications().notify({
        group: "run",
        level: "info",
        title: "Nothing to debug",
        body: "No run configuration in this project has a debug adapter.",
      });
      return;
    }
    if (configs.length > 1) {
      openConfigChooser(configs);
      return;
    }
    config = configs[0]!;
    // Through Run's debug flow: Maven / Gradle / scripts start the JVM with a JDWP agent there.
    if (getAction("run.debugConfig")) {
      await executeAction("run.debugConfig", config);
      return;
    }
  }
  if (isRemoteConfig(config)) {
    await startRemote(config, root);
    return;
  }
  if (isJavaDebuggable(config)) {
    await maybeEditorService()
      ?.saveAll()
      .catch(() => undefined);
    await startSession(await javaLaunchConfig(config, root));
    return;
  }
  const launch = launchConfigFor(config, root);
  if (!launch) {
    notifications().notify({
      group: "run",
      level: "warning",
      title: `“${config.name}” can't be debugged`,
      body: debugUnsupportedReason(config) ?? "It has no debug adapter.",
    });
    return;
  }
  await maybeEditorService()
    ?.saveAll()
    .catch(() => undefined);
  await startSession(launch);
}

export function registerDebugActions(): () => void {
  const paused = "debugSessionPaused";
  const step = (id: string, title: string, kind: "over" | "into" | "out", icon: string): Action => ({
    id,
    title,
    category: "Debug",
    icon,
    when: paused,
    run: () => {
      const t = pausedTarget();
      if (t) void report(title, call(commands.debugStep(t.s.id, t.thread, kind)));
    },
  });

  return registerActions([
    {
      id: "debug.startConfig",
      title: "Debug…",
      category: "Debug",
      icon: "debug",
      description: "Start debugging a run configuration",
      run: ({ arg }) => report("Cannot start debugging", startConfig(arg)),
    },
    {
      id: "debug.attach",
      title: "Attach Debugger",
      category: "Debug",
      hidden: true,
      description:
        "Attach the Java debugger to a JVM listening for JDWP (arg: { name, module, hostName, port, process })",
      run: ({ arg }) =>
        report(
          "Cannot attach the debugger",
          (async () => {
            const root = useProject.getState().project?.root;
            if (!root || !isJavaAttachTarget(arg)) return;
            const launch = await javaAttachConfig(arg, root);
            await startSession(launch, { process: (arg.process ?? null) as RunId | null, rerunnable: false });
          })(),
        ),
    },
    {
      id: "debug.stop",
      title: "Stop",
      category: "Debug",
      icon: "stop",
      when: "debugSessionActive",
      run: () => {
        const s = activeSession() ?? Object.values(useDebug.getState().sessions).find(isLive);
        if (s) void stopSession(s.id);
      },
    },
    {
      id: "debug.reloadChangedClasses",
      title: "Reload Changed Classes",
      description: "HotSwap: compile and reload the changed classes into the running Java debug session",
      category: "Debug",
      icon: "refresh",
      keywords: ["hotswap", "hot swap", "hot code replace"],
      when: "debugCanHotSwap",
      run: () => reloadChangedClasses(),
    },
    {
      id: "debug.rerun",
      title: "Rerun",
      category: "Debug",
      icon: "rerun",
      when: "debugCanRerun",
      // ⌘R / Ctrl+F5 rerun only in the Debug tool window (⌘R is Replace in the editor).
      keyWhen: "activeToolWindow == 'debug'",
      run: () => {
        const s = activeSession();
        if (s) void rerunSession(rootOf(s).id);
      },
    },
    {
      id: "debug.resume",
      title: "Resume Program",
      category: "Debug",
      icon: "resume",
      when: paused,
      run: () => {
        const t = pausedTarget();
        if (t) void report("Resume failed", call(commands.debugResume(t.s.id, t.thread)));
      },
    },
    {
      id: "debug.pause",
      title: "Pause Program",
      category: "Debug",
      icon: "pause",
      when: "debugSessionActive && !debugSessionPaused",
      run: async () => {
        const s = activeSession();
        if (!s || !isLive(s)) return;
        let thread = s.selectedThread ?? s.threads[0]?.id;
        if (thread == null) {
          const threads = await call(commands.debugThreads(s.id)).catch(() => []);
          thread = threads[0]?.id ?? 0;
        }
        await report("Pause failed", call(commands.debugPause(s.id, thread)));
      },
    },
    step("debug.stepOver", "Step Over", "over", "step-over"),
    step("debug.stepInto", "Step Into", "into", "step-into"),
    step("debug.stepOut", "Step Out", "out", "step-out"),
    {
      id: "debug.forceStepOver",
      title: "Force Step Over",
      category: "Debug",
      icon: "force-step-over",
      description: "Step over, ignoring breakpoints in the called code",
      when: paused,
      run: () => {
        const t = pausedTarget();
        if (t) void report("Force Step Over failed", call(commands.debugForceStepOver(t.s.id, t.thread)));
      },
    },
    {
      // DAP has no "ignore stepping filters" flag: adapters step into what their
      // launch options (justMyCode, skipFiles, stepFilters) allow.
      id: "debug.forceStepInto",
      title: "Force Step Into",
      category: "Debug",
      icon: "force-step-into",
      when: paused,
      run: () => {
        const t = pausedTarget();
        if (t) void report("Force Step Into failed", call(commands.debugStep(t.s.id, t.thread, "into")));
      },
    },
    {
      id: "debug.smartStepInto",
      title: "Smart Step Into",
      category: "Debug",
      icon: "smart-step-into",
      description: "Choose which call on the current line to step into",
      when: paused,
      run: () => void report("Smart Step Into failed", smartStepInto()),
    },
    {
      id: "debug.showExecutionPoint",
      title: "Show Execution Point",
      category: "Debug",
      icon: "show-execution-point",
      when: paused,
      run: () => {
        const s = activeSession();
        if (s) void showExecutionPoint(s.id);
      },
    },
    {
      id: "debug.resetFrame",
      title: "Reset Frame",
      category: "Debug",
      icon: "reset-frame",
      keywords: ["drop frame", "pop frame", "restart frame"],
      description: "Return to the start of the selected frame's method",
      when: paused,
      run: () => {
        const t = pausedTarget();
        const frame = t && selectedFrame(t.s);
        if (!t || !frame) return;
        if (!sessionSupports("restartFrame", t.s)) {
          notSupported("Reset Frame", t.s);
          return;
        }
        void report("Reset Frame failed", call(commands.debugRestartFrame(t.s.id, frame.id)));
      },
    },
    {
      id: "debug.setValue",
      title: "Set Value…",
      category: "Debug",
      icon: "edit",
      keyWhen: "debugVariablesFocus",
      when: paused,
      run: () => focusedDebugView()?.setValue?.(),
    },
    {
      id: "debug.jumpToSource",
      title: "Jump to Source",
      category: "Debug",
      keyWhen: "debugFramesFocus || debugVariablesFocus",
      when: paused,
      run: () => {
        const view = focusedDebugView();
        if (view?.jumpToSource) {
          view.jumpToSource();
          return;
        }
        const s = activeSession();
        const frame = s && selectedFrame(s);
        if (frame) void revealFrame(frame, true);
      },
    },
    {
      id: "debug.attachToProcess",
      title: "Attach to Process…",
      category: "Debug",
      icon: "attach-to-process",
      description: "Attach the debugger to a running Java, Node.js, Python, Go or native process",
      run: () => void openAttachPopup(),
    },
    {
      id: "debug.runToCursor",
      title: "Run to Cursor",
      category: "Debug",
      icon: "run-to-cursor",
      when: paused,
      run: () => {
        const t = pausedTarget();
        const c = cursor();
        if (t && c)
          void report("Run to Cursor failed", call(commands.debugRunTo(t.s.id, t.thread, c.path, c.line, false)));
      },
    },
    {
      id: "debug.forceRunToCursor",
      title: "Force Run to Cursor",
      category: "Debug",
      icon: "force-run-to-cursor",
      description: "Run to the caret, ignoring breakpoints on the way",
      when: paused,
      run: () => {
        const t = pausedTarget();
        const c = cursor();
        if (t && c)
          void report("Force Run to Cursor failed", call(commands.debugRunTo(t.s.id, t.thread, c.path, c.line, true)));
      },
    },
    {
      id: "debug.toggleBreakpoint",
      title: "Toggle Line Breakpoint",
      category: "Debug",
      icon: "breakpoint",
      run: () => {
        const c = cursor();
        if (!c) return;
        const exists = useBreakpoints.getState().byFile[c.path]?.some((b) => b.line === c.line);
        const language = activeEditor()?.ctx.language ?? "";
        if (!exists && !canPlaceBreakpoint(language)) {
          notifications().notify({
            level: "info",
            key: "debug.breakpointNotAllowed",
            title: "Breakpoints can't be placed in this file",
            body: "Enable Settings › Build, Execution, Deployment › Debugger › Allow placing breakpoints in any file.",
          });
          return;
        }
        const ed = activeEditor();
        if (ed) toggleBreakpointSmart(c.path, c.line, language, ed.view.state.doc.toString());
        else toggleBreakpoint(c.path, c.line);
      },
    },
    {
      id: "debug.toggleTemporaryBreakpoint",
      title: "Toggle Temporary Line Breakpoint",
      category: "Debug",
      icon: "breakpoint",
      description: "A line breakpoint that is removed after it is hit",
      run: () => {
        const c = cursor();
        if (c && canPlaceBreakpoint(activeEditor()?.ctx.language ?? "")) toggleTemporaryBreakpoint(c.path, c.line);
      },
    },
    {
      id: "debug.toggleMethodBreakpoint",
      title: "Toggle Method Breakpoint",
      category: "Debug",
      icon: "breakpoint-method",
      run: () => {
        const ed = activeEditor();
        const c = cursor();
        if (!ed || !c) return;
        const existing = specialAt(c.path).find((b) => b.kind === "method" && b.line === c.line);
        const method = methodAt(ed.ctx.language, ed.view.state.doc.toString(), c.line);
        if (!existing && !method) {
          notifications().notify({
            level: "info",
            key: "debug.noMethod",
            title: "No method declaration on this line",
            body: "Put the caret on a method declaration, or add a method breakpoint by name in View Breakpoints.",
          });
          return;
        }
        toggleMethodAt(c.path, c.line, method?.name ?? "");
      },
    },
    {
      id: "debug.toggleFieldWatchpoint",
      title: "Toggle Field Watchpoint",
      category: "Debug",
      icon: "breakpoint-field",
      run: () => {
        const ed = activeEditor();
        const c = cursor();
        if (!ed || !c) return;
        const existing = specialAt(c.path).find((b) => b.kind === "field" && b.line === c.line);
        const field = fieldAt(ed.ctx.language, ed.view.state.doc.toString(), c.line);
        if (!existing && !field) {
          notifications().notify({
            level: "info",
            key: "debug.noField",
            title: "No field declaration on this line",
            body: "Field watchpoints can be set on Java field declarations, or from the Variables view while suspended.",
          });
          return;
        }
        toggleFieldAt(c.path, c.line, field ?? { dataId: "", label: "" });
      },
    },
    {
      id: "debug.viewBreakpoints",
      title: "View Breakpoints…",
      category: "Debug",
      icon: "breakpoint",
      run: () => {
        const c = cursor();
        const bp = c ? useBreakpoints.getState().byFile[c.path]?.find((b) => b.line === c.line) : undefined;
        openBreakpointsDialog(c && bp ? { path: c.path, id: bp.id } : undefined);
      },
    },
    {
      id: "debug.muteBreakpoints",
      title: "Mute Breakpoints",
      category: "Debug",
      keywords: ["unmute", "disable all"],
      toggled: () => useBreakpoints.getState().muted,
      run: () => setMuted(!useBreakpoints.getState().muted),
    },
    {
      id: "debug.removeAllBreakpoints",
      title: "Remove All Breakpoints",
      category: "Debug",
      run: () => {
        removeAllBreakpoints();
        removeAllSpecial();
      },
    },
    {
      id: "debug.evaluate",
      title: "Evaluate Expression…",
      category: "Debug",
      when: "debugSessionActive",
      run: () => openEvaluateDialog(evaluateSeed()),
    },
    {
      id: "debug.browseConsoleHistory",
      title: "Browse Console History",
      category: "Debug",
      keywords: ["history", "previous expressions", "repl"],
      when: "debugSessionActive",
      run: () => {
        if (!browseFocusedConsoleHistory()) showStatusInfo(tx("Focus the debug console input first"));
      },
    },
    {
      // ⌥⌘F8: the selection (or expression at the caret) evaluated in a value hint, no dialog.
      id: "debug.quickEvaluate",
      title: "Quick Evaluate Expression",
      category: "Debug",
      when: "debugSessionActive && textEditorActive",
      run: () => quickEvaluate(),
    },
    {
      id: "debug.showToolWindow",
      title: "Show Debug Tool Window",
      category: "Debug",
      hidden: true,
      run: () => toolWindowService().show("debug", true),
    },
  ]);
}
