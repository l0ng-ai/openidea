import { describe, expect, it } from "vitest";
import { isThreadDump, parseThreadDump } from "../parse";
import jdk11Sync from "../__fixtures__/jdk11-sync.txt?raw";
import jdk17Juc from "../__fixtures__/jdk17-juc.txt?raw";
import jdk21Mixed from "../__fixtures__/jdk21-mixed.txt?raw";
import jdk25None from "../__fixtures__/jdk25-none.txt?raw";
import jdk25Sync from "../__fixtures__/jdk25-sync.txt?raw";

function parsed(text: string) {
  const dump = parseThreadDump(text);
  if (!dump) throw new Error("expected a thread dump");
  return dump;
}

function thread(text: string, name: string) {
  const found = parsed(text).threads.find((t) => t.name === name);
  if (!found) throw new Error(`no thread ${name}`);
  return found;
}

describe("parseThreadDump", () => {
  it("reads the header after jcmd's pid line", () => {
    expect(parsed(jdk25Sync).header).toBe(
      "Full thread dump OpenJDK 64-Bit Server VM (25.0.3+9-LTS mixed mode, sharing):",
    );
  });

  it("links a two-monitor deadlock and flags both threads", () => {
    const dump = parsed(jdk25Sync);
    expect(dump.deadlocks).toHaveLength(1);
    expect(dump.deadlocks[0]).toMatchObject([
      { thread: "sync-1", heldBy: "sync-2" },
      { thread: "sync-2", heldBy: "sync-1" },
    ]);
    const firstFrames = {
      "sync-1": "at Deadlock.lambda$syncPair$0(Deadlock.java:10)",
      "sync-2": "at Deadlock.lambda$syncPair$1(Deadlock.java:11)",
    };
    for (const [name, frame] of Object.entries(firstFrames)) {
      const t = thread(jdk25Sync, name);
      expect(t.deadlocked).toBe(true);
      expect(t.state).toBe("BLOCKED");
      expect(t.stateDetail).toBe("on object monitor");
      expect(t.frames[0]).toBe(frame);
    }
    expect(thread(jdk25Sync, "main").deadlocked).toBe(false);
  });

  it("does not duplicate threads from the deadlock stack section", () => {
    const names = parsed(jdk25Sync).threads.map((t) => t.name);
    expect(names.filter((n) => n === "sync-1")).toHaveLength(1);
    expect(thread(jdk25Sync, "sync-1").frames).toHaveLength(6);
  });

  it("records held and awaited locks in one format", () => {
    const sync1 = thread(jdk25Sync, "sync-1");
    expect(sync1.waitsOn).toBe("java.lang.Object <0x0000007018419290>");
    expect(sync1.holds).toEqual(["java.lang.Object <0x0000007018419280>"]);
    expect(parsed(jdk25Sync).deadlocks[0]?.[0]?.waitsFor).toBe(sync1.waitsOn);
  });

  it("names the ownable synchronizer a thread waits for", () => {
    const [first, second] = parsed(jdk21Mixed).deadlocks[0] ?? [];
    expect(first?.thread).toBe("mix-1");
    expect(first?.waitsFor).toContain("ReentrantLock$NonfairSync");
    expect(second?.waitsFor).toContain("java.lang.Object");
    expect(thread(jdk21Mixed, "mix-1").waitsOn).toContain("ReentrantLock$NonfairSync");
    expect(thread(jdk21Mixed, "mix-1").state).toBe("WAITING");
    expect(thread(jdk21Mixed, "mix-1").stateDetail).toBe("parking");
    expect(thread(jdk21Mixed, "mix-2").holds).toEqual([first?.waitsFor]);
  });

  it("links a pure java.util.concurrent deadlock", () => {
    const dump = parsed(jdk17Juc);
    expect(dump.deadlocks).toHaveLength(1);
    expect(dump.deadlocks[0]).toHaveLength(2);
    expect(dump.deadlocks[0]?.every((l) => l.waitsFor.includes("ReentrantLock$NonfairSync"))).toBe(true);
  });

  it("parses JDK 11 headers that have no [nid] column", () => {
    const main = thread(jdk11Sync, "main");
    expect(main.number).toBe(1);
    expect(main.state).toBe("TIMED_WAITING");
    expect(main.stateDetail).toBe("sleeping");
    expect(thread(jdk11Sync, "Reference Handler").daemon).toBe(true);
    expect(parsed(jdk11Sync).deadlocks[0]).toHaveLength(2);
  });

  it("reports no deadlocks and classifies JVM threads", () => {
    const dump = parsed(jdk25None);
    expect(dump.deadlocks).toEqual([]);
    expect(dump.threads.some((t) => t.deadlocked)).toBe(false);
    expect(thread(jdk25None, "main").internal).toBe(false);
    expect(thread(jdk25None, "main").daemon).toBe(false);
    expect(thread(jdk25None, "Reference Handler").internal).toBe(true);
    expect(thread(jdk25None, "VM Thread").internal).toBe(true);
    expect(thread(jdk25None, "VM Thread").number).toBeNull();
    expect(thread(jdk25None, "VM Thread").state).toBe("UNKNOWN");
    expect(thread(jdk25None, "C2 CompilerThread0").internal).toBe(true);
  });

  it("keeps lock lines in frames and leaves the ownable section out of them", () => {
    const finalizer = thread(jdk25None, "Finalizer");
    expect(finalizer.frames.some((f) => f.startsWith("- waiting on <0x"))).toBe(true);
    expect(finalizer.frames.every((f) => /^(at |- )/.test(f))).toBe(true);
    expect(finalizer.frames.some((f) => f === "- None")).toBe(false);
  });

  it("accepts CRLF line endings and leading prompt lines", () => {
    const pasted = `$ jstack 65274\r\nAttaching to process...\r\n${jdk25Sync.replace(/\n/g, "\r\n")}`;
    const dump = parsed(pasted);
    expect(dump.threads.length).toBe(parsed(jdk25Sync).threads.length);
    expect(dump.deadlocks[0]).toHaveLength(2);
    expect(thread(pasted, "sync-1").frames[0]).toBe("at Deadlock.lambda$syncPair$0(Deadlock.java:10)");
  });

  it("separates several deadlock cycles", () => {
    const cycle = (a: string, b: string) => `Found one Java-level deadlock:
=============================
"${a}":
  waiting to lock monitor 0x01 (object 0x0a, a java.lang.Object),
  which is held by "${b}"
"${b}":
  waiting to lock monitor 0x02 (object 0x0b, a java.lang.Object),
  which is held by "${a}"

Java stack information for the threads listed above:
===================================================
"${a}":
	at X.run(X.java:1)
"${b}":
	at X.run(X.java:2)

`;
    const text = `Full thread dump VM (x):

"a" #1 prio=5 os_prio=0 tid=0x1 nid=0x1 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
	at X.run(X.java:1)

"c" #2 prio=5 os_prio=0 tid=0x2 nid=0x2 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
	at X.run(X.java:1)

${cycle("a", "b")}${cycle("c", "d")}Found 2 deadlocks.
`;
    const dump = parsed(text);
    expect(dump.deadlocks.map((links) => links.map((l) => l.thread))).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(dump.threads.map((t) => t.name)).toEqual(["a", "c"]);
    expect(dump.threads.every((t) => t.deadlocked)).toBe(true);
  });

  it("returns null when there is no thread header", () => {
    expect(parseThreadDump("")).toBeNull();
    expect(
      parseThreadDump('Exception in thread "main" java.lang.IllegalStateException\n\tat A.b(A.java:1)'),
    ).toBeNull();
  });

  it("parses 5,000 threads quickly", () => {
    const blocks = Array.from(
      { length: 5000 },
      (_, i) =>
        `"worker-${i}" #${i + 20} [${i}] prio=5 os_prio=31 cpu=1.00ms elapsed=2.00s tid=0x${i.toString(16)} nid=${i} waiting on condition  [0x0]
   java.lang.Thread.State: WAITING (parking)
	at jdk.internal.misc.Unsafe.park(java.base@21.0.4/Native Method)
	- parking to wait for  <0x${i.toString(16)}> (a java.util.concurrent.locks.ReentrantLock$NonfairSync)
	at java.util.concurrent.locks.LockSupport.park(java.base@21.0.4/LockSupport.java:221)
	at app.Worker.run(Worker.java:${i})

   Locked ownable synchronizers:
	- None
`,
    );
    const text = `Full thread dump VM (21):\n\n${blocks.join("\n")}`;
    const start = performance.now();
    const dump = parsed(text);
    const elapsed = performance.now() - start;
    expect(dump.threads).toHaveLength(5000);
    expect(elapsed).toBeLessThan(200);
  });
});

describe("isThreadDump", () => {
  it("accepts real dumps, with or without the jcmd pid line", () => {
    for (const text of [jdk11Sync, jdk17Juc, jdk21Mixed, jdk25None, jdk25Sync]) {
      expect(isThreadDump(text)).toBe(true);
    }
    expect(isThreadDump(jdk25Sync.replace(/^\d+:\n/, ""))).toBe(true);
  });

  it("rejects an ordinary exception trace", () => {
    expect(isThreadDump('Exception in thread "main" java.lang.RuntimeException: boom\n\tat A.main(A.java:3)\n')).toBe(
      false,
    );
    expect(isThreadDump("")).toBe(false);
  });
});
