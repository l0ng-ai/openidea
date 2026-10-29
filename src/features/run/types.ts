/**
 * Built-in run configuration types (Shell Script, Program, npm, Gradle, Maven,
 * Application, Spring Boot, Compound) and the helpers that turn a type's params into the launched
 * command line. Other features contribute types with `registerRunConfigType`.
 */
import type { RunConfig } from "@/platform/ipc";
import { registerRunConfigType, useRunConfigTypes, type RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs, uid, uniqueName } from "./configs";
import {
  applicationType,
  gradleForkedJvm,
  isWindows,
  mavenForkedJvm,
  springBootType,
  type ForkedJvm,
} from "./jvmTypes";
import { tx } from "@/platform/i18n";

export const COMPOUND = "compound";

const on = (v: string | undefined) => v === "true";
const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
const dirOf = (cwd: string | null | undefined) => cwd ?? "";

/** Values of `args[index]` across detected configurations of `kind`. */
function argsOf(configs: readonly RunConfig[], kind: string, index: number): string[] {
  const out = new Set<string>();
  for (const c of configs) if (c.kind === kind && c.args[index]) out.add(c.args[index]);
  return [...out];
}

const shell: RunConfigTypeContribution = {
  id: "shell",
  label: "Shell Script",
  icon: "file-shell",
  description: "Run a script file, script text or command line",
  defaults: { mode: "file" },
  fields: [
    {
      key: "mode",
      label: "Execute",
      control: "select",
      options: [
        { value: "file", label: "Script file" },
        { value: "text", label: "Script text" },
        { value: "command", label: "Command line" },
      ],
    },
    { key: "path", label: "Script path", mono: true, required: true, visible: (p) => p.mode === "file" },
    { key: "options", label: "Script options", mono: true, visible: (p) => p.mode === "file" },
    {
      key: "interpreter",
      label: "Interpreter path",
      mono: true,
      placeholder: "Run the script directly",
      visible: (p) => p.mode === "file",
    },
    {
      key: "interpreterOptions",
      label: "Interpreter options",
      mono: true,
      visible: (p) => p.mode === "file" && !!p.interpreter,
    },
    {
      key: "script",
      label: "Script text",
      control: "textarea",
      mono: true,
      required: true,
      visible: (p) => p.mode === "text",
    },
    {
      key: "command",
      label: "Command",
      mono: true,
      required: true,
      placeholder: "e.g. ./gradlew or cargo",
      visible: (p) => p.mode === "command",
    },
    {
      key: "args",
      label: "Arguments",
      mono: true,
      placeholder: "Space separated; quote with ' or \"",
      visible: (p) => p.mode === "command",
    },
  ],
  commandLine(p) {
    if (p.mode === "text") return { command: p.script ?? "", args: [] };
    if (p.mode === "file") {
      const path = p.path ?? "";
      if (!p.interpreter?.trim()) return { command: path, args: parseArgs(p.options ?? "") };
      return {
        command: p.interpreter.trim(),
        args: [...parseArgs(p.interpreterOptions ?? ""), path, ...parseArgs(p.options ?? "")],
      };
    }
    return { command: p.command ?? "", args: parseArgs(p.args ?? "") };
  },
  paramsFrom: (c) => ({ mode: "command", command: c.command, args: formatArgs(c.args) }),
};

const program: RunConfigTypeContribution = {
  id: "program",
  label: "Program",
  icon: "file-binary",
  description: "Run an executable with arguments",
  fields: [
    { key: "program", label: "Executable", mono: true, required: true, placeholder: "Path or command on PATH" },
    { key: "arguments", label: "Program arguments", mono: true },
  ],
  commandLine: (p) => ({ command: p.program ?? "", args: parseArgs(p.arguments ?? "") }),
  paramsFrom: (c) =>
    c.args.length || !/\s/.test(c.command) ? { program: c.command, arguments: formatArgs(c.args) } : null,
};

const isScene = (a: string) => /\.t?scn$/i.test(a);
const isGodot = (cmd: string) => /^godot([-.\w]*)$/i.test(baseName(cmd).replace(/\.exe$/i, ""));

/**
 * Godot: `godot --path <project>` runs the main scene, `… <scene>` one scene. The
 * executable is the one from Settings › Language Servers › godot (else detected).
 */
