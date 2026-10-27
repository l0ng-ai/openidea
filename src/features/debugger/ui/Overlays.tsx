/** Debugger popovers and dialogs: breakpoint properties, View Breakpoints, Evaluate, config chooser. */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MutableRefObject } from "react";
import { basename, relativePath, useProject } from "@/platform/project";
import { executeAction, getAction } from "@/platform/actions";
import { call, commands, type AttachableProcess, type RunConfig, type Variable } from "@/platform/ipc";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import { Button, Checkbox, Dialog, Icon, IconButton, Input, Kbd, List, Menu, Popup, Toggle, T } from "@/ui";
import { isConditional, suspends, type BreakpointEntry } from "../breakpoints/model";
import {
  removeAllBreakpoints,
  removeBreakpoint,
  setMuted,
  updateBreakpoint,
  useBreakpoints,
} from "../breakpoints/store";
import { activeSession, addWatch, evaluate, isLive, startSession, useDebug } from "../state";
import {
  addMethodBreakpoint,
  removeAllSpecial,
  removeSpecial,
  updateSpecial,
  useSpecialBreakpoints,
  type SpecialBreakpoint,
} from "../breakpoints/special";
import { attachConfig, attachDetail, attachRows, type AttachRow } from "../attach";
import {
  exceptionGroups,
  refreshExceptionFilters,
  setExceptionFilter,
  useExceptionBreakpoints,
} from "../breakpoints/exceptions";
import { closeBreakpointPopover, useOverlays } from "./popoverStore";
import { VariablesView, type VarRoot } from "./VariablesView";
import { pushHistory, readHistory } from "./expressionHistory";
import styles from "./Overlays.module.css";
import { isImeKey } from "@/platform/ime";
import { tx } from "@/platform/i18n";

export function DebuggerOverlays() {
  return (
    <>
      <BreakpointPopover />
      <BreakpointsDialog />
      <EvaluateDialog />
      <ConfigChooser />
      <AttachPopup />
      <SmartStepChooser />
    </>
  );
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}

// --- breakpoint properties popover ------------------------------------------

function BreakpointPopover() {
  const popover = useOverlays((s) => s.popover);
  const bp = useBreakpoints((s) => (popover ? s.byFile[popover.path]?.find((b) => b.id === popover.id) : undefined));
  const special = useSpecialBreakpoints((s) =>
    popover ? [...s.methods, ...s.fields].find((b) => b.id === popover.id) : undefined,
  );
  if (popover && special) return <SpecialEditor key={special.id} bp={special} at={popover} />;
  if (!popover || !bp) return null;
  return <BreakpointEditor key={popover.id} path={popover.path} bp={bp} at={popover} focusLog={popover.focusLog} />;
}

function BreakpointEditor({
  path,
  bp,
  at,
  focusLog,
}: {
  path: string;
  bp: BreakpointEntry;
  at: { x: number; y: number };
  focusLog: boolean;
}) {
  const commitText = useRef<(() => void) | null>(null);
  const close = () => {
    commitText.current?.();
    closeBreakpointPopover();
  };

  return (
    <Popup open onClose={close} anchor={at} placement="bottom-start" trapFocus aria-label="Breakpoint properties">
      <div className={styles.bpEditor}>
        <div className={styles.bpTitle}>
          <span className={styles.bpDot} data-look={bp.enabled ? "on" : "off"} aria-hidden />
          <span className={styles.bpFile}>
            {basename(path)}:{bp.line + 1}
          </span>
        </div>
        <BreakpointFields
          path={path}
          bp={bp}
          focus={focusLog ? "log" : "condition"}
          onEnter={close}
          commitRef={commitText}
        />
        <div className={styles.bpFooter}>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              close();
              void executeAction("debug.viewBreakpoints");
            }}
          >
            <T>More</T> <Kbd action="debug.viewBreakpoints" />
          </button>
          <div className={styles.spacer} />
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              removeBreakpoint(path, bp.id);
              closeBreakpointPopover();
            }}
          >
            <T>Remove</T>
          </Button>
          <Button size="small" variant="primary" onClick={close}>
            <T>Done</T>
          </Button>
        </div>
      </div>
    </Popup>
  );
}

