/**
 * A task's Changes editor tab: its changed files in a tree beside one scrolling diff of
 * them all, with the actions on the task's work (accept, rollback).
 */
import type { AgentChange, AgentCommit, AgentTask } from "@/bindings";
import { CombinedDiffView, type CombinedDiffHandle, type CombinedDiffItem } from "@/features/vcs/CombinedDiff";
import { commitFileDiffData, diffInput, openDiff, withChain, type DiffData } from "@/features/vcs/diffInput";
import { repositoryPath } from "@/features/vcs/repositoryPaths";
import { tx } from "@/platform/i18n";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { isSameOrInside } from "@/platform/paths";
import { basename, dirname, relativeDir, useProject } from "@/platform/project";
import { EmptyState, fileIconName, Icon, IconButton, showContextMenu, Spinner, T, Tabs, Tree } from "@/ui";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "../Session.module.css";
import { setChangesOptions, useChangesOptions, type ChangesScope } from "../changesOptions";
import { formatSentAt } from "../conversation";
import { branchLabel, CHANGES_KIND, changesKey } from "../model";
import { acceptChanges, refreshChanges, rollbackChanges, scheduleChanges, useAgents } from "../store";

/**
 * Current branch of the project's repository for a local-checkout task (`status` is
 * `null` otherwise); followed as git changes, since the agent or the user may switch it.
 */
export function useLocalHead(status: AgentTask["status"] | null, root: string | null): string | null {
  const [head, setHead] = useState<string | null>(null);
  const local = status !== null;
  useEffect(() => {
    if (!local) return;
    let live = true;
    const load = () =>
      void call(commands.vcsBranchInfo(root)).then(
        (b) => live && setHead(b.head ?? b.headCommit?.slice(0, 8) ?? null),
        () => live && setHead(null),
      );
    load();
    const off = onIdeEvent("vcsChanged", load);
    return () => {
      live = false;
      off();
    };
  }, [local, status, root]);
  return local ? head : null;
}

const KIND_COLOR: Partial<Record<AgentChange["kind"], string>> = {
  added: "var(--vcs-added)",
  untracked: "var(--vcs-untracked)",
  modified: "var(--vcs-modified)",
  renamed: "var(--vcs-modified)",
  deleted: "var(--vcs-deleted)",
  conflicted: "var(--vcs-conflict)",
};

/** What a task's changes look like as the options show them: the files, and the commits they're grouped by. */
export function useTaskChanges(id: string) {
  // Grouping needs commits of the task's own: local checkouts keep the flat list.
  const isolation = useAgents((s) => s.tasks.get(id)?.isolation);
  const grouped = useChangesOptions((s) => s.groupByCommit) && isolation === "worktree";
  const sinceStart = useAgents((s) => s.changes.get(id));
  const review = useAgents((s) => s.groupedChanges.get(id));
  const changes = (grouped ? review?.uncommitted : sinceStart) ?? null;
  const commits = (grouped ? review?.commits : undefined) ?? NO_COMMITS;
  return { grouped, changes, commits };
}

const NO_COMMITS: readonly AgentCommit[] = [];

/**
 * Reads the task's changes once the project's agents are connected, and again as its checkout
 * changes. The watcher reports every repository under the project, so the main checkout and other
 * tasks' worktrees would otherwise re-read this task's changes for nothing. A worktree's gitdir is
 * `<project>/.git/worktrees/<slug>`, outside the worktree itself: the watcher only reports the
 * project there, so that is the root its events match.
 */
export function useChangesRefresh(id: string) {
  const connected = useAgents((s) => s.loaded);
  const task = useAgents((s) => s.tasks.get(id));
  const projectRoot = useProject((s) => s.project?.root ?? null);
  const refreshRoot = task?.isolation === "worktree" ? (task.projectRoot ?? projectRoot) : (task?.cwd ?? null);
  useEffect(() => {
    if (connected) void refreshChanges(id);
  }, [id, connected]);
  useEffect(() => {
    if (!connected) return;
    return onIdeEvent("vcsChanged", (e) => {
      if (!refreshRoot || !isSameOrInside(refreshRoot, e.root)) return;
      scheduleChanges(id);
    });
  }, [id, connected, refreshRoot]);
}

