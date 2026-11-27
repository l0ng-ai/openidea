/**
 * PyCharm's "Flask server" and "FastAPI" configurations: `python -m flask --app <app> run` and
 * `python -m uvicorn <module:app>`, with host, port and the development server's reloader.
 */
import type { RunConfig } from "@/platform/ipc";
import type { RunConfigTypeContribution, RunConfigTypeField } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { customCommandVisible, interpreterField, systemPython } from "./pythonTypes";

const interpreterFields: readonly RunConfigTypeField[] = [
  interpreterField,
  {
    key: "command",
    label: "Command",
    mono: true,
    placeholder: "python3",
    required: true,
    hint: "e.g. python3, .venv/bin/python, uv, poetry",
    visible: customCommandVisible,
  },
  {
    key: "runnerArgs",
    label: "Runner arguments",
    mono: true,
    placeholder: "run python",
    hint: "e.g. `run python` for uv/poetry; empty calls the interpreter itself",
  },
];

const serverFields = (port: string): RunConfigTypeField[] => [
  { key: "host", label: "Host", mono: true, placeholder: "127.0.0.1" },
  { key: "port", label: "Port", mono: true, placeholder: port },
];

const flag = (on: string | undefined, name: string) => (on === "true" ? [name] : []);
const option = (value: string | undefined, name: string) => (value?.trim() ? [name, value.trim()] : []);

/** `args` from `-m <module>` on: the runner args before it and the module's own arguments; null without it. */
function moduleArgs(c: RunConfig, module: string): { runnerArgs: string; rest: string[] } | null {
  const at = c.args.findIndex((a, i) => a === "-m" && c.args[i + 1] === module);
  if (at < 0) return null;
  return { runnerArgs: formatArgs(c.args.slice(0, at)), rest: c.args.slice(at + 2) };
}

/** Takes `--host` / `--port` (and their `=` forms) out of `args`. */
function takeServerOptions(args: string[]): { host: string; port: string; rest: string[] } {
  const out = { host: "", port: "", rest: [] as string[] };
  for (let i = 0; i < args.length; i++) {
    const m = /^(--host|--port|-h|-p)(?:=(.*))?$/.exec(args[i]!);
    const key = m && (m[1] === "--host" || m[1] === "-h" ? "host" : "port");
    if (!m || !key || (m[2] === undefined && args[i + 1] === undefined)) out.rest.push(args[i]!);
    else out[key] = m[2] ?? args[++i]!;
  }
  return out;
}

export const flaskType: RunConfigTypeContribution = {
  id: "flask",
  label: "Flask server",
  icon: "file-python",
  description: "Run a Flask application with flask run",
  get defaults() {
    return { command: systemPython(), debug: "true" };
  },
  debugAdapter: "debugpy",
  fields: [
    ...interpreterFields,
    {
      key: "app",
      label: "Application",
      mono: true,
      placeholder: "app",
      hint: "Passed as --app: a module or file, optionally with the app or factory (hello:create_app()); empty finds app.py or wsgi.py",
    },
    {
      key: "debug",
      label: "Debug mode",
      control: "checkbox",
      hint: "flask --debug: reload on code changes and show the interactive debugger in the browser",
    },
    ...serverFields("5000"),
    {
      key: "options",
      label: "Additional options",
      mono: true,
      placeholder: "e.g. --cert adhoc --extra-files config.toml",
    },
  ],
  commandLine(p) {
    return {
      command: p.command?.trim() || systemPython(),
      args: [
        ...parseArgs(p.runnerArgs ?? ""),
        "-m",
        "flask",
        ...option(p.app, "--app"),
        ...flag(p.debug, "--debug"),
        "run",
        ...option(p.host, "--host"),
        ...option(p.port, "--port"),
        ...parseArgs(p.options ?? ""),
      ],
    };
  },
  paramsFrom(c) {
    if (c.kind !== "flask") return null;
    const found = moduleArgs(c, "flask");
    const run = found?.rest.indexOf("run") ?? -1;
    if (!found || run < 0) return null;
    // Options of the `flask` group go before `run`; only `--app` and `--debug` have fields.
    let app = "";
    let debug = false;
    const group = found.rest.slice(0, run);
    for (let i = 0; i < group.length; i++) {
      if (group[i] === "--app" && group[i + 1] !== undefined) app = group[++i]!;
      else if (group[i]?.startsWith("--app=")) app = group[i]!.slice(6);
      else if (group[i] === "--debug") debug = true;
      else return null;
    }
    const after = found.rest.slice(run + 1);
    if (after.includes("--debug")) debug = true;
    const { host, port, rest } = takeServerOptions(after.filter((a) => a !== "--debug"));
    return {
      command: c.command,
      runnerArgs: found.runnerArgs,
      app,
      ...(debug ? { debug: "true" } : {}),
      host,
      port,
      options: formatArgs(rest),
    };
  },
};

export const fastapiType: RunConfigTypeContribution = {
  id: "fastapi",
  label: "FastAPI",
  icon: "file-python",
  description: "Run a FastAPI application with uvicorn",
  get defaults() {
    return { command: systemPython(), app: "main:app", reload: "true" };
  },
  debugAdapter: "debugpy",
  fields: [
    ...interpreterFields,
    {
      key: "app",
      label: "Application",
      mono: true,
      required: true,
      placeholder: "main:app",
      hint: "The module and the FastAPI instance in it, module:attribute",
    },
    { key: "reload", label: "Reload on code changes", control: "checkbox", hint: "uvicorn --reload" },
    ...serverFields("8000"),
    { key: "options", label: "Additional options", mono: true, placeholder: "e.g. --reload-dir app --log-level debug" },
  ],
  commandLine(p) {
    return {
      command: p.command?.trim() || systemPython(),
      args: [
        ...parseArgs(p.runnerArgs ?? ""),
        "-m",
        "uvicorn",
        ...(p.app?.trim() ? [p.app.trim()] : []),
        ...flag(p.reload, "--reload"),
        ...option(p.host, "--host"),
        ...option(p.port, "--port"),
        ...parseArgs(p.options ?? ""),
      ],
    };
  },
  paramsFrom(c) {
    if (c.kind !== "fastapi") return null;
    const found = moduleArgs(c, "uvicorn");
    if (!found) return null;
    const [app = "", ...after] = found.rest[0]?.startsWith("-") ? ["", ...found.rest] : found.rest;
    const { host, port, rest } = takeServerOptions(after.filter((a) => a !== "--reload"));
    return {
      command: c.command,
      runnerArgs: found.runnerArgs,
      app,
      ...(after.includes("--reload") ? { reload: "true" } : {}),
      host,
      port,
      options: formatArgs(rest),
    };
  },
};
