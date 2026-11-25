/** Lazy variables tree (scopes, locals, watches, evaluation results). */
import { writeClipboardText } from "@/platform/clipboard";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { call, commands, type DebugSessionId, type Variable } from "@/platform/ipc";
import { Dialog, Icon, Tree, acquirePopup, showContextMenu, type MenuItem, type TreeHandle } from "@/ui";
import { formatMessage, tx } from "@/platform/i18n";
import { fontWeightOf } from "@/platform/editorSettings";
import { resolveMonoFont } from "@/platform/fonts";
import { useProject } from "@/platform/project";
import { activeEditor } from "@/editor/api";
import { notifications } from "@/workbench/contributions";
import { addFieldWatchpoint } from "../breakpoints/special";
import { methodAt } from "../breakpoints/symbols";
import {
  activeSession,
  addWatch,
  evaluate,
  removeAllWatches,
  removeWatch,
  revealFrame,
  rootOf,
  sessionSupports,
  setVariableValue,
  useDebug,
} from "../state";
import { blurDebugView, focusDebugView } from "./focusedView";
import { openTableView } from "./popoverStore";
import { isTableType } from "../tableView";
import { classifyValue, oneLine, shownValue, sortVariables } from "../values";
import { stringText, valueText } from "../valueText";
import { workflowSettings } from "@/platform/workflowSettings";
import styles from "./VariablesView.module.css";

export type VarRoot =
  | { key: string; kind: "eval" | "watch"; name: string; variable: Variable | null; error: string | null }
  | { key: string; kind: "scope"; name: string; reference: number; expensive: boolean }
  /** `container`: variablesReference of the scope / object holding the variable (for Set Value). */
  | { key: string; kind: "var"; variable: Variable; container?: number };

interface VarNode {
  key: string;
  kind: "eval" | "watch" | "scope" | "var" | "message";
  name: string;
  value: string;
  typeName: string | null;
  reference: number;
  evaluateName: string | null;
  error: string | null;
  depth0: boolean;
  /** variablesReference of the parent (0 when unknown). */
  container: number;
  /** `value` is not computed yet; `reference` holds it as a single nameless variable. */
  lazy: boolean;
}

function fromRoot(r: VarRoot): VarNode {
  switch (r.kind) {
    case "scope":
      return {
        key: r.key,
        kind: "scope",
        name: r.name,
        value: "",
        typeName: null,
        reference: r.reference,
        evaluateName: null,
        error: null,
        depth0: true,
        container: 0,
        lazy: false,
      };
    case "var":
      return fromVariable(r.key, r.variable, r.container ?? 0, true);
    default:
      return {
        key: r.key,
        kind: r.kind,
        name: r.name,
        value: r.variable?.value ?? "",
        typeName: r.variable?.typeName ?? null,
        reference: r.variable?.variablesReference ?? 0,
        evaluateName: r.variable?.evaluateName ?? r.name,
        error: r.error,
        depth0: true,
        container: 0,
        lazy: !!r.variable?.lazy,
      };
  }
}

function fromVariable(key: string, v: Variable, container: number, depth0 = false): VarNode {
  return {
    key,
    kind: "var",
    name: v.name,
    value: v.value,
    typeName: v.typeName,
    reference: v.variablesReference,
    evaluateName: v.evaluateName,
    error: null,
    depth0,
    container,
    lazy: !!v.lazy,
  };
}

function toVariable(n: VarNode): Variable {
  return {
    name: n.name,
    value: n.value,
    typeName: n.typeName,
    variablesReference: n.reference,
    evaluateName: n.evaluateName,
    lazy: n.lazy,
  };
}

function message(key: string, text: string): VarNode {
  return {
    key,
    kind: "message",
    name: text,
    value: "",
    typeName: null,
    reference: 0,
    evaluateName: null,
    error: null,
    depth0: false,
    container: 0,
    lazy: false,
  };
}

/**
 * Values changed since the previous stop (IDEA paints them in a
 * distinct colour). Values are remembered per
 * `scope` (e.g. thread + frame depth) so switching frames doesn't compare unrelated locals.
 */
export class ValueChanges {
  private scopes = new Map<string, { epoch: number; prev: Map<string, string>; cur: Map<string, string> }>();

