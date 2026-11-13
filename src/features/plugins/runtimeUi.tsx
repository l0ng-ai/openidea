/**
 * What running plugin code shows outside its declarations: status bar items
 * (`ui.set-status-item`), background tasks (`tasks.begin`), and the
 * workbench events it subscribed to (`events.subscribe`), reported in
 * batches.
 */
import { writeClipboardText } from "@/platform/clipboard";
import { providePluginTestParser, providePluginTestSelector } from "@/workbench/contributions";
import {
  contentTabData,
  contentTabKey,
  handleContentTabReplyText,
  openPluginDiffRequest,
  PLUGIN_CONTENT_EDITOR_KIND,
  WASM_CONTENT_VIEW,
} from "./views/contentTab";
import { create } from "zustand";
import { refreshRunTargets, startRunTargets } from "./runTargets";
import type {
  CommitAnswer,
  CommandAnswer,
  CommitRequest,
  EventKind,
  PluginContextKey,
  PluginEvent,
  Prompt,
  StatusItem,
  WorkbenchEvent,
} from "@/bindings";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { setPluginDecorations } from "./decorations";
import { editorsFor, onEditorEvent } from "@/editor/api";
import { executeAction, executeActionOrThrow, getAction, onActionExecuted } from "@/platform/actions";
import { clearContext, setContext, type ContextValue } from "@/platform/context";
import { isTauri, onIdeEvent } from "@/platform/ipc";
import { isOpenable, openExternalUrl } from "@/platform/openUrl";
import { tx, VerbatimTextContext } from "@/platform/i18n";
import { useProject } from "@/platform/project";
import { isRemoteWindow } from "@/platform/remote";
import { ipcPath } from "@/platform/paths";
import { shortcutLabel } from "@/platform/keymap";
import { BarButton } from "@/ui/BarButton";
import { notifications, maybeCommitService, maybeEditorService, registerStatusItem } from "@/workbench/contributions";
import { pickItems, promptInput } from "@/workbench/inputDialogs";
import { confirm } from "@/workbench/messages";
import { removeTask, upsertTask, useTasks } from "@/workbench/tasks";
import { editorContext } from "./editorContext";
import { pluginsBackend } from "./backend";
import { askNetPermission } from "./netAsk";
import { confirmRemoteCopy, confirmRemoteOpen } from "./remoteAsk";
import { usePluginT } from "./pluginText";
import { setPluginOutput } from "./views/outputStore";
import { PLUGIN_LOG_EDITOR_KIND } from "./views/logEditor";
import type { PluginLogEditorData } from "./views/logTab";
import { bumpView, deliverViewMessage } from "./views/viewStore";
import { revealWindowView } from "./views/viewWindows";
import { runPluginCommand, usePlugins } from "./store";

// --- status bar items ---------------------------------------------------------

type ItemKey = `${string}/${string}`;

export const usePluginStatusItems = create<{ items: Map<ItemKey, { pluginId: string; item: StatusItem }> }>(() => ({
  items: new Map(),
}));

let statusRevision = 0;
let statusRequest = 0;
const globalStatus = new Map<ItemKey, { pluginId: string; item: StatusItem }>();
const windowStatus = new Map<ItemKey, { pluginId: string; item: StatusItem }>();

