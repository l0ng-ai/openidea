import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeAction, getAction, isActionEnabled } from "@/platform/actions";
import { commands, type JvmThreadsResult, type JvmThreadsUnavailable, type RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import type { ProjectInfo } from "@/platform/ipc";
import { runJvmToken } from "../../gradleRun";
import { useStackTraces } from "../../stackTrace";
import { useRun, type RunSession, type SessionStatus } from "../../store";
import { activateThreadDumps } from "../actions";
import type { ThreadDumpTab } from "../store";
import { threadsUnavailableText } from "../unavailableText";
import jdk25Sync from "../__fixtures__/jdk25-sync.txt?raw";
import jdk25None from "../__fixtures__/jdk25-none.txt?raw";
import jdk25Vjuc from "../__fixtures__/jdk25-vjuc.json?raw";
import jdk25Vsync from "../__fixtures__/jdk25-vsync.json?raw";

const notify = vi.hoisted(() => vi.fn());
const showToolWindow = vi.hoisted(() => vi.fn());
vi.mock("@/workbench/contributions", async (orig) => {
  const actual = await orig<typeof import("@/workbench/contributions")>();
  return {
    ...actual,
    notifications: () => ({ notify }),
    toolWindowService: () => ({ show: showToolWindow }),
  };
});

function config(kind: string, patch: Partial<RunConfig> = {}): RunConfig {
  return {
    id: `${kind}:App`,
    name: "App",
    kind,
    command: "",
    args: [],
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
    ...patch,
  };
}

function start(c: RunConfig, status: SessionStatus = "running") {
  const session: RunSession = {
    id: "s1",
    config: c,
    runId: 7,
    status,
    exitCode: null,
    startedAt: 0,
    endedAt: null,
    stdinClosed: false,
  };
  useRun.setState({ sessions: [session], activeSession: session.id });
}

const ready = (text: string, virtualJson: string | null = null): JvmThreadsResult => ({
  status: "ready",
  dump: {
    text,
    pid: 42,
    javaVersion: "25",
    takenWhileSuspended: false,
    elapsedMs: 80,
    virtualJson,
    virtualNote: null,
  },
});
const virtualNames = (tab: ThreadDumpTab) =>
  tab.dump.threads.filter((t) => t.container !== undefined).map((t) => t.name);
const unavailable = (reason: JvmThreadsUnavailable): JvmThreadsResult => ({ status: "unavailable", reason });
const answer = (result: JvmThreadsResult) => ({ status: "ok" as const, data: result });

const enabled = () => isActionEnabled(getAction("run.dumpThreads")!);

function onlyTab(): ThreadDumpTab {
  const [tab, ...rest] = useStackTraces.getState().tabs;
  if (tab?.kind !== "threads" || rest.length) throw new Error("expected one thread dump tab");
  return tab;
}

const ROOT = "/w/demo";

let dispose: () => void;
beforeEach(() => {
  useProject.setState({ project: { root: ROOT } as ProjectInfo, settings: null });
  dispose = activateThreadDumps();
  useStackTraces.setState({ tabs: [], dialog: null });
  notify.mockClear();
  showToolWindow.mockClear();
});
afterEach(() => {
  dispose();
  vi.restoreAllMocks();
  useRun.setState({ sessions: [], activeSession: null });
});

describe("run.dumpThreads", () => {
  it("is disabled for a Node run and enabled for a running Java application", () => {
    start(config("npm", { command: "npm", args: ["run", "dev"] }));
    expect(enabled()).toBe(false);
    start(config("application"));
    expect(enabled()).toBe(true);
    start(config("application"), "finished");
    expect(enabled()).toBe(false);
  });

  it("counts the Maven and Gradle tasks that run the application", () => {
    start(config("gradle", { args: [":app:bootRun"] }));
    expect(enabled()).toBe(true);
    start(config("maven", { args: ["spring-boot:run"] }));
    expect(enabled()).toBe(true);
    start(config("gradle", { args: ["build"] }));
    expect(enabled()).toBe(false);
    start(config("maven", { args: ["test"], isTest: true }));
    expect(enabled()).toBe(false);
  });

  it("opens the dump in a threads tab titled by the configuration", async () => {
    const app = config("application");
    start(app);
    vi.spyOn(commands, "runJvmThreadDump").mockResolvedValue(answer(ready(jdk25Sync)));
    await executeAction("run.dumpThreads");
    const tab = onlyTab();
    expect(tab.title).toBe("Threads: App");
    expect(tab.source).toEqual({ run: 7, token: runJvmToken(app, ROOT) });
    expect(tab.dump.deadlocks).toHaveLength(1);
    expect(showToolWindow).toHaveBeenCalledWith("run", true);
    expect(notify).not.toHaveBeenCalled();
  });

  it("passes the token of a Gradle-delegated session", async () => {
    start(config("application", { id: "app:Main Class" }));
    const dump = vi.spyOn(commands, "runJvmThreadDump").mockResolvedValue(answer(ready(jdk25Sync)));
    await executeAction("run.dumpThreads");
    expect(dump).toHaveBeenCalledWith(7, runJvmToken({ id: "app:Main Class" }, ROOT));
    expect(dump.mock.calls[0]![1]).toMatch(/^app_Main_Class-/);
  });

  it("notifies why no dump was taken", async () => {
    start(config("application"));
    vi.spyOn(commands, "runJvmThreadDump").mockResolvedValue(answer(unavailable({ kind: "remoteRun" })));
    await executeAction("run.dumpThreads");
    expect(useStackTraces.getState().tabs).toEqual([]);
    expect(showToolWindow).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({ body: "Thread dumps are not available for remote runs yet." }),
    );
  });

  it("reads a failed request as a failed dump", async () => {
    start(config("application"));
    vi.spyOn(commands, "runJvmThreadDump").mockResolvedValue({
      status: "error",
      error: { kind: "internal", message: "boom", data: null },
    } as never);
    await executeAction("run.dumpThreads");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ body: "Could not dump the threads: boom" }));
  });

  it("refreshes into the same tab and throws why it could not, leaving the notification to the tab", async () => {
    start(config("application"));
    const dump = vi.spyOn(commands, "runJvmThreadDump").mockResolvedValue(answer(ready(jdk25Sync)));
    await executeAction("run.dumpThreads");
    const id = onlyTab().id;

    dump.mockResolvedValue(answer(ready(jdk25None)));
    await onlyTab().refresh!();
    expect(onlyTab().id).toBe(id);
    expect(onlyTab().dump.deadlocks).toEqual([]);

    dump.mockResolvedValue(answer(unavailable({ kind: "jvm", reason: { kind: "programExited" } })));
    await expect(onlyTab().refresh!()).rejects.toThrow("The program has exited.");
    expect(notify).not.toHaveBeenCalled();
  });

  it("brings the virtual threads into the tab, and the next dump's on refresh", async () => {
    start(config("application"));
    const dump = vi.spyOn(commands, "runJvmThreadDump").mockResolvedValue(answer(ready(jdk25None, jdk25Vsync)));
    await executeAction("run.dumpThreads");
    expect(virtualNames(onlyTab())).toEqual(["v-sync-1", "v-sync-2"]);
    expect(onlyTab().dump.deadlocks).toHaveLength(1);

    dump.mockResolvedValue(answer(ready(jdk25None, jdk25Vjuc)));
    await onlyTab().refresh!();
    expect(virtualNames(onlyTab())).toEqual(["v-juc-1", "v-juc-2"]);
    expect(onlyTab().dump.deadlocks).toEqual([]);
  });
});

