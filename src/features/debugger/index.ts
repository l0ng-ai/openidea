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
  registerMenuGroup,
  registerOverlay,
  registerRunConfigType,
  registerToolWindow,
  useDebugRunSessions,
} from "@/workbench/contributions";
import { registerDebugActions } from "./actions";
import { loadBreakpoints } from "./breakpoints/store";
import { loadExceptionBreakpoints } from "./breakpoints/exceptions";
import { loadSpecialBreakpoints } from "./breakpoints/special";
import { breakpointGutter } from "./editor/breakpointGutter";
import { executionPoint } from "./editor/execution";
import { runToCursorInlay } from "./editor/runToCursor";
import { installSmartStepPicking, smartStepTargets } from "./editor/smartStep";
import { hotSwapMenuItems, onHotCodeReplace } from "./hotswap";
import {
  activeSession,
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
import { forgetMemory } from "./memory/memoryState";

/** Whether a breakpoint popover, debugger dialog or chooser is open. */
const useAnyOverlay = () =>
  useOverlays((s) => !!(s.popover || s.evaluate || s.breakpoints || s.chooser || s.attach || s.smartStep));

export function activate(): () => void {
  useDebugRunSessions.setState({
    Console: lazyComponent(() => import("./ui/DebugConsole").then((m) => m.DebugServiceConsole)),
  });
  loadWatches();
  publishContext();
  loadBreakpoints(useProject.getState().project?.root ?? null);
  loadExceptionBreakpoints(useProject.getState().project?.root ?? null);
  loadSpecialBreakpoints(useProject.getState().project?.root ?? null);
  const disposers = [
    () => useDebugRunSessions.setState({ sessions: [], serviceSessions: [], Console: null }),
    registerDebugActions(),
    // Remote JVM Debug, Go Remote, …: Run/Debug Configurations › Add New Configuration.
    ...REMOTE_TYPES.map(registerRunConfigType),
    registerToolWindow({
      id: "debug",
      title: "Debug",
      icon: "toolwindow-debug",
      anchor: "bottom",
      stripe: "onUse",
      order: 20,
      component: lazyComponent(() => import("./ui/DebugToolWindow").then((m) => m.DebugToolWindow)),
      headerContent: lazyComponent(() => import("./ui/DebugToolWindow").then((m) => m.DebugTabs)),
    }),
    registerOverlay({
      id: "debugger",
      component: lazyWhen(useAnyOverlay, () => import("./ui/Overlays").then((m) => m.DebuggerOverlays)),
    }),
    registerMenuGroup({
      id: "debugger.evaluate",
      menus: ["editor"],
      items: () => (activeSession()?.status === "paused" ? [{ kind: "action", action: "debug.evaluate" }] : []),
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
      ],
    }),
    installSmartStepPicking(),
    onIdeEvent("debug", (e) => {
      if (e.event.kind === "hotCodeReplace") onHotCodeReplace(e.session, e.event);
      else handleDebugEvent(e.session, e.event);
    }),
    useDebug.subscribe((s, prev) => {
      if (s.sessions === prev.sessions) return;
      for (const id of Object.keys(prev.sessions)) if (!(id in s.sessions)) forgetMemory(Number(id));
    }),
    useProject.subscribe((s, prev) => {
      const root = s.project?.root ?? null;
      if (root !== (prev.project?.root ?? null) || s.project?.trusted !== prev.project?.trusted) {
        resetSessions();
        loadBreakpoints(root);
        loadExceptionBreakpoints(root);
        loadSpecialBreakpoints(root);
      }
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
