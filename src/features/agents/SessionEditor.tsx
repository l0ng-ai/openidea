/** An agent task as an editor tab: the conversation, a composer and the task's changed files. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type { AgentChange, AgentEntry, AgentTask } from "@/bindings";
import { executeAction } from "@/platform/actions";
import { call, commands } from "@/platform/ipc";
import { basename, relativeDir, useProject } from "@/platform/project";
import { editorService, notifications, type EditorInput } from "@/workbench/contributions";
import { Button, EmptyState, Icon, IconButton, Spinner, T, Tree, fileIconName } from "@/ui";
import { TaskStatusIcon } from "./AgentsView";
import { Composer } from "./Composer";
import { canSend, emptyDraft, usageLabel } from "./composerModel";
import { ConfigPickers } from "./ConfigPickers";
import { Markdown } from "./Markdown";
import { branchLabel, isBusy, providerIcon, statusLabel } from "./model";
import {
  archiveTask,
  cancelTask,
  loadEntries,
  markVisible,
  refreshChanges,
  editQueued,
  removeQueued,
  respond,
  sendMessage,
  sendQueuedNow,
  setTaskConfig,
  useAgents,
} from "./store";
import styles from "./Session.module.css";

export function SessionEditor({ input }: { input: EditorInput }) {
  const id = (input.data as { task: string }).task;
  const task = useAgents((s) => s.tasks.get(id));
  const entries = useAgents((s) => s.entries.get(id));
  const changes = useAgents((s) => s.changes.get(id));
  useEffect(() => {
    void loadEntries(id).catch(() => undefined);
    void refreshChanges(id);
    return markVisible(id);
  }, [id]);
  if (!task) return <EmptyState title="This agent task no longer exists" />;
  return (
    <div className={styles.session}>
      <div className={styles.conversation}>
        <Header task={task} />
        <PermissionBanner task={task} entries={entries ?? null} />
        <Stream task={task} entries={entries ?? null} />
        <SessionComposer task={task} entries={entries ?? null} />
      </div>
      <ChangesPane task={task} changes={changes ?? null} />
    </div>
  );
}

function providerName(id: string) {
  return useAgents.getState().providers.find((p) => p.id === id)?.name ?? id;
}

function Header({ task }: { task: AgentTask }) {
  const busy = isBusy(task.status);
  const where = task.isolation === "worktree" ? branchLabel(task.branch) : null;
  return (
    <div className={styles.header}>
      <TaskStatusIcon status={task.status} />
      <span className={styles.title} title={task.title}>
        {task.title}
      </span>
      <span className={styles.headerDetail} title={task.cwd}>
        <Icon name={providerIcon(task.provider)} size={13} className={styles.providerIcon} />
        {providerName(task.provider)}
        {task.model ? ` · ${task.model}` : ""}
        {" · "}
        {where ?? <T>Local checkout</T>}
        {" · "}
        <T>{statusLabel(task.status)}</T>
      </span>
      {task.usage && <Usage task={task} />}
      {busy && <IconButton icon="stop" title="Stop" size="small" onClick={() => void cancelTask(task.id)} />}
      <IconButton
        icon="terminal"
        title="Open in Terminal"
        size="small"
        onClick={() => void executeAction("terminal.openAt", task.cwd)}
      />
      {!busy && task.status !== "archived" && (
        <IconButton icon="close" title="Archive Task" size="small" onClick={() => void archiveTask(task.id)} />
      )}
    </div>
  );
}

/** Context window use: "12%", the numbers (and cost) in the tooltip. */
function Usage({ task }: { task: AgentTask }) {
  const label = usageLabel(task.usage!);
  return (
    <span className={styles.usage} title={label.detail} aria-label={`Context ${label.short}, ${label.detail}`}>
      <span className={styles.usageBar} aria-hidden>
        <span style={{ width: label.short }} />
      </span>
      {label.short}
    </span>
  );
}

