/**
 * What running plugin code shows outside its declarations: status bar items
 * (`ui.set-status-item`), background tasks (`tasks.begin`), and the
 * workbench events it subscribed to (`events.subscribe`), reported in
 * batches.
 */
import { create } from "zustand";
import type {
  CommitAnswer,
  CommitRequest,
  EventKind,
  PluginContextKey,
  PluginEvent,
  Prompt,
  StatusItem,
  WorkbenchEvent,
} from "@/bindings";
import { onEditorEvent } from "@/editor/api";
import { executeAction, getAction, onActionExecuted } from "@/platform/actions";
import { clearContext, setContext, type ContextValue } from "@/platform/context";
import { onIdeEvent } from "@/platform/ipc";
import { openExternalUrl } from "@/platform/openUrl";
import { useProject } from "@/platform/project";
import { shortcutLabel } from "@/platform/keymap";
import { BarButton } from "@/ui/BarButton";
import {
  maybeCommitService,
  maybeEditorService,
  registerStatusItem,
  toolWindowService,
} from "@/workbench/contributions";
import { pickItems, promptInput } from "@/workbench/inputDialogs";
import { confirm } from "@/workbench/messages";
import { removeTask, upsertTask, useTasks } from "@/workbench/tasks";
import { pluginsBackend } from "./backend";
import { usePluginT } from "./pluginText";
import { bumpView, deliverViewMessage, pluginToolWindowId } from "./views/viewStore";
import { runPluginCommand, usePlugins } from "./store";

// --- status bar items ---------------------------------------------------------

type ItemKey = `${string}/${string}`;

export const usePluginStatusItems = create<{ items: Map<ItemKey, { pluginId: string; item: StatusItem }> }>(() => ({
  items: new Map(),
}));

function setStatusItem(pluginId: string, id: string, item: StatusItem | null) {
  usePluginStatusItems.setState((s) => {
    const items = new Map(s.items);
    if (item) items.set(`${pluginId}/${id}`, { pluginId, item });
    else items.delete(`${pluginId}/${id}`);
    return { items };
  });
}

/** Items declared under `[[contributes.statusBar]]`: shown until (and unless) the code sets its own. */
interface Declared {
  item: StatusItem;
  align: "left" | "right";
  priority: number;
}

export const useDeclaredStatusItems = create<{ items: Map<ItemKey, { pluginId: string } & Declared> }>(() => ({
  items: new Map(),
}));

export function declareStatusItem(pluginId: string, id: string, declared: Declared): () => void {
  const key: ItemKey = `${pluginId}/${id}`;
  const entry = { pluginId, ...declared };
  useDeclaredStatusItems.setState((s) => ({ items: new Map(s.items).set(key, entry) }));
  return () =>
    useDeclaredStatusItems.setState((s) => {
      if (s.items.get(key) !== entry) return s;
      const items = new Map(s.items);
      items.delete(key);
      return { items };
    });
}

function PluginStatusItemView({ itemKey }: { itemKey: ItemKey }) {
  const running = usePluginStatusItems((s) => s.items.get(itemKey));
  const declared = useDeclaredStatusItems((s) => s.items.get(itemKey));
  const entry = running ?? declared;
  const t = usePluginT(entry?.pluginId ?? "");
  if (!entry) return null;
  const { pluginId, item } = entry;
  const command = item.command;
  // Declared items were translated with their declaration.
  const translate = running ? t : (text: string) => text;
  const tooltip = item.tooltip ? translate(item.tooltip) : undefined;
  const text = translate(item.text);
  return (
    <BarButton
      tooltip={tooltip}
      aria-label={tooltip ?? text}
      onClick={command ? () => void runPluginCommand(pluginId, command) : undefined}
    >
      {text}
    </BarButton>
  );
}

/** The item's name in the status bar menu: its plugin's, plus what it declares (tooltip or text). */
function statusItemTitle(key: ItemKey, declared: Declared | undefined): string {
  const pluginId = key.slice(0, key.indexOf("/"));
  const plugin = usePlugins.getState().plugins.find((p) => p.id === pluginId)?.name ?? pluginId;
  const what = declared?.item.tooltip || declared?.item.text;
  return what ? `${plugin}: ${what}` : plugin;
}

/** One status bar contribution per plugin item (declared or set by code), registered while it exists. */
function projectStatusItems(): () => void {
  const registered = new Map<ItemKey, { dispose: () => void; sig: string }>();
  const sync = () => {
    const running = usePluginStatusItems.getState().items;
    const declared = useDeclaredStatusItems.getState().items;
    const live = new Set<ItemKey>([...running.keys(), ...declared.keys()]);
    for (const [key, r] of registered) {
      const d = declared.get(key);
      const sig = d ? `${d.align}/${d.priority}` : "";
      if (!live.has(key) || r.sig !== sig) {
        r.dispose();
        registered.delete(key);
      }
    }
    for (const key of live)
      if (!registered.has(key)) {
        const d = declared.get(key);
        const View = () => <PluginStatusItemView itemKey={key} />;
        const dispose = registerStatusItem({
          id: `plugin.${key}`,
          // Named in the status bar's context menu, so it can be hidden like the built-in widgets.
          title: statusItemTitle(key, d),
          align: d?.align ?? "right",
          priority: d?.priority ?? 2,
          component: View,
        });
        registered.set(key, { dispose, sig: d ? `${d.align}/${d.priority}` : "" });
      }
  };
  sync();
  const unsubscribe = [
    usePluginStatusItems.subscribe((s, prev) => s.items !== prev.items && sync()),
    useDeclaredStatusItems.subscribe((s, prev) => s.items !== prev.items && sync()),
  ];
  refreshStatusItems();
  refreshContextKeys();
  return () => {
    unsubscribe.forEach((u) => u());
    for (const r of registered.values()) r.dispose();
    registered.clear();
  };
}

