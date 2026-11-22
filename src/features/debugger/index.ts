/**
 * Debugger: breakpoints (editor gutter + per-project store synced to the
 * backend), DAP sessions driven by `IdeEvent::Debug`, the Debug tool window,
 * execution point + inline values, Evaluate / View Breakpoints dialogs.
 */
import { lazyComponent, lazyWhen } from "@/ui";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { selectionValueTooltip, valueTooltip } from "./editor/valueTooltip";
import { quickEvaluateMouse } from "./editor/quickEvaluate";
import { registerEditorContribution } from "@/editor/api";
import {
  registerEditorKind,
  registerMenuGroup,
  registerOverlay,
  registerRunConfigType,
  registerToolWindow,
  useDebugRunSessions,
} from "@/workbench/contributions";
import { registerDebugActions } from "./actions";
import { registerDevToolsWindows } from "./flutter/devTools";
import { registerDebugTabActions } from "./tabActions";
import { loadBreakpoints } from "./breakpoints/store";
import { loadExceptionBreakpoints } from "./breakpoints/exceptions";
import { loadExceptionClasses } from "./breakpoints/exceptionClasses";
import { loadJsBreakpoints, watchPageSessions } from "./js/eventBreakpoints";
import { watchNetworkSessions } from "./js/networkSessions";
import { loadResponseOverrides, watchOverrideSessions } from "./js/responseOverrides";
import { watchProfiledSessions } from "./js/profile";
import { loadSpecialBreakpoints } from "./breakpoints/special";
import { breakpointGutter } from "./editor/breakpointGutter";
import { executionPoint } from "./editor/execution";
import { runToCursorInlay } from "./editor/runToCursor";
import { installSmartStepPicking, smartStepTargets } from "./editor/smartStep";
import { exceptionBreakpointIntention } from "./editor/exceptionBreakpointIntention";
import { hotSwapMenuItems, onHotCodeReplace } from "./hotswap";
import { installFlutterHotReloadOnSave } from "./flutterReload";
import {
  activeSession,
  canTraceStream,
  handleDebugEvent,
  isLive,
  loadWatches,
  publishContext,
  resetSessions,
  stopSession,
  useDebug,
} from "./state";
import { useOverlays } from "./ui/popoverStore";
import { REMOTE_TYPES } from "./remote";
import { jsBrowserType } from "./browser";
import { forgetInstances } from "./memory/instancesState";
import { forgetHeapCapture, forgetHeapOnProjectChange } from "./heap/heapState";
import { heapEditorKind } from "./heap/heapEditorKind";
import { streamTraceKind } from "./streams/streamTraceKind";
import { installHeapContext } from "./heap/heapDumpFiles";
import { forgetMemory } from "./memory/memoryState";
import { closeStaleStreamChooser, forgetStreamTrace } from "./streams/streamState";

/** Whether a breakpoint popover, debugger dialog or chooser is open. */
const useAnyOverlay = () =>
  useOverlays(
    (s) =>
      !!(
        s.popover ||
        s.evaluate ||
        s.breakpoints ||
        s.chooser ||
        s.attach ||
        s.smartStep ||
        s.streamChooser ||
        s.streamAbort != null ||
        s.tableView
      ),
  );

/** The Debug stripe button's badge, like Run's: how many debug sessions (child sessions aside) are live. */
function useLiveSessionCount(): number | null {
  return useDebug((s) => Object.values(s.sessions).filter((x) => x.parent === null && isLive(x)).length || null);
}

