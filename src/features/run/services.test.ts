import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MenuItem } from "@/ui";
import { pickServices } from "./serviceImport";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";

const ipc = vi.hoisted(() => ({ runConfigs: vi.fn() }));
vi.mock("@/platform/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/platform/ipc")>()),
  isTauri: () => true,
  commands: ipc,
}));

import {
  addType,
  cleanupRemovedProject,
  addMenuCategories,
  categorizedTypes,
  runServiceProvider,
  registerRunServiceActions,
  readHidden,
  readTypes,
  runServiceItems,
  sessionDetail,
  sessionStatus,
} from "./services";
import { KIND_OPTIONS, categoryOf } from "./configs";
import { startedPort } from "@/platform/serverPort";
import { registerRunConfigType, useDebugRunSessions, type DebugServiceSession } from "@/workbench/contributions";
import { useRun, type RunSession } from "./store";

const { startRun, stopServiceSessions, openUrl, showContextMenu } = vi.hoisted(() => ({
  startRun: vi.fn(),
  openUrl: vi.fn(),
  showContextMenu: vi.fn(),
  stopServiceSessions: vi.fn(),
}));
vi.mock("./store", async (importOriginal) => ({ ...(await importOriginal<typeof import("./store")>()), startRun }));
vi.mock("./serviceSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./serviceSessions")>()),
  stopServiceSessions,
}));