const godot: RunConfigTypeContribution = {
  id: "godot",
  label: "Godot",
  icon: "file-gdscript",
  description: "Run a Godot project's main scene or a chosen scene",
  ownsWorkingDirectory: true,
  debugAdapter: "godot",
  fields: [
    { key: "projectDir", label: "Project directory", mono: true, placeholder: "Project root (holds project.godot)" },
    {
      key: "scene",
      label: "Scene",
      mono: true,
      placeholder: "Main scene",
      hint: "e.g. res://levels/level_1.tscn; empty runs the project's main scene",
      suggestions: (configs) => [
        ...new Set(configs.filter((c) => c.kind === "godot").flatMap((c) => c.args.filter(isScene))),
      ],
    },
    {
      key: "arguments",
      label: "Arguments",
      mono: true,
      placeholder: "Godot command line options, e.g. --debug-collisions",
    },
  ],
  commandLine: (p) => ({
    command: "godot",
    args: ["--path", ".", ...(p.scene?.trim() ? [p.scene.trim()] : []), ...parseArgs(p.arguments ?? "")],
    cwd: p.projectDir?.trim() || null,
  }),
  paramsFrom(c) {
    if (!isGodot(c.command)) return null;
    const rest = [...c.args];
    const path = rest.indexOf("--path");
    if (path >= 0) rest.splice(path, 2);
    const scene = rest.find(isScene) ?? "";
    return { projectDir: dirOf(c.cwd), scene, arguments: formatArgs(rest.filter((a) => a !== scene)) };
  },
};

const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn", "bun"];
const NPM_COMMANDS = ["run", "test", "start", "install", "ci", "publish", "pack"];

const npm: RunConfigTypeContribution = {
  id: "npm",
  label: "npm",
  icon: "file-npm",
  description: "Run a package.json script",
  defaults: { packageManager: "npm", command: "run" },
  ownsWorkingDirectory: true,
  fields: [
    { key: "packageDir", label: "package.json directory", mono: true, placeholder: "Project root" },
    { key: "command", label: "Command", control: "select", options: NPM_COMMANDS.map((v) => ({ value: v, label: v })) },
    {
      key: "script",
      label: "Script",
      mono: true,
      required: true,
      visible: (p) => p.command === "run",
      suggestions: (configs) => argsOf(configs, "npm", 1),
    },
    { key: "arguments", label: "Arguments", mono: true },
    {
      key: "packageManager",
      label: "Package manager",
      control: "select",
      options: PACKAGE_MANAGERS.map((v) => ({ value: v, label: v })),
    },
  ],
  commandLine(p) {
    const command = p.command || "run";
    const args = [command, ...(command === "run" ? [p.script ?? ""] : []), ...parseArgs(p.arguments ?? "")];
    return { command: p.packageManager || "npm", args, cwd: p.packageDir?.trim() || null };
  },
  paramsFrom(c) {
    const [command, ...rest] = c.args;
    if (!PACKAGE_MANAGERS.includes(c.command) || !command || !NPM_COMMANDS.includes(command)) return null;
    const script = command === "run" ? (rest.shift() ?? "") : "";
    return { packageManager: c.command, command, script, arguments: formatArgs(rest), packageDir: dirOf(c.cwd) };
  },
};

function wrapperCommand(unix: string, windows: string, plain: string, wrapper: boolean): string {
  if (!wrapper) return plain;
  return isWindows() ? windows : `./${unix}`;
}

function buildToolType(
  id: string,
  label: string,
  icon: string,
  tasks: { label: string; description: string },
  wrapper: { unix: string; windows: string; plain: string; label: string; byDefault: boolean },
  jvm: ForkedJvm,
): RunConfigTypeContribution {
  return {
    id,
    label,
    icon,
    description: tasks.description,
    defaults: wrapper.byDefault ? { wrapper: "true" } : {},
    ownsWorkingDirectory: true,
    fields: [
      { key: "projectDir", label: tx`${label} project`, mono: true, placeholder: "Project root" },
      {
        key: "tasks",
        label: tasks.label,
        mono: true,
        required: true,
        suggestions: (configs) => argsOf(configs, id, 0),
      },
      { key: "arguments", label: "Arguments", mono: true },
      ...jvm.fields,
      { key: "wrapper", label: wrapper.label, control: "checkbox" },
    ],
    commandLine: (p) => ({
      command: wrapperCommand(wrapper.unix, wrapper.windows, wrapper.plain, on(p.wrapper)),
      args: [...parseArgs(p.tasks ?? ""), ...parseArgs(p.arguments ?? ""), ...jvm.args(p)],
      cwd: p.projectDir?.trim() || null,
    }),
    ...(jvm.prepareLaunch ? { prepareLaunch: jvm.prepareLaunch } : {}),
    paramsFrom(c) {
      const name = baseName(c.command);
      const usesWrapper = name === wrapper.unix || name === wrapper.windows;
      if (!usesWrapper && name !== wrapper.plain) return null;
      return {
        projectDir: dirOf(c.cwd),
        tasks: formatArgs(c.args),
        arguments: "",
        ...(usesWrapper ? { wrapper: "true" } : {}),
      };
    },
  };
}

