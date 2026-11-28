/**
 * Celery (PyCharm's "Celery worker" and "Enqueue Celery tasks"): `python -m celery -A <app> worker`
 * (with Beat when asked), or `celery call` sending one task to the broker. The command is the
 * interpreter, the runner args its leading arguments (`run python` for uv / poetry).
 */
import type { RunConfigTypeContribution } from "@/workbench/contributions";
import { formatArgs, parseArgs } from "./configs";
import { customCommandVisible, interpreterField, systemPython } from "./pythonTypes";

const enqueue = (p: Readonly<Record<string, string>>) => p.mode === "call";

/** Why `value` is not JSON of the given shape, or null. */
function jsonOf(shape: "array" | "object") {
  return (value: string) => {
    try {
      const v: unknown = JSON.parse(value);
      const ok = shape === "array" ? Array.isArray(v) : !!v && typeof v === "object" && !Array.isArray(v);
      if (ok) return null;
    } catch {
      // reported below
    }
    return shape === "array" ? "Enter a JSON list of arguments" : "Enter a JSON object of keyword arguments";
  };
}

export const celeryType: RunConfigTypeContribution = {
  id: "celery",
  label: "Celery",
  icon: "file-python",
  description: "Run a Celery worker or send a task to it",
  get defaults() {
    return { mode: "worker", command: systemPython() };
  },
  debugAdapter: "debugpy",
  fields: [
    {
      key: "mode",
      label: "Run",
      control: "select",
      options: [
        { value: "worker", label: "Worker" },
        { value: "call", label: "Enqueue task" },
      ],
    },
    {
      key: "app",
      label: "Celery app",
      mono: true,
      placeholder: "proj",
      hint: "Module of the Celery app (proj, proj.celery:app), passed as -A; to send a task, empty uses the task's module",
    },
    { key: "beat", label: "Run Beat scheduler", control: "checkbox", visible: (p) => !enqueue(p) },
    { key: "module", label: "Module", mono: true, placeholder: "proj.tasks", visible: enqueue },
    {
      key: "task",
      label: "Task",
      mono: true,
      required: true,
      placeholder: "add",
      hint: "Function name in the module, or the task's full registered name",
      visible: enqueue,
    },
    {
      key: "taskArgs",
      label: "Task args",
      mono: true,
      placeholder: "[2, 3]",
      validate: jsonOf("array"),
      visible: enqueue,
    },
    {
      key: "taskKwargs",
      label: "Task kwargs",
      mono: true,
      placeholder: '{"x": 1}',
      validate: jsonOf("object"),
      visible: enqueue,
    },
    { key: "options", label: "Parameters", mono: true, placeholder: "e.g. --loglevel INFO" },
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
  ],
  commandLine(p) {
    const args = [...parseArgs(p.runnerArgs ?? ""), "-m", "celery"];
    if (enqueue(p)) {
      const module = p.module?.trim() ?? "";
      const task = p.task?.trim() ?? "";
      const app = p.app?.trim() || module;
      if (app) args.push("-A", app);
      args.push("call", module ? `${module}.${task}` : task);
      if (p.taskArgs?.trim()) args.push("--args", p.taskArgs.trim());
      if (p.taskKwargs?.trim()) args.push("--kwargs", p.taskKwargs.trim());
    } else {
      if (p.app?.trim()) args.push("-A", p.app.trim());
      args.push("worker");
      if (p.beat === "true") args.push("-B");
    }
    args.push(...parseArgs(p.options ?? ""));
    return { command: p.command?.trim() || systemPython(), args };
  },
  paramsFrom(c) {
    if (c.kind !== "celery") return null;
    const at = c.args.findIndex((a, i) => a === "-m" && c.args[i + 1] === "celery");
    if (at < 0) return null;
    let rest = c.args.slice(at + 2);
    let app = "";
    if (rest[0] === "-A" && rest[1] !== undefined) {
      app = rest[1];
      rest = rest.slice(2);
    }
    const base = { command: c.command, runnerArgs: formatArgs(c.args.slice(0, at)) };
    if (rest[0] === "worker") {
      const beat = rest[1] === "-B";
      return { ...base, mode: "worker", app, beat: beat ? "true" : "", options: formatArgs(rest.slice(beat ? 2 : 1)) };
    }
    if (rest[0] !== "call" || !rest[1]) return null;
    const name = rest[1];
    rest = rest.slice(2);
    const take = (flag: string) => {
      if (rest[0] !== flag || rest[1] === undefined) return "";
      const value = rest[1];
      rest = rest.slice(2);
      return value;
    };
    const taskArgs = take("--args");
    const taskKwargs = take("--kwargs");
    // `proj.tasks.add` sent with `-A proj.tasks` reads back as module + task.
    const dot = name.lastIndexOf(".");
    const inApp = !!app && dot === app.length && name.startsWith(app);
    return {
      ...base,
      mode: "call",
      app: inApp ? "" : app,
      module: inApp ? app : "",
      task: inApp ? name.slice(dot + 1) : name,
      taskArgs,
      taskKwargs,
      options: formatArgs(rest),
    };
  },
};
