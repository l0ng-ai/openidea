/**
 * Commit tool window: change list with inclusion checkboxes, message, stashes. Its
 * parts also make the Git window's Local Changes / Stash tabs and the Commit dialog.
 */
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";
import { tx } from "@/platform/i18n";
import clsx from "clsx";
import { executeAction } from "@/platform/actions";
import {
  Button,
  Checkbox,
  EmptyState,
  Icon,
  IconButton,
  List,
  Menu,
  Select,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  Tabs,
  Tree,
  fileIconName,
  registerDropTarget,
  showContextMenu,
  startPointerDrag,
  type MenuItem,
  type TabItem,
  type TreeHandle,
  T,
} from "@/ui";
import { editorService } from "@/workbench/contributions";
import {
  aggregateCheck,
  buildChangeTree,
  checkOf,
  filesOf,
  ignoreTargets,
  isPartiallyStaged,
  planCommit,
  toggledCheck,
  type ChangeNode,
} from "./changes";
import { applyStash, commitChanges, dropStash, showUnstashDialog, stashChanges } from "./changeOps";
import { CommitOptionsPopup } from "./CommitOptions";
import { DEFAULT_LIST_NAME, useChangelists, withListDefaults } from "./changelists";
import { moveToChangelist } from "./changelistsUi";
import { messageHistory, setAmend, setGroupByDir, useCommit, type CommitTab } from "./commitStore";
import { pushAfterCommit } from "./commitUi";
import { stashTabOf, stashTabs, type ContentTab } from "./gitTabs";
import { openDiff, withChain, workingDiffData } from "./diffInput";
import { KIND_COLOR, KIND_LABEL, fileCount, formatTime, stashLabel, stripSlash } from "./model";
import { call, commands } from "@/platform/ipc";
import { OperationBanner } from "./operations";
import { ShelfPanel, loadShelves, useShelf } from "./shelf";
import { refreshNow, repoName, selectRepo, useVcs } from "./store";
import styles from "./CommitView.module.css";

/** MIME type of changed files dragged between change lists (absolute paths, newline-separated). */
const CHANGES_MIME = "application/x-openidea-changes";

/** Shown text of a node: group names are translated, except the names of user change lists. */
function nodeText(n: ChangeNode): string {
  return n.type === "group" && (!n.changelist || n.label === DEFAULT_LIST_NAME) ? tx(n.label) : n.label;
}

/** Content tabs as `Tabs` items, with their counts. */
export function tabItems(tabs: readonly ContentTab[]): TabItem[] {
  return tabs.map((t) => ({
    id: t.id,
    label: t.label,
    // `Tabs` treats a missing flag as closable once it has `onClose`.
    closable: !!t.closable,
    trailing: t.count ? <span className={styles.count}>{t.count}</span> : undefined,
  }));
}

/** Shelf and stash counts for the tabs (loads the shelves once VCS is available). */
export function useStashTabCounts(available: boolean) {
  const roots = useVcs((s) => s.roots);
  const version = useVcs((s) => s.version);
  const [stashCount, setStashCount] = useState(0);
  useEffect(() => {
    let live = true;
    if (available)
      void Promise.all(roots.map((r) => call(commands.vcsStashes(r))))
        .then((lists) => live && setStashCount(lists.reduce((n, list) => n + list.length, 0)))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [available, roots, version]);
  const shelfCount = useShelf((s) => s.shelves.length);
  useEffect(() => {
    if (available) void loadShelves().catch(() => undefined);
  }, [available]);
  return { stashCount: available ? stashCount : 0, shelfCount };
}

/** "Commit" / "Shelf" / "Stash" content tabs; they stand in for the tool window title. */
export function CommitTabs() {
  const available = useVcs((s) => s.available);
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const tab = useCommit((s) => s.tab);
  const counts = useStashTabCounts(available);
  return (
    <Tabs
      variant="compact"
      className={styles.tabs}
      activeId={stashTabOf(tab, combine)}
      onSelect={(id) => useCommit.setState({ tab: id as CommitTab })}
      aria-label="Commit"
      items={tabItems([
        { id: "changes", label: "Commit" },
        ...(available ? stashTabs({ combine, tab, ...counts }) : []),
      ])}
    />
  );
}

export function CommitToolWindow() {
  const available = useVcs((s) => s.available);
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const tab = stashTabOf(
    useCommit((s) => s.tab),
    combine,
  );
  if (!available)
    return (
      <EmptyState icon="commit" title="Version control is not configured">
        <T>Open a Git repository to commit changes.</T>
      </EmptyState>
    );
  return <div className={styles.root}>{tab === "changes" ? <ChangesPanel /> : <StashContent tab={tab} />}</div>;
}

/** The Shelf, Stash or combined "Stashes and Shelves" tab. */
export function StashContent({ tab }: { tab: CommitTab }) {
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  if (combine)
    return (
      <SplitGroup orientation="vertical" className={styles.split}>
        <SplitPanel defaultSize="50%" minSize="80px">
          <StashesPanel />
        </SplitPanel>
        <SplitHandle />
        <SplitPanel defaultSize="50%" minSize="80px">
          <ShelfPanel />
        </SplitPanel>
      </SplitGroup>
    );
  return tab === "shelf" ? <ShelfPanel /> : <StashesPanel />;
}

// ---------------------------------------------------------------------------

const bottomLeft = (el: HTMLElement) => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 2 };
};

