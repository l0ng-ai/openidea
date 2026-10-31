/**
 * Per-document edit pipeline between CodeMirror and the Rust document.
 *
 * Model (classic single-server OT client):
 *   confirmed  — the text at `serverVersion`, i.e. what the backend has acked
 *   inflight   — one change set sent with base `serverVersion`, awaiting reply
 *   buffer     — local changes made since, composed into one change set
 *   local text = confirmed ∘ inflight ∘ buffer
 *
 * Local edits never wait for IPC: `local()` composes into the buffer and a
 * flush is scheduled once per frame, so a burst of keystrokes becomes one
 * `doc_edit`. Only one request is in flight per document, so the backend
 * receives edits strictly in order.
 *
 * Remote patches (`docPatched`) are applied when their base equals
 * `serverVersion`; patches that arrive early (the event can overtake the
 * reply of our own edit) wait in `pendingRemote`. A patch with base ==
 * `serverVersion` while a request is in flight means the backend applied it
 * first, so our request will come back `outOfSync`: we transform inflight /
 * buffer over the patch right away and simply resend the transformed inflight
 * on rejection. If a rejection arrives without the corresponding patch (lost
 * or delayed event), we fetch a snapshot, derive the missing patch by diffing
 * it against `confirmed`, and rebase the same way — local typing survives.
 * Anything unexpected falls back to a hard resync (local content replaced by
 * the snapshot, selections mapped).
 */
import { ChangeSet, Text } from "@codemirror/state";
import type { TextChange } from "@/platform/ipc";
import { minimalChange } from "./diff";

export interface SyncTransport {
  edit(baseVersion: number, changes: TextChange[]): Promise<number>;
  snapshot(): Promise<{ text: string; version: number }>;
}

export interface SyncHost {
  /** Apply a change set (in local-text coordinates) to every view, annotated as remote. */
  applyRemote(changes: ChangeSet, workspaceEdit?: boolean): void;
  /** Called after a hard resync discarded local changes the backend never saw. */
  onDiscarded?(reason: unknown): void;
  /** Non-recoverable transport errors (logged by default). */
  onError?(error: unknown): void;
}

export type Scheduler = (fn: () => void) => void;

/** Next animation frame, or a short timeout when frames are paused (window hidden or occluded). */
export const frameScheduler: Scheduler = (fn) => {
  if (typeof requestAnimationFrame !== "function") {
    setTimeout(fn, 0);
    return;
  }
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(once);
  setTimeout(once, 50);
};

function isOutOfSync(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { kind?: string }).kind === "outOfSync";
}

export function toTextChanges(cs: ChangeSet): TextChange[] {
  const out: TextChange[] = [];
  cs.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return out;
}

interface RemotePatch {
  workspaceEdit?: boolean;
  baseVersion: number;
  version: number;
  changes: TextChange[];
}

/** How long a rejection waits for the matching `docPatched` before fetching a snapshot. */
const RESYNC_GRACE_MS = 60;
const MAX_REBASES = 5;

export class DocSync {
  serverVersion: number;
  confirmed: Text;
  localText: Text;
  inflight: ChangeSet | null = null;
  buffer: ChangeSet | null = null;
  /** Number of edit requests acked (diagnostics / tests). */
  acked = 0;

