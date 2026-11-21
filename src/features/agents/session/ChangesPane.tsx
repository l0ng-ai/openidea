import type { AgentChange, AgentCommit, AgentTask } from "@/bindings";
import { commitFileDiffData, openDiff, withChain, type DiffData } from "@/features/vcs/diffInput";
import { repositoryPath } from "@/features/vcs/repositoryPaths";
import { tx } from "@/platform/i18n";
import { call, commands, onIdeEvent } from "@/platform/ipc";
import { basename, dirname, relativeDir } from "@/platform/project";
import { fileIconName, Icon, IconButton, showContextMenu, Spinner, T, Tree } from "@/ui";
import { notifications } from "@/workbench/contributions";
import { confirm } from "@/workbench/messages";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChangesResizer } from "../ChangesResizer";
import styles from "../Session.module.css";
import { setChangesOptions, type ChangesScope } from "../changesOptions";
import { SegmentedControl } from "../ConfigPickers";
import { formatSentAt } from "../conversation";
import { branchLabel } from "../model";
import { acceptChanges, refreshChanges, rollbackChanges, useAgents } from "../store";

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

const CHANGES_OPEN_KEY = "openidea.agents.changesOpen.v1";

function loadChangesOpen(): Record<string, boolean> {
  try {
    const raw = globalThis.localStorage?.getItem(CHANGES_OPEN_KEY);
    const v: unknown = raw ? JSON.parse(raw) : {};
    return v && typeof v === "object" ? (v as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/**
 * Whether the Changes pane is shown for `task`: the user's choice once made, else
 * only while the task has changes. Docked sessions stay in the conversation until
 * the user explicitly opens changes; navigation there does not change editor preferences.
 */
export function useChangesOpen(
  task: string,
  changes: AgentChange[] | null,
  docked: boolean,
): [boolean, (open: boolean) => void] {
  const [state, setState] = useState<{
    task: string;
    open: boolean | undefined;
  }>(() => ({
    task,
    open: docked ? false : loadChangesOpen()[task],
  }));
  const chosen = state.task === task ? state.open : docked ? false : loadChangesOpen()[task];
  const set = useCallback(
    (open: boolean) => {
      setState({ task, open });
      if (docked) return;
      try {
        globalThis.localStorage?.setItem(CHANGES_OPEN_KEY, JSON.stringify({ ...loadChangesOpen(), [task]: open }));
      } catch {
        /* storage unavailable */
      }
    },
    [task, docked],
  );
  return [chosen ?? (changes?.length ?? 0) > 0, set];
}

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

export function ChangesPane({
  task,
  changes,
  commits,
  grouped,
  scope,
  head,
  docked,
  onHide,
}: {
  task: AgentTask;
  changes: AgentChange[] | null;
  commits: readonly AgentCommit[];
  grouped: boolean;
  scope: ChangesScope;
  head: string | null;
  docked: boolean;
  onHide: () => void;
}) {
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
  return (
    <aside className={styles.changes} aria-label={tx("Changes")}>
      {!docked && <ChangesResizer />}
      <div className={styles.changesHeader}>
        {docked && <IconButton icon="arrow-left" title="Back to conversation" onClick={onHide} />}
        <span className={styles.changesTitle}>
          <T>Changes</T>
        </span>
        {changes && changes.length > 0 && (
          <span className={styles.muted}>
            {changes.length} <T>{changes.length === 1 ? "file" : "files"}</T>
          </span>
        )}
        <span className={styles.bannerSpacer} />
        {task.isolation === "worktree" && (
          <IconButton
            icon="check"
            title={picked.length ? "Accept Selected Changes…" : "Accept All Changes…"}
            disabled={(!changes?.length && !commits.length) || task.status === "starting" || task.status === "running"}
            onClick={() => void accept()}
          />
        )}
        <IconButton
          icon="revert"
          title={picked.length ? "Rollback Selected Changes…" : "Rollback All Changes…"}
          disabled={!changes?.length || task.status === "starting" || task.status === "running"}
          onClick={() => void rollback()}
        />
        <IconButton icon="refresh" title="Refresh" onClick={() => void refreshChanges(task.id)} />
        {task.isolation === "worktree" && scope === "task" && (
          <IconButton
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
        {!docked && <IconButton icon="chevron-right" title={tx("Hide changes")} size="small" onClick={onHide} />}
      </div>
      <div className={styles.changesScope}>
        <SegmentedControl
          ariaLabel={tx("Changes to show")}
          options={[
            { value: "task", label: tx("Whole Task") },
            { value: "turn", label: tx("Last Turn") },
          ]}
          value={scope}
          onChange={(value) => {
            setChangesOptions({ scope: value === "turn" ? "turn" : "task" });
            void refreshChanges(task.id);
          }}
        />
      </div>
      {(scope === "turn" || grouped || head || task.base) && (
        <div className={styles.changesSummary}>
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
        </div>
      )}
      <div className={styles.changesList}>
        {changes === null ? (
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
            }}
            onActivate={(n) => {
              if (n.type === "file") {
                if (n.commit) void openCommitDiff(task, n.commit, n.change.path);
                else if (grouped) void openUncommittedDiff(task, n.change.path);
                else void openChangeDiff(task, n.change.path, scope);
              } else if (n.type === "commit") {
                void openCommitDiff(task, n.commit, n.commit.files[0]?.path ?? "");
              }
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
                    <span
                      className={styles.muted}
                    >{`${files.length} ${tx(files.length === 1 ? "file" : "files")}`}</span>
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
                  <span className={styles.changeDir}>
                    {n.change.repo
                      ? n.change.relPath.includes("/")
                        ? dirname(n.change.relPath)
                        : ""
                      : relativeDir(task.cwd, n.change.path)}
                  </span>
                  <span className={styles.changeStat}>
                    {n.change.added > 0 && <span className={styles.added}>+{n.change.added}</span>}{" "}
                    {n.change.removed > 0 && <span className={styles.removed}>−{n.change.removed}</span>}
                  </span>
                </span>
              );
            }}
            empty={
              <div className={styles.changesEmpty}>
                {scope === "turn" ? <T>The last turn changed no files</T> : <T>No changes yet</T>}
              </div>
            }
          />
        )}
      </div>
    </aside>
  );
}

/** Opens the diff of `path` between the task's start (or its last turn's) and now. */
export async function openChangeDiff(task: AgentTask, path: string, scope: ChangesScope = "task") {
  const { changes, turnChanges } = useAgents.getState();
  const changed = ((scope === "turn" ? turnChanges : changes).get(task.id) ?? []).map((change) => change.path);
  const paths = changed.includes(path) ? changed : [path];
  const baseLabel = scope === "turn" ? tx("Before Last Turn") : (task.base ?? "Base");
  const right = task.isolation === "worktree" ? branchLabel(task.branch) : "Working tree";
  const diffs = await Promise.all(
    paths.map(async (file): Promise<DiffData> => {
      const base = await call(commands.agentBaseText(task.id, file, scope === "turn" ? "lastTurn" : null)).catch(
        () => null,
      );
      return {
        path: file,
        left: { type: "text", text: base ?? "", label: baseLabel },
        right: { type: "file", path: file, label: right },
        title: `${basename(file)} (${baseLabel} ↔ ${right})`,
      };
    }),
  );
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

/** Opens the diff of `path` among the task's uncommitted files (grouped view). */
async function openUncommittedDiff(task: AgentTask, path: string) {
  const changes = useAgents.getState().groupedChanges.get(task.id)?.uncommitted ?? [];
  const paths = changes.map((change) => change.path);
  if (!paths.includes(path)) return;
  await ensureTaskRepo(task);
  await openDiff(
    withChain(
      changes.map((change) => uncommittedDiffData(task, change)),
      paths.indexOf(path),
    ),
  );
}

/** Opens the diff of one commit (`parent ↔ commit`), starting at `path`. */
async function openCommitDiff(task: AgentTask, commit: AgentCommit, path: string) {
  const diffs = commit.files.map((file) =>
    commitFileDiffData(
      {
        id: commit.id,
        shortId: commit.shortId,
        parents: commit.parent ? [commit.parent] : [],
        repo: task.cwd,
      },
      { path: file.relPath, kind: file.kind, oldPath: file.oldPath },
    ),
  );
  if (!diffs.length) return;
  await ensureTaskRepo(task);
  const index = commit.files.findIndex((file) => file.path === path);
  await openDiff(withChain(diffs, index < 0 ? 0 : index));
}
