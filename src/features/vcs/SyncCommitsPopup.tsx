/**
 * Commits of the branch widget's incoming / outgoing markers: a popup listing them the way
 * git does (newest first) and opening a commit's diff in the log's diff view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { create } from "zustand";
import type { BranchInfo, Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { notifications } from "@/workbench/contributions";
import { Button, Icon, List, Popup, Spinner, T, firstSelectable } from "@/ui";
import type { PopupAnchor } from "@/ui/Popup";
import { activeRepository } from "./activeRepository";
import { showChangesDiff, toLogChanges } from "./logChanges";
import { formatTime } from "./model";
import { currentRepoRoot, unfetchedBranch, useVcs } from "./store";
import {
  outgoingDestination,
  syncRow,
  syncSections,
  type SyncBranch,
  type SyncDirection,
  type SyncSection,
} from "./syncCommits";
import styles from "./SyncCommitsPopup.module.css";
import common from "./common.module.css";
import { useRowHeight } from "@/ui/density";

/** A commit range can be long; the popup shows what git lists, bounded like Compare Branches. */
const LIMIT = 2000;

export interface SyncCommitsSource {
  repo: string | null;
  branch: SyncBranch;
  /** Only the side whose marker was clicked; `undefined` lists both. */
  direction?: SyncDirection;
  unfetchedRemote?: string;
}

export const useSyncCommits = create<{ source: SyncCommitsSource | null }>(() => ({ source: null }));
let openGeneration = 0;

/** Opens the commit list of `source` (a marker click, or the branches popup entry). */
export function showSyncCommits(source: SyncCommitsSource) {
  openGeneration++;
  useSyncCommits.setState({ source });
}

export function showBranchSync(repo: string | null, info: BranchInfo, direction?: SyncDirection) {
  showSyncCommits(syncSource(repo, info, direction));
}

/** The active file's repository also scopes the Branches popup entry and Find Action. */
export async function showSyncCommitsForCurrent(direction?: SyncDirection) {
  const request = ++openGeneration;
  const { branch, branchRoot, roots } = useVcs.getState();
  const project = useProject.getState().project;
  const repo = activeRepository();
  const info =
    repo && roots.length > 1 && repo !== branchRoot
      ? await call(commands.vcsBranchInfo(repo)).catch(() => null)
      : branch;
  if (info && request === openGeneration && project === useProject.getState().project)
    showBranchSync(repo, info, direction);
}

function syncSource(repo: string | null, info: BranchInfo, direction?: SyncDirection): SyncCommitsSource {
  const pending = unfetchedBranch(useVcs.getState().unfetched, repo ?? currentRepoRoot(), info.head, info.trackedTip);
  return {
    repo,
    branch: {
      branch: info.head,
      upstream: info.upstream,
      ahead: info.ahead,
      behind: info.behind,
      outgoing: info.outgoing,
    },
    direction,
    unfetchedRemote: pending?.trackedTip.tracking.remote,
  };
}

/** The popup host; the branches widget anchors it, and it falls back to the window centre. */
export function SyncCommitsPopupHost() {
  const source = useSyncCommits((s) => s.source);
  if (!source) return null;
  const anchor: PopupAnchor = document.querySelector("[data-branches-widget]") ?? {
    x: window.innerWidth / 2 - 280,
    y: 60,
  };
  // Another branch, direction or repository starts from a clean popup rather than the last list.
  const key = [
    source.repo,
    source.branch.branch,
    source.branch.upstream,
    source.branch.ahead,
    source.branch.behind,
    source.branch.outgoing?.reference,
    source.branch.outgoing?.count,
    source.direction,
    source.unfetchedRemote,
  ].join("\0");
  return (
    <SyncCommitsPopup
      key={key}
      source={source}
      anchor={anchor}
      onClose={() => useSyncCommits.setState({ source: null })}
    />
  );
}

type PopupRow =
  | { type: "section"; key: string; section: SyncSection }
  | { type: "commit"; key: string; commit: Commit };

function popupTitle(source: SyncCommitsSource): string {
  if (source.direction === "incoming") return tx("Incoming commits");
  if (source.direction === "outgoing") return tx("Outgoing commits");
  return tx("Incoming and outgoing commits");
}

/** A commit's files, as the log's changed-files pane builds them, so its Show Diff path opens them. */
async function showCommitDiff(commit: Commit, repo: string | null) {
  const files = await call(commands.vcsCommitFiles(repo, commit.id));
  if (!files.length) {
    notifications().notify({ group: "vcs", level: "info", title: tx("Nothing to show") });
    return;
  }
  await showChangesDiff(toLogChanges(files, commit, repo));
}

