/** Debug tool window: toolbar, Threads & Variables (frames + variables), Console. */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction, getAction } from "@/platform/actions";
import { evaluateWhen, useContextKeys } from "@/platform/context";
import { basename, useProject } from "@/platform/project";
import { call, commands, type Scope, type Variable } from "@/platform/ipc";
import {
  EmptyState,
  Icon,
  IconButton,
  Kbd,
  Menu,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  showContextMenu,
  type MenuItem,
  type TabItem,
  T,
} from "@/ui";
import { setMuted, useBreakpoints } from "../breakpoints/store";
import { frameLabel, groupFrames } from "../frames";
import { blurDebugView, focusDebugView } from "./focusedView";
import {
  addWatch,
  clearConsole,
  evaluate,
  isLive,
  selectFrame,
  selectSession,
  selectThread,
  appendConsole,
  revealFrame,
  sessionSupports,
  useDebug,
  type DebugSession,
} from "../state";
import { VariablesView, type VarRoot } from "./VariablesView";
import { pushHistory, readHistory, setConsoleHistoryBrowser } from "./expressionHistory";
import { sortVariables } from "../values";
import { workflowSettings } from "@/platform/workflowSettings";
import { spanStyle } from "@/ui/ansi";
import ansi from "@/ui/ansi.module.css";
import styles from "./DebugToolWindow.module.css";
import { tx } from "@/platform/i18n";

function useActionEnabled(id: string): boolean {
  const ctx = useContextKeys();
  const a = getAction(id);
  return !!a && evaluateWhen(a.when, ctx);
}

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
      <Menu open={open} anchor={ref} items={MORE_ITEMS} placement="bottom-start" onClose={() => setOpen(false)} />
    </>
  );
}

type Tab = "variables" | "console";

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
  const items: TabItem[] = list.map((s) => ({
    id: String(s.id),
    label: s.parent != null ? tx`${s.name} (child)` : s.name,
    text: s.name,
    icon: "debug",
    italic: s.status === "terminated",
    tooltip: statusText(s),
  }));
  return (
    <Tabs
      variant="compact"
      className={styles.sessionTabs}
      aria-label="Debug sessions"
      items={items}
      activeId={active != null ? String(active) : null}
      onSelect={(id) => selectSession(+id)}
      panelIdPrefix="openidea-debug"
    />
  );
}

export function DebugToolWindow() {
  const active = useDebug((s) => (s.active != null ? s.sessions[s.active] : undefined));
  const muted = useBreakpoints((s) => s.muted);
  const [tab, setTab] = useState<Tab>("variables");

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
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Debugger actions")}>
        <div role="tablist" aria-label={tx("Debug views")} className={styles.tabs}>
          {(
            [
              ["variables", "Threads & Variables"],
              ["console", "Console"],
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
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        {/* IDEA's XDebugger.ToolWindow.TopToolbar3 (+ its "More" group). */}
        <span className={styles.sep} aria-hidden />
        <ToolButton action="debug.rerun" icon="rerun" />
        <ToolButton action="debug.stop" icon="stop" tone="danger" />
        <span className={styles.sep} aria-hidden />
        <ToolButton action="debug.resume" icon="resume" />
        <ToolButton action="debug.pause" icon="pause" />
        <ToolButton action="debug.stepOver" icon="step-over" />
        <ToolButton action="debug.stepInto" icon="step-into" />
        <ToolButton action="debug.stepOut" icon="step-out" />
        <span className={styles.sep} aria-hidden />
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
      </div>
      <div role="tabpanel" id={`debug-panel-${tab}`} aria-labelledby={`debug-tab-${tab}`} className={styles.panel}>
        {tab === "variables" ? <ThreadsAndVariables session={active} /> : <ConsoleView session={active} />}
      </div>
    </div>
  );
}

// --- threads & frames ----------------------------------------------------------

function ThreadsAndVariables({ session }: { session: DebugSession }) {
  return (
    <SplitGroup orientation="horizontal" id="debug-threads-variables" className={styles.split}>
      <SplitPanel id="frames" defaultSize="34%" minSize="160px">
        <FramesPane session={session} />
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="variables" minSize="200px">
        <VariablesPane session={session} />
      </SplitPanel>
    </SplitGroup>
  );
}

function FramesPane({ session }: { session: DebugSession }) {
  const root = useProject((s) => s.project?.root ?? null);
  const [showAll, setShowAll] = useState(false);
  const items = useMemo(
    () => groupFrames(session.frames, root, session.selectedFrame, showAll),
    [session.frames, root, session.selectedFrame, showAll],
  );
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
      {session.threads.length > 0 && (
        <Select
          value={session.selectedThread != null ? String(session.selectedThread) : null}
          options={session.threads.map((t) => ({
            value: String(t.id),
            label: t.name,
            detail: t.id === session.stoppedThread ? "suspended" : undefined,
          }))}
          onChange={(v) => void selectThread(session.id, +v)}
          aria-label="Thread"
          className={styles.threadSelect}
        />
      )}
      <div
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
          <div className={styles.note}>{session.status === "terminated" ? tx("Finished") : tx("Running…")}</div>
        )}
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
              type="button"
              role="option"
              aria-selected={item.frame.id === session.selectedFrame}
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
                      void navigator.clipboard?.writeText(
                        session.frames
                          .map((f) => `${frameLabel(f)}${f.path ? `, ${basename(f.path)}` : ""}`)
                          .join("\n"),
                      ),
                  },
                ]);
              }}
            >
              <Icon name="method" size={16} className={styles.frameIcon} />
              <span className={styles.frameName}>{item.frame.name}</span>
              {item.frame.path && (
                <span className={styles.frameFile}>
                  , {basename(item.frame.path)}
                  {item.frame.line >= 0 ? `:${item.frame.line + 1}` : ""}
                </span>
              )}
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
  const [expression, setExpression] = useState("");
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
  }, [session.id, frame, stopSeq]);

  // Watches are re-evaluated on every stop / frame change.
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
  }, [session.id, frame, stopSeq, watches]);

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
    const watchRows = watchData.frame === frame ? watchData.rows : [];
    for (const w of watches) {
      const r = watchRows.find((x) => x.expression === w);
      out.push({
        key: `watch:${w}`,
        kind: "watch",
        name: w,
        variable: r?.result ?? null,
        error: frame == null ? "Not suspended" : (r?.error ?? null),
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
  }, [lastEval, watches, watchData, scopeData, frame]);

  const run = async () => {
    const e = expression.trim();
    if (!e) return;
    try {
      setLastEval({ expression: e, result: await evaluate(e, "repl", session), error: null });
    } catch (err) {
      setLastEval({ expression: e, result: null, error: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className={styles.variables}>
      <div className={styles.evalField}>
        <input
          className={styles.evalInput}
          value={expression}
          onChange={(e) => setExpression(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && e.shiftKey) {
              e.preventDefault();
              addWatch(expression);
              setExpression("");
            } else if (e.key === "Enter") {
              e.preventDefault();
              void run();
            }
          }}
          placeholder={frame != null ? "Evaluate expression (↩) or add a watch (⇧⌘↩)" : "Evaluate expression"}
          aria-label={tx("Evaluate expression")}
          spellCheck={false}
          autoComplete="off"
          disabled={frame == null}
        />
        <IconButton
          icon="plus"
          title="Add to Watches"
          shortcut="⇧⌘↩"
          size="small"
          iconSize={16}
          disabled={!expression.trim()}
          onClick={() => {
            addWatch(expression);
            setExpression("");
          }}
        />
      </div>
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
          generation={stopSeq * 100000 + (frame ?? 0)}
          changes={{ epoch: stopSeq, scope: changeScope }}
          aria-label="Variables"
        />
      )}
    </div>
  );
}