  /** Starts `epoch` for `scope`: the values seen in the earlier epoch become the baseline. */
  enter(scope: string, epoch: number) {
    const s = this.scopes.get(scope);
    if (!s) {
      if (this.scopes.size >= 64) this.scopes.delete(this.scopes.keys().next().value!);
      this.scopes.set(scope, { epoch, prev: new Map(), cur: new Map() });
    } else if (s.epoch !== epoch) {
      s.prev = s.cur.size ? s.cur : s.prev;
      s.cur = new Map();
      s.epoch = epoch;
    }
  }

  record(scope: string, key: string, value: string) {
    this.scopes.get(scope)?.cur.set(key, value);
  }

  changed(scope: string, key: string, value: string): boolean {
    const prev = this.scopes.get(scope)?.prev.get(key);
    return prev !== undefined && prev !== value;
  }
}

/** Per stop (`gen`): loaded children by parent key, and lazy rows whose value was computed. */
interface ViewCache {
  gen: number;
  map: Map<string, VarNode[]>;
  resolved: Map<string, VarNode>;
}

const emptyCache = (gen: number): ViewCache => ({ gen, map: new Map(), resolved: new Map() });

/** `c` for stop `gen` with `next` in place of the row of the same key. */
function withResolved(c: ViewCache, gen: number, next: VarNode): ViewCache {
  const base = c.gen === gen ? c : emptyCache(gen);
  const map = new Map(base.map);
  for (const [parent, list] of map)
    if (list.some((n) => n.key === next.key))
      map.set(
        parent,
        list.map((n) => (n.key === next.key ? next : n)),
      );
  return { gen, map, resolved: new Map(base.resolved).set(next.key, next) };
}

/** A lazy row with its value computed; a failure shows on the row. */
function computeLazy(session: DebugSessionId, node: VarNode): Promise<VarNode> {
  return call(commands.debugResolveVariable(session, toVariable(node))).then(
    // Still lazy: the adapter gave no single value, so the row opens as an ordinary one.
    (v) => ({ ...fromVariable(node.key, v, node.container, node.depth0), kind: node.kind, lazy: false }),
    (e) => ({ ...node, lazy: false, reference: 0, error: e instanceof Error ? e.message : String(e) }),
  );
}

const tracksChanges = (n: VarNode) => (n.kind === "var" || n.kind === "watch") && !n.error;

/** Shared by every view: the variables pane remounts while the program runs between stops. */
const valueChanges = new ValueChanges();

export interface VariablesViewProps {
  roots: VarRoot[];
  session: DebugSessionId | null;
  /** Changing it drops loaded children (new stop); expansion is kept and re-loaded. */
  generation?: number;
  /** Highlight values changed since the previous `epoch` (stop) within the same `scope`. */
  changes?: { epoch: number; scope: string };
  /** Keys of nodes expanded initially (e.g. the root of a value hint). */
  defaultExpanded?: readonly string[];
  /** Keyboard focus goes to the tree on mount. */
  autoFocus?: boolean;
  "aria-label"?: string;
  className?: string;
}

