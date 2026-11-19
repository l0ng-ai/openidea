/** Agent tasks of the open project, mirrored from `ide-agent` through `agentSubscribe`. */
import { Channel } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { create } from "zustand";
import type {
  AgentAcceptOutcome,
  AgentChange,
  AgentChanges,
  AgentChangesView,
  AgentCommand,
  AgentConfigOption,
  AgentEntry,
  AgentEvent,
  AgentImage,
  AgentLimit,
  AgentModelCatalog,
  AgentPrompt,
  AgentProvider,
  AgentTask,
  ExternalSession,
  Isolation,
  RequestId,
} from "@/bindings";
import { useChangesOptions } from "./changesOptions";
import { clearAgentTaskFontZoom, resetAllAgentFontZoom } from "./fontZoom";
import { clearDismissedAssets } from "./sessionAssetsModel";
import { basename, useProject } from "@/platform/project";
import { defaultTaskProject } from "./project";
import { call, commands, isTauri, nextRequestId } from "@/platform/ipc";
import { editorService, notifications, notifyTabTitlesChanged, toolWindowService } from "@/workbench/contributions";
import { tx } from "@/platform/i18n";
import { confirm, showError } from "@/workbench/messages";
import {
  bypassDefaults,
  canSend,
  shellCommand,
  cursorModelDefaults,
  emptyDraft,
  isMentioned,
  isPerModelOption,
  mentionOf,
  referenceOf,
  toPrompt,
  withIdeContext,
  type ComposerDraft,
  type FileRef,
  type IdeContext,
} from "./composerModel";
import { withQuote } from "./conversation";
import {
  EMPTY_ORGANIZE,
  loadOrganize,
  pruneOrganize,
  saveOrganize,
  type OrganizeGroup,
  type TaskOrganize,
} from "./organize";
import {
  HOME_KEY,
  HOME_KIND,
  SESSION_KIND,
  TOOL_WINDOW,
  appendEntry,
  entriesKey,
  isBusy,
  sessionKey,
  upsertEntry,
} from "./model";

/** New Task page settings (its text lives in the `HOME` composer). */
export interface Draft {
  projectRoot?: string | null;
  provider: string;
  /** Settings chosen for the next task, by option id (reset when the agent changes). */
  config: Record<string, string>;
  /** Thinking-level choices by model value for this provider. */
  thoughtLevels?: Record<string, Record<string, string>>;
  isolation: Isolation;
  /** The user picked `isolation`: otherwise a task runs in the local checkout. */
  isolationChosen?: boolean;
  /** `null`: the current branch. */
  base: string | null;
  /** Per-session MCP server enable/disable overrides (`server_name` -> `enabled`) for the next task. */
  mcpOverrides?: Record<string, boolean>;
}

/** Composer key of the New Task page; sessions use their task id. */
export const HOME = "home";

export type SessionLocation = "editor" | "toolWindow";

interface AgentsState {
  loaded: boolean;
  /** Tasks running a `!` command from their composer. */
  shellRunning: Set<string>;
  /** Why the tasks could not be loaded. */
  error: string | null;
  tasks: Map<string, AgentTask>;
  /** Tasks with unseen replies or status changes in this project. */
  unread: Set<string>;
  /** Entries of the tasks (and subagents) opened in this window, by `entriesKey`. */
  entries: Map<string, AgentEntry[]>;
  entryLoads: Map<string, { error: string | null }>;
  changes: Map<string, AgentChange[]>;
  /** The task's uncommitted changes and commits, when the Changes pane groups by commit. */
  groupedChanges: Map<string, AgentChanges>;
  /** What the task's last turn changed, when the Changes pane shows that. */
  turnChanges: Map<string, AgentChange[]>;
  /** Scroll position and follow-output preference by conversation, shared by both hosts. */
  scrollPositions: Map<string, { top: number; stick: boolean }>;
  providers: AgentProvider[];
  modelCatalogs: Map<string, AgentModelCatalog>;
  modelRequests: Set<string>;
  /** Last New Task discovery target, so another model never inherits its error/cooldown. */
  modelRequestTargets: Map<string, string | null>;
  /** The usage limits each agent last reported for its account, by provider. */
  limits: Map<string, AgentLimit[]>;
  draft: Draft;
  composers: Map<string, ComposerDraft>;
  /** The composer typed in last: where "Send to Agent" adds references. */
  lastComposer: string;
  /** First messages of past tasks, newest first (New Task page ↑). */
  history: string[];
  /** The user's groups and pins of the tool window's list. */
  organize: TaskOrganize;
  /** Project the organize state belongs to (its storage key); null until the tasks load. */
  organizeRoot: string | null;
  /** Sessions on this machine that no task holds yet (#312). */
  external: ExternalSession[];
  /** Why the external sessions could not be listed. */
  externalError: string | null;
  /** The Import Sessions from Other Apps dialog is open. */
  importOpen: boolean;
  /** External sessions being imported (`provider:sessionId`), so none is imported twice. */
  importing: ReadonlySet<string>;
  /** The composer asked to take focus (`seq` tells repeated requests apart). */
  focus: { key: string; seq: number } | null;
  /** Task shown inside the Agents tool window instead of an editor tab. */
  docked: string | null;
  sessionLocation: SessionLocation;
  lastTask: string | null;
  homeOpen: boolean;
  pinnedModels: string[];
  /** Whether messages carry the editor's current file and selection. */
  ideContext: boolean;
}

const DRAFT_KEY = "openidea.agents.draft.v2";
const HISTORY_KEY = "openidea.agents.history.v1";
const HISTORY_SIZE = 50;
const SESSION_LOCATION_KEY = "openidea.agents.sessionLocation.v1";
const PINNED_MODELS_KEY = "openidea.agents.pinnedModels.v1";
const IDE_CONTEXT_KEY = "openidea.agents.ideContext.v1";

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

const fallbackDraft: Draft = {
  provider: "claude",
  config: {},
  isolation: "local",
  base: null,
};

/**
 * The saved New Task settings. A worktree is used only when the user picked it: drafts
 * saved before that choice was recorded carried the old default (`worktree`) instead.
 */
export function savedDraft(saved: Partial<Draft>): Draft {
  const draft = { ...fallbackDraft, ...saved };
  return draft.isolationChosen ? draft : { ...draft, isolation: "local" };
}

export const useAgents = create<AgentsState>(() => ({
  loaded: false,
  shellRunning: new Set(),
  error: null,
  tasks: new Map(),
  unread: new Set(),
  entries: new Map(),
  entryLoads: new Map(),
  changes: new Map(),
  groupedChanges: new Map(),
  turnChanges: new Map(),
  providers: [],
  limits: new Map(),
  modelCatalogs: new Map(),
  modelRequests: new Set(),
  modelRequestTargets: new Map(),
  draft: savedDraft(load<Partial<Draft>>(DRAFT_KEY, {})),
  composers: new Map(),
  lastComposer: HOME,
  history: load<string[]>(HISTORY_KEY, []),
  organize: EMPTY_ORGANIZE,
  organizeRoot: null,
  external: [],
  externalError: null,
  importOpen: false,
  importing: new Set(),
  focus: null,
  docked: null,
  sessionLocation: load<unknown>(SESSION_LOCATION_KEY, null) === "toolWindow" ? "toolWindow" : "editor",
  lastTask: null,
  homeOpen: false,
  pinnedModels: load<string[]>(PINNED_MODELS_KEY, []),
  ideContext: load<boolean>(IDE_CONTEXT_KEY, true),
  scrollPositions: new Map(),
}));

