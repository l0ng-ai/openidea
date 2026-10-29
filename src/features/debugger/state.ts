/**
 * Debug sessions as the UI sees them, fed by `IdeEvent::Debug` and by pulls
 * (threads, frames, locals) after each stop.
 */
import { workflowSettings } from "@/platform/workflowSettings";
import { executeAction } from "@/platform/actions";
import { create } from "zustand";
import { AnsiStream, appendSpans, type Span } from "@/ui/ansi";
import { setContext } from "@/platform/context";
import {
  call,
  commands,
  isTauri,
  type DebugCapabilities,
  type DebugEvent,
  type DebugSessionId,
  type LaunchConfig,
  type RunId,
  type StackFrame,
  type ThreadInfo,
  type Variable,
} from "@/platform/ipc";
import { maybeEditorService, notifications, toolWindowService } from "@/workbench/contributions";
import { breakpointsOf, consumeTemporary, refreshStates, resetStatuses } from "./breakpoints/store";
import { interpolateLog, logParts, suspends } from "./breakpoints/model";
import { syncSpecial, useSpecialBreakpoints } from "./breakpoints/special";
import { refreshExceptionFilters } from "./breakpoints/exceptions";
import { missingAdapter } from "./missingAdapter";

export type SessionStatus = "starting" | "running" | "paused" | "terminated";

export interface DebugSession {
  id: DebugSessionId;
  name: string;
  adapter: string;
  parent: DebugSessionId | null;
  /** Launch configuration (root sessions), used by Rerun. */
  launch: LaunchConfig | null;
  /** Process the session is attached to (a Run tab's build tool); stopped with the session. */
  process: RunId | null;
  status: SessionStatus;
  stoppedThread: number | null;
  stopReason: string | null;
  stopDescription: string | null;
  threads: ThreadInfo[];
  selectedThread: number | null;
  frames: StackFrame[];
  selectedFrame: number | null;
  /** Breakpoint hits in this session. */
  hits: number;
  exitCode: number | null;
  /** What the adapter supports (fetched after start). */
  caps: DebugCapabilities | null;
}

export interface ConsoleLine {
  id: number;
  category: string;
  /** Plain text without escape sequences. */
  text: string;
  /** `text` styled by its ANSI colours. */
  spans: Span[];
}

export interface WatchResult {
  expression: string;
  result: Variable | null;
  error: string | null;
}

interface DebugState {
  sessions: Record<number, DebugSession>;
  /** Session shown in the Debug tool window / title bar. */
  active: DebugSessionId | null;
  console: Record<number, ConsoleLine[]>;
  watches: string[];
  /** Incremented on every stop; views re-pull data when it changes. */
  stopSeq: number;
}

export const useDebug = create<DebugState>(() => ({
  sessions: {},
  active: null,
  console: {},
  watches: [],
  stopSeq: 0,
}));

/** Execution point of the selected frame, plus the frame's locals for inline values. */
interface ExecutionPoint {
  path: string | null;
  line: number;
  /** The selected frame is the top frame (current position, not a caller). */
  top: boolean;
  values: Record<string, string>;
}

export const useExecutionPoint = create<ExecutionPoint>(() => ({ path: null, line: 0, top: true, values: {} }));

const MAX_CONSOLE_LINES = 5000;
let lineSeq = 0;
/** ANSI state per session and output category (a colour can span several output events). */
const ansiStreams = new Map<DebugSessionId, Map<string, AnsiStream>>();

function ansiStream(session: DebugSessionId, category: string): AnsiStream {
  let streams = ansiStreams.get(session);
  if (!streams) ansiStreams.set(session, (streams = new Map()));
  let stream = streams.get(category);
  if (!stream) streams.set(category, (stream = new AnsiStream()));
  return stream;
}

// --- accessors ---------------------------------------------------------------

export function activeSession(): DebugSession | null {
  const { active, sessions } = useDebug.getState();
  return active != null ? (sessions[active] ?? null) : null;
}