/** Shows the task's Changes tab: a new tab the first time, where it already is after that. */
export function openTaskChanges(task: string) {
  void editorService().openInput({ kind: CHANGES_KIND, key: changesKey(task), data: { task } }, { focus: true });
}

const NO_ITEMS: readonly CombinedDiffItem[] = [];

const NO_SELECTION: ReadonlySet<string> = new Set();

/** A row of the Changes pane: a group, a commit, a repository, or a file. */
type ChangeRow =
  | {
      key: string;
      type: "group";
      label: "Uncommitted" | "Committed";
      count: number;
      added: number;
      removed: number;
      children: ChangeRow[];
    }
  | { key: string; type: "commit"; commit: AgentCommit; children: ChangeRow[] }
  | { key: string; type: "repo"; root: string; children: ChangeRow[] }
  | { key: string; type: "file"; change: AgentChange; commit?: AgentCommit };

/** `files` under a row per repository, when the task changed files in several. */
function byRepository(files: ChangeRow[], prefix: string): ChangeRow[] {
  const roots = new Map<string, ChangeRow[]>();
  for (const f of files) {
    const root = f.type === "file" ? f.change.repo : null;
    if (!root) return files;
    roots.set(root, [...(roots.get(root) ?? []), f]);
  }
  if (roots.size < 2) return files;
  return [...roots].map(([root, children]) => ({
    key: `${prefix}repo:${root}`,
    type: "repo" as const,
    root,
    children,
  }));
}

/** The keys of the repository rows, at the top or in a group: shown open. */
function repositoryKeys(rows: readonly ChangeRow[]): string[] {
  return rows
    .flatMap((r) => (r.type === "group" ? r.children : [r]))
    .flatMap((r) => (r.type === "repo" ? [r.key] : []));
}

function statsOf(changes: readonly AgentChange[]) {
  return changes.reduce((n, c) => ({ added: n.added + c.added, removed: n.removed + c.removed }), {
    added: 0,
    removed: 0,
  });
}

function changeRows(
  uncommitted: readonly AgentChange[],
  commits: readonly AgentCommit[],
  grouped: boolean,
): ChangeRow[] {
  if (!grouped)
    return byRepository(
      uncommitted.map((change) => ({ key: change.path, type: "file" as const, change })),
      "",
    );
  const roots: ChangeRow[] = [];
  if (uncommitted.length) {
    roots.push({
      key: "group:uncommitted",
      type: "group",
      label: "Uncommitted",
      count: uncommitted.length,
      ...statsOf(uncommitted),
      children: byRepository(
        uncommitted.map((change) => ({ key: `uncommitted:${change.path}`, type: "file" as const, change })),
        "uncommitted:",
      ),
    });
  }
  if (commits.length) {
    const files = commits.flatMap((commit) => commit.files);
    roots.push({
      key: "group:committed",
      type: "group",
      label: "Committed",
      count: commits.length,
      ...statsOf(files),
      children: commits.map((commit) => ({
        key: `commit:${commit.id}`,
        type: "commit",
        commit,
        children: commit.files.map((change) => ({
          key: `commit:${commit.id}:${change.path}`,
          type: "file",
          change,
          commit,
        })),
      })),
    });
  }
  return roots;
}

export function ChangesTab({ input }: { input: EditorInput }) {
  const id = (input.data as { task: string }).task;
  const task = useAgents((s) => s.tasks.get(id));
  if (!task) return <EmptyState title="This agent task no longer exists" />;
  return <TaskChanges key={id} task={task} tabKey={input.key} />;
}

