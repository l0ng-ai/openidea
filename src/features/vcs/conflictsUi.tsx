/** "Resolve Conflicts" dialog and in-editor conflict resolution actions. */
import { useState } from "react";
import type { ConflictSide, FileStatus } from "@/bindings";
import { activeEditor } from "@/editor/api";
import { call, commands } from "@/platform/ipc";
import {
  Button,
  Dialog,
  Icon,
  List,
  fileIconName,
  rowSelectionMode,
  selectRow,
  selectedRows,
  showContextMenu,
  T,
} from "@/ui";
import { editorService, notifications } from "@/workbench/contributions";
import { blockAt, parseConflicts, resolutionText, type Resolution } from "./conflicts";
import { confirmDialog, openDialog } from "./dialogs";
import { mergeConflictSession, type MergeConflictSession } from "./mergeCompletion";
import { mergeInput } from "./mergeKind";
import { baseName, dirName, effectiveKind, relTo, stashLabel, stripSlash } from "./model";
import { controlLabel, controlOperation, inProgress, operationTitle } from "./operations";
import { runOp, saveAll } from "./ops";
import { executeAction } from "@/platform/actions";
import { conflictedFiles, currentRepoRoot, refreshNow, repoOf, useVcs, type VcsState } from "./store";
import styles from "./ConflictsDialog.module.css";
import { tx } from "@/platform/i18n";

export interface UnstashConflictContext {
  repo: string;
  index: number;
  message: string;
}

const unstashNotices = new Map<string, () => void>();

export function clearUnstashConflictNotices() {
  for (const clear of unstashNotices.values()) clear();
}

function showUnresolvedUnstashNotice(stash: UnstashConflictContext, files: FileStatus[], description: string) {
  const { root, heads } = useVcs.getState();
  const head = heads[stash.repo]?.headCommit;
  const paths = new Set(files.map((file) => file.path));
  const stillUnresolved = (state: VcsState) =>
    state.root === root &&
    state.roots.includes(stash.repo) &&
    !state.operations[stash.repo] &&
    state.heads[stash.repo]?.headCommit === head &&
    state.status.some(
      (file) =>
        paths.has(file.path) && effectiveKind(file) === "conflicted" && repoOf(file.path, state.roots) === stash.repo,
    );
  if (!stillUnresolved(useVcs.getState())) return;

  const key = `vcs.unstash-conflicts:${stash.repo}`;
  unstashNotices.get(stash.repo)?.();
  const service = notifications();
  const clear = () => {
    unsubscribe();
    unstashNotices.delete(stash.repo);
    service.expire?.(key);
  };
  const unsubscribe = useVcs.subscribe((state) => {
    if (!stillUnresolved(state)) clear();
  });
  unstashNotices.set(stash.repo, clear);
  service.notify({
    key,
    group: "vcs",
    level: "warning",
    sticky: true,
    userInitiated: true,
    title: "Unstash has unresolved conflicts",
    body: description,
    actions: [
      {
        label: "Resolve Conflicts…",
        run: () => {
          void refreshNow().then(() => {
            if (unstashNotices.get(stash.repo) !== clear) return;
            service.expire?.(key);
            return executeAction("vcs.resolveConflicts", stash);
          });
        },
      },
    ],
  });
}

function inConflictScope(path: string, roots: readonly string[], scope?: readonly string[]): boolean {
  if (!scope) return true;
  const repo = repoOf(path, roots);
  return repo !== null && scope.includes(repo);
}

