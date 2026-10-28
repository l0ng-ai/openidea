/** Agent tasks of the open project, mirrored from `ide-agent` through `agentSubscribe`. */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { create } from "zustand";
import type {
  AgentChange,
  AgentCommand,
  AgentEntry,
  AgentEvent,
  AgentProvider,
  AgentTask,
  Isolation,
} from "@/bindings";
import { call, commands, isTauri } from "@/platform/ipc";
import { editorService, notifications } from "@/workbench/contributions";
import { canSend, emptyDraft, toPrompt, type ComposerDraft, type FileRef } from "./composerModel";
import { withQuote } from "./conversation";
import { HOME_KEY, HOME_KIND, SESSION_KIND, attentionChange, entriesKey, isBusy, sessionKey, upsertEntry } from "./model";

/** New Task page settings (its text lives in the `HOME` composer). */
export interface Draft {
  provider: string;
  /** Settings chosen for the next task, by option id (reset when the agent changes). */
  config: Record<string, string>;
  isolation: Isolation;
  /** `null`: the current branch. */
  base: string | null;
}

/** Composer key of the New Task page; sessions use their task id. */
export const HOME = "home";

interface AgentsState {
  loaded: boolean;
  /** Why the tasks could not be loaded. */
  error: string | null;
  tasks: Map<string, AgentTask>;
  /** Entries of the tasks (and subagents) opened in this window, by `entriesKey`. */
  entries: Map<string, AgentEntry[]>;
  changes: Map<string, AgentChange[]>;
  providers: AgentProvider[];
  draft: Draft;
  composers: Map<string, ComposerDraft>;
  /** The composer typed in last: where "Send to Agent" adds references. */
  lastComposer: string;
  /** First messages of past tasks, newest first (New Task page ↑). */
  history: string[];
  /** The composer asked to take focus (`seq` tells repeated requests apart). */
  focus: { key: string; seq: number } | null;
}

const DRAFT_KEY = "openidea.agents.draft.v2";
const HISTORY_KEY = "openidea.agents.history.v1";
const HISTORY_SIZE = 50;

function load<T>(key: string, fallback: T): T {
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(key) ?? "null") as T | null;
    return saved ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: unknown) {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable */
  }
}

const fallbackDraft: Draft = { provider: "claude", config: {}, isolation: "worktree", base: null };

export const useAgents = create<AgentsState>(() => ({
  loaded: false,
  error: null,
  tasks: new Map(),
  entries: new Map(),
  changes: new Map(),
  providers: [],
  draft: { ...fallbackDraft, ...load<Partial<Draft>>(DRAFT_KEY, {}) },
  composers: new Map(),
  lastComposer: HOME,
  history: load<string[]>(HISTORY_KEY, []),
  focus: null,
}));

export function updateDraft(patch: Partial<Draft>) {
  const draft = { ...useAgents.getState().draft, ...patch };
  useAgents.setState({ draft });
  save(DRAFT_KEY, draft);
}

export const composerDraft = (key: string) => useAgents.getState().composers.get(key) ?? emptyDraft();

export function updateComposer(key: string, patch: Partial<ComposerDraft>) {
  useAgents.setState((s) => ({
    composers: new Map(s.composers).set(key, { ...(s.composers.get(key) ?? emptyDraft()), ...patch }),
    lastComposer: key,
  }));
}

/** Session tabs on screen; their tasks do not notify. */
const visible = new Set<string>();
export function markVisible(task: string): () => void {
  visible.add(task);
  return () => visible.delete(task);
}

let generation = 0;

/** Subscribes this window to the project's agents (again after the project changed). */
export async function connect(): Promise<void> {
  if (!isTauri()) return;
  const gen = ++generation;
  const channel = new Channel<AgentEvent>();
  channel.onmessage = (e) => {
    if (gen === generation) onEvent(e);
  };
  let tasks: AgentTask[], providers: AgentProvider[];
  try {
    [tasks, providers] = await Promise.all([call(commands.agentSubscribe(channel)), call(commands.agentProviders())]);
  } catch (e) {
    if (gen === generation) useAgents.setState({ loaded: true, error: e instanceof Error ? e.message : String(e) });
    return;
  }
  if (gen !== generation) return;
  useAgents.setState({
    loaded: true,
    error: null,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    entries: new Map(),
    changes: new Map(),
    providers,
  });
  // Restored tabs of tasks deleted meanwhile close, like editors of deleted files.
  const editors = editorService();
  for (const t of editors.openTabs?.() ?? []) {
    const task = (t.input.data as { task?: string } | undefined)?.task;
    if (t.input.kind === SESSION_KIND && task && !useAgents.getState().tasks.has(task)) editors.closeInput?.(t.input.key);
  }
}

