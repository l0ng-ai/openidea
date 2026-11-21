/** An agent task as an editor tab: the conversation, a composer and the task's changed files. */
import type { AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { onIdeEvent } from "@/platform/ipc";
import { isSameOrInside } from "@/platform/paths";
import { useProject } from "@/platform/project";
import { EmptyState, Icon, IconButton, T } from "@/ui";
import { useEditorShown, useToolWindowShown, type EditorInput } from "@/workbench/contributions";
import clsx from "clsx";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useChangesWidthStyle } from "./ChangesResizer";
import styles from "./Session.module.css";
import { useAgentSettings } from "./agentSettings";
import { useChangesOptions } from "./changesOptions";
import { useAgentFontZoomSurface } from "./fontZoom";
import {
  entriesKey,
  findSubagent,
  sessionKey,
  subagentStatusLabel,
  subagentTitle,
  subagentWorking,
  type SubagentEntry,
} from "./model";
import { ChangesPane, useChangesOpen, useLocalHead } from "./session/ChangesPane";
import { FoldedContent } from "./session/Folds";
import { QuestionCard, type QuestionAnswer } from "./session/QuestionForm";
import { SessionComposer } from "./session/SessionComposer";
import { Stream } from "./session/Stream";
import { focusedSession, registerReachableSession, setFocusedSession, type FocusedSession } from "./sessionFocus";
import { cancelTask, loadEntries, markVisible, refreshChanges, scheduleChanges, useAgents } from "./store";

export function SessionEditor({ input, docked = false }: { input: EditorInput; docked?: boolean }) {
  const id = (input.data as { task: string }).task;
  return <TaskSession key={id} id={id} docked={docked} />;
}

