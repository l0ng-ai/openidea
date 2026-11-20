/** "Compare with current": commits on either side of two branches. */
import { useEffect, useState } from "react";
import type { Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { Dialog, List, Spinner, SplitGroup, SplitHandle, SplitPanel, T, tooltipAttrs } from "@/ui";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { showCompareRevisions } from "./operations";
import { currentRepo, useVcs } from "./store";
import styles from "./common.module.css";
import compareStyles from "./CompareBranches.module.css";
import { tx } from "@/platform/i18n";
import { useRowHeight } from "@/ui/density";

const LIMIT = 2000;

/** Commits reachable from `to` but not from `from` (git's `from..to`), computed by git, unbounded by any window. */
const commitsBetween = (from: string, to: string, repo: string | null = currentRepo()) =>
  call(
    commands.vcsLog(repo, {
      branch: null,
      path: null,
      author: null,
      text: null,
      range: `${from}..${to}`,
      skip: 0,
      limit: LIMIT,
    }),
  ).then((commits) => commits.map((c) => ({ ...c, repo })));

export function showCompareBranches(branch: string) {
  const current = useVcs.getState().branch?.head ?? "HEAD";
  openDialog((close) => <CompareDialog branch={branch} current={current} onClose={close} />);
}

/** IDEA's "View Commits" of a notification: the commits of `from..to`. */
export function showCommitRange(title: string, from: string, to: string, repo: string | null = currentRepo()) {
  openDialog((close) => <RangeDialog title={title} from={from} to={to} repo={repo} onClose={close} />);
}

function RangeDialog(props: { title: string; from: string; to: string; repo: string | null; onClose: () => void }) {
  const { title, from, to, repo, onClose } = props;
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    commitsBetween(from, to, repo)
      .then((c) => alive && setCommits(c))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [from, to, repo]);
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      width={640}
      minWidth={420}
      resizable="both"
      className={styles.listDialog}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <CommitList commits={commits} error={error} onClose={onClose} />
    </Dialog>
  );
}

function CommitList({
  commits,
  error = null,
  rangeLabel,
  onClose,
}: {
  commits: Commit[] | null;
  error?: string | null;
  rangeLabel?: string;
  onClose: () => void;
}) {
  const rowHeight = useRowHeight(rangeLabel ? 42 : 22);
  return (
    <div className={rangeLabel ? compareStyles.list : styles.commitListBody}>
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
          getKey={(c) => c.id}
          rowHeight={rowHeight}
          aria-label={rangeLabel ?? "Commits"}
          className={styles.grow}
          empty={
            <span>
              <T>No commits</T>
            </span>
          }
          onActivate={(c) => {
            onClose();
            void executeAction("vcs.showCommit", c);
          }}
          renderItem={(c) =>
            rangeLabel ? (
              <div className={compareStyles.commit}>
                <span className={compareStyles.subject} {...tooltipAttrs(c.message || c.summary, undefined, true)}>
                  {c.summary}
                </span>
                <div className={compareStyles.metadata}>
                  <span className={styles.commitHash}>{c.shortId}</span>
                  <span className={compareStyles.author}>{c.author}</span>
                  <span className={compareStyles.date}>{formatTime(c.timeMs)}</span>
                </div>
              </div>
            ) : (
              <span className={styles.commitRow} style={{ flex: 1, minWidth: 0, padding: 0 }}>
                <span className={styles.commitHash}>{c.shortId}</span>
                <span className={styles.commitSubject} {...tooltipAttrs(c.message || c.summary, undefined, true)}>
                  {c.summary}
                </span>
                <span className={styles.commitMeta}>{c.author}</span>
                <span className={styles.commitMeta}>{formatTime(c.timeMs)}</span>
              </span>
            )
          }
        />
      )}
    </div>
  );
}

function CompareRange({ label, commits, onClose }: { label: string; commits: Commit[] | null; onClose: () => void }) {
  return (
    <SplitPanel defaultSize="50%" minSize="25%">
      <div className={compareStyles.range}>
        <div className={compareStyles.rangeHeader}>
          <h3>{label}</h3>
          {commits && <span className={compareStyles.count}>{commits.length}</span>}
        </div>
        <CommitList rangeLabel={label} commits={commits} onClose={onClose} />
      </div>
    </SplitPanel>
  );
}

function CompareDialog({ branch, current, onClose }: { branch: string; current: string; onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [data, setData] = useState<{ incoming: Commit[]; outgoing: Commit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    Promise.all([commitsBetween("HEAD", branch, repo), commitsBetween(branch, "HEAD", repo)])
      .then(([incoming, outgoing]) => {
        if (alive) setData({ incoming, outgoing });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [branch, repo]);
  return (
    <Dialog
      open
      title={tx`Compare ${current} with ${branch}`}
      onClose={onClose}
      width={800}
      minWidth={360}
      minHeight={360}
      resizable="both"
      className={`${styles.listDialog} ${compareStyles.dialog}`}
      buttons={[
        {
          label: "Show Diff",
          role: "default",
          onClick: () => {
            onClose();
            // Whole-project diff: every file that differs between the branches.
            showCompareRevisions(branch, "HEAD", branch, current, repo);
          },
        },
        { label: "Close", role: "cancel" },
      ]}
    >
      {error ? (
        <div className={`${styles.error} ${compareStyles.error}`} role="alert">
          {error}
        </div>
      ) : (
        <SplitGroup orientation="vertical" className={compareStyles.ranges}>
          <CompareRange
            label={tx`In ${branch}, not in ${current}`}
            commits={data?.incoming ?? null}
            onClose={onClose}
          />
          <SplitHandle aria-label={tx("Resize branch comparison panes")} />
          <CompareRange
            label={tx`In ${current}, not in ${branch}`}
            commits={data?.outgoing ?? null}
            onClose={onClose}
          />
        </SplitGroup>
      )}
    </Dialog>
  );
}
