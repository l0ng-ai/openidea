/** An agent task as an editor tab: the conversation and a composer. */
import type { AgentTask } from "@/bindings";
import { useTx } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { EmptyState, Icon, IconButton, T } from "@/ui";
import { useEditorShown, useToolWindowShown, type EditorInput } from "@/workbench/contributions";
import clsx from "clsx";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import styles from "./Session.module.css";
import { useAgentSettings } from "./agentSettings";
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
import { openTaskChanges, useChangesRefresh, useLocalHead, useTaskChanges } from "./session/ChangesTab";
import { FoldedContent } from "./session/Folds";
import { QuestionCard, type QuestionAnswer } from "./session/QuestionForm";
import { SessionComposer } from "./session/SessionComposer";
import { Stream } from "./session/Stream";
import { focusedSession, registerReachableSession, setFocusedSession, type FocusedSession } from "./sessionFocus";
import { cancelTask, loadEntries, markVisible, useAgents } from "./store";

export function SessionEditor({ input, docked = false }: { input: EditorInput; docked?: boolean }) {
  const id = (input.data as { task: string }).task;
  return <TaskSession key={id} id={id} docked={docked} />;
}

/**
 * What `select` reads from the store while this tab is `shown`. Hidden behind another tab, it keeps
 * what it had when it was hidden: a conversation streaming in the background renders nothing here,
 * and the tab catches up in one render when it is shown again.
 */
function useAgentsWhileShown<T>(shown: boolean, select: (s: ReturnType<typeof useAgents.getState>) => T): T {
  const held = useRef<{ value: T } | null>(null);
  return useAgents((s) => {
    if (shown || !held.current) held.current = { value: select(s) };
    return held.current.value;
  });
}

function TaskSession({ id, docked }: { id: string; docked: boolean }) {
  // A kept-alive tab stays mounted behind the shown one: it isn't read there, nor searched.
  const shown = useEditorShown();
  const task = useAgents((s) => s.tasks.get(id));
  const entries = useAgentsWhileShown(shown, (s) => s.entries.get(id));
  const { changes, commits } = useTaskChanges(id);
  useChangesRefresh(id);
  const project = useProject((s) => s.project);
  const head = useLocalHead(
    task?.isolation === "local" ? task.status : null,
    project?.workspace ? (task?.projectRoot ?? project.root) : null,
  );
  // The subagent conversation shown, with the subagents that lead to it (empty: the task's own).
  const [path, setPath] = useState<string[]>([]);
  const view = path.at(-1) ?? null;
  const viewEntries = useAgentsWhileShown(shown, (s) => s.entries.get(entriesKey(id, view)));
  const loadError = useAgents((s) => s.entryLoads.get(entriesKey(id, view))?.error);
  // Each subagent's card, from its parent's conversation.
  const cards = useAgentsWhileShown(
    shown,
    useShallow((s) => path.map((sub, i) => findSubagent(s.entries.get(entriesKey(id, path[i - 1] ?? null)), sub))),
  );
  // Connecting to the project's agents clears what was loaded before: a tab restored with the
  // project reads its conversation once that is done, not before (#2414).
  const connected = useAgents((s) => s.loaded);
  useEffect(() => {
    if (!connected) return;
    // Loaded entries are kept current by the task's events: reopening the tab needn't fetch them again.
    if (!useAgents.getState().entries.has(id)) void loadEntries(id).catch(() => undefined);
  }, [id, connected]);
  useEffect(() => {
    if (shown) return markVisible(id);
  }, [id, shown]);
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
      focusInput: canFocusInput ? () => setInputFocus((n) => n + 1) : undefined,
    }),
    [canFocusInput],
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
      className={clsx(styles.session, docked && styles.docked, fitWindowWidth && styles.fitWidth)}
      style={zoomStyle}
      onFocusCapture={() => shown && setFocusedSession(session)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null) && focusedSession() === session) {
          setFocusedSession(null);
        }
      }}
    >
      <div className={styles.conversation}>
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
              onOpenChanges={() => openTaskChanges(id)}
              onOpenSubagent={openSubagent}
            />
          </>
        )}
      </div>
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