vi.mock("./serviceImport", () => ({ pickServices: vi.fn() }));
vi.mock("./navigate", () => ({ openUrl }));
vi.mock("@/ui", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/ui")>()), showContextMenu }));

let disposeActions: () => void;
beforeEach(() => {
  disposeActions = registerRunServiceActions();
  useDebugRunSessions.setState({ serviceSessions: [] });
  openUrl.mockReset();
  showContextMenu.mockReset();
});
afterEach(() => disposeActions());

const config = (id: string, kind: string): RunConfig => ({
  id,
  name: id,
  kind,
  command: kind,
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
});

const session = (
  id: string,
  c: RunConfig,
  status: RunSession["status"],
  startedAt: number,
  extra: Partial<RunSession> = {},
): RunSession => ({
  id,
  config: c,
  runId: null,
  status,
  exitCode: null,
  startedAt,
  endedAt: null,
  stdinClosed: false,
  ...extra,
});

describe("run configurations in Services", () => {
  const build = config("build", "cargo");
  const test = config("test", "cargo");
  const dev = config("dev", "npm");
  const scratch = config("context:file", "python");

  it.each(["spring-boot", "node", "python", "go", "cargo"])(
    "shows configured %s debug roots without a Run session",
    (kind) => {
      const c = config("debug-app", kind);
      const d: DebugServiceSession = {
        id: 1,
        config: c,
        status: "running",
        processId: null,
        startedAt: 2,
        stop: async () => {},
        rerun: null,
        show: () => {},
      };
      const build = (status: DebugServiceSession["status"]) => runServiceItems([c], [], [kind], {}, [{ ...d, status }]);
      expect(build("running")[0]?.children?.[0]).toMatchObject({
        key: "run:config:debug-app",
        detail: "Debugging",
        icon: "debug",
        dim: false,
      });
      expect(build("paused")[0]?.children?.[0]?.detail).toBe("Suspended");
      expect(build("terminated")[0]?.children?.[0]).toMatchObject({ detail: "Finished", dim: true });
    },
  );

  it("does not reuse an old Run port for a new direct debug launch or double-count an attachment", () => {
    const c = config("app", "spring-boot");
    const r = session("run", c, "finished", 1, { runId: 7, httpPort: 8080 });
    const d: DebugServiceSession = {
      id: 1,
      config: c,
      status: "running",
      processId: null,
      startedAt: 2,
      stop: async () => {},
      rerun: null,
      show: () => {},
    };
    const direct = runServiceItems([c], [r], ["spring-boot"], {}, [d]);
    expect(direct[0]?.detail).toBe("1 running");
    expect(direct[0]?.children?.[0]?.detail).toBe("Debugging");
    const attached = runServiceItems([c], [{ ...r, status: "running" }], ["spring-boot"], {}, [{ ...d, processId: 7 }]);
    expect(attached[0]?.detail).toBe("1 running");
    expect(attached[0]?.children).toHaveLength(1);
    expect(attached[0]?.children?.[0]?.detail).toBe(":8080");
  });

  it("shows the app port of a direct debug session like for Run", () => {
    const c = config("app", "spring-boot");
    const d: DebugServiceSession = {
      id: 1,
      config: c,
      status: "running",
      processId: null,
      startedAt: 2,
      httpPort: 8080,
      stop: async () => {},
      rerun: null,
      show: () => {},
    };
    expect(runServiceItems([c], [], ["spring-boot"], {}, [d])[0]?.children?.[0]).toMatchObject({
      detail: ":8080",
      icon: "debug",
      dim: false,
    });
    // A paused debugger still wins over the announced port.
    expect(runServiceItems([c], [], ["spring-boot"], {}, [{ ...d, status: "paused" }])[0]?.children?.[0]?.detail).toBe(
      "Suspended",
    );
  });

  it("applies display order to detected and saved configurations of every language", () => {
    const configs = [
      config("java-a", "spring-boot"),
      config("java-b", "spring-boot"),
      config("node-a", "npm"),
      { ...config("node-b", "npm"), detected: false },
      config("py-a", "python"),
      config("py-b", "python"),
    ];
    const items = runServiceItems(configs, [], ["spring-boot", "npm", "python"], {
      "spring-boot": ["java-b", "java-a"],
      npm: ["node-b", "node-a"],
      python: ["py-b", "py-a"],
    });
    expect(items.map((g) => g.children!.map((c) => c.label))).toEqual([
      ["java-b", "java-a"],
      ["node-b", "node-a"],
      ["py-b", "py-a"],
    ]);
    expect(configs.map((c) => c.id)).toEqual(["java-a", "java-b", "node-a", "node-b", "py-a", "py-b"]);
  });

  it.each(["tomcat", "application", "compound"])("orders %s configurations across workspace members", (kind) => {
    const first = { ...config("workspace:one:app", kind), cwd: "/workspace/one", module: "one" };
    const second = { ...config("workspace:two:app", kind), cwd: "/workspace/two", module: "two" };
    const fresh = config("workspace:two:new", kind);
    const configs = [first, second, fresh];
    const items = runServiceItems(configs, [], [kind], { [kind]: [second.id, first.id] });
    expect(items[0]!.children!.map((c) => c.key)).toEqual([second, first, fresh].map((c) => `run:config:${c.id}`));
    expect(configs).toEqual([first, second, fresh]);
  });

  it("keeps stable service identity and session details after refresh and rename", () => {
    const renamed = { ...build, name: "Renamed build" };
    const items = runServiceItems(
      [renamed, test],
      [session("s1", renamed, "running", 1, { httpPort: 8080 })],
      ["cargo"],
      { cargo: ["test", "build"] },
    );
    expect(items[0]!.children!.map((c) => [c.key, c.label, c.detail])).toEqual([
      ["run:config:test", "test", undefined],
      ["run:config:build", "Renamed build", ":8080"],
    ]);
  });

  it("lists added types fully and keeps other types out", () => {
    const sessions = [
      session("s1", dev, "finished", 1),
      session("s2", dev, "running", 2),
      session("s3", scratch, "failed", 3, { exitCode: 2 }),
    ];
    const items = runServiceItems([build, test, dev], sessions, ["cargo"]);
    expect(items.map((i) => [i.key, i.label, i.detail])).toEqual([["run:type:cargo", "Cargo", undefined]]);
    expect(items[0]!.children!.map((c) => [c.key, c.detail, c.dim])).toEqual([
      ["run:config:build", undefined, true],
      ["run:config:test", undefined, true],
    ]);
    // The newest session of a configuration decides its state once its type is added.
    const npm = runServiceItems([dev], sessions, ["npm"]);
    expect(npm[0]!.children!.map((c) => [c.label, c.detail, c.dim, c.icon])).toEqual([
      ["dev", "Running", false, "run"],
    ]);
  });

  it("has no groups without added types or sessions", () => {
    expect(runServiceItems([build], [], [])).toEqual([]);
  });

  it("describes session states", () => {
    expect(sessionStatus(undefined)).toBeUndefined();
    expect(sessionStatus(session("a", build, "starting", 0))).toBe("Starting");
    expect(sessionStatus(session("a", build, "failed", 0, { stopped: true }))).toBe("Stopped");
    expect(sessionStatus(session("a", build, "finished", 0))).toBe("Finished");
  });

  it("shows nothing for a type that was never added", () => {
    const app = config("spring:app", "spring-boot");
    expect(runServiceItems([build, app], [], [])).toEqual([]);
    const items = runServiceItems([build, app], [], ["spring-boot"]);
    expect(items.map((i) => [i.key, i.label, i.expanded])).toEqual([["run:type:spring-boot", "Spring Boot", true]]);
    expect(items[0]!.children!.map((c) => [c.label, c.detail, c.dim])).toEqual([["spring:app", undefined, true]]);
    // An added type stays listed without configurations until it is removed again.
    expect(runServiceItems([build], [], ["spring-boot"])[0]!.children).toEqual([]);
  });

  it("shows the HTTP port of a running application instead of its state", () => {
    const app = config("spring:app", "spring-boot");
    const running = session("s1", app, "running", 1, { httpPort: 8080 });
    expect(sessionDetail(running)).toBe(":8080");
    expect(sessionDetail(session("s1", app, "running", 1))).toBe("Running");
    expect(sessionDetail(session("s1", app, "finished", 1, { httpPort: 8080, stopped: true }))).toBe("Stopped");
    expect(runServiceItems([app], [running], ["spring-boot"])[0]!.children![0]!.detail).toBe(":8080");
  });
});

describe("types added to Services", () => {
  beforeEach(() => localStorage.clear());

  it("starts empty and persists the user's list per project", () => {
    expect(readTypes("/p")).toEqual([]);
    localStorage.setItem("openidea.services.runTypes:/p", JSON.stringify(["npm"]));
    expect(readTypes("/p")).toEqual(["npm"]);
    localStorage.setItem("openidea.services.runTypes:/p", "[]");
    expect(readTypes("/p")).toEqual([]);
    expect(readTypes("/q")).toEqual([]);
  });
});

describe("sessions of types not added", () => {
  const dev = config("dev", "npm");
  const scratch = config("context:file", "python");

  it("keeps the type out of Services", () => {
    expect(runServiceItems([dev], [session("s1", dev, "running", 1)], [])).toEqual([]);
  });

  it("drops a deleted configuration once its run has ended (#1497)", () => {
    const removed = (id: string) => id === "dev";
    const ended = runServiceItems([], [session("s1", dev, "finished", 1)], ["npm"], {}, [], removed);
    expect(ended[0]!.children).toEqual([]);
    const live = runServiceItems([], [session("s1", dev, "running", 1)], ["npm"], {}, [], removed);
    expect(live[0]!.children!.map((c) => [c.label, c.detail])).toEqual([["dev", "Running"]]);
    // Never a saved configuration (a build task, an external tool): its finished run stays.
    const adHoc = runServiceItems([], [session("s2", scratch, "finished", 1)], ["python"], {}, [], removed);
    expect(adHoc[0]!.children!.map((c) => c.key)).toEqual(["run:config:context:file"]);
  });
});

describe("embedded web server port", () => {
  it("reads the port from the started line", () => {
    expect(startedPort("TomcatWebServer  : Tomcat started on port 8080 (http) with context path '/'")).toBe(8080);
    expect(startedPort("Tomcat started on port(s): 8081 (http) with context path ''")).toBe(8081);
    expect(startedPort("o.s.b.web.embedded.netty.NettyWebServer  : Netty started on port 9090")).toBe(9090);
    expect(startedPort("Netty started on port(s): 9091")).toBe(9091);
    expect(startedPort("Undertow started on port(s) 8082 (http)")).toBe(8082);
    expect(startedPort("Jetty started on port 9083 (http/1.1) with context path '/'")).toBe(9083);
    expect(startedPort("Tomcat initialized with port 8080 (http)")).toBeNull();
    expect(startedPort("Started DemoApplication in 1.2 seconds")).toBeNull();
    expect(startedPort("Tomcat started on port 99999")).toBeNull();
  });
});

describe("hidden configurations", () => {
  const a = config("a", "spring-boot");
  const b = config("b", "spring-boot");

  it("hides a configuration even while it runs", () => {
    const hidden = { "spring-boot": ["a"] };
    const stopped = runServiceItems([a, b], [], ["spring-boot"], {}, [], () => false, hidden);
    expect(stopped[0]!.children!.map((c) => c.key)).toEqual(["run:config:b"]);
    const running = runServiceItems(
      [a, b],
      [session("s1", a, "running", 1)],
      ["spring-boot"],
      {},
      [],
      () => false,
      hidden,
    );
    expect(running[0]!.children!.map((c) => c.key)).toEqual(["run:config:b"]);
  });

  it("keeps an added type's group whose configurations are all hidden", () => {
    const items = runServiceItems([a], [], ["spring-boot"], {}, [], () => false, { "spring-boot": ["a"] });
    expect(items).toHaveLength(1);
    expect(items[0]!.children).toEqual([]);
  });

  it("persists hidden ids per project", () => {
    localStorage.clear();
    expect(readHidden("/p")).toEqual({});
    localStorage.setItem("openidea.services.runHidden:/p", JSON.stringify({ "spring-boot": ["a"] }));
    expect(readHidden("/p")).toEqual({ "spring-boot": ["a"] });
    expect(readHidden("/q")).toEqual({});
    expect(readHidden(null)).toEqual({});
  });

  it("does not duplicate docker-compose, docker-dockerfile or docker-image runs in the run configurations provider", () => {
    const compose = config("docker:compose:docker/playground-compose.yml:postgres", "docker-compose");
    const dockerfile = config("docker:dockerfile:Dockerfile", "docker-dockerfile");
    const image = config("docker:image:postgres", "docker-image");
    const items = runServiceItems(
      [compose, dockerfile, image],
      [session("s1", compose, "running", 1), session("s2", dockerfile, "finished", 2)],
      ["docker-compose", "docker-dockerfile", "docker-image"],
    );
    expect(items).toEqual([]);
  });
});

describe("add service categories", () => {
  it("categorizes every built-in kind; update the table when adding kinds", () => {
    const expected: Record<string, string> = {
      npm: "JavaScript",
      node: "JavaScript",
      bun: "JavaScript",
      deno: "JavaScript",
      cargo: "Rust",
      rustc: "Rust",
      gradle: "Build Tools",
      maven: "Build Tools",
      cmake: "Build Tools",
      make: "Build Tools",
      just: "Build Tools",
      go: "Go",
      python: "Python",
      pytest: "Python",
      phpunit: "Others",
      composer: "Others",
      cc: "C/C++",
      "cmake-application": "C/C++",
      shell: "Shell",
      program: "Shell",
      compound: "Others",
      application: "Java",
      "jar-application": "Java",
      "spring-boot": "Java",
      native: "Java",
      "java-file": "Java",
      kotlin: "Java",
      kotlinc: "Java",
      "scala-cli": "Java",
      ruby: "Others",
      php: "Others",
      perl: "Others",
      lua: "Others",
      r: "Others",
      swift: "Others",
      dart: "Others",
      elixir: "Others",
    };
    for (const { value } of KIND_OPTIONS) expect(categoryOf(value), value).toBe(expected[value]);
  });

  it("orders buckets: fixed order first, unlisted plugin categories after, Others last", () => {
    const dispose = registerRunConfigType({
      id: "fake-cloud",
      label: "Cloud Run",
      icon: "cloud",
      group: "Clouds",
      fields: [],
      commandLine: () => null,
    });
    const buckets = categorizedTypes(["ruby", "spring-boot", "npm", "fake-cloud", "gradle"]);
    expect(buckets.map((b) => b.category)).toEqual(["Java", "Build Tools", "JavaScript", "Clouds", "Others"]);
    dispose();
  });

  it("keeps a single-member category as its own bucket", () => {
    expect(categorizedTypes(["go", "ruby"])).toEqual([
      { category: "Go", kinds: ["go"] },
      { category: "Others", kinds: ["ruby"] },
    ]);
  });

  it("sorts each bucket's kinds by their label", () => {
    const buckets = categorizedTypes(["spring-boot", "application", "java-file", "native"]);
    expect(buckets[0]).toEqual({ category: "Java", kinds: ["application", "java-file", "native", "spring-boot"] });
  });

  it("groups nothing for an empty list", () => {
    expect(categorizedTypes([])).toEqual([]);
  });

  it("lists a category once in the Add Service menu when the project uses only some of its kinds", () => {
    const { project, rest } = addMenuCategories(["go", "maven", "gradle", "python"], ["go", "maven"]);
    expect(project.map((b) => b.category)).toEqual(["Build Tools", "Go"]);
    expect(project[0]!.kinds).toEqual(expect.arrayContaining(["maven", "gradle"]));
    expect(rest.map((b) => b.category)).toEqual(["Python"]);
  });
});

describe("open in browser", () => {
  const item = () => ({ key: "run:config:a", label: "a", icon: "" });
  const hasBrowser = () => !runServiceProvider.actions!(item()).find((a) => a.id === "open-browser")?.disabled;

  beforeEach(() => {
    useProject.setState({ project: null });
    useRun.setState({ configs: [], sessions: [] });
  });

  it("offers Open in Browser while a session runs with an HTTP port", () => {
    useRun.setState({
      configs: [config("a", "spring-boot")],
      sessions: [session("s1", config("a", "spring-boot"), "running", 1, { httpPort: 8080 })],
    });
    expect(hasBrowser()).toBe(true);
  });

  it("disables Open in Browser without a port or a running session", () => {
    useRun.setState({
      configs: [config("a", "spring-boot")],
      sessions: [session("s1", config("a", "spring-boot"), "running", 1)],
    });
    expect(hasBrowser()).toBe(false);
    useRun.setState({ sessions: [session("s1", config("a", "spring-boot"), "finished", 1, { httpPort: 8080 })] });
    expect(hasBrowser()).toBe(false);
  });
});

describe("group batch actions", () => {
  const group = () => ({ key: "run:type:spring-boot", label: "Spring Boot", icon: "" });
  const action = (id: string) =>
    runServiceProvider.actions!(group() as never).find((a: { id: string }) => a.id === id)!;

  beforeEach(() => {
    startRun.mockReset().mockResolvedValue(null);
    stopServiceSessions.mockReset().mockImplementation(async (sessions) => {
      const ids = sessions.flatMap((s: { run?: RunSession }) => (s.run ? [s.run.id] : []));
      useRun.setState((state) => ({
        sessions: state.sessions.map((s) => (ids.includes(s.id) ? { ...s, status: "finished" } : s)),
      }));
    });
    useProject.setState({ project: null });
    useRun.setState({ configs: [], sessions: [] });
    addType("spring-boot");
  });

  it("enables Run All and Restart All with stopped configurations, Stop All only with running ones", () => {
    useRun.setState({ configs: [config("a", "spring-boot"), config("b", "spring-boot")], sessions: [] });
    expect(action("run-all").disabled).toBe(false);
    expect(action("restart-all").disabled).toBe(false);
    expect(action("stop-all").disabled).toBe(true);
  });

  it("enables Stop All when one runs and Run All while others are stopped", () => {
    useRun.setState({
      configs: [config("a", "spring-boot"), config("b", "spring-boot")],
      sessions: [session("s1", config("a", "spring-boot"), "running", 1)],
    });
    expect(action("stop-all").disabled).toBe(false);
    expect(action("run-all").disabled).toBe(false);
  });

  it("disables Run All when everything runs", () => {
    useRun.setState({
      configs: [config("a", "spring-boot")],
      sessions: [session("s1", config("a", "spring-boot"), "running", 1)],
    });
    expect(action("run-all").disabled).toBe(true);
  });

  it("starts stopped configurations in display order, skipping running ones", async () => {
    const a = config("a", "spring-boot");
    const b = config("b", "spring-boot");
    const c = config("c", "spring-boot");
    useRun.setState({ configs: [a, b, c], sessions: [session("s1", a, "running", 1)] });
    await action("run-all").run();
    expect(startRun.mock.calls).toEqual([
      [b, undefined, undefined, { show: false }],
      [c, undefined, undefined, { show: false }],
    ]);
  });

  it("restarts: stops the running ones, then starts every configuration in order", async () => {
    const a = config("a", "spring-boot");
    const b = config("b", "spring-boot");
    useRun.setState({ configs: [a, b], sessions: [session("s1", a, "running", 1)] });
    await action("restart-all").run();
    expect(stopServiceSessions).toHaveBeenCalledOnce();
    expect(stopServiceSessions.mock.calls[0]![0].map((s: { config: RunConfig }) => s.config.id)).toEqual(["a"]);
    expect(startRun.mock.calls).toEqual([
      [a, undefined, undefined, { show: false }],
      [b, undefined, undefined, { show: false }],
    ]);
  });

  it("waits for process exit before restarting any configuration and continues after a launch failure", async () => {
    const a = config("a", "spring-boot");
    const b = config("b", "spring-boot");
    useRun.setState({ configs: [a, b], sessions: [session("s1", a, "running", 1, { runId: 1 })] });
    stopServiceSessions.mockResolvedValue(undefined);
    startRun.mockRejectedValueOnce(new Error("launch failed"));
    const pending = action("restart-all").run();
    await vi.waitFor(() => expect(stopServiceSessions).toHaveBeenCalledOnce());
    expect(startRun).not.toHaveBeenCalled();
    useRun.setState({ sessions: [session("s1", a, "finished", 1, { runId: 1 })] });
    await pending;
    expect(startRun.mock.calls.map(([c]) => c.id)).toEqual(["a", "b"]);
  });

  it("uses the saved display order and leaves other types alone", async () => {
    useProject.setState({ project: { root: "/group-order" } as never });
    localStorage.setItem("openidea.services.runTypes:/group-order", JSON.stringify(["spring-boot"]));
    localStorage.setItem("openidea.services.runOrder:/group-order", JSON.stringify({ "spring-boot": ["c", "a", "b"] }));
    const configs = [
      config("a", "spring-boot"),
      config("b", "spring-boot"),
      config("c", "spring-boot"),
      config("d", "npm"),
    ];
    useRun.setState({ configs, sessions: [session("other", configs[3]!, "running", 1)] });
    await action("run-all").run();
    expect(startRun.mock.calls.map(([c]) => c.id)).toEqual(["c", "a", "b"]);
    expect(action("stop-all").disabled).toBe(true);
    await action("stop-all").run();
    expect(stopServiceSessions).not.toHaveBeenCalled();
  });

  it("does not resurrect a deleted configuration retained only as finished output", async () => {
    const a = config("removed", "spring-boot");
    useRun.setState({ configs: [a], sessions: [] });
    useRun.setState({ configs: [], sessions: [session("old", a, "finished", 1)] });
    expect(action("run-all").disabled).toBe(true);
    expect(action("restart-all").disabled).toBe(true);
  });

  it("rechecks enabled state when a registered action runs", async () => {
    const a = config("a", "spring-boot");
    useRun.setState({ configs: [a], sessions: [] });
    const run = action("run-all");
    useRun.setState({ sessions: [session("s1", a, "starting", 1)] });
    await run.run();
    expect(startRun).not.toHaveBeenCalled();
  });

  it("opens the known group URL and offers a named choice for several web apps", async () => {
    const a = config("a", "spring-boot");
    const b = config("b", "spring-boot");
    useRun.setState({ configs: [a, b], sessions: [session("s1", a, "running", 1, { httpPort: 8123 })] });
    await action("open-browser").run();
    expect(openUrl).toHaveBeenCalledWith("http://localhost:8123");
    openUrl.mockClear();
    useDebugRunSessions.setState({
      serviceSessions: [
        {
          id: 1,
          config: b,
          status: "running",
          processId: null,
          startedAt: 2,
          httpPort: 8456,
          stop: async () => {},
          rerun: null,
          show: () => {},
        },
      ],
    });
    await action("open-browser").run();
    expect(openUrl).not.toHaveBeenCalled();
    const choices = showContextMenu.mock.calls[0]![1];
    expect(choices.map((c: { label: string }) => c.label)).toEqual([
      "a — http://localhost:8123",
      "b — http://localhost:8456",
    ]);
    choices[1].run();
    expect(openUrl).toHaveBeenCalledWith("http://localhost:8456");
  });
});

describe("removing a workspace member from Services", () => {
  const main = { ...config("app", "spring-boot"), cwd: "/w/main" };
  const vue = { ...config("dev", "npm"), cwd: "/w/vue" };

  beforeEach(() => {
    localStorage.clear();
    useProject.setState({ project: { root: "/w/main" } as never });
    ipc.runConfigs.mockImplementation(async () => ({ status: "ok", data: [main] }));
  });
  afterEach(() => {
    useProject.setState({ project: null });
    useRun.setState({ configs: [], sessions: [], temporary: [], selectedId: null });
  });

  it("stops and forgets the member's sessions and drops its empty type groups", async () => {
    useRun.setState({
      configs: [main, vue],
      temporary: ["dev"],
      sessions: [session("s1", main, "finished", 1), session("s2", vue, "running", 2, { runId: 7 })],
    });
    localStorage.setItem("openidea.services.runTypes:/w/main", JSON.stringify(["spring-boot", "npm"]));

    await cleanupRemovedProject("/w/vue");

    const s = useRun.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(["s1"]);
    expect(s.configs.map((c) => c.id)).toEqual(["app"]);
    expect(s.temporary).toEqual([]);
    expect(readTypes("/w/main")).toEqual(["spring-boot"]);
    expect(ipc.runConfigs).toHaveBeenCalled();
  });

  it("keeps a type another project still uses, and a sibling with a shared prefix", async () => {
    const other = { ...config("serve", "npm"), cwd: "/w/main" };
    const sibling = { ...config("dev2", "npm"), cwd: "/w/vue2" };
    useRun.setState({ configs: [main, other, vue, sibling], sessions: [] });
    localStorage.setItem("openidea.services.runTypes:/w/main", JSON.stringify(["npm"]));
    // What the backend lists once /w/vue is no longer a workspace member.
    ipc.runConfigs.mockImplementation(async () => ({ status: "ok", data: [main, other, sibling] }));

    await cleanupRemovedProject("/w/vue");

    expect(useRun.getState().configs.map((c) => c.id)).toEqual(["app", "serve", "dev2"]);
    expect(readTypes("/w/main")).toEqual(["npm"]);
  });
});

describe("service selection", () => {
  const group = { key: "run:type:npm", label: "npm", icon: "" };
  const item = (id: string) => ({ key: `run:config:${id}`, label: id, icon: "" });
  const leaf = (items: MenuItem[], label: string): Extract<MenuItem, { run?: unknown }> => {
    for (const entry of items) {
      if (entry.kind === "separator" || entry.kind === "header" || entry.kind === "action") continue;
      if (entry.label === label) return entry;
      if (entry.submenu) {
        const found = leaf(entry.submenu, label);
        if (found) return found;
      }
    }
    return undefined!;
  };

  beforeEach(() => {
    localStorage.clear();
    useProject.setState({ project: { root: "/selection" } as never });
    useRun.setState({ configs: [config("dev", "npm")], sessions: [] });
    vi.mocked(pickServices).mockReset();
    startRun.mockReset().mockResolvedValue(null);
  });

  it("restores a hidden single configuration through its group's Add Service", async () => {
    leaf(runServiceProvider.menu!(item("dev")), "Remove from Services").run!();
    expect(readHidden("/selection")).toEqual({ npm: ["dev"] });
    await leaf(runServiceProvider.menu!(group), "Add Service").run!();
    expect(readHidden("/selection")).toEqual({ npm: [] });
    expect(pickServices).not.toHaveBeenCalled();
  });

  it("keeps Run All and Restart All scoped to visible configurations", async () => {
    addType("npm");
    useRun.setState({ configs: [config("dev", "npm"), config("test", "npm")] });
    leaf(runServiceProvider.menu!(item("dev")), "Remove from Services").run!();
    for (const id of ["run-all", "restart-all"]) {
      startRun.mockClear();
      await runServiceProvider.actions!(group)
        .find((a) => a.id === id)!
        .run();
      expect(startRun.mock.calls.map(([c]) => c.id)).toEqual(["test"]);
    }
  });

  it("does not apply a picker result after switching projects", async () => {
    useRun.setState({ configs: [config("dev", "npm"), config("test", "npm")] });
    let finish!: (value: Set<string>) => void;
    vi.mocked(pickServices).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = leaf(runServiceProvider.menu!(group), "Add Service").run!();
    useProject.setState({ project: { root: "/other-selection" } as never });
    finish(new Set(["dev"]));
    await pending;
    await Promise.resolve();
    expect(readHidden("/other-selection")).toEqual({});
    expect(readTypes("/other-selection")).toEqual([]);
  });
});