export function isLive(s: DebugSession | null | undefined): boolean {
  return !!s && s.status !== "terminated";
}

/** Root (user-started) session of `s`. */
export function rootOf(s: DebugSession): DebugSession {
  const { sessions } = useDebug.getState();
  let cur = s;
  while (cur.parent != null && sessions[cur.parent]) cur = sessions[cur.parent]!;
  return cur;
}

function patch(id: DebugSessionId, p: Partial<DebugSession>) {
  useDebug.setState((s) => {
    const cur = s.sessions[id];
    if (!cur) return s;
    return { sessions: { ...s.sessions, [id]: { ...cur, ...p } } };
  });
  publishContext();
}

function blank(id: DebugSessionId, p: Partial<DebugSession> = {}): DebugSession {
  return {
    id,
    name: "Debug",
    adapter: "",
    parent: null,
    launch: null,
    process: null,
    status: "starting",
    stoppedThread: null,
    stopReason: null,
    stopDescription: null,
    threads: [],
    selectedThread: null,
    frames: [],
    selectedFrame: null,
    hits: 0,
    exitCode: null,
    caps: null,
    ...p,
  };
}

// Sessions this window owns. The backend sends a session's events only to the window
// that started it; as a second line of defence, events of other sessions are dropped.
/** `debugStart` calls in flight: their root session's id is not known yet. */
let pendingStarts = 0;
/** Sessions adopted while a start was in flight, not yet confirmed by its result. */
const provisional = new Set<DebugSessionId>();
/** Every session id this window has owned (late events of dropped sessions are ignored). */
const owned = new Set<DebugSessionId>();

/** Registers a session as owned by this window (idempotent). */
export function adoptSession(id: DebugSessionId, p: Partial<DebugSession> = {}): DebugSession {
  const existing = useDebug.getState().sessions[id];
  if (existing) return existing;
  owned.add(id);
  const s = blank(id, { status: "running", ...p });
  void loadCapabilities(id);
  useDebug.setState((st) => ({
    sessions: { ...st.sessions, [id]: s },
    active: st.active == null || !isLive(st.sessions[st.active]) ? id : st.active,
  }));
  publishContext();
  return s;
}

/**
 * The session an event belongs to, adopting it when it is this window's: a child
 * (announced by `started` with a parent) of one of its sessions, or the root
 * session of a start still in flight here (its build output and `started` arrive
 * before `debugStart` returns the id). Anything else is not ours.
 */
function ownSession(id: DebugSessionId, event: DebugEvent): DebugSession | null {
  const st = useDebug.getState();
  const existing = st.sessions[id];
  if (existing) return existing;
  if (owned.has(id)) return null;
  if (event.kind === "started" && event.parent != null) {
    if (!st.sessions[event.parent]) return null;
    return adoptSession(id, { name: event.name, adapter: event.adapter, parent: event.parent });
  }
  if (pendingStarts === 0) return null;
  provisional.add(id);
  return event.kind === "started" ? adoptSession(id, { name: event.name, adapter: event.adapter }) : adoptSession(id);
}

/** A start finished (`id` on success): sessions no start claimed are failed starts' leftovers. */
function settleStart(id: DebugSessionId | null) {
  pendingStarts = Math.max(0, pendingStarts - 1);
  if (id != null) provisional.delete(id);
  if (pendingStarts > 0) return;
  const leftovers = [...provisional];
  provisional.clear();
  for (const s of leftovers) if (isLive(useDebug.getState().sessions[s])) markTerminated(s);
}

export function publishContext() {
  const s = activeSession();
  const anyLive = Object.values(useDebug.getState().sessions).some(isLive);
  setContext("debugSessionActive", anyLive);
  setContext("debugSessionPaused", s?.status === "paused");
  setContext("debugCanRerun", !!s && !!rootOf(s).launch);
  setContext(
    "debugCanHotSwap",
    Object.values(useDebug.getState().sessions).some((x) => isLive(x) && !!x.caps?.hotCodeReplace),
  );
}

