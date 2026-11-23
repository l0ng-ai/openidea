/** TODO tool window: "Project", "Current File", "Scope Based" and "Changes" tabs, grouped by file. */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import clsx from "clsx";
import { openEditorPaths, useEditorRegistry } from "@/editor/api";
import { previewColors } from "@/editor/lineTokens";
import { executeAction } from "@/platform/actions";
import { basename, relativeDir, useProject } from "@/platform/project";
import { EDIT_SCOPES_ACTION, useCustomScopeList } from "@/platform/search";
import { editorService, toolWindowService, useLocalChanges, useOccurrenceNavigator } from "@/workbench/contributions";
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
  Toolbar,
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
  changedPaths,
  countItems,
  groupTodos,
  mergeLive,
  todoSearchScope,
  type TodoGroup,
  type TodoScope,
} from "./model";
import {
  activePatterns,
  todoFilterKeywords,
  updateTodoSettings,
  useTodoSettings,
  type TodoItem,
} from "@/platform/todo";
import { setTodoFilterSelection, useTodoFilterSelection } from "@/platform/todoFilterSelection";
import { editTodoFiltersItem, todoFilterChoices } from "@/workbench/todoFilterMenu";
import {
  provideTodoReview,
  type TodoReview,
  type TodoReviewFile,
  type TodoReviewSkippedFile,
} from "@/workbench/todoReview";
import { scanProject, scanScope, useTodos } from "./store";
import styles from "./TodoView.module.css";
import { tx } from "@/platform/i18n";

type ScopeTab = "project" | "file" | "scope" | "changes";
type ReviewId = `review:${number}`;
type Tab = ScopeTab | ReviewId;

interface ReviewTab {
  id: ReviewId;
  review: TodoReview;
}

function isReviewId(tab: Tab): tab is ReviewId {
  return tab.startsWith("review:");
}

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
  tab: ScopeTab;
  activeReview: ReviewId | null;
  reviewTabs: ReviewTab[];
  /** Hidden keywords (filter). */
  hidden: string[];
  collapsed: Set<string>;
  /** The Scope Based tab's scope. */
  scope: TodoScope;
  /** The Changes tab's change list (null: the active one). */
  changelist: string | null;
  setTab(tab: ScopeTab): void;
  setScope(scope: TodoScope): void;
  toggleKeyword(k: string): void;
  showAll(): void;
}

