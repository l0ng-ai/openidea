import type { ChangedFile, Commit, LinkTarget } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { setContext } from "@/platform/context";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import {
  EmptyState,
  Icon,
  IconButton,
  Spinner,
  SplitGroup,
  SplitHandle,
  SplitPanel,
  T,
  Tree,
  fileIconName,
  lazyComponent,
  showContextMenu,
  type MenuItem,
  type TreeHandle,
} from "@/ui";
import { maybeEditorService, type EditorInput } from "@/workbench/contributions";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { DIFF_KIND, diffInput, vcsDiffInFront } from "../diffInput";
import { buildFileTree, dirKeys, type FileTreeNode } from "../fileTree";
import styles from "../GitLog.module.css";
import {
  absolutePath,
  filesUnder,
  flatFileNodes,
  showChangesDiff,
  toLogChanges,
  useLogChanges,
  withLineStats,
  type LogChange,
} from "../logChanges";
import { LogIdContext } from "../logContext";
import { logOptions, useLogOptions } from "../logOptions";
import { openLogTab, updateLogOptions, useGitLog } from "../logStore";
import { KIND_COLOR, dirName, fileCount, renameFrom, type EffectiveKind } from "../model";
import { commitKey, commitRepo } from "../multiRoot";
import { currentRepo, repoName } from "../store";
import { CommitMessage } from "./CommitMessage";
import { useDropdownMenu, useReadOnlyLog } from "./logHooks";
import { toggle } from "./shared";

const LogMergePreview = lazyComponent(() => import("../GitMergeDiff").then((m) => m.GitMergeDiff));

const LogDiffPreview = lazyComponent(() => import("../DiffEditor").then((m) => m.DiffEditor));

/** Keyboard moves through several files quickly: preview the one the selection settles on. */
const PREVIEW_DELAY = 120;