/** Opens a file's diff; F7 continues through the other files of its group, in tree order. */
function openNode(n: ChangeNode, roots: readonly ChangeNode[]) {
  if (n.type !== "file" || !n.path) return;
  const group = roots.find((g) => g.files.some((f) => f.path === n.files[0]?.path)) ?? null;
  const paths: string[] = [];
  const walk = (ns: readonly ChangeNode[]) =>
    ns.forEach((x) => (x.type === "file" ? x.path && paths.push(x.path) : walk(x.children ?? [])));
  walk(group ? [group] : [n]);
  const items = paths.map((p) => workingDiffData(p));
  void openDiff(withChain(items, Math.max(0, paths.indexOf(n.path))), { preview: true });
}

function listMenu(id: string, active: boolean, paths: string[]): MenuItem[] {
  const count = paths.length;
  return [
    ...(count ? [{ kind: "action" as const, action: "vcs.changelist.commit", arg: id, label: "Commit…" }] : []),
    { kind: "separator" },
    { kind: "action", action: "vcs.changelist.new" },
    { kind: "action", action: "vcs.changelist.edit", arg: id },
    ...(active
      ? []
      : [
          { kind: "action" as const, action: "vcs.changelist.setActive", arg: id },
          { kind: "action" as const, action: "vcs.changelist.delete", arg: id },
        ]),
    { kind: "separator" },
    ...(count
      ? [
          { kind: "action" as const, action: "vcs.shelve", arg: paths },
          { kind: "action" as const, action: "vcs.createPatch", arg: paths },
        ]
      : []),
  ];
}

function nodeMenu(nodes: ChangeNode[], repos: readonly string[]): MenuItem[] {
  const files = filesOf(nodes);
  const paths = files.map((f) => f.path);
  const first = nodes.find((n) => n.type === "file");
  const untracked = files.filter((f) => f.unstaged === "untracked");
  const toIgnore = ignoreTargets(nodes, repos);
  const conflicted = files.filter((f) => f.unstaged === "conflicted");
  const items: MenuItem[] = [
    { kind: "action", action: "vcs.showDiff", arg: first?.path },
    {
      label: "Jump to Source",
      icon: "external-link",
      shortcut: "F4",
      disabled: !first?.path || first.kind === "deleted",
      run: () => first?.path && void editorService().openFile(first.path, { focus: true }),
    },
    { kind: "separator" },
  ];
  if (conflicted.length) items.push({ kind: "action", action: "vcs.resolveConflicts", label: "Resolve Conflicts…" });
  items.push(
    { kind: "action", action: "vcs.rollback", arg: paths, label: "Rollback…" },
    ...(untracked.length
      ? [{ kind: "action" as const, action: "vcs.addToVcs", arg: untracked.map((f) => f.path) }]
      : []),
    ...(toIgnore.length
      ? [
          {
            kind: "action" as const,
            action: "vcs.ignoreShared",
            arg: toIgnore,
            label: "Add to .gitignore",
          },
        ]
      : []),
    {
      label: "Stage",
      icon: "plus",
      disabled: !files.some((f) => f.unstaged),
      run: () => void call(commands.vcsStage(paths)).finally(() => void refreshNow()),
    },
    {
      label: "Unstage",
      icon: "minus",
      disabled: !files.some((f) => f.staged),
      run: () => void call(commands.vcsUnstage(paths)).finally(() => void refreshNow()),
    },
    { kind: "separator" },
    ...(nodes.some((n) => n.changelist)
      ? [{ kind: "action" as const, action: "vcs.changelist.move", arg: paths, label: "Move to Another Changelist…" }]
      : []),
    { kind: "action", action: "vcs.shelve", arg: paths },
    { kind: "action", action: "vcs.createPatch", arg: paths },
    { kind: "separator" },
    {
      label: "Show History",
      icon: "history",
      disabled: !first?.path,
      run: () => void executeAction("vcs.showLog", { path: first?.path }),
    },
    { kind: "action", action: "vcs.localHistory", arg: first?.path },
    { kind: "action", action: "vcs.annotate", arg: first?.path },
    { kind: "separator" },
    { label: "Copy Path", icon: "copy", run: () => void navigator.clipboard?.writeText(paths.join("\n")) },
  );
  return items;
}

