/** Lazy variables tree (scopes, locals, watches, evaluation results). */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { call, commands, type DebugSessionId, type Variable } from "@/platform/ipc";
import { Icon, Tree, acquirePopup, showContextMenu, type MenuItem, type TreeHandle } from "@/ui";
import { activeEditor } from "@/editor/api";
import { notifications } from "@/workbench/contributions";
import { addFieldWatchpoint } from "../breakpoints/special";
import { methodAt } from "../breakpoints/symbols";
import { activeSession, addWatch, removeWatch, revealFrame, sessionSupports, setVariableValue } from "../state";
import { blurDebugView, focusDebugView } from "./focusedView";
import { classifyValue, sortVariables } from "../values";
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
  const [cache, setCache] = useState<{ gen: number; map: Map<string, VarNode[]> }>({ gen: generation, map: new Map() });
  const children = cache.gen === generation ? cache.map : null;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(defaultExpanded));
  const loading = useRef(new Set<string>());
  const tree = useRef<TreeHandle>(null);

  const nodes = useMemo(() => roots.map(fromRoot), [roots]);
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

  const load = useCallback(
    async (node: VarNode) => {
      if (session == null || node.reference <= 0) return;
      const tag = `${generation}:${node.key}`;
      if (loading.current.has(tag)) return;
      loading.current.add(tag);
      let list: VarNode[];
      try {
        const raw = await call(commands.debugVariables(session, node.reference));
        const vars = workflowSettings().debugger.sortValues ? sortVariables(raw) : raw;
        const seen = new Map<string, number>();
        list = vars.map((v) => {
          const n = (seen.get(v.name) ?? 0) + 1;
          seen.set(v.name, n);
          return fromVariable(`${node.key}/${v.name}${n > 1 ? `#${n}` : ""}`, v, node.reference);
        });
        if (!list.length) list = [message(`${node.key}/\u0000empty`, "No variables")];
      } catch (e) {
        list = [message(`${node.key}/\u0000error`, e instanceof Error ? e.message : String(e))];
      } finally {
        loading.current.delete(tag);
      }
      setCache((c) => {
        const map = new Map(c.gen === generation ? c.map : []);
        map.set(node.key, list);
        return { gen: generation, map };
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

  const onContextMenu = (node: VarNode | null, _sel: Set<string>, e: React.MouseEvent) => {
    if (!node || node.kind === "message") return;
    e.preventDefault();
    const items: MenuItem[] = [];
    if (editable(node))
      items.push(
        { label: "Set Value…", icon: "edit", shortcut: "F2", run: () => startEdit(node) },
        { kind: "separator" },
      );
    if (node.kind === "watch") items.push({ label: "Remove Watch", icon: "minus", run: () => removeWatch(node.name) });
    if (node.kind !== "scope") {
      items.push({ label: "Copy Value", icon: "copy", run: () => void navigator.clipboard?.writeText(node.value) });
      items.push({ label: "Copy Name", run: () => void navigator.clipboard?.writeText(node.name) });
      if (node.kind === "var" && node.evaluateName)
        items.push({ label: "Add to Watches", icon: "eye", run: () => addWatch(node.evaluateName!) });
      if (canWatch(node))
        items.push({
          label: "Add Field Watchpoint",
          icon: "breakpoint-field",
          run: () => void addWatchpointFor(session!, node),
        });
      items.push(
        { kind: "separator" },
        { label: "Jump to Source", shortcut: "F4", run: () => void jumpToDeclaration(node) },
      );
    }
    if (items.length) showContextMenu(e, items);
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
            <VarRow node={n} changed={isChanged(n)} />
          )
        }
      />
    </div>
  );
}

function VarEditRow({
  node,
  value,
  error,
  onChange,
  onCommit,
  onCancel,
}: {
  node: VarNode;
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
    <span className={styles.row}>
      <span className={styles.name}>{node.name}</span>
      <span className={styles.eq}>=</span>
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
      {error && <span className={styles.error}>{error}</span>}
    </span>
  );
}

function nodeIcon(node: VarNode): string {
  if (node.kind === "watch") return "eye";
  if (node.kind === "eval") return "evaluate-expression";
  return node.depth0 ? "variable" : "field";
}

function VarRow({ node, changed }: { node: VarNode; changed: boolean }) {
  if (node.kind === "message") return <span className={styles.message}>{node.name}</span>;
  if (node.kind === "scope")
    return (
      <span className={styles.row}>
        <Icon name="folder" size={16} className={styles.nodeIcon} />
        <span className={styles.scope}>{node.name}</span>
      </span>
    );
  const kind = node.error ? null : classifyValue(node.value, node.typeName);
  return (
    <span className={styles.row}>
      <Icon name={nodeIcon(node)} size={16} className={styles.nodeIcon} />
      <span className={clsx(styles.name, node.kind === "var" && styles.varName, changed && styles.changed)}>
        {node.name}
      </span>
      <span className={styles.eq}>=</span>
      {node.error ? (
        <span className={styles.error}>{node.error}</span>
      ) : (
        <>
          {node.typeName && <span className={styles.type}>{`{${node.typeName}}`}</span>}
          <span className={clsx(styles.value, kind && styles[kind])}>{node.value}</span>
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
