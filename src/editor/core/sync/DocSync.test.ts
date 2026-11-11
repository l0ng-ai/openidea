import { describe, expect, it, vi } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import type { TextChange } from "@/platform/ipc";
import { DocSync, toTextChanges } from "./DocSync";
import { minimalChanges } from "./diff";

function apply(text: string, changes: TextChange[]) {
  let out = "";
  let pos = 0;
  for (const c of changes) {
    out += text.slice(pos, c.from) + c.insert;
    pos = c.to;
  }
  return out + text.slice(pos);
}

function numberedLines(count: number) {
  return Array.from({ length: count }, (_, i) => `line ${i}\n`).join("");
}

class OutOfSync extends Error {
  kind = "outOfSync";
}

/** Backend double: requests are queued and processed explicitly, in order. */
class FakeServer {
  version = 0;
  edits: Array<{ base: number; changes: TextChange[] }> = [];
  private queue: Array<() => void> = [];
  snapshots = 0;
  /** Snapshots still to reject (a transient IPC or remote-host failure). */
  failSnapshots = 0;
  failNext: unknown = null;
  constructor(public text: string) {}

  transport = {
    edit: (base: number, changes: TextChange[]) =>
      new Promise<number>((resolve, reject) => {
        this.queue.push(() => {
          this.edits.push({ base, changes });
          if (this.failNext) {
            const e = this.failNext;
            this.failNext = null;
            reject(e);
            return;
          }
          if (base !== this.version) {
            reject(new OutOfSync(`base ${base} != ${this.version}`));
            return;
          }
          this.text = apply(this.text, changes);
          resolve(++this.version);
        });
      }),
    snapshot: async () => {
      this.snapshots++;
      if (this.failSnapshots > 0) {
        this.failSnapshots--;
        throw { kind: "unavailable", message: "snapshot failed" };
      }
      return { text: this.text, version: this.version };
    },
  };

  /** Backend-originated change; returns the event the UI would receive. */
  patch(changes: TextChange[]) {
    const baseVersion = this.version;
    this.text = apply(this.text, changes);
    this.version++;
    return { baseVersion, version: this.version, changes };
  }

  /** Processes one request synchronously; its reply is delivered on the microtask queue. */
  step() {
    this.queue.shift()?.();
  }

  pending() {
    return this.queue.length;
  }

  async processAll() {
    while (this.queue.length) {
      this.queue.shift()!();
      await flushMicrotasks();
    }
  }
}

async function flushMicrotasks() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function setup(initial: string) {
  const server = new FakeServer(initial);
  const view = { text: Text.of(initial.split("\n")) };
  const scheduled: Array<() => void> = [];
  const host = {
    applyRemote: vi.fn((cs: ChangeSet) => {
      view.text = cs.apply(view.text);
    }),
    onDiscarded: vi.fn(),
    onError: vi.fn(),
  };
  const sync = new DocSync(0, initial, server.transport, host, (fn) => scheduled.push(fn));
  const type = (from: number, to: number, insert: string) => {
    const cs = ChangeSet.of([{ from, to, insert }], view.text.length);
    view.text = cs.apply(view.text);
    sync.local(cs);
  };
  const frame = () => scheduled.splice(0).forEach((f) => f());
  return { server, view, sync, type, frame, host };
}

