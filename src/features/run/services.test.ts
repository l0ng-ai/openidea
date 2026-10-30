import { beforeEach, describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { DEFAULT_TYPES, readRan, readTypes, runServiceItems, sessionDetail, sessionStatus } from "./services";
import { startedPort } from "./serverPort";
import type { RunSession } from "./store";

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

  it("defaults to Spring Boot and persists the user's list per project", () => {
    expect(readTypes("/p")).toEqual(["spring-boot"]);
    localStorage.setItem("openidea.services.runTypes:/p", JSON.stringify(["npm"]));
    expect(readTypes("/p")).toEqual(["npm"]);
    localStorage.setItem("openidea.services.runTypes:/p", "[]");
    expect(readTypes("/p")).toEqual([]);
    expect(readTypes("/q")).toEqual(["spring-boot"]);
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
});
