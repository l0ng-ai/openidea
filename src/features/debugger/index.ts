/**
 * Debugger: breakpoints (editor gutter + per-project store synced to the
 * backend), DAP sessions driven by `IdeEvent::Debug`, the Debug tool window,
 * execution point + inline values, Evaluate / View Breakpoints dialogs.
 */
import { lazyComponent } from "@/ui";
import { onIdeEvent } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { selectionValueTooltip, valueTooltip } from "./editor/valueTooltip";
import { registerEditorContribution } from "@/editor/api";
import {
  registerMenuGroup,
  registerOverlay,
  registerRunConfigType,
  registerToolWindow,
} from "@/workbench/contributions";
import { registerDebugActions } from "./actions";
import { loadBreakpoints } from "./breakpoints/store";
import { loadExceptionBreakpoints } from "./breakpoints/exceptions";
import { loadSpecialBreakpoints } from "./breakpoints/special";
import { breakpointGutter } from "./editor/breakpointGutter";
import { executionPoint } from "./editor/execution";
import { runToCursorInlay } from "./editor/runToCursor";
import { installSmartStepPicking, smartStepTargets } from "./editor/smartStep";
import { onHotCodeReplace } from "./hotswap";
import { handleDebugEvent, isLive, loadWatches, publishContext, resetSessions, stopSession, useDebug } from "./state";
import { DebuggerOverlays } from "./ui/Overlays";
import { REMOTE_TYPES } from "./remote";

export function activate(): () => void {
  loadWatches();
  publishContext();
  loadBreakpoints(useProject.getState().project?.root ?? null);
  loadExceptionBreakpoints(useProject.getState().project?.root ?? null);
  loadSpecialBreakpoints(useProject.getState().project?.root ?? null);
  const disposers = [
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
    registerOverlay({ id: "debugger", component: DebuggerOverlays }),
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
        smartStepTargets(ctx),
      ],
    }),
    installSmartStepPicking(),
    onIdeEvent("debug", (e) => {
      if (e.event.kind === "hotCodeReplace") onHotCodeReplace(e.session, e.event);
      else handleDebugEvent(e.session, e.event);
    }),
    useProject.subscribe((s, prev) => {
      const root = s.project?.root ?? null;
      if (root !== (prev.project?.root ?? null)) {
        resetSessions();
        loadBreakpoints(root);
        loadExceptionBreakpoints(root);
        loadSpecialBreakpoints(root);
      }
    }),
  ];
  return () => disposers.reverse().forEach((d) => d());
}