describe("run.openThreadDump", () => {
  it("opens a debug session's dump and takes the next one with the same request", async () => {
    const take = vi.fn(async () => ready(jdk25Sync));
    await executeAction("run.openThreadDump", { title: "Threads: Debug App", source: { session: 3 }, take });
    const tab = onlyTab();
    expect(tab.title).toBe("Threads: Debug App");
    expect(tab.source).toEqual({ session: 3 });
    take.mockResolvedValue(ready(jdk25None));
    await tab.refresh!();
    expect(take).toHaveBeenCalledTimes(2);
    expect(onlyTab().dump.deadlocks).toEqual([]);
  });
});

describe("threadsUnavailableText", () => {
  it.each<[JvmThreadsUnavailable, string]>([
    [
      { kind: "jvm", reason: { kind: "listenerNotRunning" } },
      "Resume the program to dump its threads: the JVM has no attach listener while it is stopped.",
    ],
    [
      { kind: "jvm", reason: { kind: "unsafeWhileSuspended", javaMajor: 11 } },
      "Resume the program to dump its threads: Java 11 cannot answer while the debugger stops it.",
    ],
    [
      { kind: "listenerDidNotStart" },
      "The JVM did not accept the request. It may run with -XX:+DisableAttachMechanism.",
    ],
    [{ kind: "jvm", reason: { kind: "noJvmProcess" } }, "No Java process was found for this run."],
    [{ kind: "jvm", reason: { kind: "programExited" } }, "The program has exited."],
    [{ kind: "jvm", reason: { kind: "unsupportedPlatform" } }, "Thread dumps are not available on this platform yet."],
    [{ kind: "remoteRun" }, "Thread dumps are not available for remote runs yet."],
    [{ kind: "jvm", reason: { kind: "timedOut" } }, "The JVM did not answer in time."],
    [{ kind: "failed", message: "socket closed" }, "Could not dump the threads: socket closed"],
  ])("explains %j", (reason, text) => {
    expect(threadsUnavailableText(reason)).toBe(text);
  });
});
