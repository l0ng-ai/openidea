import { parseArgs, formatArgs } from "@/platform/commandLine";
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

function delveLaunch(rc: RunConfig, cwd: string, root: string): LaunchConfig {
  const out = base(rc, "delve", cwd);
  const p = rc.params;
  if (p?.goKind) {
    const module = join(root, p.module || ".");
    const target = p.target || ".";
    out.program =
      p.scope === "package" && !target.startsWith(".") && !isAbsolute(target)
        ? target
        : join(module, target.split("|")[0]!.trim());
    const test = p.goKind === "test";
    const parsed = delveLaunch(
      {
        ...rc,
        params: undefined,
        args: [
          test ? "test" : "build",
          ...parseArgs(p.toolArgs ?? ""),
          ...(test && p.pattern ? ["-run", p.pattern] : []),
          target,
          ...(test ? ["-args", ...parseArgs(p.programArgs ?? "")] : []),
        ],
      },
      module,
      root,
    );
    const toolArgs = parseArgs(JSON.parse(parsed.extraJson!).buildFlags ?? "");
    out.args = test ? parsed.args : parseArgs(p.programArgs ?? "");
    out.extraJson = JSON.stringify({
      mode: p.goKind === "test" ? "test" : "debug",
      buildFlags: toolArgs,
      dlvCwd: module,
      ...(p.scope === "file" ? { __goFiles: target.split("|").map((f) => join(module, f.trim())) } : {}),
      __goToolArgs: toolArgs,
      __goUseTags: p.useTags === "true",
      ...(p.outputDir ? { output: join(root, `${p.outputDir}/go-debug`) } : {}),
    });
    return out;
  }
  const [sub, ...rest] = rc.args;
  const test = sub === "test";
  const flags: string[] = [];
  const testFlags: string[] = [];
  const targets: string[] = [];
  let programArgs: string[] = [];
  const boolFlags = new Set([
    "-a",
    "-n",
    "-race",
    "-msan",
    "-asan",
    "-cover",
    "-linkshared",
    "-modcacherw",
    "-buildvcs",
    "-trimpath",
    "-v",
    "-work",
    "-x",
    "-json",
    "-c",
  ]);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--" || (test && a === "-args")) {
      programArgs = rest.slice(i + 1);
      break;
    }
    const selection =
      test &&
      /^-(run|skip|bench|benchtime|count|timeout|parallel|cpu|list|fuzz|fuzztime|fuzzminimizetime)(?:=(.*))?$/.exec(a);
    if (test && /^-(short|failfast|benchmem|fullpath|v)(?:=|$)/.test(a)) {
      testFlags.push(a.replace(/^-/, "-test."));
    } else if (selection) {
      const value = selection[2] ?? rest[++i];
      if (value !== undefined) testFlags.push(`-test.${selection[1]}`, value);
    } else if (a.startsWith("-")) {
      if (test && (a === "-json" || a === "-c")) continue;
      flags.push(a);
      if (!a.includes("=") && !boolFlags.has(a) && rest[i + 1] !== undefined) flags.push(rest[++i]!);
    } else if (!test && targets.length) {
      programArgs = rest.slice(i);
      break;
    } else targets.push(a);
  }
  const target = targets[0] ?? ".";
  out.program = target.endsWith("/...") ? cwd : join(cwd, target);
  out.args = [...testFlags, ...programArgs];
  out.extraJson = JSON.stringify({
    mode: test ? "test" : "debug",
    ...(flags.length ? { buildFlags: formatArgs(flags) } : {}),
  });
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
  if (adapter === "lldb-dap") {
    const from = rc.params?.cmakeSourceRoot;
    const to = rc.params?.cmakeCanonicalSourceRoot;
    out.extraJson = JSON.stringify({
      env: Object.entries(rc.env).map(([k, v]) => `${k}=${v}`),
      ...(from && to && from !== to ? { sourceMap: [[from, to]] } : {}),
    });
  }
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
  if (adapter === "delve") return delveLaunch(rc, cwd, root);
  if (adapter === "godot") return godotLaunch(rc, cwd);
  if (adapter === "netcoredbg" && rc.kind === "dotnet") {
    if (!rc.params?.targetPath) return null;
    return {
      ...base(rc, adapter, cwd),
      program: rc.params.targetPath,
      args: parseArgs(rc.params.programArgs?.trim() ? rc.params.programArgs : rc.params.profileArgs || ""),
      extraJson: JSON.stringify({ justMyCode: workflowSettings().debugger.skipLibraryCode }),
    };
  }
  // Adapters without a template (hidden in Edit Configurations): generic arguments.
  return {
    ...base(rc, adapter, cwd),
    program: resolveCommand(rc.command, cwd),
    args: [...rc.args],
  };
}
