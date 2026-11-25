import { describe, expect, it } from "vitest";
import type { DumpThread, ThreadState } from "../parse";
import { monitorCycles, virtualThreads } from "../parseJson";
import jdk21Vjuc from "../__fixtures__/jdk21-vjuc.json?raw";
import jdk25Vjuc from "../__fixtures__/jdk25-vjuc.json?raw";
import jdk25Vsync from "../__fixtures__/jdk25-vsync.json?raw";

function synth(name: string, state: ThreadState, waitsOn: string | null, holds: string[]): DumpThread {
  return {
    name,
    number: null,
    daemon: true,
    state,
    stateDetail: "",
    frames: [],
    holds,
    waitsOn,
    internal: false,
    deadlocked: false,
  };
}

const blocked = (name: string, waitsOn: string, holds: string[]) => synth(name, "BLOCKED", waitsOn, holds);
const names = (cycles: ReturnType<typeof monitorCycles>) => cycles.map((c) => c.map((l) => l.thread));

describe("virtualThreads", () => {
  it("keeps only the virtual threads of a JDK 25 dump", () => {
    const threads = virtualThreads(jdk25Vsync);
    expect(threads.map((t) => t.name)).toEqual(["v-sync-1", "v-sync-2"]);
    expect(threads[0]).toMatchObject({
      number: 26,
      state: "BLOCKED",
      container: "<root>",
      waitsOn: "java.lang.Object@2a965924",
      holds: ["java.lang.Object@1164b0ad"],
      internal: false,
    });
  });

  it("writes frames the way the text parser does, so source links work", () => {
    const frames = virtualThreads(jdk25Vsync)[0]?.frames;
    expect(frames).toEqual([
      "at VirtualDeadlock.lambda$main$0(VirtualDeadlock.java:9)",
      "at java.base/java.lang.VirtualThread.run(VirtualThread.java:460)",
    ]);
  });

  it("reads the park blocker as the lock a virtual thread waits on", () => {
    const threads = virtualThreads(jdk25Vjuc);
    expect(threads.map((t) => [t.name, t.state])).toEqual([
      ["v-juc-1", "WAITING"],
      ["v-juc-2", "WAITING"],
    ]);
    expect(threads[0]?.waitsOn).toMatch(/^java\.util\.concurrent\.locks\.ReentrantLock\$NonfairSync@/);
    expect(threads[0]?.holds).toEqual([]);
  });

  it("recognises JDK 21 virtual threads, which carry no flag, without counting carriers", () => {
    const threads = virtualThreads(jdk21Vjuc);
    expect(threads.map((t) => t.name)).toEqual(["v-juc-1", "v-juc-2"]);
    expect(threads.every((t) => t.state === "UNKNOWN")).toBe(true);
  });

  it("reads an empty tid as no number, not 0", () => {
    const json = JSON.stringify({
      threadDump: {
        threadContainers: [{ container: "<root>", threads: [{ tid: "", name: "v", virtual: true, stack: [] }] }],
      },
    });
    expect(virtualThreads(json)[0]?.number).toBeNull();
  });

  it("answers nothing for malformed or unrelated JSON", () => {
    expect(virtualThreads("{not json")).toEqual([]);
    expect(virtualThreads("")).toEqual([]);
    expect(virtualThreads("[1,2]")).toEqual([]);
    expect(virtualThreads('{"threadDump":{}}')).toEqual([]);
  });
});

describe("monitorCycles", () => {
  it("finds the monitor deadlock between two virtual threads", () => {
    const cycles = monitorCycles(virtualThreads(jdk25Vsync));
    expect(cycles).toEqual([
      [
        { thread: "v-sync-1", waitsFor: "java.lang.Object@2a965924", heldBy: "v-sync-2" },
        { thread: "v-sync-2", waitsFor: "java.lang.Object@1164b0ad", heldBy: "v-sync-1" },
      ],
    ]);
  });

  it("reports no cycle when the dump names no lock owner", () => {
    expect(monitorCycles(virtualThreads(jdk25Vjuc))).toEqual([]);
    expect(monitorCycles(virtualThreads(jdk21Vjuc))).toEqual([]);
  });

  it("finds a three-thread cycle", () => {
    const cycles = monitorCycles([blocked("a", "L1", ["L3"]), blocked("b", "L2", ["L1"]), blocked("c", "L3", ["L2"])]);
    expect(cycles).toEqual([
      [
        { thread: "a", waitsFor: "L1", heldBy: "b" },
        { thread: "b", waitsFor: "L2", heldBy: "c" },
        { thread: "c", waitsFor: "L3", heldBy: "a" },
      ],
    ]);
  });

  it("leaves out a thread that only queues behind a cycle", () => {
    const cycles = monitorCycles([blocked("tail", "L1", []), blocked("a", "L2", ["L1"]), blocked("b", "L1", ["L2"])]);
    expect(names(cycles)).toEqual([["a", "b"]]);
  });

  it("reports two disjoint cycles separately", () => {
    const cycles = monitorCycles([
      blocked("a", "L2", ["L1"]),
      blocked("c", "L4", ["L3"]),
      blocked("b", "L1", ["L2"]),
      blocked("d", "L3", ["L4"]),
    ]);
    expect(names(cycles)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  it("draws no edge from a thread in wait(), whatever the thread order", () => {
    // waiter wait()s on L1 (still listed as owned) while holding L2; b holds L1 and is blocked on L2.
    const waiter = synth("waiter", "WAITING", "L1", ["L1", "L2"]);
    const b = blocked("b", "L2", ["L1"]);
    expect(monitorCycles([waiter, b])).toEqual([]);
    expect(monitorCycles([b, waiter])).toEqual([]);
  });

  it("does not let a wait()ing thread own the monitor it waits on", () => {
    const waiter = synth("waiter", "WAITING", "L", ["L"]);
    const b = blocked("b", "L", ["M"]);
    const c = blocked("c", "M", []);
    expect(monitorCycles([waiter, b, c])).toEqual([]);
    expect(monitorCycles([b, c, waiter])).toEqual([]);
  });

  it("finds a real cycle whichever thread lists the shared monitor first", () => {
    const waiter = synth("waiter", "WAITING", "L", ["L"]);
    const b = blocked("b", "L", ["M"]);
    const c = blocked("c", "M", ["L"]);
    expect(names(monitorCycles([waiter, b, c]))).toEqual([["b", "c"]]);
    expect(names(monitorCycles([b, c, waiter]))).toEqual([["b", "c"]]);
  });

  it("ignores a thread that holds the lock it waits on", () => {
    const [thread] = virtualThreads(jdk25Vsync);
    if (!thread) throw new Error("expected a thread");
    expect(monitorCycles([{ ...thread, holds: [thread.waitsOn ?? ""] }])).toEqual([]);
  });
});