export function VariablesView({
  roots,
  session,
  generation = 0,
  changes,
  defaultExpanded,
  autoFocus,
  className,
  ...aria
}: VariablesViewProps) {
  const [cache, setCache] = useState<ViewCache>(() => emptyCache(generation));
  const current = cache.gen === generation ? cache : null;
  const children = current?.map ?? null;
  const resolved = current?.resolved ?? null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded));
  const loading = useRef(new Set<string>());
  const tree = useRef<TreeHandle>(null);

  const nodes = useMemo(
    () =>
      roots.map((r) => {
        const n = fromRoot(r);
        return resolved?.get(n.key) ?? n;
      }),
    [roots, resolved],
  );
  const byKey = useMemo(() => {
    const m = new Map<string, VarNode>();
    const walk = (list: readonly VarNode[]) =>
      list.forEach((n) => {
        m.set(n.key, n);
        const c = children?.get(n.key);
        if (c) walk(c);
      });
    walk(nodes);
    return m;
  }, [nodes, children]);

  if (changes) valueChanges.enter(changes.scope, changes.epoch);
  const changeScope = changes?.scope;
  useEffect(() => {
    if (changeScope == null) return;
    for (const n of byKey.values()) if (tracksChanges(n)) valueChanges.record(changeScope, n.key, n.value);
  }, [byKey, changeScope]);
  const isChanged = (n: VarNode) =>
    !!changes && tracksChanges(n) && valueChanges.changed(changes.scope, n.key, n.value);

  useEffect(() => {
    if (autoFocus) tree.current?.focus();
  }, [autoFocus]);

  const resolve = useCallback(
    async (node: VarNode): Promise<VarNode> => {
      if (session == null || !node.lazy) return node;
      const next = await computeLazy(session, node);
      setCache((c) => withResolved(c, generation, next));
      return next;
    },
    [session, generation],
  );

  const load = useCallback(
    async (opened: VarNode) => {
      if (session == null || opened.reference <= 0) return;
      const { key } = opened;
      const tag = `${generation}:${key}`;
      if (loading.current.has(tag)) return;
      loading.current.add(tag);
      let list: VarNode[] = [];
      let computed: VarNode | null = null;
      try {
        // Opening a lazy row computes its value first: its own reference holds only that value.
        if (opened.lazy) computed = await computeLazy(session, opened);
        const node = computed ?? opened;
        if (node.reference > 0) {
          const raw = await call(commands.debugVariables(session, node.reference));
          const vars = workflowSettings().debugger.sortValues ? sortVariables(raw) : raw;
          const seen = new Map<string, number>();
          list = vars.map((v) => {
            const n = (seen.get(v.name) ?? 0) + 1;
            seen.set(v.name, n);
            return fromVariable(`${key}/${v.name}${n > 1 ? `#${n}` : ""}`, v, node.reference);
          });
          if (!list.length) list = [message(`${key}/\u0000empty`, "No variables")];
        }
      } catch (e) {
        list = [message(`${key}/\u0000error`, e instanceof Error ? e.message : String(e))];
      } finally {
        loading.current.delete(tag);
      }
      setCache((c) => {
        const base = computed
          ? withResolved(c, generation, computed)
          : c.gen === generation
            ? c
            : emptyCache(generation);
        return { ...base, map: new Map(base.map).set(key, list) };
      });
    },
    [session, generation],
  );

  // Re-load children of nodes that stay expanded across steps (and non-expensive scopes on first show).
  useEffect(() => {
    for (const n of byKey.values()) {
      const wants = expanded.has(n.key);
      if (wants && n.reference > 0 && !children?.has(n.key)) void load(n);
    }
  }, [byKey, expanded, children, load]);

  const [editing, setEditing] = useState<{ key: string; value: string; error: string | null } | null>(null);
  const [valuePopup, setValuePopup] = useState<VarNode | null>(null);
  const editable = (n: VarNode | undefined): n is VarNode =>
    !!n && session != null && (n.kind === "var" || n.kind === "watch") && (n.container > 0 || !!n.evaluateName);
  const startEdit = (n: VarNode) => setEditing({ key: n.key, value: n.value, error: null });
  const commitEdit = async () => {
    const e = editing;
    const node = e ? byKey.get(e.key) : undefined;
    if (!e || !node) return setEditing(null);
    if (e.value === node.value) {
      setEditing(null);
      tree.current?.focus();
      return;
    }
    try {
      await setVariableValue({ container: node.container, name: node.name, evaluateName: node.evaluateName }, e.value);
      setEditing(null);
      tree.current?.focus();
    } catch (err) {
      setEditing({ ...e, error: err instanceof Error ? err.message : String(err) });
    }
  };

  const leadNode = () => {
    const lead = tree.current?.leadKey();
    return lead ? byKey.get(lead) : undefined;
  };
  const viewCommands = () => ({
    view: "variables" as const,
    setValue: () => {
      const node = leadNode();
      if (editable(node)) startEdit(node);
    },
    jumpToSource: () => {
      const node = leadNode();
      if (node) void jumpToDeclaration(node);
    },
  });
  const canWatch = (n: VarNode) =>
    session != null && n.kind === "var" && n.container > 0 && sessionSupports("dataBreakpoints");

  const copyValue = async (row: VarNode) => {
    const node = await resolve(row);
    let text = node.value;
    const paused = session != null ? useDebug.getState().sessions[session] : undefined;
    if (paused?.status === "paused" && node.reference <= 0 && node.evaluateName) {
      // A long string arrives cut short; evaluating it for the clipboard returns all of it.
      text = await evaluate(node.evaluateName, "clipboard", paused).then(
        (v) => v.value || text,
        () => text,
      );
    } else if (session != null && node.reference > 0) {
      try {
        text = await valueText(node, (ref) => call(commands.debugVariables(session, ref)));
      } catch (e) {
        notifications().notify({
          group: "run",
          level: "error",
          key: "debug.copyValue",
          title: "Cannot copy the value",
          body: e instanceof Error ? e.message : String(e),
        });
        return;
      }
    }
    await writeClipboardText(text);
  };

  const onContextMenu = (node: VarNode | null, _sel: Set<string>, e: React.MouseEvent) => {
    if (!node || node.kind === "message" || node.kind === "scope") return;
    e.preventDefault();
    const items: MenuItem[] = [];
    if (node.kind === "watch")
      items.push(
        { label: "Remove Watch", icon: "minus", run: () => removeWatch(node.name) },
        { label: "Remove All Watches", run: removeAllWatches },
        { kind: "separator" },
      );
    if (editable(node)) items.push({ label: "Set Value…", icon: "edit", shortcut: "F2", run: () => startEdit(node) });
    const tableExpression = node.evaluateName;
    if (tableExpression && session != null && isTableType(node.typeName) && pausedIn(session)?.adapter === "debugpy")
      items.push({ label: "View as Table", run: () => openTableView(tableExpression, session) });
    items.push(
      { label: "Copy Value", icon: "copy", run: () => void copyValue(node) },
      { label: "Copy Name", run: () => void writeClipboardText(node.name) },
    );

    const watchActions: MenuItem[] = [];
    const expression = node.evaluateName;
    if (node.kind === "var" && expression)
      watchActions.push({ label: "Add to Watches", icon: "eye", run: () => addWatch(expression) });
    if (canWatch(node))
      watchActions.push({
        label: "Add Field Watchpoint",
        icon: "breakpoint-field",
        run: () => void addWatchpointFor(session!, node),
      });
    if (watchActions.length) items.push({ kind: "separator" }, ...watchActions);

    items.push(
      { kind: "separator" },
      { label: "Jump to Source", shortcut: "F4", run: () => void jumpToDeclaration(node) },
    );
    showContextMenu(e, items);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (editing) return;
    const lead = tree.current?.leadKey();
    const node = lead ? byKey.get(lead) : undefined;
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    if (node?.kind === "watch") {
      e.preventDefault();
      removeWatch(node.name);
    }
  };

  return (
    <div
      className={clsx(styles.root, className)}
      onKeyDown={onKeyDown}
      onFocus={() => focusDebugView(viewCommands())}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) blurDebugView("variables");
      }}
    >
      <Tree<VarNode>
        roots={nodes}
        getKey={(n) => n.key}
        getLabel={(n) => n.name}
        getChildren={(n) => children?.get(n.key)}
        isExpandable={(n) => n.reference > 0}
        loadChildren={(n) => load(n)}
        expanded={expanded}
        onExpandedChange={(next) => setExpanded(next)}
        multiSelect={false}
        onContextMenu={onContextMenu}
        handleRef={tree}
        aria-label={aria["aria-label"] ?? "Variables"}
        renderNode={(n) =>
          editing?.key === n.key ? (
            <VarEditRow
              node={n}
              changed={isChanged(n)}
              value={editing.value}
              error={editing.error}
              onChange={(value) => setEditing({ ...editing, value, error: null })}
              onCommit={() => void commitEdit()}
              onCancel={() => {
                setEditing(null);
                tree.current?.focus();
              }}
            />
          ) : (
            <VarRow node={n} changed={isChanged(n)} onShowValue={setValuePopup} onResolve={(n) => void resolve(n)} />
          )
        }
      />
      {valuePopup && <ValueDialog node={valuePopup} session={session} onClose={() => setValuePopup(null)} />}
    </div>
  );
}

