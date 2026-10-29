import { describe, expect, it } from "vitest";
import type { RunConfig } from "@/platform/ipc";
import { debugUnsupportedReason, launchConfigFor } from "../launch";

const rc = (p: Partial<RunConfig>): RunConfig => ({
  id: "x",
  name: "cfg",
  kind: "shell",
  command: "true",
  args: [],
  cwd: null,
  env: {},
  detected: true,
  isTest: false,
  debugAdapter: null,
  ...p,
});

const extra = (l: { extraJson: string | null } | null) => JSON.parse(l?.extraJson ?? "{}");

describe("run config → launch config", () => {
  it("returns null without an adapter", () => {
    expect(launchConfigFor(rc({}), "/p")).toBeNull();
  });

  it("cargo run builds the binary through codelldb's cargo integration", () => {
    const l = launchConfigFor(
      rc({
        kind: "cargo",
        command: "cargo",
        args: ["run", "-p", "app", "--bin", "app", "--", "--port", "1"],
        debugAdapter: "codelldb",
      }),
      "/p",
    )!;
    expect(l.adapter).toBe("codelldb");
    expect(l.program).toBeNull();
    expect(l.args).toEqual(["--port", "1"]);
    expect(l.cwd).toBe("/p");
    expect(extra(l)).toEqual({
      cargo: { args: ["build", "-p", "app", "--bin", "app"], filter: { name: "app", kind: "bin" } },
      sourceLanguages: ["rust"],
    });
  });

  it("cargo test builds test binaries without running", () => {
    const l = launchConfigFor(
      rc({ kind: "cargo", command: "cargo", args: ["test", "--workspace"], debugAdapter: "codelldb" }),
      "/p",
    )!;
    expect(extra(l).cargo).toEqual({ args: ["test", "--no-run", "--workspace"] });
  });

  it("debugpy: script, module, console script, venv interpreter", () => {
    const script = launchConfigFor(
      rc({ kind: "python", command: ".venv/bin/python", args: ["manage.py", "runserver"], debugAdapter: "debugpy" }),
      "/p",
    )!;
    expect(script.program).toBe("/p/manage.py");
    expect(script.args).toEqual(["runserver"]);
    expect(extra(script)).toMatchObject({ python: "/p/.venv/bin/python", django: true, console: "internalConsole" });

    const mod = launchConfigFor(
      rc({ kind: "python", command: "python3", args: ["-m", "app", "-v"], debugAdapter: "debugpy" }),
      "/p",
    )!;
    expect(mod.program).toBeNull();
    expect(mod.args).toEqual(["-v"]);
    expect(extra(mod)).toMatchObject({ module: "app", python: "python3" });

    const pytest = launchConfigFor(
      rc({ kind: "pytest", command: ".venv/bin/pytest", args: ["-x"], debugAdapter: "debugpy" }),
      "/p",
    )!;
    expect(extra(pytest)).toMatchObject({ module: "pytest", python: "/p/.venv/bin/python" });
    expect(pytest.args).toEqual(["-x"]);

    const globalPytest = launchConfigFor(rc({ kind: "pytest", command: "pytest", debugAdapter: "debugpy" }), "/p")!;
    expect(extra(globalPytest).python).toBe("python3");
  });

  it("js-debug: npm scripts run through the package manager, node scripts directly", () => {
    const npm = launchConfigFor(
      rc({ kind: "npm", command: "pnpm", args: ["run", "dev"], cwd: "web", debugAdapter: "js-debug" }),
      "/p",
    )!;
    expect(npm.cwd).toBe("/p/web");
    expect(npm.program).toBeNull();
    expect(extra(npm)).toMatchObject({ type: "pwa-node", runtimeExecutable: "pnpm", runtimeArgs: ["run", "dev"] });

    const node = launchConfigFor(rc({ command: "node", args: ["server.js", "--x"], debugAdapter: "js-debug" }), "/p")!;
    expect(node.program).toBe("/p/server.js");
    expect(node.args).toEqual(["--x"]);
    expect(extra(node).runtimeExecutable).toBeUndefined();

    // A located Node.js (e.g. 22.6+ for TypeScript) is used instead of PATH's.
    const ts = launchConfigFor(
      rc({ command: "/opt/node22/bin/node", args: ["a.ts"], debugAdapter: "js-debug" }),
      "/p",
    )!;
    expect(ts.program).toBe("/p/a.ts");
    expect(extra(ts).runtimeExecutable).toBe("/opt/node22/bin/node");
  });

  it("js-debug: TypeScript through a runner or type-stripping flag runs as the runtime", () => {
    const flag = launchConfigFor(
      rc({
        kind: "node",
        command: "/bin/node",
        args: ["--experimental-strip-types", "a.ts"],
        debugAdapter: "js-debug",
      }),
      "/p",
    )!;
    expect(flag.program).toBeNull();
    expect(extra(flag)).toMatchObject({
      runtimeExecutable: "/bin/node",
      runtimeArgs: ["--experimental-strip-types", "a.ts"],
    });
    const tsx = launchConfigFor(
      rc({ kind: "node", command: "npx", args: ["tsx", "a.ts"], debugAdapter: "js-debug" }),
      "/p",
    )!;
    expect(extra(tsx)).toMatchObject({ runtimeExecutable: "npx", runtimeArgs: ["tsx", "a.ts"] });
  });

  it("deno: waits on its inspector at a free port that js-debug attaches to", () => {
    const l = launchConfigFor(
      rc({
        kind: "deno",
        command: "/bin/deno",
        args: ["run", "-A", "--inspect", "main.ts", "x"],
        debugAdapter: "js-debug",
      }),
      "/p",
    )!;
    expect(l.adapter).toBe("js-debug");
    expect(l.program).toBeNull();
    expect(extra(l)).toMatchObject({
      type: "pwa-node",
      runtimeExecutable: "/bin/deno",
      runtimeArgs: ["run", "--inspect-wait=127.0.0.1:${freePort}", "-A", "main.ts", "x"],
      attachSimplePort: "${freePort}",
    });
    const test = launchConfigFor(
      rc({ kind: "deno", command: "deno", args: ["test"], debugAdapter: "js-debug" }),
      "/p",
    )!;
    expect(extra(test).runtimeArgs).toEqual(["test", "--inspect-wait=127.0.0.1:${freePort}"]);
  });

  it("deno task and Bun can't be debugged, with a reason", () => {
    const task = rc({ kind: "deno", command: "deno", args: ["task", "dev"], debugAdapter: "js-debug" });
    expect(launchConfigFor(task, "/p")).toBeNull();
    expect(debugUnsupportedReason(task)).toContain("deno run");
    const bun = rc({ kind: "bun", command: "/bin/bun", args: ["run", "a.ts"], debugAdapter: "js-debug" });
    expect(launchConfigFor(bun, "/p")).toBeNull();
    expect(debugUnsupportedReason(bun)).toContain("WebKit");
    // `bun run <script>` of package.json may start Node, which js-debug follows.
    const script = rc({ kind: "npm", command: "bun", args: ["run", "dev"], debugAdapter: "js-debug" });
    expect(debugUnsupportedReason(script)).toBeNull();
    expect(launchConfigFor(script, "/p")).not.toBeNull();
  });

  it("never hands a Java command to java-debug as a program to start", () => {
    const tomcat = rc({
      name: "tomcat9",
      command: "C:\\apache-tomcat-9.0.98\\bin\\catalina.bat",
      args: ["run"],
      debugAdapter: "java-debug",
    });
    const gradle = rc({ kind: "gradle", command: "./gradlew", args: ["build"], debugAdapter: "java-debug" });
    for (const c of [tomcat, gradle]) {
      expect(launchConfigFor(c, "/p")).toBeNull();
      expect(debugUnsupportedReason(c)).toContain("Remote JVM Debug");
    }
  });

  it("delve: debug mode for run, test mode for test", () => {
    const run = launchConfigFor(rc({ kind: "go", command: "go", args: ["run", "."], debugAdapter: "delve" }), "/p")!;
    expect(run.program).toBe("/p");
    expect(extra(run)).toEqual({ mode: "debug" });
    const sub = launchConfigFor(
      rc({ kind: "go", command: "go", args: ["run", "./cmd/api"], debugAdapter: "delve" }),
      "/p",
    )!;
    expect(sub.program).toBe("/p/cmd/api");
    const test = launchConfigFor(
      rc({ kind: "go", command: "go", args: ["test", "./..."], debugAdapter: "delve" }),
      "/p",
    )!;
    expect(extra(test)).toEqual({ mode: "test" });
    expect(test.program).toBe("/p");
    // A gutter test / subtest: the package, and `-run` for the test binary.
    const one = launchConfigFor(
      rc({
        kind: "go",
        command: "go",
        args: ["test", "./calc", "-run", "^TestSub$/^zero_case$"],
        debugAdapter: "delve",
      }),
      "/p",
    )!;
    expect(one.program).toBe("/p/calc");
    expect(one.args).toEqual(["-test.run", "^TestSub$/^zero_case$"]);
    const eq = launchConfigFor(
      rc({ kind: "go", command: "go", args: ["test", "-run=^TestA$", "."], debugAdapter: "delve" }),
      "/p",
    )!;
    expect(eq.program).toBe("/p");
    expect(eq.args).toEqual(["-test.run", "^TestA$"]);
  });

  it("other adapters launch the command as the program", () => {
    const l = launchConfigFor(
      rc({ command: "./bin/app", args: ["a"], env: { K: "v" }, debugAdapter: "netcoredbg" }),
      "/p",
    )!;
    expect(l).toMatchObject({
      adapter: "netcoredbg",
      program: "/p/bin/app",
      args: ["a"],
      env: { K: "v" },
      request: "launch",
    });
  });

  it("native programs under CodeLLDB / lldb-dap: program, args, cwd, env", () => {
    const run = rc({ command: "./build/app", args: ["-v"], cwd: "c", env: { K: "v" } });
    const lldb = launchConfigFor({ ...run, debugAdapter: "codelldb" }, "/p")!;
    expect(lldb).toMatchObject({
      adapter: "codelldb",
      program: "/p/c/build/app",
      args: ["-v"],
      cwd: "/p/c",
      env: { K: "v" },
    });
    expect(lldb.extraJson).toBeNull();
    const dap = launchConfigFor({ ...run, debugAdapter: "lldb-dap" }, "/p")!;
    expect(dap).toMatchObject({ adapter: "lldb-dap", program: "/p/c/build/app" });
    // lldb-dap takes `KEY=VALUE` strings.
    expect(extra(dap)).toEqual({ env: ["K=v"] });
  });

  it("Godot: the editor's adapter plays the main scene or the chosen one of the project", () => {
    const project = rc({
      kind: "godot",
      command: "/Apps/Godot",
      args: ["--path", "."],
      cwd: "game",
      debugAdapter: "godot",
    });
    const main = launchConfigFor(project, "/p")!;
    expect(main).toMatchObject({ adapter: "godot", request: "launch", cwd: "/p/game", program: null });
    expect(extra(main)).toEqual({ project: "/p/game", scene: "main" });
    const scene = launchConfigFor({ ...project, args: ["--path", ".", "res://levels/one.tscn"] }, "/p")!;
    expect(extra(scene)).toEqual({ project: "/p/game", scene: "res://levels/one.tscn" });
    const relative = launchConfigFor({ ...project, cwd: null, args: ["--path", "game", "menu.tscn"] }, "/p")!;
    expect(extra(relative)).toEqual({ project: "/p/game", scene: "res://menu.tscn" });
  });
});