export function togglePinnedModel(modelValue: string) {
  const current = useAgents.getState().pinnedModels;
  const next = current.includes(modelValue) ? current.filter((m) => m !== modelValue) : [...current, modelValue];
  useAgents.setState({ pinnedModels: next });
  save(PINNED_MODELS_KEY, next);
}

export function updateDraft(patch: Partial<Draft>) {
  const current = useAgents.getState().draft;
  if (patch.provider && patch.provider !== current.provider) draftGeneration++;
  const draft = {
    ...current,
    ...(patch.provider && patch.provider !== current.provider ? { thoughtLevels: {} } : {}),
    ...patch,
  };
  useAgents.setState({ draft });
  save(DRAFT_KEY, draft);
}

/** What Settings › Agents says new tasks of `provider` start with, by option id. */
export const providerDefaults = (provider: string | undefined): Record<string, string> =>
  (provider && useProject.getState().settings?.agents?.defaults?.[provider]) || {};

/**
 * New Task settings use the authoritative catalog, retaining an explicitly selected
 * model even if it disappears so the user must choose its replacement.
 */
export function draftConfig(
  provider: AgentProvider | undefined,
  draft: Draft,
  defaults: Record<string, string> = providerDefaults(provider?.id),
): AgentConfigOption[] {
  const catalog = provider && useAgents.getState().modelCatalogs.get(provider.id);
  const offered = catalog?.config ?? provider?.config ?? [];
  const priorModel = provider?.config.find((o) => o.category === "model");
  const source =
    priorModel && draft.config[priorModel.id] !== undefined && !offered.some((o) => o.category === "model")
      ? [...offered, { ...priorModel, values: [] }]
      : offered;
  const config = source
    .filter((o) => !isPerModelOption(o))
    .map((o) => {
      const explicit = draft.config[o.id];
      const choice = explicit ?? defaults[o.id];
      return {
        ...o,
        defaultValue: o.defaultValue ?? o.current,
        current:
          o.category === "model" && explicit !== undefined
            ? explicit
            : choice !== undefined && o.values.some((v) => v.value === choice)
              ? choice
              : o.current,
      };
    });
  const model = config.find((o) => o.category === "model")?.current;
  if (model) {
    config.push(
      ...((catalog ?? provider)?.thoughtLevels?.[model] ?? []).map((o) => {
        const choice = draft.thoughtLevels?.[model]?.[o.id] ?? defaults[o.id];
        return {
          ...o,
          defaultValue: o.defaultValue ?? o.current,
          current: choice !== undefined && o.values.some((v) => v.value === choice) ? choice : o.current,
        };
      }),
    );
  }
  return config;
}

export function setDraftOption(id: string, value: string) {
  const { draft, providers } = useAgents.getState();
  const config = draftConfig(
    providers.find((p) => p.id === draft.provider),
    draft,
  );
  const model = config.find((o) => o.category === "model")?.current;
  const target = config.find((o) => o.id === id);
  if (model && target && isPerModelOption(target)) {
    updateDraft({
      thoughtLevels: {
        ...draft.thoughtLevels,
        [model]: { ...draft.thoughtLevels?.[model], [id]: value },
      },
    });
  } else {
    updateDraft({ config: { ...draft.config, [id]: value } });
  }
}

export const composerDraft = (key: string) => useAgents.getState().composers.get(key) ?? emptyDraft();

export function updateComposer(key: string, patch: Partial<ComposerDraft>) {
  useAgents.setState((s) => ({
    composers: new Map(s.composers).set(key, {
      ...(s.composers.get(key) ?? emptyDraft()),
      ...patch,
    }),
    lastComposer: key,
  }));
}

/** An acknowledgement consumes only the submitted revision, in the same project connection. */
function clearSubmittedComposer(key: string, submitted: ComposerDraft, started: number) {
  useAgents.setState((s) =>
    generation === started && s.composers.get(key) === submitted
      ? { composers: new Map(s.composers).set(key, emptyDraft()) }
      : s,
  );
}

/** Session tabs on screen; a task can be shown in more than one split. */
const visible = new Map<string, number>();
const windowFocused = () => document.visibilityState !== "hidden" && document.hasFocus();
const viewing = (task: string) => visible.has(task) && windowFocused();

function setUnread(task: string, value: boolean) {
  const s = useAgents.getState();
  if (s.unread.has(task) === value) return;
  const unread = new Set(s.unread);
  if (value) unread.add(task);
  else unread.delete(task);
  useAgents.setState({ unread });
}

function markUnread(task: string) {
  const current = useAgents.getState().tasks.get(task);
  if (current && current.status !== "archived" && !viewing(task) && !quietTasks.has(task)) setUnread(task, true);
}

/** Tasks the IDE runs on its own account (a generated commit message): no notifications, no unread mark. */
const quietTasks = new Set<string>();

export function runQuietly(task: string): () => void {
  quietTasks.add(task);
  setUnread(task, false);
  return () => void quietTasks.delete(task);
}

export function markVisible(task: string): () => void {
  visible.set(task, (visible.get(task) ?? 0) + 1);
  const read = () => {
    if (viewing(task)) setUnread(task, false);
  };
  read();
  window.addEventListener("focus", read);
  document.addEventListener("visibilitychange", read);
  return () => {
    const count = (visible.get(task) ?? 1) - 1;
    if (count) visible.set(task, count);
    else visible.delete(task);
    window.removeEventListener("focus", read);
    document.removeEventListener("visibilitychange", read);
  };
}

let generation = 0;
let draftGeneration = 0;
const modelFlights = new Map<string, { launch: string; generation: number; draftGeneration: number | null }>();

const selectedProvider = () => {
  const { providers, draft } = useAgents.getState();
  return providers.find((p) => p.id === draft.provider) ?? providers[0];
};

const launchKey = (provider: AgentProvider) =>
  JSON.stringify([provider.program, provider.args, provider.env, provider.installed]);

function applyModelCatalog(catalog: AgentModelCatalog) {
  useAgents.setState((s) => {
    const previous = s.modelCatalogs.get(catalog.provider);
    const model = (previous?.config ?? s.providers.find((p) => p.id === catalog.provider)?.config)?.find(
      (o) => o.category === "model",
    );
    const config =
      model && !catalog.config.some((o) => o.category === "model")
        ? [...catalog.config, { ...model, current: null, values: [] }]
        : catalog.config;
    return { modelCatalogs: new Map(s.modelCatalogs).set(catalog.provider, { ...catalog, config }) };
  });
}

/** Refresh the New Task agent, including settings for the draft's selected model. */
export async function refreshModels(
  provider = selectedProvider()?.id,
  force = true,
  model?: string | null,
): Promise<void> {
  const selected = selectedProvider();
  if (!provider || !selected?.installed || selected.id !== provider || useProject.getState().project?.trusted === false)
    return;
  model ??= draftConfig(selected, useAgents.getState().draft).find((o) => o.category === "model")?.current ?? null;
  await refreshProviderModels(selected, force, model, draftGeneration);
}

/** Discover switch candidates without using or updating the session's settings. */
export async function refreshTaskModels(id: string, force = true): Promise<void> {
  const { tasks, providers } = useAgents.getState();
  const task = tasks.get(id);
  if (!task || task.status === "archived" || !task.config.some((o) => o.category === "model")) return;
  const provider = providers.find((p) => p.id === task.provider);
  if (!provider?.installed || useProject.getState().project?.trusted === false) return;
  await refreshProviderModels(provider, force, null, null);
}