function fileNodeAt<F>(nodes: readonly FileTreeNode<F>[], key: string): FileTreeNode<F> | null {
  for (const n of nodes) {
    if (n.key === key) return n.file ? n : null;
    if (!n.file) {
      const hit = fileNodeAt(n.children, key);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * The selected commits' changes: one commit's files against its first parent, or, for several
 * (IDEA), their combined changes with every selected commit listed below.
 */
export function CommitDetails({ commits }: { commits: Commit[] }) {
  const scope = useContext(LogIdContext);
  const [menuBelow, dropdown] = useDropdownMenu();
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const readOnly = useReadOnlyLog();
  const selected = useGitLog((s) => s.selected);
  const selection = useGitLog((s) => s.selection);
  // Newest first (log order).
  const chosen = useMemo(() => {
    const ids = new Set(selection);
    return commits.filter((c) => ids.has(commitKey(c)));
  }, [commits, selection]);
  const commit = selected ? commits.find((c) => commitKey(c) === selected) : undefined;
  const many = chosen.length > 1;
  const idsKey = chosen.map(commitKey).join(" ");
  const commitRoot = commit ? commitRepo(commit) : null;
  const [result, setResult] = useState<{
    key: string;
    files: LogChange[] | null;
    error: string | null;
  } | null>(null);
  const [expanded, setExpanded] = useState<Set<string> | null>(null);
  const [parentIndex, setParentIndex] = useState(-1);
  const fromParents = useLogOptions((s) => s.changesFromParents);
  const onlyAffected = useLogOptions((s) => s.showOnlyAffected);
  const preview = useLogOptions((s) => s.diffPreview);
  const savedLocation = useLogOptions((s) => s.diffLocation);
  // The modal commit interface keeps diffs out of editor tabs (#1863): the "Editor"
  // preview shows beside the changes instead.
  const modal = useWorkflowSettings((s) => !s.vcs.commit.nonModal);
  const diffLocation = modal && savedLocation === "editor" ? "right" : savedLocation;
  const showLineStats = useLogOptions((s) => s.showLineStats);
  const filters = useGitLog((s) => s.filters);
  const filesKey = JSON.stringify([idsKey, fromParents, parentIndex, commitRoot, showLineStats]);
  const files = result?.key === filesKey ? result.files : null;
  const error = result?.key === filesKey ? result.error : null;

  useEffect(() => {
    if (!idsKey) return;
    let alive = true;
    const load = (async () => {
      if (many) {
        const roots = [...new Set(chosen.map(commitRepo))];
        return (
          await Promise.all(
            roots.map(async (repo) => {
              const group = chosen.filter((c) => commitRepo(c) === repo);
              const files = await call(
                commands.vcsCommitsChanges(repo ?? currentRepo(), group.map((c) => c.id).reverse()),
              );
              return toLogChanges(files, null, repo, readOnly);
            }),
          )
        ).flat();
      }
      const c = chosen[0]!;
      if (c.parents.length > 1) {
        const groups = await Promise.all(
          c.parents.map(async (id, index) => {
            const files = await call(commands.vcsDiffRevisions(commitRoot ?? currentRepo(), id, c.id));
            return toLogChanges(files, { ...c, parents: [id] }, commitRoot, readOnly).map((f) => ({
              ...f,
              group: `${tx("Parent")} ${index + 1}: ${id.slice(0, 8)}`,
            }));
          }),
        );
        if (fromParents) return parentIndex < 0 ? groups.flat() : (groups[parentIndex] ?? []);
        // A merge's combined changes are files changed against every parent.
        return groups[0]!
          .filter((f) => groups.every((group) => group.some((x) => x.path === f.path)))
          .map((f) => ({
            ...f,
            group: undefined,
            mergeParents: c.parents
              .slice(0, 2)
              .map((rev, i) => ({ rev, path: groups[i]!.find((x) => x.path === f.path)?.oldPath ?? f.path })),
          }));
      }
      const files = await call(commands.vcsCommitFiles(commitRoot ?? currentRepo(), c.id));
      return toLogChanges(files, c, commitRoot, readOnly);
    })();
    load
      .then((files) => (showLineStats ? withLineStats(files).catch(() => files) : files))
      .then((files) => alive && setResult({ key: filesKey, files, error: null }))
      .catch(
        (e) => alive && setResult({ key: filesKey, files: null, error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, fromParents, parentIndex, commitRoot, filesKey, many, readOnly, showLineStats]);

  const groupByDirectory = useLogOptions((s) => s.groupByDirectory);
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(() => new Set());
  const treeRef = useRef<TreeHandle>(null);
  const [diffToReveal, setDiffToReveal] = useState<{ key: string } | null>(null);
  const syncingDiff = useRef(false);
  const changes = useMemo(() => {
    const changes = files ?? [];
    const paths = filters.paths?.length ? filters.paths : filters.path ? [filters.path] : [];
    return onlyAffected && paths.length
      ? changes.filter((c) =>
          paths.some((p) => {
            const matches = (rel: string) => {
              const abs = absolutePath(rel, c.repo);
              return abs === p || abs.startsWith(`${p}/`) || (!many && commit?.historyPath === rel);
            };
            return matches(c.path) || (c.oldPath != null && matches(c.oldPath));
          }),
        )
      : changes;
  }, [files, commit, many, filters.path, filters.paths, onlyAffected]);
  const lineTotals = useMemo(() => {
    if (!showLineStats || !changes.length) return null;
    if (changes.some((f) => f.added === undefined || f.removed === undefined)) return null;
    return changes.reduce((sum, f) => ({ added: sum.added + f.added!, removed: sum.removed + f.removed! }), {
      added: 0,
      removed: 0,
    });
  }, [changes, showLineStats]);
  const multipleRoots = new Set(chosen.map(commitRepo)).size > 1;
  const changeTreePath = useCallback(
    (f: LogChange) => `${multipleRoots ? `${repoName(f.repo ?? "")}/` : ""}${f.group ? `${f.group}/` : ""}${f.path}`,
    [multipleRoots],
  );
  const tree = useMemo(
    () => (groupByDirectory ? buildFileTree(changes, changeTreePath) : flatFileNodes(changes, changeTreePath)),
    [changes, groupByDirectory, changeTreePath],
  );
  const allDirs = useMemo(() => dirKeys(tree), [tree]);
  const ordered = useMemo(() => filesUnder(tree), [tree]);
  const chosenChanges = useMemo(() => filesUnder(tree, selectedKeys), [tree, selectedKeys]);

  // Show Diff Preview: a single selected file follows into the editor's preview tab.
  const previewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (!active) clearTimeout(previewTimer.current);
    return () => clearTimeout(previewTimer.current);
  }, [active]);
  const previewSelection = (sel: ReadonlySet<string>) => {
    clearTimeout(previewTimer.current);
    if (syncingDiff.current || sel.size !== 1) return;
    // While the editor shows one of this pane's diffs, the selection walks it along (a click or
    // arrow key), as in the Commit window.
    const shown = maybeEditorService()?.activeInput?.();
    const following = shown?.kind === DIFF_KIND && ordered.some((c) => diffInput(c.diff).key === shown.key);
    if (!following && (!logOptions().diffPreview || logOptions().diffLocation !== "editor" || vcsDiffInFront())) return;
    const file = fileNodeAt(tree, [...sel][0]!)?.file;
    // A preview that cannot open (no editor yet, the file went away) is just skipped.
    if (file)
      previewTimer.current = setTimeout(() => void showChangesDiff([file], true).catch(() => undefined), PREVIEW_DELAY);
  };

  // Follow only this pane's exact diff (path AND revisions); another commit or
  // Compare with Local must not move its selection. Never take focus from F7.
  useEffect(() => {
    const editor = maybeEditorService();
    const followDiff = (input: EditorInput | null) => {
      if (input?.kind !== DIFF_KIND) return;
      const change = ordered.find((c) => diffInput(c.diff).key === input.key);
      if (!change) return;
      clearTimeout(previewTimer.current);
      const rel = changeTreePath(change);
      setExpanded((current) => {
        const next = new Set(current ?? allDirs);
        for (const key of allDirs) if (rel.startsWith(key.slice(2) + "/")) next.add(key);
        return next;
      });
      setDiffToReveal({ key: `f:${rel}` });
    };
    followDiff(editor?.activeInput?.() ?? null);
    return editor?.onActiveInputChange?.(followDiff);
  }, [ordered, allDirs, changeTreePath]);

  // Tree.reveal needs the expanded rows to have rendered. Suppress the reverse
  // preview update so it cannot reopen the diff and lose its requested chunk.
  useLayoutEffect(() => {
    if (!diffToReveal) return;
    syncingDiff.current = true;
    treeRef.current?.reveal(diffToReveal.key);
    syncingDiff.current = false;
  }, [diffToReveal]);

  useEffect(() => {
    if (!active) return;
    useLogChanges.setState({ commits: chosen, all: ordered, selected: chosenChanges });
  }, [chosen, ordered, chosenChanges, active]);
  useEffect(
    () => () => {
      if (!scope || useGitLog.getState().shownLog === scope)
        useLogChanges.setState({ commits: [], all: [], selected: [] });
    },
    [scope],
  );
  useEffect(() => () => setContext("vcsLogChangesFocus", false), []);

  if (!commit)
    return (
      <div className={styles.details}>
        <EmptyState>
          <T>Select a commit to view changes</T>
        </EmptyState>
      </div>
    );

  const openViewOptions = (e: ReactMouseEvent<HTMLElement>) =>
    menuBelow(e, [
      { kind: "header", label: "Group By" },
      { kind: "action", action: "vcs.log.changes.groupByDirectory" },
      { kind: "separator" },
      { kind: "action", action: "vcs.log.changes.diffPreview" },
      toggle("Show Only Affected Changes", logOptions(), "showOnlyAffected"),
      toggle("Show lines added and deleted", logOptions(), "showLineStats"),
      toggle("Show Changes from Parents", logOptions(), "changesFromParents"),
      {
        label: "Diff Preview Location",
        submenu: (["editor", "right", "bottom"] as const).map((location) => ({
          label: location === "editor" ? "Editor" : location === "right" ? "Right" : "Bottom",
          checked: savedLocation === location,
          run: () => updateLogOptions({ diffLocation: location }),
        })),
      },
    ]);

  const onFileMenu = (node: FileTreeNode<LogChange> | null, sel: ReadonlySet<string>, e: ReactMouseEvent) => {
    if (!node) return;
    const target = sel.has(node.key) ? filesUnder(tree, sel) : filesUnder([node]);
    if (!target.length) return;
    e.preventDefault();
    showContextMenu(e, changesMenu(target));
  };

  const details = (
    <SplitGroup orientation="vertical" id="git-log-details" storageKey="openidea.vcs.logDetailsSplit">
      <SplitPanel id="files" defaultSize="60%" minSize="60px">
        <div
          className={styles.filesPane}
          onFocusCapture={() => setContext("vcsLogChangesFocus", true)}
          onBlurCapture={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setContext("vcsLogChangesFocus", false);
          }}
        >
          <div className={styles.detailsBar} role="toolbar" aria-label={tx("Changed files")}>
            <IconButton
              icon="diff"
              size="small"
              title="Show Diff"
              action="vcs.log.changes.showDiff"
              actionArg={chosenChanges}
              disabled={!chosenChanges.length}
            />
            <IconButton
              icon="revert"
              size="small"
              title="Revert Selected Changes"
              action="vcs.log.changes.revert"
              actionArg={chosenChanges}
              disabled={readOnly || !chosenChanges.length || new Set(chosenChanges.map((c) => c.repo)).size > 1}
            />
            <IconButton icon="eye" title="View Options" size="small" aria-haspopup="menu" onClick={openViewOptions} />
            {!many && fromParents && commit.parents.length > 1 && (
              <button
                type="button"
                className={styles.filterMain}
                onClick={(e) =>
                  menuBelow(e, [
                    { label: tx("All Parents"), checked: parentIndex < 0, run: () => setParentIndex(-1) },
                    ...commit.parents.map((id, index) => ({
                      label: `${tx("Parent")} ${index + 1}: ${id.slice(0, 8)}`,
                      checked: index === parentIndex,
                      run: () => setParentIndex(index),
                    })),
                  ])
                }
              >
                {parentIndex < 0 ? tx("All Parents") : `${tx("Parent")} ${parentIndex + 1}`}
              </button>
            )}
            <span className={styles.detailsCount}>
              {files ? fileCount(changes.length) : ""}
              {many ? " " + tx`in ${chosen.length} commits` : ""}
            </span>
            {lineTotals && <LineStats added={lineTotals.added} removed={lineTotals.removed} />}
            <span className={styles.grow} />
            <IconButton
              icon="expand-all"
              title="Expand All"
              size="small"
              disabled={!allDirs.length}
              onClick={() => setExpanded(new Set(allDirs))}
            />
            <IconButton
              icon="collapse-all"
              title="Collapse All"
              size="small"
              disabled={!allDirs.length}
              onClick={() => setExpanded(new Set())}
            />
          </div>
          {error && <div className={styles.message}>{error}</div>}
          {!files && !error && (
            <div className={styles.message}>
              <Spinner size={12} />
            </div>
          )}
          {files && (
            <Tree<FileTreeNode<LogChange>>
              handleRef={treeRef}
              roots={tree}
              getKey={(n) => n.key}
              getLabel={(n) => n.name}
              getChildren={(n) => (n.file ? undefined : n.children)}
              isExpandable={(n) => !n.file}
              expanded={expanded ?? new Set(allDirs)}
              onExpandedChange={(next) => setExpanded(next)}
              selected={selectedKeys}
              onSelectionChange={(sel) => {
                setSelectedKeys(sel);
                previewSelection(sel);
              }}
              renderNode={(n) => <ChangedFileRow node={n} flat={!groupByDirectory} />}
              onActivate={(n) => n.file && void showChangesDiff([n.file])}
              onJumpToSource={(n, sel) => {
                const files = sel.has(n.key) ? filesUnder(tree, sel) : filesUnder([n]);
                void executeAction("vcs.log.changes.jumpToSource", files);
              }}
              onContextMenu={onFileMenu}
              aria-label="Changed files"
              className={styles.fileTree}
            />
          )}
        </div>
      </SplitPanel>
      <SplitHandle />
      <SplitPanel id="message" minSize="60px">
        <div className={styles.messageBox}>
          {many ? (
            chosen.map((c) => <CommitMessage key={commitKey(c)} commit={c} compact />)
          ) : (
            <CommitMessage commit={commit} />
          )}
        </div>
      </SplitPanel>
    </SplitGroup>
  );
  const embedded = preview && diffLocation !== "editor";
  const selectedChange = chosenChanges.length === 1 ? chosenChanges[0] : undefined;
  return (
    <div className={styles.details}>
      {dropdown}
      {embedded ? (
        <SplitGroup
          orientation={diffLocation === "right" ? "horizontal" : "vertical"}
          id={`git-log-preview-${diffLocation}`}
          storageKey={`openidea.vcs.logPreviewSplit.${diffLocation}`}
        >
          <SplitPanel id="changes" defaultSize="55%" minSize="20%">
            {details}
          </SplitPanel>
          <SplitHandle />
          <SplitPanel id="preview" minSize="20%">
            {selectedChange ? (
              selectedChange.mergeParents?.length === 2 && selectedChange.after ? (
                <LogMergePreview
                  input={{
                    kind: "git-merge-diff",
                    key: `git-merge-diff:${selectedChange.repo}:${selectedChange.after}:${selectedChange.path}`,
                    data: {
                      repo: selectedChange.repo,
                      revision: selectedChange.after,
                      path: selectedChange.path,
                      parents: selectedChange.mergeParents,
                    },
                  }}
                />
              ) : (
                <LogDiffPreview key={diffInput(selectedChange.diff).key} input={diffInput(selectedChange.diff)} />
              )
            ) : (
              <EmptyState>
                <T>Select a file to preview its changes</T>
              </EmptyState>
            )}
          </SplitPanel>
        </SplitGroup>
      ) : (
        details
      )}
    </div>
  );
}

/** IDEA's changes browser context menu in the Git Log; `changes` = the files it acts on. */
export function changesMenu(changes: LogChange[]): MenuItem[] {
  const one = changes.length === 1 ? changes[0]! : null;
  return [
    { kind: "action", action: "vcs.log.changes.showDiff", arg: changes },
    { kind: "action", action: "vcs.log.changes.compareWithLocal", arg: changes, disabled: !one?.after || one.readOnly },
    {
      kind: "action",
      action: "vcs.log.changes.compareBeforeWithLocal",
      arg: changes,
      disabled: !one?.before || one.readOnly,
    },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.changes.jumpToSource",
      arg: changes,
      disabled: !changes.some((c) => c.after && !c.readOnly),
    },
    { kind: "separator" },
    {
      kind: "action",
      action: "vcs.log.changes.revert",
      arg: changes,
      disabled: changes.some((c) => c.readOnly) || new Set(changes.map((c) => c.repo)).size > 1,
    },
    {
      kind: "action",
      action: "vcs.log.changes.getFromRevision",
      arg: changes,
      disabled: changes.some((c) => c.readOnly),
    },
    { kind: "separator" },
    ...(one?.readOnly
      ? [{ label: "Show History for File", run: () => openLogTab("history", absolutePath(one.path, one.repo)) }]
      : [
          {
            kind: "action",
            action: "vcs.showHistory",
            arg: one ? absolutePath(one.path, one.repo) : undefined,
            disabled: !one?.after,
          } satisfies MenuItem,
        ]),
  ];
}

function lineCount(file: ChangedFile | LogChange): { added: number; removed: number } | null {
  if (!("added" in file) || typeof file.added !== "number" || typeof file.removed !== "number") return null;
  return { added: file.added, removed: file.removed };
}

/** Sum of a directory once every file under it has counts; otherwise the row stays without them. */
function nodeLineCount(node: FileTreeNode<ChangedFile | LogChange>): { added: number; removed: number } | null {
  if (node.file) return lineCount(node.file);
  let added = 0;
  let removed = 0;
  for (const child of node.children) {
    const count = nodeLineCount(child);
    if (!count) return null;
    added += count.added;
    removed += count.removed;
  }
  return node.children.length ? { added, removed } : null;
}

function LineStats({ added, removed }: { added: number; removed: number }) {
  return (
    <span className={styles.lineStats}>
      <span className={styles.lineAdded} aria-label={added === 1 ? tx`${added} line added` : tx`${added} lines added`}>
        +{added}
      </span>
      <span
        className={styles.lineRemoved}
        aria-label={removed === 1 ? tx`${removed} line deleted` : tx`${removed} lines deleted`}
      >
        −{removed}
      </span>
    </span>
  );
}

function ChangedFileRow({ node, flat = false }: { node: FileTreeNode<ChangedFile | LogChange>; flat?: boolean }) {
  const stats = nodeLineCount(node);
  if (!node.file)
    return (
      <span className={styles.fileRow}>
        <Icon name="folder" size={16} className={styles.fileIcon} />
        <span className={styles.fileName}>{node.name}</span>
        <span className={styles.fileDir}>{fileCount(node.count)}</span>
        {stats && <LineStats added={stats.added} removed={stats.removed} />}
      </span>
    );
  const f = node.file;
  const kind: EffectiveKind = f.kind === "untracked" ? "added" : f.kind;
  return (
    <span className={styles.fileRow} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}>
      <ChangedFileIcon name={node.name} link={f.link} />
      <span className={styles.fileName} style={{ color: KIND_COLOR[kind] }}>
        {node.name}
      </span>
      {flat && dirName(f.path) && <span className={styles.fileDir}>{dirName(f.path)}</span>}
      {f.oldPath && <span className={styles.fileDir}>{renameFrom(f.path, f.oldPath)}</span>}
      {stats && <LineStats added={stats.added} removed={stats.removed} />}
    </span>
  );
}

/** Like the Project tree: a link shows its target's folder or file icon with IDEA's link arrow. */
function ChangedFileIcon({ name, link }: { name: string; link?: LinkTarget | null }) {
  if (!link) return <Icon name={fileIconName(name)} size={16} className={styles.fileIcon} />;
  const icon = link === "dir" ? "folder" : link === "file" ? fileIconName(name) : "file-unknown";
  const label = link === "unresolved" ? tx("Symbolic link, target not found in this revision") : tx("Symbolic link");
  return (
    <span className={styles.iconStack} data-link={link}>
      <Icon name={icon} size={16} />
      <Icon name="symlink-mark" size={16} className={styles.iconOverlay} label={label} />
    </span>
  );
}
