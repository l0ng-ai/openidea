import { useProject } from "@/platform/project";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { registerActions } from "@/platform/actions";
import { setContext } from "@/platform/context";
import type { RunConfig } from "@/platform/ipc";
import {
  provideNotificationService,
  provideToolWindowService,
  registerRunConfigType,
  registerToolWindow,
  runConfigTypes,
  type RunConfigTypeContribution,
  type ToolWindowService,
} from "@/workbench/contributions";
import { typeRows } from "./AddConfigPopup";
import { runBeforeLaunch } from "./beforeLaunch";
import { buildRows } from "./ConfigChooser";
import { compoundChildren, compoundCycle, formatEnv, parseEnv, validateConfig } from "./configs";
import { contextConfig } from "./context";
import { EditConfigsOverlay, moveConfig, treeRows } from "./EditConfigsDialog";
import { pasteRows } from "./EnvDialog";
import { CURRENT_FILE, resetRuns, selectConfig, sessionsOf, startCompound, startRun, useRun } from "./store";
import {
  BUILTIN_TYPES,
  blankTemplate,
  formParams,
  missingParams,
  newConfigOfType,
  registerBuiltinTypes,
  typeFor,
  withParams,
} from "./types";

vi.mock("./dialogs", () => ({
  confirmRerun: vi.fn(async () => true),
  confirmTerminate: vi.fn(),
  promptValue: vi.fn(),
  RunDialogsOverlay: () => null,
}));

const cfg = (id: string, extra: Partial<RunConfig> = {}): RunConfig => ({
  id,
  name: id,
  kind: "shell",
  command: "x",
  args: [],
  cwd: null,
  env: {},
  detected: false,
  isTest: false,
  debugAdapter: null,
  ...extra,
});

let disposeTypes: () => void;
const notify = vi.fn();
const show = vi.fn();

beforeEach(() => {
  resetRuns();
  disposeTypes = registerBuiltinTypes();
  notify.mockClear();
  show.mockClear();
  provideToolWindowService({ show, isVisible: () => true } as unknown as ToolWindowService);
  provideNotificationService({ notify });
});

afterEach(() => disposeTypes());