function CheckMark({
  checked,
  indeterminate,
  label,
  onToggle,
}: {
  checked: boolean;
  indeterminate: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <span
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={label}
      className={clsx(styles.check, (checked || indeterminate) && styles.checkOn)}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        e.preventDefault();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {indeterminate ? <Icon name="minus" size={10} /> : checked ? <Icon name="check" size={10} /> : null}
    </span>
  );
}

/** Inclusion state of every change (user overrides over the change list defaults). */
function useCommitChecks() {
  const status = useVcs((s) => s.status);
  const root = useVcs((s) => s.root) ?? "";
  const userChecks = useCommit((s) => s.checks);
  const lists = useChangelists((s) => s.state);
  return useMemo(() => withListDefaults(status, root, lists, userChecks), [status, root, lists, userChecks]);
}

/** Number of changes the commit would include. */
export function useIncludedCount(): number {
  const status = useVcs((s) => s.status);
  const checks = useCommitChecks();
  return useMemo(() => planCommit(status, checks).included.length, [status, checks]);
}

/** The Commit tool window's Commit tab: changes with inclusion checkboxes above the message. */
function ChangesPanel() {
  const included = useIncludedCount();
  return (
    <SplitGroup orientation="vertical" className={styles.split}>
      <SplitPanel defaultSize="62%" minSize="20%">
        <ChangesTree mode="commit" />
      </SplitPanel>
      <SplitHandle />
      <SplitPanel defaultSize="38%" minSize="120px">
        <CommitPanel included={included} />
      </SplitPanel>
    </SplitGroup>
  );
}

/**
 * The change tree with its toolbar. `commit`: the Commit tool window's (inclusion
 * checkboxes); `local`: the Git tool window's Local Changes tab of the modal commit
 * interface (no checkboxes, a Commit… button); `dialog`: the Commit dialog's.
 */