// --- console -----------------------------------------------------------------

export function appendConsole(session: DebugSessionId, category: string, raw: string) {
  if (!raw) return;
  const spans = ansiStream(session, category).parse(raw);
  const text = spans.map((sp) => sp.text).join("");
  if (!text) return;
  useDebug.setState((s) => {
    const prev = s.console[session] ?? [];
    const next = [...prev];
    const last = next[next.length - 1];
    // Merge partial lines of the same category.
    if (last && last.category === category && !last.text.endsWith("\n")) {
      next[next.length - 1] = { ...last, text: last.text + text, spans: appendSpans(last.spans, spans) };
    } else {
      next.push({ id: ++lineSeq, category, text, spans });
    }
    if (next.length > MAX_CONSOLE_LINES) next.splice(0, next.length - MAX_CONSOLE_LINES);
    return { console: { ...s.console, [session]: next } };
  });
}

export function clearConsole(session: DebugSessionId) {
  ansiStreams.delete(session);
  useDebug.setState((s) => ({ console: { ...s.console, [session]: [] } }));
}

// --- lifecycle ---------------------------------------------------------------

export async function startSession(
  launch: LaunchConfig,
  options: {
    /** A process started for this session (e.g. Maven with a JDWP agent): Stop ends it too. */
    process?: RunId | null;
    /** Rerun repeats the launch (false for attaching to a process that is gone afterwards). */
    rerunnable?: boolean;
  } = {},
): Promise<DebugSessionId | null> {
  if (!isTauri()) {
    notifications().notify({ group: "run", level: "warning", title: "Debugging needs the desktop app" });
    return null;
  }
  // Drop finished sessions; keep running ones (multiple concurrent sessions are fine).
  useDebug.setState((s) => {
    const sessions = Object.fromEntries(Object.entries(s.sessions).filter(([, v]) => isLive(v)));
    const consoleLines = Object.fromEntries(Object.entries(s.console).filter(([k]) => sessions[+k]));
    for (const id of ansiStreams.keys()) if (!sessions[id]) ansiStreams.delete(id);
    return { sessions, console: consoleLines, active: s.active != null && sessions[s.active] ? s.active : null };
  });
  try {
    if (workflowSettings().run.showOnStart) toolWindowService().show("debug");
  } catch {
    // Workbench not ready (tests).
  }
  pendingStarts++;
  try {
    const id = await call(commands.debugStart(launch));
    owned.add(id);
    useDebug.setState((s) => {
      const cur = s.sessions[id] ?? blank(id, { status: "running" });
      return {
        sessions: {
          ...s.sessions,
          [id]: {
            ...cur,
            name: launch.name,
            adapter: launch.adapter,
            launch: options.rerunnable === false ? null : launch,
            process: options.process ?? null,
            status: cur.status === "starting" ? "running" : cur.status,
          },
        },
        active: id,
      };
    });
    settleStart(id);
    publishContext();
    void refreshExceptionFilters();
    void loadCapabilities(id);
    // Method breakpoints / watchpoints went out during configuration: pull their states.
    void syncSpecial();
    return id;
  } catch (e) {
    settleStart(null);
    const missing = missingAdapter(launch.adapter, e);
    if (missing) {
      notifications().notify({
        group: "run",
        level: "warning",
        title: missing.title,
        body: missing.body,
        key: "debug.start",
        sticky: true,
        actions: [
          {
            label: "Install and Debug",
            run: () => void executeAction("tools.install", missing.tool).then(() => startSession(launch, options)),
          },
        ],
      });
      return null;
    }
    notifications().notify({
      group: "run",
      level: "error",
      title: `Cannot start debugger for ${launch.name}`,
      body: e instanceof Error ? e.message : String(e),
      key: "debug.start",
    });
    return null;
  }
}