export const useTodoView = create<ViewState>((set) => ({
  tab: "project",
  activeReview: null,
  reviewTabs: [],
  hidden: [],
  collapsed: new Set(),
  scope: loadScope(),
  changelist: null,
  setTab: (tab) => set({ tab, activeReview: null }),
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

let reviewSequence = 0;

function closeReview(id: string) {
  useTodoView.setState((state) => {
    const at = state.reviewTabs.findIndex((tab) => tab.id === id);
    if (at === -1) return state;
    const reviewTabs = state.reviewTabs.filter((tab) => tab.id !== id);
    return {
      reviewTabs,
      activeReview:
        state.activeReview === id ? (reviewTabs[Math.min(at, reviewTabs.length - 1)]?.id ?? null) : state.activeReview,
    };
  });
}

export function installTodoReviews() {
  const clear = () => useTodoView.setState({ reviewTabs: [], activeReview: null });
  const dispose = provideTodoReview((review) => {
    useTodoView.setState((state) => {
      const existing = state.reviewTabs.find((tab) => tab.review === review);
      if (existing) return { activeReview: existing.id };
      const id: ReviewId = `review:${++reviewSequence}`;
      return { reviewTabs: [...state.reviewTabs, { id, review }], activeReview: id };
    });
    toolWindowService().show("todo", true);
  });
  const unsubscribe = useProject.subscribe((state, before) => {
    if (state.project !== before.project) clear();
  });
  return () => {
    dispose();
    unsubscribe();
    clear();
  };
}

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
  const review = useTodoView((state) => state.activeReview !== null);
  const items: MenuItem[] = [
    {
      id: "preview",
      label: "Show Preview",
      checked: o.preview,
      run: () => useTodoViewOptions.setState({ preview: !o.preview }),
    },
  ];
  if (!review)
    items.push({
      id: "autoscroll",
      label: "Autoscroll to Source",
      checked: o.autoscroll,
      run: () => useTodoViewOptions.setState({ autoscroll: !o.autoscroll }),
    });
  return items;
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
export function useTodoGroups(tab: ScopeTab, openPaths?: ReadonlySet<string>): TodoGroup[] {
  const scanned = useTodos((s) => s.scanned);
  const scoped = useTodos((s) => s.scoped);
  const live = useTodos((s) => s.live);
  const hidden = useTodoView((s) => s.hidden);
  const settings = useTodoSettings();
  const selectedFilter = useTodoFilterSelection("view");
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const changed = useChangedPaths();
  return useMemo(() => {
    const keywords =
      todoFilterKeywords(settings, selectedFilter) ??
      keywordFilter(
        hidden,
        activePatterns(settings).map((p) => p.keyword.trim()),
      );
    if (tab === "scope") {
      // Open Files membership comes from the tabs, even when the last scan found no matches there.
      if (openPaths) return groupTodos(mergeLive(scoped, live), { keywords, paths: openPaths });
      // Open editors' unsaved text, for the files the scope scan found.
      const inScope = new Map([...live].filter(([path]) => scoped.has(path)));
      return groupTodos(mergeLive(scoped, inScope), { keywords });
    }
    const merged = mergeLive(scanned, live);
    if (tab === "changes") return groupTodos(merged, { keywords, paths: changed });
    return groupTodos(merged, tab === "file" ? { keywords, path: current } : { keywords });
  }, [scanned, scoped, live, hidden, settings, selectedFilter, tab, current, changed, openPaths]);
}

/** The Scope Based tab's scope as the backend scope, with a key that changes when it does. */
function useScopeQuery() {
  const scope = useTodoView((s) => s.scope);
  const custom = useCustomScopeList();
  const openPaths = useEditorRegistry(useShallow(() => (scope === "openFiles" ? openEditorPaths() : [])));
  return useMemo(() => {
    const search = todoSearchScope(scope, custom, openPaths);
    return { search, key: JSON.stringify(search), openPaths: scope === "openFiles" ? new Set(openPaths) : undefined };
  }, [scope, custom, openPaths]);
}

/** Rescans the chosen scope when it changes, and (debounced) when the project index does. */
function useScopeScan(active: boolean, { search, key }: ReturnType<typeof useScopeQuery>) {
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
    <span className={styles.text}>
      <strong className={styles.keyword} style={{ color }}>
        {item.text.slice(0, kwLen)}
      </strong>
      {item.text.slice(kwLen)}
    </span>
  );
}

function TodoToolbar({ review }: { review: boolean }) {
  const settings = useTodoSettings();
  const hidden = useTodoView((s) => s.hidden);
  const toggleKeyword = useTodoView((s) => s.toggleKeyword);
  const showAll = useTodoView((s) => s.showAll);
  const filterId = useTodoFilterSelection("view");
  const selected = settings.filters.find(({ id }) => id === filterId)?.id ?? null;
  const keywords = todoFilterKeywords(settings, selected);
  const patterns = activePatterns(settings);
  const scanning = useTodos((s) => s.scanning);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = [
    ...todoFilterChoices(
      settings,
      selected,
      (id) => {
        showAll();
        setTodoFilterSelection("view", id);
      },
      selected === null && hidden.length === 0,
    ),
    {
      id: "keywords",
      label: "Filter by Keyword",
      disabled: !patterns.length,
      submenu: patterns.map(({ id, keyword }) => ({
        id,
        label: keyword,
        verbatim: true,
        checked: keywords?.has(keyword.trim()) ?? !hidden.includes(keyword.trim()),
        run: () => {
          if (keywords) {
            useTodoView.setState({
              hidden: patterns.map((pattern) => pattern.keyword.trim()).filter((word) => !keywords.has(word)),
            });
            setTodoFilterSelection("view", null);
          }
          toggleKeyword(keyword.trim());
        },
      })),
    },
    { kind: "separator" },
    editTodoFiltersItem,
  ];
  return (
    <Toolbar aria-label="TODO actions" orientation="vertical" className={styles.toolbar}>
      <IconButton icon="arrow-up" action="navigate.prevOccurrence" size="small" />
      <IconButton icon="arrow-down" action="navigate.nextOccurrence" size="small" />
      {!review && (
        <>
          <IconButton
            icon="filter"
            size="small"
            title="Filter TODO Items"
            pressed={selected !== null || hidden.length > 0}
            onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
          />
          <Menu
            open={!!anchor}
            anchor={anchor}
            items={items}
            onClose={() => setAnchor(null)}
            aria-label="TODO filters"
          />
          <IconButton
            icon="case"
            size="small"
            title="Match Case"
            pressed={settings.caseSensitive}
            onClick={() => updateTodoSettings({ caseSensitive: !settings.caseSensitive })}
          />
          <IconButton
            icon="refresh"
            size="small"
            title="Refresh"
            disabled={scanning}
            onClick={() => void scanProject()}
          />
        </>
      )}
    </Toolbar>
  );
}

/** Scope tabs in the tool window header: "Project" / "Current File" / "Scope Based" / "Changes". */
export function TodoTabs() {
  const tab = useTodoView((s) => s.tab);
  const setTab = useTodoView((s) => s.setTab);
  const reviews = useTodoView((s) => s.reviewTabs);
  const activeReview = useTodoView((s) => s.activeReview);
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const projectCount = countItems(useTodoGroups("project"));
  const fileCount = countItems(useTodoGroups("file"));
  const changesCount = countItems(useTodoGroups("changes"));
  return (
    <Tabs
      variant="compact"
      aria-label="TODO scope"
      className={styles.tabs}
      activeId={activeReview ?? tab}
      onSelect={(id) => {
        const tab = id as Tab;
        if (isReviewId(tab)) useTodoView.setState({ activeReview: tab });
        else setTab(tab);
      }}
      onClose={closeReview}
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
        ...reviews.map(({ id, review }) => {
          const title = tx(review.kind === "pending" ? "Commit TODOs" : "Committed TODOs");
          const count = review.files.reduce((total, file) => total + file.items.length, 0);
          return {
            id,
            closable: true,
            label: (
              <>
                {title}
                {review.subject && <span className={styles.tabFile}> {review.subject}</span>}
              </>
            ),
            text: review.subject ? `${title} · ${review.subject}` : title,
            trailing: count ? <span className={styles.tabCount}>{count}</span> : undefined,
          };
        }),
      ]}
    />
  );
}

