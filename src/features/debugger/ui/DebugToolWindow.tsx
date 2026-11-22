/** Debug tool window: toolbar, Threads & Variables (frames + variables), Console. */
import { writeClipboardText } from "@/platform/clipboard";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { editorPrefs } from "@/platform/editorSettings";
import { monoFontFamily } from "@/platform/fonts";
import { isImeKey } from "@/platform/ime";
import { formatBinding, hostBinding } from "@/platform/keymap";
import { basename, useProject } from "@/platform/project";
import { call, commands, isTauri, type Scope, type Variable } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  Kbd,
  Menu,
  MenuList,
  Popup,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  Toolbar,
  showContextMenu,
  type MenuItem,
  type TabItem,
  T,
} from "@/ui";
import type { SelectOption } from "@/ui/Select";
import { revealVertically } from "@/ui/Tabs";
import { setMuted, useBreakpoints } from "../breakpoints/store";
import { frameLabel, groupFrames } from "../frames";
import { blurDebugView, focusDebugView } from "./focusedView";
import { useActionEnabled } from "./useActionEnabled";
import {
  addWatch,
  closeSessionTab,
  evaluate,
  isLive,
  isThreadSuspended,
  selectFrame,
  selectSession,
  selectThread,
  revealFrame,
  rootOf,
  sessionSupports,
  useDebug,
  type DebugSession,
} from "../state";
import { remoteWaitingNote } from "../remote";
import { sessionTabs } from "./sessionTabs";
import { debugTabMenu } from "../tabActions";
import { stopNote } from "../js/eventBreakpoints";
import { NetworkView } from "../js/NetworkView";
import { liveWatchesApply, useLiveWatches } from "../js/liveWatches";
import { pageProfileItems, useJsProfile } from "../js/profile";
import { MemoryView } from "../memory/MemoryView";
import { DebugConsole } from "./DebugConsole";
import { VariablesView, type VarRoot } from "./VariablesView";
import { useExpressionCompletion } from "./ExpressionCompletion";
import { pushHistory, readHistory } from "./expressionHistory";
import { sortVariables } from "../values";
import { workflowSettings } from "@/platform/workflowSettings";
import { useToolWindowShown } from "@/workbench/contributions";
import { useToolWindowLayout } from "@/workbench/toolwindows/store";
import styles from "./DebugToolWindow.module.css";
import { tx, useTx } from "@/platform/i18n";

function ToolButton({ action, icon, tone }: { action: string; icon: string; tone?: "danger" }) {
  const enabled = useActionEnabled(action);
  return (
    <IconButton
      icon={icon}
      action={action}
      size="small"
      iconSize={16}
      disabled={!enabled}
      tone={tone}
      className={styles.tool}
    />
  );
}

/** IDEA's `XDebugger.ToolWindow.TopToolbar3.Extra` ("More" in the debugger toolbar). */
const MORE_ITEMS: MenuItem[] = [
  { kind: "action", action: "debug.forceStepOver", icon: "force-step-over" },
  { kind: "action", action: "debug.forceStepInto", icon: "force-step-into" },
  { kind: "action", action: "debug.smartStepInto", icon: "smart-step-into" },
  { kind: "separator" },
  { kind: "action", action: "debug.runToCursor", icon: "run-to-cursor" },
  { kind: "action", action: "debug.forceRunToCursor", icon: "force-run-to-cursor" },
  { kind: "separator" },
  { kind: "action", action: "debug.showExecutionPoint", icon: "show-execution-point" },
  { kind: "separator" },
  { kind: "action", action: "debug.evaluate", icon: "evaluate-expression" },
  { kind: "action", action: "debug.resetFrame", icon: "reset-frame" },
];

function MoreActions() {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const page = useDebug((s) => {
    const a = s.active == null ? undefined : s.sessions[s.active];
    return a && isLive(a) && a.caps?.jsPage ? a.id : null;
  });
  const recording = useJsProfile((s) => page != null && !!s.recording[page]);
  const items = useMemo(() => [...MORE_ITEMS, ...pageProfileItems(page != null, recording)], [page, recording]);
  return (
    <>
      <IconButton
        ref={ref}
        icon="more"
        title="More"
        size="small"
        iconSize={16}
        className={styles.tool}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      />
      <Menu open={open} anchor={ref} items={items} placement="bottom-start" onClose={() => setOpen(false)} />
    </>
  );
}

