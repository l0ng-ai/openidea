/**
 * Commits of the branch widget's incoming / outgoing markers: a popup listing them the way
 * git does (newest first) and opening a commit's diff in the log's diff view.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { create } from "zustand";
import type { Commit } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { notifications } from "@/workbench/contributions";
import { Button, Icon, List, Popup, Spinner, T, firstSelectable } from "@/ui";
import type { PopupAnchor } from "@/ui/Popup";
import { showChangesDiff, toLogChanges } from "./logChanges";
import { formatTime } from "./model";
import { currentRepo, useVcs } from "./store";
import { syncRow, syncSections, type SyncBranch, type SyncDirection, type SyncSection } from "./syncCommits";
import styles from "./SyncCommitsPopup.module.css";
import common from "./common.module.css";

/** A commit range can be long; the popup shows what git lists, bounded like Compare Branches. */
const LIMIT = 2000;

export interface SyncCommitsSource {
  repo: string | null;
  branch: SyncBranch;
  /** Only the side whose marker was clicked; `undefined` lists both. */
  direction?: SyncDirection;
}

export const useSyncCommits = create<{ source: SyncCommitsSource | null }>(() => ({ source: null }));

/** Opens the commit list of `source` (a marker click, or the branches popup entry). */
export function showSyncCommits(source: SyncCommitsSource) {
  useSyncCommits.setState({ source });
}

/** The selected branch's own list: the Branches popup entry and the `vcs.syncCommits` action. */
export function showSyncCommitsForCurrent(direction?: SyncDirection) {
  const info = useVcs.getState().branch;
  if (!info) return;
  showSyncCommits({
    repo: currentRepo(),
    branch: { branch: info.head, upstream: info.upstream, ahead: info.ahead, behind: info.behind },
    direction,
  });
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
  const key = `${source.repo ?? ""}\0${source.branch.branch ?? ""}\0${source.branch.upstream ?? ""}\0${source.direction ?? ""}`;
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
  const sections = useMemo(() => syncSections(source.branch, source.direction), [source.branch, source.direction]);
  const [lists, setLists] = useState<Commit[][] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const title = popupTitle(source);

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

  const body = () => {
    if (!source.branch.upstream)
      return (
        <div className={styles.empty}>
          <T>This branch has no upstream. Push it to compare with a remote branch.</T>
        </div>
      );
    if (!sections.length) return <div className={styles.empty}>{tx`Up to date with ${source.branch.upstream}`}</div>;
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
          rowHeight={22}
          aria-label={title}
          className={styles.list}
        />
      </div>
    );
  };

  return (
    <Popup open anchor={anchor} placement="bottom-start" onClose={onClose} aria-label={title} className={styles.popup}>
      <div className={styles.header}>{title}</div>
      {body()}
      <div className={styles.footer}>
        <Button icon="history" disabled={!activeCommit} onClick={openInLog}>
          Open in Git Log
        </Button>
      </div>
    </Popup>
  );
}
