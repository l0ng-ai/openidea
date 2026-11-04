import { describe, expect, it } from "vitest";
import { IME_COMMIT_TIMEOUT_MS, ImeCommitGate, type ImeScheduler } from "./imeCommit";

/** Runs queued callbacks in order, the way setTimeout(0) drains after the current event. */
function manualScheduler() {
  let next = 1;
  const tasks = new Map<number, () => void>();
  const scheduler: ImeScheduler = {
    after: (callback) => {
      const id = next++;
      tasks.set(id, callback);
      return id;
    },
    cancel: (id) => {
      tasks.delete(id);
    },
  };
  const run = () => {
    for (const [id, task] of [...tasks]) {
      tasks.delete(id);
      task();
    }
  };
  return { scheduler, run, pending: () => tasks.size };
}

function gateWithRebase() {
  const { scheduler, run, pending } = manualScheduler();
  let rebased = 0;
  const gate = new ImeCommitGate(() => rebased++, scheduler);
  return { gate, run, pending, rebases: () => rebased };
}

/** Collects the emissions that reach the PTY, like `Session.fromTerminal`. */
function emitter(gate: ImeCommitGate) {
  const sent: string[] = [];
  return { sent, emit: (data: string) => gate.accept() && sent.push(data) };
}

describe("ImeCommitGate", () => {
  it("takes the first emission of a commit and drops the repeated one", () => {
    const { gate } = gateWithRebase();
    gate.begin();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(false);
  });

  it("keeps the real text of the pi case and drops the stale suffix", () => {
    // xterm sends the committed diff first, then a stale `value.substring(start)`.
    const { gate, run } = gateWithRebase();
    const { sent, emit } = emitter(gate);
    gate.begin();
    emit("在吗");
    gate.finish();
    emit("好在吗");
    run();
    expect(sent).toEqual(["在吗"]);
  });

  it("starts a new commit on the next IME keystroke even inside the timeout", () => {
    // Two commits can arrive back to back; the second must not be swallowed by the first
    // commit's still-running timeout.
    const { gate } = gateWithRebase();
    gate.begin();
    expect(gate.accept()).toBe(true);
    gate.begin();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(false);
  });

  it("drops the stale suffix of a WebKitGTK punctuation commit without compositionstart", () => {
    // fcitx5 commits `，` as insertFromComposition + compositionend without compositionstart:
    // xterm sends the keydown diff `，`, then compositionend emits `好，` from the previous
    // composition's position. That suffix is what showed up as a duplicate in the terminal.
    const { gate, run, rebases } = gateWithRebase();
    const { sent, emit } = emitter(gate);
    gate.begin();
    emit("，");
    gate.finish();
    emit("好，");
    run();
    expect(sent).toEqual(["，"]);
    expect(rebases()).toBe(1);
  });

  it("stands down for a real composition, then gates the next commit again", () => {
    // compositionstart must not disable the gate for the whole session: the very next
    // punctuation commit still needs deduplication.
    const { gate, run, rebases } = gateWithRebase();
    gate.begin();
    gate.compositionStart();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(true);
    gate.finish();
    run();
    expect(rebases()).toBe(1);

    gate.begin();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(false);
  });

  it("accepts every emission while composing", () => {
    const { gate } = gateWithRebase();
    gate.compositionStart();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(true);
  });

  it("rebases after a composition that xterm sent by itself", () => {
    const { gate, run, rebases } = gateWithRebase();
    gate.compositionStart();
    gate.finish();
    expect(rebases()).toBe(0);
    run();
    expect(rebases()).toBe(1);
  });

  it("rebases after a commit whose compositionend arrives, not before", () => {
    const { gate, run, rebases } = gateWithRebase();
    gate.begin();
    expect(gate.accept()).toBe(true);
    gate.finish();
    expect(rebases()).toBe(0);
    run();
    expect(rebases()).toBe(1);
  });

  it("opens a commit from a composition input when no keydown preceded it", () => {
    const { gate } = gateWithRebase();
    gate.input();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(false);
    // A second input event belongs to the same commit and must not reopen it.
    gate.input();
    expect(gate.accept()).toBe(false);
  });

  it("closes a commit whose compositionend never arrives", () => {
    const { gate, run, pending, rebases } = gateWithRebase();
    gate.begin();
    expect(pending()).toBe(1);
    run();
    expect(IME_COMMIT_TIMEOUT_MS).toBeGreaterThan(0);
    expect(rebases()).toBe(1);
    expect(gate.accept()).toBe(true);
  });

  it("does not rebase into a composition that started before the close ran", () => {
    const { gate, run, rebases } = gateWithRebase();
    gate.begin();
    gate.finish();
    gate.compositionStart();
    run();
    expect(rebases()).toBe(0);
  });
});