export async function stopSession(id: DebugSessionId) {
  const s = useDebug.getState().sessions[id];
  if (!s) return;
  const root = rootOf(s);
  try {
    await call(commands.debugStop(root.id));
  } catch (e) {
    // Already gone: mark it finished locally.
    console.warn("debugStop failed", e);
    markTerminated(root.id);
  }
  // Detaching leaves an attached JVM running: stop the process it belongs to, like IDEA.
  if (root.process != null) await call(commands.runStop(root.process)).catch(() => undefined);
}

export async function rerunSession(id: DebugSessionId) {
  const s = useDebug.getState().sessions[id];
  if (!s) return;
  const root = rootOf(s);
  const launch = root.launch;
  if (!launch) return;
  if (isLive(root)) await stopSession(root.id);
  await startSession(launch);
}

async function loadCapabilities(id: DebugSessionId) {
  try {
    const caps = await call(commands.debugCapabilities(id));
    if (useDebug.getState().sessions[id]) patch(id, { caps });
  } catch {
    // Session already gone.
  }
}

/** Whether the active session's adapter supports `cap` (false while unknown). */
export function sessionSupports(cap: keyof DebugCapabilities, s: DebugSession | null = activeSession()): boolean {
  return !!s?.caps?.[cap];
}

function markTerminated(id: DebugSessionId) {
  patch(id, { status: "terminated", frames: [], selectedFrame: null, stoppedThread: null });
  const st = useDebug.getState();
  if (st.active === id) {
    // Prefer another live session (e.g. the parent of a finished child).
    const other = Object.values(st.sessions).find(isLive);
    if (other) useDebug.setState({ active: other.id });
  }
  if (!Object.values(useDebug.getState().sessions).some(isLive)) {
    resetStatuses();
    useSpecialBreakpoints.setState({ status: {} });
    if (workflowSettings().debugger.hideOnTermination) {
      try {
        toolWindowService().hide("debug");
      } catch {
        // Workbench not ready (tests).
      }
    }
  }
  updateExecutionPoint();
  publishContext();
}

// --- selection / pulls -------------------------------------------------------

export function selectSession(id: DebugSessionId) {
  useDebug.setState({ active: id });
  publishContext();
  updateExecutionPoint();
}

export async function selectThread(id: DebugSessionId, threadId: number) {
  patch(id, { selectedThread: threadId, frames: [], selectedFrame: null });
  await loadFrames(id, threadId, true);
}

export function selectFrame(id: DebugSessionId, frameId: number, reveal = true) {
  patch(id, { selectedFrame: frameId });
  updateExecutionPoint();
  const s = useDebug.getState().sessions[id];
  const frame = s?.frames.find((f) => f.id === frameId);
  if (reveal && frame?.path) {
    void maybeEditorService()?.openFile(frame.path, {
      selection: { line: frame.line, col: frame.column },
      focus: false,
    });
  }
  void loadLocals(id, frameId);
}

async function loadFrames(id: DebugSessionId, threadId: number, reveal: boolean) {
  let frames: StackFrame[] = [];
  try {
    frames = await call(commands.debugStackTrace(id, threadId));
  } catch (e) {
    console.warn("stackTrace failed", e);
  }
  const s = useDebug.getState().sessions[id];
  if (!s || s.status !== "paused" || s.selectedThread !== threadId) return;
  patch(id, { frames });
  const top = frames.find((f) => f.path && f.presentationHint !== "label") ?? frames[0];
  if (top?.path && (s.stopReason === "breakpoint" || s.stopReason === "function breakpoint")) {
    void logSuspendingHit(id, top);
    consumeTemporary(top.path, top.line);
  }
  if (top) selectFrame(id, top.id, reveal);
  else updateExecutionPoint();
}

/**
 * A suspending breakpoint that also logs: DAP logpoints never suspend, so the
 * message is evaluated in the stopped frame and printed here instead.
 */
