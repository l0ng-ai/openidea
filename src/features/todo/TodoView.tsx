/** TODO tool window: "Project", "Current File", "Scope Based" and "Changes" tabs, grouped by file. */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import clsx from "clsx";
import { openEditorPaths, useEditorRegistry } from "@/editor/api";
import { executeAction } from "@/platform/actions";
import { basename, relativeDir, useProject } from "@/platform/project";
import { EDIT_SCOPES_ACTION, useCustomScopeList } from "@/platform/search";
import { editorService, useLocalChanges, useOccurrenceNavigator } from "@/workbench/contributions";
import {
  EmptyState,
  Icon,
  IconButton,
  Menu,
  Select,
  SourcePreview,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Spinner,
  Tabs,
  Tree,
  fileIconName,
  type MenuItem,
  type TreeHandle,
  type TreeRowState,
  T,
} from "@/ui";
import { previewText } from "./ipc";
import { PreviewEditor } from "./PreviewEditor";
import {
  BUILTIN_TODO_SCOPES,
  activePatterns,
  changedPaths,
  countItems,
  groupTodos,
  mergeLive,
  todoSearchScope,
  type TodoGroup,
  type TodoItem,
  type TodoScope,
} from "./model";
import { scanProject, scanScope, updateTodoSettings, useTodoSettings, useTodos } from "./store";
import styles from "./TodoView.module.css";
import { tx } from "@/platform/i18n";

type Tab = "project" | "file" | "scope" | "changes";

const SCOPE_KEY = "openidea.todo.scope.v1";

function loadScope(): TodoScope {
  try {
    const v = globalThis.localStorage?.getItem(SCOPE_KEY);
    if (v && (BUILTIN_TODO_SCOPES.some((s) => s.value === v) || v.startsWith("custom:"))) return v as TodoScope;
  } catch {
    /* storage unavailable */
  }
  return "projectFiles";
}

interface ViewState {
  tab: Tab;
  /** Hidden keywords (filter). */
  hidden: string[];
  collapsed: Set<string>;
  /** The Scope Based tab's scope. */
  scope: TodoScope;
  /** The Changes tab's change list (null: the active one). */
  changelist: string | null;
  setTab(tab: Tab): void;
  setScope(scope: TodoScope): void;
  toggleKeyword(k: string): void;
  showAll(): void;
}

export const useTodoView = create<ViewState>((set) => ({
  tab: "project",
  hidden: [],
  collapsed: new Set(),
  scope: loadScope(),
  changelist: null,
  setTab: (tab) => set({ tab }),
  setScope: (scope) => {
    set({ scope });
    try {
      globalThis.localStorage?.setItem(SCOPE_KEY, scope);
    } catch {
      /* storage unavailable */
    }
  },
  toggleKeyword: (k) =>
    set((s) => ({ hidden: s.hidden.includes(k) ? s.hidden.filter((h) => h !== k) : [...s.hidden, k] })),
  showAll: () => set({ hidden: [] }),
}));

// View options (persisted), in the tool window's ⋮ menu. IDEA's defaults:
// preview on, no autoscroll.
const OPTIONS_KEY = "openidea.todo.view.v1";

interface TodoViewOptions {
  preview: boolean;
  autoscroll: boolean;
}

function loadOptions(): Partial<TodoViewOptions> {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(OPTIONS_KEY) ?? "{}") as Partial<TodoViewOptions>;
  } catch {
    return {};
  }
}

export const useTodoViewOptions = create<TodoViewOptions>(() => ({
  preview: true,
  autoscroll: false,
  ...loadOptions(),
}));

