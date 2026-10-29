/** Background task progress (from `task` / `indexState` backend events). */
import { create } from "zustand";
import { commands, IpcError, onIdeEvent } from "@/platform/ipc";
import { tx } from "@/platform/i18n";

export interface BackgroundTask {
  id: number | string;
  title: string;
  message: string | null;
  /** 0..1, or null when indeterminate. */
  fraction: number | null;
  done: boolean;
  startedAt: number;
  /** Stops the task (shown as a cancel button in the Background Tasks popup). Call it through `cancelTask`. */
  cancel?: () => void;
  /** Why the task can't be stopped (a disabled cancel button with this tooltip), when it has no `cancel`. */
  uncancellable?: string;
  /** Cancel was requested: shown as "Cancelling…" until the task ends, then removed at once. */
  cancelling?: boolean;
  /** Waiting for the tasks ahead of it in its queue (`queueTask`); cancelling drops it. */
  queued?: boolean;
}

interface TaskState {
  tasks: BackgroundTask[];
  indexing: { files: number; symbols: number } | null;
}

export const useTasks = create<TaskState>(() => ({ tasks: [], indexing: null }));

const DONE_LINGER_MS = 600;
/** Backend tasks that finish sooner (a language server's per-keystroke work) never reach the status bar. */
const SHOW_DELAY_MS = 500;
export const INDEX_TASK_ID = "indexing";

export type TaskUpdate = Omit<BackgroundTask, "startedAt" | "cancelling" | "queued">;

export function upsertTask(t: TaskUpdate) {
  let cancelled = false;
  useTasks.setState((s) => {
    const i = s.tasks.findIndex((x) => x.id === t.id);
    const tasks = [...s.tasks];
    if (i >= 0) {
      cancelled = !!tasks[i]!.cancelling;
      // Progress that arrives after Cancel keeps saying "Cancelling…".
      tasks[i] = { ...tasks[i]!, ...t, queued: false, message: cancelled ? tasks[i]!.message : t.message };
    } else if (!t.done) tasks.push({ ...t, startedAt: Date.now() });
    else return s;
    return { tasks };
  });
  // A cancelled task leaves without the finished (full) progress bar.
  if (t.done) {
    if (cancelled) removeTask(t.id);
    else setTimeout(() => removeTask(t.id), DONE_LINGER_MS);
  }
}

export function removeTask(id: BackgroundTask["id"]) {
  useTasks.setState((s) => ({ tasks: s.tasks.filter((t) => t.id !== id) }));
}

/** Whether `t` offers a working Cancel now. */
export function canCancel(t: BackgroundTask): boolean {
  return !!t.cancel && !t.done && !t.cancelling;
}

/** Cancels task `id`: it shows "Cancelling…" until its producer ends it. */
export function cancelTask(id: BackgroundTask["id"]) {
  const t = useTasks.getState().tasks.find((x) => x.id === id);
  if (!t || !canCancel(t)) return;
  useTasks.setState((s) => ({
    tasks: s.tasks.map((x) => (x.id === id ? { ...x, cancelling: true, message: tx("Cancelling…") } : x)),
  }));
  t.cancel!();
}

export function setIndexing(indexing: boolean, files: number, symbols: number) {
  useTasks.setState({ indexing: indexing ? { files, symbols } : null });
  upsertTask({
    id: INDEX_TASK_ID,
    title: "Indexing",
    message: indexing ? tx`${files.toLocaleString()} files · ${symbols.toLocaleString()} symbols` : null,
    fraction: null,
    done: !indexing,
    uncancellable: tx("Code insight needs the index; it can't be stopped"),
  });
}

// ---------------------------------------------------------------------------
// Queues: tasks that run one at a time, the rest waiting (listed, cancellable).

/** The error a task cancelled while queued rejects with (`isCancelled` is true for it). */
export function queuedCancelled(): IpcError {
  return new IpcError({ kind: "cancelled", message: "Cancelled" });
}