/**
 * Line breakpoint properties shared by the gutter popover and the Breakpoints dialog,
 * like IDEA's: Suspend and the two logging options are independent. Text fields
 * commit on blur (and through `commitRef` when the popover closes).
 */
function BreakpointFields({
  path,
  bp,
  focus,
  onEnter,
  commitRef,
}: {
  path: string;
  bp: BreakpointEntry;
  focus?: "condition" | "log";
  onEnter?: () => void;
  commitRef?: MutableRefObject<(() => void) | null>;
}) {
  const [condition, setCondition] = useState(bp.condition ?? "");
  const [hitCondition, setHitCondition] = useState(bp.hitCondition ?? "");
  const [logEval, setLogEval] = useState(!!bp.logMessage?.trim());
  const [logMessage, setLogMessage] = useState(bp.logMessage ?? "");
  const conditionHistory = useMemo(() => readHistory("condition"), []);
  const historyId = useId();
  const draft = useRef({ condition, hitCondition, logEval, logMessage });
  useEffect(() => {
    draft.current = { condition, hitCondition, logEval, logMessage };
  });
  const commitText = () => {
    const d = draft.current;
    const cond = d.condition.trim() || null;
    if (cond) pushHistory("condition", cond);
    updateBreakpoint(path, bp.id, {
      condition: cond,
      hitCondition: d.hitCondition.trim() || null,
      logMessage: d.logEval ? d.logMessage.trim() || null : null,
    });
  };
  useEffect(() => {
    if (!commitRef) return;
    commitRef.current = commitText;
    return () => {
      commitRef.current = null;
    };
  });
  const onKey = (e: KeyboardEvent) => {
    if (onEnter && e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onEnter();
    }
  };
  return (
    <>
      <Checkbox
        checked={bp.enabled}
        onChange={(enabled) => updateBreakpoint(path, bp.id, { enabled })}
        label="Enabled"
      />
      <Checkbox
        checked={suspends(bp)}
        onChange={(on) => updateBreakpoint(path, bp.id, { suspend: on ? undefined : false })}
        label="Suspend"
      />
      <label className={styles.field}>
        <span className={styles.label}>
          <T>Condition</T>
        </span>
        <Input
          mono
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          onBlur={commitText}
          onKeyDown={onKey}
          list={conditionHistory.length ? historyId : undefined}
          placeholder="e.g. order.total > 100"
          data-autofocus={focus === "condition" ? "" : undefined}
          aria-label="Condition"
        />
        {conditionHistory.length > 0 && (
          <datalist id={historyId}>
            {conditionHistory.map((h) => (
              <option key={h} value={h} />
            ))}
          </datalist>
        )}
      </label>
      <label className={styles.field}>
        <span className={styles.label}>
          <T>Hit count</T>
        </span>
        <Input
          mono
          value={hitCondition}
          onChange={(e) => setHitCondition(e.target.value)}
          onBlur={commitText}
          onKeyDown={onKey}
          placeholder="e.g. 5 or >= 3"
          aria-label="Hit count condition"
        />
      </label>
      <Checkbox
        checked={!!bp.logHit}
        onChange={(on) => updateBreakpoint(path, bp.id, { logHit: on || undefined })}
        label={'"Breakpoint hit" message'}
      />
      <Checkbox
        checked={logEval}
        onChange={(on) => {
          setLogEval(on);
          draft.current = { ...draft.current, logEval: on };
          commitText();
        }}
        label="Evaluate and log"
      />
      {logEval && (
        <Input
          mono
          value={logMessage}
          onChange={(e) => setLogMessage(e.target.value)}
          onBlur={commitText}
          onKeyDown={onKey}
          placeholder="Value: {expression}"
          data-autofocus={focus === "log" ? "" : undefined}
          aria-label="Evaluate and log"
        />
      )}
    </>
  );
}

