import { describe, expect, it } from "vitest";
import { monitorCycles, virtualThreads } from "../parseJson";
import jdk21Vjuc from "../__fixtures__/jdk21-vjuc.json?raw";
import jdk25Vjuc from "../__fixtures__/jdk25-vjuc.json?raw";
import jdk25Vsync from "../__fixtures__/jdk25-vsync.json?raw";

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

  it("ignores a thread that holds the lock it waits on", () => {
    const [thread] = virtualThreads(jdk25Vsync);
    if (!thread) throw new Error("expected a thread");
    expect(monitorCycles([{ ...thread, holds: [thread.waitsOn ?? ""] }])).toEqual([]);
  });
});