  private inflightBase = 0;
  /** inflight was transformed over a remote patch; its request will be rejected. */
  private inflightStale = false;
  private rebases = 0;
  private pendingRemote: RemotePatch[] = [];
  private flushScheduled = false;
  private resyncing = false;
  private generation = 0;
  private disposed = false;
  private idleWaiters: Array<() => void> = [];
  private graceTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    version: number,
    text: Text | string,
    private transport: SyncTransport,
    private host: SyncHost,
    private schedule: Scheduler = frameScheduler,
  ) {
    this.serverVersion = version;
    this.confirmed = typeof text === "string" ? Text.of(text.split("\n")) : text;
    this.localText = this.confirmed;
  }

  get idle(): boolean {
    return !this.inflight && !this.buffer && !this.resyncing;
  }

  /** Records a local change (CodeMirror coordinates of the current local text). */
  local(changes: ChangeSet) {
    if (this.disposed || changes.empty) return;
    this.localText = changes.apply(this.localText);
    this.buffer = this.buffer ? this.buffer.compose(changes) : changes;
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.schedule(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }

  /** Sends buffered changes now if nothing is in flight. */
  flush() {
    if (this.disposed || this.inflight || !this.buffer || this.resyncing) return;
    this.inflight = this.buffer;
    this.buffer = null;
    this.inflightStale = false;
    this.send();
  }

  /** Resolves once every local change has been acked by the backend. */
  whenIdle(): Promise<void> {
    this.flush();
    if (this.idle || this.disposed) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** A `docPatched` event for this document. */
  remote(patch: RemotePatch) {
    if (this.disposed || patch.version <= this.serverVersion) return;
    this.pendingRemote.push(patch);
    this.drainRemote();
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.graceTimer);
    this.resolveIdle(true);
  }

  // -------------------------------------------------------------------------

  private send() {
    const inflight = this.inflight!;
    const base = this.serverVersion;
    const gen = this.generation;
    this.inflightBase = base;
    let changes: TextChange[];
    try {
      changes = toTextChanges(inflight);
    } catch (e) {
      this.hardResync(e);
      return;
    }
    this.transport.edit(base, changes).then(
      (version) => {
        if (gen !== this.generation || this.disposed || this.inflight !== inflight) return;
        this.onAck(version);
      },
      (error) => {
        if (gen !== this.generation || this.disposed) return;
        this.onReject(error);
      },
    );
  }

  private onAck(version: number) {
    this.confirmed = this.inflight!.apply(this.confirmed);
    this.serverVersion = version;
    this.inflight = null;
    this.inflightStale = false;
    this.rebases = 0;
    this.acked++;
    this.drainRemote();
    this.flush();
    this.resolveIdle();
  }

  private onReject(error: unknown) {
    if (!isOutOfSync(error)) {
      this.host.onError?.(error);
      this.hardResync(error);
      return;
    }
    if (++this.rebases > MAX_REBASES) {
      this.hardResync(error);
      return;
    }
    if (this.inflightStale || this.serverVersion !== this.inflightBase) {
      // The patch that beat us has already been applied and our change rebased.
      this.resend();
      return;
    }
    // The patch event hasn't arrived yet: give it a moment, then use a snapshot.
    this.resyncing = true;
    clearTimeout(this.graceTimer);
    this.graceTimer = setTimeout(() => {
      if (this.disposed) return;
      if (this.serverVersion !== this.inflightBase) {
        this.resyncing = false;
        this.resend();
      } else {
        void this.rebaseOnSnapshot();
      }
    }, RESYNC_GRACE_MS);
  }

  private resend() {
    this.resyncing = false;
    this.inflightStale = false;
    if (!this.inflight) {
      this.flush();
      return;
    }
    // Fold any buffered changes into the resend to keep request count low.
    if (this.buffer) {
      this.inflight = this.inflight.compose(this.buffer);
      this.buffer = null;
    }
    this.send();
  }

  private async rebaseOnSnapshot() {
    const gen = this.generation;
    let snap: { text: string; version: number };
    try {
      snap = await this.transport.snapshot();
    } catch (e) {
      this.host.onError?.(e);
      this.resyncing = false;
      this.resolveIdle(true);
      return;
    }
    if (gen !== this.generation || this.disposed) return;
    if (snap.version > this.serverVersion) {
      const change = minimalChange(this.confirmed.toString(), snap.text);
      this.pendingRemote = this.pendingRemote.filter((p) => p.version > snap.version);
      this.applyRemoteNow({ baseVersion: this.serverVersion, version: snap.version, changes: change ? [change] : [] });
      this.drainRemote();
    }
    this.resend();
  }

  private drainRemote() {
    for (;;) {
      this.pendingRemote = this.pendingRemote.filter((p) => p.version > this.serverVersion);
      const i = this.pendingRemote.findIndex((p) => p.baseVersion === this.serverVersion);
      if (i < 0) return;
      const [patch] = this.pendingRemote.splice(i, 1);
      this.applyRemoteNow(patch!);
    }
  }

  private applyRemoteNow(patch: RemotePatch) {
    let p: ChangeSet;
    try {
      p = ChangeSet.of(patch.changes, this.confirmed.length);
    } catch (e) {
      this.hardResync(e);
      return;
    }
    this.confirmed = p.apply(this.confirmed);
    this.serverVersion = patch.version;
    if (this.inflight) {
      const inflight = this.inflight.map(p, true);
      p = p.map(this.inflight);
      this.inflight = inflight;
      this.inflightStale = true;
    }
    if (this.buffer) {
      const buffer = this.buffer.map(p, true);
      p = p.map(this.buffer);
      this.buffer = buffer;
    }
    if (p.empty) return;
    this.localText = p.apply(this.localText);
    this.host.applyRemote(p, patch.workspaceEdit);
  }

  /** Last resort: adopt the backend text, dropping unacknowledged local changes. */
  private async hardResync(reason: unknown) {
    const gen = ++this.generation;
    this.resyncing = true;
    clearTimeout(this.graceTimer);
    let snap: { text: string; version: number };
    try {
      snap = await this.transport.snapshot();
    } catch (e) {
      if (gen !== this.generation) return;
      this.host.onError?.(e);
      this.inflight = null;
      this.buffer = null;
      this.resyncing = false;
      this.resolveIdle(true);
      return;
    }
    if (gen !== this.generation || this.disposed) return;
    const hadLocal = !!this.inflight || !!this.buffer;
    const local = this.localText.toString();
    this.inflight = null;
    this.buffer = null;
    this.inflightStale = false;
    this.rebases = 0;
    this.pendingRemote = this.pendingRemote.filter((p) => p.version > snap.version);
    this.confirmed = Text.of(snap.text.split("\n"));
    this.serverVersion = snap.version;
    const change = minimalChange(local, snap.text);
    if (change) {
      const cs = ChangeSet.of([change], local.length);
      this.localText = this.confirmed;
      this.host.applyRemote(cs);
    }
    this.resyncing = false;
    if (hadLocal) this.host.onDiscarded?.(reason);
    this.drainRemote();
    this.flush();
    this.resolveIdle();
  }

  private resolveIdle(force = false) {
    if (!force && !this.idle) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    waiters.forEach((w) => w());
  }
}