function specialTitle(b: SpecialBreakpoint): string {
  return b.kind === "method" ? b.name || "(no method)" : b.label;
}

/** Properties popover of a method breakpoint / field watchpoint (right-click on its gutter icon). */
function SpecialEditor({ bp, at }: { bp: SpecialBreakpoint; at: { x: number; y: number } }) {
  const [condition, setCondition] = useState(bp.condition ?? "");
  const [hitCondition, setHitCondition] = useState(bp.hitCondition ?? "");
  const close = () => {
    updateSpecial(bp.id, { condition: condition.trim() || null, hitCondition: hitCondition.trim() || null });
    closeBreakpointPopover();
  };
  return (
    <Popup open onClose={close} anchor={at} placement="bottom-start" trapFocus aria-label="Breakpoint properties">
      <div className={styles.bpEditor}>
        <div className={styles.bpTitle}>
          <Icon name={bp.kind === "method" ? "breakpoint-method" : "breakpoint-field"} size={14} />
          <span className={styles.bpFile}>{specialTitle(bp)}</span>
        </div>
        <Checkbox checked={bp.enabled} onChange={(enabled) => updateSpecial(bp.id, { enabled })} label="Enabled" />
        <label className={styles.field}>
          <span className={styles.label}>
            <T>Condition</T>
          </span>
          <Input
            mono
            value={condition}
            onChange={(e) => setCondition(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && close()}
            data-autofocus=""
            aria-label="Condition"
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>
            <T>Hit count</T>
          </span>
          <Input
            mono
            value={hitCondition}
            onChange={(e) => setHitCondition(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && close()}
            aria-label="Hit count condition"
          />
        </label>
        <div className={styles.bpFooter}>
          <button
            type="button"
            className={styles.link}
            onClick={() => {
              close();
              void executeAction("debug.viewBreakpoints");
            }}
          >
            <T>More</T> <Kbd action="debug.viewBreakpoints" />
          </button>
          <div className={styles.spacer} />
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              removeSpecial(bp.id);
              closeBreakpointPopover();
            }}
          >
            <T>Remove</T>
          </Button>
          <Button size="small" variant="primary" onClick={close}>
            <T>Done</T>
          </Button>
        </div>
      </div>
    </Popup>
  );
}

// --- View Breakpoints dialog --------------------------------------------------

interface BpRow {
  path: string;
  bp: BreakpointEntry;
}

type DialogRow =
  | { type: "section"; key: string; label: string }
  | ({ type: "line"; key: string } & BpRow)
  | { type: "special"; key: string; bp: SpecialBreakpoint };