type Tab = "variables" | "console" | "memory" | "network";

/** The view the user last picked; the tool window opens on it again (Console until one is picked). */
let chosenTab: Tab = "console";

/** Threads & Variables › Focus On Breakpoint: whether a breakpoint hit selects that tab. */
async function setVariablesOnBreakpoint(on: boolean) {
  if (!isTauri()) return;
  useProject.setState({
    settings: await call(commands.settingsSet("global", "debugger.variablesOnBreakpoint", JSON.stringify(on))),
  });
}

function statusText(s: DebugSession): string {
  if (s.status === "terminated") return s.exitCode != null ? `Finished · exit code ${s.exitCode}` : "Finished";
  if (s.status === "starting") return "Starting…";
  return s.status === "paused" ? "Suspended" : "Running";
}

/** Tool window header: one tab per debug session (`main ×`), like IDEA's content tabs. */
export function DebugTabs() {
  const sessions = useDebug((s) => s.sessions);
  const active = useDebug((s) => s.active);
  const list = Object.values(sessions);
  if (!list.length) return null;
  const tabs = sessionTabs(list);
  const ownerOf = (id: string) => tabs.find((t) => t.session.id === +id)?.owner ?? +id;
  const items: TabItem[] = tabs.map(({ session: s, child, owner }) => ({
    id: String(s.id),
    label: child ? tx`${s.name} (child)` : s.name,
    text: s.name,
    icon: "debug",
    italic: s.status === "terminated",
    closable: true,
    pinned: !child && !!sessions[owner]?.pinned,
    tooltip: statusText(s),
  }));
  // A browser launch's own session has no tab: its page's tab stands for it.
  const shown = tabs.find((t) => t.session.id === active) ?? tabs.find((t) => t.owner === active);
  return (
    <Tabs
      variant="compact"
      className={styles.sessionTabs}
      aria-label="Debug sessions"
      items={items}
      activeId={shown ? String(shown.session.id) : null}
      onSelect={(id) => selectSession(+id)}
      onClose={(id) => void closeSessionTab(ownerOf(id))}
      onTogglePin={(id) => void executeAction("debug.pinTab", ownerOf(id))}
      onContextMenu={(id, e) => {
        e.preventDefault();
        showContextMenu(e, debugTabMenu(ownerOf(id)), { owner: e.currentTarget });
      }}
      panelIdPrefix="openidea-debug"
    />
  );
}

/**
 * Services › a configuration being debugged: the same debugger as the Debug tool window, for
 * that session (#4773). `console` replaces the Console tab, e.g. with the console of the run the
 * debugger is attached to.
 */
export function DebugServiceView({ sessionId, console: consolePane }: { sessionId: number; console?: ReactNode }) {
  const shown = useDebug((s) => {
    const active = s.active != null ? s.sessions[s.active] : undefined;
    return !!active && rootOf(active).id === sessionId;
  });
  useEffect(() => {
    if (useDebug.getState().sessions[sessionId]) selectSession(sessionId);
  }, [sessionId]);
  // The toolbar acts on the active session: using this view makes its session the active one again.
  const reselect = () => {
    if (!shown && useDebug.getState().sessions[sessionId]) selectSession(sessionId);
  };
  return (
    <div className={styles.serviceView} onPointerDownCapture={reselect} onFocusCapture={reselect}>
      {shown && <DebugView consolePane={consolePane} />}
    </div>
  );
}

export function DebugToolWindow() {
  const sideDocked = useToolWindowLayout((s) => (s.placements.debug?.anchor ?? "bottom") !== "bottom");
  return <DebugView sideDocked={sideDocked} />;
}

