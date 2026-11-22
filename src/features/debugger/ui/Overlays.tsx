/** Debugger popovers and dialogs: breakpoint properties, View Breakpoints, Evaluate, config chooser. */
import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MutableRefObject,
} from "react";
import { basename, relativePath, useProject } from "@/platform/project";
import { executeAction, getAction } from "@/platform/actions";
import { editorPrefs } from "@/platform/editorSettings";
import { monoFontFamily } from "@/platform/fonts";
import type { AttachableProcess, RunConfig, Variable } from "@/platform/ipc";
import { maybeEditorService, notifications } from "@/workbench/contributions";
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  IconButton,
  Input,
  Kbd,
  List,
  MenuList,
  Popup,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Toggle,
  T,
} from "@/ui";
import { useRowHeight } from "@/ui/density";
import { isConditional, suspends, type BreakpointEntry } from "../breakpoints/model";
import {
  removeAllBreakpoints,
  removeBreakpoint,
  setMuted,
  updateBreakpoint,
  useBreakpoints,
} from "../breakpoints/store";
import { activeSession, addWatch, evaluate, isLive, startSession, useDebug } from "../state";
import { cancelSmartStep, chooseStepTarget, smartStepAnchor } from "../editor/smartStep";
import { AmbiguousClassError, rememberImport } from "../classImports";
import {
  addMethodBreakpoint,
  removeAllSpecial,
  removeSpecial,
  updateSpecial,
  useSpecialBreakpoints,
  type SpecialBreakpoint,
} from "../breakpoints/special";
import { attachConfig, attachDetail, attachRows, type AttachRow } from "../attach";
import { openAttachPopup, installAttachAdapter } from "../attachPopup";
import {
  ANY_EXCEPTION_ADAPTER,
  anyException,
  exceptionGroups,
  filterHint,
  refreshExceptionFilters,
  setAnyException,
  setExceptionFilter,
  useExceptionBreakpoints,
} from "../breakpoints/exceptions";
import {
  addExceptionClass,
  removeAllExceptionClasses,
  updateExceptionClass,
  useExceptionClasses,
  type ExceptionClassEntry,
} from "../breakpoints/exceptionClasses";
import { AnyExceptionDetail, ExceptionClassDetail } from "./ExceptionClassDetail";
import { EventBreakpointsSection } from "../js/EventBreakpointsSection";
import { StreamChainChooser } from "../streams/StreamChainChooser";
import { StreamAbortDialog } from "../streams/StreamAbortDialog";
import { closeBreakpointPopover, useOverlays } from "./popoverStore";
import { TableViewDialog } from "./TableViewDialog";
import { VariablesView, type VarRoot } from "./VariablesView";
import { useExpressionCompletion } from "./ExpressionCompletion";
import { pushHistory, readHistory } from "./expressionHistory";
import styles from "./Overlays.module.css";
import { isImeKey } from "@/platform/ime";
import { tx, txPart } from "@/platform/i18n";

export function DebuggerOverlays() {
  return (
    <>
      <BreakpointPopover />
      <BreakpointsDialog />
      <EvaluateDialog />
      <ConfigChooser />
      <AttachPopup />
      <SmartStepChooser />
      <StreamChainChooser />
      <StreamAbortDialog />
      <TableView />
    </>
  );
}

