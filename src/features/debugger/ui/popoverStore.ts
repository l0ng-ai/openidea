/** Open/close state of the debugger's overlays (rendered by `Overlays.tsx`). */
import { create } from "zustand";
import type { AttachableProcess, DebugSessionId, RunConfig, StepInTarget, StreamChainInfo } from "@/platform/ipc";

/** A Smart Step Into target placed on the paused line (UTF-16 offsets within the line). */
export interface InlineStepTarget {
  id: number;
  from: number;
  to: number;
}

interface OverlayState {
  popover: { path: string; id: string; x: number; y: number; focusLog: boolean } | null;
  evaluate: { expression: string } | null;
  breakpoints: { path?: string; id?: string } | null;
  chooser: { configs: RunConfig[] } | null;
  /** Attach to Process popup; `processes` is null while loading. */
  attach: {
    processes: AttachableProcess[] | null;
    error: string | null;
    mode?: "all" | "unity";
    projectRoot?: string | null;
    installTool?: string;
    runConfig?: RunConfig;
  } | null;
  /**
   * Smart Step Into: picked in the editor when `inline` is set (targets sorted
   * by position, `index` the selected one), else in the chooser dialog.
   */
  smartStep: {
    session: DebugSessionId;
    thread: number;
    targets: StepInTarget[];
    inline?: { path: string; line: number; ranges: InlineStepTarget[]; index: number };
  } | null;
  /**
   * Trace Stream Chain: the chains on the paused line, unavailable ones listed with their reason.
   * `frame` is the frame they were found in; chain indexes mean nothing for another one.
   */
  streamChooser: { session: DebugSessionId; frame: number; chains: StreamChainInfo[] } | null;
  /** The session whose stream trace "Abort Operation…" asks about. */
  streamAbort: DebugSessionId | null;
  /** View as Table; it stays open across steps, so it lives here rather than in the Variables view. */
  tableView: { expression: string; session: DebugSessionId } | null;
}

export const useOverlays = create<OverlayState>(() => ({
  popover: null,
  evaluate: null,
  breakpoints: null,
  chooser: null,
  attach: null,
  smartStep: null,
  streamChooser: null,
  streamAbort: null,
  tableView: null,
}));

export function openBreakpointPopover(path: string, id: string, at: { x: number; y: number }, focusLog = false) {
  useOverlays.setState({ popover: { path, id, x: at.x, y: at.y, focusLog } });
}

export function closeBreakpointPopover() {
  useOverlays.setState({ popover: null });
}

export function openTableView(expression: string, session: DebugSessionId) {
  useOverlays.setState({ tableView: { expression, session } });
}

export function openEvaluateDialog(expression = "") {
  useOverlays.setState({ evaluate: { expression } });
}

export function openBreakpointsDialog(select?: { path: string; id: string }) {
  useOverlays.setState({ breakpoints: select ?? {} });
}

export function openConfigChooser(configs: RunConfig[]) {
  useOverlays.setState({ chooser: { configs } });
}

export function openSmartStepChooser(session: DebugSessionId, thread: number, targets: StepInTarget[]) {
  useOverlays.setState({ smartStep: { session, thread, targets } });
}

export function openStreamChainChooser(session: DebugSessionId, frame: number, chains: StreamChainInfo[]) {
  useOverlays.setState({ streamChooser: { session, frame, chains } });
}
