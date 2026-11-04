/**
 * Push dialog: the files changed by the outgoing commits (the selected commit's, or all of
 * them), with the selected file's diff beside the tree. The diff stays inside the dialog,
 * which is modal.
 */
import { useEffect, useMemo, useState } from "react";
import type { ChangedFile, Commit, RevisionChange } from "@/bindings";
import { call, commands } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { Button, Spinner, T } from "@/ui";
import { ComparisonTree } from "./ComparisonTree";
import { buildFileTree } from "./fileTree";
import { toLogChanges, type LogChange } from "./logChanges";
import { KIND_COLOR, fileCount } from "./model";
import styles from "./common.module.css";

/** Identifies what `PushChanges` shows; render it with this `key` so a new selection starts afresh. */
export const pushChangesKey = (repo: string | null, commits: readonly Commit[]) =>
  `${repo ?? ""}:${commits.map((c) => c.id).join(" ")}`;

/**
 * `commits` newest first, as the dialog lists them (stable across renders). `onShowAll`: a single
 * commit is shown; offers going back to the changes of all outgoing commits.
 */
export function PushChanges({
  repo,
  commits,
  onShowAll,
}: {
  repo: string | null;
  commits: readonly Commit[];
  onShowAll?: () => void;
}) {
  const [changes, setChanges] = useState<LogChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<LogChange | null>(null);

  useEffect(() => {
    if (!commits.length) return;
    let alive = true;
    const single = commits.length === 1 ? commits[0]! : null;
    const load: Promise<(ChangedFile | RevisionChange)[]> = single
      ? call(commands.vcsCommitFiles(repo, single.id))
      : call(commands.vcsCommitsChanges(repo, commits.map((c) => c.id).reverse()));
    load
      .then((f) => alive && setChanges(toLogChanges(f, single, repo)))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [repo, commits]);

  const tree = useMemo(() => (changes ? buildFileTree(changes, (f) => f.path) : []), [changes]);
  const count = commits.length;
  if (!count) return null;
  return (
    <div className={styles.pushChanges}>
      <div className={styles.pushChangesTitle}>
        <span>
          {changes ? fileCount(changes.length) : ""}
          {count > 1 ? " " + tx`in ${count} commits` : ""}
        </span>
        {onShowAll && (
          <Button variant="ghost" size="small" onClick={onShowAll}>
            <T>Show All Commits</T>
          </Button>
        )}
      </div>
      {error ? (
        <div className={styles.error}>{error}</div>
      ) : !changes ? (
        <div className={styles.empty}>
          <Spinner size={14} />
        </div>
      ) : (
        <ComparisonTree
          tree={tree}
          current={current}
          onSelect={setCurrent}
          diffFor={(c) => c.diff}
          getColor={(c) => KIND_COLOR[c.kind === "untracked" ? "added" : c.kind]}
          ariaLabel="Changed files"
          renderDetails={(n) => (n.file ? null : <span className={styles.fileDir}>{n.count}</span>)}
        />
      )}
    </div>
  );
}