function setStatusItem(pluginId: string, id: string, item: StatusItem | null, window = false) {
  statusRevision++;
  const key: ItemKey = `${pluginId}/${id}`;
  const scope = window ? windowStatus : globalStatus;
  if (item) scope.set(key, { pluginId, item });
  else scope.delete(key);
  const effective = windowStatus.get(key) ?? globalStatus.get(key);
  usePluginStatusItems.setState((s) => {
    const items = new Map(s.items);
    if (effective) items.set(key, effective);
    else items.delete(key);
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
    <VerbatimTextContext.Provider value={true}>
      <BarButton
        tooltip={tooltip}
        aria-label={tooltip ?? text}
        onClick={command ? () => void runPluginCommand(pluginId, command) : undefined}
      >
        {text}
      </BarButton>
    </VerbatimTextContext.Provider>
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
  const request = ++statusRequest;
  const revision = statusRevision;
  void pluginsBackend()
    .statusItems()
    .then((items) => {
      if (request !== statusRequest) return;
      if (revision !== statusRevision) {
        refreshStatusItems();
        return;
      }
      globalStatus.clear();
      windowStatus.clear();
      usePluginStatusItems.setState({ items: new Map() });
      items.forEach((i) => setStatusItem(i.pluginId, i.id, i.item, i.window));
    })
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
    .then((kinds) => {
      wanted = new Set(kinds);
      if (wanted.has("settings-changed")) post({ kind: "settingsChanged", value: [] });
    })
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
    if (e.type === "docClosed" && wanted.has("file-closed")) post({ kind: "fileClosed", value: e.path });
    if (e.type === "inputModeChanged" && wanted.has("input-mode-changed"))
      post({ kind: "inputModeChanged", value: { path: e.path, mode: e.mode, sub: e.sub } });
    if (e.type === "docSaved" && wanted.has("file-saved")) post({ kind: "fileSaved", value: e.path });
    if (e.type === "docChanged" && wanted.has("document-changed"))
      post({
        kind: "documentChanged",
        value: { path: e.path, baseVersion: e.baseVersion, version: e.version, changes: e.changes },
      });
  });
  const offActions = onActionExecuted((id, _arg, source) => {
    if (!wanted.has("action-performed")) return;
    const action = getAction(id);
    post({
      kind: "actionPerformed",
      value: { action: id, title: action?.title ?? id, source, shortcut: shortcutLabel(id) ?? null },
    });
  });
  const offSettings = onIdeEvent("settingsChanged", () => {
    if (wanted.has("settings-changed")) post({ kind: "settingsChanged", value: [] });
  });
  const offVcs = onIdeEvent("vcsChanged", (e) => {
    if (wanted.has("vcs-changed")) post({ kind: "vcsChanged", value: e.root });
  });
  return () => {
    offEditor();
    offActions();
    offVcs();
    offSettings();
    if (postTimer) clearTimeout(postTimer);
    postTimer = null;
    queue = [];
  };
}

const openPrompts = new Map<string, AbortController>();

/** The user's answer in the shape `plugin_answer_prompt` takes: `null` when dismissed. */
async function askUser(prompt: Prompt, signal: AbortSignal): Promise<string[] | null> {
  switch (prompt.kind) {
    case "pickDirectory": {
      if (signal.aborted) return null;
      try {
        const { open } = await import("@/platform/dialog");
        if (signal.aborted) return null;
        const selected = await open({
          directory: true,
          multiple: false,
          title: prompt.title,
          defaultPath: prompt.initial ?? undefined,
        });
        if (signal.aborted) return null;
        const path = Array.isArray(selected) ? selected[0] : selected;
        return path ? [ipcPath(path)] : null;
      } catch (error) {
        if (!signal.aborted)
          notifications().notify({ level: "error", title: tx("Cannot choose a directory"), body: String(error) });
        return null;
      }
    }
    case "quickPick":
      return pickItems({ title: prompt.title, items: prompt.items, multiple: prompt.multiple, signal, verbatim: true });
    case "input": {
      const text = await promptInput({
        title: prompt.prompt,
        initial: prompt.value ?? "",
        validate: () => null,
        keepWhitespace: true,
        multiline: prompt.multiline,
        signal,
        verbatim: true,
      });
      return text === null ? null : [text];
    }
    case "confirm":
      return (await confirm({ title: prompt.title, message: prompt.message, ok: tx("OK"), signal, verbatim: true }))
        ? []
        : null;
    case "netPermission":
      // The host's own question: answered before this (`answerPrompt`).
      return null;
  }
}

