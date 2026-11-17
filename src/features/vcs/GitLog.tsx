import { tx } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { useWorkflowSettings } from "@/platform/workflowSettings";
import { EmptyState, IconButton, SplitGroup, SplitHandle, SplitPanel, T, Tabs } from "@/ui";
import { copySelectionOnKeyDown } from "@/ui/selectableText";
import { spanStyle } from "@/ui/ansi";
import clsx from "clsx";
import { useContext, useEffect, useLayoutEffect, useRef } from "react";
import { LocalChangesView, StashContent, tabItems, useStashTabCounts } from "./CommitView";
import styles from "./GitLog.module.css";
import { WorktreesPanel } from "./gitMenuDialogs";
import { gitTabs, shownTab } from "./gitTabs";
import { BranchesPanel } from "./log/BranchesPanel";
import { CommitDetails } from "./log/CommitDetails";
import { CommitList } from "./log/CommitList";
import { FilterBar } from "./log/FilterBar";
import { useLogRepositories, useReadOnlyLog } from "./log/logHooks";
import { LogIdContext } from "./logContext";
import { invalidateLogDetails } from "./logDetails";
import { useLogOptions } from "./logOptions";
import { LogScope } from "./LogScope";
import {
  closeLogTab,
  initLogBranchFilter,
  logState,
  refsSignature,
  reloadLog,
  selectGitTab,
  useGitLog,
} from "./logStore";
import { branchesByRepo } from "./multiRoot";
import { clearConsole, useVcsConsole } from "./ops";
import { loadBranches, useVcs } from "./store";

/** The Git window's tabs (they depend on the commit interface) and the one shown. */
function useGitTabs() {
  const available = useVcs((s) => s.available);
  const modal = useWorkflowSettings((s) => !s.vcs.commit.nonModal);
  const combine = useWorkflowSettings((s) => s.vcs.git.combineStashAndShelf);
  const tab = useGitLog((s) => s.tab);
  const logTabs = useGitLog((s) => s.logTabs);
  const counts = useStashTabCounts(available && modal);
  const tabs = gitTabs({ modal, combine, tab, logTabs, ...counts });
  return { tabs, shown: shownTab(tab, tabs, combine) };
}

/** Tool window header: [Local Changes / Stash…] Log, log tabs, Console and Worktrees content tabs. */
export function GitTabs() {
  const available = useVcs((s) => s.available);
  const external = useGitLog((s) => s.logTabs.some((t) => t.id === s.tab && t.readOnly));
  const { tabs, shown } = useGitTabs();
  if (!available && !external) return null;
  return (
    <Tabs
      variant="compact"
      className={styles.headerTabs}
      activeId={shown}
      onSelect={selectGitTab}
      onClose={closeLogTab}
      aria-label="Git"
      panelIdPrefix="openidea-git"
      items={tabItems(tabs)}
    />
  );
}

