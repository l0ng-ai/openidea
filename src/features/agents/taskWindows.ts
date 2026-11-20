/**
 * A conversation moved to a lightweight editor window. Only the view moves: the task and its
 * agent process stay in the project's backend, and the project window keeps the task list, the
 * unread marks, the notifications and a copy of the unsent draft.
 */
import { emitTo, TauriEvent, type UnlistenFn } from "@tauri-apps/api/event";
import { getAllWindows, getCurrentWindow, Window } from "@tauri-apps/api/window";
import { auxiliaryWindow, windowLabel } from "@/platform/auxWindow";
import { call, commands, isTauri } from "@/platform/ipc";
import { tx } from "@/platform/i18n";
import { executeAction, registerActions } from "@/platform/actions";
import {
  editorService,
  notifications,
  provideEditorService,
  provideToolWindowService,
  toolWindowService,
  type EditorInput,
  type OpenOptions,
} from "@/workbench/contributions";
import type { ComposerDraft } from "./composerModel";
import { SESSION_KIND, sessionKey } from "./model";
import { composerDraft, loadEntries, openHome, openTask, updateComposer, useAgents } from "./store";
import { installTaskWindowRouting } from "./taskWindowRouting";

export const TASK_WINDOW = "openidea://agents/window";

export type TaskWindowMessage =
  | { type: "requestDraft"; task: string; label: string }
  | { type: "draftSnapshot"; task: string; draft: ComposerDraft }
  | { type: "openFile"; path: string; options?: OpenOptions }
  | { type: "openInput"; input: EditorInput; options?: OpenOptions }
  | { type: "toolWindow"; id: string }
  | { type: "action"; action: string; arg?: unknown }
  /** Window `label` shows `task`; `draft` is what changed in its composer. */
  | { type: "draft"; task: string; label: string; draft: Partial<ComposerDraft> }
  /** Window `label` closed its tab of `task`. */
  | { type: "closed"; task: string; label: string }
  /** A lightweight window asks the project window to show `task`, or New Task. */
  | { type: "open"; task: string | null; prompt?: string }
  /** A project window that lost track of its windows (it reloaded) asks them to report again. */
  | { type: "sync" };

type TaskData = { task: string; title?: string; draft?: ComposerDraft };
const taskInput = (data: TaskData): EditorInput => ({ kind: SESSION_KIND, key: sessionKey(data.task), data });
const taskOf = (input: EditorInput | null) => (input?.kind === SESSION_KIND ? (input.data as TaskData).task : null);

type Detached = { label: string; draft: ComposerDraft; focused: boolean; stop?: UnlistenFn };
/** Project window: the conversations shown in its lightweight windows. */
const detached = new Map<string, Detached>();
const opening = new Map<string, ComposerDraft>();
/** Lightweight window: its tab of this task closed. */
let tabClosed: ((task: string) => void) | undefined;
export const taskTabClosed = (task: string) => tabClosed?.(task);

/** A reload uses the project's current draft, not the draft in the original launch. */
export async function prepareTaskWindowInput(input: EditorInput): Promise<EditorInput> {
  const task = taskOf(input);
  const aux = auxiliaryWindow();
  if (!task || !aux) return input;
  await new Promise<void>((resolve, reject) => {
    let loading = false;
    const finish = (error?: unknown) => {
      clearTimeout(timer);
      stop();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const check = () => {
      const state = useAgents.getState();
      if (!state.loaded) return;
      const error = state.error || state.entryLoads.get(task)?.error;
      if (error) return finish(new Error(error));
      if (!state.tasks.has(task)) return finish(new Error(tx("Could not open the editor window")));
      if (state.entries.has(task)) return finish();
      if (!loading) {
        loading = true;
        void loadEntries(task).catch(finish);
      }
    };
    const stop = useAgents.subscribe(check);
    const timer = setTimeout(() => finish(new Error(tx("Loading the conversation timed out. Try again."))), 20_000);
    check();
  });
  const self = getCurrentWindow();
  let receive!: (draft: ComposerDraft) => void;
  const snapshot = new Promise<ComposerDraft>((resolve) => {
    receive = resolve;
  });
  const stop = await self.listen<TaskWindowMessage>(TASK_WINDOW, ({ payload }) => {
    if (payload.type === "draftSnapshot" && payload.task === task) receive(payload.draft);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const draft = await Promise.race([
      emitTo(aux.parent, TASK_WINDOW, {
        type: "requestDraft",
        task,
        label: self.label,
      } satisfies TaskWindowMessage).then(() => snapshot),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(tx("Timed out opening the editor window"))), 5000);
      }),
    ]);
    return { ...input, data: { ...(input.data as TaskData), draft } };
  } finally {
    clearTimeout(timer);
    stop();
  }
}

async function focusWindow(label: string): Promise<void> {
  const window = await Window.getByLabel(label);
  if (!window) return;
  await window.unminimize();
  await window.show();
  await window.setFocus();
}

function markRead(task: string) {
  const unread = new Set(useAgents.getState().unread);
  if (unread.delete(task)) useAgents.setState({ unread });
}