export function ChangesTree({ mode }: { mode: "commit" | "local" | "dialog" }) {
  const status = useVcs((s) => s.status);
  const root = useVcs((s) => s.root) ?? "";
  const groupByDir = useCommit((s) => s.groupByDir);
  const lists = useChangelists((s) => s.state);
  const checks = useCommitChecks();
  const checkboxes = mode !== "local";
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  // IDEA starts with Unversioned Files collapsed.
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(["group:unversioned"]));
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const treeRef = useRef<TreeHandle>(null);
  const viewRef = useRef<HTMLButtonElement>(null);

  const repos = useVcs((s) => s.roots);
  const roots = useMemo(
    () => buildChangeTree(status, root, groupByDir, lists, repos),
    [status, root, groupByDir, lists, repos],
  );
  const [byKey, parents] = useMemo(() => {
    const m = new Map<string, ChangeNode>();
    const up = new Map<string, string>();
    const walk = (ns: ChangeNode[], parent?: string) =>
      ns.forEach((n) => {
        m.set(n.key, n);
        if (parent) up.set(n.key, parent);
        if (n.children) walk(n.children, n.key);
      });
    walk(roots);
    return [m, up] as const;
  }, [roots]);

  /** Select Opened File: reveals the focused editor's file in the tree. */
  const selectOpened = () => {
    const path = editorService().activePath();
    const node = path ? [...byKey.values()].find((n) => n.type === "file" && n.path === path) : undefined;
    if (!node) return;
    const ancestors: string[] = [];
    for (let k = parents.get(node.key); k; k = parents.get(k)) ancestors.push(k);
    setCollapsed((c) => new Set([...c].filter((k) => !ancestors.includes(k))));
    requestAnimationFrame(() => treeRef.current?.reveal(node.key));
  };
  const expanded = useMemo(() => {
    const s = new Set<string>();
    for (const k of byKey.keys()) if (!collapsed.has(k)) s.add(k);
    return s;
  }, [byKey, collapsed]);

  // Forget overrides for files that are no longer changed.
  useEffect(() => {
    const live = new Set(status.map((f) => f.path));
    const cur = useCommit.getState().checks;
    if ([...cur.keys()].some((k) => !live.has(k))) {
      useCommit.setState({ checks: new Map([...cur].filter(([k]) => live.has(k))) });
    }
  }, [status]);

  const toggle = useCallback((nodes: ChangeNode[]) => {
    const files = filesOf(nodes);
    const { status: st, root: r } = useVcs.getState();
    const cur = withListDefaults(st, r ?? "", useChangelists.getState().state, useCommit.getState().checks);
    const agg = aggregateCheck(files, cur);
    const target = agg.on === files.length && !agg.indeterminate ? "none" : "all";
    const next = new Map(cur);
    for (const f of files) next.set(f.path, files.length === 1 ? toggledCheck(checkOf(f, cur)) : target);
    useCommit.setState({ checks: next });
  }, []);

  const selectedNodes = () => [...selected].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);

  return (
    <div className={styles.changes}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Changes")}>
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshNow()} />
        {mode === "local" && <IconButton icon="commit" action="vcs.commit" size="small" />}
        <IconButton icon="undo" action="vcs.rollback" size="small" />
        {mode !== "dialog" && <IconButton icon="git-pull" action="vcs.update" size="small" />}
        <IconButton
          ref={viewRef}
          icon="eye"
          title="View Options"
          size="small"
          aria-haspopup="menu"
          onClick={() =>
            viewRef.current &&
            showContextMenu(bottomLeft(viewRef.current), [
              { kind: "header", label: "Group By" },
              { label: "Directory", checked: groupByDir, run: () => setGroupByDir(!groupByDir) },
            ])
          }
        />
        <span className={styles.sep} />
        {mode !== "dialog" && (
          <IconButton icon="locate" title="Select Opened File" size="small" onClick={selectOpened} />
        )}
        <IconButton icon="expand-all" title="Expand All" size="small" onClick={() => setCollapsed(new Set())} />
        <IconButton
          icon="collapse-all"
          title="Collapse All"
          size="small"
          onClick={() => setCollapsed(new Set([...byKey.values()].filter((n) => n.type !== "file").map((n) => n.key)))}
        />
      </div>
      {mode !== "dialog" && <OperationBanner />}
      <div
        className={styles.treeWrap}
        onKeyDownCapture={(e) => {
          if (checkboxes && e.key === " " && !e.metaKey && !e.ctrlKey && selected.size) {
            e.preventDefault();
            e.stopPropagation();
            toggle(selectedNodes());
          } else if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey) {
            const group = selectedNodes().find((x) => x.type === "group" && x.changelist);
            if (group?.changelist) {
              e.preventDefault();
              e.stopPropagation();
              void executeAction("vcs.changelist.delete", group.changelist);
            }
          } else if (e.key === "F4") {
            const n = selectedNodes().find((x) => x.type === "file");
            if (n?.path) {
              e.preventDefault();
              void editorService().openFile(n.path, { focus: true });
            }
          }
        }}
      >
        <Tree<ChangeNode>
          handleRef={treeRef}
          roots={roots}
          getKey={(n) => n.key}
          getLabel={nodeText}
          getChildren={(n) => n.children}
          isExpandable={(n) => n.type !== "file"}
          expanded={expanded}
          onExpandedChange={(_next, node, open) =>
            setCollapsed((c) => {
              const s = new Set(c);
              if (open) s.delete(node.key);
              else s.add(node.key);
              return s;
            })
          }
          selected={selected}
          onSelectionChange={(sel) => {
            setSelected(sel);
            const nodes = [...sel].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);
            useCommit.setState({
              selection: filesOf(nodes).map((f) => f.path),
              selectedList: nodes.find((n) => n.changelist)?.changelist ?? null,
            });
          }}
          onActivate={(n) => openNode(n, roots)}
          onContextMenu={(node, sel, e: MouseEvent) => {
            if (!node) return;
            if (node.type === "group" && node.changelist) {
              const paths = node.files.map((f) => stripSlash(f.path));
              showContextMenu(e, listMenu(node.changelist, !!node.active, paths));
              return;
            }
            const nodes = [...sel].map((k) => byKey.get(k)).filter((n): n is ChangeNode => !!n);
            showContextMenu(e, nodeMenu(nodes.length ? nodes : [node], repos));
          }}
          aria-label="Changes"
          empty={
            <span className={styles.empty}>
              <T>No local changes</T>
            </span>
          }
          renderNode={(n, st) => {
            const agg = aggregateCheck(n.files, checks);
            const label = (
              <span
                className={clsx(
                  styles.label,
                  n.type === "group" && styles.groupLabel,
                  n.type === "group" && n.changelist && !n.active && styles.inactiveList,
                )}
                style={n.type === "file" && n.kind ? { color: KIND_COLOR[n.kind] } : undefined}
                title={n.type === "file" && n.kind ? tx(KIND_LABEL[n.kind]) : undefined}
              >
                {nodeText(n)}
              </span>
            );
            // Pointer-driven (HTML5 drag and drop never reaches the Tauri webview):
            // files and folders drag; any row takes them into its changelist.
            const list = n.changelist;
            const dnd =
              list === undefined
                ? {}
                : {
                    ref: (el: HTMLSpanElement | null) =>
                      el
                        ? registerDropTarget(el, {
                            accepts: (type) => type === CHANGES_MIME,
                            over: () => setDropTarget(list),
                            leave: () => setDropTarget(null),
                            drop: (data) => {
                              setDropTarget(null);
                              moveToChangelist(data.payload.split("\n"), list);
                            },
                          })
                        : undefined,
                    ...(n.type !== "group" && {
                      onPointerDown: (e: PointerEvent<HTMLSpanElement>) => {
                        const paths =
                          selected.has(n.key) && selected.size > 1
                            ? filesOf(selectedNodes()).map((f) => f.path)
                            : n.files.map((f) => f.path);
                        startPointerDrag(e, e.currentTarget, {
                          type: CHANGES_MIME,
                          payload: paths.map(stripSlash).join("\n"),
                        });
                      },
                    }),
                  };
            return (
              <span
                className={clsx(styles.nodeRow, n.type === "group" && dropTarget === n.changelist && styles.dropTarget)}
                {...dnd}
              >
                {checkboxes && (
                  <CheckMark
                    checked={agg.checked}
                    indeterminate={agg.indeterminate}
                    label={tx`Include ${n.label} in commit`}
                    onToggle={() => toggle(selected.has(n.key) && selected.size > 1 ? selectedNodes() : [n])}
                  />
                )}
                {n.type === "group" ? null : (
                  <Icon
                    name={n.type === "dir" ? (st.expanded ? "folder-open" : "folder") : fileIconName(n.label)}
                    size={16}
                    className={styles.icon}
                  />
                )}
                {label}
                {n.type === "group" && <span className={styles.detail}>{fileCount(n.files.length)}</span>}
                {n.type === "file" && n.files[0] && isPartiallyStaged(n.files[0]) && (
                  <span className={styles.partial} title={tx("Partially staged: only staged hunks are committed")}>
                    <T>partial</T>
                  </span>
                )}
                {n.detail && <span className={styles.detail}>{n.detail}</span>}
              </span>
            );
          }}
        />
      </div>
    </div>
  );
}