export function TodoView() {
  const tab = useTodoView((s) => s.tab);
  const activeReview = useTodoView((s) => s.activeReview);
  const review = useTodoView((s) => s.reviewTabs.find(({ id }) => id === activeReview)?.review);
  const current = useEditorRegistry((s) => s.active?.ctx.path ?? null);
  const { scanning, error, limitHit, scannedOnce, scopedScanning, scopedKey } = useTodos();
  const scope = useScopeQuery();
  const liveGroups = useTodoGroups(tab, scope.openPaths);
  useScopeScan(!review && tab === "scope", scope);
  const groups = useMemo(
    () => review?.files.map(({ path, items }) => ({ path, items })) ?? liveGroups,
    [review, liveGroups],
  );

  const empty =
    tab === "file" && !current ? (
      <EmptyState icon="todo" title="No file is open" />
    ) : tab === "scope" ? (
      scopedScanning || scopedKey !== scope.key ? (
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
      {(!review || groups.length > 0) && <TodoToolbar review={!!review} />}
      <div className={styles.content}>
        {!review && tab === "project" && limitHit && (
          <div className={styles.banner}>
            <T>Too many matches; showing the first 10 000.</T>
          </div>
        )}
        {!review && tab === "scope" && <ScopeBar />}
        {!review && tab === "changes" && <ChangelistBar />}
        {review && review.skipped.length > 0 && (
          <SkippedTodoFiles files={review.skipped} collapsible={groups.length > 0} />
        )}
        {(!review || groups.length > 0) && (
          <TodoResults
            key={activeReview ?? "scopes"}
            groups={groups}
            empty={review ? undefined : empty}
            review={review}
          />
        )}
      </div>
    </div>
  );
}

function SkippedTodoFiles({ files, collapsible }: { files: readonly TodoReviewSkippedFile[]; collapsible: boolean }) {
  const root = useProject((state) => state.project?.root ?? "");
  const list = (
    <ul className={styles.skippedFiles}>
      {files.map(({ path, reason, detail }) => {
        const directory = relativeDir(root, path);
        const label = directory ? `${directory}/${basename(path)}` : basename(path);
        return (
          <li key={path}>
            <strong title={path}>{label}</strong>
            <span>{reason}</span>
            {detail && <span className={styles.skipDetail}>{detail}</span>}
          </li>
        );
      })}
    </ul>
  );
  return collapsible ? (
    <details className={styles.skippedSummary}>
      <summary>
        <T>Files Not Checked</T> <span className={styles.tabCount}>{files.length}</span>
      </summary>
      {list}
    </details>
  ) : (
    <section className={styles.skippedOnly} aria-label={tx("Files Not Checked")}>
      <h3>
        <T>Files Not Checked</T>
      </h3>
      {list}
    </section>
  );
}

function itemKey({ path, line, col }: TodoItem) {
  return `${path}\u0000${line}:${col}`;
}

function TodoResults({ groups, empty, review }: { groups: TodoGroup[]; empty: ReactNode; review?: TodoReview }) {
  const liveCollapsed = useTodoView((s) => s.collapsed);
  const [reviewCollapsed, setReviewCollapsed] = useState(() => new Set<string>());
  const collapsed = review ? reviewCollapsed : liveCollapsed;
  const root = useProject((s) => s.project?.root ?? "");
  const showPreview = useTodoViewOptions((o) => o.preview);
  const tree = useRef<TreeHandle>(null);
  const first = review ? groups[0]?.items[0] : undefined;
  const [lead, setLead] = useState<Node | null>(() =>
    first ? { kind: "item", key: itemKey(first), item: first } : null,
  );

  const activate = (item: TodoItem, focus: boolean) => {
    if (review) {
      void review.files.find(({ path }) => path === item.path)?.open(item, focus);
    } else open(item, focus);
  };

  useOccurrenceNavigator("todo", (dir, focus) => {
    const step = tree.current?.selectOccurrence(dir);
    const node = step?.node as Node | undefined;
    if (!step || node?.kind !== "item") return null;
    if (!review || focus) activate(node.item, focus);
    return step;
  });

  const roots = useMemo<Node[]>(() => groups.map((g) => ({ kind: "file", key: g.path, group: g })), [groups]);
  const expanded = useMemo(
    () => new Set(roots.filter((r) => !collapsed.has(r.key)).map((r) => r.key)),
    [roots, collapsed],
  );
  const getChildren = useCallback(
    (node: Node): Node[] | undefined =>
      node.kind === "file" ? node.group.items.map((item) => ({ kind: "item", key: itemKey(item), item })) : undefined,
    [],
  );

  const renderNode = (n: Node, state: TreeRowState) => {
    if (n.kind === "file") {
      const name = basename(n.group.path);
      const directory = relativeDir(root, n.group.path);
      return (
        <span className={styles.row}>
          <Icon name={fileIconName(name)} size={16} className={styles.fileIcon} />
          <span className={styles.fileLocation}>
            <span className={clsx(styles.fileName, state.selected && styles.selectedText)} title={name}>
              {name}
            </span>
            {directory && (
              <span className={styles.directory} title={directory}>
                {directory}
              </span>
            )}
          </span>
          <span className={styles.count}>
            {n.group.items.length === 1 ? tx`${n.group.items.length} item` : tx`${n.group.items.length} items`}
          </span>
        </span>
      );
    }
    return (
      <span className={styles.row} title={n.item.text}>
        <span className={styles.position} title={`(${n.item.line + 1}, ${n.item.col + 1})`}>
          {n.item.line + 1}
        </span>
        <ItemText item={n.item} />
      </span>
    );
  };

  return (
    <SplitGroup
      orientation="horizontal"
      id="todo-preview-split"
      storageKey={showPreview ? "openidea.todo.previewSplit" : undefined}
      className={styles.body}
    >
      <SplitPanel id="items" minSize={160} className={styles.panel}>
        <Tree<Node>
          handleRef={tree}
          roots={roots}
          getKey={(node) => node.key}
          getLabel={(node) => (node.kind === "file" ? basename(node.group.path) : node.item.text)}
          getChildren={getChildren}
          isExpandable={(node) => node.kind === "file"}
          expanded={expanded}
          defaultSelected={first ? [itemKey(first)] : undefined}
          onExpandedChange={(_next, node, isExpanded) => {
            const updated = new Set(collapsed);
            if (isExpanded) updated.delete(node.key);
            else updated.add(node.key);
            if (review) setReviewCollapsed(updated);
            else useTodoView.setState({ collapsed: updated });
          }}
          renderNode={renderNode}
          onActivate={(node) => {
            const item = node.kind === "item" ? node.item : node.group.items[0];
            if (item) activate(item, true);
          }}
          onSelectionChange={(_selection, node) => {
            setLead(node);
            if (!review && node?.kind === "item" && useTodoViewOptions.getState().autoscroll) open(node.item, false);
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
          <SplitPanel id="preview" minSize={160} defaultSize="50%" className={styles.panel}>
            <TodoPreview node={lead} review={review} />
          </SplitPanel>
        </>
      )}
    </SplitGroup>
  );
}

function TodoPreview({ node, review }: { node: Node | null; review?: TodoReview }) {
  const item = node?.kind === "item" ? node.item : (node?.group.items[0] ?? null);
  const highlights = item ? [{ line: item.line, ranges: [[item.col, item.col + item.text.length] as const] }] : [];
  const snapshot: TodoReviewFile | undefined = review?.files.find(({ path }) => path === item?.path);
  const load = useCallback(async () => snapshot?.text ?? "", [snapshot]);
  if (review)
    return (
      <SourcePreview
        path={snapshot?.path ?? null}
        line={item?.line ?? 0}
        highlights={highlights}
        load={load}
        colorize={previewColors}
      />
    );
  return (
    <PreviewEditor
      path={item?.path ?? null}
      line={item?.line ?? 0}
      col={item?.col ?? 0}
      highlights={highlights}
      fallbackLoad={previewText}
    />
  );
}