function SyncCommitsPopup({
  source,
  anchor,
  onClose,
}: {
  source: SyncCommitsSource;
  anchor: PopupAnchor;
  onClose: () => void;
}) {
  const rowHeight = useRowHeight(22);
  const sections = useMemo(() => syncSections(source.branch, source.direction), [source.branch, source.direction]);
  const [lists, setLists] = useState<Commit[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const title = popupTitle(source);
  const remoteBusy = useVcs((s) => !!s.remoteBusy);
  const unfetched = source.direction !== "outgoing" && !!source.unfetchedRemote;
  const destination = outgoingDestination(source.branch.outgoing);

  useEffect(() => {
    if (!sections.length) return;
    let live = true;
    Promise.all(
      sections.map((section) =>
        call(
          commands.vcsLog(source.repo, {
            branch: null,
            path: null,
            author: null,
            text: null,
            range: section.range,
            skip: 0,
            limit: LIMIT,
          }),
        ),
      ),
    )
      .then((loaded) => {
        if (!live) return;
        setLists(loaded);
        setError(null);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, [sections, source.repo]);

  const rows = useMemo<PopupRow[]>(() => {
    if (!lists) return [];
    const out: PopupRow[] = [];
    // One direction is already the popup's title; only a list of both needs its section headers.
    const withSections = sections.length > 1;
    sections.forEach((section, i) => {
      if (withSections) out.push({ type: "section", key: `section:${section.direction}`, section });
      for (const commit of lists[i] ?? [])
        out.push({ type: "commit", key: `${section.direction}:${commit.id}`, commit });
    });
    return out;
  }, [lists, sections]);
  const isSection = (row: PopupRow) => row.type === "section";
  const activeIndex = rows[active]?.type === "commit" ? active : firstSelectable(rows, isSection);
  const activeCommit = rows[activeIndex]?.type === "commit" ? rows[activeIndex].commit : null;
  const total = lists?.reduce((n, list) => n + list.length, 0) ?? 0;

  // The list arrives after the popup opened: move focus into it so ↑/↓ and Enter work.
  useEffect(() => {
    if (!lists || !total) return;
    listRef.current?.querySelector<HTMLElement>('[role="listbox"]')?.focus({ preventScroll: true });
  }, [lists, total]);

  const openDiff = (commit: Commit) => {
    onClose();
    void showCommitDiff(commit, source.repo).catch((e) =>
      notifications().notify({
        group: "vcs",
        level: "error",
        title: tx("Could not show diff"),
        body: e instanceof Error ? e.message : String(e),
      }),
    );
  };
  const openInLog = () => {
    if (!activeCommit) return;
    onClose();
    void executeAction("vcs.showCommit", { ...activeCommit, repo: source.repo });
  };
  const fetch = async () => {
    const project = useProject.getState().project;
    if (!(await executeAction("vcs.fetch", { repo: source.repo, remote: source.unfetchedRemote }))) return;
    if (useProject.getState().project !== project || useSyncCommits.getState().source !== source) return;
    const info = await call(commands.vcsBranchInfo(source.repo)).catch(() => null);
    if (
      info &&
      info.head === source.branch.branch &&
      useProject.getState().project === project &&
      useSyncCommits.getState().source === source
    )
      showSyncCommits(syncSource(source.repo, info, source.direction));
  };

  const body = () => {
    if (!sections.length) {
      if (unfetched) return null;
      if (source.direction === "outgoing" && source.branch.outgoing === null)
        return (
          <div className={styles.empty}>
            <T>No local tracking ref is available for the push destination.</T>
          </div>
        );
      const upstream = source.branch.upstream;
      const compared =
        source.direction === "outgoing"
          ? (destination ?? upstream)
          : source.direction === "incoming"
            ? upstream
            : (upstream ?? destination);
      return (
        <div className={styles.empty}>
          {compared ? (
            tx`Up to date with ${compared}`
          ) : (
            <T>This branch has no upstream. Push it to compare with a remote branch.</T>
          )}
        </div>
      );
    }
    if (error) return <div className={clsx(common.error, styles.empty)}>{error}</div>;
    if (!lists)
      return (
        <div className={styles.empty}>
          <Spinner size={14} />
        </div>
      );
    if (!total) return <div className={styles.empty}>{tx("No commits")}</div>;
    return (
      <div ref={listRef}>
        <List
          items={rows}
          getKey={(row) => row.key}
          isSection={isSection}
          renderSection={(row) =>
            row.type === "section" ? (
              <span className={styles.section}>
                <Icon name={row.section.direction === "incoming" ? "vcs-incoming" : "vcs-outgoing"} size={12} />
                {row.section.direction === "incoming" ? <T>Incoming commits</T> : <T>Outgoing commits</T>}
                <span className={styles.count}>{row.section.count}</span>
              </span>
            ) : null
          }
          renderItem={(row) => {
            if (row.type !== "commit") return null;
            const commit = row.commit;
            const line = syncRow(commit);
            return (
              <span className={clsx(common.commitRow, styles.row)}>
                <span className={common.commitHash}>{line.hash}</span>
                <span className={common.commitSubject} title={commit.message || commit.summary}>
                  {line.subject}
                </span>
                <span className={common.commitMeta}>{line.author}</span>
                <span className={common.commitMeta}>{formatTime(commit.timeMs)}</span>
              </span>
            );
          }}
          activeIndex={activeIndex}
          onActiveChange={setActive}
          onActivate={(row) => {
            if (row.type === "commit") openDiff(row.commit);
          }}
          rowHeight={rowHeight}
          aria-label={title}
          className={styles.list}
        />
      </div>
    );
  };

  return (
    <Popup open anchor={anchor} placement="bottom-start" onClose={onClose} aria-label={title} className={styles.popup}>
      <div className={styles.header}>{title}</div>
      {source.direction !== "incoming" && destination && destination !== source.branch.upstream && (
        <div className={styles.destination}>{tx`Push destination: ${destination}`}</div>
      )}
      {unfetched && (
        <div className={styles.empty}>
          <T>Remote changes available to fetch</T>
        </div>
      )}
      {body()}
      <div className={styles.footer}>
        {unfetched && (
          <Button
            icon="git-fetch"
            variant={sections.length ? "secondary" : "primary"}
            data-autofocus={!sections.length || undefined}
            disabled={remoteBusy}
            onClick={() => void fetch()}
          >
            Fetch
          </Button>
        )}
        {(!unfetched || sections.length > 0) && (
          <Button icon="history" disabled={!activeCommit} onClick={openInLog}>
            Open in Git Log
          </Button>
        )}
      </div>
    </Popup>
  );
}