/** Commit message inspections (Settings › Version Control › Commit). */
export function messageProblems(
  message: string,
  c: {
    blankLineAfterSubject: boolean;
    limitSubject: boolean;
    subjectLimit: number;
    limitBody: boolean;
    bodyLimit: number;
  },
): string[] {
  const lines = message.split("\n");
  const out: string[] = [];
  if (c.limitSubject && (lines[0]?.length ?? 0) > c.subjectLimit)
    out.push(`Subject line is longer than ${c.subjectLimit} characters`);
  if (c.blankLineAfterSubject && lines.length > 1 && lines[1]!.trim() !== "")
    out.push("Missing blank line between subject and body");
  if (c.limitBody) {
    const long = lines.slice(1).findIndex((l) => l.length > c.bodyLimit);
    if (long >= 0) out.push(`Body line ${long + 2} is longer than ${c.bodyLimit} characters`);
  }
  return out;
}

/** "Wrap when typing reaches right margin": breaks the caret line at the last space before `limit`. */
export function wrapAtMargin(text: string, caret: number, limit: number): { text: string; caret: number } | null {
  const start = text.lastIndexOf("\n", caret - 1) + 1;
  const end = text.indexOf("\n", caret);
  const line = text.slice(start, end < 0 ? text.length : end);
  if (start === 0 || line.length <= limit) return null; // the subject line is never wrapped
  const cut = line.lastIndexOf(" ", limit);
  if (cut <= 0) return null;
  const at = start + cut;
  return { text: `${text.slice(0, at)}\n${text.slice(at + 1)}`, caret };
}

