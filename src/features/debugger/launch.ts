/** Run configuration → DAP launch configuration, per adapter. */
import { workflowSettings } from "@/platform/workflowSettings";
import type { LaunchConfig, RunConfig } from "@/platform/ipc";

function isAbsolute(p: string) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
}

function join(base: string, p: string) {
  if (isAbsolute(p)) return p;
  const rel = p.replace(/^\.\//, "");
  return rel === "." || rel === "" ? base : `${base.replace(/\/$/, "")}/${rel}`;
}

/** A command path with a directory part resolved against `cwd`; bare names stay for PATH lookup. */
function resolveCommand(cmd: string, cwd: string) {
  return cmd.includes("/") ? join(cwd, cmd) : cmd;
}

function splitAtDashDash(args: readonly string[]): [string[], string[]] {
  const i = args.indexOf("--");
  return i < 0 ? [[...args], []] : [args.slice(0, i), args.slice(i + 1)];
}

function base(rc: RunConfig, adapter: string, cwd: string): LaunchConfig {
  return {
    name: rc.name,
    adapter,
    request: "launch",
    program: null,
    args: [],
    cwd,
    env: { ...rc.env },
    extraJson: null,
  };
}

function cargoLaunch(rc: RunConfig, cwd: string, adapter: string): LaunchConfig {
  const [cargoArgs, programArgs] = splitAtDashDash(rc.args);
  const [sub, ...rest] = cargoArgs;
  let args: string[];
  let filter: { name?: string; kind?: string } | undefined;
  if (sub === "test" || sub === "nextest") {
    args = ["test", "--no-run", ...rest.filter((a) => a !== "--no-run")];
  } else {
    args = ["build", ...rest];
    const bin = rest.indexOf("--bin");
    if (bin >= 0 && rest[bin + 1]) filter = { name: rest[bin + 1], kind: "bin" };
    const example = rest.indexOf("--example");
    if (example >= 0 && rest[example + 1]) filter = { name: rest[example + 1], kind: "example" };
    if (!filter) filter = { kind: "bin" };
  }
  return {
    ...base(rc, adapter, cwd),
    args: programArgs,
    extraJson: JSON.stringify({ cargo: filter ? { args, filter } : { args }, sourceLanguages: ["rust"] }),
  };
}

function pythonFor(rc: RunConfig, cwd: string): string {
  const cmd = rc.command;
  const name = cmd.split("/").pop() ?? cmd;
  if (/^python[\d.]*(\.exe)?$/.test(name)) return resolveCommand(cmd, cwd);
  // A venv tool such as `.venv/bin/pytest`: use the interpreter next to it.
  if (cmd.includes("/")) return resolveCommand(cmd.slice(0, cmd.lastIndexOf("/") + 1) + "python", cwd);
  return "python3";
}

function debugpyLaunch(rc: RunConfig, cwd: string): LaunchConfig {
  const out = base(rc, "debugpy", cwd);
  const dbg = workflowSettings().debugger;
  const extra: Record<string, unknown> = {
    python: pythonFor(rc, cwd),
    console: "internalConsole",
    justMyCode: dbg.skipLibraryCode,
    subProcess: dbg.python.attachSubprocess,
    redirectOutput: true,
  };
  if (dbg.python.gevent) extra.gevent = true;
  const name = rc.command.split("/").pop() ?? rc.command;
  const isPython = /^python[\d.]*(\.exe)?$/.test(name);
  if (!isPython) {
    // A console script (`pytest`, `uvicorn`, …): run it as a module.
    extra.module = name.replace(/\.exe$/, "");
    out.args = [...rc.args];
  } else if (rc.args[0] === "-m" && rc.args[1]) {
    extra.module = rc.args[1];
    out.args = rc.args.slice(2);
  } else if (rc.args[0]) {
    out.program = join(cwd, rc.args[0]);
    out.args = rc.args.slice(1);
    if (rc.args[0].endsWith("manage.py")) extra.django = true;
  }
  out.extraJson = JSON.stringify(extra);
  return out;
}

/** Replaced by the backend with one free local port per launch (`ide-dap` `FREE_PORT_PLACEHOLDER`). */
const FREE_PORT = "${freePort}";

/** Deno subcommands that run code and take `--inspect-wait`. */
const DENO_RUNS = new Set(["run", "test", "bench", "serve", "eval"]);

/**
 * `deno run …` (and test / bench / serve / eval) under js-debug: Deno waits on its V8
 * inspector at a free port and js-debug attaches to it (`attachSimplePort`), like the
 * VS Code Deno extension. `null` for subcommands that can't take the flag (`deno task`).
 */
function denoRuntime(rc: RunConfig): Record<string, unknown> | null {
  const [sub, ...rest] = rc.args;
  if (!sub || !DENO_RUNS.has(sub)) return null;
  const flags = rest.filter((a) => !/^--inspect(-brk|-wait)?(=|$)/.test(a));
  return {
    runtimeExecutable: rc.command,
    runtimeArgs: [sub, `--inspect-wait=127.0.0.1:${FREE_PORT}`, ...flags],
    attachSimplePort: FREE_PORT,
  };
}

function commandName(cmd: string) {
  return (cmd.split(/[\\/]/).pop() ?? cmd).replace(/\.(exe|cmd)$/i, "");
}

/**
 * Why `rc` can't be debugged even though it names a debugger, or null when it can.
 * Bun's inspector speaks the WebKit Inspector protocol, which js-debug can't attach to.
 * Java configurations reach this only when the Run feature found no JVM to attach to.
 */
export function debugUnsupportedReason(rc: RunConfig): string | null {
  // java-debug runs inside jdtls: it launches Application configurations or attaches to a JDWP agent.
  if (rc.debugAdapter === "java-debug")
    return "The Java debugger can't start this command itself. Debug an Application, Spring Boot, Maven or Gradle configuration, or start the JVM with a JDWP agent and attach with a Remote JVM Debug configuration.";
  const name = commandName(rc.command);
  if (rc.kind === "bun" || (name === "bun" && rc.kind !== "npm"))
    return (
      "Bun's inspector speaks the WebKit Inspector protocol, which the JavaScript debugger (vscode-js-debug) " +
      "can't attach to. Run it with `bun --inspect` and open the printed debug.bun.sh link, or debug the file with Node.js or Deno."
    );
  if (rc.kind === "deno" || name === "deno") {
    if (!denoRuntime(rc))
      return `\`deno ${rc.args[0] ?? ""}\` can't be started with the debugger. Debug a \`deno run\` or \`deno test\` configuration instead.`;
  }
  return null;
}

function jsDebugLaunch(rc: RunConfig, cwd: string): LaunchConfig {
  const out = base(rc, "js-debug", cwd);
  const extra: Record<string, unknown> = {
    type: "pwa-node",
    console: "internalConsole",
    outputCapture: "std",
    skipFiles: workflowSettings().debugger.skipLibraryCode ? ["<node_internals>/**", "**/node_modules/**"] : [],
    autoAttachChildProcesses: true,
  };
  const name = commandName(rc.command);
  const deno = name === "deno" ? denoRuntime(rc) : null;
  if (deno) {
    Object.assign(extra, deno);
  } else if (name === "node" && rc.args[0] && !rc.args[0].startsWith("-")) {
    out.program = join(cwd, rc.args[0]);
    out.args = rc.args.slice(1);
    // The Node.js the run configuration picked (settings / version manager), not PATH's.
    if (rc.command !== name) extra.runtimeExecutable = resolveCommand(rc.command, cwd);
  } else {
    extra.runtimeExecutable = rc.command;
    extra.runtimeArgs = [...rc.args];
  }
  out.extraJson = JSON.stringify(extra);
  return out;
}

function delveLaunch(rc: RunConfig, cwd: string): LaunchConfig {
  const out = base(rc, "delve", cwd);
  const [sub, ...rest] = rc.args;
  const [goArgs, programArgs] = splitAtDashDash(rest);
  if (sub === "test") {
    // `go test` selection flags become the test binary's (`-run ^TestX$` → `-test.run ^TestX$`).
    const testFlags: string[] = [];
    let pkg: string | undefined;
    for (let i = 0; i < goArgs.length; i++) {
      const a = goArgs[i]!;
      const flag = /^--?(run|skip)(?:=(.*))?$/.exec(a);
      if (flag) {
        const value = flag[2] ?? goArgs[++i];
        if (value !== undefined) testFlags.push(`-test.${flag[1]}`, value);
      } else if (!a.startsWith("-")) pkg ??= a;
    }
    pkg ??= ".";
    out.program = pkg.endsWith("/...") ? cwd : join(cwd, pkg);
    out.extraJson = JSON.stringify({ mode: "test" });
    out.args = [...testFlags, ...programArgs];
  } else {
    const flags = goArgs.filter((a) => a.startsWith("-"));
    const positional = goArgs.filter((a) => !a.startsWith("-"));
    const target = positional[0] ?? ".";
    out.program = join(cwd, target);
    out.args = [...positional.slice(1), ...programArgs];
    out.extraJson = JSON.stringify(flags.length ? { mode: "debug", buildFlags: flags.join(" ") } : { mode: "debug" });
  }
  return out;
}

/** The scene a `godot --path <dir> [scene]` command line plays: `main`, or a `res://` path. */
export function godotScene(args: readonly string[]): string {
  const scene = args.find((a, i) => args[i - 1] !== "--path" && /\.t?scn$/i.test(a));
  if (!scene) return "main";
  return scene.startsWith("res://") ? scene : `res://${scene.replace(/^\.\//, "")}`;
}

/**
 * Godot: the adapter inside the editor plays the scene itself (with the editor's run
 * settings), so the launch names the project (checked against the editor's) and the scene.
 */
function godotLaunch(rc: RunConfig, cwd: string): LaunchConfig {
  const i = rc.args.indexOf("--path");
  const dir = i >= 0 ? rc.args[i + 1] : undefined;
  const project = dir ? join(cwd, dir) : cwd;
  return { ...base(rc, "godot", project), extraJson: JSON.stringify({ project, scene: godotScene(rc.args) }) };
}

/** A native program under CodeLLDB or lldb-dap: program, args, cwd, env. */
function nativeLaunch(rc: RunConfig, cwd: string, adapter: string): LaunchConfig {
  const out: LaunchConfig = { ...base(rc, adapter, cwd), program: resolveCommand(rc.command, cwd), args: [...rc.args] };
  // lldb-dap takes the environment as `KEY=VALUE` strings.
  if (adapter === "lldb-dap")
    out.extraJson = JSON.stringify({ env: Object.entries(rc.env).map(([k, v]) => `${k}=${v}`) });
  return out;
}

/**
 * The launch configuration that debugs `rc`, or `null` when it has no adapter.
 * `root` is the project root (default working directory).
 */
export function launchConfigFor(rc: RunConfig, root: string): LaunchConfig | null {
  const adapter = rc.debugAdapter;
  if (!adapter || debugUnsupportedReason(rc)) return null;
  const cwd = rc.cwd ? join(root, rc.cwd) : root;
  if (adapter === "codelldb" || adapter === "lldb-dap") {
    return rc.kind === "cargo" ? cargoLaunch(rc, cwd, adapter) : nativeLaunch(rc, cwd, adapter);
  }
  if (adapter === "debugpy") return debugpyLaunch(rc, cwd);
  if (adapter === "js-debug") return jsDebugLaunch(rc, cwd);
  if (adapter === "delve") return delveLaunch(rc, cwd);
  if (adapter === "godot") return godotLaunch(rc, cwd);
  // Adapters without a template (hidden in Edit Configurations): generic arguments.
  return {
    ...base(rc, adapter, cwd),
    program: resolveCommand(rc.command, cwd),
    args: [...rc.args],
  };
}
