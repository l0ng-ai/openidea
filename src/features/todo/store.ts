/**
 * TODO index: project scan through `search_start`, incremental refresh on
 * file changes and saves, live results from open editors, and settings.
 */
import { Channel } from "@tauri-apps/api/core";
import { create } from "zustand";
import { call, cancelRequestSafe, commands, isTauri, nextRequestId, onIdeEvent } from "./ipc";
import type { RequestId, SearchEvent, SearchQuery, SearchScope } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import { onEditorEvent } from "@/editor/api";
import { buildTodoQuery, itemsFromMatches, useTodoSettings, type TodoItem } from "@/platform/todo";

interface TodoState {
  /** Results of the last project scan, per absolute path. */
  scanned: Map<string, TodoItem[]>;
  /** Scans of open editors (unsaved text), per path. */
  live: Map<string, TodoItem[]>;
  scanning: boolean;
  error: string | null;
  limitHit: boolean;
  scannedOnce: boolean;
  /** Results of the "Scope Based" tab's scan, for the scope `scopedKey`. */
  scoped: Map<string, TodoItem[]>;
  scopedKey: string | null;
  scopedScanning: boolean;
}

export const useTodos = create<TodoState>(() => ({
  scanned: new Map(),
  live: new Map(),
  scanning: false,
  error: null,
  limitHit: false,
  scannedOnce: false,
  scoped: new Map(),
  scopedKey: null,
  scopedScanning: false,
}));

export function setLiveTodos(path: string, items: TodoItem[] | null) {
  useTodos.setState((s) => {
    const live = new Map(s.live);
    if (items) live.set(path, items);
    else if (!live.delete(path)) return s;
    return { live };
  });
}

/** The running scan of a consumer (the project index, the Scope Based tab). */
interface Slot {
  id: RequestId | null;
}

const projectSlot: Slot = { id: null };
const scopeSlot: Slot = { id: null };

function run(
  query: SearchQuery,
  onFile: (path: string, items: TodoItem[]) => void,
  slot: Slot = projectSlot,
): Promise<{ limitHit: boolean } | null> {
  const settings = useTodoSettings.getState();
  return new Promise((resolve, reject) => {
    const id = nextRequestId();
    let settled = false;
    const finish = (v: { limitHit: boolean } | null) => {
      if (settled) return;
      settled = true;
      if (slot.id === id) slot.id = null;
      resolve(v);
    };
    if (slot.id !== null) cancelRequestSafe(slot.id);
    slot.id = id;
    const channel = new Channel<SearchEvent>();
    channel.onmessage = (ev) => {
      if (settled || slot.id !== id) return;
      if (ev.type === "file") onFile(ev.file.path, itemsFromMatches(ev.file, settings));
      else finish(ev.summary.cancelled ? null : { limitHit: ev.summary.limitHit });
    };
    call(commands.searchStart(id, query, channel)).then(
      () => setTimeout(() => finish(null), 2000),
      (e) => {
        if (settled) return;
        settled = true;
        if (slot.id === id) slot.id = null;
        reject(e);
      },
    );
  });
}

let scanSeq = 0;