/** The session with this id while it is paused, with the adapter its root session started. */
function pausedIn(session: DebugSessionId | null) {
  const s = session != null ? useDebug.getState().sessions[session] : undefined;
  return s?.status === "paused" ? rootOf(s) : null;
}

/**
 * View: the whole value in a popup that a click outside closes. Adapters cut long strings
 * short in variables; the value is evaluated again as for copying (`clipboard`), which
 * returns it in full, and a string shows as its text, line breaks included.
 */
function ValueDialog({
  node,
  session,
  onClose,
}: {
  node: VarNode;
  session: DebugSessionId | null;
  onClose: () => void;
}) {
  const [value, setValue] = useState(node.value);
  const editor = useProject((s) => s.settings?.editor);
  const { family, size } = resolveMonoFont(undefined, editor);
  useEffect(() => {
    const s = session != null ? useDebug.getState().sessions[session] : undefined;
    if (!s || s.status !== "paused" || !node.evaluateName || node.reference > 0) return;
    let live = true;
    evaluate(node.evaluateName, "clipboard", s).then(
      (v) => live && v.value && setValue(v.value),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [node, session]);
  const text = classifyValue(value, node.typeName) === "string" ? stringText(value) : value;
  return (
    <Dialog
      open
      popup
      dismissOnBackdrop
      onClose={onClose}
      title={`${node.name}${node.typeName ? ` {${node.typeName}}` : ""}`}
      width="clamp(420px, 50vw, 820px)"
      minWidth={320}
      minHeight={200}
      resizable="both"
      aria-label={formatMessage(tx("Value of {label}"), { label: node.name })}
      className={styles.valuePopup}
    >
      <pre
        className={styles.valuePopupValue}
        role="region"
        aria-label={tx("Value")}
        tabIndex={0}
        data-autofocus=""
        style={{
          fontFamily: family,
          fontSize: size,
          fontWeight: fontWeightOf(editor?.fontWeight, 400),
          lineHeight: editor?.lineHeight ? `${editor.lineHeight}px` : undefined,
          tabSize: editor?.tabSize || 4,
        }}
      >
        {text}
      </pre>
    </Dialog>
  );
}

function VarEditRow({
  node,
  changed,
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: {
  node: VarNode;
  changed: boolean;
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // While editing, Escape belongs to the editor row: holding a popup layer keeps
  // the global "Escape → focus editor" binding (`!popupOpen`) from firing.
  useEffect(() => acquirePopup(), []);
  return (
    <span className={clsx(styles.row, styles.editRow)} title={node.name}>
      <VarPrefix node={node} changed={changed} />
      <span className={styles.valueGroup}>
        <input
          className={clsx(styles.editInput, error && styles.editInvalid)}
          value={value}
          autoFocus
          spellCheck={false}
          autoComplete="off"
          aria-label={`New value of ${node.name}`}
          aria-invalid={!!error || undefined}
          title={error ?? undefined}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onChange(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onBlur={onCancel}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
            }
          }}
        />
        {error && <span className={clsx(styles.error, styles.editError)}>{oneLine(error)}</span>}
      </span>
    </span>
  );
}

function nodeIcon(node: VarNode): string {
  if (node.kind === "watch") return "eye";
  if (node.kind === "eval") return "evaluate-expression";
  return node.depth0 ? "variable" : "field";
}

function VarPrefix({ node, changed, showName = true }: { node: VarNode; changed: boolean; showName?: boolean }) {
  const evaluation = node.kind === "eval";
  return (
    <>
      <Icon name={nodeIcon(node)} size={16} className={styles.nodeIcon} />
      {showName && (
        <>
          <span
            className={clsx(
              styles.name,
              evaluation && styles.evalName,
              node.kind === "var" && styles.varName,
              changed && styles.changed,
            )}
            title={evaluation ? node.name : undefined}
          >
            {evaluation ? oneLine(node.name) : node.name}
          </span>
          <span className={styles.eq}>=</span>
        </>
      )}
    </>
  );
}

function VarRow({
  node,
  changed,
  onShowValue,
  onResolve,
}: {
  node: VarNode;
  changed: boolean;
  onShowValue: (node: VarNode) => void;
  onResolve: (node: VarNode) => void;
}) {
  const valueRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const text = valueRef.current;
    const group = text?.parentElement;
    if (!text || !group) {
      setOverflow(false);
      return;
    }
    // The group measures the space available before the Show button takes any of it.
    const update = () => setOverflow(text.scrollWidth > group.clientWidth + 1);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(group);
    observer.observe(text);
    return () => observer.disconnect();
  }, [node.value, node.typeName, node.error]);
  if (node.kind === "message") return <span className={styles.message}>{node.name}</span>;
  if (node.kind === "scope")
    return (
      <span className={styles.row}>
        <Icon name="folder" size={16} className={styles.nodeIcon} />
        <span className={styles.scope}>{node.name}</span>
      </span>
    );
  const kind = node.error ? null : classifyValue(node.value, node.typeName);
  const shown = shownValue(node.value, node.typeName);
  return (
    <span className={styles.row} title={node.name}>
      <VarPrefix node={node} changed={changed} showName={!shown.entry} />
      {node.error ? (
        <span className={styles.error}>{oneLine(node.error)}</span>
      ) : (
        <>
          {shown.label && (
            <span className={styles.type} title={shown.label}>
              {shown.label}
            </span>
          )}
          <span className={styles.valueGroup}>
            <span ref={valueRef} className={clsx(styles.value, kind && styles[kind])} title={node.value}>
              {oneLine(shown.text)}
            </span>
            {node.lazy && (
              <button
                type="button"
                className={styles.showValue}
                title={tx("Compute the value")}
                aria-label={tx("Compute the value")}
                onClick={(e) => {
                  e.stopPropagation();
                  onResolve(node);
                }}
              >
                (…)
              </button>
            )}
            {!node.lazy && overflow && (
              <button
                type="button"
                className={styles.showValue}
                title={tx("Show")}
                onClick={(e) => {
                  e.stopPropagation();
                  onShowValue(node);
                }}
              >
                …{tx("Show")}
              </button>
            )}
          </span>
        </>
      )}
    </span>
  );
}