function TableView() {
  const view = useOverlays((s) => s.tableView);
  // A finished session (Stop, or Restart, which starts another id) has nothing left to show.
  const live = useDebug((s) => view != null && isLive(s.sessions[view.session]));
  useEffect(() => {
    if (view && !live) useOverlays.setState({ tableView: null });
  }, [view, live]);
  if (!view || !live) return null;
  return (
    <TableViewDialog
      key={`${view.session}:${view.expression}`}
      expression={view.expression}
      session={view.session}
      onClose={() => useOverlays.setState({ tableView: null })}
    />
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
    const changes = {
      condition: cond,
      hitCondition: d.hitCondition.trim() || null,
      logMessage: d.logEval ? d.logMessage.trim() || null : null,
    };
    if (
      changes.condition === (bp.condition ?? null) &&
      changes.hitCondition === (bp.hitCondition ?? null) &&
      changes.logMessage === (bp.logMessage ?? null)
    )
      return;
    if (cond) pushHistory("condition", cond);
    updateBreakpoint(path, bp.id, changes);
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
  | { type: "special"; key: string; bp: SpecialBreakpoint }
  | { type: "anyException"; key: string }
  | { type: "exceptionClass"; key: string; bp: ExceptionClassEntry };

const ANY_EXCEPTION_KEY = "any-exception";

function BreakpointLocation({ path, line }: { path: string; line: number }) {
  return (
    <span className={styles.bpLocation} title={`${path}:${line + 1}`}>
      <span className={styles.bpName}>{basename(path)}</span>
      <span className={styles.bpLine}>:{line + 1}</span>
    </span>
  );
}

function BreakpointsDialog() {
  const state = useOverlays((s) => s.breakpoints);
  const byFile = useBreakpoints((s) => s.byFile);
  const status = useBreakpoints((s) => s.status);
  const muted = useBreakpoints((s) => s.muted);
  const methods = useSpecialBreakpoints((s) => s.methods);
  const fields = useSpecialBreakpoints((s) => s.fields);
  const specialStatus = useSpecialBreakpoints((s) => s.status);
  const exceptionClasses = useExceptionClasses((s) => s.list);
  const knownFilters = useExceptionBreakpoints((s) => s.known);
  const filterChoices = useExceptionBreakpoints((s) => s.choices);
  const any = anyException(knownFilters, filterChoices);
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
    section("Java Exception Breakpoints", [
      { type: "anyException", key: ANY_EXCEPTION_KEY },
      ...exceptionClasses.map((bp) => ({ type: "exceptionClass" as const, key: bp.id, bp })),
    ]);
    return out;
  }, [byFile, methods, fields, exceptionClasses]);
  const items = rows.filter((r) => r.type !== "section");
  const [selected, setSelected] = useState<string | null>(null);
  // The shown breakpoint's typed fields, saved before it is closed or another one is shown:
  // Enter on Done and a click on a row don't blur them.
  const commitRef = useRef<(() => void) | null>(null);
  const open = !!state;
  const layout = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);
  useLayoutEffect(() => {
    const el = layout.current;
    if (!open || !el) return;
    const update = () => setStacked(el.clientWidth > 0 && el.clientWidth < 560);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open]);
  const current = items.find((r) => r.key === (selected ?? state?.id)) ?? items[0];
  const close = () => {
    commitRef.current?.();
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
    removeAllExceptionClasses();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Breakpoints"
      className={styles.bpWindow}
      width={760}
      minWidth={400}
      minHeight={340}
      resizable="both"
      aria-label="Breakpoints"
      buttons={[{ label: "Done", role: "default", onClick: close }]}
    >
      <SplitGroup
        elementRef={layout}
        orientation={stacked ? "vertical" : "horizontal"}
        storageKey={stacked ? "openidea.debug.breakpoints.stacked" : "openidea.debug.breakpoints.split"}
        className={styles.bpDialog}
      >
        <SplitPanel id="breakpoint-list" defaultSize={stacked ? "42%" : "35%"} minSize={stacked ? "34%" : "216px"}>
          <div className={styles.bpListHeader}>
            <Toggle checked={muted} onChange={setMuted} label="Mute breakpoints" />
            <div className={styles.bpListActions}>
              <IconButton
                icon="plus"
                title="Add Method Breakpoint"
                size="small"
                onClick={() => setSelected(addMethodBreakpoint("").id)}
              />
              <IconButton
                icon="breakpoint-exception"
                title="Add Java Exception Breakpoint"
                size="small"
                onClick={() => setSelected(addExceptionClass("").id)}
              />
              <IconButton
                icon="trash"
                title="Remove All Breakpoints"
                size="small"
                disabled={!items.some((r) => r.type !== "anyException")}
                onClick={removeAll}
              />
            </div>
          </div>
          <List
            items={rows}
            getKey={(r) => r.key}
            isSection={(r) => r.type === "section"}
            renderSection={(r) => (
              <div className={styles.exceptionAdapter}>{r.type === "section" ? tx(r.label) : ""}</div>
            )}
            activeIndex={current ? rows.indexOf(current) : -1}
            onActiveChange={(i) => {
              commitRef.current?.();
              setSelected(rows[i]?.key ?? null);
            }}
            // A click selects; double-click or Enter goes to the source.
            onActivate={(r, _i, e) => {
              if (e.type === "keydown" || e.detail > 1) goTo(r);
            }}
            aria-label="All breakpoints"
            className={styles.bpList}
            empty={
              <div className={styles.empty}>
                <T>No breakpoints. Click a line number to add one.</T>
              </div>
            }
            renderItem={(r) => {
              if (r.type === "section") return null;
              if (r.type === "anyException") {
                return (
                  <div className={styles.bpRow}>
                    <Checkbox
                      checked={any.caught || any.uncaught}
                      onChange={(on) => {
                        setAnyException("caught", on);
                        setAnyException("uncaught", on);
                      }}
                      aria-label={tx("Enable Any exception")}
                    />
                    <Icon name="breakpoint-exception" size={14} />
                    <span className={styles.bpName}>
                      <T>Any exception</T>
                    </span>
                  </div>
                );
              }
              if (r.type === "exceptionClass") {
                const name = r.bp.className || tx("No class chosen");
                return (
                  <div className={styles.bpRow}>
                    <Checkbox
                      checked={r.bp.enabled}
                      onChange={(enabled) => updateExceptionClass(r.bp.id, { enabled })}
                      aria-label={tx`Enable ${r.bp.className || txPart("No class chosen")}`}
                    />
                    <Icon name="breakpoint-exception" size={14} />
                    <span className={styles.bpName} title={name}>
                      {name}
                    </span>
                  </div>
                );
              }
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
                    <span className={styles.bpName} title={specialTitle(r.bp)}>
                      {specialTitle(r.bp)}
                    </span>
                    {r.bp.path && (
                      <span className={styles.bpDir}>
                        {basename(r.bp.path)}
                        {r.bp.line != null ? `:${r.bp.line + 1}` : ""}
                      </span>
                    )}
                    {st && !st.verified && isLive(activeSession()) && (
                      <span className={styles.bpCond}>
                        <T>unverified</T>
                      </span>
                    )}
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
                  <BreakpointLocation path={r.path} line={r.bp.line} />
                  <span className={styles.bpDir}>{relativePath(root, r.path)}</span>
                  {isConditional(r.bp) && <span className={styles.bpCond}>{suspends(r.bp) ? "if" : "log"}</span>}
                  {r.bp.temporary && (
                    <span className={styles.bpCond}>
                      <T>temp</T>
                    </span>
                  )}
                </div>
              );
            }}
          />
          <div className={styles.bpAuxiliary}>
            <ExceptionBreakpoints open={open} />
            <EventBreakpointsSection />
          </div>
        </SplitPanel>
        <SplitHandle />
        <SplitPanel id="breakpoint-detail" minSize={stacked ? "42%" : "284px"}>
          <div className={styles.bpDetail}>
            {current?.type === "line" ? (
              <BreakpointDetail key={current.key} row={current} onGo={() => goTo(current)} commitRef={commitRef} />
            ) : current?.type === "special" ? (
              <SpecialDetail key={current.key} bp={current.bp} onGo={() => goTo(current)} commitRef={commitRef} />
            ) : current?.type === "exceptionClass" ? (
              <ExceptionClassDetail key={current.key} bp={current.bp} commitRef={commitRef} />
            ) : current?.type === "anyException" ? (
              <AnyExceptionDetail />
            ) : null}
          </div>
        </SplitPanel>
      </SplitGroup>
    </Dialog>
  );
}