describe("DocSync", () => {
  it("coalesces a burst of keystrokes into one ordered edit per frame", async () => {
    const { server, view, sync, type, frame } = setup("hello");
    type(5, 5, " ");
    type(6, 6, "w");
    type(7, 7, "o");
    expect(server.pending()).toBe(0);
    frame();
    expect(server.pending()).toBe(1);
    // Typing while the request is in flight is buffered, not sent.
    type(8, 8, "rld");
    frame();
    expect(server.pending()).toBe(1);
    await server.processAll();
    expect(server.edits.map((e) => e.base)).toEqual([0, 1]);
    expect(server.edits[0]!.changes).toEqual([{ from: 5, to: 5, insert: " wo" }]);
    expect(server.text).toBe("hello world");
    expect(view.text.toString()).toBe("hello world");
    expect(sync.serverVersion).toBe(2);
    expect(sync.idle).toBe(true);
  });

  it("uses original-document coordinates for multi-range change sets", async () => {
    const { server, sync, view } = setup("aaa\nbbb\nccc");
    const cs = ChangeSet.of(
      [
        { from: 0, to: 0, insert: "// " },
        { from: 4, to: 4, insert: "// " },
      ],
      view.text.length,
    );
    view.text = cs.apply(view.text);
    sync.local(cs);
    expect(toTextChanges(cs)).toEqual([
      { from: 0, to: 0, insert: "// " },
      { from: 4, to: 4, insert: "// " },
    ]);
    sync.flush();
    await server.processAll();
    expect(server.text).toBe("// aaa\n// bbb\nccc");
  });

  it("applies remote patches when idle", () => {
    const { server, view, sync, host } = setup("abc");
    sync.remote(server.patch([{ from: 3, to: 3, insert: "def" }]));
    expect(view.text.toString()).toBe("abcdef");
    expect(host.applyRemote).toHaveBeenCalledTimes(1);
    expect(sync.serverVersion).toBe(1);
  });

  it("ignores duplicate / stale patches", () => {
    const { server, view, sync } = setup("abc");
    const e = server.patch([{ from: 0, to: 0, insert: "x" }]);
    sync.remote(e);
    sync.remote(e);
    expect(view.text.toString()).toBe("xabc");
  });

  it("transforms pending local changes over a remote patch and resends after outOfSync", async () => {
    const { server, view, sync, type, frame } = setup("let a = 1;");
    type(10, 10, " // one"); // inflight
    frame();
    type(0, 0, ">"); // buffered
    // Formatter runs on the backend before our edit arrives.
    const ev = server.patch([{ from: 4, to: 5, insert: "alpha" }]);
    sync.remote(ev);
    expect(view.text.toString()).toBe(">let alpha = 1; // one");
    await server.processAll(); // first request rejected, transformed one resent
    await server.processAll();
    expect(server.text).toBe(">let alpha = 1; // one");
    expect(view.text.toString()).toBe(server.text);
    expect(sync.idle).toBe(true);
    expect(server.snapshots).toBe(0);
  });

  it("queues patches that overtake the reply to our own edit", async () => {
    const { server, view, sync, type, frame } = setup("x");
    type(1, 1, "y");
    frame();
    server.step(); // backend applies our edit (v1); the reply is still on its way
    const ev = server.patch([{ from: 0, to: 0, insert: "<" }]); // v1 -> v2
    sync.remote(ev); // arrives before the reply: must wait for it
    expect(view.text.toString()).toBe("xy");
    await flushMicrotasks();
    expect(view.text.toString()).toBe("<xy");
    expect(server.text).toBe("<xy");
    expect(sync.serverVersion).toBe(2);
    expect(sync.idle).toBe(true);
  });

  it("rebases on a snapshot when the rejection arrives without its patch", async () => {
    vi.useFakeTimers();
    try {
      const { server, view, sync, type, frame } = setup("one\ntwo\n");
      type(8, 8, "three\n");
      frame();
      server.patch([{ from: 0, to: 3, insert: "ONE" }]); // event lost
      await server.processAll();
      expect(sync.idle).toBe(false);
      type(0, 0, "#"); // typing during resync is kept
      await vi.advanceTimersByTimeAsync(100);
      await server.processAll();
      await flushMicrotasks();
      expect(server.snapshots).toBe(1);
      expect(server.text).toBe("#ONE\ntwo\nthree\n");
      expect(view.text.toString()).toBe(server.text);
      expect(sync.idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps syncing when the snapshot of a rebase fails once", async () => {
    vi.useFakeTimers();
    try {
      const { server, view, sync, type, frame, host } = setup("one\ntwo\n");
      type(8, 8, "three\n");
      frame();
      server.patch([{ from: 0, to: 3, insert: "ONE" }]); // event lost
      server.failSnapshots = 1;
      let idle = false;
      void sync.whenIdle().then(() => (idle = true));
      for (let i = 0; i < 4; i++) {
        await server.processAll();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(server.snapshots).toBe(2);
      expect(host.onError).toHaveBeenCalledWith(expect.objectContaining({ kind: "unavailable" }));
      expect(server.text).toBe("ONE\ntwo\nthree\n");
      expect(view.text.toString()).toBe(server.text);
      expect(sync.idle).toBe(true);
      expect(idle).toBe(true);
      expect(host.onDiscarded).not.toHaveBeenCalled();

      // Later typing still reaches the backend.
      type(0, 0, "#");
      frame();
      await server.processAll();
      expect(server.text).toBe("#ONE\ntwo\nthree\n");
      expect(sync.idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops retrying when every snapshot fails, and keeps the local text to send later", async () => {
    vi.useFakeTimers();
    try {
      const { server, view, sync, type, frame, host } = setup("one\ntwo\n");
      type(8, 8, "three\n");
      frame();
      server.patch([{ from: 0, to: 3, insert: "ONE" }]); // event lost
      server.failSnapshots = Infinity;
      let idle = false;
      void sync.whenIdle().then(() => (idle = true));
      for (let i = 0; i < 20 && !idle; i++) {
        await server.processAll();
        await vi.advanceTimersByTimeAsync(100);
      }
      // A save waiting on the document is released instead of hanging, and nothing is in flight.
      expect(idle).toBe(true);
      expect(sync.inflight).toBeNull();
      expect(server.pending()).toBe(0);
      expect(host.onError).toHaveBeenCalled();
      expect(view.text.toString()).toBe("one\ntwo\nthree\n");

      // Once the backend answers again, the local text and new typing land where they belong.
      server.failSnapshots = 0;
      type(0, 0, "#");
      frame();
      for (let i = 0; i < 4; i++) {
        await server.processAll();
        await vi.advanceTimersByTimeAsync(100);
      }
      expect(server.text).toBe("#ONE\ntwo\nthree\n");
      expect(view.text.toString()).toBe(server.text);
      expect(sync.idle).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hard-resyncs on unexpected errors and reports discarded changes", async () => {
    const { server, view, sync, type, frame, host } = setup("abc");
    server.failNext = { kind: "permissionDenied", message: "read-only" };
    type(0, 0, "zzz");
    frame();
    await server.processAll();
    await flushMicrotasks();
    expect(view.text.toString()).toBe("abc");
    // The rejection reaches the host, which writes it to the log file.
    expect(host.onDiscarded).toHaveBeenCalledWith(expect.objectContaining({ kind: "permissionDenied" }));
    expect(sync.idle).toBe(true);
  });

  it("a hard resync touches only the regions that differ", async () => {
    const initial = numberedLines(40);
    const { server, view, type, frame, host } = setup(initial);
    server.failNext = { kind: "permissionDenied", message: "read-only" };
    type(initial.indexOf("line 2\n"), initial.indexOf("line 2\n"), "#");
    type(view.text.toString().indexOf("line 37\n"), view.text.toString().indexOf("line 37\n"), "#");
    frame();
    await server.processAll();
    await flushMicrotasks();
    expect(view.text.toString()).toBe(initial);
    const touched: number[] = [];
    host.applyRemote.mock.calls[0]![0].iterChanges((fromA) => touched.push(fromA));
    expect(touched).toHaveLength(2);
  });

  it("a snapshot resync patches each region a lost event changed", async () => {
    vi.useFakeTimers();
    try {
      const initial = numberedLines(40);
      const { server, view, type, frame, host } = setup(initial);
      type(initial.length, initial.length, "tail\n");
      frame();
      const lost = [
        { from: initial.indexOf("line 2\n"), to: initial.indexOf("line 2\n"), insert: "#" },
        { from: initial.indexOf("line 37\n"), to: initial.indexOf("line 37\n"), insert: "#" },
      ];
      server.patch(lost);
      await server.processAll();
      await vi.advanceTimersByTimeAsync(100);
      await server.processAll();
      await flushMicrotasks();
      expect(view.text.toString()).toBe(server.text);
      const touched: number[] = [];
      host.applyRemote.mock.calls[0]![0].iterChanges((fromA) => touched.push(fromA));
      expect(touched).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("whenIdle resolves after everything is acked", async () => {
    const { server, sync, type } = setup("");
    type(0, 0, "a");
    const idle = sync.whenIdle();
    let done = false;
    void idle.then(() => (done = true));
    await flushMicrotasks();
    expect(done).toBe(false);
    await server.processAll();
    await flushMicrotasks();
    expect(done).toBe(true);
    expect(server.text).toBe("a");
  });

  it("converges under random interleavings of local edits, patches and replies", async () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 30; round++) {
      const { server, view, sync, type, frame } = setup("0123456789");
      for (let step = 0; step < 40; step++) {
        const action = rnd(5);
        if (action === 0) {
          const len = view.text.length;
          const from = rnd(len + 1);
          const to = Math.min(len, from + rnd(3));
          type(from, to, "abc".slice(0, rnd(4)));
        } else if (action === 1) {
          frame();
        } else if (action === 2) {
          const len = server.text.length;
          const from = rnd(len + 1);
          sync.remote(server.patch([{ from, to: Math.min(len, from + rnd(2)), insert: "R" }]));
        } else if (action === 3 && server.pending()) {
          await server.processAll();
        } else {
          await flushMicrotasks();
        }
      }
      frame();
      for (let i = 0; i < 10 && !sync.idle; i++) {
        await server.processAll();
        frame();
        await flushMicrotasks();
      }
      expect(sync.idle).toBe(true);
      expect(view.text.toString()).toBe(server.text);
    }
  });
});

describe("minimalChanges", () => {
  it("trims common prefix and suffix", () => {
    expect(minimalChanges("hello world", "hello brave world")).toEqual([{ from: 6, to: 6, insert: "brave " }]);
    expect(minimalChanges("abc", "abc")).toEqual([]);
    expect(apply("aaa", minimalChanges("aaa", "a"))).toBe("a");
  });

  it("keeps distant edits apart", () => {
    const before = numberedLines(40);
    const after = before.replace("line 2\n", "line two\n").replace("line 37\n", "line thirty-seven\n");
    const changes = minimalChanges(before, after);
    expect(changes).toHaveLength(2);
    expect(apply(before, changes)).toBe(after);
  });

  it("rebuilds text across astral characters", () => {
    expect(apply("a😀b\n😁c", minimalChanges("a😀b\n😁c", "a😁b\n😀c"))).toBe("a😁b\n😀c");
  });
});