// --- console -------------------------------------------------------------------

function ConsoleView({ session }: { session: DebugSession }) {
  const lines = useDebug((s) => s.console[session.id]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [input, setInput] = useState("");
  const history = useRef<string[]>(readHistory("console"));
  const historyPos = useRef(-1);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  const submit = async () => {
    const e = input.trim();
    if (!e) return;
    pushHistory("console", e);
    history.current = readHistory("console");
    historyPos.current = -1;
    setInput("");
    appendConsole(session.id, "input", `> ${e}\n`);
    try {
      const v = await evaluate(e, "repl", session);
      appendConsole(session.id, "result", `${v.value}\n`);
    } catch (err) {
      appendConsole(session.id, "stderr", `${err instanceof Error ? err.message : String(err)}\n`);
    }
  };

  /** IDEA's Browse History popup: the expressions typed before, most recent first. */
  const browseHistory = () => {
    const el = inputRef.current;
    const r = el?.getBoundingClientRect();
    const items: MenuItem[] = history.current.length
      ? history.current.slice(0, 30).map((h, i) => ({
          id: String(i),
          label: h.length > 120 ? `${h.slice(0, 120)}…` : h,
          run: () => {
            setInput(h);
            historyPos.current = i;
            el?.focus();
          },
        }))
      : [{ id: "none", label: "No history", disabled: true }];
    showContextMenu({ x: r?.left ?? 120, y: (r?.top ?? 200) - 4 }, items);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void submit();
    } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const h = history.current;
      if (!h.length) return;
      e.preventDefault();
      const pos = Math.max(-1, Math.min(h.length - 1, historyPos.current + (e.key === "ArrowUp" ? 1 : -1)));
      historyPos.current = pos;
      setInput(pos < 0 ? "" : h[pos]!);
    }
  };

  return (
    <div className={styles.console}>
      <div
        ref={scroller}
        className={clsx(styles.consoleOutput, ansi.palette)}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          showContextMenu(e, [{ label: "Clear All", icon: "trash", run: () => clearConsole(session.id) }]);
        }}
        role="log"
        aria-label={tx("Debug console")}
        tabIndex={0}
      >
        {(lines ?? []).map((l) => (
          <span key={l.id} className={clsx(styles.out, styles[`cat-${l.category}`])}>
            {l.spans.map((sp, i) => (
              <span key={i} style={spanStyle(sp)}>
                {sp.text}
              </span>
            ))}
          </span>
        ))}
      </div>
      <label className={styles.repl}>
        <span className={styles.prompt} aria-hidden>
          ›
        </span>
        <input
          ref={inputRef}
          className={styles.evalInput}
          onFocus={() => setConsoleHistoryBrowser(browseHistory)}
          onBlur={() => setConsoleHistoryBrowser(null)}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isLive(session) ? "Evaluate in the debug console" : "Session finished"}
          disabled={!isLive(session)}
          aria-label={tx("Debug console input")}
          spellCheck={false}
          autoComplete="off"
        />
        <IconButton
          icon="trash"
          title="Clear Console"
          size="small"
          iconSize={12}
          onClick={() => clearConsole(session.id)}
        />
      </label>
    </div>
  );
}