function Stream({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  });
  const waiting = entries?.some((e) => e.type === "permission" && !e.chosen);
  return (
    <div
      ref={ref}
      className={styles.stream}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {entries === null ? (
        <Spinner />
      ) : (
        entries.map((entry, i) => <Entry key={i} task={task} entry={entry} />)
      )}
      {(task.status === "running" || task.status === "starting") && !waiting && (
        <div className={styles.working}>
          <Spinner size={12} />
          <T>{task.status === "starting" ? "Starting the agent…" : "Working…"}</T>
        </div>
      )}
    </div>
  );
}

const TOOL_ICONS: Record<string, string> = {
  read: "file",
  edit: "edit",
  delete: "minus",
  move: "edit",
  search: "search",
  execute: "terminal",
  fetch: "web",
  think: "todo",
};

function Entry({ task, entry }: { task: AgentTask; entry: AgentEntry }) {
  switch (entry.type) {
    case "user":
      return (
        <div className={styles.user}>
          {entry.text}
          {entry.attachments.length > 0 && (
            <div className={styles.attachments}>
              {entry.attachments.map((a, i) => (
                <span key={i} className={styles.attachment}>
                  <Icon name={fileIconName(a)} size={12} />
                  {a}
                </span>
              ))}
            </div>
          )}
        </div>
      );
    case "agent":
      return <Markdown text={entry.text} />;
    case "thought":
      return (
        <details className={styles.thought}>
          <summary>
            <T>Thinking</T>
          </summary>
          <div className={styles.thoughtText}>{entry.text}</div>
        </details>
      );
    case "tool":
      return <ToolEntry task={task} entry={entry} />;
    case "plan":
      return (
        <div className={styles.plan}>
          <div className={styles.planTitle}>
            <T>Plan</T>
          </div>
          {entry.items.map((item, i) => (
            <div key={i} className={clsx(styles.planItem, item.status === "completed" && styles.planDone)}>
              <Icon name={item.status === "completed" ? "check" : item.status === "in_progress" ? "run" : "minus"} size={12} />
              {item.content}
            </div>
          ))}
        </div>
      );
    case "permission":
      return <PermissionLine task={task} entry={entry} />;
    case "error":
      return (
        <div className={styles.error} role="alert">
          <Icon name="error" size={14} />
          <span>{entry.message}</span>
        </div>
      );
  }
}

function ToolEntry({ task, entry }: { task: AgentTask; entry: Extract<AgentEntry, { type: "tool" }> }) {
  const head = (
    <>
      <Icon name={TOOL_ICONS[entry.kind] ?? "run"} size={14} />
      <span className={styles.toolTitle}>{shortTitle(task, entry.title || entry.kind)}</span>
      {entry.diffs.map((d) => (
        <button
          key={d.path}
          type="button"
          className={styles.toolDiff}
          title={d.path}
          onClick={(e) => {
            e.preventDefault();
            void openChangeDiff(task, d.path);
          }}
        >
          <span className={styles.added}>+{d.added}</span> <span className={styles.removed}>−{d.removed}</span>
        </button>
      ))}
      {(entry.status === "running" || entry.status === "pending") && <Spinner size={12} />}
      {entry.status === "failed" && <Icon name="error" size={12} />}
    </>
  );
  if (!entry.output) return <div className={styles.tool}>{head}</div>;
  return (
    <details className={styles.toolDetails}>
      <summary className={styles.tool}>{head}</summary>
      <pre className={styles.output}>{entry.output}</pre>
    </details>
  );
}

/** Agent-written titles with the task's own folder dropped from paths. */
const shortTitle = (task: AgentTask, title: string) => title.replaceAll(`${task.cwd}/`, "");