function TaskSession({ id, docked }: { id: string; docked: boolean }) {
  const task = useAgents((s) => s.tasks.get(id));
  const entries = useAgents((s) => s.entries.get(id));
  // Grouping needs commits of the task's own: local checkouts keep the flat list.
  const isolation = useAgents((s) => s.tasks.get(id)?.isolation);
  const grouped = useChangesOptions((s) => s.groupByCommit) && isolation === "worktree";
  const sinceStart = useAgents((s) => s.changes.get(id));
  const review = useAgents((s) => s.groupedChanges.get(id));
  const changes = grouped ? (review?.uncommitted ?? null) : (sinceStart ?? null);
  const commits = grouped ? (review?.commits ?? []) : [];
  const scope = useChangesOptions((s) => s.scope);
  const lastTurn = useAgents((s) => s.turnChanges.get(id));
  const project = useProject((s) => s.project);
  const head = useLocalHead(
    task?.isolation === "local" ? task.status : null,
    project?.workspace ? (task?.projectRoot ?? project.root) : null,
  );
  const [changesOpen, setChangesOpen] = useChangesOpen(id, changes ?? null, docked);
  const changesWidth = useChangesWidthStyle();
  // The subagent conversation shown, with the subagents that lead to it (empty: the task's own).
  const [path, setPath] = useState<string[]>([]);
  const view = path.at(-1) ?? null;
  const viewEntries = useAgents((s) => s.entries.get(entriesKey(id, view)));
  const loadError = useAgents((s) => s.entryLoads.get(entriesKey(id, view))?.error);
  // Each subagent's card, from its parent's conversation.
  const cards = useAgents(
    useShallow((s) => path.map((sub, i) => findSubagent(s.entries.get(entriesKey(id, path[i - 1] ?? null)), sub))),
  );
  // Connecting to the project's agents clears what was loaded before: a tab restored with the
  // project reads its conversation once that is done, not before (#2414).
  const connected = useAgents((s) => s.loaded);
  useEffect(() => {
    if (!connected) return;
    // Loaded entries are kept current by the task's events: reopening the tab needn't fetch them again.
    if (!useAgents.getState().entries.has(id)) void loadEntries(id).catch(() => undefined);
    void refreshChanges(id);
  }, [id, connected]);
  // A commit in the task's checkout moves its HEAD: pick it up without waiting for the agent.
  // The watcher reports every repository under the project, so the main checkout and other
  // tasks' worktrees would otherwise re-read this task's changes for nothing. A worktree's
  // gitdir is `<project>/.git/worktrees/<slug>`, outside the worktree itself: the watcher only
  // reports the project there, so that is the root its events match.
  const refreshRoot =
    task?.isolation === "worktree" ? (task.projectRoot ?? project?.root ?? null) : (task?.cwd ?? null);
  useEffect(() => {
    if (!connected) return;
    return onIdeEvent("vcsChanged", (e) => {
      if (!refreshRoot || !isSameOrInside(refreshRoot, e.root)) return;
      scheduleChanges(id);
    });
  }, [id, connected, refreshRoot]);
  // A kept-alive tab stays mounted behind the shown one: it isn't read there, nor searched.
  const shown = useEditorShown();
  useEffect(() => {
    if (shown && (!docked || !changesOpen)) return markVisible(id);
  }, [id, docked, changesOpen, shown]);
  useEffect(() => {
    if (connected && view && !useAgents.getState().entries.has(entriesKey(id, view))) {
      void loadEntries(id, view).catch(() => undefined);
    }
  }, [id, view, connected]);
  const openSubagent = useCallback((sub: string) => setPath((p) => [...p, sub]), []);
  // Answers in flight, kept across entry reloads so a refresh doesn't lose what was typed.
  const drafts = useRef(new Map<string, QuestionAnswer[]>());
  const [finding, setFinding] = useState(false);
  const [findFocus, setFindFocus] = useState(0);
  const [inputFocus, setInputFocus] = useState(0);
  const { fitWindowWidth } = useAgentSettings();
  const sessionRoot = useRef<HTMLDivElement>(null);
  const { fontZoom, zoomStyle } = useAgentFontZoomSurface(sessionRoot, sessionKey(id), docked, !!task);
  // A docked task is on screen while its tool window is; a tab's own `shown` is its editor slot's.
  const toolWindowShown = useToolWindowShown();
  const onScreen = docked ? toolWindowShown : shown;
  const canFocusInput = onScreen && !!task && task.status !== "archived" && !view;
  const session = useMemo<FocusedSession>(
    () => ({
      openFind: () => {
        setFinding(true);
        setFindFocus((n) => n + 1);
      },
      focusInput: canFocusInput
        ? () => {
            if (docked) setChangesOpen(false);
            setInputFocus((n) => n + 1);
          }
        : undefined,
    }),
    [canFocusInput, docked, setChangesOpen],
  );
  useLayoutEffect(() => {
    if (shown && sessionRoot.current?.contains(document.activeElement)) setFocusedSession(session);
    return () => {
      if (focusedSession() === session) setFocusedSession(null);
    };
  }, [session, shown]);
  useLayoutEffect(() => {
    if (session.focusInput) return registerReachableSession(session);
  }, [session]);
  if (!task) return <EmptyState title="This agent task no longer exists" />;
  return (
    <div
      ref={sessionRoot}
      className={clsx(
        styles.session,
        docked && styles.docked,
        changesOpen && !docked && styles.withChanges,
        fitWindowWidth && styles.fitWidth,
      )}
      style={{ ...changesWidth, ...zoomStyle }}
      onFocusCapture={() => shown && setFocusedSession(session)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && focusedSession() === session) {
          setFocusedSession(null);
        }
      }}
    >
      <div className={styles.conversation} hidden={docked && changesOpen}>
        {view && <SubagentBar task={task} path={path} cards={cards} onNavigate={setPath} />}
        <FoldedContent.Provider value={finding && shown}>
          <Stream
            key={view ?? ""}
            task={task}
            entries={viewEntries ?? null}
            loadError={loadError}
            subagent={view ? (cards.at(-1) ?? null) : null}
            onOpenSubagent={openSubagent}
            finding={finding && shown}
            findFocus={findFocus}
            fontZoom={fontZoom}
            onCloseFind={() => setFinding(false)}
            drafts={drafts}
          />
        </FoldedContent.Provider>
        {view ? (
          <div className={styles.readOnly}>
            <T>Subagents take their instructions from the agent that started them.</T>
          </div>
        ) : (
          <>
            <QuestionCard task={task} entries={entries ?? null} drafts={drafts} />
            <SessionComposer
              task={task}
              focusRequest={inputFocus}
              focusRoot={sessionRoot}
              entries={entries ?? null}
              head={head}
              changes={changes ?? null}
              commits={commits}
              changesOpen={changesOpen}
              onToggleChanges={() => setChangesOpen(!changesOpen)}
              onOpenSubagent={openSubagent}
            />
          </>
        )}
      </div>
      {changesOpen && (
        <ChangesPane
          task={task}
          changes={scope === "turn" ? (lastTurn ?? null) : (changes ?? null)}
          commits={scope === "turn" ? [] : commits}
          grouped={grouped && scope === "task"}
          scope={scope}
          head={head}
          docked={docked}
          onHide={() => setChangesOpen(false)}
        />
      )}
    </div>
  );
}

/** Where a subagent conversation sits: the way back to the task, and the subagent's state. */
function SubagentBar({
  task,
  path,
  cards,
  onNavigate,
}: {
  task: AgentTask;
  path: string[];
  cards: Array<SubagentEntry | undefined>;
  onNavigate: (path: string[]) => void;
}) {
  const tx = useTx();
  const card = cards.at(-1);
  return (
    <div className={styles.subagentBar}>
      <IconButton icon="arrow-left" title="Back" onClick={() => onNavigate(path.slice(0, -1))} />
      <nav className={styles.crumbs} aria-label={tx("Subagent")}>
        <button type="button" className={styles.crumb} onClick={() => onNavigate([])} title={task.title}>
          {task.title}
        </button>
        {path.map((sub, i) => {
          const title = cards[i] ? subagentTitle(cards[i]) : tx("Subagent");
          return (
            <Fragment key={sub}>
              <Icon name="chevron-right" size={12} className={styles.muted} />
              {i === path.length - 1 ? (
                <span className={styles.crumbCurrent} title={cards[i]?.description ?? title}>
                  {title}
                </span>
              ) : (
                <button type="button" className={styles.crumb} onClick={() => onNavigate(path.slice(0, i + 1))}>
                  {title}
                </button>
              )}
            </Fragment>
          );
        })}
      </nav>
      {card && (
        <span className={styles.muted}>
          <T>{subagentStatusLabel(card.status)}</T>
        </span>
      )}
      {card && subagentWorking(card.status) && card.cancellable && (
        <IconButton icon="stop" title="Stop Subagent" onClick={() => void cancelTask(task.id, card.id)} />
      )}
    </div>
  );
}
