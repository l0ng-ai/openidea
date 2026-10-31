import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { useProject } from "@/platform/project";
import {
  DEFAULT_TYPES,
  addType,
  categorizedTypes,
  readHidden,
  readRan,
  readTypes,
  runServiceItems,
  runServiceProvider,
  sessionDetail,
  sessionStatus,
} from "./services";
import { KIND_OPTIONS, categoryOf } from "./configs";
import { startedPort } from "./serverPort";
import { useRun, type RunSession } from "./store";
import { registerRunConfigType, type DebugServiceSession } from "@/workbench/contributions";

const { startRun, stopServiceSessions } = vi.hoisted(() => ({
  startRun: vi.fn(),
  stopServiceSessions: vi.fn(),
}));
vi.mock("./store", async (importOriginal) => ({ ...(await importOriginal<typeof import("./store")>()), startRun }));
vi.mock("./serviceSessions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./serviceSessions")>()),
  stopServiceSessions,
}));

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
      const build = (status: DebugServiceSession["status"]) => runServiceItems([c], [], [], [], {}, [{ ...d, status }]);
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
    const direct = runServiceItems([c], [r], DEFAULT_TYPES, [], {}, [d]);
    expect(direct[0]?.detail).toBe("1 running");
    expect(direct[0]?.children?.[0]?.detail).toBe("Debugging");
    const attached = runServiceItems([c], [{ ...r, status: "running" }], DEFAULT_TYPES, [], {}, [
      { ...d, processId: 7 },
    ]);
    expect(attached[0]?.detail).toBe("1 running");
    expect(attached[0]?.children).toHaveLength(1);
    expect(attached[0]?.children?.[0]?.detail).toBe(":8080");
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
    const items = runServiceItems(configs, [], ["spring-boot", "npm", "python"], [], {
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
    const items = runServiceItems(configs, [], [kind], [], { [kind]: [second.id, first.id] });
    expect(items[0]!.children!.map((c) => c.key)).toEqual([second, first, fresh].map((c) => `run:config:${c.id}`));
    expect(configs).toEqual([first, second, fresh]);
  });

  it("orders remembered configurations when their type was not explicitly added", () => {
    const items = runServiceItems([build, test], [], [], ["build", "test"], { cargo: ["test", "build"] });
    expect(items[0]!.children!.map((c) => c.key)).toEqual(["run:config:test", "run:config:build"]);
  });

  it("keeps stable service identity and session details after refresh and rename", () => {
    const renamed = { ...build, name: "Renamed build" };
    const items = runServiceItems(
      [renamed, test],
      [session("s1", renamed, "running", 1, { httpPort: 8080 })],
      ["cargo"],
      [],
      { cargo: ["test", "build"] },
    );
    expect(items[0]!.children!.map((c) => [c.key, c.label, c.detail])).toEqual([
      ["run:config:test", "test", undefined],
      ["run:config:build", "Renamed build", ":8080"],
    ]);
  });

  it("lists added types fully and other types only with their runs", () => {
    const sessions = [
      session("s1", dev, "finished", 1),
      session("s2", dev, "running", 2),
      session("s3", scratch, "failed", 3, { exitCode: 2 }),
    ];
    const items = runServiceItems([build, test, dev], sessions, ["cargo"]);
    expect(items.map((i) => [i.key, i.label, i.detail])).toEqual([
      ["run:type:cargo", "Cargo", undefined],
      ["run:type:npm", "npm", "1 running"],
      ["run:type:python", "Python", undefined],
    ]);
    expect(items[0]!.children!.map((c) => [c.key, c.detail, c.dim])).toEqual([
      ["run:config:build", undefined, true],
      ["run:config:test", undefined, true],
    ]);
    // The newest session of a configuration decides its state.
    expect(items[1]!.children!.map((c) => [c.label, c.detail, c.dim, c.icon])).toEqual([
      ["dev", "Running", false, "run"],
    ]);
    expect(items[2]!.children!.map((c) => [c.key, c.detail])).toEqual([["run:config:context:file", "Failed (exit 2)"]]);
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

  it("shows Spring Boot by default, hidden while the project has none", () => {
    const app = config("spring:app", "spring-boot");
    expect(runServiceItems([build], [], DEFAULT_TYPES)).toEqual([]);
    const items = runServiceItems([build, app], [], DEFAULT_TYPES);
    expect(items.map((i) => [i.key, i.label, i.expanded])).toEqual([["run:type:spring-boot", "Spring Boot", true]]);
    expect(items[0]!.children!.map((c) => [c.label, c.detail, c.dim])).toEqual([["spring:app", undefined, true]]);
  });

  it("shows the HTTP port of a running application instead of its state", () => {
    const app = config("spring:app", "spring-boot");
    const running = session("s1", app, "running", 1, { httpPort: 8080 });
    expect(sessionDetail(running)).toBe(":8080");
    expect(sessionDetail(session("s1", app, "running", 1))).toBe("Running");
    expect(sessionDetail(session("s1", app, "finished", 1, { httpPort: 8080, stopped: true }))).toBe("Stopped");
    expect(runServiceItems([app], [running], DEFAULT_TYPES)[0]!.children![0]!.detail).toBe(":8080");
  });
});