describe("configuration types", () => {
  it("are contributed through the registry", () => {
    expect(runConfigTypes().map((t) => t.id)).toEqual(expect.arrayContaining(BUILTIN_TYPES.map((t) => t.id)));
  });

  it.each([
    ["maven", "mvn.cmd", ["clean", "test"]],
    ["maven", "MVN.CMD", ["verify"]],
    ["maven", "mvn.bat", ["test"]],
    ["maven", "/opt/maven/bin/mvn", ["package"]],
    ["maven", String.raw`C:\tools\maven\bin\mvn.cmd`, ["test", "-Dname=two words"]],
    ["maven", "mvnw.cmd", ["test"]],
    ["gradle", "gradle.bat", ["build"]],
    ["gradle", "gradle.cmd", ["test"]],
    ["gradle", "gradlew.bat", ["test"]],
    ["pytest", "pytest.exe", ["tests/test_app.py", "-q"]],
    ["pytest", String.raw`C:\project\.venv\Scripts\PYTEST.EXE`, ["-q"]],
    ["pytest", "PYTHON.EXE", ["-m", "pytest", "tests"]],
    ["npm", String.raw`C:\Program Files\nodejs\NPM.CMD`, ["run", "test", "--", "two words"]],
    ["npm", "pnpm.COM", ["test"]],
    ["application", String.raw`C:\jdk\bin\JAVA.EXE`, ["-cp", "lib/*", "a.Main"]],
    ["spring-boot", "java.cmd", ["-cp", "lib/*", "a.App"]],
    ["godot", "GODOT.EXE", ["--path", ".", "res://a.tscn"]],
  ])("opens %s launcher %s in its form and preserves the command line", (kind, command, args) => {
    const original = cfg("windows", { kind, command, args, cwd: "C:/project" });
    const params = formParams(original);
    expect(params).not.toBeNull();
    expect(withParams(original, params!)).toMatchObject({ command, args, cwd: original.cwd });
    if (kind === "maven" || kind === "gradle") {
      expect(params!.wrapper === "true").toBe(/^(mvnw|gradlew)/.test(command));
      expect(withParams(original, { ...params!, tasks: "clean" })).toMatchObject({ command, args: ["clean"] });
    }
  });

  it("switches launchers when the wrapper or package manager selection changes", () => {
    const maven = cfg("m", { kind: "maven", command: "mvnw.cmd", args: ["test"] });
    expect(withParams(maven, { ...formParams(maven)!, wrapper: "false" }).command).toBe("mvn");
    const npm = cfg("n", { kind: "npm", command: "NPM.CMD", args: ["test"] });
    expect(formParams(npm)!.packageManager).toBe("npm");
    expect(withParams(npm, { ...formParams(npm)!, packageManager: "pnpm" }).command).toBe("pnpm");
  });

  it.each(["mvn.cmd.sh", "other.exe", "/bin/MVN"])("does not accept unrelated Maven commands: %s", (command) => {
    expect(formParams(cfg("m", { kind: "maven", command, args: ["test"] }))).toBeNull();
  });

  it("old run.toml entries edit as a Shell Script command line", () => {
    const old = cfg("user:server", { command: "cargo", args: ["run", "--bin", "my app"] });
    const params = formParams(old)!;
    expect(params).toEqual({ mode: "command", command: "cargo", args: "run --bin 'my app'" });
    expect(withParams(old, params)).toMatchObject({ command: "cargo", args: ["run", "--bin", "my app"] });
  });

  it("Godot runs the main scene or a chosen one, and reads detected configurations back", () => {
    const godot = typeFor("godot")!;
    expect(godot.debugAdapter).toBe("godot");
    const c = cfg("g", { kind: "godot" });
    expect(withParams(c, { projectDir: "game", scene: "", arguments: "" })).toMatchObject({
      command: "godot",
      args: ["--path", "."],
      cwd: "game",
    });
    expect(withParams(c, { scene: "res://one.tscn", arguments: "--debug-collisions" })).toMatchObject({
      args: ["--path", ".", "res://one.tscn", "--debug-collisions"],
      cwd: null,
    });
    const detected = cfg("godot:project", {
      kind: "godot",
      command: "/Apps/Godot.app/Contents/MacOS/Godot",
      args: ["--path", "."],
    });
    expect(godot.paramsFrom!(detected)).toEqual({
      projectDir: "",
      scene: "",
      arguments: "",
      executable: detected.command,
    });
    const scene = { ...detected, cwd: "demo", args: ["--path", ".", "res://a.tscn", "--verbose"] };
    expect(godot.paramsFrom!(scene)).toEqual({
      projectDir: "demo",
      scene: "res://a.tscn",
      arguments: "--verbose",
      executable: detected.command,
    });
    expect(godot.paramsFrom!(cfg("x", { command: "cargo" }))).toBeNull();
  });

  it("pytest round-trips commandLine / paramsFrom and opens implicit context configs in the form", () => {
    const pytest = typeFor("pytest")!;
    expect(pytest.debugAdapter).toBe("debugpy");
    expect(newConfigOfType(pytest, [])).toMatchObject({
      kind: "pytest",
      command: "pytest",
      args: [],
      debugAdapter: "debugpy",
      params: { command: "pytest" },
    });

    const cases: Array<{
      command: string;
      args: string[];
      params: { command: string; runnerArgs: string; target: string; options: string };
    }> = [
      {
        command: "pytest",
        args: ["tests", "-x"],
        params: { command: "pytest", runnerArgs: "", target: "tests", options: "-x" },
      },
      {
        command: "uv",
        args: ["run", "pytest", "tests/test_a.py::test_x", "-q"],
        params: { command: "uv", runnerArgs: "run pytest", target: "tests/test_a.py::test_x", options: "-q" },
      },
      {
        command: "python",
        args: ["-m", "pytest"],
        params: { command: "python", runnerArgs: "-m pytest", target: "", options: "" },
      },
      {
        command: ".venv/bin/pytest",
        args: [],
        params: { command: ".venv/bin/pytest", runnerArgs: "", target: "", options: "" },
      },
      {
        command: ".venv\\Scripts\\pytest.exe",
        args: [],
        params: { command: ".venv\\Scripts\\pytest.exe", runnerArgs: "", target: "", options: "" },
      },
    ];

    for (const { command, args, params } of cases) {
      const c = cfg("pytest", { kind: "pytest", command, args, detected: true });
      expect(pytest.paramsFrom!(c)).toEqual(params);
      expect(formParams(c)).toEqual(params);
      expect(pytest.commandLine(params)).toEqual({ command, args });
      expect(withParams(c, params)).toMatchObject({ command, args });
    }

    const implicit = contextConfig("worker/test_worker.py", [])!;
    expect(implicit).toMatchObject({
      kind: "pytest",
      command: "python3",
      args: ["-m", "pytest", "worker/test_worker.py"],
    });
    expect(formParams(implicit)).toEqual({
      command: "python3",
      runnerArgs: "-m pytest",
      target: "worker/test_worker.py",
      options: "",
    });

    const uvPy = [cfg("py", { kind: "python", command: "uv", args: ["run", "python", "-m", "app"] })];
    const uvImplicit = contextConfig("worker/test_worker.py", uvPy)!;
    expect(uvImplicit).toMatchObject({
      kind: "pytest",
      command: "uv",
      args: ["run", "python", "-m", "pytest", "worker/test_worker.py"],
    });
    expect(formParams(uvImplicit)).toEqual({
      command: "uv",
      runnerArgs: "run python -m pytest",
      target: "worker/test_worker.py",
      options: "",
    });

    expect(pytest.paramsFrom!(cfg("pytest", { kind: "pytest", command: "tox", args: [] }))).toBeNull();
  });

  it("shell script files and text derive the command line", () => {
    const c = cfg("s");
    expect(
      withParams(c, {
        mode: "file",
        path: "scripts/build.sh",
        options: "--fast",
        interpreter: "/bin/bash",
        interpreterOptions: "-e",
      }),
    ).toMatchObject({
      command: "/bin/bash",
      args: ["-e", "scripts/build.sh", "--fast"],
    });
    expect(withParams(c, { mode: "file", path: "./run.sh" })).toMatchObject({ command: "./run.sh", args: [] });
    expect(withParams(c, { mode: "text", script: "echo a && echo b" })).toMatchObject({
      command: "echo a && echo b",
      args: [],
    });
  });

  it("detected npm / Gradle configurations open in their forms when they fit", () => {
    const npm = cfg("npm:dev", {
      kind: "npm",
      command: "pnpm",
      args: ["run", "dev", "--port", "3000"],
      cwd: "web",
      detected: true,
    });
    expect(formParams(npm)).toEqual({
      packageManager: "pnpm",
      command: "run",
      script: "dev",
      arguments: "--port 3000",
      packageDir: "web",
    });
    const gradle = cfg("gradle:test", { kind: "gradle", command: "./gradlew", args: ["test"], detected: true });
    expect(formParams(gradle)).toMatchObject({ tasks: "test", wrapper: "true" });
    // An unrelated executable stays a plain command.
    expect(formParams(cfg("m", { kind: "maven", command: "/opt/tools/custom-build", args: ["package"] }))).toBeNull();
    expect(withParams(npm, { packageManager: "npm", command: "test", packageDir: "" })).toMatchObject({
      command: "npm",
      args: ["test"],
      cwd: null,
    });
  });

  it("new configurations get the type's defaults, then the template", () => {
    const template = cfg("template:npm", {
      kind: "npm",
      env: { NODE_ENV: "development" },
      params: { packageManager: "pnpm", command: "run", script: "dev" },
      beforeLaunch: [{ kind: "build", target: "" }],
      allowParallel: true,
    });
    const c = newConfigOfType(typeFor("npm")!, [], template, "Web");
    expect(c).toMatchObject({
      kind: "npm",
      name: "Unnamed",
      command: "pnpm",
      args: ["run", "dev"],
      env: { NODE_ENV: "development" },
      allowParallel: true,
      folder: "Web",
      local: true,
      beforeLaunch: [{ kind: "build", target: "" }],
    });
    expect(c.id.startsWith("user:")).toBe(true);
    expect(missingParams(newConfigOfType(typeFor("program")!, []))).toEqual({ program: "Executable is required" });
  });

  it("Add New Configuration lists, groups and filters types", () => {
    const types = [
      ...runConfigTypes(),
      { ...BUILTIN_TYPES[0]!, id: "docker-image", label: "Docker Image", group: "Docker" },
    ];
    const rows = typeRows(types, "");
    expect(rows.find((r) => r.kind === "group")).toMatchObject({ label: "Docker" });
    expect(rows.filter((r) => r.kind === "type").map((r) => (r.kind === "type" ? r.type.label : ""))).toContain(
      "Compound",
    );
    expect(typeRows(types, "grad").map((r) => r.key)).toEqual(["gradle"]);
    expect(typeRows(types, "dock").map((r) => r.key)).toEqual(["group:Docker", "docker-image"]);
  });
});

