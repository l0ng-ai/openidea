/** "Compare with current": commits on either side of two branches. */
import { useEffect, useState } from "react";
import type { Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { Dialog, List, Spinner, Tabs, T } from "@/ui";
import { openDialog } from "./dialogs";
import { formatTime } from "./model";
import { currentRepo, useVcs } from "./store";
import styles from "./common.module.css";
import { tx } from "@/platform/i18n";

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
    <Dialog open title={title} onClose={onClose} width={640} buttons={[{ label: "Close", role: "cancel" }]}>
      <CommitList commits={commits} error={error} onClose={onClose} />
    </Dialog>
  );
}

function CommitList({
  commits,
  error,
  onClose,
}: {
  commits: Commit[] | null;
  error: string | null;
  onClose: () => void;
}) {
  return (
    <div style={{ height: 320, display: "flex", flexDirection: "column" }}>
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
          rowHeight={22}
          aria-label="Commits"
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
          renderItem={(c) => (
            <span className={styles.commitRow} style={{ flex: 1, padding: 0 }}>
              <span className={styles.commitHash}>{c.shortId}</span>
              <span className={styles.commitSubject}>{c.summary}</span>
              <span className={styles.commitMeta}>{c.author}</span>
              <span className={styles.commitMeta}>{formatTime(c.timeMs)}</span>
            </span>
          )}
        />
      )}
    </div>
  );
}

function CompareDialog({ branch, current, onClose }: { branch: string; current: string; onClose: () => void }) {
  const [repo] = useState(currentRepo);
  const [data, setData] = useState<{ incoming: Commit[]; outgoing: Commit[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState("incoming");
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
  }, [branch]);
  const list = data ? (tab === "incoming" ? data.incoming : data.outgoing) : [];
  return (
    <Dialog
      open
      title={tx`Compare ${current} with ${branch}`}
      onClose={onClose}
      width={640}
      buttons={[{ label: "Close", role: "cancel" }]}
    >
      <Tabs
        variant="compact"
        activeId={tab}
        onSelect={setTab}
        aria-label="Direction"
        items={[
          {
            id: "incoming",
            label: tx`In ${branch}, not in ${current}`,
            trailing: data ? String(data.incoming.length) : undefined,
          },
          {
            id: "outgoing",
            label: tx`In ${current}, not in ${branch}`,
            trailing: data ? String(data.outgoing.length) : undefined,
          },
        ]}
      />
      <CommitList commits={data ? list : null} error={error} onClose={onClose} />
    </Dialog>
  );
}