/**
 * Re-reads the status items of running plugin code (later changes arrive as
 * `statusItemChanged`). Like the event kinds, the backend answers once this
 * window's project is open and trusted, so call it again when that happens.
 */
function refreshStatusItems() {
  void pluginsBackend()
    .statusItems()
    .then((items) => items.forEach((i) => setStatusItem(i.pluginId, i.id, i.item)))
    .catch(() => {});
}

function applyPluginContext(pluginId: string, key: string, value: string | null) {
  const name = `plugin.${pluginId}.${key}`;
  let parsed: ContextValue;
  try {
    parsed = value === null ? undefined : JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) clearContext(name);
  else setContext(name, parsed);
}

const appliedContextKeys = new Map<string, Set<string>>();
let contextFetching = false;
let contextDirty = false;

function applyContextKeys(keys: PluginContextKey[]) {
  const fresh = new Map<string, Set<string>>();
  for (const k of keys) {
    applyPluginContext(k.pluginId, k.key, k.value);
    if (!fresh.has(k.pluginId)) fresh.set(k.pluginId, new Set());
    fresh.get(k.pluginId)!.add(k.key);
  }
  for (const [id, applied] of appliedContextKeys) {
    for (const key of applied) {
      if (!fresh.get(id)?.has(key)) applyPluginContext(id, key, null);
    }
  }
  appliedContextKeys.clear();
  for (const [id, set] of fresh) appliedContextKeys.set(id, set);
}

/**
 * Re-reads the effective context keys of every plugin from the backend (the event does
 * not say whether a change was window- or global-scoped) and drops keys it no longer
 * reports. One fetch at a time: changes that arrive meanwhile cost a single follow-up.
 */
function refreshContextKeys() {
  if (contextFetching) {
    contextDirty = true;
    return;
  }
  contextFetching = true;
  contextDirty = false;
  pluginsBackend()
    .contextKeys()
    .then(applyContextKeys)
    .catch(() => {})
    .finally(() => {
      contextFetching = false;
      if (contextDirty) refreshContextKeys();
    });
}

// --- tasks --------------------------------------------------------------------

const taskId = (id: string) => `plugin:${id}`;

function onTaskEvent(e: Extract<PluginEvent, { type: "taskStarted" | "taskProgress" | "taskEnded" }>) {
  const id = taskId(e.taskId);
  const current = useTasks.getState().tasks.find((t) => t.id === id);
  switch (e.type) {
    case "taskStarted":
      upsertTask({
        id,
        title: e.title,
        message: null,
        fraction: null,
        done: false,
        cancel: e.cancellable ? () => void pluginsBackend().cancelTask(e.taskId) : undefined,
      });
      break;
    case "taskProgress":
      if (current)
        upsertTask({
          ...current,
          message: e.message,
          fraction: e.total ? Math.min(1, e.done / e.total) : null,
        });
      break;
    case "taskEnded":
      if (current) upsertTask({ ...current, done: true });
      else removeTask(id);
      break;
  }
}

// --- workbench events -----------------------------------------------------------

/** Batches are sent at most this often; the backend batches again per plugin. */
const POST_INTERVAL_MS = 500;

let wanted = new Set<EventKind>();
let queue: WorkbenchEvent[] = [];
let postTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Re-reads the event kinds plugins want. Besides `subscriptionsChanged`
 * (run-time subscriptions), declared `on-event:` kinds change whenever plugins
 * load, install, toggle or get grants, which the backend reports as `commandsChanged`.
 */
export function refreshEventKinds() {
  void pluginsBackend()
    .eventKinds()
    .then((kinds) => (wanted = new Set(kinds)))
    .catch(() => {});
}

function post(event: WorkbenchEvent) {
  queue.push(event);
  if (postTimer) return;
  postTimer = setTimeout(() => {
    postTimer = null;
    const batch = queue;
    queue = [];
    void pluginsBackend()
      .postEvents(batch)
      .catch(() => {});
  }, POST_INTERVAL_MS);
}