export function disconnect() {
  generation++;
  useAgents.setState({ loaded: false, error: null, tasks: new Map(), entries: new Map(), changes: new Map() });
}

function onEvent(e: AgentEvent) {
  const s = useAgents.getState();
  switch (e.type) {
    case "task": {
      const prev = s.tasks.get(e.task.id);
      useAgents.setState({ tasks: new Map(s.tasks).set(e.task.id, e.task) });
      notifyChange(prev, e.task);
      if (prev?.status !== e.task.status && !isBusy(e.task.status)) {
        void refreshChanges(e.task.id);
        void refreshProviders();
      }
      break;
    }
    case "removed": {
      const tasks = new Map(s.tasks);
      tasks.delete(e.id);
      const composers = new Map(s.composers);
      composers.delete(e.id);
      useAgents.setState({ tasks, composers });
      editorService().closeInput?.(sessionKey(e.id));
      break;
    }
    case "entry": {
      const key = entriesKey(e.task, e.subagent);
      const current = s.entries.get(key);
      if (!current) return;
      const next = upsertEntry(current, e.index, e.entry);
      if (next) useAgents.setState({ entries: new Map(s.entries).set(key, next) });
      else void loadEntries(e.task, e.subagent);
      if (e.entry.type === "tool" && e.entry.status === "completed" && e.entry.diffs.length) {
        scheduleChanges(e.task);
      }
      break;
    }
  }
}

function notifyChange(prev: AgentTask | undefined, task: AgentTask) {
  const change = attentionChange(prev?.status, task.status);
  if (!change) return;
  if (visible.has(task.id) && document.hasFocus()) return;
  const body =
    change === "input" ? "Waiting for your answer" : change === "failed" ? (task.error ?? "The agent stopped") : "Finished";
  notifications().notify({
    level: change === "failed" ? "error" : "info",
    title: task.title,
    body,
    key: `agent:${task.id}`,
    group: "tools",
    sticky: change !== "finished",
    actions: [{ label: change === "finished" ? "Review" : "Open", run: () => openTask(task.id) }],
  });
}

/** Loads the entries of the task's conversation, or of its subagent `subagent`'s. */
export async function loadEntries(task: string, subagent: string | null = null): Promise<void> {
  const entries = await call(commands.agentEntries(task, subagent));
  useAgents.setState((s) => ({ entries: new Map(s.entries).set(entriesKey(task, subagent), entries) }));
}

export async function refreshChanges(task: string): Promise<void> {
  try {
    const changes = await call(commands.agentChanges(task));
    useAgents.setState((s) => ({ changes: new Map(s.changes).set(task, changes) }));
  } catch {
    // The worktree is gone or not a repository: nothing to list.
    useAgents.setState((s) => ({ changes: new Map(s.changes).set(task, []) }));
  }
}

const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleChanges(task: string) {
  if (pendingChanges.has(task)) return;
  pendingChanges.set(
    task,
    setTimeout(() => {
      pendingChanges.delete(task);
      void refreshChanges(task);
    }, 500),
  );
}

async function refreshProviders() {
  const providers = await call(commands.agentProviders()).catch(() => null);
  if (providers) useAgents.setState({ providers });
}

export const NO_COMMANDS: readonly AgentCommand[] = [];

/**
 * Slash commands to complete: what the agent offered (`offered`; fetched again when it
 * changes) plus, for Claude Code, the skills and custom commands on disk. Without `task`,
 * those of the project.
 */