/** Exception breakpoint filters offered by the debug adapters (checkbox per filter). */
function ExceptionBreakpoints({ open }: { open: boolean }) {
  const known = useExceptionBreakpoints((s) => s.known);
  const choices = useExceptionBreakpoints((s) => s.choices);
  // java-debug's filters are "Any exception" in the list above.
  const groups = useMemo(
    () => exceptionGroups(known, choices).filter((g) => g.adapter !== ANY_EXCEPTION_ADAPTER),
    [known, choices],
  );
  useEffect(() => {
    if (open) void refreshExceptionFilters();
  }, [open]);
  return (
    <section className={styles.exceptions} aria-label={tx("Exception breakpoints")}>
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
              <Fragment key={f.filter}>
                <span title={f.description ?? undefined} className={styles.exceptionRow}>
                  <Checkbox
                    checked={f.enabled}
                    onChange={(on) => setExceptionFilter(g.adapter, f.filter, on)}
                    label={f.label}
                  />
                </span>
                {filterHint(g.adapter, f.filter) && (
                  <div className={styles.exceptionHint}>{tx(filterHint(g.adapter, f.filter)!)}</div>
                )}
              </Fragment>
            ))}
          </div>
        ))
      )}
    </section>
  );
}

function BreakpointDetail({
  row,
  onGo,
  commitRef,
}: {
  row: BpRow;
  onGo: () => void;
  commitRef: MutableRefObject<(() => void) | null>;
}) {
  const { path, bp } = row;
  const st = useBreakpoints((s) => s.status[bp.id]);
  return (
    <div className={styles.detail}>
      <div className={styles.bpTitle}>
        <BreakpointLocation path={path} line={bp.line} />
        <Button size="small" variant="ghost" onClick={onGo}>
          <T>Go to Source</T>
        </Button>
        <Button size="small" variant="ghost" onClick={() => removeBreakpoint(path, bp.id)}>
          <T>Remove</T>
        </Button>
      </div>
      {st && <div className={styles.statusLine}>{st.verified ? tx("Verified") : (st.message ?? "Not verified")}</div>}
      <BreakpointFields path={path} bp={bp} commitRef={commitRef} />
      <Checkbox
        checked={!!bp.temporary}
        onChange={(temporary) => updateBreakpoint(path, bp.id, { temporary })}
        label="Remove once hit"
      />
    </div>
  );
}