const gradle = buildToolType(
  "gradle",
  "Gradle",
  "file-gradle",
  { label: "Tasks", description: "Run Gradle tasks" },
  {
    unix: "gradlew",
    windows: "gradlew.bat",
    plain: "gradle",
    label: "Use the Gradle wrapper",
    byDefault: true,
  },
  gradleForkedJvm,
);

const maven = buildToolType(
  "maven",
  "Maven",
  "file-maven",
  { label: "Goals", description: "Run Maven goals" },
  {
    unix: "mvnw",
    windows: "mvnw.cmd",
    plain: "mvn",
    label: "Use the Maven wrapper",
    byDefault: false,
  },
  mavenForkedJvm,
);

const compound: RunConfigTypeContribution = {
  id: COMPOUND,
  label: "Compound",
  icon: "gutter-run-all",
  description: "Run or debug several configurations together",
  fields: [],
  commandLine: () => null,
};

/**
 * pytest: what comes after the `pytest` invocation — a target (directory, file,
 * test id) and options. The command itself is one word (`pytest`, `uv`,
 * `.venv/bin/pytest`, `python`), the runner args its leading arguments
 * (`run pytest`, `-m pytest`, none).
 */
const pytest: RunConfigTypeContribution = {
  id: "pytest",
  label: "pytest",
  icon: "file-python",
  description: "Run pytest tests",
  defaults: { command: "pytest" },
  debugAdapter: "debugpy",
  fields: [
    {
      key: "command",
      label: "Command",
      mono: true,
      placeholder: "pytest",
      required: true,
      hint: "e.g. pytest, uv, poetry, .venv/bin/pytest, python",
    },
    {
      key: "runnerArgs",
      label: "Runner arguments",
      mono: true,
      placeholder: "run pytest",
      hint: "e.g. `run pytest` for uv/poetry, `-m pytest` for python; empty calls the command itself",
    },
    {
      key: "target",
      label: "Target",
      mono: true,
      placeholder: "tests",
      hint: "Directory, file or test id; empty runs the whole suite",
    },
    { key: "options", label: "pytest options", mono: true, placeholder: "e.g. -x -q --tb=short" },
  ],
  commandLine(p) {
    const args = parseArgs(p.runnerArgs ?? "");
    if (p.target?.trim()) args.push(...parseArgs(p.target.trim()));
    args.push(...parseArgs(p.options ?? ""));
    return { command: p.command?.trim() || "pytest", args };
  },
  paramsFrom(c) {
    if (c.kind !== "pytest") return null;
    // The runner part (`run pytest`, `-m pytest`, none when the command is
    // pytest itself); what follows is the target and pytest options.
    const m = c.args.indexOf("-m");
    const runner =
      c.args[0] === "run" && c.args[1] === "pytest"
        ? 2
        : m >= 0 && c.args[m + 1] === "pytest"
          ? m + 2
          : baseName(c.command).replace(/\.exe$/i, "") === "pytest"
            ? 0
            : null;
    if (runner === null) return null;
    const rest = c.args.slice(runner);
    const [target, ...options] = rest;
    return {
      command: c.command,
      runnerArgs: formatArgs(c.args.slice(0, runner)),
      target: target && !target.startsWith("-") ? formatArgs([target]) : "",
      options: formatArgs(target && !target.startsWith("-") ? options : rest),
    };
  },
};

export const BUILTIN_TYPES: readonly RunConfigTypeContribution[] = [
  shell,
  program,
  npm,
  gradle,
  maven,
  godot,
  pytest,
  applicationType,
  springBootType,
  compound,
];

export function registerBuiltinTypes(): () => void {
  const disposers = BUILTIN_TYPES.map(registerRunConfigType);
  return () => disposers.forEach((d) => d());
}

export function typeFor(kind: string): RunConfigTypeContribution | undefined {
  return useRunConfigTypes.getState().types.get(kind);
}

/** Only Debug applies to `c` (Remote JVM Debug, Go Remote…): it attaches and launches no process. */
export const isDebugOnly = (c: Pick<RunConfig, "kind">, type = typeFor(c.kind)) => !!type?.debugOnly;