async function hide(task: string) {
  if (useAgents.getState().docked === task) useAgents.setState({ docked: null });
  await editorService().closeInput?.(sessionKey(task));
}

/** The conversation comes back with what was typed in its window. */
function restore(task: string, entry: Detached) {
  if (detached.get(task) !== entry) return;
  detached.delete(task);
  void entry.stop?.();
  if (!useAgents.getState().tasks.has(task)) return;
  updateComposer(task, entry.draft);
  openTask(task);
  void focusWindow(getCurrentWindow().label);
}

async function watch(task: string, entry: Detached) {
  const window = await Window.getByLabel(entry.label);
  if (!window) return restore(task, entry);
  // Not undone by `restore`: a window that closed the tab still receives agent events until it is gone.
  void window.once(TauriEvent.WINDOW_DESTROYED, () => {
    void call(commands.agentUnsubscribe(entry.label)).catch(() => {});
    restore(task, entry);
  });
  const focus = (focused: boolean) => {
    entry.focused = focused;
    if (focused) {
      markRead(task);
      useAgents.setState({ lastComposer: task });
    }
  };
  const stop = await window.onFocusChanged(({ payload }) => focus(payload));
  if (detached.get(task) !== entry) return void stop();
  entry.stop = stop;
  focus(await window.isFocused());
}

function adopt(task: string, label: string, draft: Partial<ComposerDraft>) {
  let entry = detached.get(task);
  if (entry?.label !== label) {
    void entry?.stop?.();
    entry = { label, draft: composerDraft(task), focused: false };
    detached.set(task, entry);
    void watch(task, entry);
    void hide(task);
  }
  entry.draft = { ...entry.draft, ...draft };
}

function activateProjectWindow(): () => void {
  const self = getCurrentWindow();
  const recovering = new Set<string>();
  const stops = [
    installTaskWindowRouting(
      (task) => {
        const entry = task ? detached.get(task) : undefined;
        if (entry) void focusWindow(entry.label);
        return !!entry;
      },
      (task) => detached.get(task)?.focused ?? false,
      {
        read: (task) => detached.get(task)?.draft,
        update: (task, patch) => {
          const entry = detached.get(task);
          if (!entry) return false;
          entry.draft = { ...entry.draft, ...patch };
          void emitTo(entry.label, TASK_WINDOW, {
            type: "draftSnapshot",
            task,
            draft: entry.draft,
          } satisfies TaskWindowMessage).catch((error) => console.warn("cannot update conversation draft", error));
          return true;
        },
      },
    ),
    // Back/Forward and a restored layout open tabs without going through `openTask`.
    editorService().onActiveInputChange?.((input) => {
      const task = taskOf(input);
      const entry = task ? detached.get(task) : undefined;
      if (!task || !entry) return;
      void hide(task);
      void focusWindow(entry.label);
    }),
  ];
  const listening = self.listen<TaskWindowMessage>(TASK_WINDOW, ({ payload: message }) => {
    if (message.type === "requestDraft") {
      const aux = auxiliaryWindow(message.label);
      const entry = detached.get(message.task);
      if (aux?.kind === "editor" && aux.parent === self.label && (!entry || entry.label === message.label))
        void emitTo(message.label, TASK_WINDOW, {
          type: "draftSnapshot",
          task: message.task,
          draft: entry?.draft ?? composerDraft(message.task),
        } satisfies TaskWindowMessage).catch((error) => console.warn("cannot restore conversation draft", error));
    } else if (message.type === "draft") {
      if (auxiliaryWindow(message.label)?.parent !== self.label) return;
      const pending = opening.get(message.task);
      if (pending) opening.set(message.task, { ...pending, ...message.draft });
      else if (detached.get(message.task)?.label === message.label || recovering.has(message.label))
        adopt(message.task, message.label, message.draft);
    } else if (message.type === "closed") {
      const entry = detached.get(message.task);
      if (entry?.label === message.label) restore(message.task, entry);
    } else if (message.type === "open") {
      if (message.task) openTask(message.task);
      else openHome(message.prompt);
      void focusWindow(self.label);
    } else if (message.type === "openFile" || message.type === "openInput") {
      const editors = editorService();
      const opened =
        message.type === "openFile"
          ? editors.openFile(message.path, message.options)
          : editors.openInput(message.input, message.options);
      void opened.then(() => focusWindow(self.label)).catch(console.error);
    } else if (message.type === "toolWindow") {
      toolWindowService().show(message.id, true);
      void focusWindow(self.label);
    } else if (message.type === "action") {
      void focusWindow(self.label)
        .then(() => executeAction(message.action, message.arg))
        .catch(console.error);
    }
  });
  void listening
    .then(async () => {
      for (const { label } of await getAllWindows()) {
        const aux = auxiliaryWindow(label);
        if (aux?.kind === "editor" && aux.parent === self.label) {
          recovering.add(label);
          await emitTo(label, TASK_WINDOW, { type: "sync" } satisfies TaskWindowMessage);
        }
      }
    })
    .catch((error) => console.warn("cannot look for conversation windows", error));
  return () => {
    stops.forEach((stop) => stop?.());
    void listening.then((stop) => stop()).catch(() => {});
    for (const entry of detached.values()) void entry.stop?.();
    detached.clear();
  };
}