/** Rescans the whole project. */
export async function scanProject(): Promise<void> {
  const root = useProject.getState().project?.root;
  const query = buildTodoQuery(useTodoSettings.getState());
  if (!root || !isTauri()) {
    useTodos.setState({
      scanned: new Map(),
      scanning: false,
      scannedOnce: true,
      error: isTauri() ? null : "TODO scanning needs the desktop app",
    });
    return;
  }
  if (!query) {
    useTodos.setState({ scanned: new Map(), scanning: false, scannedOnce: true, error: null });
    return;
  }
  const seq = ++scanSeq;
  pending.clear();
  useTodos.setState({ scanning: true, error: null });
  const found = new Map<string, TodoItem[]>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    flushTimer = null;
    if (seq === scanSeq) useTodos.setState({ scanned: new Map(found) });
  };
  try {
    const r = await run(query, (path, items) => {
      if (items.length) found.set(path, items);
      flushTimer ??= setTimeout(flush, 150);
    });
    if (seq !== scanSeq) return;
    if (flushTimer) clearTimeout(flushTimer);
    if (!r) {
      useTodos.setState({ scanning: false });
      return;
    }
    useTodos.setState({ scanned: found, scanning: false, limitHit: r.limitHit, scannedOnce: true });
  } catch (e) {
    if (seq !== scanSeq) return;
    if (flushTimer) clearTimeout(flushTimer);
    useTodos.setState({ scanning: false, scannedOnce: true, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Rescans a few files (after saves / external changes). */
export async function rescanFiles(paths: string[], removed: string[] = []): Promise<void> {
  if (!isTauri()) return;
  if (projectSlot.id !== null) {
    // Wait for the running scan instead of cancelling it.
    queueRefresh(paths, removed, 1000);
    return;
  }
  if (removed.length) dropPaths(removed);
  const query = buildTodoQuery(useTodoSettings.getState(), { kind: "files", paths });
  if (!query || !paths.length) return;
  const found = new Map<string, TodoItem[]>();
  try {
    await run(query, (path, items) => found.set(path, items));
  } catch {
    return;
  }
  useTodos.setState((s) => {
    const scanned = new Map(s.scanned);
    for (const p of paths) {
      const items = found.get(p);
      if (items?.length) scanned.set(p, items);
      else scanned.delete(p);
    }
    return { scanned };
  });
}

function dropPaths(paths: string[]) {
  useTodos.setState((s) => {
    const scanned = new Map(s.scanned);
    let changed = false;
    for (const p of paths) {
      for (const k of [...scanned.keys()]) {
        if (k === p || k.startsWith(`${p}/`)) {
          scanned.delete(k);
          changed = true;
        }
      }
    }
    return changed ? { scanned } : s;
  });
}

let scopeSeq = 0;

/**
 * Scans `scope` for the Scope Based tab (null: nothing to scan). `key` names the
 * scope, so the view can tell whether the results are for the chosen one.
 */
export async function scanScope(key: string, scope: SearchScope | null): Promise<void> {
  const seq = ++scopeSeq;
  const query = scope && isTauri() ? buildTodoQuery(useTodoSettings.getState(), scope) : null;
  if (!query) {
    if (scopeSlot.id !== null) cancelRequestSafe(scopeSlot.id);
    useTodos.setState({ scoped: new Map(), scopedKey: key, scopedScanning: false });
    return;
  }
  useTodos.setState((s) => ({
    scopedScanning: true,
    scoped: s.scopedKey === key ? s.scoped : new Map(),
    scopedKey: key,
  }));
  const found = new Map<string, TodoItem[]>();
  try {
    const r = await run(
      query,
      (path, items) => {
        if (items.length) found.set(path, items);
      },
      scopeSlot,
    );
    if (seq !== scopeSeq || !r) return;
    useTodos.setState({ scoped: found, scopedScanning: false });
  } catch {
    if (seq === scopeSeq) useTodos.setState({ scoped: new Map(), scopedScanning: false });
  }
}

// --- incremental refresh -------------------------------------------------------

const pending = new Set<string>();
const pendingRemoved = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const MAX_INCREMENTAL = 200;

export function queueRefresh(changed: string[], removed: string[] = [], delay = 600) {
  changed.forEach((p) => pending.add(p));
  removed.forEach((p) => pendingRemoved.add(p));
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    const paths = [...pending];
    const gone = [...pendingRemoved];
    pending.clear();
    pendingRemoved.clear();
    if (paths.length > MAX_INCREMENTAL) void scanProject();
    else void rescanFiles(paths, gone);
  }, delay);
}

const IGNORED = /\/(\.git|node_modules|target|dist|build|\.idea|\.gradle|__pycache__)\//;

/** Wires project open / fs events / saves to the index; returns a disposer. */
export function installTodoIndex(): () => void {
  let root = useProject.getState().project?.root ?? null;
  let startTimer: ReturnType<typeof setTimeout> | null = null;
  const start = () => {
    if (startTimer) clearTimeout(startTimer);
    // Let the workbench settle before scanning.
    startTimer = setTimeout(() => void scanProject(), 1500);
  };
  if (root) start();
  const unsubProject = useProject.subscribe((s) => {
    const r = s.project?.root ?? null;
    if (r === root) return;
    root = r;
    useTodos.setState({
      scanned: new Map(),
      live: new Map(),
      scannedOnce: false,
      error: null,
      scoped: new Map(),
      scopedKey: null,
    });
    if (r) start();
  });
  let settings = useTodoSettings.getState();
  const unsubSettings = useTodoSettings.subscribe((s) => {
    if (
      s.patterns === settings.patterns &&
      s.caseSensitive === settings.caseSensitive &&
      s.commentsOnly === settings.commentsOnly
    )
      return;
    settings = s;
    if (root) start();
  });
  const unsubFs = onIdeEvent("fsChanged", (e) => {
    const changed = [...e.created, ...e.modified].filter((p) => !IGNORED.test(p));
    const removed = e.removed.filter((p) => !IGNORED.test(p));
    if (changed.length || removed.length) queueRefresh(changed, removed);
  });
  const unsubEditor = onEditorEvent((e) => {
    if (e.type === "docSaved") queueRefresh([e.path], [], 100);
    else if (e.type === "docClosed") setLiveTodos(e.path, null);
  });
  return () => {
    if (startTimer) clearTimeout(startTimer);
    if (timer) clearTimeout(timer);
    if (projectSlot.id !== null) cancelRequestSafe(projectSlot.id);
    if (scopeSlot.id !== null) cancelRequestSafe(scopeSlot.id);
    unsubProject();
    unsubSettings();
    unsubFs();
    unsubEditor();
  };
}