interface Waiter {
  id: BackgroundTask["id"];
  start: () => void;
}

interface Queue {
  limit: number;
  running: number;
  waiting: Waiter[];
}

const queues = new Map<string, Queue>();

function startNext(q: Queue) {
  while (q.running < q.limit && q.waiting.length) {
    const w = q.waiting.shift()!;
    // The queue's Cancel is spent; the work sets its own (or says why it has none).
    useTasks.setState((s) => ({
      tasks: s.tasks.map((t) => (t.id === w.id ? { ...t, queued: false, cancel: undefined } : t)),
    }));
    w.start();
  }
}

/**
 * Runs `work` once the tasks queued before it in `queue` are done (`limit` run at a time).
 * Until then task `task.id` is listed as queued, and its Cancel drops it: `work` never
 * starts and the promise rejects with a cancellation (`isCancelled`). Once started,
 * `work` reports its own progress with `upsertTask` under `task.id` and ends the task.
 */
export function queueTask<T>(
  queue: string,
  task: { id: BackgroundTask["id"]; title: string },
  work: () => Promise<T>,
  limit = 1,
): Promise<T> {
  let q = queues.get(queue);
  if (!q) queues.set(queue, (q = { limit, running: 0, waiting: [] }));
  const slot = q;
  const run = async () => {
    slot.running++;
    try {
      return await work();
    } finally {
      slot.running--;
      startNext(slot);
    }
  };
  if (slot.running < slot.limit && !slot.waiting.length) return run();
  return new Promise<T>((resolve, reject) => {
    const waiter: Waiter = { id: task.id, start: () => void run().then(resolve, reject) };
    slot.waiting.push(waiter);
    const cancel = () => {
      const i = slot.waiting.indexOf(waiter);
      if (i < 0) return;
      slot.waiting.splice(i, 1);
      removeTask(task.id);
      reject(queuedCancelled());
    };
    const queued: BackgroundTask = {
      id: task.id,
      title: task.title,
      message: tx("Waiting for other tasks"),
      fraction: null,
      done: false,
      startedAt: Date.now(),
      queued: true,
      cancel,
    };
    useTasks.setState((s) => ({ tasks: [...s.tasks.filter((t) => t.id !== task.id), queued] }));
  });
}

// ---------------------------------------------------------------------------
// Tasks that often finish at once

const pending = new Map<BackgroundTask["id"], ReturnType<typeof setTimeout>>();
const latest = new Map<BackgroundTask["id"], TaskUpdate>();

/** `upsertTask`, except that a task ending within `SHOW_DELAY_MS` of its start is never shown. */
export function upsertTaskSoon(t: TaskUpdate) {
  if (useTasks.getState().tasks.some((x) => x.id === t.id)) return upsertTask(t);
  if (t.done) {
    clearTimeout(pending.get(t.id));
    pending.delete(t.id);
    latest.delete(t.id);
    return;
  }
  latest.set(t.id, t);
  if (pending.has(t.id)) return;
  pending.set(
    t.id,
    setTimeout(() => {
      pending.delete(t.id);
      const last = latest.get(t.id);
      latest.delete(t.id);
      if (last) upsertTask(last);
    }, SHOW_DELAY_MS),
  );
}

export function installTaskEvents(): () => void {
  const notCancellable = tx("This task can't be cancelled");
  const a = onIdeEvent("task", (e) =>
    upsertTaskSoon({
      id: e.id,
      title: e.title,
      message: e.message,
      fraction: e.fraction,
      done: e.done,
      cancel: e.cancellable ? () => void commands.cancelTask(e.id).catch(() => {}) : undefined,
      uncancellable: e.cancellable ? undefined : notCancellable,
    }),
  );
  const b = onIdeEvent("indexState", (e) => setIndexing(e.indexing, e.files, e.symbols));
  return () => {
    pending.forEach(clearTimeout);
    pending.clear();
    latest.clear();
    a();
    b();
  };
}