function activateLightweightWindow(parent: string): () => void {
  const self = getCurrentWindow();
  /** The conversations shown here, with what the project window last heard of their composers. */
  const shown = new Map<string, Partial<ComposerDraft>>();
  const send = (message: TaskWindowMessage) =>
    void emitTo(parent, TASK_WINDOW, message).catch((error) => console.warn("cannot reach the project window", error));
  const editors = editorService();
  // A conversation keeps its view here; its file links and workbench tools open in the project.
  provideEditorService({
    ...editors,
    openFile: (path, options) =>
      shown.size
        ? emitTo(parent, TASK_WINDOW, { type: "openFile", path, options } satisfies TaskWindowMessage)
        : editors.openFile(path, options),
    openInput: (input, options) =>
      shown.size && input.kind !== SESSION_KIND
        ? emitTo(parent, TASK_WINDOW, { type: "openInput", input, options } satisfies TaskWindowMessage)
        : editors.openInput(input, options),
  });
  provideToolWindowService({
    show: (id) => send({ type: "toolWindow", id }),
    toggle: (id) => send({ type: "toolWindow", id }),
    hide: () => {},
    isVisible: () => false,
  });
  const report = (task: string, all = false) => {
    const draft = composerDraft(task);
    const known = all ? {} : shown.get(task)!;
    // Images are base64: only what changed travels with each keystroke.
    const changed = Object.fromEntries(
      Object.entries(draft).filter(([field, value]) => value !== known[field as keyof ComposerDraft]),
    );
    shown.set(task, draft);
    if (all || Object.keys(changed).length) send({ type: "draft", task, label: self.label, draft: changed });
  };
  const show = (input: EditorInput | null) => {
    const task = taskOf(input);
    if (!task || shown.has(task)) return;
    const { draft } = input!.data as TaskData;
    // What was being typed in the project window moves along, once.
    if (draft && !useAgents.getState().composers.has(task)) updateComposer(task, draft);
    report(task, true);
  };
  tabClosed = (task) => {
    if (!shown.delete(task)) return;
    send({ type: "closed", task, label: self.label });
    // A window opened for the conversation has nothing left to show.
    setTimeout(() => {
      if (!editorService().openTabs?.().length) void self.close();
    });
  };
  const stops = [
    registerActions(
      [
        { id: "terminal.openAt", title: "Open in Terminal" },
        { id: "file.settings", title: "Settings…" },
        { id: "navigate.selectInProjectView", title: "Select in Project View" },
      ].map(({ id, title }) => ({
        id,
        title,
        hidden: true,
        enabled: () => shown.size > 0,
        run: ({ arg }) => send({ type: "action", action: id, arg }),
      })),
    ),
    installTaskWindowRouting((task, prompt) => {
      if (task && shown.has(task)) void editorService().openInput(taskInput({ task }), { focus: true });
      else send({ type: "open", task, prompt });
      return true;
    }),
    editorService().onActiveInputChange?.(show),
    useAgents.subscribe((state, previous) => {
      if (state.composers !== previous.composers) for (const task of shown.keys()) report(task);
    }),
  ];
  const listening = self.listen<TaskWindowMessage>(TASK_WINDOW, ({ payload: message }) => {
    if (message.type === "sync") for (const task of shown.keys()) report(task, true);
    else if (message.type === "draftSnapshot" && shown.has(message.task)) {
      // This snapshot came from the project (for example, Send to Agent): do not echo it back.
      shown.set(message.task, message.draft);
      updateComposer(message.task, message.draft);
    }
  });
  return () => {
    tabClosed = undefined;
    provideEditorService(editors);
    stops.forEach((stop) => stop?.());
    void listening.then((stop) => stop()).catch(() => {});
  };
}

export function activateTaskWindows(): () => void {
  if (!isTauri() || !windowLabel()) return () => {};
  const aux = auxiliaryWindow();
  return aux ? activateLightweightWindow(aux.parent) : activateProjectWindow();
}

/** Moves the conversation of `task` to a window of its own; false when it stayed here. */
export async function moveTaskToWindow(task: string): Promise<boolean> {
  const open = editorService().openInWindow;
  if (!open || auxiliaryWindow() || opening.has(task) || !useAgents.getState().tasks.has(task)) return false;
  const existing = detached.get(task);
  if (existing) {
    await focusWindow(existing.label);
    return true;
  }
  const draft = composerDraft(task);
  opening.set(task, draft);
  try {
    const title = useAgents.getState().tasks.get(task)?.title;
    const label = await open(taskInput({ task, title }));
    adopt(task, label, opening.get(task) ?? draft);
    return true;
  } catch (error) {
    notifications().notify({
      level: "error",
      title: "Could not move conversation to a new window",
      body: error instanceof Error ? error.message : String(error),
    });
    return false;
  } finally {
    opening.delete(task);
  }
}