export function activate(): () => void {
  useDebugRunSessions.setState({
    Console: lazyComponent(() => import("./ui/DebugConsole").then((m) => m.DebugServiceConsole)),
    View: lazyComponent(() => import("./ui/DebugToolWindow").then((m) => m.DebugServiceView)),
  });
  loadWatches(useProject.getState().project?.root ?? null);
  publishContext();
  loadBreakpoints(useProject.getState().project?.root ?? null);
  loadExceptionBreakpoints(useProject.getState().project?.root ?? null);
  loadExceptionClasses(useProject.getState().project?.root ?? null);
  loadSpecialBreakpoints(useProject.getState().project?.root ?? null);
  loadJsBreakpoints(useProject.getState().project?.root ?? null);
  loadResponseOverrides(useProject.getState().project?.root ?? null);
  const disposers = [
    () => useDebugRunSessions.setState({ sessions: [], serviceSessions: [], Console: null, View: null }),
    registerDebugActions(),
    registerDebugTabActions(),
    registerDevToolsWindows(),
    // Remote JVM Debug, Go Remote, …: Run/Debug Configurations › Add New Configuration.
    ...REMOTE_TYPES.map(registerRunConfigType),
    registerRunConfigType(jsBrowserType),
    registerToolWindow({
      id: "debug",
      title: "Debug",
      icon: "toolwindow-debug",
      anchor: "bottom",
      stripe: "onUse",
      sessionContent: true,
      order: 20,
      component: lazyComponent(() => import("./ui/DebugToolWindow").then((m) => m.DebugToolWindow)),
      headerContent: lazyComponent(() => import("./ui/DebugToolWindow").then((m) => m.DebugTabs)),
      useBadge: useLiveSessionCount,
    }),
    registerEditorKind(heapEditorKind),
    registerEditorKind(streamTraceKind),
    installHeapContext(),
    forgetHeapOnProjectChange(),
    registerOverlay({
      id: "debugger",
      component: lazyWhen(useAnyOverlay, () => import("./ui/Overlays").then((m) => m.DebuggerOverlays)),
    }),
    registerMenuGroup({
      id: "debugger.evaluate",
      menus: ["editor"],
      items: () => {
        const s = activeSession();
        if (s?.status !== "paused") return [];
        return [
          { kind: "action", action: "debug.evaluate" },
          ...(canTraceStream(s) ? [{ kind: "action" as const, action: "debug.traceStreamChain" }] : []),
        ];
      },
    }),
    registerMenuGroup({
      id: "debugger.hotswap",
      menus: ["editor"],
      items: (_menu, { paths }) => hotSwapMenuItems(paths),
    }),
    // Stop (⌘F2) offers the running debug sessions beside run processes.
    registerMenuGroup({
      id: "debugger.stop",
      menus: ["stopProcess"],
      items: () =>
        Object.values(useDebug.getState().sessions)
          .filter((s) => s.parent == null && isLive(s))
          .map((s) => ({ label: s.name, verbatim: true, icon: "debug", run: () => void stopSession(s.id) })),
    }),
    registerEditorContribution({
      id: "debugger",
      order: 60,
      extensions: (ctx) => [
        breakpointGutter(ctx),
        executionPoint(ctx),
        runToCursorInlay(ctx),
        valueTooltip(),
        selectionValueTooltip(),
        quickEvaluateMouse(),
        smartStepTargets(ctx),
        exceptionBreakpointIntention(ctx),
      ],
    }),
    installSmartStepPicking(),
    installFlutterHotReloadOnSave(),
    onIdeEvent("debug", (e) => {
      if (e.event.kind === "hotCodeReplace") onHotCodeReplace(e.session, e.event);
      else handleDebugEvent(e.session, e.event);
    }),
    useDebug.subscribe((s, prev) => {
      if (s.sessions === prev.sessions) return;
      closeStaleStreamChooser();
      for (const id of Object.keys(prev.sessions)) {
        if (id in s.sessions) continue;
        forgetMemory(Number(id));
        forgetInstances(Number(id));
        forgetHeapCapture(Number(id));
        forgetStreamTrace(Number(id));
      }
    }),
    useProject.subscribe((s, prev) => {
      const root = s.project?.root ?? null;
      if (root !== (prev.project?.root ?? null) || s.project?.trusted !== prev.project?.trusted) {
        useOverlays.setState({ attach: null });
        resetSessions();
        loadWatches(root);
        loadBreakpoints(root);
        loadExceptionBreakpoints(root);
        loadExceptionClasses(root);
        loadSpecialBreakpoints(root);
        loadJsBreakpoints(root);
        loadResponseOverrides(root);
      }
    }),
    watchPageSessions(),
    watchNetworkSessions(),
    watchOverrideSessions(),
    watchProfiledSessions(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