async function logSuspendingHit(id: DebugSessionId, frame: StackFrame) {
  const bp = breakpointsOf(frame.path!).find((b) => b.line === frame.line && b.enabled);
  if (!bp || !suspends(bp)) return;
  for (const part of logParts(bp, frame.path!)) {
    const text = await interpolateLog(part, async (expr) => {
      const v = await call(commands.debugEvaluateIn(id, frame.id, expr, "repl"));
      return v.value;
    });
    appendConsole(id, "console", `${text}\n`);
  }
}

async function loadThreads(id: DebugSessionId) {
  try {
    const threads = await call(commands.debugThreads(id));
    patch(id, { threads });
  } catch (e) {
    console.warn("threads failed", e);
  }
}

/** Locals of `frameId` (first non-expensive scope) for inline values. */
async function loadLocals(id: DebugSessionId, frameId: number) {
  const values: Record<string, string> = {};
  try {
    const scopes = await call(commands.debugScopes(id, frameId));
    const scope = scopes.find((sc) => !sc.expensive);
    if (scope) {
      const vars = await call(commands.debugVariables(id, scope.variablesReference));
      for (const v of vars) if (v.name && !(v.name in values)) values[v.name] = v.value;
    }
  } catch {
    // No inline values.
  }
  const s = useDebug.getState().sessions[id];
  if (useDebug.getState().active !== id || s?.selectedFrame !== frameId) return;
  useExecutionPoint.setState({ values });
}

/** Show Execution Point (⌥F10): back to the suspended thread's top frame, revealed and focused. */
export async function showExecutionPoint(id: DebugSessionId) {
  const s = useDebug.getState().sessions[id];
  if (!s || s.status !== "paused" || s.stoppedThread == null) return;
  if (s.selectedThread !== s.stoppedThread) {
    patch(id, { selectedThread: s.stoppedThread, frames: [], selectedFrame: null });
    await loadFrames(id, s.stoppedThread, false);
  }
  const cur = useDebug.getState().sessions[id];
  const top = cur?.frames.find((f) => f.path && f.presentationHint !== "label");
  if (!cur || !top) return;
  selectFrame(id, top.id, false);
  await revealFrame(top, true);
}

/** Opens a frame's source at its line (Jump to Source, F4). */
export async function revealFrame(frame: StackFrame, focus: boolean) {
  if (!frame.path) return;
  await maybeEditorService()?.openFile(frame.path, { selection: { line: frame.line, col: frame.column }, focus });
}

export function updateExecutionPoint() {
  const s = activeSession();
  const frame = s && s.status === "paused" ? s.frames.find((f) => f.id === s.selectedFrame) : undefined;
  if (!s || !frame || !frame.path) {
    if (useExecutionPoint.getState().path !== null) useExecutionPoint.setState({ path: null, values: {} });
    return;
  }
  const top = s.frames.find((f) => f.path && f.presentationHint !== "label")?.id === frame.id;
  const cur = useExecutionPoint.getState();
  if (cur.path === frame.path && cur.line === frame.line && cur.top === top) return;
  useExecutionPoint.setState({ path: frame.path, line: frame.line, top, values: {} });
}

// --- watches -------------------------------------------------------------------

export function addWatch(expression: string) {
  const e = expression.trim();
  if (!e) return;
  useDebug.setState((s) => (s.watches.includes(e) ? s : { watches: [...s.watches, e] }));
  persistWatches();
}

export function removeWatch(expression: string) {
  useDebug.setState((s) => ({ watches: s.watches.filter((w) => w !== expression) }));
  persistWatches();
}

const WATCH_KEY = "openidea.debugger.watches";

function persistWatches() {
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(useDebug.getState().watches));
  } catch {
    // ignore
  }
}

export function loadWatches() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCH_KEY) ?? "[]") as unknown;
    if (Array.isArray(raw)) useDebug.setState({ watches: raw.filter((w): w is string => typeof w === "string") });
  } catch {
    // ignore
  }
}

/**
 * "Set Value" (F2 in the variables tree): `setVariable` in `container`, or
 * `setExpression` on the evaluate name. Refreshes variables, watches and inline values.
 */
