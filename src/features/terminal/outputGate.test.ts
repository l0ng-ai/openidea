import { describe, expect, it } from "vitest";
import {
  HIDDEN_FLUSH_MS,
  OutputGate,
  flushIntervalMs,
  notifyTerminalVisibility,
  type OutputGateClock,
} from "./outputGate";

function fakeClock() {
  let now = 0;
  const timers = new Map<number, { fn: () => void; at: number }>();
  let nextId = 1;
  const clock: OutputGateClock = {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout: (id) => {
      timers.delete(id);
    },
  };
  return {
    clock,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timers.entries()]) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
  };
}

describe("flushIntervalMs", () => {
  it("maps presets and forces a floor while hidden", () => {
    expect(flushIntervalMs("unlimited", false)).toBe(0);
    expect(flushIntervalMs("60", false)).toBe(17);
    expect(flushIntervalMs("30", false)).toBe(33);
    expect(flushIntervalMs("10", false)).toBe(100);
    expect(flushIntervalMs("unlimited", true)).toBe(HIDDEN_FLUSH_MS);
    expect(flushIntervalMs("60", true)).toBe(HIDDEN_FLUSH_MS);
  });
});

describe("OutputGate", () => {
  it("writes immediately when unlimited and visible", () => {
    const writes: string[] = [];
    const { clock } = fakeClock();
    const gate = new OutputGate({
      maxFps: () => "unlimited",
      hidden: () => false,
      write: (d) => writes.push(d),
      clock,
    });
    gate.push("a");
    gate.push("b");
    expect(writes).toEqual(["a", "b"]);
    gate.dispose();
  });

  it("coalesces chunks until the interval elapses", () => {
    const writes: string[] = [];
    const { clock, advance } = fakeClock();
    const gate = new OutputGate({
      maxFps: () => "10",
      hidden: () => false,
      write: (d) => writes.push(d),
      clock,
    });
    gate.push("a");
    gate.push("b");
    expect(writes).toEqual([]);
    advance(100);
    expect(writes).toEqual(["ab"]);
    gate.push("c");
    advance(50);
    expect(writes).toEqual(["ab"]);
    advance(50);
    expect(writes).toEqual(["ab", "c"]);
    gate.dispose();
  });

  it("uses the hidden interval and flushes when becoming visible", () => {
    const writes: string[] = [];
    let hidden = true;
    const { clock, advance } = fakeClock();
    const gate = new OutputGate({
      maxFps: () => "60",
      hidden: () => hidden,
      write: (d) => writes.push(d),
      clock,
    });
    gate.push("x");
    expect(writes).toEqual([]);
    advance(100);
    expect(writes).toEqual([]);
    advance(HIDDEN_FLUSH_MS - 100);
    expect(writes).toEqual(["x"]);

    gate.push("y");
    hidden = false;
    notifyTerminalVisibility();
    expect(writes).toEqual(["x", "y"]);
    gate.dispose();
  });

  it("clear drops buffered output without writing", () => {
    const writes: string[] = [];
    const { clock } = fakeClock();
    const gate = new OutputGate({
      maxFps: () => "10",
      hidden: () => false,
      write: (d) => writes.push(d),
      clock,
    });
    gate.push("z");
    gate.clear();
    expect(writes).toEqual([]);
    expect(gate.buffered).toBe("");
    gate.dispose();
  });
});