describe("types added to Services", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to Spring Boot and Vue and persists the user's list per project", () => {
    expect(readTypes("/p")).toEqual(["spring-boot", "vue"]);
    localStorage.setItem("openidea.services.runTypes:/p", JSON.stringify(["npm"]));
    expect(readTypes("/p")).toEqual(["npm"]);
    localStorage.setItem("openidea.services.runTypes:/p", "[]");
    expect(readTypes("/p")).toEqual([]);
    expect(readTypes("/q")).toEqual(["spring-boot", "vue"]);
  });
});

describe("configurations that ran", () => {
  const dev = config("dev", "npm");
  const scratch = config("context:file", "python");
  beforeEach(() => localStorage.clear());

  it("persists the ran configuration ids per project", () => {
    expect(readRan("/p")).toEqual([]);
    localStorage.setItem("openidea.services.ran:/p", JSON.stringify(["dev"]));
    expect(readRan("/p")).toEqual(["dev"]);
    expect(readRan("/q")).toEqual([]);
  });

  it("lists previously run configurations without a session", () => {
    const items = runServiceItems([dev, scratch], [], [], ["dev", "context:file"]);
    expect(items.map((i) => [i.key, i.label])).toEqual([
      ["run:type:npm", "npm"],
      ["run:type:python", "Python"],
    ]);
    expect(items[0]!.children!.map((c) => [c.label, c.dim])).toEqual([["dev", true]]);
    expect(items[1]!.children!.map((c) => c.key)).toEqual(["run:config:context:file"]);
  });

  it("ignores ran ids whose configuration is gone and merges sessions", () => {
    const gone = runServiceItems([dev], [], [], ["missing"]);
    expect(gone).toEqual([]);
    const running = session("s1", dev, "running", 1);
    const items = runServiceItems([dev], [running], [], ["dev"]);
    expect(items).toHaveLength(1);
    expect(items[0]!.children!.map((c) => [c.label, c.detail])).toEqual([["dev", "Running"]]);
  });
});

describe("embedded web server port", () => {
  it("reads the port from the started line", () => {
    expect(startedPort("TomcatWebServer  : Tomcat started on port 8080 (http) with context path '/'")).toBe(8080);
    expect(startedPort("Tomcat started on port(s): 8081 (http) with context path ''")).toBe(8081);
    expect(startedPort("o.s.b.web.embedded.netty.NettyWebServer  : Netty started on port 9090")).toBe(9090);
    expect(startedPort("Netty started on port(s): 9091")).toBe(9091);
    expect(startedPort("Undertow started on port(s) 8082 (http)")).toBe(8082);
    expect(startedPort("Jetty started on port 8083 (http/1.1) with context path '/'")).toBe(8083);
    expect(startedPort("Tomcat initialized with port 8080 (http)")).toBeNull();
    expect(startedPort("Started DemoApplication in 1.2 seconds")).toBeNull();
    expect(startedPort("Tomcat started on port 99999")).toBeNull();
  });

  it("reads the port from Vite and Vue CLI dev server lines", () => {
    expect(startedPort("  ➜  Local:   http://localhost:5173/")).toBe(5173);
    expect(startedPort("- Local:   http://localhost:8080/")).toBe(8080);
    expect(startedPort("  ➜  Local:   http://127.0.0.1:7001/")).toBe(7001);
    expect(startedPort("  ➜  Local:   http://[::1]:4173/")).toBe(4173);
    expect(startedPort("  ➜  Network: http://192.168.1.5:5173/")).toBeNull();
    expect(startedPort("Compiled successfully in 123 ms")).toBeNull();
  });
});

describe("open in browser", () => {
  const item = () => ({ key: "run:config:a", label: "a", icon: "" });
  const hasBrowser = () => runServiceProvider.actions!(item()).some((a) => a.id === "open-browser");

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

  it("hides Open in Browser without a port or a running session", () => {
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
  const action = (id: string) => runServiceProvider.actions!(group()).find((a) => a.id === id)!;

  beforeEach(() => {
    startRun.mockReset().mockResolvedValue(null);
    stopServiceSessions.mockReset().mockResolvedValue(undefined);
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
});

describe("hidden configurations", () => {
  const a = config("a", "spring-boot");
  const b = config("b", "spring-boot");

  it("hides a configuration unless it runs", () => {
    const hidden = { "spring-boot": ["a"] };
    const stopped = runServiceItems([a, b], [], DEFAULT_TYPES, [], {}, [], hidden);
    expect(stopped[0]!.children!.map((c) => c.key)).toEqual(["run:config:b"]);
    const running = runServiceItems([a, b], [session("s1", a, "running", 1)], DEFAULT_TYPES, [], {}, [], hidden);
    expect(running[0]!.children!.map((c) => c.key)).toEqual(["run:config:a", "run:config:b"]);
  });

  it("keeps an empty default group whose configurations are all hidden", () => {
    const items = runServiceItems([a], [], DEFAULT_TYPES, [], {}, [], { "spring-boot": ["a"] });
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
});

describe("add service categories", () => {
  it("categorizes every built-in kind; update the table when adding kinds", () => {
    const expected: Record<string, string> = {
      npm: "JavaScript",
      vue: "JavaScript",
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
      cc: "C/C++",
      shell: "Shell",
      program: "Shell",
      compound: "Others",
      application: "Java",
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
});
