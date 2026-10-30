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
    const sent: string[] = [];
    const emit = (data: string) => {
      if (gate.accept()) sent.push(data);
    };
    gate.begin();
    emit("在吗");
    gate.finish();
    emit("好在吗");
    run();
    expect(sent).toEqual(["在吗"]);
  });

  it("accepts every emission once the commit is over", () => {
    const { gate, run } = gateWithRebase();
    gate.begin();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(false);
    gate.finish();
    run();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(true);
  });

  it("rebases the textarea when the commit closes, not before", () => {
    const { gate, run, rebases } = gateWithRebase();
    gate.begin();
    gate.finish();
    expect(rebases()).toBe(0);
    run();
    expect(rebases()).toBe(1);
  });

  it("stands down once a real compositionstart arrives", () => {
    const { gate, rebases } = gateWithRebase();
    gate.begin();
    gate.compositionStart();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(true);
    expect(rebases()).toBe(0);
    // And a later commit is not gated either.
    gate.begin();
    expect(gate.accept()).toBe(true);
    expect(gate.accept()).toBe(true);
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
});