export interface CommitRunner {
  busy: boolean;
  /** Commit was asked for without a message: reported at the field. */
  emptyError: boolean;
  clearEmptyError: () => void;
  /** Whether the Commit buttons are enabled. */
  canCommit: boolean;
  run: (push: boolean) => Promise<void>;
}

/**
 * Commit / Commit and Push… of the Commit tool window and the Commit dialog: the
 * shared pipeline (`commitChanges`), then the push. `onCommitted` runs after a commit.
 */
export function useCommitRunner(included: number, onCommitted?: () => void): CommitRunner {
  const amend = useCommit((s) => s.amend);
  const merging = useVcs((s) => s.branch?.operation === "merge");
  const [emptyError, setEmptyError] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (push: boolean) => {
    if (busy) return;
    // IDEA keeps Commit enabled and reports an empty message at the field.
    if (!useCommit.getState().message.trim() && !useCommit.getState().amend) {
      setEmptyError(true);
      useCommit.setState((s) => ({ focusTick: s.focusTick + 1 }));
      return;
    }
    setBusy(true);
    try {
      const id = await commitChanges();
      if (id === undefined) return;
      onCommitted?.();
      if (push) void pushAfterCommit();
    } finally {
      setBusy(false);
    }
  };
  return {
    busy,
    emptyError,
    clearEmptyError: () => setEmptyError(false),
    canCommit: (included > 0 || amend || merging) && !busy,
    run,
  };
}