async function refreshProviderModels(
  selected: AgentProvider,
  force: boolean,
  model: string | null,
  draftGen: number | null,
): Promise<void> {
  const provider = selected.id;
  const state = useAgents.getState();
  const catalog = state.modelCatalogs.get(provider);
  const missingModelSettings =
    model !== null && !Object.hasOwn(catalog?.thoughtLevels ?? selected.thoughtLevels ?? {}, model);
  const requestTarget = state.modelRequestTargets.get(provider);
  const launch = launchKey(selected);
  const pending = modelFlights.get(provider);
  if (
    pending?.launch === launch &&
    pending.generation === generation &&
    (draftGen === null || pending.draftGeneration === null || pending.draftGeneration === draftGen)
  ) {
    // A chat joining a draft lookup still needs its result if the draft switches providers.
    if (draftGen === null) pending.draftGeneration = null;
    return;
  }
  if (
    catalog?.refreshing ||
    (force &&
      (draftGen === null ||
        requestTarget === undefined ||
        requestTarget === model ||
        (!missingModelSettings && !catalog?.error)) &&
      catalog?.retryAtMs != null &&
      catalog.retryAtMs > Date.now())
  )
    return;
  const gen = generation;
  const root = useProject.getState().project?.root;
  const flight = { launch, generation: gen, draftGeneration: draftGen };
  modelFlights.set(provider, flight);
  useAgents.setState((s) => ({
    modelRequests: new Set(s.modelRequests).add(provider),
    modelRequestTargets: new Map(s.modelRequestTargets).set(provider, model),
  }));
  const current = () => {
    const activeProvider = useAgents.getState().providers.find((p) => p.id === provider);
    return (
      gen === generation &&
      root === useProject.getState().project?.root &&
      (flight.draftGeneration === null ||
        (flight.draftGeneration === draftGeneration && selectedProvider()?.id === provider)) &&
      activeProvider !== undefined &&
      launchKey(activeProvider) === launch
    );
  };
  try {
    const result = await call(commands.agentRefreshModels(provider, force, model));
    // A streamed status/completion is newer than the snapshot returned by the command.
    if (current() && useAgents.getState().modelCatalogs.get(provider) === catalog) applyModelCatalog(result);
  } catch (e) {
    if (current() && useAgents.getState().modelCatalogs.get(provider) === catalog)
      applyModelCatalog({
        provider,
        config: catalog?.config ?? selected.config,
        thoughtLevels: catalog?.thoughtLevels ?? selected.thoughtLevels ?? {},
        refreshedAtMs: catalog?.refreshedAtMs ?? null,
        retryAtMs: catalog?.retryAtMs ?? null,
        refreshing: false,
        error: e instanceof Error ? e.message : String(e),
      });
  } finally {
    if (modelFlights.get(provider) === flight) {
      modelFlights.delete(provider);
      useAgents.setState((s) => {
        const modelRequests = new Set(s.modelRequests);
        modelRequests.delete(provider);
        return { modelRequests };
      });
    }
  }
}

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
    [tasks, providers] = await Promise.all([
      call(commands.agentSubscribe(channel)),
      useProject.getState().project?.trusted === false
        ? Promise.resolve([] as AgentProvider[])
        : call(commands.agentProviders()),
    ]);
  } catch (e) {
    if (gen === generation)
      useAgents.setState({
        loaded: true,
        error: e instanceof Error ? e.message : String(e),
      });
    return;
  }
  if (gen !== generation) return;
  const organizeRoot = useProject.getState().project?.root ?? null;
  useAgents.setState({
    loaded: true,
    error: null,
    tasks: new Map(tasks.map((t) => [t.id, t])),
    entries: new Map(),
    entryLoads: new Map(),
    changes: new Map(),
    groupedChanges: new Map(),
    turnChanges: new Map(),
    providers,
    organizeRoot,
    organize: pruneOrganize(loadOrganize(organizeRoot), tasks),
  });
  notifyTabTitlesChanged();
  // Restored tabs of tasks deleted meanwhile close, like editors of deleted files.
  const editors = editorService();
  for (const t of editors.openTabs?.() ?? []) {
    const task = (t.input.data as { task?: string } | undefined)?.task;
    if (t.input.kind === SESSION_KIND && task && !useAgents.getState().tasks.has(task))
      await editors.closeInput?.(t.input.key);
  }
}

type EntryEvent = Extract<AgentEvent, { type: "entry" | "append" }>;

/** Entry events that arrived while their conversation loaded, applied on top of the copy it loads. */
const arrivedWhileLoading = new Map<string, EntryEvent[]>();
/** Whether the message each task streams now is the agent's reply, known without its conversation. */
const streamingReply = new Map<string, { index: number; reply: boolean }>();

/** `entries` with the event applied; `null` when the copy can't take it. */
function applyEntryEvent(entries: AgentEntry[], e: EntryEvent): AgentEntry[] | null {
  if (e.type === "append") return appendEntry(entries, e.index, e.from, e.text);
  const have = entries[e.index];
  // Sent before the loaded copy was read: that copy already holds more of the message.
  if (
    have &&
    (have.type === "agent" || have.type === "thought") &&
    e.entry.type === have.type &&
    have.text.length > e.entry.text.length &&
    have.text.startsWith(e.entry.text)
  )
    return entries;
  return upsertEntry(entries, e.index, e.entry);
}

function onEntryEvent(s: AgentsState, e: EntryEvent) {
  const key = entriesKey(e.task, e.subagent);
  if (s.entryLoads.get(key)?.error === null) {
    arrivedWhileLoading.set(key, [...(arrivedWhileLoading.get(key) ?? []), e]);
    return;
  }
  const current = s.entries.get(key);
  if (!current) return;
  const next = applyEntryEvent(current, e);
  if (!next) void loadEntries(e.task, e.subagent);
  else if (next !== current) useAgents.setState({ entries: new Map(s.entries).set(key, next) });
}

const CACHED_CLOSED_TASKS = 5;

/** Recent closed-task ids kept in memory so reopening a just-closed tab avoids refetching. */
const closedTaskMru: string[] = [];
/** Bumped when a task's cache is dropped, so a fetch started before that doesn't refill it. */
const cacheDrops = new Map<string, number>();

function isTaskKey(key: string, taskId: string): boolean {
  return key === taskId || key.startsWith(`${taskId}/`);
}

function forgetClosed(taskId: string) {
  const idx = closedTaskMru.indexOf(taskId);
  if (idx >= 0) closedTaskMru.splice(idx, 1);
}

function clearTaskMaps(taskId: string, clearStreaming = false) {
  forgetClosed(taskId);
  for (const key of [...arrivedWhileLoading.keys()]) {
    if (isTaskKey(key, taskId)) arrivedWhileLoading.delete(key);
  }
  // Mounted streams write into this map directly, so it is pruned in place rather than replaced.
  const positions = useAgents.getState().scrollPositions;
  for (const key of [...positions.keys()]) {
    if (isTaskKey(key, taskId)) positions.delete(key);
  }
  if (clearStreaming) streamingReply.delete(taskId);
  const timer = pendingChanges.get(taskId);
  if (timer !== undefined) {
    clearTimeout(timer);
    pendingChanges.delete(taskId);
  }
}