export function showConflictsDialog(arg?: unknown) {
  const repositories =
    arg && typeof arg === "object" && "repositories" in arg && Array.isArray(arg.repositories)
      ? arg.repositories.filter((root): root is string => typeof root === "string")
      : undefined;
  const stash: UnstashConflictContext | undefined =
    arg &&
    typeof arg === "object" &&
    "repo" in arg &&
    typeof arg.repo === "string" &&
    "index" in arg &&
    typeof arg.index === "number" &&
    "message" in arg &&
    typeof arg.message === "string"
      ? { repo: arg.repo, index: arg.index, message: arg.message }
      : undefined;
  const mergeRepo =
    arg && typeof arg === "object" && "mergeRepo" in arg && typeof arg.mergeRepo === "string"
      ? arg.mergeRepo
      : currentRepoRoot();
  const session = stash || repositories ? undefined : mergeConflictSession(mergeRepo);
  const scope = stash ? [stash.repo] : (session?.roots ?? repositories);
  const { resolvedConflicts, roots } = useVcs.getState();
  if (
    !session &&
    !conflictedFiles().some((file) => inConflictScope(file.path, roots, scope)) &&
    (stash || ![...resolvedConflicts].some((path) => inConflictScope(path, roots, scope)))
  ) {
    notifications().notify({ group: "vcs", level: "info", title: "No merge conflicts" });
    return;
  }
  openDialog((close) => (
    <ConflictsDialog stash={stash} session={session} repositories={repositories} onClose={close} />
  ));
}

export function canRevertResolved(paths: readonly string[]): boolean {
  const { resolvedConflicts } = useVcs.getState();
  return paths.length > 0 && paths.every((path) => resolvedConflicts.has(stripSlash(path)));
}

export async function revertResolved(paths: string[]) {
  if (!canRevertResolved(paths)) return;
  const count = paths.length;
  const name = baseName(paths[0]!);
  const message = count === 1 ? tx`Revert the resolution of ${name}?` : tx`Revert resolutions for ${count} files?`;
  if (!(await confirmDialog({ title: "Revert Resolved Files", message, okLabel: "Revert", danger: true }))) return;
  await saveAll();
  await runOp(tx("Reverting resolved conflicts"), () => call(commands.vcsRevertResolved(paths)), {
    success: tx("Resolved conflicts reopened"),
  });
}

export function openMergeEditor(path: string) {
  void editorService().openInput(mergeInput(stripSlash(path)), { focus: true });
}

/** Accept Yours / Accept Theirs for whole conflicted files. */
export async function acceptConflictSide(files: readonly string[], side: ConflictSide): Promise<boolean> {
  if (!files.length) return false;
  const paths = files.map(stripSlash);
  const count = paths.length;
  const path = paths[0]!;
  const title =
    side === "ours"
      ? count === 1
        ? tx`Accept yours for ${baseName(path)}`
        : tx`Accept yours for ${count} files`
      : count === 1
        ? tx`Accept theirs for ${baseName(path)}`
        : tx`Accept theirs for ${count} files`;
  const accepted = await runOp(
    title,
    async () => {
      await saveAll();
      await call(commands.vcsAcceptConflictSide(paths, side));
      return true;
    },
    { success: count === 1 ? tx`${baseName(path)} resolved` : tx`${count} files resolved` },
  );
  return accepted === true;
}

type ConflictRow = { key: string } & ({ header: "Unresolved" | "Resolved" } | { path: string; conflict?: FileStatus });
const isSection = (row: ConflictRow) => "header" in row;