function DebugView({ consolePane, sideDocked = false }: { consolePane?: ReactNode; sideDocked?: boolean }) {
  const tx = useTx();
  const active = useDebug((s) => (s.active != null ? s.sessions[s.active] : undefined));
  const muted = useBreakpoints((s) => s.muted);
  const [view, setView] = useState<{
    session: number | undefined;
    status: DebugSession["status"] | undefined;
    tab: Tab;
  }>({ session: undefined, status: undefined, tab: chosenTab });
  if (active && (view.session !== active.startedAt || view.status !== active.status))
    setView({
      session: active.startedAt,
      status: active.status,
      // A breakpoint or exception brings Threads & Variables to the front unless its Focus On Breakpoint
      // is off; finishing a step keeps the tab the user is on (e.g. Console, to watch the output while
      // stepping), and so does Memory.
      tab:
        active.status === "starting"
          ? "console"
          : active.status === "paused" &&
              view.tab !== "memory" &&
              active.stopReason !== "step" &&
              workflowSettings().debugger.variablesOnBreakpoint
            ? "variables"
            : view.tab,
    });
  // A JVM session shows the Memory tab from the start, before the debugger has reported what it supports.
  const memoryPending = !!active && !active.caps && JVM_ADAPTERS.has(rootOf(active).adapter);
  const hasMemory = !!active && (sessionSupports("jvmMemory", active) || memoryPending);
  const hasNetwork = !!active && sessionSupports("jsPage", active);
  // The selected session may be one without the Memory or the Network tab.
  const tab: Tab =
    (view.tab === "memory" && !hasMemory) || (view.tab === "network" && !hasNetwork) ? "variables" : view.tab;

  if (!active) {
    return (
      <div className={styles.emptyWrap}>
        <EmptyState title="Not debugging">
          <T>Start a debug configuration with</T> <Kbd action="run.debug" />{" "}
          <T>or click a line number to set a breakpoint.</T>
        </EmptyState>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <Toolbar className={styles.actions} aria-label="Debugger actions">
          <ToolButton action="debug.rerun" icon="rerun" />
          <ToolButton action="debug.stop" icon="stop" tone="danger" />
          <span className={styles.sep} aria-hidden />
          <ToolButton action="debug.resume" icon="resume" />
          <ToolButton action="debug.pause" icon="pause" />
          <ToolButton action="debug.stepOver" icon="step-over" />
          <ToolButton action="debug.stepInto" icon="step-into" />
          <ToolButton action="debug.stepOut" icon="step-out" />
          <span className={styles.sep} aria-hidden />
          {rootOf(active).adapter === "dart" && (
            <>
              <ToolButton action="debug.hotReload" icon="hot-reload" />
              <ToolButton action="debug.hotRestart" icon="refresh" />
              {rootOf(active).vmServiceUri && <ToolButton action="debug.openDevTools" icon="external-link" />}
              <span className={styles.sep} aria-hidden />
            </>
          )}
          <IconButton
            icon="view-breakpoints"
            action="debug.viewBreakpoints"
            size="small"
            iconSize={16}
            className={styles.tool}
          />
          <IconButton
            icon="mute-breakpoint"
            title={muted ? "Unmute Breakpoints" : "Mute Breakpoints"}
            pressed={muted}
            size="small"
            iconSize={16}
            className={styles.tool}
            onClick={() => setMuted(!muted)}
          />
          <MoreActions />
        </Toolbar>
        <div role="tablist" aria-label={tx("Debug views")} className={styles.tabs}>
          {(
            [
              ["variables", "Threads & Variables"],
              ["console", "Console"],
              ...(hasMemory ? [["memory", "Memory"] as const] : []),
              ...(hasNetwork ? [["network", "Network"] as const] : []),
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`debug-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`debug-panel-${id}`}
              className={clsx(styles.tab, tab === id && styles.tabActive)}
              onClick={() => {
                chosenTab = id;
                setView({ session: active.startedAt, status: active.status, tab: id });
              }}
              onContextMenu={
                id === "variables"
                  ? (e) => {
                      e.preventDefault();
                      showContextMenu(e, [
                        {
                          label: "Focus On Breakpoint",
                          checked: workflowSettings().debugger.variablesOnBreakpoint,
                          run: () => void setVariablesOnBreakpoint(!workflowSettings().debugger.variablesOnBreakpoint),
                        },
                      ]);
                    }
                  : undefined
              }
            >
              {tx(label)}
            </button>
          ))}
        </div>
      </div>
      <div role="tabpanel" id={`debug-panel-${tab}`} aria-labelledby={`debug-tab-${tab}`} className={styles.panel}>
        {tab === "variables" ? (
          <ThreadsAndVariables session={active} sideDocked={sideDocked} />
        ) : tab === "memory" ? (
          memoryPending ? (
            <div className={styles.emptyWrap}>
              <EmptyState title="Memory">
                <T>The Memory view is available once the program has started.</T>
              </EmptyState>
            </div>
          ) : (
            <MemoryView key={active.id} session={active} />
          )
        ) : tab === "network" ? (
          <NetworkView key={active.id} session={active.id} />
        ) : (
          (consolePane ?? <DebugConsole key={active.id} session={active} />)
        )}
      </div>
    </div>
  );
}

/** Debug adapters whose sessions have the Memory view (`ide-dap`'s `JVM_MEMORY_ADAPTERS`). */
const JVM_ADAPTERS = new Set(["java-debug", "kotlin-debug-adapter", "kotlin-lsp"]);

// --- threads & frames ----------------------------------------------------------

const DEFAULT_THREADS_VARIABLES_LAYOUT = { frames: 34, variables: 66 };

function ThreadsAndVariables({ session, sideDocked }: { session: DebugSession; sideDocked: boolean }) {
  return (
    <SplitGroup
      orientation={sideDocked ? "vertical" : "horizontal"}
      id="debug-threads-variables"
      storageKey={sideDocked ? "openidea.debug.threadsVariables.vertical" : "openidea.debug.threadsVariables"}
      defaultLayout={DEFAULT_THREADS_VARIABLES_LAYOUT}
      className={styles.split}
    >
      <SplitPanel
        id="frames"
        defaultSize={`${DEFAULT_THREADS_VARIABLES_LAYOUT.frames}%`}
        minSize={sideDocked ? "25%" : "160px"}
      >
        <FramesPane session={session} />
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="variables" minSize={sideDocked ? "25%" : "200px"}>
        <VariablesPane session={session} />
      </SplitPanel>
    </SplitGroup>
  );
}

function ThreadSelector({ session }: { session: DebugSession }) {
  const tr = useTx();
  const value = session.selectedThread == null ? null : String(session.selectedThread);
  const options = session.threads.map<SelectOption>(({ id, name }) => {
    const option = { value: String(id), label: name, verbatim: true };
    if (!isLive(session)) return option;
    if (!isThreadSuspended(session, id)) return { ...option, icon: "thread-running", detail: "Running" };
    const reason =
      id === session.stoppedThread ? session.stopReason : session.suspendedThreads?.find((t) => t.id === id)?.reason;
    return reason === "breakpoint" || reason?.endsWith(" breakpoint")
      ? { ...option, icon: "thread-breakpoint", detail: "At breakpoint" }
      : { ...option, icon: "thread-suspended", detail: "Suspended" };
  });
  const selected = options.find((option) => option.value === value);
  const summary = selected?.detail ? `${selected.label} (${tr(selected.detail)})` : selected?.label;
  return (
    <div className={styles.threadHeader}>
      <Select
        value={value}
        options={options}
        onChange={(v) => void selectThread(session.id, Number(v))}
        aria-label="Thread"
        aria-description={summary}
        title={summary}
        variant="ghost"
        className={styles.threadSelect}
      />
    </div>
  );
}

function FramesPane({ session }: { session: DebugSession }) {
  const root = useProject((s) => s.project?.root ?? null);
  const [showAll, setShowAll] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const selectedRow = useRef<HTMLButtonElement>(null);
  const items = useMemo(
    () => groupFrames(session.frames, root, session.selectedFrame, showAll),
    [session.frames, root, session.selectedFrame, showAll],
  );
  useLayoutEffect(() => {
    if (list.current && selectedRow.current) revealVertically(list.current, selectedRow.current);
  }, [items]);
  const paused = session.status === "paused";
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const frames = items.flatMap((i) => (i.kind === "frame" ? [i.frame] : []));
    const idx = frames.findIndex((f) => f.id === session.selectedFrame);
    const next = frames[idx + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) {
      e.preventDefault();
      selectFrame(session.id, next.id);
    }
  };
  return (
    <div className={styles.frames}>
      {session.threads.length > 0 && <ThreadSelector session={session} />}
      <div
        ref={list}
        className={styles.frameList}
        role="listbox"
        aria-label={tx("Frames")}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onFocus={() =>
          focusDebugView({
            view: "frames",
            jumpToSource: () => {
              const f = session.frames.find((x) => x.id === session.selectedFrame);
              if (f) void revealFrame(f, true);
            },
          })
        }
        onBlur={() => blurDebugView("frames")}
      >
        {!paused && (
          <div className={styles.note}>
            {session.status === "terminated"
              ? tx("Finished")
              : (remoteWaitingNote(rootOf(session).runConfig) ?? tx("Running…"))}
          </div>
        )}
        {stopNote(session) && <div className={styles.note}>{stopNote(session)}</div>}
        {items.map((item) =>
          item.kind === "hidden" ? (
            <button
              key={item.key}
              type="button"
              className={clsx(styles.frame, styles.hiddenFrames)}
              onClick={() => setShowAll(true)}
            >
              {tx`${item.count} library frames hidden`}
            </button>
          ) : (
            <button
              key={item.frame.id}
              ref={item.frame.id === session.selectedFrame ? selectedRow : undefined}
              type="button"
              role="option"
              aria-selected={item.frame.id === session.selectedFrame}
              title={item.frame.path ? `${frameLabel(item.frame)}, ${basename(item.frame.path)}` : item.frame.name}
              className={clsx(
                styles.frame,
                item.frame.id === session.selectedFrame && styles.frameSelected,
                item.library && styles.frameLibrary,
              )}
              onClick={() => selectFrame(session.id, item.frame.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                selectFrame(session.id, item.frame.id, false);
                showContextMenu(e, [
                  {
                    label: "Jump to Source",
                    shortcut: "F4",
                    disabled: !item.frame.path,
                    run: () => void revealFrame(item.frame, true),
                  },
                  {
                    label: "Reset Frame",
                    icon: "reset-frame",
                    disabled: !paused || !sessionSupports("restartFrame", session),
                    run: () => void executeAction("debug.resetFrame"),
                  },
                  { kind: "separator" },
                  {
                    label: showAll ? "Hide Library Frames" : "Show All Frames",
                    run: () => setShowAll((v) => !v),
                  },
                  {
                    label: "Copy Stack",
                    icon: "copy",
                    run: () =>
                      void writeClipboardText(
                        session.frames
                          .map((f) => `${frameLabel(f)}${f.path ? `, ${basename(f.path)}` : ""}`)
                          .join("\n"),
                      ),
                  },
                ]);
              }}
            >
              <Icon name="method" size={16} className={styles.frameIcon} />
              <span className={styles.frameText}>
                <span className={styles.frameLabel}>
                  <span className={styles.frameName}>{item.frame.name}</span>
                  {item.frame.path && item.frame.line >= 0 && (
                    <span className={styles.frameLine}>:{item.frame.line + 1}</span>
                  )}
                </span>
                {item.frame.path && <span className={styles.frameFile}>, {basename(item.frame.path)}</span>}
              </span>
            </button>
          ),
        )}
      </div>
    </div>
  );
}

// --- variables -----------------------------------------------------------------

interface EvalRow {
  expression: string;
  result: Variable | null;
  error: string | null;
}

function VariablesPane({ session }: { session: DebugSession }) {
  const watches = useDebug((s) => s.watches);
  const stopSeq = useDebug((s) => s.stopSeq);
  const variablesEpoch = useDebug((s) => s.variablesEpoch);
  const settings = useProject((s) => s.settings);
  const [expression, setExpression] = useState("");
  const evalField = useRef<HTMLInputElement>(null);
  const evalRow = useRef<HTMLDivElement>(null);
  const completion = useExpressionCompletion(evalField, expression, setExpression, session);
  const [history, setHistory] = useState<{ sessionId: number; stopSeq: number; entries: string[] } | null>(null);
  const [lastEval, setLastEval] = useState<EvalRow | null>(null);
  const [scopeData, setScopeData] = useState<{ frame: number | null; scopes: Scope[]; locals: Variable[] }>({
    frame: null,
    scopes: [],
    locals: [],
  });
  const [watchData, setWatchData] = useState<{ frame: number | null; seq: number; rows: EvalRow[] }>({
    frame: null,
    seq: -1,
    rows: [],
  });
  const frame = session.status === "paused" ? session.selectedFrame : null;
  const historyOpen = frame != null && history?.sessionId === session.id && history.stopSeq === stopSeq;
  const editor = settings?.editor;
  const live = liveWatchesApply(session);
  // A hidden tool window stays mounted: its watches must not go on running in the page.
  const liveWatches = useLiveWatches(session, watches, useToolWindowShown());
  // Same thread and stack depth across stops: compare like with like.
  const changeScope = `${session.id}:${session.selectedThread}:${session.frames.findIndex((f) => f.id === frame)}`;

  // Scopes + first scope's variables of the selected frame.
  useEffect(() => {
    if (frame == null) return;
    let cancelled = false;
    void (async () => {
      let scopes: Scope[] = [];
      let locals: Variable[] = [];
      try {
        scopes = await call(commands.debugScopes(session.id, frame));
        const first = scopes.find((s) => !s.expensive);
        if (first) {
          const vars = await call(commands.debugVariables(session.id, first.variablesReference));
          locals = workflowSettings().debugger.sortValues ? sortVariables(vars) : vars;
        }
      } catch {
        // Frame went away (resumed).
      }
      if (!cancelled) setScopeData({ frame, scopes, locals });
    })();
    return () => {
      cancelled = true;
    };
  }, [session.id, frame, stopSeq, variablesEpoch]);

  // Watches are re-evaluated on every stop / frame change, and when the adapter has new values (kotlin-lsp first
  // answers "Collecting data…").
  useEffect(() => {
    if (frame == null || !watches.length) return;
    let cancelled = false;
    void (async () => {
      const rows = await Promise.all(
        watches.map(async (w): Promise<EvalRow> => {
          try {
            return { expression: w, result: await evaluate(w, "watch", session), error: null };
          } catch (e) {
            return { expression: w, result: null, error: e instanceof Error ? e.message : String(e) };
          }
        }),
      );
      if (!cancelled) setWatchData({ frame, seq: stopSeq, rows });
    })();
    return () => {
      cancelled = true;
    };
    // `session` identity changes on every patch; frame/stopSeq capture what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, frame, stopSeq, variablesEpoch, watches]);

  const roots = useMemo<VarRoot[]>(() => {
    const out: VarRoot[] = [];
    if (lastEval)
      out.push({
        key: `eval:${lastEval.expression}`,
        kind: "eval",
        name: lastEval.expression,
        variable: lastEval.result,
        error: lastEval.error,
      });
    // While the program runs, a debugger that evaluates without suspending gives the values.
    const watchRows = frame == null ? liveWatches : watchData.frame === frame ? watchData.rows : [];
    for (const w of watches) {
      const r = watchRows.find((x) => x.expression === w);
      out.push({
        key: `watch:${w}`,
        kind: "watch",
        name: w,
        variable: r?.result ?? null,
        error: frame == null && !live ? "Not suspended" : (r?.error ?? null),
      });
    }
    if (frame != null && scopeData.frame === frame) {
      const firstScope = scopeData.scopes.find((s) => !s.expensive);
      const seen = new Map<string, number>();
      for (const v of scopeData.locals) {
        const n = (seen.get(v.name) ?? 0) + 1;
        seen.set(v.name, n);
        out.push({
          key: `local:${v.name}${n > 1 ? `#${n}` : ""}`,
          kind: "var",
          variable: v,
          container: firstScope?.variablesReference ?? 0,
        });
      }
      for (const s of scopeData.scopes) {
        if (s === firstScope) continue;
        out.push({
          key: `scope:${s.name}`,
          kind: "scope",
          name: s.name,
          reference: s.variablesReference,
          expensive: s.expensive,
        });
      }
    }
    return out;
  }, [lastEval, watches, watchData, scopeData, frame, live, liveWatches]);

  const run = async () => {
    const e = expression.trim();
    if (!e) return;
    pushHistory("evaluate", e);
    try {
      setLastEval({
        expression: e,
        result: await evaluate(e, session.adapter === "gdb" ? "watch" : "repl", session),
        error: null,
      });
    } catch (err) {
      setLastEval({ expression: e, result: null, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const addExpressionWatch = () => {
    const e = expression.trim();
    if (!e) return;
    pushHistory("evaluate", e);
    addWatch(e);
    setExpression("");
  };

  const recall = (text: string) => {
    setExpression(text);
    requestAnimationFrame(() => {
      evalField.current?.focus();
      evalField.current?.setSelectionRange(text.length, text.length);
    });
  };

  return (
    <div className={styles.variables}>
      <div ref={evalRow} className={styles.evalField}>
        <input
          ref={evalField}
          className={styles.evalInput}
          style={{
            fontFamily: monoFontFamily(editor?.fontFamily, editorPrefs(settings).fallbackFont, "var(--font-mono)"),
            fontSize: editor?.fontSize ? `min(var(--fs-ui), ${editor.fontSize}px)` : undefined,
          }}
          value={expression}
          onChange={(e) => {
            setExpression(e.target.value);
            completion.onInput();
          }}
          onBlur={completion.close}
          onKeyDown={(e) => {
            if (isImeKey(e.nativeEvent) || completion.onKeyDown(e)) return;
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
              e.preventDefault();
              addExpressionWatch();
            } else if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder={tx("Evaluate expression")}
          aria-label={tx("Evaluate expression")}
          spellCheck={false}
          autoComplete="off"
          disabled={frame == null}
        />
        {completion.popup}
        <IconButton
          icon="plus"
          title="Add to Watches"
          shortcut={formatBinding(hostBinding("Meta+Shift+Enter"))}
          size="small"
          iconSize={16}
          disabled={!expression.trim()}
          onClick={addExpressionWatch}
        />
        <IconButton
          icon="chevron-down"
          title="History"
          size="small"
          aria-haspopup="menu"
          aria-expanded={historyOpen}
          disabled={frame == null}
          onClick={() =>
            setHistory(
              historyOpen
                ? null
                : {
                    sessionId: session.id,
                    stopSeq,
                    entries: readHistory("evaluate")
                      .filter((entry) => !/[\r\n]/.test(entry))
                      .slice(0, 20),
                  },
            )
          }
        />
      </div>
      <Popup
        open={historyOpen}
        onClose={() => setHistory(null)}
        anchor={evalRow}
        placement="bottom-start"
        matchWidth
        role="presentation"
        autoFocus={false}
        className={styles.evalHistory}
      >
        <MenuList
          aria-label={tx("Expression history")}
          iconColumn={false}
          onDone={() => setHistory(null)}
          items={
            history?.entries.length
              ? history.entries.map((entry) => ({ label: entry, verbatim: true, run: () => recall(entry) }))
              : [{ label: "No history", disabled: true }]
          }
        />
      </Popup>
      {frame == null && !watches.length && !lastEval ? (
        <div className={styles.note}>
          {session.status === "terminated"
            ? tx("The session has finished.")
            : tx("Variables are available while suspended.")}
        </div>
      ) : (
        <VariablesView
          roots={roots}
          session={session.id}
          generation={(stopSeq * 1000 + (variablesEpoch % 1000)) * 100000 + (frame ?? 0)}
          changes={{ epoch: stopSeq, scope: changeScope }}
          aria-label="Variables"
        />
      )}
    </div>
  );
}