/**
 * The params the type form edits for `config`: its own, else derived from its command
 * line; null when the type can't reproduce that command line (edited as a plain command).
 */
export function formParams(config: RunConfig, type = typeFor(config.kind)): Record<string, string> | null {
  if (!type) return null;
  if (config.params && Object.keys(config.params).length) return { ...config.params };
  if (type.id === COMPOUND) return {};
  const derived = type.paramsFrom?.(config);
  if (!derived) return null;
  // Only when the form reproduces exactly what runs today.
  const line = type.commandLine(derived);
  if (!line) return null;
  const sameCwd = !type.ownsWorkingDirectory || (line.cwd ?? null) === (config.cwd ?? null);
  return line.command === config.command && formatArgs(line.args) === formatArgs(config.args) && sameCwd
    ? derived
    : null;
}

/** `config` with `params` and the command line (and stop command) they produce. */
export function withParams(config: RunConfig, params: Record<string, string>, type = typeFor(config.kind)): RunConfig {
  const line = type?.commandLine(params);
  const { stopCommand: _previous, ...rest } = config;
  if (!line) return { ...rest, params, command: "", args: [] };
  return {
    ...rest,
    params,
    command: line.command,
    args: line.args,
    ...(type?.ownsWorkingDirectory ? { cwd: line.cwd ?? null } : {}),
    ...(line.stop ? { stopCommand: line.stop } : {}),
  };
}

/** Whether "Emulate terminal in output console" applies to `config`. */
export function terminalApplies(config: RunConfig, type = typeFor(config.kind)): boolean {
  return config.kind !== COMPOUND && !config.isTest && type?.terminal !== false && !type?.debugOnly;
}

/** Required params that are empty and values the field rejects, by key. */
export function missingParams(config: RunConfig, type = typeFor(config.kind)): Record<string, string> {
  const out: Record<string, string> = {};
  const params = formParams(config, type);
  if (!type || !params) return out;
  for (const f of type.fields) {
    if (f.control === "output" || !(f.visible?.(params) ?? true)) continue;
    const value = params[f.key]?.trim() ?? "";
    if (f.required && !value) out[f.key] = `${f.label} is required`;
    else if (value && f.validate) {
      const error = f.validate(value, params);
      if (error) out[f.key] = error;
    }
  }
  return out;
}

/** Template keys copied onto a new configuration ("Edit configuration templates…"). */
const TEMPLATE_KEYS = [
  "env",
  "cwd",
  "isTest",
  "debugAdapter",
  "allowParallel",
  "includeSystemEnv",
  "envFiles",
  "stdinFile",
  "outputFile",
  "beforeLaunch",
  "showOnStdout",
  "showOnStderr",
  "openToolWindow",
  "focusToolWindow",
  "emulateTerminal",
  "target",
] as const satisfies ReadonlyArray<keyof RunConfig>;

export const templateId = (kind: string) => `template:${kind}`;

/** An empty template for `type` (what a new configuration gets without one). */
export function blankTemplate(type: RunConfigTypeContribution): RunConfig {
  return withParams(
    {
      id: templateId(type.id),
      name: type.label,
      kind: type.id,
      command: "",
      args: [],
      cwd: null,
      env: {},
      detected: false,
      isTest: false,
      debugAdapter: type.debugAdapter ?? null,
    },
    { ...type.defaults },
    type,
  );
}

/** A new configuration of `type`, with the type's defaults and then its template applied. */
export function newConfigOfType(
  type: RunConfigTypeContribution,
  configs: readonly RunConfig[],
  template?: RunConfig | null,
  folder?: string | null,
): RunConfig {
  const base: RunConfig = {
    id: uid(),
    name: uniqueName("Unnamed", configs),
    kind: type.id,
    command: "",
    args: [],
    cwd: null,
    env: {},
    detected: false,
    isTest: false,
    debugAdapter: null,
    local: true,
    ...(folder ? { folder } : {}),
  };
  const copied: Partial<RunConfig> = {};
  if (template) {
    for (const key of TEMPLATE_KEYS) {
      const v = template[key];
      if (v !== undefined) (copied as Record<string, unknown>)[key] = structuredClone(v);
    }
  }
  const params = { ...type.defaults, ...(template?.params ?? {}) };
  const next = withParams({ ...base, ...copied }, params, type);
  return type.debugAdapter ? { ...next, debugAdapter: type.debugAdapter } : next;
}