function SpecialDetail({
  bp,
  onGo,
  commitRef,
}: {
  bp: SpecialBreakpoint;
  onGo: () => void;
  commitRef: MutableRefObject<(() => void) | null>;
}) {
  const st = useSpecialBreakpoints((s) => s.status[bp.id]);
  const [name, setName] = useState(bp.kind === "method" ? bp.name : bp.label);
  const [condition, setCondition] = useState(bp.condition ?? "");
  const [hitCondition, setHitCondition] = useState(bp.hitCondition ?? "");
  const draft = useRef({ name, condition, hitCondition });
  useEffect(() => {
    draft.current = { name, condition, hitCondition };
    commitRef.current = () => {
      const d = draft.current;
      updateSpecial(bp.id, {
        name: d.name.trim(),
        condition: d.condition.trim() || null,
        hitCondition: d.hitCondition.trim() || null,
      });
    };
    return () => {
      commitRef.current = null;
    };
  });
  return (
    <div className={styles.detail}>
      <div className={styles.bpTitle}>
        <Icon name={bp.kind === "method" ? "breakpoint-method" : "breakpoint-field"} size={14} />
        <span className={styles.bpFile} title={specialTitle(bp)}>
          {specialTitle(bp)}
        </span>
        {bp.path && (
          <Button size="small" variant="ghost" onClick={onGo}>
            <T>Go to Source</T>
          </Button>
        )}
        <Button size="small" variant="ghost" onClick={() => removeSpecial(bp.id)}>
          <T>Remove</T>
        </Button>
      </div>
      {st && <div className={styles.statusLine}>{st.verified ? tx("Verified") : (st.message ?? "Not verified")}</div>}
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
          <div className={styles.statusLine}>{tx`Watching ${bp.dataId}`}</div>
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
  const [ambiguous, setAmbiguous] = useState<AmbiguousClassError | null>(null);
  const [history, setHistory] = useState(() => readHistory("evaluate"));
  const [historyMenu, setHistoryMenu] = useState(false);
  const historyPos = useRef(-1);
  const expressionRow = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const expressionId = useId();
  const resultTitleId = useId();
  const settings = useProject((s) => s.settings);
  const editor = settings?.editor;
  const font = {
    "--evaluate-font": monoFontFamily(editor?.fontFamily, editorPrefs(settings).fallbackFont, "var(--font-mono)"),
    "--evaluate-font-size": editor?.fontSize ? `${editor.fontSize}px` : undefined,
    "--evaluate-line-height": editor?.lineHeight ? `${editor.lineHeight}px` : undefined,
  } as CSSProperties;
  const session = useDebug((s) => (s.active != null ? s.sessions[s.active] : undefined));
  const paused = session?.status === "paused";
  const close = () => useOverlays.setState({ evaluate: null });
  const lines = Math.min(10, expression.split("\n").length);
  const completion = useExpressionCompletion(field, expression, setExpression, session);
  const run = async () => {
    const e = expression.trim();
    if (!e) return;
    pushHistory("evaluate", e);
    setHistory(readHistory("evaluate"));
    historyPos.current = -1;
    setAmbiguous(null);
    try {
      const v: Variable = await evaluate(e, session?.adapter === "gdb" ? "watch" : "repl", session ?? null);
      setResult({ key: `eval:${e}:${Date.now()}`, kind: "eval", name: e, variable: v, error: null });
    } catch (err) {
      setResult({ key: `eval:${e}:${Date.now()}`, kind: "eval", name: e, variable: null, error: errorText(err) });
      if (err instanceof AmbiguousClassError) setAmbiguous(err);
    }
  };
  const className = ambiguous?.className ?? "";
  const recall = (text: string) => {
    setExpression(text);
    setAmbiguous(null);
    requestAnimationFrame(() => {
      const el = field.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(text.length, text.length);
    });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isImeKey(e.nativeEvent) || completion.onKeyDown(e)) return;
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
      minWidth={340}
      minHeight={240}
      resizable="both"
      className={styles.evalDialog}
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
        <div className={styles.evalExpression}>
          <label className={styles.label} htmlFor={expressionId}>
            <T>Expression</T>
          </label>
          <div ref={expressionRow} className={styles.evalInputRow} style={font}>
            <textarea
              ref={field}
              id={expressionId}
              className={styles.evalInput}
              rows={lines}
              value={expression}
              onChange={(e) => {
                setExpression(e.target.value);
                setAmbiguous(null);
                historyPos.current = -1;
                completion.onInput();
              }}
              onKeyDown={onKeyDown}
              onBlur={completion.close}
              onFocus={(e) => {
                setHistoryMenu(false);
                e.currentTarget.select();
              }}
              spellCheck={false}
              autoComplete="off"
              data-autofocus=""
              placeholder={tx(
                paused ? "Expression to evaluate in the selected frame" : "Pause the program to evaluate",
              )}
            />
            {completion.popup}
            <IconButton
              className={styles.evalHistory}
              icon="chevron-down"
              title="History"
              size="small"
              aria-haspopup="menu"
              aria-expanded={historyMenu}
              disabled={!history.length}
              onClick={() => setHistoryMenu((open) => !open)}
            />
          </div>
          <Popup
            open={historyMenu}
            onClose={() => setHistoryMenu(false)}
            anchor={expressionRow}
            placement="bottom-start"
            matchWidth
            role="presentation"
            autoFocus={false}
            className={styles.evalHistoryPopup}
            style={font}
          >
            <MenuList
              aria-label={tx("Expression history")}
              iconColumn={false}
              onDone={() => setHistoryMenu(false)}
              items={history
                .slice(0, 20)
                .map((h) => ({ label: h.replace(/\s+/g, " "), verbatim: true, run: () => recall(h) }))}
            />
          </Popup>
        </div>
        <section className={styles.evalResult} aria-labelledby={resultTitleId}>
          <span id={resultTitleId} className={styles.label}>
            <T>Result</T>
          </span>
          <div className={styles.evalResultContent}>
            {ambiguous && (
              <div className={styles.evalImport} role="group" aria-label={tx("Class to import")}>
                <span className={styles.label}>{tx`Choose the class to import for ${className}:`}</span>
                {ambiguous.candidates.map((c) => (
                  <Button
                    key={c}
                    variant="ghost"
                    size="small"
                    onClick={() => {
                      if (session) rememberImport(session.id, c);
                      void run();
                    }}
                  >
                    {c}
                  </Button>
                ))}
              </div>
            )}
            {result ? (
              <VariablesView roots={[result]} session={session?.id ?? null} aria-label="Evaluation result" />
            ) : (
              <div className={styles.evalHint}>
                {paused ? tx("Press Enter to evaluate") : tx("Evaluation is available while the program is suspended")}
              </div>
            )}
          </div>
        </section>
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
  const [installing, setInstalling] = useState(false);
  const gridId = useId();
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
    if (state.projectRoot !== undefined && state.projectRoot !== root) return close();
    close();
    if (!root) return;
    try {
      await startSession(await attachConfig(p, root), { rerunnable: false, runConfig: state.runConfig });
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
    <Dialog
      open
      onClose={close}
      title={state.mode === "unity" ? "Attach to Unity Process" : "Attach to Process"}
      width={780}
      minWidth={360}
      minHeight={300}
      resizable="both"
      dismissOnBackdrop
      closeOnDeactivate
      className={styles.attachDialog}
      aria-label={state.mode === "unity" ? "Attach to Unity Process" : "Attach to process"}
      buttons={[
        {
          label: "Refresh",
          role: "extra",
          disabled: state.processes === null || installing,
          onClick: () => {
            setActive(0);
            void openAttachPopup(state.mode, state.runConfig);
          },
        },
        { label: "Cancel", role: "cancel", onClick: close },
        {
          label: "Attach",
          role: "default",
          disabled: rows[activeIndex]?.kind !== "process" || installing,
          onClick: () => {
            const row = rows[activeIndex];
            if (row?.kind === "process") void attach(row.process);
          },
        },
      ]}
    >
      <div className={styles.attachContent}>
        {state.mode === "unity" && (
          <p>
            <T>
              Open the project in Unity Editor, enable Editor Attaching and switch to Debug Mode. Select its process
              below. Stopping debugging disconnects without closing Unity.
            </T>
          </p>
        )}
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
          aria-controls={state.processes !== null && !state.error ? gridId : undefined}
        />
        {state.processes == null ? (
          <div className={styles.empty}>
            <T>Loading processes…</T>
          </div>
        ) : state.error ? (
          <div className={styles.empty}>
            <div>{state.error}</div>
            {state.installTool && (
              <Button
                disabled={installing}
                onClick={() => {
                  setInstalling(true);
                  void installAttachAdapter().finally(() => setInstalling(false));
                }}
              >
                {installing ? "Installing…" : "Install Unity Debugger"}
              </Button>
            )}
          </div>
        ) : (
          <div
            id={gridId}
            className={styles.attachGrid}
            role="grid"
            aria-label={tx("Processes")}
            aria-rowcount={rows.filter((r) => r.kind === "process").length + 1}
          >
            <div role="rowgroup">
              <div className={styles.attachHeader} role="row" aria-rowindex={1}>
                <span role="columnheader">
                  <T>Executable</T>
                </span>
                <span role="columnheader" className={styles.attachPid}>
                  <T>PID</T>
                </span>
                <span role="columnheader">
                  <T>Command line</T>
                </span>
              </div>
            </div>
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
              tableBody={{ headerRows: 1 }}
              className={styles.attachList}
              empty={
                <div className={styles.empty}>
                  {filter
                    ? tx`No attachable processes match the filter.`
                    : state.mode === "unity"
                      ? tx`No Unity Editor processes found. Open Unity Editor, then refresh.`
                      : tx`No attachable processes.`}
                </div>
              }
              renderItem={(r) => {
                if (r.kind !== "process") return null;
                const { name, pid, commandLine, port } = r.process;
                const endpoint = port == null ? null : attachDetail(r.process);
                return (
                  <div className={styles.attachRow} role="presentation">
                    <span className={styles.attachCell} role="gridcell" title={name}>
                      {name}
                    </span>
                    <span className={styles.attachPid} role="gridcell">
                      {pid}
                    </span>
                    <span className={styles.attachCommand} role="gridcell">
                      <span className={styles.attachCell} title={commandLine}>
                        {commandLine}
                      </span>
                      {endpoint && (
                        <span className={styles.attachEndpoint} title={endpoint}>
                          <span className={styles.attachFullAddress}>{endpoint}</span>
                          <span className={styles.attachPort}>:{port}</span>
                        </span>
                      )}
                    </span>
                  </div>
                );
              }}
            />
          </div>
        )}
      </div>
    </Dialog>
  );
}

// --- Smart Step Into -------------------------------------------------------------

function SmartStepChooser() {
  const all = useOverlays((s) => s.smartStep);
  const state = all?.inline ? null : all;
  const anchor = useMemo(() => (state ? smartStepAnchor() : "center"), [state]);
  const rowHeight = useRowHeight();
  if (!state) return null;

  return (
    <Popup
      open
      anchor={anchor}
      placement="top-start"
      onClose={cancelSmartStep}
      trapFocus
      className={styles.stepPopup}
      aria-label={tx("Smart Step Into")}
    >
      <div className={styles.stepHeading}>
        <T>Step Into</T>
      </div>
      <div className={styles.stepTargets} style={{ height: Math.min(state.targets.length, 8) * rowHeight }}>
        <List
          items={state.targets}
          getKey={(t) => String(t.id)}
          rowHeight={rowHeight}
          autoFocus
          hoverSelects
          onActivate={(t) => chooseStepTarget(t.id)}
          aria-label={tx("Calls on the current line")}
          className={styles.stepList}
          renderItem={(t) => (
            <>
              <Icon name="method" size={16} />
              <span className={styles.stepLabel} title={t.label}>
                {t.label}
              </span>
            </>
          )}
        />
      </div>
    </Popup>
  );
}