async function answerPrompt(promptId: string, prompt: Prompt, pluginId: string) {
  const controller = new AbortController();
  openPrompts.set(promptId, controller);
  const answer =
    prompt.kind === "netPermission"
      ? await askNetPermission(pluginId, prompt.host, prompt.sessionOnly, controller.signal)
      : await askUser(prompt, controller.signal);
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

async function answerCommand(e: Extract<PluginEvent, { type: "executeCommand" }>) {
  let answer: CommandAnswer;
  try {
    const command = usePlugins
      .getState()
      .ui.find((c) => c.point === "commands" && e.id === `plugin.${c.pluginId}.${(c.decl as { id: string }).id}`);
    if (command) {
      const value = await pluginsBackend().runCommand(
        command.pluginId,
        (command.decl as { id: string }).id,
        e.arg,
        editorContext(),
        [],
        undefined,
        e.chain,
      );
      answer = { kind: "value", value };
    } else if (getAction(e.id)) {
      await executeAction(e.id, e.arg);
      answer = { kind: "value", value: null };
    } else answer = { kind: "notFound" };
  } catch (error) {
    answer = { kind: "failed", value: error instanceof Error ? error.message : String(error) };
  }
  await pluginsBackend()
    .answerCommand(e.requestId, answer)
    .catch(() => {});
}

/** Handles the runtime UI events; returns whether `e` was one. */
export function handleRuntimeEvent(e: PluginEvent): boolean {
  switch (e.type) {
    case "runTargetsChanged":
      void refreshRunTargets().catch(() => {});
      return true;
    case "decorationsChanged":
      setPluginDecorations(e.pluginId, e.sets);
      return true;
    case "editorOpen": {
      const r = e.selection;
      void maybeEditorService()?.openFile(e.path, {
        focus: true,
        selection: r ? { line: r.start.line, col: r.start.col, endLine: r.end.line, endCol: r.end.col } : undefined,
      });
      return true;
    }
    case "editorRanges": {
      for (const editor of editorsFor(e.path)) {
        const doc = editor.view.state.doc;
        const ranges = e.ranges.map((r) => {
          if (r.start.line >= doc.lines || r.end.line >= doc.lines) return null;
          const start = doc.line(r.start.line + 1),
            end = doc.line(r.end.line + 1);
          if (r.start.col > start.length || r.end.col > end.length) return null;
          return EditorSelection.range(start.from + r.start.col, end.from + r.end.col);
        });
        if (!ranges.length || ranges.some((r) => r == null)) continue;
        const valid = ranges.filter((r) => r != null);
        if (e.reveal) editor.view.dispatch({ effects: EditorView.scrollIntoView(valid[0]!, { y: "center" }) });
        else editor.view.dispatch({ selection: EditorSelection.create(valid) });
      }
      return true;
    }
    case "executeCommand":
      void answerCommand(e);
      return true;
    case "contextChanged":
      refreshContextKeys();
      return true;
    case "windowStatusItemChanged":
      setStatusItem(e.pluginId, e.id, e.item, true);
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
    case "websocketReady":
      post({ kind: "websocketReady", value: { pluginId: e.pluginId, connection: e.connection } });
      return true;
    case "viewChanged":
      bumpView(e.pluginId, e.view);
      return true;
    case "viewMessage":
      deliverViewMessage(e.pluginId, e.view, e.message);
      return true;
    case "windowRequest":
      void handleWindowRequest(e);
      return true;
    case "contentTabReply":
      handleContentTabReplyText(
        e.pluginId,
        JSON.stringify({
          op: "content-tab-reply",
          requestId: e.requestId,
          ...JSON.parse(JSON.stringify(e.reply), (_k, v: unknown) => (v === null ? undefined : v)),
        }),
      );
      return true;
    case "openDiff":
      try {
        const { diff, fileName } = e;
        openPluginDiffRequest(
          {
            ...diff,
            leftLabel: diff.leftLabel ?? undefined,
            rightLabel: diff.rightLabel ?? undefined,
            title: diff.title ?? undefined,
            fileName: fileName ?? undefined,
          },
          diff.left.length + diff.right.length,
        );
      } catch (err) {
        console.warn(`plugin ${e.pluginId} diff:`, err);
      }
      return true;
    case "openTerminal":
      // The program was approved (`process:`) and verified by the host.
      void executeAction("terminal.runCommand", { program: e.program, args: e.args, name: e.title, cwd: e.cwd });
      return true;
    case "outputChanged":
      setPluginOutput(e.pluginId, e.channel, e.text);
      return true;
    case "revealOutput":
      setPluginOutput(e.pluginId, e.channel, e.text);
      void maybeEditorService()?.openInput({
        kind: PLUGIN_LOG_EDITOR_KIND,
        key: `pluginOutput:${JSON.stringify([e.pluginId, e.channel])}`,
        data: {
          pluginId: e.pluginId,
          view: "",
          key: e.channel,
          title: tx`Output: ${e.channel}`,
          program: "",
          args: [],
          toggles: [],
          origin: "output",
        } satisfies PluginLogEditorData,
      });
      return true;
    case "openLogTab":
      void maybeEditorService()?.openInput({
        kind: PLUGIN_LOG_EDITOR_KIND,
        key: `pluginLog:${JSON.stringify([e.pluginId, "", e.key])}`,
        data: {
          pluginId: e.pluginId,
          view: "",
          key: e.key,
          title: e.title,
          program: e.log.program,
          args: e.log.args,
          toggles: e.log.toggles,
          origin: "code",
        } satisfies PluginLogEditorData,
      });
      return true;
    case "openLocation":
      void maybeEditorService()?.openFile(e.path, { selection: { line: e.line, col: e.column }, focus: true });
      return true;
    case "copyToClipboard":
      if (isRemoteWindow()) void copyRemoteText(e.pluginId, e.text);
      else void writeClipboardText(e.text);
      return true;
    case "openProject":
      void executeAction("file.openProjectPath", { path: e.path, newWindow: e.newWindow });
      return true;
    case "openUrl":
      if (isRemoteWindow()) void openRemoteUrl(e.pluginId, e.url);
      else void openExternalUrl(e.url);
      return true;
    case "promptRequested":
      void answerPrompt(e.promptId, e.prompt, e.pluginId);
      return true;
    case "promptClosed":
      openPrompts.get(e.promptId)?.abort();
      openPrompts.delete(e.promptId);
      return true;
    case "promptWaiting":
      bringWindowToFront();
      return true;
    case "commitRequested":
      void answerCommit(e.requestId, e.request);
      return true;
    case "revealView":
      revealWindowView(e.pluginId, e.view);
      return true;
    default:
      return false;
  }
}

/** A remote window's plugin code runs on its server: what it opens here, the user confirms first. */
async function openRemoteUrl(pluginId: string, url: string) {
  if (isOpenable(url) && (await confirmRemoteOpen(pluginId, url))) await openExternalUrl(url);
}

/** A remote window's plugin code runs on its server: what it copies here, the user confirms first. */
async function copyRemoteText(pluginId: string, text: string) {
  if (await confirmRemoteCopy(pluginId, text)) await writeClipboardText(text).catch(() => {});
}

/** Another window ran a command of a plugin whose prompt is open here: show this window. */
function bringWindowToFront() {
  if (!isTauri()) return;
  void import("@tauri-apps/api/window")
    .then(async ({ getCurrentWindow }) => {
      const w = getCurrentWindow();
      if (await w.isMinimized()) await w.unminimize();
      await w.setFocus();
    })
    .catch(() => undefined);
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
    statusRevision++;
    globalStatus.clear();
    windowStatus.clear();
    usePluginStatusItems.setState({ items: new Map() });
    refreshEventKinds();
    refreshStatusItems();
    refreshContextKeys();
  });
}

