/** Changed files and modal diff review for the commits selected in the Push dialog. */
import { useEffect, useMemo, useState } from "react";
import type { Commit } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Dialog, Icon, IconButton, Spinner, Tree, fileIconName } from "@/ui";
import { DiffEditor } from "./DiffEditor";
import { diffInput, diffTitle, withChain, type DiffData } from "./diffInput";
import { buildFileTree, dirKeys, type FileTreeNode } from "./fileTree";
import { filesUnder, toLogChanges, type LogChange } from "./logChanges";
import { KIND_COLOR, fileCount } from "./model";
import { currentRepoRoot, repoName } from "./store";
import styles from "./common.module.css";

/** One repository's selected commits, in the log's newest-first order. */
export interface PushPreviewGroup {
  repo: string | null;
  commits: readonly Commit[];
}

/** Reviews commits without changing which repositories or commits the push will publish. */
export function PushPreview({ groups }: { groups: readonly PushPreviewGroup[] }) {
  // Remount on a different selection so old files, errors and selection cannot flash during loading.
  const key = JSON.stringify(groups.map((g) => [g.repo, g.commits.map((c) => c.id)]));
  return <PushPreviewContent key={key} groups={groups} />;
}

function PushPreviewContent({ groups }: { groups: readonly PushPreviewGroup[] }) {
  const [changes, setChanges] = useState<LogChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [expanded, setExpanded] = useState<ReadonlySet<string> | null>(null);
  const [diff, setDiff] = useState<DiffData | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all(
      groups.map(async ({ repo, commits }) => {
        if (!commits.length) return [];
        const root = repo ?? currentRepoRoot();
        if (commits.length === 1) {
          const commit = commits[0]!;
          return toLogChanges(await call(commands.vcsCommitFiles(repo, commit.id)), commit, root);
        }
        // The backend combines oldest first, following renames and dropping add-then-delete pairs.
        const ids = commits.map((c) => c.id).reverse();
        return toLogChanges(await call(commands.vcsCommitsChanges(repo, ids)), null, root);
      }),
    )
      .then((list) => alive && setChanges(list.flat()))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      // A slow response for an earlier commit selection must never replace the current preview.
      alive = false;
    };
  }, [groups]);

  const tree = useMemo(() => {
    const repositories = new Map<string | null, LogChange[]>();
    for (const c of changes ?? []) {
      const root = c.repo ?? null;
      const list = repositories.get(root) ?? [];
      list.push(c);
      repositories.set(root, list);
    }
    return [...repositories].flatMap(([repo, files]) => {
      // Paths can repeat across repositories; scope directory and file selection keys alike.
      const scope = (nodes: FileTreeNode<LogChange>[]): FileTreeNode<LogChange>[] =>
        nodes.map((n) => ({ ...n, key: JSON.stringify([repo, n.key]), children: scope(n.children) }));
      const children = scope(buildFileTree(files, (f) => f.path));
      return groups.length > 1
        ? [
            {
              key: JSON.stringify([repo]),
              name: repo ? repoName(repo) : "Git",
              file: null,
              children,
              count: files.length,
            },
          ]
        : children;
    });
  }, [changes, groups]);
  const picked = filesUnder(tree, selected);
  const showDiff = (node?: FileTreeNode<LogChange>) => {
    const files = node && !selected.has(node.key) ? filesUnder([node]) : picked;
    if (files.length)
      setDiff(
        withChain(
          files.map((c) => c.diff),
          0,
        ),
      );
  };

  return (
    <div className={styles.pushPreview}>
      <div className={styles.pushPreviewBar}>
        <IconButton icon="diff" title="Show Diff" size="small" disabled={!picked.length} onClick={() => showDiff()} />
        <span className={styles.hint}>{changes ? fileCount(changes.length) : tx("Changed files")}</span>
        <span className={styles.grow} />
        <IconButton
          icon="expand-all"
          title="Expand All"
          size="small"
          onClick={() => setExpanded(new Set(dirKeys(tree)))}
        />
        <IconButton icon="collapse-all" title="Collapse All" size="small" onClick={() => setExpanded(new Set())} />
      </div>
      {error ? (
        <div className={styles.error} role="alert">
          {error}
        </div>
      ) : !changes ? (
        <div className={styles.empty}>
          <Spinner size={14} />
        </div>
      ) : (
        <Tree<FileTreeNode<LogChange>>
          roots={tree}
          getKey={(n) => n.key}
          getLabel={(n) => n.name}
          getChildren={(n) => (n.file ? undefined : n.children)}
          isExpandable={(n) => !n.file}
          expanded={expanded ?? new Set(dirKeys(tree))}
          onExpandedChange={setExpanded}
          selected={selected}
          onSelectionChange={setSelected}
          multiSelect
          activateExpandable
          onActivate={(n) => showDiff(n)}
          aria-label="Files to push"
          className={styles.grow}
          empty={<span>{tx("No changes")}</span>}
          renderNode={(n) => (
            <span className={styles.fileRow} style={{ flex: 1, padding: 0 }}>
              <Icon name={n.file ? fileIconName(n.name) : "folder"} size={14} />
              <span
                className={styles.fileName}
                style={{ color: n.file ? KIND_COLOR[n.file.kind] : undefined }}
                title={n.file?.oldPath ? `${n.file.oldPath} → ${n.file.path}` : n.file?.path}
              >
                {n.name}
              </span>
              {!n.file && <span className={styles.fileDir}>{fileCount(n.count)}</span>}
            </span>
          )}
        />
      )}
      {diff && (
        <Dialog
          open
          title={diffTitle(diff)}
          width={1100}
          resizable="both"
          onClose={() => setDiff(null)}
          buttons={[{ label: "Close", role: "cancel" }]}
        >
          <div className={styles.pushDiff}>
            <DiffEditor key={diffInput(diff).key} input={diffInput(diff)} onOpenDiff={setDiff} />
          </div>
        </Dialog>
      )}
    </div>
  );
}