export function GitToolWindow() {
  const { shown } = useGitTabs();
  const available = useVcs((s) => s.available);
  const external = useGitLog((s) => s.logTabs.some((t) => t.id === s.tab && t.readOnly));
  if (!available && !external)
    return (
      <EmptyState title="Version control is not configured">
        <T>The project is not a Git repository.</T>
      </EmptyState>
    );
  return (
    <div
      className={styles.root}
      role="tabpanel"
      id={`openidea-git-panel-${shown}`}
      aria-labelledby={`openidea-git-tab-${shown}`}
    >
      {shown === "changes" ? (
        <LocalChangesView />
      ) : shown === "shelf" || shown === "stashes" ? (
        <StashContent tab={shown} />
      ) : shown === "console" ? (
        <ConsoleView />
      ) : shown === "worktrees" ? (
        <WorktreesPanel className={styles.worktrees} listClassName={styles.worktreeList} />
      ) : (
        // Each log tab has its own view (its filters and commits are swapped into the store).
        <LogScope id={shown}>
          <LogView key={shown} />
        </LogScope>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Log

export function LogView() {
  const scope = useContext(LogIdContext);
  const shown = useGitLog((s) => s.shownLog);
  const active = !scope || scope === shown;
  const version = useVcs((s) => s.version);
  const commits = useGitLog((s) => s.commits);
  const selection = useGitLog((s) => s.selection);
  const root = useVcs((s) => s.root);
  const repo = useLogRepositories();
  const readOnly = useReadOnlyLog();
  const showBranches = useLogOptions((s) => s.showBranches);
  const showDetails = useLogOptions((s) => s.showDetails);
  const branchesLoaded = useVcs((s) => s.branchesLoaded);
  const lastRefs = useRef<string | null>(null);
  const allRefs = useRef<string | null>(null);
  const externalRefs = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    void Promise.all([
      branchesByRepo(repo),
      Promise.all(repo.map(async (root) => [root, await call(commands.vcsLogRefs(root))] as const)),
    ])
      .then(([all, refs]) => {
        if (!live) return;
        const signature = JSON.stringify([all, refs]);
        if (allRefs.current !== null && allRefs.current !== signature) {
          invalidateLogDetails(repo);
          void reloadLog({ preserve: true }, scope ?? undefined);
        }
        allRefs.current = signature;
        if (readOnly) externalRefs.current = JSON.stringify(refs.map(([, value]) => value));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [repo, version, readOnly, scope]);
  useEffect(() => {
    if (!readOnly) return;
    let live = true;
    const timer = setInterval(() => {
      void Promise.all(repo.map((root) => call(commands.vcsLogRefs(root))))
        .then((refs) => {
          if (!live) return;
          const signature = JSON.stringify(refs);
          if (externalRefs.current && externalRefs.current !== signature) {
            invalidateLogDetails(repo);
            void reloadLog({ preserve: true }, scope ?? undefined);
          }
          externalRefs.current = signature;
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [repo, readOnly, scope]);

  // On mount, when the window switches to another project and when another of its
  // repositories is selected (its branches are needed to notice its refs moving).
  const mounted = useRef(false);
  useEffect(() => {
    lastRefs.current = null;
    allRefs.current = null;
    const state = logState(scope ?? undefined);
    if (mounted.current || !state.loading) void reloadLog({ preserve: state.commits.length > 0 }, scope ?? undefined);
    mounted.current = true;
    if (!readOnly) void loadBranches().catch(() => undefined);
  }, [root, repo, readOnly, scope]);

  // Once the repository's branches are known, settle the branch filter (the
  // remembered refs, else the current branch) and load the log with it.
  useEffect(() => {
    if (!active) return;
    if (!branchesLoaded) return;
    // The refs the log is loaded with, so the first checkout or commit after this reloads it.
    const { branch, branches } = useVcs.getState();
    lastRefs.current = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const settled = initLogBranchFilter();
    const { commits, loading } = useGitLog.getState();
    if (settled || (!commits.length && !loading)) void reloadLog();
  }, [root, repo, branchesLoaded, active]);

  // HEAD or a branch tip moved (commit, undo, reset, rebase, fetch…): reload (keeps the selection).
  useEffect(() => {
    if (!active) return;
    const { branch, branches, branchesLoaded } = useVcs.getState();
    if (!branchesLoaded) return;
    const refs = refsSignature(branch, branches) + JSON.stringify(useVcs.getState().heads);
    const previous = lastRefs.current;
    lastRefs.current = refs;
    if (previous !== null && previous !== refs && useGitLog.getState().commits.length)
      void reloadLog({ preserve: true });
  }, [version, active]);

  return (
    // Its own layout without the Branches pane, so each keeps its sizes.
    <SplitGroup
      key={showBranches ? "branches" : "no-branches"}
      orientation="horizontal"
      id={showBranches ? "git-log" : "git-log-no-branches"}
      storageKey={`openidea.vcs.logSplit.${showBranches ? "branches" : "noBranches"}.${showDetails ? "details" : "noDetails"}`}
      className={styles.split}
    >
      {showBranches && (
        <>
          <SplitPanel id="branches" defaultSize="18%" minSize="120px">
            <BranchesPanel />
          </SplitPanel>
          <SplitHandle />
        </>
      )}
      <SplitPanel id="commits" defaultSize="54%" minSize="25%">
        <div className={styles.log}>
          <FilterBar />
          <CommitList />
        </div>
      </SplitPanel>
      {showDetails && (
        <>
          <SplitHandle />
          <SplitPanel id="details" defaultSize="28%" minSize="15%">
            <CommitDetails key={selection.join(" ") || "none"} commits={commits} />
          </SplitPanel>
        </>
      )}
    </SplitGroup>
  );
}

// ---------------------------------------------------------------------------
// Console

function ConsoleView() {
  const lines = useVcsConsole((s) => s.lines);
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <div className={styles.consoleWrap}>
      <div className={styles.consoleBar}>
        <IconButton icon="trash" title="Clear All" size="small" onClick={clearConsole} />
      </div>
      <div
        ref={ref}
        className={styles.console}
        tabIndex={0}
        role="log"
        onKeyDown={copySelectionOnKeyDown}
        aria-label={tx("Git console")}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
        }}
      >
        {!lines.length && (
          <div className={styles.muted}>
            <T>Git commands run by the IDE appear here.</T>
          </div>
        )}
        {lines.map((l) => (
          <div key={l.id} className={clsx(styles.line, styles[`line-${l.kind}`])}>
            {l.kind === "cmd" && (
              <span className={styles.time}>{new Date(l.time).toLocaleTimeString(undefined, { hour12: false })} </span>
            )}
            {l.spans
              ? l.spans.map((s, i) => (
                  // A background without a colour of its own keeps the default text colour, as in
                  // a terminal, not the red of an error line.
                  <span key={i} style={s.bg && !s.fg ? { ...spanStyle(s), color: "var(--fg)" } : spanStyle(s)}>
                    {s.text}
                  </span>
                ))
              : l.text}
          </div>
        ))}
      </div>
    </div>
  );
}