function TaskChanges({ task, tabKey }: { task: AgentTask; tabKey: string }) {
  useChangesRefresh(task.id);
  const { grouped: groupedView, changes: taskChanges, commits: taskCommits } = useTaskChanges(task.id);
  const scope = useChangesOptions((s) => s.scope);
  const lastTurn = useAgents((s) => s.turnChanges.get(task.id));
  const project = useProject((s) => s.project);
  const head = useLocalHead(
    task.isolation === "local" ? task.status : null,
    project?.workspace ? (task.projectRoot ?? project.root) : null,
  );
  const changes = scope === "turn" ? (lastTurn ?? null) : taskChanges;
  const commits = scope === "turn" ? NO_COMMITS : taskCommits;
  const grouped = groupedView && scope === "task";
  // The views key their rows differently, and list different changes: a selection doesn't carry over.
  const view = scope === "turn" ? "turn" : grouped ? "grouped" : "flat";
  const [selection, setSelection] = useState<{
    view: string;
    keys: ReadonlySet<string>;
  }>(() => ({
    view,
    keys: NO_SELECTION,
  }));
  const selected = selection.view === view ? selection.keys : NO_SELECTION;
  const setSelected = (keys: ReadonlySet<string>) => setSelection({ view, keys });
  const rows = useMemo(() => changeRows(changes ?? [], commits, grouped), [changes, commits, grouped]);
  // Only the working files roll back; a commit's files are history.
  const rollbackable = useMemo(() => {
    const out = new Map<string, AgentChange>();
    const walk = (row: ChangeRow) => {
      if (row.type === "file") {
        if (!row.commit) out.set(row.key, row.change);
      } else if (row.type !== "commit") row.children.forEach(walk);
    };
    rows.forEach(walk);
    return out;
  }, [rows]);
  // Selection keys that no longer name a working file (a commit's file, a stale row) don't count.
  const picked = [...selected].flatMap((key) => rollbackable.get(key) ?? []);
  const added = changes?.reduce((n, c) => n + c.added, 0) ?? 0;
  const removed = changes?.reduce((n, c) => n + c.removed, 0) ?? 0;
  const rollback = async () => {
    const count = picked.length || changes?.length || 0;
    if (!count) return;
    const ok = await confirm({
      title: "Rollback Changes",
      message: (
        <>
          <p>
            {count === 1
              ? tx`Roll back the changes to ${basename((picked[0] ?? changes![0]!).path)}?`
              : tx`Roll back the changes to ${count} files?`}
          </p>
          <p>
            {scope === "turn"
              ? tx(
                  "They go back to how they were when the last turn started. Edits of yours made to them since then are lost too.",
                )
              : grouped
                ? tx("They go back to the last commit; changes made after it are lost.")
                : task.isolation === "worktree"
                  ? tx("They go back to how they were when the task started, in the task's worktree.")
                  : tx(
                      "They go back to how they were when the task started. Edits of yours made to them since then are lost too; edits from before the task are kept.",
                    )}
          </p>
        </>
      ),
      ok: "Rollback",
      icon: "warning",
    });
    if (!ok) return;
    try {
      await rollbackChanges(
        task.id,
        picked.length ? picked.map((c) => c.relPath) : null,
        scope === "turn" ? "lastTurn" : grouped ? "group" : "sinceStart",
      );
      setSelected(new Set());
    } catch (e) {
      notifications().notify({
        level: "error",
        title: tx("Cannot roll back the changes"),
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const accept = async () => {
    // Accepting brings over the task's whole work, committed or not: grouping and the last turn
    // only change the listing.
    const all =
      (grouped || scope === "turn") && !picked.length
        ? await call(commands.agentChanges(task.id, null)).catch(() => changes ?? [])
        : (changes ?? []);
    const targets = picked.length ? picked : all;
    const count = targets.length;
    if (!count) return;
    const name = basename(targets[0]!.path);
    const ok = await confirm({
      title: "Accept Changes",
      message: (
        <>
          <p>
            {count === 1
              ? tx`Copy the changes to ${name} into the local checkout?`
              : tx`Copy the changes to ${count} files into the local checkout?`}
          </p>
          <p>{tx("They land uncommitted. Files you changed yourself since the task started are left alone.")}</p>
        </>
      ),
      ok: "Accept",
      icon: "warning",
    });
    if (!ok) return;
    try {
      const outcome = await acceptChanges(task.id, picked.length ? picked.map((c) => c.relPath) : null);
      setSelected(new Set());
      if (outcome.skipped.length) {
        const skippedNames = outcome.skipped.map((s) => s.path).join(", ");
        notifications().notify({
          level: "warning",
          title: tx("Changes accepted, some files kept"),
          body: tx`You changed them yourself, accept them by hand: ${skippedNames}.`,
        });
      } else {
        notifications().notify({
          level: "info",
          title: tx("Changes accepted"),
        });
      }
    } catch (e) {
      notifications().notify({
        level: "error",
        title: tx("Cannot accept the changes"),
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };
  const items = useDiffItems(task, rows, grouped, scope);
  const diff = useRef<CombinedDiffHandle>(null);
  const busy = task.status === "starting" || task.status === "running";
  const fileTree =
    changes === null ? (
      <Spinner />
    ) : (
      <Tree<ChangeRow>
        key={view}
        aria-label="Changed files"
        roots={rows}
        getKey={(n) => n.key}
        getLabel={(n) =>
          n.type === "file"
            ? basename(n.change.path)
            : n.type === "commit"
              ? n.commit.summary
              : n.type === "repo"
                ? basename(n.root)
                : n.label
        }
        getChildren={(n) => (n.type === "file" ? undefined : n.children)}
        isExpandable={(n) => n.type !== "file" && n.children.length > 0}
        defaultExpanded={[...(grouped ? ["group:uncommitted", "group:committed"] : []), ...repositoryKeys(rows)]}
        activateExpandable={(n) => n.type === "commit"}
        selected={selected}
        onSelectionChange={(sel, lead) => {
          if (lead?.type === "file" && !lead.commit) setSelected(sel);
          // The diff follows the tree: a row shows its first file.
          const first = lead && firstFile(lead);
          if (first) diff.current?.reveal(first);
        }}
        onActivate={(n) => {
          const first = firstFile(n);
          if (first) diff.current?.reveal(first);
        }}
        renderNode={(n) => {
          if (n.type === "group") {
            return (
              <span className={styles.changeGroup}>
                <span className={styles.changeGroupName}>
                  {n.label === "Uncommitted" ? <T>Uncommitted</T> : <T>Committed</T>}
                </span>
                <span className={styles.muted}>
                  {n.label === "Committed"
                    ? tx(n.count === 1 ? "1 commit" : "{count} commits").replace("{count}", String(n.count))
                    : `${n.count} ${tx(n.count === 1 ? "file" : "files")}`}
                </span>
                <span className={styles.changeStat}>
                  {n.added > 0 && <span className={styles.added}>+{n.added}</span>}{" "}
                  {n.removed > 0 && <span className={styles.removed}>−{n.removed}</span>}
                </span>
              </span>
            );
          }
          if (n.type === "repo") {
            const files = n.children.flatMap((c) => (c.type === "file" ? [c.change] : []));
            const stats = statsOf(files);
            return (
              <span className={styles.changeGroup} title={n.root}>
                <Icon name="folder" size={14} />
                <span className={styles.changeGroupName}>{basename(n.root)}</span>
                <span className={styles.muted}>{`${files.length} ${tx(files.length === 1 ? "file" : "files")}`}</span>
                <span className={styles.changeStat}>
                  {stats.added > 0 && <span className={styles.added}>+{stats.added}</span>}{" "}
                  {stats.removed > 0 && <span className={styles.removed}>−{stats.removed}</span>}
                </span>
              </span>
            );
          }
          if (n.type === "commit") {
            const stats = statsOf(n.commit.files);
            return (
              <span className={styles.changeCommit} title={n.commit.message}>
                <Icon name="commit" size={14} />
                <span className={styles.changeCommitHash}>{n.commit.shortId}</span>
                <span className={styles.changeCommitSummary}>{n.commit.summary}</span>
                {n.commit.timeMs != null && (
                  <span className={styles.changeCommitTime}>{formatSentAt(n.commit.timeMs)}</span>
                )}
                <span className={styles.changeStat}>
                  {stats.added > 0 && <span className={styles.added}>+{stats.added}</span>}{" "}
                  {stats.removed > 0 && <span className={styles.removed}>−{stats.removed}</span>}
                </span>
              </span>
            );
          }
          return (
            <span className={styles.change} title={n.change.relPath}>
              <Icon name={fileIconName(basename(n.change.path), n.change.path)} size={16} />
              <span className={styles.changeName} style={{ color: KIND_COLOR[n.change.kind] }}>
                {basename(n.change.path)}
              </span>
              <span className={styles.changeDir}>{changeDir(task, n.change)}</span>
              <span className={styles.changeStat}>
                {n.change.added > 0 && <span className={styles.added}>+{n.change.added}</span>}{" "}
                {n.change.removed > 0 && <span className={styles.removed}>−{n.change.removed}</span>}
              </span>
            </span>
          );
        }}
      />
    );
  return (
    <section className={styles.changes} aria-label={tx("Changes")}>
      <CombinedDiffView
        key={view}
        items={items ?? NO_ITEMS}
        tabKey={tabKey}
        handle={diff}
        empty={
          items === null ? (
            <Spinner />
          ) : scope === "turn" ? (
            <T>The last turn changed no files</T>
          ) : (
            <T>No changes yet</T>
          )
        }
        toolbarStart={
          <>
            <Tabs
              variant="compact"
              aria-label="Changes to show"
              activeId={scope}
              onSelect={(id) => {
                if (id === scope) return;
                setChangesOptions({ scope: id === "turn" ? "turn" : "task" });
                void refreshChanges(task.id);
              }}
              items={[
                { id: "task", label: "Whole Task" },
                { id: "turn", label: "Last Turn" },
              ]}
            />
            {(scope === "turn" || grouped || head || task.base) && (
              <span className={styles.changesSummary}>
                {scope === "turn" ? (
                  <T>Since the last turn started</T>
                ) : (
                  <>
                    <T>vs</T> {grouped ? "HEAD" : (head ?? task.base)}
                  </>
                )}
                {changes && changes.length > 0 && (
                  <>
                    {"  "}
                    <span className={styles.added}>+{added}</span> <span className={styles.removed}>−{removed}</span>
                  </>
                )}
              </span>
            )}
          </>
        }
        toolbarEnd={
          <>
            {task.isolation === "worktree" && (
              <IconButton
                size="small"
                icon="check"
                title={picked.length ? "Accept Selected Changes…" : "Accept All Changes…"}
                disabled={(!changes?.length && !commits.length) || busy}
                onClick={() => void accept()}
              />
            )}
            <IconButton
              size="small"
              icon="revert"
              title={picked.length ? "Rollback Selected Changes…" : "Rollback All Changes…"}
              disabled={!changes?.length || busy}
              onClick={() => void rollback()}
            />
            <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshChanges(task.id)} />
            {task.isolation === "worktree" && scope === "task" && (
              <IconButton
                size="small"
                icon="eye"
                title="View Options"
                aria-haspopup="menu"
                onClick={(e) =>
                  showContextMenu(e, [
                    { kind: "header", label: "Group By" },
                    {
                      id: "groupByCommit",
                      label: "Commit",
                      checked: grouped,
                      run: () => {
                        setChangesOptions({ groupByCommit: !grouped });
                        void refreshChanges(task.id);
                      },
                    },
                  ])
                }
              />
            )}
          </>
        }
        files={{ content: fileTree, label: tx("Resize changed files"), storageKey: "openidea.agents.changesTab.files" }}
      />
    </section>
  );
}

/** Key of the first file row at or under `row`: what the diff scrolls to for it. */
function firstFile(row: ChangeRow): string | null {
  if (row.type === "file") return row.key;
  for (const child of row.children) {
    const key = firstFile(child);
    if (key) return key;
  }
  return null;
}

/** The file rows under `rows`, in tree order (collapsed ones included). */
function fileRows(rows: readonly ChangeRow[]): Extract<ChangeRow, { type: "file" }>[] {
  return rows.flatMap((r) => (r.type === "file" ? [r] : fileRows(r.children)));
}

/**
 * The diff of every file row, keyed like the rows. Since the task started (or the last turn),
 * the left side is the base the backend kept; grouped, `HEAD` or the commit's parent. A file
 * whose diff is unchanged keeps its object, so its block doesn't load again as the task works.
 */
function useDiffItems(
  task: AgentTask,
  rows: readonly ChangeRow[],
  grouped: boolean,
  scope: ChangesScope,
): CombinedDiffItem[] | null {
  const [items, setItems] = useState<CombinedDiffItem[] | null>(null);
  const previous = useRef(new Map<string, CombinedDiffItem>());
  useEffect(() => {
    let live = true;
    const files = fileRows(rows);
    const detail = (row: (typeof files)[number]) => {
      const dir = changeDir(task, row.change);
      return row.commit ? [row.commit.shortId, dir].filter(Boolean).join(" · ") : dir;
    };
    const build = async (): Promise<CombinedDiffItem[]> => {
      if (grouped) await ensureTaskRepo(task);
      return Promise.all(
        files.map(async (row) => {
          const data = row.commit
            ? commitFileDiff(task, row.commit, row.change)
            : grouped
              ? uncommittedDiffData(task, row.change)
              : await changeDiffData(task, row.change.path, scope, row.change.kind);
          return { key: row.key, data, detail: detail(row) };
        }),
      );
    };
    void build().then((next) => {
      if (!live) return;
      const kept = next.map((item) => {
        const before = previous.current.get(item.key);
        return before && diffInput(before.data).key === diffInput(item.data).key && before.detail === item.detail
          ? before
          : item;
      });
      previous.current = new Map(kept.map((item) => [item.key, item]));
      setItems(kept);
    });
    return () => {
      live = false;
    };
  }, [task, rows, grouped, scope]);
  return items;
}

/** The folder of a changed file, as the tree names it. */
function changeDir(task: AgentTask, change: AgentChange): string {
  if (!change.repo) return relativeDir(task.cwd, change.path);
  return change.relPath.includes("/") ? dirname(change.relPath) : "";
}

/** Diff of `path` between the task's start (or its last turn's) and now. */
async function changeDiffData(
  task: AgentTask,
  path: string,
  scope: ChangesScope,
  kind?: AgentChange["kind"],
): Promise<DiffData> {
  const baseLabel = scope === "turn" ? tx("Before Last Turn") : (task.base ?? "Base");
  const right = task.isolation === "worktree" ? branchLabel(task.branch) : "Working tree";
  // A file the task added or deleted has one side only, shown alone.
  const added = kind === "added" || kind === "untracked";
  const base = added
    ? null
    : await call(commands.agentBaseText(task.id, path, scope === "turn" ? "lastTurn" : null)).catch(() => null);
  return {
    path,
    left: added
      ? { type: "text", text: "", label: baseLabel, absent: true }
      : { type: "text", text: base ?? "", label: baseLabel },
    right:
      kind === "deleted"
        ? { type: "text", text: "", label: right, absent: true }
        : { type: "file", path, label: right },
    title: `${basename(path)} (${baseLabel} ↔ ${right})`,
  };
}

/** Opens the diff of `path` between the task's start (or its last turn's) and now. */
export async function openChangeDiff(task: AgentTask, path: string, scope: ChangesScope = "task") {
  const { changes, turnChanges } = useAgents.getState();
  const listed = (scope === "turn" ? turnChanges : changes).get(task.id) ?? [];
  const changed = listed.map((change) => change.path);
  const paths = changed.includes(path) ? changed : [path];
  const kinds = new Map(listed.map((change) => [change.path, change.kind]));
  const diffs = await Promise.all(paths.map((file) => changeDiffData(task, file, scope, kinds.get(file))));
  await openDiff(withChain(diffs, paths.indexOf(path)));
}

/** Diff of `path` in the grouped view: `HEAD` ↔ the working file. */
function uncommittedDiffData(task: AgentTask, change: AgentChange): DiffData {
  const left: DiffData["left"] =
    change.kind === "added" || change.kind === "untracked"
      ? { type: "text", text: "", label: "(does not exist)", absent: true }
      : {
          type: "rev",
          rev: "HEAD",
          path: change.oldPath ? repositoryPath(task.cwd, change.oldPath) : undefined,
          label: "HEAD",
        };
  const right: DiffData["right"] =
    change.kind === "deleted"
      ? { type: "text", text: "", label: "(deleted)", absent: true }
      : {
          type: "worktree",
          label: task.isolation === "worktree" ? branchLabel(task.branch) : "Working tree",
        };
  return { path: change.path, left, right };
}

/** Registration needed before a diff reads revisions inside the task's own worktree. */
async function ensureTaskRepo(task: AgentTask) {
  // A worktree is its own repository, outside the project's: `vcs_file_at` reads it only once
  // it is registered as an external log for this window.
  if (task.isolation === "worktree") await call(commands.vcsOpenExternalLog(task.cwd)).catch(() => undefined);
}

/** Diff of a file of one of the task's commits: `parent ↔ commit`. */
function commitFileDiff(task: AgentTask, commit: AgentCommit, file: AgentChange): DiffData {
  return commitFileDiffData(
    {
      id: commit.id,
      shortId: commit.shortId,
      parents: commit.parent ? [commit.parent] : [],
      repo: task.cwd,
    },
    { path: file.relPath, kind: file.kind, oldPath: file.oldPath },
  );
}