export function startRuntimeUi(): () => void {
  const stopParser = providePluginTestParser((config, chunk) => pluginsBackend().parseTestResults(config, chunk));
  const disposers = [
    startRunTargets(),
    stopParser,
    providePluginTestSelector((config, tests) => pluginsBackend().selectTests(config, tests)),
    projectStatusItems(),
    trackWorkbenchEvents(),
    refreshOnProjectChange(),
  ];
  return () => disposers.reverse().forEach((d) => d());
}

async function handleWindowRequest(e: Extract<PluginEvent, { type: "windowRequest" }>) {
  const r = e.request;
  try {
    if (r.kind === "databaseConnect") {
      if (!getAction("db.pluginConnect")) throw new Error(tx("Database service unavailable"));
      await executeActionOrThrow("db.pluginConnect", r.id);
      await pluginsBackend().answerCommand(e.requestId, { kind: "value", value: null });
      return;
    }
    if (r.kind === "contentTab") {
      const raw = JSON.parse(JSON.stringify(r.tab), (_k, v: unknown) => (v === null ? undefined : v)) as object;
      const data = contentTabData(e.pluginId, WASM_CONTENT_VIEW, raw, JSON.stringify(raw).length);
      const editor = maybeEditorService();
      if (!editor) throw new Error("Editor unavailable");
      await editor.openInput({
        kind: PLUGIN_CONTENT_EDITOR_KIND,
        key: contentTabKey(e.pluginId, WASM_CONTENT_VIEW, data.key),
        data,
      });
      await pluginsBackend().answerCommand(e.requestId, { kind: "value", value: null });
      return;
    }
    const finish = (status: number | null, stopped: boolean) => {
      if (r.kind === "run") void pluginsBackend().finishOperation(r.operation, status, stopped);
      else if (stopped) void pluginsBackend().closeTerminalSession(r.operation);
    };
    if (r.kind === "run") {
      if (!getAction("run.pluginStart")) throw new Error("Run service unavailable");
      await executeActionOrThrow("run.pluginStart", { config: r.config, debug: r.debug, onExit: finish });
    } else {
      if (!getAction("terminal.pluginSession")) throw new Error("Terminal service unavailable");
      await executeActionOrThrow("terminal.pluginSession", {
        ...r,
        onExit: finish,
        spawn: (cols: number, rows: number, output: import("@tauri-apps/api/core").Channel<string>) =>
          pluginsBackend().terminalSessionSpawn(r.operation, cols, rows, output),
      });
    }
    if (e.requestId) await pluginsBackend().answerCommand(e.requestId, { kind: "value", value: null });
  } catch (error) {
    if (r.kind === "run") await pluginsBackend().finishOperation(r.operation, null, false);
    if (e.requestId) await pluginsBackend().answerCommand(e.requestId, { kind: "failed", value: String(error) });
  }
}