function ConflictsDialog({
  stash,
  session,
  repositories,
  onClose,
}: {
  stash?: UnstashConflictContext;
  session?: MergeConflictSession;
  repositories?: readonly string[];
  onClose: () => void;
}) {
  const roots = useVcs((s) => s.roots);
  const scope = stash ? [stash.repo] : (session?.roots ?? repositories);
  const files = conflictedFiles(useVcs((s) => s.status)).filter((file) => inConflictScope(file.path, roots, scope));
  const resolved = useVcs((s) => s.resolvedConflicts);
  const root = useVcs((s) => s.root) ?? "";
  const repo = useVcs((s) => (repositories ? (repositories.find((root) => s.operations[root]) ?? null) : s.repo));
  const mergeRoot = useVcs((s) => session?.roots.find((root) => s.operations[root] === "merge"));
  const busy = useVcs((s) => s.remoteBusy !== null);
  const op = useVcs((s) => {
    if (stash) return null;
    if (session) return mergeRoot ? "merge" : null;
    return inProgress(repositories ? (repo ? s.operations[repo] : null) : s.branch?.operation);
  });
  const operationRoot = mergeRoot ?? (repositories ? repo : null);
  const head = useVcs((s) => (operationRoot ? s.heads[operationRoot]?.head : s.branch?.head) ?? null);
  const [selection, setSelection] = useState<{ lead: string; anchor: string; keys: ReadonlySet<string> | null }>();
  const unresolved = new Set(files.map((f) => stripSlash(f.path)));
  const resolvedPaths = stash
    ? []
    : [...resolved].filter((path) => !unresolved.has(path) && inConflictScope(path, roots, scope));
  const rows: ConflictRow[] = [
    ...(files.length
      ? [
          { key: "unresolved", header: "Unresolved" as const },
          ...files.map((f) => ({ key: f.path, path: f.path, conflict: f })),
        ]
      : []),
    ...(resolvedPaths.length
      ? [{ key: "resolved", header: "Resolved" as const }, ...resolvedPaths.map((path) => ({ key: path, path }))]
      : []),
  ];
  const selectedIndex = rows.findIndex((row) => row.key === selection?.lead);
  const active = selectedIndex >= 0 ? selectedIndex : rows.findIndex((row) => "path" in row);
  const anchor = rows.findIndex((row) => row.key === selection?.anchor);
  const rowSelection = { lead: active, anchor: anchor < 0 ? active : anchor, keys: selection?.keys ?? null };
  const selected = selectedRows(rows, rowSelection);
  const conflicts = selected.flatMap((row) => ("path" in row && row.conflict ? [row.conflict] : []));
  const restore = selected.flatMap((row) => ("path" in row && !row.conflict ? [row.path] : []));
  const canAccept = conflicts.length > 0 && conflicts.length === selected.length;
  const canRestore = restore.length > 0 && restore.length === selected.length;
  const merge = selected.length === 1 ? conflicts[0] : undefined;
  const stashDescription = stash ? `stash@{${stash.index}}: ${stashLabel(stash.message).text}` : null;
  const close = () => {
    onClose();
    if (stash && stashDescription && files.length) showUnresolvedUnstashNotice(stash, files, stashDescription);
  };
  const edit = (path: string) => {
    close();
    openMergeEditor(path);
  };
  const pending = files.some((file) => !repo || repoOf(file.path) === repo);
  const conclude = session
    ? { label: "Accept and Finish", disabled: !!files.length || !mergeRoot || busy, run: () => void session.finish() }
    : op && !pending
      ? op === "merge" && !repositories
        ? { label: "Commit…", disabled: false, run: () => void executeAction("vcs.commit") }
        : {
            label: controlLabel(op, "continue"),
            disabled: !!repositories && busy,
            run: () => void controlOperation("continue", op, repositories ? repo : undefined),
          }
      : null;
  const canConclude = conclude !== null && !conclude.disabled;
  return (
    <Dialog
      open
      title="Conflicts"
      onClose={close}
      className={styles.dialog}
      width={680}
      resizable="both"
      minWidth={360}
      minHeight={320}
      buttons={[
        ...(conclude
          ? [
              {
                label: conclude.label,
                role: "default" as const,
                disabled: conclude.disabled,
                autoFocus: canConclude,
                onClick: () => {
                  onClose();
                  conclude.run();
                },
              },
            ]
          : []),
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={styles.content}>
        <div className={styles.summary}>
          {stashDescription ? (
            <span>{tx`Conflicts during unstashing ${stashDescription}`}</span>
          ) : (
            op && <span>{operationTitle(op, head)}</span>
          )}
          <span className={styles.count} role="status">
            {files.length
              ? files.length === 1
                ? tx`${files.length} file with conflicts`
                : tx`${files.length} files with conflicts`
              : tx("All conflicts resolved")}
          </span>
        </div>
        <div className={styles.workspace}>
          <div className={styles.listFrame}>
            <div className={styles.listHeader} aria-hidden>
              <T>Name</T>
            </div>
            <List
              autoFocus={active >= 0 && !canConclude}
              items={rows}
              getKey={(row) => row.key}
              isSection={isSection}
              renderSection={(row) =>
                "header" in row && (row.header === "Unresolved" ? tx("Unresolved") : tx("Resolved"))
              }
              activeIndex={active}
              isSelected={(row) => !!rowSelection.keys?.has(row.key)}
              onSelect={(index, event) => {
                const next = selectRow(rows, rowSelection, index, rowSelectionMode(event), isSection);
                setSelection({ lead: rows[next.lead]!.key, anchor: rows[next.anchor]!.key, keys: next.keys });
              }}
              aria-label={tx("Conflicted files")}
              className={styles.list}
              empty={
                <span>
                  <T>No conflicts</T>
                </span>
              }
              onActivate={(row, _i, e) => {
                if ("header" in row || (e.type === "click" && (e as unknown as MouseEvent).detail < 2)) return;
                if (row.conflict) edit(row.path);
                else {
                  onClose();
                  void executeAction("vcs.showDiff", row.path);
                }
              }}
              onContextMenu={(row, _i, e) => {
                if ("path" in row && !row.conflict) {
                  e.preventDefault();
                  const paths = canRestore && restore.includes(row.path) ? restore : [row.path];
                  showContextMenu(e, [{ kind: "action", action: "vcs.revertResolved", arg: paths }]);
                }
              }}
              renderItem={(row) => {
                if (!("path" in row)) return null;
                const path = relTo(root, stripSlash(row.path));
                const name = baseName(row.path);
                const dir = dirName(path);
                return (
                  <span className={styles.row} title={path}>
                    <Icon name={row.conflict ? fileIconName(name, row.path) : "check"} size={16} />
                    <span className={styles.fileName} data-resolved={row.conflict ? undefined : true}>
                      {name}
                    </span>
                    {dir && <span className={styles.fileDir}>{dir}</span>}
                  </span>
                );
              }}
            />
          </div>
          <div className={styles.actions} role="group" aria-label={tx("Conflict resolution")}>
            {canRestore ? (
              <Button onClick={() => void executeAction("vcs.revertResolved", restore)}>Revert Resolved</Button>
            ) : (
              <>
                <Button
                  disabled={!canAccept}
                  onClick={() =>
                    void acceptConflictSide(
                      conflicts.map((f) => f.path),
                      "ours",
                    )
                  }
                >
                  Accept Yours
                </Button>
                <Button
                  disabled={!canAccept}
                  onClick={() =>
                    void acceptConflictSide(
                      conflicts.map((f) => f.path),
                      "theirs",
                    )
                  }
                >
                  Accept Theirs
                </Button>
                <Button
                  variant={canConclude ? "secondary" : "primary"}
                  disabled={!merge}
                  onClick={() => merge && edit(merge.path)}
                >
                  Merge…
                </Button>
              </>
            )}
          </div>
        </div>
      </div>
    </Dialog>
  );
}

/** Resolves the conflict block at the caret of the active editor. */
export function resolveAtCaret(how: Resolution): boolean {
  const ed = activeEditor();
  if (!ed) return false;
  const { view } = ed;
  const blocks = parseConflicts(view.state.doc.toString());
  const block = blockAt(blocks, view.state.selection.main.head);
  if (!block) {
    notifications().notify({ group: "vcs", level: "info", title: "The caret is not inside a conflict" });
    return false;
  }
  view.dispatch({
    // During a rebase the user's commit is git's "theirs" section, as in the merge editor.
    changes: { from: block.from, to: block.to, insert: resolutionText(block, how, inProgress() === "rebase") },
    userEvent: "input.resolve",
    scrollIntoView: true,
  });
  return true;
}

/** Moves the caret to the next conflict marker in the active editor. */
export function gotoConflict(dir: 1 | -1): boolean {
  const ed = activeEditor();
  if (!ed) return false;
  const { view } = ed;
  const blocks = parseConflicts(view.state.doc.toString());
  if (!blocks.length) return false;
  const head = view.state.selection.main.head;
  const target =
    dir === 1
      ? (blocks.find((b) => b.from > head) ?? blocks[0]!)
      : ([...blocks].reverse().find((b) => b.to < head) ?? blocks[blocks.length - 1]!);
  view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
  view.focus();
  return true;
}