useTodoViewOptions.subscribe((s) => {
  try {
    globalThis.localStorage?.setItem(OPTIONS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
});

/** The TODO tool window's ⋮ menu entries. */
export function useTodoHeaderMenu(): MenuItem[] {
  const o = useTodoViewOptions();
  return [
    {
      id: "preview",
      label: "Show Preview",
      checked: o.preview,
      run: () => useTodoViewOptions.setState({ preview: !o.preview }),
    },
    {
      id: "autoscroll",
      label: "Autoscroll to Source",
      checked: o.autoscroll,
      run: () => useTodoViewOptions.setState({ autoscroll: !o.autoscroll }),
    },
  ];
}

type Node = { kind: "file"; key: string; group: TodoGroup } | { kind: "item"; key: string; item: TodoItem };

function keywordFilter(hidden: readonly string[], all: readonly string[]): Set<string> | null {
  return hidden.length ? new Set(all.filter((k) => !hidden.includes(k))) : null;
}

/** Files of the chosen change list (the VCS change lists; empty without VCS). */
function useChangedPaths(): Set<string> {
  const lists = useLocalChanges((s) => s.lists);
  const listId = useTodoView((s) => s.changelist);
  return useMemo(() => changedPaths(lists, listId), [lists, listId]);
}

/** Groups for a tab (exported for the badge and tests). */
export function useTodoGroups(tab: Tab): TodoGroup[] {
  const scanned = useTodos((s) => s.scanned);
  const scoped = useTodos((s) => s.scoped);
  const live = useTodos((s) => s.live);
  const hidden = useTodoView((s) => s.hidden);
  const patterns = useTodoSettings((s) => s.patterns);
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const changed = useChangedPaths();
  return useMemo(() => {
    const keywords = keywordFilter(
      hidden,
      patterns.map((p) => p.keyword.trim()),
    );
    if (tab === "scope") {
      // Open editors' unsaved text, for the files the scope scan found.
      const inScope = new Map([...live].filter(([path]) => scoped.has(path)));
      return groupTodos(mergeLive(scoped, inScope), { keywords });
    }
    const merged = mergeLive(scanned, live);
    if (tab === "changes") return groupTodos(merged, { keywords, paths: changed });
    return groupTodos(merged, tab === "file" ? { keywords, path: current } : { keywords });
  }, [scanned, scoped, live, hidden, patterns, tab, current, changed]);
}

/** The Scope Based tab's scope as the backend scope, with a key that changes when it does. */
function useScopeQuery() {
  const scope = useTodoView((s) => s.scope);
  const custom = useCustomScopeList();
  // Open tabs change with the active editor (or its count): re-read them then.
  const openKey = useEditorRegistry((s) =>
    scope === "openFiles" ? `${s.editors.size}:${s.active?.ctx.path ?? ""}` : "",
  );
  return useMemo(() => {
    const search = todoSearchScope(scope, custom, scope === "openFiles" ? openEditorPaths() : []);
    return { search, key: JSON.stringify(search) };
  }, [scope, custom, openKey]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Rescans the chosen scope when it changes, and (debounced) when the project index does. */
function useScopeScan(active: boolean) {
  const { search, key } = useScopeQuery();
  const scanned = useTodos((s) => s.scanned);
  const scopedKey = useTodos((s) => s.scopedKey);
  const fresh = scopedKey === key;
  useEffect(() => {
    if (!active) return;
    if (!fresh) {
      void scanScope(key, search);
      return;
    }
    const t = setTimeout(() => void scanScope(key, search), 800);
    return () => clearTimeout(t);
    // `fresh` only gates the first scan of a scope; later ones follow the project index.
  }, [active, key, scanned]); // eslint-disable-line react-hooks/exhaustive-deps
}

/** IDEA's "Changelist:" chooser above the Changes tab (when there is more than one list). */
function ChangelistBar() {
  const lists = useLocalChanges((s) => s.lists);
  const chosen = useTodoView((s) => s.changelist);
  if (lists.length < 2) return null;
  const value = lists.find((l) => l.id === chosen)?.id ?? lists.find((l) => l.active)?.id ?? lists[0]!.id;
  return (
    <div className={styles.scopeBar}>
      <span className={styles.muted}>
        <T>Changelist:</T>
      </span>
      <Select<string>
        aria-label="Changelist"
        className={styles.scopeSelect}
        value={value}
        options={lists.map((l) => ({
          value: l.id,
          label: l.name,
          detail: l.files.length === 1 ? tx`${l.files.length} file` : tx`${l.files.length} files`,
        }))}
        onChange={(id) => useTodoView.setState({ changelist: id })}
      />
    </div>
  );
}

function ScopeBar() {
  const scope = useTodoView((s) => s.scope);
  const setScope = useTodoView((s) => s.setScope);
  const custom = useCustomScopeList();
  const options = [
    ...BUILTIN_TODO_SCOPES,
    ...custom.map((c) => ({ value: `custom:${c.name}` as TodoScope, label: c.name, detail: c.pattern })),
  ];
  return (
    <div className={styles.scopeBar}>
      <span className={styles.muted}>
        <T>Scope:</T>
      </span>
      <Select<TodoScope>
        aria-label="Scope"
        className={styles.scopeSelect}
        value={scope}
        options={options}
        onChange={setScope}
      />
      <IconButton
        icon="more-horizontal"
        size="small"
        title="Edit Scopes…"
        onClick={() =>
          void executeAction(EDIT_SCOPES_ACTION, scope.startsWith("custom:") ? { select: scope.slice(7) } : undefined)
        }
      />
    </div>
  );
}

export function useTodoBadge(): number | null {
  const n = countItems(useTodoGroups("project"));
  return n || null;
}

function open(item: TodoItem, focus: boolean) {
  void editorService().openFile(item.path, { selection: { line: item.line, col: item.col }, focus, preview: !focus });
}

function colorFor(keyword: string): string {
  const s = useTodoSettings.getState();
  const k = s.caseSensitive ? keyword : keyword.toLowerCase();
  return (
    s.patterns.find((p) => (s.caseSensitive ? p.keyword.trim() : p.keyword.trim().toLowerCase()) === k)?.color ??
    "var(--info)"
  );
}

function ItemText({ item }: { item: TodoItem }) {
  const kwLen = item.keyword.length;
  const color = colorFor(item.keyword);
  return (
    <span className={styles.text} style={{ color }}>
      <strong className={styles.keyword}>{item.text.slice(0, kwLen)}</strong>
      {item.text.slice(kwLen)}
    </span>
  );
}

export function TodoHeaderActions() {
  const settings = useTodoSettings();
  const hidden = useTodoView((s) => s.hidden);
  const toggleKeyword = useTodoView((s) => s.toggleKeyword);
  const showAll = useTodoView((s) => s.showAll);
  const scanning = useTodos((s) => s.scanning);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = [
    { id: "all", label: "Show All", checked: hidden.length === 0, run: showAll },
    { kind: "separator" },
    ...activePatterns(settings).map((p) => ({
      id: p.id,
      label: p.keyword,
      checked: !hidden.includes(p.keyword.trim()),
      run: () => toggleKeyword(p.keyword.trim()),
    })),
  ];
  return (
    <>
      <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" />
      <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" />
      <IconButton
        icon="filter"
        size="small"
        title="Filter TODO Items"
        pressed={hidden.length > 0}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
      />
      <Menu open={!!anchor} anchor={anchor} items={items} onClose={() => setAnchor(null)} aria-label="TODO filters" />
      <IconButton
        icon="case"
        size="small"
        title="Match Case"
        pressed={settings.caseSensitive}
        onClick={() => updateTodoSettings({ caseSensitive: !settings.caseSensitive })}
      />
      <IconButton icon="refresh" size="small" title="Refresh" disabled={scanning} onClick={() => void scanProject()} />
    </>
  );
}

/** Scope tabs in the tool window header: "Project" / "Current File" / "Scope Based" / "Changes". */
export function TodoTabs() {
  const tab = useTodoView((s) => s.tab);
  const setTab = useTodoView((s) => s.setTab);
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const projectCount = countItems(useTodoGroups("project"));
  const fileCount = countItems(useTodoGroups("file"));
  const changesCount = countItems(useTodoGroups("changes"));
  return (
    <Tabs
      variant="compact"
      aria-label="TODO scope"
      className={styles.tabs}
      activeId={tab}
      onSelect={(id) => setTab(id as Tab)}
      items={[
        {
          id: "project",
          label: "Project",
          trailing: projectCount ? <span className={styles.tabCount}>{projectCount}</span> : undefined,
        },
        {
          id: "file",
          label: current ? (
            <>
              <T>Current File</T> <span className={styles.tabFile}>{basename(current)}</span>
            </>
          ) : (
            "Current File"
          ),
          text: "Current File",
          trailing: fileCount ? <span className={styles.tabCount}>{fileCount}</span> : undefined,
        },
        { id: "scope", label: "Scope Based" },
        {
          id: "changes",
          label: "Changes",
          tooltip: "TODO items in files of a changelist",
          trailing: changesCount ? <span className={styles.tabCount}>{changesCount}</span> : undefined,
        },
      ]}
    />
  );
}

export function TodoView() {
  const tab = useTodoView((s) => s.tab);
  const collapsed = useTodoView((s) => s.collapsed);
  const root = useProject((s) => s.project?.root ?? "");
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const { scanning, error, limitHit, scannedOnce, scopedScanning, scopedKey } = useTodos();
  const groups = useTodoGroups(tab);
  useScopeScan(tab === "scope");
  const scopeKey = useScopeQuery().key;
  const showPreview = useTodoViewOptions((o) => o.preview);
  const tree = useRef<TreeHandle>(null);
  const [lead, setLead] = useState<Node | null>(null);

  useOccurrenceNavigator("todo", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const n = step?.node as Node | undefined;
    if (!step || n?.kind !== "item") return null;
    open(n.item, focus);
    return step;
  });

  const roots = useMemo<Node[]>(() => groups.map((g) => ({ kind: "file", key: g.path, group: g })), [groups]);
  const expanded = useMemo(
    () => new Set(roots.filter((r) => !collapsed.has(r.key)).map((r) => r.key)),
    [roots, collapsed],
  );
  const getChildren = useCallback(
    (n: Node): Node[] | undefined =>
      n.kind === "file"
        ? n.group.items.map((item) => ({ kind: "item", key: `${item.path}\u0000${item.line}:${item.col}`, item }))
        : undefined,
    [],
  );

  const renderNode = (n: Node, state: TreeRowState) => {
    if (n.kind === "file") {
      const name = basename(n.group.path);
      return (
        <span className={styles.row}>
          <Icon name={fileIconName(name)} size={16} className={styles.fileIcon} />
          <span className={clsx(styles.fileName, state.selected && styles.selectedText)}>{name}</span>
          <span className={styles.muted}>{relativeDir(root, n.group.path)}</span>
          <span className={styles.count}>
            {n.group.items.length === 1 ? tx`${n.group.items.length} item` : tx`${n.group.items.length} items`}
          </span>
        </span>
      );
    }
    return (
      <span className={styles.row} title={n.item.text}>
        <span className={styles.position}>
          ({n.item.line + 1}, {n.item.col + 1})
        </span>
        <ItemText item={n.item} />
      </span>
    );
  };

  const empty =
    tab === "file" && !current ? (
      <EmptyState icon="todo" title="No file is open" />
    ) : tab === "scope" ? (
      scopedScanning || scopedKey !== scopeKey ? (
        <div className={styles.loading}>
          <Spinner size={14} /> <T>Scanning for TODO items…</T>
        </div>
      ) : (
        <EmptyState icon="todo" title="No TODO items found in this scope" />
      )
    ) : tab === "changes" ? (
      <EmptyState icon="todo" title="No TODO items in changed files" />
    ) : error && tab === "project" ? (
      <EmptyState icon="todo" title="TODO items unavailable">
        {error}
      </EmptyState>
    ) : scanning || (!scannedOnce && tab === "project") ? (
      <div className={styles.loading}>
        <Spinner size={14} /> <T>Scanning for TODO items…</T>
      </div>
    ) : (
      <EmptyState icon="todo" title={tab === "file" ? "No TODO items in this file" : "No TODO items found"} />
    );

  return (
    <div className={styles.view}>
      {tab === "project" && limitHit && (
        <div className={styles.banner}>
          <T>Too many matches; showing the first 10 000.</T>
        </div>
      )}
      {tab === "scope" && <ScopeBar />}
      {tab === "changes" && <ChangelistBar />}
      <div className={styles.body}>
        <SplitGroup orientation="horizontal" id="todo-preview-split">
          <SplitPanel id="items" minSize={160} className={styles.panel}>
            <Tree<Node>
              handleRef={tree}
              roots={roots}
              getKey={(n) => n.key}
              getLabel={(n) => (n.kind === "file" ? basename(n.group.path) : n.item.text)}
              getChildren={getChildren}
              isExpandable={(n) => n.kind === "file"}
              expanded={expanded}
              onExpandedChange={(_next, node, isExpanded) =>
                useTodoView.setState((s) => {
                  const c = new Set(s.collapsed);
                  if (isExpanded) c.delete(node.key);
                  else c.add(node.key);
                  return { collapsed: c };
                })
              }
              renderNode={renderNode}
              onActivate={(n) => {
                if (n.kind === "item") open(n.item, true);
                else if (n.group.items[0]) open(n.group.items[0], true);
              }}
              onSelectionChange={(_sel, node) => {
                setLead(node);
                // Autoscroll to Source (off by default, as in IDEA).
                if (node?.kind === "item" && useTodoViewOptions.getState().autoscroll) open(node.item, false);
              }}
              activateExpandable={false}
              multiSelect={false}
              speedSearch
              aria-label="TODO items"
              empty={empty}
            />
          </SplitPanel>
          {showPreview && (
            <>
              <SplitHandle />
              <SplitPanel id="preview" minSize={160} defaultSize="45%" className={styles.panel}>
                <TodoPreview node={lead} />
              </SplitPanel>
            </>
          )}
        </SplitGroup>
      </div>
    </div>
  );
}

function TodoPreview({ node }: { node: Node | null }) {
  const item = node?.kind === "item" ? node.item : (node?.group.items[0] ?? null);
  // Session-local, deliberately not persisted: editing is an explicit opt-in
  // each time the tool window opens, so previews start read-only.
  const [editable, setEditable] = useState(false);
  const highlights = item ? [{ line: item.line, ranges: [[item.col, item.col + item.text.length] as const] }] : [];
  return (
    <div className={styles.previewPane}>
      <div className={styles.previewBar}>
        <label className={styles.previewToggle}>
          <input
            type="checkbox"
            checked={editable}
            onChange={(e) => setEditable(e.target.checked)}
            aria-label={tx("Allow editing")}
          />
          <T>Allow editing</T>
        </label>
      </div>
      {item && editable ? (
        <PreviewEditor path={item.path} line={item.line} col={item.col} />
      ) : (
        <SourcePreview path={item?.path ?? null} line={item?.line ?? 0} highlights={highlights} load={previewText} />
      )}
    </div>
  );
}