export async function setVariableValue(
  target: { container: number; name: string; evaluateName: string | null },
  value: string,
  session: DebugSession | null = activeSession(),
): Promise<Variable> {
  if (!session || session.status !== "paused") throw new Error("The debugger is not suspended");
  const result = await call(
    commands.debugSetVariable(
      session.id,
      target.container,
      target.name,
      target.evaluateName,
      session.selectedFrame,
      value,
    ),
  );
  useDebug.setState((st) => ({ stopSeq: st.stopSeq + 1 }));
  if (session.selectedFrame != null) void loadLocals(session.id, session.selectedFrame);
  return result;
}

export async function evaluate(
  expression: string,
  context: "repl" | "watch" | "hover" | "clipboard",
  session: DebugSession | null = activeSession(),
): Promise<Variable> {
  if (!session || !isLive(session)) throw new Error("No active debug session");
  return call(commands.debugEvaluateIn(session.id, session.selectedFrame, expression, context));
}

/** Settings › Debugger › Focus application on breakpoint. */
function focusAppWindow() {
  if (!isTauri()) return;
  void import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      if (await w.isMinimized()) await w.unminimize();
      await w.setFocus();
    })
    .catch(() => undefined);
}

// --- events ----------------------------------------------------------------------

export function handleDebugEvent(id: DebugSessionId, event: DebugEvent) {
  const s = ownSession(id, event);
  if (!s) return;
  switch (event.kind) {
    case "started":
      if (!s.launch) patch(id, { name: event.name, adapter: event.adapter, parent: event.parent });
      break;
    case "initialized":
      if (s.status === "starting") patch(id, { status: "running" });
      break;
    case "stopped": {
      const isBp = event.reason === "breakpoint" || event.reason === "function breakpoint";
      patch(id, {
        status: "paused",
        stoppedThread: event.threadId,
        selectedThread: event.threadId,
        stopReason: event.reason,
        stopDescription: event.description,
        frames: [],
        selectedFrame: null,
        hits: s.hits + (isBp ? 1 : 0),
      });
      useDebug.setState((st) => ({ active: id, stopSeq: st.stopSeq + 1 }));
      publishContext();
      void loadThreads(id);
      void loadFrames(id, event.threadId, true);
      const dbg = workflowSettings().debugger;
      try {
        if (dbg.showOnBreakpoint) toolWindowService().show("debug");
      } catch {
        // ignore
      }
      if (dbg.focusAppOnBreakpoint) focusAppWindow();
      break;
    }
    case "continued": {
      const cur = useDebug.getState().sessions[id]!;
      if (cur.status === "terminated") break;
      patch(id, {
        status: "running",
        frames: [],
        selectedFrame: null,
        stoppedThread: null,
      });
      updateExecutionPoint();
      break;
    }
    case "output":
      appendConsole(id, event.category, event.output);
      break;
    case "thread":
      if (s.status === "paused") void loadThreads(id);
      break;
    case "breakpointsChanged":
      void refreshStates(event.path);
      break;
    case "exited":
      patch(id, { exitCode: event.code });
      appendConsole(id, "system", `\nProcess finished with exit code ${event.code}\n`);
      break;
    case "terminated":
      markTerminated(id);
      break;
  }
}

/** The window switched projects: stops its sessions and forgets them (late events stay ignored via `owned`). */
export function resetSessions() {
  const { sessions } = useDebug.getState();
  for (const s of Object.values(sessions)) if (s.parent == null && isLive(s)) void stopSession(s.id);
  ansiStreams.clear();
  useDebug.setState({ sessions: {}, active: null, console: {}, stopSeq: 0 });
  useExecutionPoint.setState({ path: null, line: 0, top: true, values: {} });
  publishContext();
}

/** Breakpoint ↔ session glue: unverified look only makes sense while debugging. */
export function sessionsRunning(): boolean {
  return Object.values(useDebug.getState().sessions).some(isLive);
}