export function useAgentCommands(
  provider: string | undefined,
  task: string | null,
  offered: readonly AgentCommand[],
): readonly AgentCommand[] {
  const [found, setFound] = useState<{ for: unknown[]; list: readonly AgentCommand[] } | null>(null);
  useEffect(() => {
    if (!provider || !isTauri()) return;
    let alive = true;
    call(commands.agentCommands(provider, task))
      .then((list) => alive && setFound({ for: [provider, task, offered], list }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [provider, task, offered]);
  // Until the list for these arguments arrives, what the agent offered.
  const current = found && found.for[0] === provider && found.for[1] === task && found.for[2] === offered;
  return current ? found.list : offered;
}

export function openTask(task: string) {
  // The title rides along so a restored tab has it before the tasks load.
  const title = useAgents.getState().tasks.get(task)?.title;
  void editorService().openInput({ kind: SESSION_KIND, key: sessionKey(task), data: { task, title } }, { focus: true });
}

/** Opens the New Task page; `prompt` pre-fills it. */
export function openHome(prompt?: string) {
  if (prompt !== undefined) updateComposer(HOME, { text: prompt });
  void editorService().openInput({ kind: HOME_KIND, key: HOME_KEY, data: {} }, { focus: true });
}

export async function startTask(): Promise<void> {
  const { draft } = useAgents.getState();
  const composer = composerDraft(HOME);
  if (!canSend(composer)) return;
  const task = await call(
    commands.agentCreate({
      prompt: toPrompt(composer),
      provider: draft.provider,
      config: Object.entries(draft.config).map(([id, value]) => ({ id, value })),
      isolation: draft.isolation,
      base: draft.isolation === "worktree" ? draft.base : null,
    }),
  );
  // Its events can arrive before this reply: keep the newer state they carried.
  useAgents.setState((s) => ({
    tasks: s.tasks.has(task.id) ? s.tasks : new Map(s.tasks).set(task.id, task),
    entries: new Map(s.entries).set(task.id, s.entries.get(task.id) ?? []),
  }));
  remember(composer.text.trim());
  updateComposer(HOME, emptyDraft());
  editorService().closeInput?.(HOME_KEY);
  openTask(task.id);
}

function remember(text: string) {
  if (!text) return;
  const history = [text, ...useAgents.getState().history.filter((h) => h !== text)].slice(0, HISTORY_SIZE);
  useAgents.setState({ history });
  save(HISTORY_KEY, history);
}

/** Sends the session composer's message: queued while the agent works, or with `now` interrupting it. */
export async function sendMessage(task: string, now: boolean): Promise<void> {
  const composer = composerDraft(task);
  if (!canSend(composer)) return;
  await call(commands.agentPrompt(task, toPrompt(composer), now));
  updateComposer(task, emptyDraft());
}

/** Moves the caret to the end of composer `key`. */
export function focusComposer(key: string) {
  useAgents.setState((s) => ({ focus: { key, seq: (s.focus?.seq ?? 0) + 1 } }));
}

/** Quotes `text` (a selection of the conversation) in the task's composer, to reply to it. */
export function quoteInComposer(task: string, text: string) {
  updateComposer(task, { text: withQuote(composerDraft(task).text, text) });
  focusComposer(task);
}

/** Puts an earlier message back into the composer to edit and send again. */
export function editMessage(task: string, text: string) {
  const current = composerDraft(task).text;
  updateComposer(task, { text: current.trim() ? `${text}\n${current}` : text });
  focusComposer(task);
}

/** Sends an earlier message again (queued while the agent works). */
export const resendMessage = (task: string, text: string) =>
  call(commands.agentPrompt(task, { text, files: [], images: [] }, false));

/** Takes a queued message back into the composer to edit it. */
export async function editQueued(task: string, queued: string): Promise<void> {
  const item = await call(commands.agentUnqueue(task, queued));
  const current = composerDraft(task);
  const cwd = useAgents.getState().tasks.get(task)?.cwd ?? "";
  const files: FileRef[] = item.prompt.files.map((path) => ({
    path,
    rel: path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path,
  }));
  updateComposer(task, {
    text: current.text ? `${item.prompt.text}\n${current.text}` : item.prompt.text,
    files: [...files, ...current.files],
    images: [...item.prompt.images, ...current.images],
  });
}

export const removeQueued = (task: string, queued: string) => call(commands.agentUnqueue(task, queued));
export const sendQueuedNow = (task: string, queued: string) => call(commands.agentSendQueuedNow(task, queued));
export const setTaskConfig = (task: string, option: string, value: string) =>
  call(commands.agentSetConfig(task, option, value));

/**
 * Adds `@file` references (with an optional line range) to the composer typed in last and
 * shows it: IDEA-style "send this to the chat".
 */
export function addReferences(refs: Array<{ path: string; rel: string; mention: string }>) {
  const s = useAgents.getState();
  const key = s.lastComposer !== HOME && s.tasks.has(s.lastComposer) ? s.lastComposer : HOME;
  const task = key === HOME ? null : s.tasks.get(key)!;
  const current = composerDraft(key);
  // A worktree task sees the same files under its own directory.
  const root = task?.isolation === "worktree" ? task.cwd : null;
  const files: FileRef[] = refs.map((r) => ({ path: root ? `${root}/${r.rel}` : r.path, rel: r.rel }));
  const mentions = refs.map((r) => r.mention).join(" ");
  const text = current.text && !/\s$/.test(current.text) ? `${current.text} ${mentions} ` : `${current.text}${mentions} `;
  updateComposer(key, { text, files: [...current.files, ...files] });
  if (task) openTask(task.id);
  else openHome();
}

/** Stops the task's turn, or with `subagent` only that subagent's work. */
export const cancelTask = (task: string, subagent: string | null = null) => call(commands.agentCancel(task, subagent));
export const respond = (task: string, permission: number, option: string | null) =>
  call(commands.agentRespond(task, permission, option));
export const archiveTask = (task: string) => call(commands.agentArchive(task));
export const deleteTask = (task: string, removeWorktree: boolean) => call(commands.agentDelete(task, removeWorktree));
