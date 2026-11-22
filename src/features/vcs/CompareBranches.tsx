import { useEffect, useState } from "react";
import type { Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Dialog, List, Spinner, T, tooltipAttrs } from "@/ui";
import { useRowHeight } from "@/ui/density";
import { maybeEditorService } from "@/workbench/contributions";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { saveAll } from "./ops";
import { currentRepoRoot, repoName, useVcs } from "./store";
import styles from "./common.module.css";

export const BRANCH_COMPARISON_KIND = "git-branch-comparison";

interface ComparisonRef {
  name: string;
  rev: string;
}

export interface BranchComparisonTarget extends ComparisonRef {
  repositories?: readonly string[];
}

export interface BranchComparisonData {
  branch: ComparisonRef;
  current: ComparisonRef;
  repositories: string[];
}

export function branchComparisonTitle({ branch, current }: BranchComparisonData) {
  return tx`Compare ${current.name} with ${branch.name}`;
}

export function comparisonPaneIds(key: string): [string, string] {
  return [`${key}:incoming`, `${key}:outgoing`];
}

export async function showCompareBranches({ name, rev, repositories }: BranchComparisonTarget) {
  const editor = maybeEditorService();
  if (!editor) return;
  const selected = currentRepoRoot();
  const repos = [...new Set(repositories ?? (selected ? [selected] : []))].sort();
  if (!repos.length) return;
  const { heads, branch, root } = useVcs.getState();
  const currentNames = repos.map((repo) => heads[repo]?.head ?? (repo === selected ? branch?.head : null));
  const first = currentNames[0];
  const current =
    first && currentNames.every((head) => head === first)
      ? { name: first, rev: `refs/heads/${first}` }
      : { name: "HEAD", rev: "HEAD" };
  const data: BranchComparisonData = { branch: { name, rev }, current, repositories: repos };
  const key = `${BRANCH_COMPARISON_KIND}:${JSON.stringify([rev, current.rev, repos])}`;
  await saveAll();
  if (useVcs.getState().root !== root) return;
  await editor.openInput({ kind: BRANCH_COMPARISON_KIND, key, data });
}

interface CommitRange {
  repo: string | null;
  from: string;
  to: string;
}

/** Reviews unmerged commits from the branch-deleted notification. */
export function showCommitRanges(title: string, ranges: readonly CommitRange[], restore: () => void) {
  openDialog((close) => <RangeDialog title={title} ranges={ranges} restore={restore} onClose={close} />);
}

function RangeDialog({
  title,
  ranges,
  restore,
  onClose,
}: {
  title: string;
  ranges: readonly CommitRange[];
  restore: () => void;
  onClose: () => void;
}) {
  const [commits, setCommits] = useState<(Commit & { repo: string | null })[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rowHeight = useRowHeight(22);
  useEffect(() => {
    let alive = true;
    void Promise.all(
      ranges.map(async ({ repo, from, to }) => {
        const entries = await call(
          commands.vcsLog(repo, {
            branch: null,
            path: null,
            author: null,
            text: null,
            range: `${from}..${to}`,
            skip: 0,
            limit: 2000,
          }),
        );
        return entries.map((commit) => ({ ...commit, repo }));
      }),
    )
      .then((entries) => alive && setCommits(entries.flat()))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [ranges]);
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      width={640}
      minWidth={420}
      resizable="both"
      className={styles.listDialog}
      buttons={[
        {
          label: "Restore",
          onClick: () => {
            onClose();
            restore();
          },
        },
        { label: "Close", role: "cancel" },
      ]}
    >
      <div className={styles.commitListBody}>
        {error ? (
          <div className={styles.error} style={{ padding: 14 }}>
            {error}
          </div>
        ) : !commits ? (
          <div className={styles.empty}>
            <Spinner size={14} />
          </div>
        ) : (
          <List
            items={commits}
            getKey={(commit) => `${commit.repo}:${commit.id}`}
            rowHeight={rowHeight}
            aria-label="Commits"
            className={styles.grow}
            empty={
              <span>
                <T>No commits</T>
              </span>
            }
            onActivate={(commit) => {
              onClose();
              void executeAction("vcs.showCommit", commit);
            }}
            renderItem={(commit) => (
              <span className={styles.commitRow} style={{ flex: 1, minWidth: 0, padding: 0 }}>
                <span className={styles.commitHash}>{commit.shortId}</span>
                <span
                  className={styles.commitSubject}
                  {...tooltipAttrs(commit.message || commit.summary, undefined, true)}
                >
                  {commit.summary}
                </span>
                <span className={styles.commitMeta}>{commit.author}</span>
                {ranges.length > 1 && commit.repo && <span className={styles.commitMeta}>{repoName(commit.repo)}</span>}
                <span className={styles.commitMeta}>{formatTime(commit.timeMs)}</span>
              </span>
            )}
          />
        )}
      </div>
    </Dialog>
  );
}