function withoutTaskCache(s: AgentsState, taskId: string): Partial<AgentsState> | null {
  let entries: Map<string, AgentEntry[]> | undefined;
  for (const key of s.entries.keys()) {
    if (isTaskKey(key, taskId)) (entries ??= new Map(s.entries)).delete(key);
  }
  let entryLoads: Map<string, { error: string | null }> | undefined;
  for (const key of s.entryLoads.keys()) {
    if (isTaskKey(key, taskId)) (entryLoads ??= new Map(s.entryLoads)).delete(key);
  }
  let changes: Map<string, AgentChange[]> | undefined;
  if (s.changes.has(taskId)) {
    changes = new Map(s.changes);
    changes.delete(taskId);
  }
  let groupedChanges: Map<string, AgentChanges> | undefined;
  if (s.groupedChanges.has(taskId)) {
    groupedChanges = new Map(s.groupedChanges);
    groupedChanges.delete(taskId);
  }
  let turnChanges: Map<string, AgentChange[]> | undefined;
  if (s.turnChanges.has(taskId)) {
    turnChanges = new Map(s.turnChanges);
    turnChanges.delete(taskId);
  }
  if (!entries && !entryLoads && !changes && !groupedChanges && !turnChanges) return null;
  return {
    ...(entries ? { entries } : {}),
    ...(entryLoads ? { entryLoads } : {}),
    ...(changes ? { changes } : {}),
    ...(groupedChanges ? { groupedChanges } : {}),
    ...(turnChanges ? { turnChanges } : {}),
  };
}

function dropTaskCache(taskId: string) {
  clearTaskMaps(taskId);
  // A deleted task needs no marker: fetches already discard results for tasks that are gone.
  if (useAgents.getState().tasks.has(taskId)) cacheDrops.set(taskId, (cacheDrops.get(taskId) ?? 0) + 1);
  useAgents.setState((s) => withoutTaskCache(s, taskId) ?? s);
}

function isTaskOpenInUi(taskId: string): boolean {
  if (useAgents.getState().docked === taskId) return true;
  return (editorService().openTabs?.() ?? []).some(
    (t) => t.input.kind === SESSION_KIND && (t.input.data as { task?: string } | undefined)?.task === taskId,
  );
}

/** Whether a background trigger should reload a task's changes: only while they are shown or still cached. */
function wantsChanges(taskId: string): boolean {
  const s = useAgents.getState();
  return s.changes.has(taskId) || s.groupedChanges.has(taskId) || s.turnChanges.has(taskId) || isTaskOpenInUi(taskId);
}

/**
 * Releases cached conversation data for a closed or un-docked session once more than
 * `CACHED_CLOSED_TASKS` closed tasks have been retained. Archived and deleted tasks are
 * dropped immediately; other tasks stay in a small MRU cache so reopening is instant.
 */
export function releaseClosedTaskCache(taskId: string) {
  if (!taskId || isTaskOpenInUi(taskId)) return;
  const task = useAgents.getState().tasks.get(taskId);
  if (!task || task.status === "archived") {
    dropTaskCache(taskId);
    return;
  }
  forgetClosed(taskId);
  closedTaskMru.push(taskId);
  while (closedTaskMru.length > CACHED_CLOSED_TASKS) {
    const oldest = closedTaskMru.shift()!;
    if (!isTaskOpenInUi(oldest)) dropTaskCache(oldest);
  }
}

export function disconnect() {
  generation++;
  arrivedWhileLoading.clear();
  streamingReply.clear();
  modelFlights.clear();
  closedTaskMru.length = 0;
  cacheDrops.clear();
  for (const timer of pendingChanges.values()) clearTimeout(timer);
  pendingChanges.clear();
  resetAllAgentFontZoom();
  useAgents.setState({
    loaded: false,
    error: null,
    tasks: new Map(),
    unread: new Set(),
    entries: new Map(),
    entryLoads: new Map(),
    changes: new Map(),
    groupedChanges: new Map(),
    turnChanges: new Map(),
    modelCatalogs: new Map(),
    modelRequests: new Set(),
    modelRequestTargets: new Map(),
    organize: EMPTY_ORGANIZE,
    organizeRoot: null,
    docked: null,
    lastTask: null,
    homeOpen: false,
    external: [],
    externalError: null,
    importOpen: false,
    importing: new Set(),
    scrollPositions: new Map(),
  });
}

function onEvent(e: AgentEvent) {
  const s = useAgents.getState();
  switch (e.type) {
    case "task": {
      const prev = s.tasks.get(e.task.id);
      useAgents.setState({ tasks: new Map(s.tasks).set(e.task.id, e.task) });
      if (prev && (prev.title !== e.task.title || prev.status !== e.task.status)) notifyTabTitlesChanged();
      if (e.task.status === "archived") {
        setUnread(e.task.id, false);
        if (prev?.status !== "archived" && !isTaskOpenInUi(e.task.id)) dropTaskCache(e.task.id);
      }
      if (prev?.status !== e.task.status && !isBusy(e.task.status) && e.task.status !== "archived") {
        if (wantsChanges(e.task.id)) void refreshChanges(e.task.id);
        void refreshProviders();
      }
      break;
    }
    case "attention": {
      markUnread(e.task);
      notifyAttention(e.task, e.reason);
      break;
    }
    case "removed": {
      clearTaskMaps(e.id, true);
      cacheDrops.delete(e.id);
      const tasks = new Map(s.tasks);
      tasks.delete(e.id);
      const composers = new Map(s.composers);
      composers.delete(e.id);
      const unread = new Set(s.unread);
      unread.delete(e.id);
      // A deleted task leaves its group and the pinned area.
      const organize = pruneOrganize(s.organize, tasks.values());
      if (organize !== s.organize) saveOrganize(s.organizeRoot, organize);
      useAgents.setState({
        tasks,
        composers,
        unread,
        ...withoutTaskCache(s, e.id),
        organize,
        ...(s.docked === e.id ? { docked: null } : {}),
      });
      clearAgentTaskFontZoom(sessionKey(e.id));
      clearDismissedAssets(e.id);
      void editorService().closeInput?.(sessionKey(e.id));
      break;
    }
    case "truncated": {
      const current = s.entries.get(e.task);
      if (current)
        useAgents.setState({
          entries: new Map(s.entries).set(e.task, current.slice(0, e.length)),
        });
      scheduleChanges(e.task);
      break;
    }
    case "modelCatalog": {
      if (s.providers.some((p) => p.id === e.catalog.provider)) applyModelCatalog(e.catalog);
      break;
    }
    case "providers": {
      void refreshProviders();
      break;
    }
    case "limits": {
      useAgents.setState({
        limits: new Map(s.limits).set(e.provider, e.limits),
      });
      break;
    }
    case "entry": {
      if (
        !e.subagent &&
        ((e.entry.type === "agent" && e.entry.text.trim()) ||
          e.entry.type === "error" ||
          (e.entry.type === "permission" && e.entry.chosen === null))
      ) {
        markUnread(e.task);
      }
      if (!e.subagent) streamingReply.set(e.task, { index: e.index, reply: e.entry.type === "agent" });
      onEntryEvent(s, e);
      if (e.entry.type === "tool" && e.entry.status === "completed" && e.entry.diffs.length) {
        scheduleChanges(e.task);
      }
      break;
    }
    case "append": {
      if (!e.subagent && e.text.trim()) {
        const shown = s.entries.get(entriesKey(e.task, null))?.[e.index];
        const streaming = streamingReply.get(e.task);
        if (shown ? shown.type === "agent" : streaming?.index === e.index && streaming.reply) markUnread(e.task);
      }
      onEntryEvent(s, e);
      break;
    }
  }
}

/** In-app balloon for an Attention event; OS delivery goes through the general balloon path. */
function notifyAttention(taskId: string, reason: "finished" | "input" | "failed") {
  if (viewing(taskId) || quietTasks.has(taskId)) return;
  const task = useAgents.getState().tasks.get(taskId);
  const title = task?.title ?? "Agent";
  const body =
    reason === "input"
      ? "Waiting for your answer"
      : reason === "failed"
        ? (task?.error ?? "The agent stopped")
        : "Finished";
  notifications().notify({
    level: reason === "failed" ? "error" : "info",
    title,
    body,
    key: `agent:${taskId}`,
    group: "tools",
    sticky: reason !== "finished",
    actions: [
      {
        label: reason === "finished" ? "Review" : "Open",
        run: () => openTask(taskId),
      },
    ],
  });
}

