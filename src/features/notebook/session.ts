import { Channel } from "@tauri-apps/api/core";
import type { EditorState } from "@codemirror/state";
import type { NotebookSnapshot, NotebookEdit, NotebookOutputEvent, Sdk, RequestId } from "@/bindings";
import { call, commands, IpcError, isTauri, nextRequestId, onIdeEvent } from "@/platform/ipc";
import { notifyEditorDocumentChanged } from "@/workbench/contributions";
import { OutputReducer } from "./outputs";

export const notebookBackend = {
  open: (path: string) => call(commands.notebookOpen(path)),
  get: (id: string) => call(commands.notebookGet(id)),
  edit: (id: string, version: number, edit: NotebookEdit) => call(commands.notebookEdit(id, version, edit)),
  save: (id: string) => call(commands.notebookSave(id)),
  reload: (id: string) => call(commands.notebookReload(id)),
  undo: (id: string) => call(commands.notebookUndo(id)),
  redo: (id: string) => call(commands.notebookRedo(id)),
  close: (id: string) => call(commands.notebookClose(id)),
  interrupt: (id: string) => call(commands.notebookInterrupt(id)),
  restart: (id: string) => call(commands.notebookRestart(id)),
  execute: (
    id: string,
    cells: string[],
    python: string | null,
    request: RequestId,
    output: Channel<NotebookOutputEvent>,
  ) => call(commands.notebookExecute(id, cells, python, request, output)),
  environments: () => Promise.all([call(commands.sdkDetect("python")), call(commands.sdkPythonEffective())]),
  cancel: (request: RequestId) => commands.cancelRequest(request),
};

type Pending = { edit: NotebookEdit | { type: "undo" } | { type: "redo" }; committed: boolean };
type ErrorOwner = "load" | "mutation" | "save" | "execution" | "kernel" | "environment" | "reload" | "other";

const PYTHON_KEY = "openidea.notebook.python:";
function savedPython(path: string): string | null {
  try {
    return globalThis.localStorage?.getItem(PYTHON_KEY + path) || null;
  } catch {
    return null;
  }
}
export interface NotebookViewState {
  snapshot: NotebookSnapshot | null;
  loading: boolean;
  error: string | null;
  running: boolean;
  frozen: boolean;
  kernel: string;
  python: string | null;
  environments: Sdk[];
  pending: number;
}

/** One session/queue per file; tabs and mounted React views do not own its lifetime. */
export class NotebookSession {
  private state: NotebookViewState = {
    snapshot: null,
    loading: false,
    error: null,
    running: false,
    frozen: false,
    kernel: "idle",
    python: null,
    environments: [],
    pending: 0,
  };
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private pending: Pending[] = [];
  private pumping: Promise<void> | null = null;
  private blocked = false;
  private disposed = false;
  private authoritativeVersion = -1;
  private executionCancelled = false;
  private generation = 0;
  private execution: Promise<void> | null = null;
  private request: RequestId | null = null;
  private refreshing: Promise<void> | null = null;
  private refreshAgain = false;
  private output = new OutputReducer();
  private stopEvents: (() => void) | null = null;
  private errors = new Map<ErrorOwner, { cause: unknown; message: string }>();
  // EditorState contains selection and syntax state, but deliberately no local history.
  readonly editors = new Map<string, EditorState>();
  readonly markdownEditing = new Set<string>();
  selectedCell: string | null = null;
  scrollTop = 0;