/** Amend, message history and the message field with its inspections and failed checks. */
export function CommitMessageField({ included, runner }: { included: number; runner: CommitRunner }) {
  const message = useCommit((s) => s.message);
  const amend = useCommit((s) => s.amend);
  const focusTick = useCommit((s) => s.focusTick);
  const ref = useRef<HTMLTextAreaElement>(null);
  const historyRef = useRef<HTMLButtonElement>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyTick = useCommit((s) => s.historyTick);
  const checkProblems = useCommit((s) => s.checkProblems);
  const { emptyError } = runner;

  // The failed checks concern what was about to be committed: editing it dismisses them.
  useEffect(() => {
    if (useCommit.getState().checkProblems.length) useCommit.setState({ checkProblems: [] });
  }, [message, amend, included]);

  useEffect(() => {
    if (focusTick) ref.current?.focus();
  }, [focusTick]);
  // Show Commit Message History (⌃M) asks through the store.
  const [seenHistoryTick, setSeenHistoryTick] = useState(historyTick);
  if (historyTick !== seenHistoryTick) {
    setSeenHistoryTick(historyTick);
    if (messageHistory().length) setHistoryOpen(true);
  }

  const cfg = useWorkflowSettings((s) => s.vcs.commit);
  const first = message.split("\n")[0] ?? "";
  const tooLong = cfg.limitSubject && first.length > cfg.subjectLimit;
  const problems = messageProblems(message, cfg).filter((p) => !p.startsWith("Subject line"));
  const margin = cfg.limitBody ? cfg.bodyLimit : cfg.subjectLimit;
  const showMargin = cfg.showRightMargin && (cfg.limitBody || cfg.limitSubject);
  const history = messageHistory();

  return (
    <>
      <div className={styles.commitBar}>
        <Checkbox checked={amend} onChange={(v) => void setAmend(v)} label="Amend" />
        <IconButton
          ref={historyRef}
          icon="history"
          title="Commit Message History"
          size="small"
          disabled={!history.length}
          aria-haspopup="menu"
          aria-expanded={historyOpen}
          onClick={() => setHistoryOpen((o) => !o)}
        />
        <Menu
          open={historyOpen}
          onClose={() => setHistoryOpen(false)}
          anchor={historyRef}
          placement="bottom-end"
          aria-label="Recent commit messages"
          items={history.map((m, i) => ({
            id: `h${i}`,
            label: m.split("\n")[0]!.slice(0, 80),
            run: () => {
              useCommit.setState({ message: m });
              ref.current?.focus();
            },
          }))}
        />
        <span className={styles.grow} />
        {tooLong && (
          <span className={clsx(styles.lineLen, styles.lineLenWarn)} title={tx("Subject line length")}>
            {first.length}/{cfg.subjectLimit}
          </span>
        )}
      </div>
      <textarea
        ref={ref}
        className={clsx(styles.message, !showMargin && styles.noMargin, emptyError && styles.messageError)}
        aria-invalid={emptyError || undefined}
        style={{ ["--guide" as string]: `${margin}ch` }}
        value={message}
        placeholder={tx("Commit Message")}
        aria-label={tx("Commit message")}
        spellCheck
        onChange={(e) => {
          const el = e.target;
          const wrapped =
            cfg.limitBody && cfg.wrapAtMargin ? wrapAtMargin(el.value, el.selectionStart, cfg.bodyLimit) : null;
          useCommit.setState({ message: wrapped?.text ?? el.value });
          runner.clearEmptyError();
          if (wrapped) requestAnimationFrame(() => el.setSelectionRange(wrapped.caret, wrapped.caret));
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void runner.run(e.altKey);
          } else if (e.key === "Escape") {
            e.currentTarget.blur();
          }
        }}
      />
      {emptyError && (
        <div className={clsx(styles.inspections, styles.inspectionError)} role="alert">
          <T>Specify commit message</T>
        </div>
      )}
      {problems.length > 0 && (
        <div className={styles.inspections} role="status">
          {problems.join(" · ")}
        </div>
      )}
      {checkProblems.length > 0 && (
        <div className={styles.checkProblems} role="alert">
          <Icon name="warning" size={14} className={styles.checkProblemsIcon} />
          <div className={styles.checkProblemsList}>
            {checkProblems.map((p, i) => (
              <div key={i}>
                <span className={styles.checkProblemTitle}>{tx(p.title)}</span>
                {typeof p.text === "string" ? `: ${tx(p.text)}` : p.text}
                {p.details && (
                  <>
                    {" "}
                    <button type="button" className={styles.checkProblemLink} onClick={p.details.run}>
                      {tx(p.details.label)}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

/** Label of the Commit button. */
export function commitLabel(amend: boolean, problems: boolean): string {
  return problems ? "Commit Anyway" : amend ? "Amend Commit" : "Commit";
}

/** Label of the Commit and Push button. */
export const commitAndPushLabel = (amend: boolean) => (amend ? "Amend and Push…" : "Commit and Push…");

/** The message and the Commit buttons of the Commit tool window. */
function CommitPanel({ included }: { included: number }) {
  const amend = useCommit((s) => s.amend);
  const remoteBusy = useVcs((s) => s.remoteBusy);
  const checkProblems = useCommit((s) => s.checkProblems);
  const optionsRef = useRef<HTMLButtonElement>(null);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const runner = useCommitRunner(included);
  const { canCommit } = runner;

  return (
    <div className={styles.commit}>
      <CommitMessageField included={included} runner={runner} />
      <div className={styles.commitActions}>
        <Button variant="primary" disabled={!canCommit} onClick={() => void runner.run(false)} title="⌘↩">
          <T>{commitLabel(amend, checkProblems.length > 0)}</T>
        </Button>
        <Button
          className={styles.pushButton}
          disabled={!canCommit || !!remoteBusy}
          onClick={() => void runner.run(true)}
          title="⌥⌘↩"
        >
          <span>
            <T>{commitAndPushLabel(amend)}</T>
          </span>
        </Button>
        <span className={styles.grow} />
        <IconButton
          ref={optionsRef}
          icon="settings"
          title="Commit Options"
          size="small"
          aria-haspopup="dialog"
          aria-expanded={optionsOpen}
          onClick={() => setOptionsOpen((o) => !o)}
        />
        {optionsOpen && <CommitOptionsPopup anchor={optionsRef} onClose={() => setOptionsOpen(false)} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function StashesPanel() {
  const repo = useVcs((s) => s.repo);
  const repos = useVcs((s) => s.roots);
  const version = useVcs((s) => s.version);
  const [tick, setTick] = useState(0);
  const [active, setActive] = useState(0);
  const request = useMemo(() => ({ repos, repo, version, tick }), [repos, repo, version, tick]);
  const [result, setResult] = useState<{
    request: typeof request;
    stashes: (import("@/bindings").Stash & { repo: string | null })[];
    error: string | null;
  } | null>(null);
  const loaded = result?.request === request;
  const stashes = loaded ? result.stashes : [];
  const error = loaded ? result.error : null;
  useEffect(() => {
    let live = true;
    void Promise.all(
      (request.repos.length ? request.repos : [request.repo]).map(async (root) =>
        (await call(commands.vcsStashes(root))).map((s) => ({ ...s, repo: root })),
      ),
    )
      .then((lists) => {
        if (live) setResult({ request, stashes: lists.flat(), error: null });
      })
      .catch((e) => {
        if (live) setResult({ request, stashes: [], error: String(e) });
      });
    return () => {
      live = false;
    };
  }, [request]);
  const current = stashes[active];
  return (
    <div className={styles.changes}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Stashes")}>
        {repos.length > 1 && (
          <Select
            aria-label="Repository"
            value={repo}
            onChange={(root) => void selectRepo(root)}
            options={repos.map((root) => ({ value: root, label: repoName(root) }))}
          />
        )}
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => setTick((n) => n + 1)} />
        <IconButton icon="plus" title="Stash Changes…" size="small" onClick={() => void stashChanges()} />
        <span className={styles.sep} />
        <IconButton
          icon="check"
          title="Apply Stash"
          size="small"
          disabled={!current}
          onClick={() => current && void applyStash(current.index, false, current.repo)}
        />
        <IconButton
          icon="undo"
          title="Pop Stash (Apply and Drop)"
          size="small"
          disabled={!current}
          onClick={() => current && void applyStash(current.index, true, current.repo)}
        />
        <IconButton
          icon="trash"
          title="Drop Stash"
          size="small"
          disabled={!current}
          onClick={() => current && void dropStash(current.index, current.message, current.repo)}
        />
      </div>
      <List
        items={stashes}
        getKey={(s) => `${s.repo}:${s.index}`}
        activeIndex={Math.min(active, Math.max(0, stashes.length - 1))}
        onActiveChange={setActive}
        rowHeight={22}
        aria-label="Stashes"
        className={styles.stashList}
        empty={<span className={styles.empty}>{error ?? (loaded ? tx("No stashes") : tx("Loading…"))}</span>}
        onActivate={(s, _i, e) => {
          if (e.type === "click" && (e as MouseEvent).detail < 2) return;
          void applyStash(s.index, false, s.repo);
        }}
        onContextMenu={(s, i, e) => {
          e.preventDefault();
          setActive(i);
          showContextMenu(e, [
            { label: "Apply Stash", icon: "check", run: () => void applyStash(s.index, false, s.repo) },
            { label: "Pop Stash", icon: "undo", run: () => void applyStash(s.index, true, s.repo) },
            { label: "Unstash…", run: () => showUnstashDialog(s.index, s.repo) },
            { kind: "separator" },
            { label: "Drop Stash", icon: "trash", run: () => void dropStash(s.index, s.message, s.repo) },
          ]);
        }}
        renderItem={(s) => {
          const { branch, text } = stashLabel(s.message);
          return (
            <span className={styles.stashRow} title={`stash@{${s.index}}: ${s.message}`}>
              <span className={styles.stashMessage}>
                {repos.length > 1 && s.repo ? `${repoName(s.repo)} · ` : ""}
                {text}
              </span>
              {branch && <span className={styles.detail}>{branch}</span>}
              <span className={styles.detail}>{formatTime(s.timeMs)}</span>
            </span>
          );
        }}
      />
    </div>
  );
}