/** Loads the entries of the task's conversation, or of its subagent `subagent`'s. */
export async function loadEntries(task: string, subagent: string | null = null): Promise<void> {
  const key = entriesKey(task, subagent);
  if (useAgents.getState().entryLoads.get(key)?.error === null) return;
  const load = { error: null };
  useAgents.setState((s) => ({
    entryLoads: new Map(s.entryLoads).set(key, load),
  }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const entries = await Promise.race([
      call(commands.agentEntries(task, subagent)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(tx("Loading the conversation timed out. Try again."))), 35_000);
      }),
    ]);
    if (useAgents.getState().entryLoads.get(key) !== load) return;
    let loaded = entries;
    for (const event of arrivedWhileLoading.get(key) ?? []) loaded = applyEntryEvent(loaded, event) ?? loaded;
    arrivedWhileLoading.delete(key);
    useAgents.setState((s) => {
      const entryLoads = new Map(s.entryLoads);
      entryLoads.delete(key);
      return { entries: new Map(s.entries).set(key, loaded), entryLoads };
    });
  } catch (e) {
    if (useAgents.getState().entryLoads.get(key) !== load) return;
    arrivedWhileLoading.delete(key);
    const error = (e instanceof Error ? e.message : String(e)).trim() || tx("Unknown error");
    useAgents.setState((s) => ({
      entryLoads: new Map(s.entryLoads).set(key, { error }),
    }));
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshChanges(task: string): Promise<void> {
  // Discard a result that arrives after a project switch, the task's deletion, or its cache being dropped.
  const gen = generation;
  const drops = cacheDrops.get(task);
  const stillWanted = () =>
    gen === generation && useAgents.getState().tasks.has(task) && cacheDrops.get(task) === drops;
  // The whole task's changes are read in either scope: the session's summary counts them.
  await Promise.all([
    refreshTaskChanges(task, stillWanted),
    useChangesOptions.getState().scope === "turn" && refreshTurnChanges(task, stillWanted),
  ]);
}

async function refreshTurnChanges(task: string, stillWanted: () => boolean): Promise<void> {
  const changes = await call(commands.agentChanges(task, "lastTurn")).catch(() => []);
  if (!stillWanted()) return;
  useAgents.setState((s) => ({ turnChanges: new Map(s.turnChanges).set(task, changes) }));
}

async function refreshTaskChanges(task: string, stillWanted: () => boolean): Promise<void> {
  // Local tasks have no commits of their own to group: the flat list is their only view.
  const grouped =
    useChangesOptions.getState().groupByCommit && useAgents.getState().tasks.get(task)?.isolation === "worktree";
  if (grouped) {
    try {
      const review = await call(commands.agentGroupedChanges(task));
      if (!stillWanted()) return;
      useAgents.setState((s) => ({
        groupedChanges: new Map(s.groupedChanges).set(task, review),
      }));
    } catch {
      if (!stillWanted()) return;
      // The worktree is gone or not a repository: nothing to list.
      useAgents.setState((s) => ({
        groupedChanges: new Map(s.groupedChanges).set(task, { uncommitted: [], commits: [] }),
      }));
    }
    return;
  }
  try {
    const changes = await call(commands.agentChanges(task, null));
    if (!stillWanted()) return;
    useAgents.setState((s) => ({
      changes: new Map(s.changes).set(task, changes),
    }));
  } catch {
    if (!stillWanted()) return;
    // The worktree is gone or not a repository: nothing to list.
    useAgents.setState((s) => ({ changes: new Map(s.changes).set(task, []) }));
  }
}

/** Rollback: the task's changed files `relPaths` (all with `null`) back as `view` compares them. */
export async function rollbackChanges(
  task: string,
  relPaths: string[] | null,
  view: AgentChangesView = "sinceStart",
): Promise<void> {
  try {
    await call(commands.agentRollbackChanges(task, relPaths, view));
  } finally {
    await refreshChanges(task);
  }
}

/** Copies a worktree task's changed files into the local checkout, uncommitted. */
export async function acceptChanges(task: string, relPaths: string[] | null): Promise<AgentAcceptOutcome> {
  try {
    return await call(commands.agentAcceptChanges(task, relPaths));
  } finally {
    await refreshChanges(task);
  }
}

const pendingChanges = new Map<string, ReturnType<typeof setTimeout>>();
/** Reloads the task's changes after a short pause (tool diffs, commits landing). */
export function scheduleChanges(task: string) {
  if (pendingChanges.has(task)) return;
  pendingChanges.set(
    task,
    setTimeout(() => {
      pendingChanges.delete(task);
      if (wantsChanges(task)) void refreshChanges(task);
    }, 500),
  );
}

/** Reloads the agent list (custom and registry agents are re-read). */
export async function refreshProviders() {
  const gen = generation;
  const root = useProject.getState().project?.root;
  const providers = await call(commands.agentProviders()).catch(() => null);
  if (!providers || gen !== generation || root !== useProject.getState().project?.root) return;
  useAgents.setState((s) => {
    const modelCatalogs = new Map(s.modelCatalogs);
    const modelRequestTargets = new Map(s.modelRequestTargets);
    for (const [id] of modelCatalogs) {
      const previous = s.providers.find((p) => p.id === id);
      const provider = providers.find((p) => p.id === id);
      if (!provider || (previous && launchKey(previous) !== launchKey(provider))) {
        modelCatalogs.delete(id);
        modelRequestTargets.delete(id);
      }
    }
    return { providers, modelCatalogs, modelRequestTargets };
  });
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
  const [found, setFound] = useState<{
    for: unknown[];
    list: readonly AgentCommand[];
  } | null>(null);
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
  forgetClosed(task);
  if (useAgents.getState().sessionLocation === "toolWindow") {
    showDockedTask(task);
    return;
  }
  useAgents.setState({ lastTask: task, homeOpen: false, lastComposer: task });
  openTaskInEditor(task);
}

function openTaskInEditor(task: string) {
  // The title rides along so a restored tab has it before the tasks load.
  const title = useAgents.getState().tasks.get(task)?.title;
  void editorService().openInput({ kind: SESSION_KIND, key: sessionKey(task), data: { task, title } }, { focus: true });
}

function showDockedTask(task: string) {
  const previousDocked = useAgents.getState().docked;
  useAgents.setState({
    docked: task,
    lastTask: task,
    homeOpen: false,
    lastComposer: task,
  });
  if (previousDocked && previousDocked !== task) releaseClosedTaskCache(previousDocked);
  toolWindowService().show(TOOL_WINDOW, true);
  void editorService().closeInput?.(sessionKey(task));
}

function saveSessionLocation(location: SessionLocation) {
  useAgents.setState({ sessionLocation: location });
  save(SESSION_LOCATION_KEY, location);
  if (location === "toolWindow") {
    for (const { input } of editorService().openTabs?.() ?? []) {
      if (input.kind === SESSION_KIND || input.kind === HOME_KIND) void editorService().closeInput?.(input.key);
    }
  }
}

/** Conversation placement is an Agents-wide preference, shared by every task. */
export function setSessionLocation(location: SessionLocation) {
  const s = useAgents.getState();
  if (s.sessionLocation === location) return;
  const active = editorService().activeInput?.();
  const activeTask = active?.kind === SESSION_KIND ? (active.data as { task: string }).task : null;
  const home = s.homeOpen || active?.kind === HOME_KIND;
  const task =
    s.docked ??
    activeTask ??
    (s.lastTask && s.tasks.has(s.lastTask) ? s.lastTask : null) ??
    [...s.tasks.values()]
      .filter((t) => t.status !== "archived")
      .sort((a, b) => (b.updatedMs ?? b.createdMs ?? 0) - (a.updatedMs ?? a.createdMs ?? 0))[0]?.id;
  const previousDocked = s.docked;
  saveSessionLocation(location);
  useAgents.setState({ docked: null, homeOpen: false });
  // The docked task itself reopens in the new location unless the New Task page takes its place.
  if (previousDocked && (home || previousDocked !== task)) releaseClosedTaskCache(previousDocked);
  if (home) {
    openHome();
  } else if (task) {
    openTask(task);
  } else if (location === "toolWindow") {
    openHome();
  }
}

/** Dragging a session into the tool window selects the same placement for other tasks. */
export function dockTask(task: string) {
  saveSessionLocation("toolWindow");
  showDockedTask(task);
}

export function undockTask() {
  setSessionLocation("editor");
}

/** An explicit editor drop also updates where subsequent sessions open. */
export function openTaskInEditorLocation(task: string) {
  const previousDocked = useAgents.getState().docked;
  saveSessionLocation("editor");
  useAgents.setState({ docked: null, homeOpen: false });
  if (previousDocked && previousDocked !== task) releaseClosedTaskCache(previousDocked);
  openTask(task);
}

/**
 * Closes the agent task tab that is active in the editor; the task keeps running and stays in the
 * Agents tool window. `null` when the active tab isn't an agent task, `false` when closing was cancelled.
 */
export function closeActiveTask(): Promise<boolean> | null {
  const active = editorService().activeInput?.();
  if (active?.kind !== SESSION_KIND) return null;
  return editorService().closeInput?.(active.key) ?? Promise.resolve(false);
}

/** Close Agent Task, then the New Task page, unless closing was cancelled. */
export async function closeAndNewTask() {
  if ((await closeActiveTask()) === false) return;
  openHome();
}

/** Opens the New Task page; `prompt` pre-fills it. */
export function openHome(prompt?: string) {
  const project = useProject.getState().project;
  useAgents.setState({ lastComposer: HOME });
  if (project?.workspace) {
    const previous = useAgents.getState().draft.projectRoot;
    const projectRoot = defaultTaskProject(project, editorService().activePath(), previous);
    updateDraft({
      projectRoot,
      ...(projectRoot !== previous ? { base: null } : {}),
    });
  }
  if (prompt !== undefined) updateComposer(HOME, { text: prompt });
  if (useAgents.getState().sessionLocation === "toolWindow") {
    const previousDocked = useAgents.getState().docked;
    useAgents.setState({ docked: null, homeOpen: true });
    if (previousDocked) releaseClosedTaskCache(previousDocked);
    toolWindowService().show(TOOL_WINDOW, true);
    void editorService().closeInput?.(HOME_KEY);
    return;
  }
  void editorService().openInput({ kind: HOME_KIND, key: HOME_KEY, data: {} }, { focus: true });
}

/** `isolation` overrides the draft's (a project without git can only use the local checkout). */
export async function startTask(
  isolation: Isolation = useAgents.getState().draft.isolation,
  projectRoot: string | null = null,
): Promise<void> {
  const { draft, providers } = useAgents.getState();
  const composer = composerDraft(HOME);
  if (!canSend(composer)) return;
  const started = generation;
  const command = shellCommand(composer);
  const options = draftConfig(
    providers.find((p) => p.id === draft.provider),
    draft,
  );
  if (
    options.some(
      (o) =>
        o.category === "model" &&
        draft.config[o.id] !== undefined &&
        !o.values.some((v) => v.value === draft.config[o.id]),
    )
  )
    return;
  const askForApprovals = useProject.getState().settings?.agents?.newTaskApprovals === "ask";
  const defaults = {
    ...cursorModelDefaults(draft.provider, options),
    ...(askForApprovals ? {} : bypassDefaults(options)),
    ...providerDefaults(draft.provider),
  };
  const config = options.flatMap((o) => {
    const value =
      o.category === "model" || isPerModelOption(o) ? o.current : (draft.config[o.id] ?? defaults[o.id] ?? null);
    return value !== null && o.values.some((v) => v.value === value) ? [{ id: o.id, value }] : [];
  });
  try {
    const task = await call(
      commands.agentCreate({
        projectRoot,
        prompt: promptOf(HOME, composer),
        provider: draft.provider,
        config,
        isolation,
        base: isolation === "worktree" ? draft.base : null,
        mcpOverrides: draft.mcpOverrides ?? {},
        // A `!` command runs in the new task before the agent hears anything.
        idle: command !== null,
      }),
    );
    if (generation !== started) return;
    // Its events can arrive before this reply: keep the newer state they carried.
    useAgents.setState((s) => ({
      tasks: s.tasks.has(task.id) ? s.tasks : new Map(s.tasks).set(task.id, task),
      entries: new Map(s.entries).set(task.id, s.entries.get(task.id) ?? []),
    }));
    updateDraft({ projectRoot });
    remember(composer.text.trim());
    clearSubmittedComposer(HOME, composer, started);
    const closed = await editorService().closeInput?.(HOME_KEY);
    if (generation === started && closed !== false) openTask(task.id);
    if (command !== null && generation === started)
      void execShell(task.id, command).catch((e: unknown) =>
        notifications().notify({ level: "error", title: "Couldn't send the message", body: String(e) }),
      );
  } catch (e) {
    if (generation === started) throw e;
  }
}

/** Sessions on this machine that no task holds yet (a terminal, another editor: #312). */
export async function refreshExternalSessions() {
  const started = generation;
  try {
    const external = await call(commands.agentExternalSessions());
    if (generation === started) useAgents.setState({ external, externalError: null });
  } catch (e) {
    if (generation === started) useAgents.setState({ externalError: e instanceof Error ? e.message : String(e) });
  }
}

export const showImportSessions = () => useAgents.setState({ importOpen: true });
export const hideImportSessions = () => useAgents.setState({ importOpen: false });

export const externalKey = (provider: string, sessionId: string) => `${provider}:${sessionId}`;

function markImporting(keys: readonly string[], on: boolean) {
  useAgents.setState((s) => {
    const importing = new Set(s.importing);
    for (const key of keys) {
      if (on) importing.add(key);
      else importing.delete(key);
    }
    return { importing };
  });
}

async function importOne(provider: string, sessionId: string, open: boolean) {
  const started = generation;
  const task = await call(commands.agentImportSession(provider, sessionId));
  if (generation !== started) return task;
  useAgents.setState((s) => ({
    tasks: s.tasks.has(task.id) ? s.tasks : new Map(s.tasks).set(task.id, task),
    external: s.external.filter((e) => !(e.provider === provider && e.sessionId === sessionId)),
  }));
  if (open) openTask(task.id);
  return task;
}

/** Imports an external session as a task and opens it: its first turn loads it (#312). */
export async function importExternalSession(provider: string, sessionId: string) {
  const key = externalKey(provider, sessionId);
  if (useAgents.getState().importing.has(key)) throw new Error(tx("Already importing"));
  markImporting([key], true);
  try {
    return await importOne(provider, sessionId, true);
  } finally {
    markImporting([key], false);
  }
}

/**
 * Imports sessions one after another, all marked pending from the start; only a single one opens.
 * Sessions already being imported are skipped. Failures don't stop the rest and are reported
 * together at the end. A project switch ends the batch; an abort ends it after the import in
 * flight and frees the sessions it didn't reach.
 */
export async function importExternalSessions(
  sessions: readonly { provider: string; sessionId: string; title: string }[],
  onProgress?: (done: number) => void,
  signal?: AbortSignal,
) {
  const pending = useAgents.getState().importing;
  const batch = sessions.filter((s) => !pending.has(externalKey(s.provider, s.sessionId)));
  const keys = batch.map((s) => externalKey(s.provider, s.sessionId));
  markImporting(keys, true);
  const started = generation;
  const failures: string[] = [];
  let done = 0;
  for (const s of batch) {
    if (generation !== started) return;
    if (signal?.aborted) {
      markImporting(keys.slice(done), false);
      break;
    }
    try {
      await importOne(s.provider, s.sessionId, batch.length === 1);
    } catch (e) {
      failures.push(`${s.title}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (generation === started) markImporting([externalKey(s.provider, s.sessionId)], false);
    }
    onProgress?.(++done);
  }
  if (generation !== started || !failures.length) return;
  // Not awaited, so the caller's dialog closes instead of waiting behind the message.
  const title =
    failures.length === 1 ? tx("A session could not be imported") : tx("Some sessions could not be imported");
  void showError(title, failures.join("\n"));
}

export function setIdeContext(on: boolean) {
  useAgents.setState({ ideContext: on });
  save(IDE_CONTEXT_KEY, on);
}

/** The IDE context of each mounted composer, by draft key. */
const ideContexts = new Map<string, () => IdeContext | null>();

/** Registers what composer `key` sends as IDE context; returns the unregister. */
export function provideIdeContext(key: string, context: () => IdeContext | null): () => void {
  ideContexts.set(key, context);
  return () => {
    if (ideContexts.get(key) === context) ideContexts.delete(key);
  };
}

/** The prompt of composer `key`, with the IDE context when it is on. */
function promptOf(key: string, composer: ComposerDraft): AgentPrompt {
  const context = useAgents.getState().ideContext ? (ideContexts.get(key)?.() ?? null) : null;
  return toPrompt(withIdeContext(composer, context));
}

function remember(text: string) {
  if (!text) return;
  const history = [text, ...useAgents.getState().history.filter((h) => h !== text)].slice(0, HISTORY_SIZE);
  useAgents.setState({ history });
  save(HISTORY_KEY, history);
}

/** The `!` commands running per task, so Stop ends them. */
const shellRuns = new Map<string, Set<RequestId>>();

function trackShell(task: string, request: RequestId, running: boolean) {
  const runs = shellRuns.get(task) ?? new Set<RequestId>();
  if (running) runs.add(request);
  else runs.delete(request);
  if (runs.size) shellRuns.set(task, runs);
  else shellRuns.delete(task);
  useAgents.setState((s) => {
    const shellRunning = new Set(s.shellRunning);
    if (runs.size) shellRunning.add(task);
    else shellRunning.delete(task);
    return { shellRunning };
  });
}

/** Runs a `!` line in the task's folder; its output reaches the agent with the next message. */
async function runShell(task: string, composer: ComposerDraft, command: string) {
  clearSubmittedComposer(task, composer, generation);
  remember(`!${command}`);
  await execShell(task, command);
}

async function execShell(task: string, command: string) {
  const request = nextRequestId();
  trackShell(task, request, true);
  try {
    await call(commands.agentShell(task, command, request));
  } finally {
    trackShell(task, request, false);
  }
}

/** Stops the task's turn and the `!` commands it runs. */
export async function stopTask(task: string): Promise<void> {
  for (const request of shellRuns.get(task) ?? []) void commands.cancelRequest(request);
  if (isBusy(useAgents.getState().tasks.get(task)?.status ?? "ready")) await cancelTask(task);
}

/** Sends the session composer's message: queued while the agent works, or with `now` interrupting it. */
export async function sendMessage(task: string, now: boolean): Promise<void> {
  const composer = composerDraft(task);
  if (!canSend(composer)) return;
  const command = shellCommand(composer);
  if (command !== null) return runShell(task, composer, command);
  const started = generation;
  await call(commands.agentPrompt(task, promptOf(task, composer), now));
  clearSubmittedComposer(task, composer, started);
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

/** Copies the task's conversation into a new task (up to its first `turns` turns) and opens it. */
export async function forkTask(task: string, turns: number | null): Promise<void> {
  const started = generation;
  try {
    const copy = await call(commands.agentFork(task, turns));
    if (generation !== started) return;
    useAgents.setState((s) => ({
      tasks: s.tasks.has(copy.id) ? s.tasks : new Map(s.tasks).set(copy.id, copy),
    }));
    openTask(copy.id);
  } catch (e) {
    if (generation === started) throw e;
  }
}

/** Puts a message back in the task's composer, above anything typed meanwhile. */
function restoreComposer(task: string, text: string, images: AgentImage[]) {
  const current = composerDraft(task);
  updateComposer(task, {
    text: current.text ? `${text}\n${current.text}` : text,
    images: [...images, ...current.images],
  });
  focusComposer(task);
}

/** Waits until a running turn has stopped, so it can be dropped. */
async function stopForEdit(task: string) {
  const busy = () => isBusy(useAgents.getState().tasks.get(task)?.status ?? "ready");
  if (!busy()) return;
  await cancelTask(task);
  await settled(task);
  if (busy()) throw new Error(tx("The agent is still stopping. Try again once it has stopped."));
}

/**
 * Runs the conversation again from turn `turn` with `text` as its message: the agent is
 * stopped if it works, that turn and the later ones are dropped, then `text` is sent.
 * Whatever fails, the message is kept in the composer so it can be sent again.
 */
export async function rerunFrom(task: string, turn: number, text: string, images: AgentImage[] = []): Promise<boolean> {
  if (
    turn === 0 &&
    !(await confirm({
      title: "Start a Fresh Agent Session",
      message:
        "This clears the entire conversation and starts a fresh agent session with this message. Files the agent changed stay as they are.",
      ok: "Start Fresh",
      icon: "warning",
    }))
  )
    return false;
  try {
    await stopForEdit(task);
    await call(commands.agentRollback(task, turn));
    await call(commands.agentPrompt(task, { text, files: [], images }, false));
  } catch (e) {
    restoreComposer(task, text, images);
    throw e;
  }
  return true;
}

/** Drops `turn` and the later turns, and puts the message back in the composer to edit. */
export async function retractFrom(task: string, turn: number, text: string, images: AgentImage[] = []): Promise<void> {
  try {
    await stopForEdit(task);
    const prompt = await call(commands.agentRollback(task, turn));
    // The agent only hands back the text; the images come from the message itself.
    restoreComposer(task, prompt?.text ?? text, images);
  } catch (e) {
    restoreComposer(task, text, images);
    throw e;
  }
}

/** Resolves once the task's turn has ended (or after a while). */
function settled(task: string, timeoutMs = 15_000): Promise<void> {
  const done = () => !isBusy(useAgents.getState().tasks.get(task)?.status ?? "ready");
  if (done()) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      stop();
      clearTimeout(timer);
      resolve();
    };
    const stop = useAgents.subscribe(() => done() && finish());
    const timer = setTimeout(finish, timeoutMs);
  });
}

/** Sends an earlier message again (queued while the agent works). */
export const resendMessage = (task: string, text: string) =>
  call(commands.agentPrompt(task, { text, files: [], images: [] }, false));

/** Takes a queued message back into the composer to edit it. */
export async function editQueued(task: string, queued: string): Promise<void> {
  const item = await call(commands.agentUnqueue(task, queued));
  const current = composerDraft(task);
  const cwd = useAgents.getState().tasks.get(task)?.cwd ?? "";
  const files: FileRef[] = item.prompt.files.map((path) => {
    const rel = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
    return isMentioned(item.prompt.text, rel) ? { path, rel } : { path, rel: basename(path), attached: true };
  });
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

export function setDraftMcpOverrides(mcpOverrides: Record<string, boolean>) {
  updateDraft({ mcpOverrides });
}

export async function setTaskMcpOverrides(task: string, overrides: Record<string, boolean>): Promise<void> {
  const prev = useAgents.getState().tasks.get(task);
  if (prev) {
    useAgents.setState((s) => ({
      tasks: new Map(s.tasks).set(task, { ...prev, mcpOverrides: overrides }),
    }));
  }
  const updated = await call(commands.agentSetMcpOverrides(task, overrides));
  useAgents.setState((s) => ({
    tasks: new Map(s.tasks).set(task, updated),
  }));
}

/** The composer the user is looking at: the Agents surface on show, else the one typed in last. */
function activeComposerKey(): string {
  const s = useAgents.getState();
  // The tool window shows one conversation at a time; its inline New Task page wins.
  if (s.sessionLocation === "toolWindow") {
    if (s.homeOpen) return HOME;
    if (s.docked && s.tasks.has(s.docked)) return s.docked;
  }
  const active = editorService().activeInput?.();
  if (active?.kind === HOME_KIND) return HOME;
  if (active?.kind === SESSION_KIND) {
    const task = (active.data as { task?: unknown } | undefined)?.task;
    if (typeof task === "string" && s.tasks.has(task)) return task;
  }
  // No agent tab has focus (the Project view has it): the one used last wins.
  for (const tab of editorService().openTabs?.() ?? []) {
    if (tab.input.kind === HOME_KIND) return HOME;
    if (tab.input.kind === SESSION_KIND) {
      const task = (tab.input.data as { task?: unknown } | undefined)?.task;
      if (typeof task === "string" && s.tasks.has(task)) return task;
    }
  }
  return s.lastComposer !== HOME && s.tasks.has(s.lastComposer) ? s.lastComposer : HOME;
}

/** The project a New Task started now would run in (the New Task page's project picker). */
export function homeProjectRoot(): string | null {
  const project = useProject.getState().project;
  const members = project?.workspace?.projects ?? [];
  const last = useAgents.getState().draft.projectRoot;
  return last && members.includes(last) ? last : (members[0] ?? project?.root ?? null);
}

/** A file or folder (trailing slash) to reference, with the lines meant. */
export interface ReferenceTarget {
  path: string;
  lines?: { from: number; to: number };
}

/**
 * Adds `@file` references (with an optional line range) to the composer on show (else the one
 * typed in last) and shows it: IDEA-style "send this to the chat". Paths resolve like the
 * composer's own drops: inside the task's folder, or named by their workspace project. Returns
 * how many were added; a path outside every project shows a notice.
 */
export function addReferences(targets: readonly ReferenceTarget[]): number {
  const s = useAgents.getState();
  const key = activeComposerKey();
  const task = key === HOME ? null : s.tasks.get(key)!;
  const project = useProject.getState().project;
  const root = task ? task.cwd : homeProjectRoot();
  const roots = {
    root: root ?? "",
    projectRoot: (task ? (task.projectRoot ?? project?.root) : null) ?? root ?? "",
    members: project?.workspace?.projects,
  };
  const current = composerDraft(key);
  const files: FileRef[] = [];
  const mentions: string[] = [];
  for (const { path, lines } of targets) {
    const ref = root ? referenceOf(roots, path) : null;
    if (!ref) continue;
    // A folder keeps its trailing slash, so its chip is a folder reference.
    const rel = /[\\/]$/.test(path) && ref.rel !== "." ? `${ref.rel}/` : ref.rel;
    files.push({ path: ref.path, rel });
    mentions.push(mentionOf(rel, lines));
  }
  if (files.length < targets.length)
    notifications().notify({ level: "info", title: tx("Only files of this window's projects can be referenced") });
  if (!files.length) return 0;
  const joined = mentions.join(" ");
  const text = current.text && !/\s$/.test(current.text) ? `${current.text} ${joined} ` : `${current.text}${joined} `;
  updateComposer(key, { text, files: [...current.files, ...files] });
  if (task) openTask(task.id);
  else openHome();
  return files.length;
}

/** Stops the task's turn, or with `subagent` only that subagent's work. */
export const cancelTask = (task: string, subagent: string | null = null) => call(commands.agentCancel(task, subagent));
export const stopBackgroundTask = (task: string, background: string) =>
  call(commands.agentStopBackground(task, background));
export const respond = (task: string, permission: number, option: string | null) =>
  call(commands.agentRespond(task, permission, option));
export const answerQuestion = (task: string, question: string, answer: string | null) =>
  call(commands.agentAnswerQuestion(task, question, answer));
export const unarchiveTask = (task: string) => call(commands.agentUnarchive(task));
export const renameTask = (task: string, title: string) => call(commands.agentRename(task, title));
export const archiveTask = (task: string) => call(commands.agentArchive(task));
export const deleteTask = (task: string, removeWorktree: boolean) => call(commands.agentDelete(task, removeWorktree));

/** Applies `change` to the saved arrange state of the project the tasks belong to. */
function changeOrganize(change: (organize: TaskOrganize) => TaskOrganize) {
  const s = useAgents.getState();
  const organize = change(s.organize);
  useAgents.setState({ organize });
  saveOrganize(s.organizeRoot, organize);
}

/** Pins or unpins the tasks: pinned ones sit above every group, and keep their group meanwhile. */
export function pinTasks(tasks: readonly string[], pinned: boolean) {
  changeOrganize((organize) => {
    const next = new Set(organize.pinned);
    for (const task of tasks) {
      if (pinned) next.add(task);
      else next.delete(task);
    }
    return { ...organize, pinned: [...next] };
  });
}

/** The user's groups, in the order the tool window shows them. */
export const taskGroups = (): OrganizeGroup[] => useAgents.getState().organize.groups;

/** Adds a group and puts `tasks` in it; returns the new group. */
export function newTaskGroup(name: string, tasks: readonly string[] = []): OrganizeGroup {
  const group: OrganizeGroup = {
    id: `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name.trim(),
  };
  changeOrganize((organize) => ({
    ...organize,
    groups: [...organize.groups, group],
    groupOf: tasks.length
      ? { ...organize.groupOf, ...Object.fromEntries(tasks.map((task) => [task, group.id])) }
      : organize.groupOf,
  }));
  return group;
}

export function renameTaskGroup(group: string, name: string) {
  changeOrganize((organize) => ({
    ...organize,
    groups: organize.groups.map((g) => (g.id === group ? { ...g, name: name.trim() } : g)),
  }));
}

/** Removes a group; its tasks go back to the status groups. */
export function deleteTaskGroup(group: string) {
  changeOrganize((organize) => ({
    ...organize,
    groups: organize.groups.filter((g) => g.id !== group),
    groupOf: Object.fromEntries(Object.entries(organize.groupOf).filter(([, g]) => g !== group)),
  }));
}

/** Moves the tasks into `group`, out of the pinned section; `null` puts them back among the status groups. */
export function moveTasksToGroup(tasks: readonly string[], group: string | null) {
  changeOrganize((organize) => {
    const groupOf = { ...organize.groupOf };
    for (const task of tasks) {
      if (group) groupOf[task] = group;
      else delete groupOf[task];
    }
    const moved = new Set(tasks);
    return { ...organize, groupOf, pinned: group ? organize.pinned.filter((id) => !moved.has(id)) : organize.pinned };
  });
}