/** Add Field Watchpoint: asks the adapter for a data breakpoint id for the value. */
async function addWatchpointFor(session: DebugSessionId, node: VarNode) {
  try {
    const frame = activeSession()?.selectedFrame ?? null;
    const info = await call(commands.debugDataBreakpointInfo(session, node.container, node.name, frame));
    if (!info.dataId) {
      notifications().notify({
        group: "run",
        level: "info",
        key: "debug.watchpoint",
        title: `“${node.name}” can't be watched`,
        body: info.description || undefined,
      });
      return;
    }
    const access = info.accessTypes.includes("write") || !info.accessTypes.length ? "write" : null;
    addFieldWatchpoint({ dataId: info.dataId, label: node.evaluateName ?? node.name, accessType: access });
  } catch (e) {
    notifications().notify({
      group: "run",
      level: "error",
      key: "debug.watchpoint",
      title: "Cannot add a field watchpoint",
      body: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Jump to Source on a value: the selected frame's source; for a local, its first mention
 * in the enclosing function (declaration or parameter, as far as text can tell).
 */
async function jumpToDeclaration(node: VarNode) {
  const s = activeSession();
  const frame = s?.frames.find((f) => f.id === s.selectedFrame);
  if (!frame?.path) return;
  await revealFrame(frame, true);
  if (!node.depth0 || node.kind !== "var" || !/^[A-Za-z_$][\w$]*$/.test(node.name)) return;
  const ed = activeEditor();
  if (!ed || ed.ctx.path !== frame.path) return;
  const doc = ed.view.state.doc;
  const lines = doc.toString().split("\n");
  const re = new RegExp(`(^|[^\\w$])${node.name.replace(/\$/g, "\\$")}(?![\\w$])`);
  let found: { line: number; col: number } | null = null;
  for (let n = Math.min(frame.line, lines.length - 1); n >= 0; n--) {
    const m = re.exec(lines[n]!);
    if (m) found = { line: n, col: m.index + m[1]!.length };
    if (methodAt(ed.ctx.language, lines, n)) break;
  }
  if (!found) return;
  const pos = doc.line(found.line + 1).from + found.col;
  ed.view.dispatch({ selection: { anchor: pos, head: pos + node.name.length }, scrollIntoView: true });
}