describe("compound configurations", () => {
  const a = cfg("a");
  const b = cfg("b");
  const inner = cfg("inner", { kind: "compound", command: "", compound: ["b", "a"] });
  const outer = cfg("outer", { kind: "compound", command: "", compound: ["a", "inner"] });

  it("flatten their members and reject cycles", () => {
    expect(compoundChildren(outer, [a, b, inner, outer]).map((c) => c.id)).toEqual(["a", "b"]);
    const loop = { ...inner, compound: ["outer"] };
    expect(compoundCycle(loop, [a, b, loop, outer])).toBe(true);
    expect(validateConfig(loop, [a, b, loop, outer]).compound).toMatch(/itself/);
    expect(validateConfig(cfg("empty", { kind: "compound", command: "" })).compound).toMatch(/at least one/);
    expect(validateConfig(outer, [a, b, inner, outer])).toEqual({});
  });

  it("run all members; the compound's sessions are theirs", async () => {
    useRun.setState({ configs: [a, b, inner, outer] });
    const sessions = await startCompound(outer);
    expect(sessions.map((s) => s.config.id).sort()).toEqual(["a", "b"]);
    expect(
      sessionsOf(outer)
        .map((s) => s.config.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });
});

describe("before launch tasks", () => {
  it("run in order and a failure aborts", async () => {
    const dispose = registerToolWindow({
      id: "todo",
      title: "TODO",
      icon: "todo",
      anchor: "bottom",
      component: () => null,
    });
    const build = vi.fn(async () => setContext("build.lastStatus", "success"));
    const disposeBuild = registerActions([{ id: "build.buildProject", title: "Build Project", run: build }]);
    const app = cfg("app", {
      beforeLaunch: [
        { kind: "build", target: "" },
        { kind: "toolWindow", target: "todo" },
      ],
    });
    expect(await runBeforeLaunch(app, [app.id])).toBe(true);
    expect(build).toHaveBeenCalledOnce();
    expect(show).toHaveBeenCalledWith("todo", true);

    build.mockImplementation(async () => setContext("build.lastStatus", "failed"));
    show.mockClear();
    expect(await runBeforeLaunch(app, [app.id])).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "'app' was not started" }));

    // Another configuration that can't run (no desktop app in tests) fails the launch; cycles are refused.
    const other = cfg("other");
    useRun.setState({ configs: [app, other] });
    expect(await runBeforeLaunch(cfg("x", { beforeLaunch: [{ kind: "run", target: "other" }] }), ["x"])).toBe(false);
    expect(await runBeforeLaunch(cfg("x", { beforeLaunch: [{ kind: "run", target: "x" }] }), ["x"])).toBe(false);
    dispose();
    disposeBuild();
  });
});