  constructor(
    readonly path: string,
    private backend = notebookBackend,
    private desktop = isTauri(),
  ) {
    this.state = { ...this.state, python: savedPython(path) };
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getState = () => this.state;
  isDirty = () => this.pending.length > 0 || !!this.state.snapshot?.dirty;
  private publish(patch: Partial<NotebookViewState> = {}) {
    const error = [...this.errors.values()].at(-1)?.message ?? null;
    this.state = { ...this.state, ...patch, error, pending: this.pending.length };
    this.listeners.forEach((listener) => listener());
    notifyEditorDocumentChanged();
  }
  report(error: unknown) {
    this.reportOperation(error, "other");
  }
  private reportOperation(error: unknown, owner: ErrorOwner) {
    // UI promise catches and operations waiting on flush re-report the same
    // failure. Keep its original owner so only the real recovery clears it.
    if ([...this.errors.values()].some((entry) => entry.cause === error)) return;
    this.errors.delete(owner);
    this.errors.set(owner, { cause: error, message: error instanceof Error ? error.message : String(error) });
    this.publish();
  }
  private recover(...owners: ErrorOwner[]) {
    for (const owner of owners) this.errors.delete(owner);
    this.publish();
  }
  private accept(snapshot: NotebookSnapshot) {
    if (this.disposed) return;
    const current = this.state.snapshot;
    if (current && (current.id !== snapshot.id || snapshot.version < this.authoritativeVersion)) return;
    this.authoritativeVersion = snapshot.version;
    if (current && current.version > snapshot.version) {
      // Only Channel output reductions can be newer than the latest full
      // snapshot. Take acknowledged user fields/order, retain newer outputs.
      const outputCells = new Map(current.cells.map((cell) => [cell.id, cell]));
      snapshot = {
        ...snapshot,
        version: current.version,
        dirty: current.dirty,
        cells: snapshot.cells.map((cell) => {
          const newer = outputCells.get(cell.id);
          return newer && cell.cellType === "code"
            ? { ...cell, outputs: newer.outputs, executionCount: newer.executionCount }
            : cell;
        }),
      };
    }
    this.publish({ snapshot });
    const live = new Set(snapshot.cells.map((cell) => cell.id));
    for (const id of this.editors.keys()) if (!live.has(id)) this.editors.delete(id);
  }
  load(opened?: NotebookSnapshot): Promise<void> {
    if (this.loading) return this.loading;
    if (this.disposed) return Promise.reject(new Error("Notebook is closed"));
    this.publish({ loading: true });
    this.loading = (async () => {
      if (!this.desktop) throw new Error("Notebook editing and execution require the desktop app.");
      const snapshot = opened ?? (await this.backend.open(this.path));
      // Closing a still-loading tab must release the real backend document too.
      if (this.disposed) {
        await this.backend.close(snapshot.id);
        return;
      }
      this.accept(snapshot);
      this.recover("load");
      this.stopEvents = onIdeEvent("notebookKernel", (event) => {
        if (this.disposed || event.path !== snapshot.path || event.id !== snapshot.id) return;
        this.publish({ kernel: event.state });
        if (event.message) this.reportOperation(event.message, "kernel");
      });
      void this.detectEnvironments();
    })()
      .catch((error) => {
        this.reportOperation(error, "load");
        this.loading = null;
        throw error;
      })
      .finally(() => this.publish({ loading: false }));
    return this.loading;
  }
  async detectEnvironments() {
    try {
      const [environments, effective] = await this.backend.environments();
      if (!this.disposed) {
        this.publish({ environments, python: this.state.python ?? effective });
        this.recover("environment");
      }
    } catch (error) {
      if (!this.disposed) this.reportOperation(error, "environment");
    }
  }
  selectPython(python: string) {
    if (this.state.running || this.state.frozen) return;
    try {
      globalThis.localStorage?.setItem(PYTHON_KEY + this.path, python);
    } catch {
      /* Interpreter preference is optional when storage is unavailable. */
    }
    this.publish({ python });
  }
  pendingSources() {
    const sources = new Map<string, string>();
    for (const { edit } of this.pending) if (edit.type === "setSource") sources.set(edit.cell, edit.source);
    return [...sources].map(([cell, source]) => ({ cell, source }));
  }

  /** Pending source is overlaid, never replaced by an older IPC response. */
  cells() {
    const cells = this.state.snapshot?.cells ?? [];
    return cells.map((cell) => {
      let source = cell.source;
      for (const item of this.pending)
        if (item.edit.type === "setSource" && item.edit.cell === cell.id) source = item.edit.source;
      return source === cell.source ? cell : { ...cell, source };
    });
  }
  edit(edit: NotebookEdit) {
    if (this.disposed || this.state.frozen || !this.state.snapshot) return;
    if (this.state.running && edit.type !== "setSource") {
      this.reportOperation(new Error("Stop execution before changing notebook structure."), "mutation");
      return;
    }
    const last = this.pending.at(-1);
    // Never mutate an in-flight intent; only coalesce an unsent tail.
    if (
      edit.type === "setSource" &&
      last &&
      !last.committed &&
      last !== this.inflight &&
      last.edit.type === "setSource" &&
      last.edit.cell === edit.cell
    )
      last.edit = edit;
    else this.pending.push({ edit, committed: false });
    this.publish();
    if (!this.blocked) void this.pump().catch(() => {});
  }
  private inflight: Pending | null = null;
  private pump(): Promise<void> {
    if (this.pumping) return this.pumping;
    this.pumping = Promise.resolve()
      .then(async () => {
        while (this.pending.length && !this.disposed) {
          const item = this.pending[0]!;
          this.inflight = item;
          let snapshot = this.state.snapshot!;
          if (!item.committed) {
            try {
              const result =
                item.edit.type === "undo" || item.edit.type === "redo"
                  ? await this.backend[item.edit.type](snapshot.id)
                  : await this.backend.edit(snapshot.id, snapshot.version, item.edit);
              item.committed = true;
              this.accept(result);
            } catch (error) {
              if (
                !(error instanceof IpcError) ||
                error.kind !== "outOfSync" ||
                item.edit.type === "undo" ||
                item.edit.type === "redo"
              )
                throw error;
              snapshot = await this.backend.get(snapshot.id);
              this.accept(snapshot);
              // Semantic stable-id rebase, once. Missing/deleted targets remain pending
              // with an actionable backend error rather than silently dropping user intent.
              const result = await this.backend.edit(snapshot.id, snapshot.version, item.edit);
              item.committed = true;
              this.accept(result);
            }
          }
          this.pending.shift();
          this.recover("mutation");
        }
      })
      .catch((error) => {
        this.blocked = true;
        this.reportOperation(error, "mutation");
        throw error;
      })
      .finally(() => {
        this.inflight = null;
        this.pumping = null;
      });
    return this.pumping;
  }
  async flush() {
    await this.load();
    this.blocked = false;
    await this.pump();
    if (this.pending.length)
      throw new Error("Notebook edits have not been committed. Retry edits or discard explicitly.");
  }
  async save() {
    try {
      await this.flush();
      this.accept(await this.backend.save(this.state.snapshot!.id));
      this.recover("save");
    } catch (error) {
      this.reportOperation(error, "save");
      throw error;
    }
  }
  private async history(direction: "undo" | "redo") {
    if (this.state.running || this.state.frozen) throw new Error("Stop execution before undo or redo.");
    if (!this.state.snapshot) await this.load();
    if (this.state.running || this.state.frozen || this.disposed) throw new Error("Notebook is busy or closing.");
    // History is a queue barrier: later typing must commit AFTER undo/redo, not
    // race it and get overwritten by the history response.
    this.pending.push({ edit: { type: direction }, committed: false });
    this.publish();
    this.blocked = false;
    await this.pump();
  }
  undo = () => this.history("undo");
  redo = () => this.history("redo");

  private refresh(): Promise<void> {
    this.refreshAgain = true;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      while (this.refreshAgain && !this.disposed) {
        this.refreshAgain = false;
        const id = this.state.snapshot!.id;
        this.accept(await this.backend.get(id));
      }
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }
  execute(cells?: string[]): Promise<void> {
    if (this.state.running || this.state.frozen || this.disposed)
      return Promise.reject(new Error("Notebook is busy or closing."));
    this.publish({ running: true });
    this.executionCancelled = false;
    const generation = ++this.generation;
    this.output.reset();
    this.execution = (async () => {
      await this.flush();
      if (this.state.frozen || this.executionCancelled || generation !== this.generation) return;
      const snapshot = this.state.snapshot!;
      const ids = cells ?? snapshot.cells.filter((cell) => cell.cellType === "code").map((cell) => cell.id);
      if (!ids.length) return;
      const request = nextRequestId();
      this.request = request;
      const channel = new Channel<NotebookOutputEvent>();
      let buffered: NotebookOutputEvent[] = [];
      let frame: number | null = null;
      let overflow = false;
      channel.onmessage = (event) => {
        if (this.disposed || generation !== this.generation || event.id !== snapshot.id) return;
        // Bound retained Channel work. A flood recovers from backend state instead
        // of retaining an unbounded browser queue or losing authoritative output.
        if (buffered.length < 256 && !overflow) buffered.push(event);
        else {
          overflow = true;
          buffered = [];
          this.output.recover();
        }
        if (frame !== null) return;
        frame = requestAnimationFrame(() => {
          frame = null;
          if (this.disposed || generation !== this.generation) {
            buffered = [];
            return;
          }
          let current = this.state.snapshot!;
          let refresh = overflow;
          overflow = false;
          for (const item of buffered) {
            const result = this.output.reduce(current, item);
            current = result.snapshot;
            refresh ||= result.refresh;
          }
          buffered = [];
          if (current !== this.state.snapshot) this.publish({ snapshot: current });
          if (refresh) void this.refresh().catch((error) => this.reportOperation(error, "execution"));
        });
      };
      try {
        const result = await this.backend.execute(snapshot.id, ids, this.state.python, request, channel);
        if (generation === this.generation) this.accept(result);
      } finally {
        if (generation === this.generation && !this.disposed) await this.refresh();
      }
      if (generation === this.generation && !this.executionCancelled) this.recover("execution", "kernel");
    })()
      .catch((error) => {
        this.reportOperation(error, "execution");
        throw error;
      })
      .finally(() => {
        this.request = null;
        this.execution = null;
        this.publish({ running: false });
      });
    return this.execution;
  }
  async interrupt() {
    this.executionCancelled = true;
    if (!this.state.snapshot) return;
    // Batch cancellation precedes interrupt in the host; cancelRequest is an
    // additional route for requests still waiting on kernel admission/startup.
    try {
      if (this.request !== null) await this.backend.cancel(this.request);
    } finally {
      await this.backend.interrupt(this.state.snapshot.id);
    }
  }
  private async drain() {
    const execution = this.execution;
    if (!execution) return;
    try {
      await this.interrupt();
    } finally {
      await execution.catch(() => {});
    }
  }
  async restart() {
    if (this.state.frozen) throw new Error("Notebook is closing.");
    this.publish({ frozen: true });
    ++this.generation;
    try {
      await this.drain();
      await this.flush();
      this.output.reset();
      this.accept(await this.backend.restart(this.state.snapshot!.id));
      this.publish({ kernel: "idle" });
      this.recover("execution", "kernel");
    } catch (error) {
      this.reportOperation(error, "kernel");
      throw error;
    } finally {
      this.publish({ frozen: false });
    }
  }
  async prepareClose() {
    this.publish({ frozen: true });
    if (this.loading) await this.loading.catch(() => {});
    // An invalid/unavailable file never acquired a backend document.
    if (!this.state.snapshot) return;
    try {
      await this.flush();
    } finally {
      await this.drain();
    }
  }
  cancelClose() {
    if (!this.disposed) this.publish({ frozen: false });
  }
  async discard() {
    this.publish({ frozen: true });
    ++this.generation;
    try {
      await this.drain();
      if (this.pumping) await this.pumping.catch(() => {});
      const snapshot = this.state.snapshot;
      if (!snapshot) return;
      const reloaded = await this.backend.reload(snapshot.id);
      this.pending = [];
      this.blocked = false;
      this.editors.clear();
      this.output.reset();
      this.accept(reloaded);
      this.recover("mutation", "save", "reload");
    } catch (error) {
      this.reportOperation(error, "reload");
      throw error;
    }
  }
  async close() {
    this.publish({ frozen: true });
    ++this.generation;
    try {
      // The host close interrupts, drains and shuts down authoritatively, and a
      // retired project already rejects interrupt. Never let that skip release.
      await this.drain().catch(() => {});
      if (this.pumping) await this.pumping.catch(() => {});
      if (this.loading) await this.loading.catch(() => {});
      const snapshot = this.state.snapshot;
      if (snapshot) await this.backend.close(snapshot.id);
    } finally {
      this.disposed = true;
      this.stopEvents?.();
      this.editors.clear();
      this.listeners.clear();
    }
  }
}

const sessions = new Map<string, NotebookSession>();
export function notebookSession(path: string): NotebookSession {
  let session = sessions.get(path);
  if (!session) {
    session = new NotebookSession(path);
    sessions.set(path, session);
  }
  return session;
}
export function existingNotebookSession(path: string) {
  return sessions.get(path);
}
export async function closeNotebook(path: string) {
  const session = sessions.get(path);
  if (!session) return;
  try {
    await session.close();
  } finally {
    if (sessions.get(path) === session) sessions.delete(path);
  }
}