function BreakpointsDialog() {
  const state = useOverlays((s) => s.breakpoints);
  const byFile = useBreakpoints((s) => s.byFile);
  const status = useBreakpoints((s) => s.status);
  const muted = useBreakpoints((s) => s.muted);
  const methods = useSpecialBreakpoints((s) => s.methods);
  const fields = useSpecialBreakpoints((s) => s.fields);
  const specialStatus = useSpecialBreakpoints((s) => s.status);
  const root = useProject((s) => s.project?.root ?? "");
  const rows = useMemo<DialogRow[]>(() => {
    const lines: DialogRow[] = Object.keys(byFile)
      .sort()
      .flatMap((path) => byFile[path]!.map((bp) => ({ type: "line" as const, key: bp.id, path, bp })));
    const out: DialogRow[] = [];
    const section = (label: string, list: DialogRow[]) => {
      if (list.length) out.push({ type: "section", key: `section:${label}`, label }, ...list);
    };
    section("Line Breakpoints", lines);
    section(
      "Method Breakpoints",
      methods.map((bp) => ({ type: "special" as const, key: bp.id, bp })),
    );
    section(
      "Field Watchpoints",
      fields.map((bp) => ({ type: "special" as const, key: bp.id, bp })),
    );
    return out;
  }, [byFile, methods, fields]);
  const items = rows.filter((r) => r.type !== "section");
  const [selected, setSelected] = useState<string | null>(null);
  const open = !!state;
  const current = items.find((r) => r.key === (selected ?? state?.id)) ?? items[0];
  const close = () => {
    setSelected(null);
    useOverlays.setState({ breakpoints: null });
  };
  const goTo = (r: DialogRow) => {
    const path = r.type === "line" ? r.path : r.type === "special" ? r.bp.path : null;
    const line = r.type === "line" ? r.bp.line : r.type === "special" ? r.bp.line : null;
    if (!path || line == null) return;
    close();
    void maybeEditorService()?.openFile(path, { selection: { line, col: 0 } });
  };
  const removeAll = () => {
    removeAllBreakpoints();
    removeAllSpecial();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Breakpoints"
      width={760}
      aria-label="Breakpoints"
      buttons={[{ label: "Done", role: "default", onClick: close }]}
    >
      <div className={styles.bpDialog}>
        <div className={styles.bpListPane}>
          <div className={styles.bpListHeader}>
            <Toggle checked={muted} onChange={setMuted} label="Mute breakpoints" />
            <div className={styles.spacer} />
            <IconButton
              icon="plus"
              title="Add Method Breakpoint"
              size="small"
              onClick={() => setSelected(addMethodBreakpoint("").id)}
            />
            <IconButton
              icon="trash"
              title="Remove All Breakpoints"
              size="small"
              disabled={!items.length}
              onClick={removeAll}
            />
          </div>
          <List
            items={rows}
            getKey={(r) => r.key}
            isSection={(r) => r.type === "section"}
            renderSection={(r) => <div className={styles.exceptionAdapter}>{r.type === "section" ? r.label : ""}</div>}
            activeIndex={current ? rows.indexOf(current) : -1}
            onActiveChange={(i) => setSelected(rows[i]?.key ?? null)}
            onActivate={(r) => goTo(r)}
            aria-label="All breakpoints"
            className={styles.bpList}
            empty={
              <div className={styles.empty}>
                <T>No breakpoints. Click a line number to add one.</T>
              </div>
            }
            renderItem={(r) => {
              if (r.type === "section") return null;
              if (r.type === "special") {
                const st = specialStatus[r.bp.id];
                return (
                  <div className={styles.bpRow}>
                    <Checkbox
                      checked={r.bp.enabled}
                      onChange={(enabled) => updateSpecial(r.bp.id, { enabled })}
                      aria-label={tx`Enable ${specialTitle(r.bp)}`}
                    />
                    <Icon name={r.bp.kind === "method" ? "breakpoint-method" : "breakpoint-field"} size={14} />
                    <span className={styles.bpName}>{specialTitle(r.bp)}</span>
                    {r.bp.path && (
                      <span className={styles.bpDir}>
                        {basename(r.bp.path)}
                        {r.bp.line != null ? `:${r.bp.line + 1}` : ""}
                      </span>
                    )}
                    {st && !st.verified && isLive(activeSession()) && <span className={styles.bpCond}>unverified</span>}
                  </div>
                );
              }
              const st = status[r.bp.id];
              return (
                <div className={styles.bpRow}>
                  <Checkbox
                    checked={r.bp.enabled}
                    onChange={(enabled) => updateBreakpoint(r.path, r.bp.id, { enabled })}
                    aria-label={tx`Enable breakpoint at ${basename(r.path)}:${r.bp.line + 1}`}
                  />
                  <span
                    className={styles.bpDot}
                    data-look={
                      !r.bp.enabled || muted
                        ? "off"
                        : st && !st.verified && isLive(activeSession())
                          ? "unverified"
                          : "on"
                    }
                    aria-hidden
                  />
                  <span className={styles.bpName}>
                    {basename(r.path)}:{r.bp.line + 1}
                  </span>
                  <span className={styles.bpDir}>{relativePath(root, r.path)}</span>
                  {isConditional(r.bp) && <span className={styles.bpCond}>{suspends(r.bp) ? "if" : "log"}</span>}
                  {r.bp.temporary && <span className={styles.bpCond}>temp</span>}
                </div>
              );
            }}
          />
          <ExceptionBreakpoints open={open} />
        </div>
        <div className={styles.bpDetail}>
          {current?.type === "line" ? (
            <BreakpointDetail key={current.key} row={current} onGo={() => goTo(current)} />
          ) : current?.type === "special" ? (
            <SpecialDetail key={current.key} bp={current.bp} onGo={() => goTo(current)} />
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** Exception breakpoint filters offered by the debug adapters (checkbox per filter). */
function ExceptionBreakpoints({ open }: { open: boolean }) {
  const known = useExceptionBreakpoints((s) => s.known);
  const choices = useExceptionBreakpoints((s) => s.choices);
  const groups = useMemo(() => exceptionGroups(known, choices), [known, choices]);
  useEffect(() => {
    if (open) void refreshExceptionFilters();
  }, [open]);
  return (
    <section className={styles.exceptions} aria-label="Exception breakpoints">
      <div className={styles.exceptionsTitle}>
        <T>Exception Breakpoints</T>
      </div>
      {groups.length === 0 ? (
        <div className={styles.exceptionsEmpty}>
          <T>Start a debug session to see the exception filters of its adapter.</T>
        </div>
      ) : (
        groups.map((g) => (
          <div
            key={g.adapter}
            className={styles.exceptionGroup}
            role="group"
            aria-label={`${g.adapter} exception filters`}
          >
            {groups.length > 1 && <div className={styles.exceptionAdapter}>{g.adapter}</div>}
            {g.filters.map((f) => (
              <span key={f.filter} title={f.description ?? undefined} className={styles.exceptionRow}>
                <Checkbox
                  checked={f.enabled}
                  onChange={(on) => setExceptionFilter(g.adapter, f.filter, on)}
                  label={f.label}
                />
              </span>
            ))}
          </div>
        ))
      )}
    </section>
  );
}

function BreakpointDetail({ row, onGo }: { row: BpRow; onGo: () => void }) {
  const { path, bp } = row;
  const st = useBreakpoints((s) => s.status[bp.id]);
  return (
    <div className={styles.detail}>
      <div className={styles.bpTitle}>
        <span className={styles.bpFile}>
          {basename(path)}:{bp.line + 1}
        </span>
        <div className={styles.spacer} />
        <Button size="small" variant="ghost" onClick={onGo}>
          <T>Go to Source</T>
        </Button>
        <Button size="small" variant="ghost" onClick={() => removeBreakpoint(path, bp.id)}>
          <T>Remove</T>
        </Button>
      </div>
      {st && <div className={styles.statusLine}>{st.verified ? "Verified" : (st.message ?? "Not verified")}</div>}
      <BreakpointFields path={path} bp={bp} />
      <Checkbox
        checked={!!bp.temporary}
        onChange={(temporary) => updateBreakpoint(path, bp.id, { temporary })}
        label="Remove once hit"
      />
    </div>
  );
}

function SpecialDetail({ bp, onGo }: { bp: SpecialBreakpoint; onGo: () => void }) {
  const st = useSpecialBreakpoints((s) => s.status[bp.id]);
  const [name, setName] = useState(bp.kind === "method" ? bp.name : bp.label);
  const [condition, setCondition] = useState(bp.condition ?? "");
  const [hitCondition, setHitCondition] = useState(bp.hitCondition ?? "");
  return (
    <div className={styles.detail}>
      <div className={styles.bpTitle}>
        <Icon name={bp.kind === "method" ? "breakpoint-method" : "breakpoint-field"} size={14} />
        <span className={styles.bpFile}>{specialTitle(bp)}</span>
        <div className={styles.spacer} />
        {bp.path && (
          <Button size="small" variant="ghost" onClick={onGo}>
            <T>Go to Source</T>
          </Button>
        )}
        <Button size="small" variant="ghost" onClick={() => removeSpecial(bp.id)}>
          <T>Remove</T>
        </Button>
      </div>
      {st && <div className={styles.statusLine}>{st.verified ? "Verified" : (st.message ?? "Not verified")}</div>}
      <Checkbox checked={bp.enabled} onChange={(enabled) => updateSpecial(bp.id, { enabled })} label="Enabled" />
      {bp.kind === "method" ? (
        <label className={styles.field}>
          <span className={styles.label}>
            <T>Method</T>
          </span>
          <Input
            mono
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => updateSpecial(bp.id, { name: name.trim() })}
            placeholder="com.example.Service#process, main.run, parse"
            data-autofocus={bp.name ? undefined : ""}
            aria-label="Method name"
          />
        </label>
      ) : (
        <>
          <div className={styles.statusLine}>Watching {bp.dataId}</div>
          <label className={styles.field}>
            <span className={styles.label}>
              <T>Suspend on</T>
            </span>
            <span className={styles.exceptionGroup}>
              <Checkbox
                checked={bp.accessType !== "read"}
                onChange={(on) =>
                  updateSpecial(bp.id, { accessType: on ? (bp.accessType === "read" ? "readWrite" : "write") : "read" })
                }
                label="Field modification"
              />
              <Checkbox
                checked={bp.accessType === "read" || bp.accessType === "readWrite"}
                onChange={(on) => updateSpecial(bp.id, { accessType: on ? "readWrite" : "write" })}
                label="Field access"
              />
            </span>
          </label>
        </>
      )}
      <label className={styles.field}>
        <span className={styles.label}>
          <T>Condition</T>
        </span>
        <Input
          mono
          value={condition}
          onChange={(e) => setCondition(e.target.value)}
          onBlur={() => updateSpecial(bp.id, { condition: condition.trim() || null })}
          aria-label="Condition"
        />
      </label>
      <label className={styles.field}>
        <span className={styles.label}>
          <T>Hit count</T>
        </span>
        <Input
          mono
          value={hitCondition}
          onChange={(e) => setHitCondition(e.target.value)}
          onBlur={() => updateSpecial(bp.id, { hitCondition: hitCondition.trim() || null })}
          aria-label="Hit count condition"
        />
      </label>
    </div>
  );
}

// --- Evaluate dialog -----------------------------------------------------------

function EvaluateDialog() {
  const state = useOverlays((s) => s.evaluate);
  if (!state) return null;
  return <EvaluateDialogInner initial={state.expression} />;
}

/**
 * IDEA's Evaluate dialog: Enter evaluates, ⇧Enter adds a line (the field grows),
 * ⇧⌘Enter / Ctrl+Shift+Enter adds a watch; ↑ on the first line / ↓ on the last walk
 * the per-project history, which the history button also lists.
 */
function EvaluateDialogInner({ initial }: { initial: string }) {
  const [expression, setExpression] = useState(initial);
  const [result, setResult] = useState<VarRoot | null>(null);
  const [history, setHistory] = useState(() => readHistory("evaluate"));
  const [historyMenu, setHistoryMenu] = useState(false);
  const historyPos = useRef(-1);
  const historyButton = useRef<HTMLSpanElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const session = useDebug((s) => (s.active != null ? s.sessions[s.active] : undefined));
  const paused = session?.status === "paused";
  const close = () => useOverlays.setState({ evaluate: null });
  const lines = Math.min(10, expression.split("\n").length);
  const run = async () => {
    const e = expression.trim();
    if (!e) return;
    pushHistory("evaluate", e);
    setHistory(readHistory("evaluate"));
    historyPos.current = -1;
    try {
      const v: Variable = await evaluate(e, "repl", session ?? null);
      setResult({ key: `eval:${e}:${Date.now()}`, kind: "eval", name: e, variable: v, error: null });
    } catch (err) {
      setResult({ key: `eval:${e}:${Date.now()}`, kind: "eval", name: e, variable: null, error: errorText(err) });
    }
  };
  const recall = (text: string) => {
    setExpression(text);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e.nativeEvent)) return;
    const el = e.currentTarget;
    if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      addWatch(expression);
    } else if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      if (paused) void run();
    } else if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !e.shiftKey && !e.altKey && !e.metaKey) {
      const before = el.value.slice(0, el.selectionStart);
      const after = el.value.slice(el.selectionEnd);
      const up = e.key === "ArrowUp";
      if (up ? before.includes("\n") : after.includes("\n")) return;
      const next = historyPos.current + (up ? 1 : -1);
      if (next < -1 || next >= history.length) return;
      e.preventDefault();
      historyPos.current = next;
      recall(next < 0 ? "" : history[next]!);
    }
  };
  return (
    <Dialog
      open
      onClose={close}
      title="Evaluate"
      width={620}
      aria-label="Evaluate expression"
      footerStart={
        <Button
          variant="ghost"
          onClick={() => {
            addWatch(expression);
            close();
          }}
          disabled={!expression.trim()}
        >
          <T>Add to Watches</T>
        </Button>
      }
      buttons={[
        { label: "Evaluate", role: "default", disabled: !paused || !expression.trim(), onClick: () => void run() },
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={styles.evalBody}>
        <div className={styles.field}>
          <span className={styles.label}>
            <T>Expression</T>
          </span>
          <div className={styles.evalInputRow}>
            <textarea
              ref={field}
              className={styles.evalInput}
              rows={lines}
              value={expression}
              onChange={(e) => {
                setExpression(e.target.value);
                historyPos.current = -1;
              }}
              onKeyDown={onKeyDown}
              onFocus={(e) => e.currentTarget.select()}
              spellCheck={false}
              autoComplete="off"
              data-autofocus=""
              aria-label="Expression"
              placeholder={paused ? "Expression to evaluate in the selected frame" : "Pause the program to evaluate"}
            />
            <span ref={historyButton}>
              <IconButton
                icon="history"
                title="History"
                size="small"
                disabled={!history.length}
                onClick={() => setHistoryMenu(true)}
              />
            </span>
          </div>
          <Menu
            open={historyMenu}
            onClose={() => setHistoryMenu(false)}
            anchor={historyButton}
            placement="bottom-end"
            aria-label="Expression history"
            items={history
              .slice(0, 20)
              .map((h) => ({ label: h.replace(/\s+/g, " "), verbatim: true, run: () => recall(h) }))}
          />
        </div>
        <div className={styles.evalResult}>
          {result ? (
            <VariablesView roots={[result]} session={session?.id ?? null} aria-label="Evaluation result" />
          ) : (
            <div className={styles.empty}>
              {paused ? "Press Enter to evaluate" : "Evaluation is available while the program is suspended"}
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}

// --- debug configuration chooser -----------------------------------------------

function ConfigChooser() {
  const state = useOverlays((s) => s.chooser);
  const close = () => useOverlays.setState({ chooser: null });
  const pick = (c: RunConfig) => {
    close();
    // Through Run (before-launch tasks, run-target checks) when it is loaded.
    void executeAction(getAction("run.debugConfig") ? "run.debugConfig" : "debug.startConfig", c);
  };
  return (
    <Dialog
      open={!!state}
      onClose={close}
      title="Debug"
      width={420}
      position="top"
      aria-label="Choose configuration to debug"
    >
      <List
        items={state?.configs ?? []}
        getKey={(c) => c.id}
        defaultActiveIndex={0}
        onActivate={(c) => pick(c)}
        aria-label="Debuggable configurations"
        className={styles.chooser}
        renderItem={(c) => (
          <div className={styles.chooserRow}>
            <Icon name="debug" size={14} />
            <span className={styles.bpName}>{c.name}</span>
            <span className={styles.bpDir}>{c.debugAdapter}</span>
          </div>
        )}
      />
    </Dialog>
  );
}

// --- Attach to Process ------------------------------------------------------------

function AttachPopup() {
  const state = useOverlays((s) => s.attach);
  const root = useProject((s) => s.project?.root ?? null);
  const [filter, setFilter] = useState("");
  const [active, setActive] = useState(0);
  const rows = useMemo(() => attachRows(state?.processes ?? [], filter), [state?.processes, filter]);
  const firstItem = rows.findIndex((r) => r.kind === "process");
  const activeIndex = rows[active]?.kind === "process" ? active : firstItem;
  if (!state) return null;
  const close = () => {
    setFilter("");
    setActive(0);
    useOverlays.setState({ attach: null });
  };
  const attach = async (p: AttachableProcess) => {
    close();
    if (!root) return;
    try {
      await startSession(await attachConfig(p, root), { rerunnable: false });
    } catch (e) {
      notifications().notify({
        group: "run",
        level: "error",
        key: "debug.attach",
        title: `Cannot attach to ${p.name} (${p.pid})`,
        body: errorText(e),
      });
    }
  };
  const move = (dir: 1 | -1) => {
    for (let i = activeIndex + dir; i >= 0 && i < rows.length; i += dir) {
      if (rows[i]!.kind === "process") {
        setActive(i);
        return;
      }
    }
  };
  return (
    <Dialog open onClose={close} title="Attach to Process" width={640} position="top" aria-label="Attach to process">
      <div className={styles.evalBody}>
        <Input
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              move(e.key === "ArrowDown" ? 1 : -1);
            } else if (e.key === "Enter") {
              e.preventDefault();
              const row = rows[activeIndex];
              if (row?.kind === "process") void attach(row.process);
            }
          }}
          placeholder="Filter by name, PID or command line"
          data-autofocus=""
          aria-label="Filter processes"
        />
        {state.processes == null ? (
          <div className={styles.empty}>
            <T>Loading processes…</T>
          </div>
        ) : state.error ? (
          <div className={styles.empty}>{state.error}</div>
        ) : (
          <List<AttachRow>
            items={rows}
            getKey={(r) => r.key}
            isSection={(r) => r.kind === "group"}
            renderSection={(r) =>
              r.kind === "group" ? (
                <div className={styles.exceptionAdapter}>
                  {r.label} · {r.count}
                </div>
              ) : null
            }
            activeIndex={activeIndex}
            onActiveChange={setActive}
            onActivate={(r) => r.kind === "process" && void attach(r.process)}
            focusable={false}
            aria-label="Processes"
            className={styles.attachList}
            empty={<div className={styles.empty}>No attachable processes{filter ? " match the filter" : ""}.</div>}
            renderItem={(r) =>
              r.kind === "process" ? (
                <div className={styles.chooserRow} title={r.process.commandLine}>
                  <span className={styles.attachPid}>{r.process.pid}</span>
                  <span className={styles.bpName}>{r.process.name}</span>
                  <span className={styles.bpDir}>{r.process.commandLine}</span>
                  <span className={styles.bpCond}>{attachDetail(r.process)}</span>
                </div>
              ) : null
            }
          />
        )}
      </div>
    </Dialog>
  );
}

// --- Smart Step Into -------------------------------------------------------------

function SmartStepChooser() {
  const all = useOverlays((s) => s.smartStep);
  // Picked in the editor instead.
  const state = all?.inline ? null : all;
  const close = () => useOverlays.setState({ smartStep: null });
  const pick = (targetId: number) => {
    if (!state) return;
    close();
    void call(commands.debugStepInTarget(state.session, state.thread, targetId)).catch((e) =>
      notifications().notify({ group: "run", level: "error", title: "Smart Step Into failed", body: errorText(e) }),
    );
  };
  return (
    <Dialog open={!!state} onClose={close} title="Step Into" width={420} position="top" aria-label="Smart Step Into">
      <List
        items={state?.targets ?? []}
        getKey={(t) => String(t.id)}
        defaultActiveIndex={0}
        onActivate={(t) => pick(t.id)}
        aria-label="Calls on the current line"
        className={styles.chooser}
        renderItem={(t) => (
          <div className={styles.chooserRow}>
            <Icon name="method" size={14} />
            <span className={styles.bpName}>{t.label}</span>
          </div>
        )}
      />
    </Dialog>
  );
}