/** Reports the events plugins subscribed to: files opened and saved, actions run, repositories changed. */
function trackWorkbenchEvents(): () => void {
  refreshEventKinds();
  const offEditor = onEditorEvent((e) => {
    if (e.type === "docOpened" && wanted.has("file-opened")) post({ kind: "fileOpened", value: e.path });
    if (e.type === "docSaved" && wanted.has("file-saved")) post({ kind: "fileSaved", value: e.path });
  });
  const offActions = onActionExecuted((id, _arg, source) => {
    if (!wanted.has("action-performed")) return;
    const action = getAction(id);
    post({
      kind: "actionPerformed",
      value: { action: id, title: action?.title ?? id, source, shortcut: shortcutLabel(id) ?? null },
    });
  });
  const offVcs = onIdeEvent("vcsChanged", (e) => {
    if (wanted.has("vcs-changed")) post({ kind: "vcsChanged", value: e.root });
  });
  return () => {
    offEditor();
    offActions();
    offVcs();
    if (postTimer) clearTimeout(postTimer);
    postTimer = null;
    queue = [];
  };
}

const openPrompts = new Map<string, AbortController>();

/** The user's answer in the shape `plugin_answer_prompt` takes: `null` when dismissed. */
async function askUser(prompt: Prompt, signal: AbortSignal): Promise<string[] | null> {
  switch (prompt.kind) {
    case "quickPick":
      return pickItems({ title: prompt.title, items: prompt.items, multiple: prompt.multiple, signal });
    case "input": {
      const text = await promptInput({
        title: prompt.prompt,
        initial: prompt.value ?? "",
        validate: () => null,
        keepWhitespace: true,
        signal,
      });
      return text === null ? null : [text];
    }
    case "confirm":
      return (await confirm({ title: prompt.title, message: prompt.message, ok: "OK", signal })) ? [] : null;
  }
}

async function answerPrompt(promptId: string, prompt: Prompt) {
  const controller = new AbortController();
  openPrompts.set(promptId, controller);
  const answer = await askUser(prompt, controller.signal);
  openPrompts.delete(promptId);
  if (controller.signal.aborted) return;
  await pluginsBackend()
    .answerPrompt(promptId, answer)
    .catch(() => {});
}

/** Answers a plugin's request to this window's Commit view (`commit` API). */
async function answerCommit(requestId: string, request: CommitRequest) {
  const commit = maybeCommitService();
  let answer: CommitAnswer;
  try {
    if (request.kind === "selection") {
      const selection = commit ? await commit.selection() : null;
      answer = selection ? { kind: "selection", selection } : { kind: "noRepository" };
    } else if (!commit) {
      answer = { kind: "noRepository" };
    } else {
      answer = commit.setMessage(request.revision, request.message) ? { kind: "done" } : { kind: "stale" };
    }
  } catch {
    // The selection could not be read (e.g. a file vanished): the plugin sees a stale draft.
    answer = { kind: "stale" };
  }
  await pluginsBackend()
    .answerCommit(requestId, answer)
    .catch(() => {});
}

/** Handles the runtime UI events; returns whether `e` was one. */
export function handleRuntimeEvent(e: PluginEvent): boolean {
  switch (e.type) {
    case "contextChanged":
      refreshContextKeys();
      return true;
    case "statusItemChanged":
      setStatusItem(e.pluginId, e.id, e.item);
      return true;
    case "taskStarted":
    case "taskProgress":
    case "taskEnded":
      onTaskEvent(e);
      return true;
    case "subscriptionsChanged":
      refreshEventKinds();
      return true;
    case "viewChanged":
      bumpView(e.pluginId, e.view);
      return true;
    case "viewMessage":
      deliverViewMessage(e.pluginId, e.view, e.message);
      return true;
    case "openTerminal":
      // The program was approved (`process:`) and verified by the host.
      void executeAction("terminal.runCommand", { program: e.program, args: e.args, name: e.title, cwd: e.cwd });
      return true;
    case "openLocation":
      void maybeEditorService()?.openFile(e.path, { selection: { line: e.line, col: e.column }, focus: true });
      return true;
    case "copyToClipboard":
      void navigator.clipboard?.writeText(e.text);
      return true;
    case "openUrl":
      void openExternalUrl(e.url);
      return true;
    case "promptRequested":
      void answerPrompt(e.promptId, e.prompt);
      return true;
    case "promptClosed":
      openPrompts.get(e.promptId)?.abort();
      openPrompts.delete(e.promptId);
      return true;
    case "commitRequested":
      void answerCommit(e.requestId, e.request);
      return true;
    case "revealView":
      toolWindowService().show(pluginToolWindowId(e.pluginId, e.view), true);
      return true;
    default:
      return false;
  }
}

/**
 * The backend refuses the event kinds and status items until this window's
 * project is open and trusted (`authorize_command`), but startup asks before
 * that: ask again when it changes. Any new project object counts, even with the same
 * root and trust: connecting another backend publishes one and changes where calls go.
 */
function refreshOnProjectChange(): () => void {
  return useProject.subscribe((s, prev) => {
    if (s.project === prev.project) return;
    refreshEventKinds();
    refreshStatusItems();
    refreshContextKeys();
  });
}

export function startRuntimeUi(): () => void {
  const disposers = [projectStatusItems(), trackWorkbenchEvents(), refreshOnProjectChange()];
  return () => disposers.reverse().forEach((d) => d());
}