describe("environment variables", () => {
  it("format and parse the one-line field and pasted lines", () => {
    const env = { A: "1", B: "x;y\\z" };
    expect(formatEnv(env)).toBe("A=1;B=x\\;y\\\\z");
    expect(parseEnv(formatEnv(env))).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "x;y\\z" },
    ]);
    expect(parseEnv('# comment\nexport A=1\nB = "two words"\n\nbad\n')).toEqual([
      { key: "A", value: "1" },
      { key: "B", value: "two words" },
    ]);
    expect(pasteRows([{ key: "A", value: "0" }], "A=1;C=3")).toEqual([
      { key: "A", value: "1" },
      { key: "C", value: "3" },
    ]);
  });
});

describe("Run/Debug Configurations tree", () => {
  const configs = [
    cfg("a", { kind: "npm", folder: "Web" }),
    cfg("b", { kind: "npm" }),
    cfg("c", { kind: "npm", folder: "Web" }),
    cfg("d", { kind: "shell" }),
  ];

  it("groups by type with folders first", () => {
    expect(treeRows(configs, [{ kind: "shell", name: "Empty" }]).map((r) => r.key)).toEqual([
      "g:npm",
      "f:npm:Web",
      "c:a",
      "c:c",
      "c:b",
      "g:shell",
      "f:shell:Empty",
      "c:d",
    ]);
    expect(treeRows(configs, [], new Set(["f:npm:Web"])).map((r) => r.key)).toEqual([
      "g:npm",
      "f:npm:Web",
      "c:b",
      "g:shell",
      "c:d",
    ]);
  });

  it("moves within the same type and folder", () => {
    expect(moveConfig(configs, "c", -1).map((c) => c.id)).toEqual(["c", "b", "a", "d"]);
    expect(moveConfig(configs, "b", -1).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("adds a configuration of the picked type and edits it", async () => {
    useRun.setState({ configs: [], loaded: true, editorOpen: true });
    render(<EditConfigsOverlay />);
    expect(screen.getByText("No run configurations added.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add New Configuration" }));
    fireEvent.click(await screen.findByText("Program"));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Unnamed");
    fireEvent.change(screen.getByLabelText("Executable"), { target: { value: "./server" } });
    fireEvent.change(screen.getByLabelText("Program arguments"), { target: { value: "--port 1" } });
    expect(screen.getByText("./server --port 1")).toBeTruthy();
    // Modify options adds "Redirect input".
    fireEvent.click(screen.getByRole("button", { name: /Modify options/ }));
    fireEvent.click(await screen.findByText("Redirect input"));
    expect(screen.getByLabelText("Redirect input from")).toBeTruthy();
  });

  it("opens Add New Configuration on Ctrl+N by typed letter", () => {
    useRun.setState({ configs: [], loaded: true, editorOpen: true });
    render(<EditConfigsOverlay />);
    const tree = screen.getByRole("tree", { name: "Run configurations" });
    // Dvorak: physical KeyN types "b", physical KeyL types "n".
    fireEvent.keyDown(tree, { key: "b", code: "KeyN", ctrlKey: true });
    expect(screen.queryByLabelText("Search configuration types")).toBeNull();
    fireEvent.keyDown(tree, { key: "n", code: "KeyL", ctrlKey: true });
    expect(screen.getByLabelText("Search configuration types")).toBeTruthy();
  });
});

describe("debug-only types (Remote JVM Debug)", () => {
  const remote: RunConfigTypeContribution = {
    id: "test-remote",
    label: "Test Remote",
    icon: "debug",
    defaults: { port: "5005" },
    debugOnly: true,
    debugAdapter: "java-debug",
    fields: [
      { key: "port", label: "Port", validate: (v) => (/^\d+$/.test(v) ? null : "Port must be a number") },
      { key: "agent", label: "Agent", control: "output", value: (p) => `address=*:${p.port ?? ""}` },
    ],
    commandLine: () => null,
  };
  let dispose: () => void;
  beforeEach(() => {
    dispose = registerRunConfigType(remote);
  });
  afterEach(() => dispose());

  it("edit only their fields; output fields follow the form", async () => {
    useRun.setState({ configs: [], loaded: true, editorOpen: true });
    render(<EditConfigsOverlay />);
    fireEvent.click(screen.getByRole("button", { name: "Add New Configuration" }));
    fireEvent.click(await screen.findByText("Test Remote"));
    expect((screen.getByLabelText("Agent") as HTMLTextAreaElement).value).toBe("address=*:5005");
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "6006" } });
    expect((screen.getByLabelText("Agent") as HTMLTextAreaElement).value).toBe("address=*:6006");
    expect((screen.getByLabelText("Agent") as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy();
    // No process: no working directory, environment, debug adapter or command line.
    expect(screen.queryByLabelText("Working directory")).toBeNull();
    expect(screen.queryByLabelText("Debug adapter")).toBeNull();
    expect(screen.queryByText("Command line")).toBeNull();
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "x" } });
    expect(screen.getByRole("alert").textContent).toBe("Port must be a number");
  });

  it("are valid without a command, get the type's adapter and are not run", async () => {
    const c = newConfigOfType(remote, []);
    expect(c.debugAdapter).toBe("java-debug");
    expect(validateConfig(c, [c])).toEqual({});
    expect(await startRun(c)).toBeNull();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ title: "'Unnamed' can only be debugged" }));
  });
});

describe("Current File", () => {
  it("is always offered in the chooser", () => {
    expect(buildRows([], "")[0]).toMatchObject({ type: "current" });
    expect(buildRows([cfg("a")], "cur").map((r) => r.type)).toEqual(["current", "edit"]);
    selectConfig(CURRENT_FILE);
    expect(useRun.getState().selectedId).toBe(CURRENT_FILE);
  });
});

describe("new Gradle wrapper default", () => {
  it.each(["wrapper", "local"] as const)(
    "follows %s distribution without changing existing choices",
    (distribution) => {
      const previous = useProject.getState().settings;
      useProject.setState({ settings: { languages: { java: { gradle: { distribution } } } } as never });
      try {
        const type = BUILTIN_TYPES.find((t) => t.id === "gradle")!;
        const config = newConfigOfType(type, [], blankTemplate(type));
        expect(config.params?.wrapper).toBe(distribution === "local" ? "false" : "true");
        expect(type.fields.some((f) => f.key === "wrapper")).toBe(true);
        const template = { ...config, params: { wrapper: "true" } };
        expect(newConfigOfType(type, [], template).params?.wrapper).toBe("true");
      } finally {
        useProject.setState({ settings: previous });
      }
    },
  );
});
