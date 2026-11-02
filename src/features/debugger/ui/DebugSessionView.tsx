/**
 * A debug session's views — threads & frames, variables, evaluation — shared by
 * the Debug tool window and the Services window's debug detail pane.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import { basename, useProject } from "@/platform/project";
import { call, commands, type Scope, type Variable } from "@/platform/ipc";
import { Icon, IconButton, Select, SplitGroup, SplitHandle, SplitPanel, showContextMenu } from "@/ui";
import { frameLabel, groupFrames } from "../frames";
import { blurDebugView, focusDebugView } from "./focusedView";
import {
  addWatch,
  evaluate,
  selectFrame,
  selectThread,
  revealFrame,
  sessionSupports,
  useDebug,
  type DebugSession,
} from "../state";
import { VariablesView, type VarRoot } from "./VariablesView";
import { sortVariables } from "../values";
import { workflowSettings } from "@/platform/workflowSettings";
import styles from "./DebugToolWindow.module.css";
import { tx } from "@/platform/i18n";

export function ThreadsAndVariables({ session }: { session: DebugSession }) {
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