function PermissionLine({ task, entry }: { task: AgentTask; entry: Extract<AgentEntry, { type: "permission" }> }) {
  return (
    <div className={styles.permissionLine}>
      <Icon name={!entry.chosen ? "warning" : entry.chosen === "Cancelled" ? "minus" : "check"} size={13} />
      <span className={styles.permissionTitle}>{shortTitle(task, entry.title)}</span>
      <span className={styles.muted}>{entry.chosen ?? <T>Waiting for your answer</T>}</span>
    </div>
  );
}

/** The open permission request, as an editor notification banner above the conversation. */
function PermissionBanner({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const [busy, setBusy] = useState(false);
  const entry = entries?.find((e): e is Extract<AgentEntry, { type: "permission" }> => e.type === "permission" && !e.chosen);
  if (!entry) return null;
  const answer = (option: string | null) => {
    setBusy(true);
    void respond(task.id, entry.id, option).finally(() => setBusy(false));
  };
  return (
    <div className={styles.banner} role="alert" aria-label={entry.title}>
      <Icon name="warning" size={16} />
      <span className={styles.bannerText} title={entry.title}>
        {shortTitle(task, entry.title)}
      </span>
      <span className={styles.bannerSpacer} />
      {entry.options.map((o) => (
        <button key={o.id} type="button" className={styles.bannerLink} disabled={busy} onClick={() => answer(o.id)}>
          {o.name}
        </button>
      ))}
    </div>
  );
}

function SessionComposer({ task, entries }: { task: AgentTask; entries: AgentEntry[] | null }) {
  const project = useProject((s) => s.project);
  const composer = useAgents((s) => s.composers.get(task.id)) ?? emptyDraft();
  const [sending, setSending] = useState(false);
  const busy = isBusy(task.status);
  // ↑ recalls this conversation's messages, newest first.
  const history = useMemo(
    () => (entries ?? []).flatMap((e) => (e.type === "user" && e.text ? [e.text] : [])).reverse(),
    [entries],
  );
  const send = (now: boolean) => {
    if (!canSend(composer) || sending || task.status === "archived") return;
    setSending(true);
    sendMessage(task.id, now)
      .catch((e: unknown) => notifications().notify({ level: "error", title: "Couldn't send the message", body: String(e) }))
      .finally(() => setSending(false));
  };
  const setOption = (id: string, value: string) =>
    void setTaskConfig(task.id, id, value).catch((e: unknown) =>
      notifications().notify({ level: "error", title: "Couldn't change the setting", body: String(e) }),
    );
  return (
    <div className={styles.composerArea}>
      {task.queue.length > 0 && <Queue task={task} />}
      <Composer
        id={task.id}
        placeholder={busy ? "Queue a message for when the agent is done (⌘↵ sends it now)" : "Reply to the agent"}
        root={task.cwd}
        projectRoot={project?.root ?? task.cwd}
        commands={task.commands}
        history={history}
        config={task.config}
        onConfig={setOption}
        onSubmit={send}
        disabled={task.status === "archived"}
        toolbar={<ConfigPickers config={task.config} onChange={setOption} />}
        actions={
          <>
            {busy && (
              <Button size="small" icon="stop" onClick={() => void cancelTask(task.id)}>
                Stop
              </Button>
            )}
            <Button
              size="small"
              variant={busy ? "secondary" : "primary"}
              disabled={!canSend(composer) || sending || task.status === "archived"}
              onClick={() => send(false)}
            >
              {busy ? "Queue" : "Send"}
            </Button>
          </>
        }
      />
    </div>
  );
}

/** Messages waiting for the turn to end: send now, edit, or drop. */
function Queue({ task }: { task: AgentTask }) {
  const fail = (e: unknown) => notifications().notify({ level: "error", title: "Couldn't update the queue", body: String(e) });
  return (
    <div className={styles.queue} aria-label="Queued messages">
      {task.queue.map((q) => (
        <div key={q.id} className={styles.queued}>
          <Icon name="pause" size={12} className={styles.muted} />
          <span className={styles.queuedText} title={q.prompt.text}>
            {q.prompt.text || <T>Image</T>}
          </span>
          <button type="button" className={styles.bannerLink} onClick={() => void sendQueuedNow(task.id, q.id).catch(fail)}>
            <T>Send now</T>
          </button>
          <IconButton icon="edit" title="Edit" size="small" onClick={() => void editQueued(task.id, q.id).catch(fail)} />
          <IconButton icon="close" title="Remove" size="small" onClick={() => void removeQueued(task.id, q.id).catch(fail)} />
        </div>
      ))}
    </div>
  );
}

const KIND_COLOR: Partial<Record<AgentChange["kind"], string>> = {
  added: "var(--vcs-added)",
  untracked: "var(--vcs-untracked)",
  modified: "var(--vcs-modified)",
  renamed: "var(--vcs-modified)",
  deleted: "var(--vcs-deleted)",
  conflicted: "var(--vcs-conflict)",
};

function ChangesPane({ task, changes }: { task: AgentTask; changes: AgentChange[] | null }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const added = changes?.reduce((n, c) => n + c.added, 0) ?? 0;
  const removed = changes?.reduce((n, c) => n + c.removed, 0) ?? 0;
  return (
    <aside className={styles.changes} aria-label="Changes">
      <div className={styles.changesHeader}>
        <span className={styles.changesTitle}>
          <T>Changes</T>
        </span>
        {changes && changes.length > 0 && (
          <span className={styles.muted}>
            {changes.length} <T>{changes.length === 1 ? "file" : "files"}</T>
          </span>
        )}
        <span className={styles.bannerSpacer} />
        <IconButton icon="refresh" title="Refresh" size="small" onClick={() => void refreshChanges(task.id)} />
      </div>
      {task.base && (
        <div className={styles.changesSummary}>
          <T>vs</T> {task.base}
          {changes && changes.length > 0 && (
            <>
              {"  "}
              <span className={styles.added}>+{added}</span> <span className={styles.removed}>−{removed}</span>
            </>
          )}
        </div>
      )}
      <div className={styles.changesList}>
        {changes === null ? (
          <Spinner />
        ) : (
          <Tree<AgentChange>
            aria-label="Changed files"
            roots={changes}
            getKey={(c) => c.path}
            getLabel={(c) => basename(c.path)}
            getChildren={() => undefined}
            isExpandable={() => false}
            selected={selected}
            onSelectionChange={(sel) => setSelected(sel)}
            onActivate={(c) => void openChangeDiff(task, c.path)}
            renderNode={(c) => (
              <span className={styles.change} title={c.relPath}>
                <Icon name={fileIconName(basename(c.path))} size={16} />
                <span className={styles.changeName} style={{ color: KIND_COLOR[c.kind] }}>
                  {basename(c.path)}
                </span>
                <span className={styles.changeDir}>{relativeDir(task.cwd, c.path)}</span>
                <span className={styles.changeStat}>
                  <span className={styles.added}>+{c.added}</span> <span className={styles.removed}>−{c.removed}</span>
                </span>
              </span>
            )}
            empty={
              <div className={styles.changesEmpty}>
                <T>No changes yet</T>
              </div>
            }
          />
        )}
      </div>
    </aside>
  );
}

/** Opens the diff of `path` between the task's start and now. */
export async function openChangeDiff(task: AgentTask, path: string) {
  const base = await call(commands.agentBaseText(task.id, path)).catch(() => null);
  const baseLabel = task.base ?? "Base";
  const right = task.isolation === "worktree" ? branchLabel(task.branch) : "Working tree";
  await editorService().openInput(
    {
      kind: "diff",
      key: `diff:agent:${task.id}:${path}`,
      path,
      data: {
        path,
        left: { type: "text", text: base ?? "", label: baseLabel },
        right: { type: "file", path, label: right },
        title: `${basename(path)} (${baseLabel} ↔ ${right})`,
      },
    },
    { focus: true },
  );
}
